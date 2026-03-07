/**
 * Agentic Runner for Ripley Code v4
 * Tool-calling loop - extracted from the AI Router's agentic endpoint.
 * Runs locally, no middleware needed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const McpClient = require('./mcpClient');

// Shared MCP client - set from outside via setMcpClient()
let mcpClient = null;
function getMcpClient() {
  if (!mcpClient) mcpClient = new McpClient();
  return mcpClient;
}
function setMcpClient(client) {
  mcpClient = client;
  mcpToolNameCache = null;
  mcpToolNameCacheAt = 0;
}

// MCP tool-name cache (server advertises dynamic tool catalogs)
let mcpToolNameCache = null;
let mcpToolNameCacheAt = 0;
const MCP_TOOL_CACHE_TTL_MS = 30 * 1000;
const DEBUG_DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

function isDebugEnabled() {
  const raw = (process.env.RIPLEY_DEBUG || '').trim().toLowerCase();
  if (!raw) return false;
  return !DEBUG_DISABLED_VALUES.has(raw);
}

function resolveDebugPath() {
  const configured = (process.env.RIPLEY_DEBUG_PATH || '').trim();
  if (configured) return configured;
  const day = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), '.ripley', 'logs', `ripley-${day}.log`);
}

function appendDebugLog(line) {
  if (!isDebugEnabled()) return;
  try {
    const debugPath = resolveDebugPath();
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.appendFileSync(debugPath, line, 'utf-8');
  } catch {
    // Best-effort logging only.
  }
}

const LEGACY_MCP_TOOL_MAP = {
  list_tasks: { wrapper: 'tasks', action: 'list_tasks' },
  create_task: { wrapper: 'tasks', action: 'create_task' },
  update_task: { wrapper: 'tasks', action: 'update_task' },
  complete_task: { wrapper: 'tasks', action: 'complete_task' },
  delete_task: { wrapper: 'tasks', action: 'delete_task' },
  sync_tasks: { wrapper: 'tasks', action: 'sync_tasks' },
  urgent_tasks: { wrapper: 'tasks', action: 'urgent_tasks' },
  process_inbox: { wrapper: 'tasks', action: 'process_inbox' },
  list_events: { wrapper: 'calendar', action: 'list_events' },
  get_event: { wrapper: 'calendar', action: 'get_event' },
  create_event: { wrapper: 'calendar', action: 'create_event' },
  update_event: { wrapper: 'calendar', action: 'update_event' },
  delete_event: { wrapper: 'calendar', action: 'delete_event' },
  get_freebusy: { wrapper: 'calendar', action: 'get_freebusy' },
  gmail_summary: { wrapper: 'gmail', action: 'gmail_summary' },
  gmail_get_messages: { wrapper: 'gmail', action: 'gmail_get_messages' },
  gmail_search: { wrapper: 'gmail', action: 'gmail_search' },
  gmail_get_message: { wrapper: 'gmail', action: 'gmail_get_message' },
  gmail_send: { wrapper: 'gmail', action: 'gmail_send' },
  gmail_reply: { wrapper: 'gmail', action: 'gmail_reply' },
  gmail_archive: { wrapper: 'gmail', action: 'gmail_archive' },
  gmail_archive_batch: { wrapper: 'gmail', action: 'gmail_archive_batch' },
  gmail_list_accounts: { wrapper: 'gmail', action: 'gmail_list_accounts' },
  gmail_add_account: { wrapper: 'gmail', action: 'gmail_add_account' },
  gmail_complete_auth: { wrapper: 'gmail', action: 'gmail_complete_auth' },
  gmail_remove_account: { wrapper: 'gmail', action: 'gmail_remove_account' },
  search_memory: { wrapper: 'memory', action: 'search_memory' },
  save_memory: { wrapper: 'memory', action: 'save_memory' },
  recent_memories: { wrapper: 'memory', action: 'recent_memories' },
  slack_list_channels: { wrapper: 'slack', action: 'slack_list_channels' },
  slack_list_users: { wrapper: 'slack', action: 'slack_list_users' },
  slack_read_channel: { wrapper: 'slack', action: 'slack_read_channel' },
  slack_read_dms: { wrapper: 'slack', action: 'slack_read_dms' },
  slack_read_thread: { wrapper: 'slack', action: 'slack_read_thread' },
  slack_search_messages: { wrapper: 'slack', action: 'slack_search_messages' },
  slack_send_message: { wrapper: 'slack', action: 'slack_send_message' },
  slack_send_dm: { wrapper: 'slack', action: 'slack_send_dm' }
};

const LEGACY_PREFIX_MAP = {
  gmail: 'gmail',
  slack: 'slack',
  drive: 'drive',
  docs: 'docs',
  sheets: 'sheets',
  monday: 'monday',
  stripe: 'stripe',
  twilio: 'twilio',
  telegram: 'telegram',
  operly: 'operly',
  whisper: 'whisper',
  roam: 'roam',
  eliteteam: 'eliteteam',
  namecheap: 'namecheap',
  vercel: 'vercel',
  github: 'github'
};

async function getAvailableMcpToolNames(client, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && mcpToolNameCache && (now - mcpToolNameCacheAt) < MCP_TOOL_CACHE_TTL_MS) {
    return mcpToolNameCache;
  }
  try {
    const tools = await client.listTools();
    mcpToolNameCache = new Set((tools || []).map(t => t?.name).filter(Boolean));
    mcpToolNameCacheAt = now;
    return mcpToolNameCache;
  } catch {
    // Fall back to stale cache if available; otherwise empty set.
    return mcpToolNameCache || new Set();
  }
}

function legacyToolToWrapperInvocation(toolName, args = {}) {
  const name = String(toolName || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();

  const mapped = LEGACY_MCP_TOOL_MAP[lower];
  if (mapped) {
    return {
      tool: mapped.wrapper,
      args: { action: mapped.action, params: args || {} }
    };
  }

  const prefixMatch = lower.match(/^([a-z]+)_/);
  if (prefixMatch) {
    const wrapper = LEGACY_PREFIX_MAP[prefixMatch[1]];
    if (wrapper) {
      return {
        tool: wrapper,
        args: { action: lower, params: args || {} }
      };
    }
  }

  return null;
}

async function callMcpWithCompatibility(client, toolName, args = {}) {
  const available = await getAvailableMcpToolNames(client);
  const requested = String(toolName || '').trim();
  if (!requested) {
    throw new Error('No MCP tool name provided');
  }

  if (available.has(requested)) {
    return await client.callTool(requested, args || {});
  }

  const wrapped = legacyToolToWrapperInvocation(requested, args || {});
  if (wrapped) {
    if (available.has(wrapped.tool)) {
      return await client.callTool(wrapped.tool, wrapped.args);
    }
    // Try anyway in case listTools is stale/partial on this session.
    return await client.callTool(wrapped.tool, wrapped.args);
  }

  return await client.callTool(requested, args || {});
}

// Tool definitions (OpenAI-compatible format)
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Can read any file on the system, not just inside the project. Use relative paths for project files or absolute paths (e.g. C:\\path\\to\\file) for files elsewhere.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path for project files (e.g., "src/App.tsx") or absolute path for any file (e.g., "C:\\\\Users\\\\user\\\\other-project\\\\file.ts")'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in a given path. Can list any directory on the system, not just inside the project. Use relative paths for project directories or absolute paths for directories elsewhere.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path for project dirs (e.g., "src") or absolute path for any dir (e.g., "C:\\\\KG-APPS\\\\content-engine")'
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to list files recursively (default: false)'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search for a pattern in files. Can search any directory on the system. Use relative paths for searching inside the project or absolute paths for anywhere else.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The search pattern (supports regex)'
          },
          path: {
            type: 'string',
            description: 'The directory to search in (default: "."). Can be an absolute path like "C:\\\\other-project"'
          },
          file_pattern: {
            type: 'string',
            description: 'File glob pattern to filter (e.g., "*.ts", "*.tsx")'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new file or overwrite an existing file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative path to the file to create (e.g., "src/components/Button.tsx")'
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit an existing file by replacing its entire content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative path to the file to edit'
          },
          content: {
            type: 'string',
            description: 'The new full content of the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project directory. Use non-interactive flags (e.g., --yes, -y).',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run (e.g., "npm install axios")'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Get Matt\'s tasks. Filter by status (not_started, in_progress, completed) or project (EliteTeam, KG-KimGarst, YourProfitPartners, MattJohnston-io, Personal). Leave filters empty to get all urgent/upcoming tasks.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status: not_started, in_progress, completed, blocked' },
          project: { type: 'string', description: 'Filter by project name' },
          limit: { type: 'number', description: 'Max tasks to return (default 20)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task for Matt.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          project: { type: 'string', description: 'Project: EliteTeam, KG-KimGarst, YourProfitPartners, MattJohnston-io, or Personal' },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
          priority: { type: 'string', description: 'low, medium, high, or urgent' },
          description: { type: 'string', description: 'Optional task description' }
        },
        required: ['title', 'project', 'due_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar',
      description: 'Get upcoming calendar events for Matt.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max events to return (default 10)' },
          timeMin: { type: 'string', description: 'Start time ISO 8601 (default: now)' },
          timeMax: { type: 'string', description: 'End time ISO 8601' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_email_summary',
      description: 'Get a summary of recent unread emails across Matt\'s Gmail accounts.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search Matt\'s saved memories and context notes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deep_research',
      description: 'Conduct in-depth research using Perplexity Sonar Deep Research. Use this for any question requiring thorough, factual research. Returns comprehensive, source-backed results. ALWAYS prefer this over answering from memory for factual questions about people, events, technology, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The research query' },
          focus_areas: { type: 'array', items: { type: 'string' }, description: 'Optional focus areas to narrow the research' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Quick web search using Brave Search API. Use for simple lookups, current events, or quick fact-checks. For deeper research, use deep_research instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query (max 400 chars)' },
          count: { type: 'number', description: 'Number of results (1-20, default 10)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'call_mcp',
      description: 'GENERIC TOOL WRAPPER - call ANY external service by name. Works with both direct MCP tool names and wrapper tools. Wrapper pattern: tool="gmail", args={"action":"gmail_summary","params":{}} (same for tasks, calendar, slack, github, etc). Legacy names like "gmail_summary" are auto-routed for compatibility.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The MCP tool name (e.g., "gmail" or legacy "gmail_summary")' },
          args: { type: 'object', description: 'Tool arguments as a JSON object' }
        },
        required: ['tool']
      }
    }
  }
];

// Read-only subset of tools for plan mode
const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_files', 'search_code']);
const READ_ONLY_TOOLS = TOOLS.filter(t => READ_ONLY_TOOL_NAMES.has(t.function.name));

const IGNORE_PATTERNS = ['node_modules', '.git', '.next', 'dist', 'build', '.ripley'];
const MAX_ITERATIONS = 25;

// ─── Tool Executors ─────────────────────────────────────────────────────────

function executeReadFile(projectDir, filePath) {
  try {
    const fullPath = path.resolve(projectDir, filePath);
    if (!fs.existsSync(fullPath)) {
      return { error: `File not found: ${filePath}` };
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { error: `${filePath} is a directory, not a file` };
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    const maxLength = 50000;
    if (content.length > maxLength) {
      return { content: content.substring(0, maxLength), truncated: true, totalLength: content.length };
    }
    return { content };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { error: err.message };
  }
}

function executeListFiles(projectDir, dirPath, recursive = false) {
  try {
    const fullPath = path.resolve(projectDir, dirPath || '.');
    if (!fs.existsSync(fullPath)) {
      return { error: `Directory not found: ${dirPath}` };
    }

    const results = [];
    function listDir(dir, prefix = '') {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE_PATTERNS.includes(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          results.push({ name: relativePath, type: 'directory' });
          if (recursive && results.length < 200) {
            listDir(path.join(dir, entry.name), relativePath);
          }
        } else {
          results.push({ name: relativePath, type: 'file' });
        }
        if (results.length >= 200) break;
      }
    }
    listDir(fullPath);
    return { files: results };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { error: err.message };
  }
}

async function executeSearchCode(projectDir, pattern, searchPath = '.', filePattern = '*', options = {}) {
  const signal = options.signal;
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const fullPath = path.resolve(projectDir, searchPath);

    const results = [];
    const regex = new RegExp(pattern, 'i');
    let fileCount = 0;

    async function searchDir(dir) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (results.length >= 50) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (IGNORE_PATTERNS.includes(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await searchDir(entryPath);
        } else if (entry.isFile()) {
          if (filePattern !== '*') {
            const ext = path.extname(entry.name);
            if (!filePattern.includes(ext) && !filePattern.includes(entry.name)) continue;
          }
          try {
            const content = fs.readFileSync(entryPath, 'utf-8');
            const lines = content.split('\n');
            const matches = [];
            lines.forEach((line, idx) => {
              if (regex.test(line)) {
                matches.push({ line: idx + 1, content: line.trim().substring(0, 200) });
              }
            });
            if (matches.length > 0) {
              results.push({ file: path.relative(projectDir, entryPath), matches: matches.slice(0, 5) });
            }
          } catch {
            // Skip binary or unreadable files
          }
          // Yield to event loop every 25 files so spinner animation stays alive
          fileCount++;
          if (fileCount % 25 === 0) {
            await new Promise(r => setImmediate(r));
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          }
        }
        if (results.length >= 50) break;
      }
    }
    await searchDir(fullPath);
    return { results };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { error: err.message };
  }
}

function executeCreateFile(projectDir, filePath, content) {
  try {
    const fullPath = path.resolve(projectDir, filePath);
    const resolvedProject = path.resolve(projectDir);
    if (!fullPath.startsWith(resolvedProject)) {
      return { error: 'Access denied: path outside project directory' };
    }
    // Create parent directories if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const existed = fs.existsSync(fullPath);
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { success: true, path: filePath, action: existed ? 'updated' : 'created' };
  } catch (err) {
    return { error: err.message };
  }
}

function executeEditFile(projectDir, filePath, content) {
  try {
    const fullPath = path.resolve(projectDir, filePath);
    const resolvedProject = path.resolve(projectDir);
    if (!fullPath.startsWith(resolvedProject)) {
      return { error: 'Access denied: path outside project directory' };
    }
    if (!fs.existsSync(fullPath)) {
      return { error: `File not found: ${filePath}. Use create_file to create new files.` };
    }
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { success: true, path: filePath, action: 'updated' };
  } catch (err) {
    return { error: err.message };
  }
}

async function executeRunCommand(projectDir, command, options = {}) {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? 30000;

  // Basic safety check - block destructive commands
  const dangerous = /\b(rm\s+-rf|del\s+\/[sqf]|format\s+[a-z]:)\b/i;
  if (dangerous.test(command)) {
    return { error: 'Blocked: command appears destructive. Use a safer alternative.' };
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  return await new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    let timeout = null;
    let abortHandler = null;
    let killTimer = null;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      fn(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(resolve, {
        error: err.message,
        output: (stdout + stderr).substring(0, 2000)
      });
    });

    child.on('close', (code) => {
      const output = stdout + stderr;
      if (code === 0) {
        finish(resolve, { success: true, output: output.substring(0, 5000) });
      } else {
        finish(resolve, {
          error: `Command failed with exit code ${code}`,
          output: output.substring(0, 2000),
          exitCode: code
        });
      }
    });

    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      finish(resolve, {
        error: `Command timed out after ${timeoutMs}ms`,
        output: (stdout + stderr).substring(0, 2000),
        exitCode: 124
      });
    }, timeoutMs);

    if (signal) {
      abortHandler = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
        finish(reject, new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  });
}

async function executeMcpTool(toolName, args, options = {}) {
  const signal = options.signal;
  const client = getMcpClient();
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let result;
    switch (toolName) {
      case 'get_tasks':
        result = await callMcpWithCompatibility(client, 'list_tasks', {
          status: args.status,
          project: args.project,
          limit: args.limit || 20
        });
        break;
      case 'create_task':
        result = await callMcpWithCompatibility(client, 'create_task', args);
        break;
      case 'get_calendar':
        result = await callMcpWithCompatibility(client, 'list_events', {
          maxResults: args.maxResults || 10,
          timeMin: args.timeMin,
          timeMax: args.timeMax
        });
        break;
      case 'get_email_summary':
        result = await callMcpWithCompatibility(client, 'gmail_summary', {});
        break;
      case 'search_memory':
        result = await callMcpWithCompatibility(client, 'search_memory', { query: args.query });
        break;
      case 'deep_research':
        result = await callMcpWithCompatibility(client, 'deep_research', {
          query: args.query,
          ...(args.focus_areas ? { focus_areas: args.focus_areas } : {})
        });
        break;
      case 'web_search':
        result = await callMcpWithCompatibility(client, 'web_search', {
          query: args.query,
          ...(args.count ? { count: args.count } : {})
        });
        break;
      case 'call_mcp':
        result = await callMcpWithCompatibility(client, args.tool, args.args || {});
        break;
      default:
        return { error: `Unknown MCP tool: ${toolName}` };
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return { result };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { error: `MCP error: ${err.message}` };
  }
}

async function executeTool(projectDir, toolName, args, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  switch (toolName) {
    case 'read_file':
      return executeReadFile(projectDir, args.path);
    case 'list_files':
      return executeListFiles(projectDir, args.path, args.recursive);
    case 'search_code':
      return executeSearchCode(projectDir, args.pattern, args.path, args.file_pattern, { signal });
    case 'create_file':
      return executeCreateFile(projectDir, args.path, args.content);
    case 'edit_file':
      return executeEditFile(projectDir, args.path, args.content);
    case 'run_command':
      return executeRunCommand(projectDir, args.command, { signal });
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const MCP_TOOLS = new Set(['get_tasks', 'create_task', 'get_calendar', 'get_email_summary', 'search_memory', 'deep_research', 'web_search', 'call_mcp']);

// ─── SSE Stream Parser ───────────────────────────────────────────────────────

/**
 * Consume an SSE stream response and call onToken for each text chunk.
 * Strips <think>...</think> blocks before firing tokens.
 * Returns the full assembled content string (think blocks removed).
 */
// Strip model control tokens like <|start|>, <|channel|>, <|constrain|>, etc.
const CONTROL_TOKEN_RE = /<\|[^|]*\|>/g;
function stripControlTokens(text) {
  const cleaned = text.replace(CONTROL_TOKEN_RE, '');
  return cleaned.replace(/^\s+$/, '');
}

async function consumeStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let thinkBuffer = '';   // accumulates text inside a think block
  let inThink = false;

  const flush = (text) => {
    const clean = stripControlTokens(text);
    if (!clean) return;
    fullContent += clean;
    onToken(clean);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta;
        if (!delta?.content) continue;

        let chunk = delta.content;

        // Process character by character to handle think blocks spanning chunks
        let out = '';
        for (let i = 0; i < chunk.length; i++) {
          if (!inThink) {
            // Check for opening tag
            const remaining = chunk.slice(i);
            if (remaining.startsWith('<think>')) {
              inThink = true;
              thinkBuffer = '';
              i += 6; // skip '<think>'
              continue;
            }
            out += chunk[i];
          } else {
            // Inside think block - check for closing tag
            thinkBuffer += chunk[i];
            if (thinkBuffer.endsWith('</think>')) {
              inThink = false;
              thinkBuffer = '';
            }
          }
        }

        if (out) flush(out);
      } catch {
        // Skip malformed chunks
      }
    }
  }

  return fullContent;
}

// ─── Agentic Loop ───────────────────────────────────────────────────────────

class AgenticRunner {
  constructor(lmStudio, options = {}) {
    this.lmStudio = lmStudio;
    this.onToolCall = options.onToolCall || (() => {});
    this.onToolResult = options.onToolResult || (() => {});
    this.onToken = options.onToken || (() => {});       // called per token on final response
    this.onContent = options.onContent || (() => {});   // called with full final content
    this.onReasoning = options.onReasoning || (() => {}); // called with reasoning text when thinking
    this.onWarning = options.onWarning || (() => {});
    this.totalTokens = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.lastTurnTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
  }

  /**
   * Simulate streaming by emitting content in small word-sized chunks.
   * Makes non-streaming responses render progressively like real streaming.
   */
  async emitStreaming(content) {
    // Split into small chunks (by words, preserving whitespace)
    const chunks = content.match(/\S+\s*/g) || [content];
    for (const chunk of chunks) {
      this.onToken(chunk);
      // Tiny yield to let the event loop render each chunk
      await new Promise(r => setTimeout(r, 8));
    }
  }

  /**
   * Run the agentic loop.
   * Tool-call iterations use non-streaming chat().
   * The final (no-tool) response streams token-by-token via onToken.
   *
   * @param {Array} messages - The message array (system + history + user)
   * @param {string} projectDir - The project directory for tool execution
   * @param {Object} options - Model options (model, temperature, etc.)
   * @returns {string} - The final assistant response content
   */
  async run(messages, projectDir, options = {}) {
    let iterations = 0;
    const writtenFiles = [];
    this.totalTokens = 0; // Track cumulative tokens across iterations
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.lastTurnTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;

    const logRunTotals = (phase) => {
      appendDebugLog(
        `run_totals phase=${phase} ` +
        `iterations=${iterations} ` +
        `prompt=${this.totalPromptTokens} ` +
        `completion=${this.totalCompletionTokens} ` +
        `total=${this.totalTokens} ` +
        `cache_read=${this.totalCacheReadTokens} ` +
        `cache_create=${this.totalCacheCreationTokens}\n`
      );
    };

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Check if aborted before each iteration
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Use non-streaming for tool-call iterations (need full response to parse tool_calls)
      const data = await this.lmStudio.chat(messages, {
        model: options.model,
        temperature: options.temperature ?? 0.6,
        topP: options.topP,
        repeatPenalty: options.repeatPenalty,
        reasoningEffort: options.reasoningEffort,
        maxTokens: options.maxTokens ?? 32000,
        tools: options.tools || TOOLS,
        toolChoice: 'auto',
        thinking: options.thinking ?? false,
        signal: options.signal
      });

      const choice = data.choices[0];
      const assistantMessage = choice.message;

      // Track token usage from API response
      const usage = data.usage || {};
      const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));
      const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);
      const cacheCreationTokens = Number(
        usage.cache_creation_input_tokens
        || usage.cache_creation?.ephemeral_5m_input_tokens
        || usage.cache_creation?.ephemeral_1h_input_tokens
        || 0
      );
      if (totalTokens > 0) {
        this.totalTokens += totalTokens;
        this.lastTurnTokens = promptTokens > 0 ? promptTokens : totalTokens;
      }
      if (promptTokens > 0 || completionTokens > 0) {
        this.totalPromptTokens += promptTokens;
        this.totalCompletionTokens += completionTokens;
      }
      if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
        this.totalCacheReadTokens += cacheReadTokens;
        this.totalCacheCreationTokens += cacheCreationTokens;
      }

      // DEBUG: log raw response to understand model behavior
      const reasoning = assistantMessage.reasoning || assistantMessage.reasoning_content || '';
      appendDebugLog(
        `\n=== iteration ${iterations} ===\n` +
        `finish_reason: ${choice.finish_reason}\n` +
        `usage: prompt=${promptTokens} completion=${completionTokens} total=${totalTokens} cache_read=${cacheReadTokens} cache_create=${cacheCreationTokens}\n` +
        `tool_calls: ${JSON.stringify(assistantMessage.tool_calls?.map(t => ({ name: t.function.name, args: t.function.arguments })), null, 2)}\n` +
        (reasoning ? `reasoning: ${reasoning.slice(0, 500)}\n` : '') +
        `content: ${(assistantMessage.content || '').slice(0, 500)}\n`
      );

      // Fallback: detect Harmony-format tool calls leaked into content
      // GPT-OSS sometimes outputs <|channel|>functions.tool_name as text instead of proper tool_calls
      if ((!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) && assistantMessage.content) {
        const harmonyMatch = assistantMessage.content.match(/<\|channel\|>functions\.(\w+).*?<\|message\|>\s*(\{[\s\S]*)/);
        if (harmonyMatch) {
          const toolName = harmonyMatch[1];
          let argsStr = harmonyMatch[2].trim();
          // Clean up: find the JSON object
          try {
            const args = JSON.parse(argsStr);
            assistantMessage.tool_calls = [{
              type: 'function',
              id: String(Date.now()),
              function: { name: toolName, arguments: JSON.stringify(args) }
            }];
            // Strip the Harmony tokens from content
            assistantMessage.content = assistantMessage.content.replace(/<\|channel\|>[\s\S]*/, '').trim() || null;
          } catch { /* couldn't parse args, skip */ }
        }
      }

      // Check if model wants to call tools
      // Some models use finish_reason "tool_calls", others use "stop" or "function_call"
      // but still include tool_calls in the message. Check for the array itself.
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        // Add assistant message to history, preserving the reasoning field
        // GPT-OSS requires the reasoning/CoT from prior tool calls to be passed back.
        // Other models ignore it harmlessly.
        const historyMsg = {
          role: 'assistant',
          content: assistantMessage.content || null,
          tool_calls: assistantMessage.tool_calls
        };
        if (assistantMessage.reasoning) {
          historyMsg.reasoning = assistantMessage.reasoning;
        }
        if (assistantMessage.reasoning_content) {
          historyMsg.reasoning_content = assistantMessage.reasoning_content;
        }
        messages.push(historyMsg);

        for (const toolCall of assistantMessage.tool_calls) {
          if (options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const functionName = toolCall.function.name;
          let args;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          this.onToolCall(functionName, args);

          // Execute tool
          // Block write tools in read-only (plan) mode
          let result;
          if (options.readOnly && !READ_ONLY_TOOL_NAMES.has(functionName)) {
            result = { error: `Tool "${functionName}" is blocked in plan mode. Only read_file, list_files, and search_code are available.` };
          } else if (MCP_TOOLS.has(functionName)) {
            result = await executeMcpTool(functionName, args, { signal: options.signal });
          } else {
            result = await executeTool(projectDir, functionName, args, { signal: options.signal });
          }

          this.onToolResult(functionName, !result.error, result);

          // DEBUG: log tool result
          appendDebugLog(`  tool: ${functionName} -> ${JSON.stringify(result).slice(0, 200)}\n`);

          // Track written files for reporting
          if ((functionName === 'create_file' || functionName === 'edit_file') && result.success) {
            writtenFiles.push(result.path);
          }

          // Add result to messages
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        appendDebugLog(`  writtenFiles: ${writtenFiles}\n`);

        // Continue the loop - let the model decide when it's done

      } else {
        // Final response - no more tool calls.
        // The non-streaming chat() call already returned content. Use it directly
        // instead of making a redundant streaming call that may return empty/truncated.
        let existingContent = stripControlTokens(assistantMessage.content || '');

        // Extract inline <think>/<thinking> blocks from content (Qwen3.5 embeds reasoning in content)
        let inlineReasoning = '';
        existingContent = existingContent.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_, r) => {
          inlineReasoning += r.trim();
          return '';
        });
        // Also handle orphan: content starts with reasoning text followed by </think>
        existingContent = existingContent.replace(/^[\s\S]*?<\/think(?:ing)?>\s*/i, (match) => {
          inlineReasoning += match.replace(/<\/think(?:ing)?>/i, '').trim();
          return '';
        });
        existingContent = existingContent.trim();

        const reasoning = assistantMessage.reasoning || assistantMessage.reasoning_content || inlineReasoning;

        // If the model already produced content in this iteration, use it directly
        if (existingContent) {
          if (reasoning) {
            this.onReasoning(stripControlTokens(reasoning));
          }
          await this.emitStreaming(existingContent);
          this.onContent(existingContent);
          logRunTotals('final-content');
          return existingContent;
        }

        // Model returned reasoning but no visible content - still got a real response.
        // Don't make a redundant second call; use reasoning as the response.
        if (reasoning) {
          this.onReasoning(stripControlTokens(reasoning));
          // Some models put the actual answer in reasoning when content is empty.
          // Return a minimal acknowledgment rather than an empty response.
          const fallback = '(Response was in reasoning only - see thinking output above)';
          await this.emitStreaming(fallback);
          this.onContent(fallback);
          logRunTotals('final-reasoning-fallback');
          return fallback;
        }

        // Truly empty response (no content AND no reasoning) - generate a final response.
        // This should be rare; it means the model returned nothing useful at all.
        if (options.thinking) {
          const thinkData = await this.lmStudio.chat(messages, {
            model: options.model,
            temperature: options.temperature ?? 0.6,
            topP: options.topP,
            repeatPenalty: options.repeatPenalty,
            reasoningEffort: options.reasoningEffort,
            maxTokens: options.maxTokens ?? 32000,
            thinking: true,
            signal: options.signal
          });
          const thinkMsg = thinkData.choices[0]?.message;
          const thinkReasoning = thinkMsg?.reasoning;
          const content = stripControlTokens(thinkMsg?.content || '');

          if (thinkReasoning) this.onReasoning(stripControlTokens(thinkReasoning));
          await this.emitStreaming(content);
          this.onContent(content);
          logRunTotals('final-think-pass');
          return content;
        }

        // Normal streaming final response
        const streamResponse = await this.lmStudio.chatStream(messages, {
          model: options.model,
          temperature: options.temperature ?? 0.6,
          topP: options.topP,
          repeatPenalty: options.repeatPenalty,
          reasoningEffort: options.reasoningEffort,
          maxTokens: options.maxTokens ?? 32000,
          thinking: false,
          signal: options.signal
        });

        const content = await consumeStream(streamResponse, (token) => {
          this.onToken(token);
        });

        this.onContent(content);
        logRunTotals('final-stream');
        return content;
      }
    }

    this.onWarning('Max tool iterations reached');
    logRunTotals('max-iterations');
    return '';
  }
}

module.exports = { AgenticRunner, TOOLS, READ_ONLY_TOOLS, executeTool, setMcpClient };
