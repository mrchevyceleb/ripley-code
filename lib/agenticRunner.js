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
  mcpHealthy = null;
  mcpHealthCheckAt = 0;
}

// MCP tool-name cache (server advertises dynamic tool catalogs)
let mcpToolNameCache = null;
let mcpToolNameCacheAt = 0;
const MCP_TOOL_CACHE_TTL_MS = 30 * 1000;

// MCP health state (cached for 60s to avoid repeated slow checks)
let mcpHealthy = null; // null = unknown, true/false = cached result
let mcpHealthCheckAt = 0;
const MCP_HEALTH_CACHE_TTL_MS = 60 * 1000;

async function checkMcpHealth() {
  const now = Date.now();
  if (mcpHealthy !== null && (now - mcpHealthCheckAt) < MCP_HEALTH_CACHE_TTL_MS) {
    return mcpHealthy;
  }
  try {
    const client = getMcpClient();
    if (typeof client.isConnected === 'function') {
      mcpHealthy = await client.isConnected();
    } else {
      // If no health check method, assume healthy and let individual calls fail
      mcpHealthy = true;
    }
  } catch {
    mcpHealthy = false;
  }
  mcpHealthCheckAt = now;
  return mcpHealthy;
}
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

// ─── Error Enrichment ─────────────────────────────────────────────────────────

function enrichToolError(functionName, args, result) {
  if (!result || !result.error) return result;
  const errStr = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);

  // Categorize errors with actionable guidance
  const patterns = [
    { test: /Unknown tool|unknown tool/i, category: 'PERMANENT', retryable: false,
      guidance: `Tool "${args?.tool || functionName}" does not exist. Do not retry.` },
    { test: /ECONNREFUSED|ECONNRESET|unreachable|socket hang up/i, category: 'TRANSIENT', retryable: false,
      guidance: 'Service is unreachable. Proceed without this tool.' },
    { test: /timed? ?out|ETIMEDOUT|deadline exceeded/i, category: 'TRANSIENT', retryable: false,
      guidance: 'Request timed out. Move on to other work.' },
    { test: /not found|ENOENT|no such file/i, category: 'PERMANENT', retryable: false,
      guidance: 'Resource not found. Check the path or name.' },
    { test: /401|403|unauthorized|forbidden|expired|invalid.*token/i, category: 'PERMANENT', retryable: false,
      guidance: 'Authentication/authorization issue. Skip this service.' },
    { test: /5\d{2}|internal server error|bad gateway|service unavailable/i, category: 'TRANSIENT', retryable: true,
      guidance: 'Server error. May resolve on retry.' }
  ];

  for (const p of patterns) {
    if (p.test.test(errStr)) {
      return { ...result, category: p.category, retryable: p.retryable, guidance: p.guidance };
    }
  }
  return result;
}

// ─── Transient Retry ──────────────────────────────────────────────────────────

const TRANSIENT_ERROR_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|5\d{2}|bad gateway|service unavailable|internal server error/i;

async function withRetry(fn, { maxRetries = 2, baseDelay = 1000, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return await fn();
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      const errMsg = err?.message || String(err);
      // Only retry transient errors
      if (!TRANSIENT_ERROR_RE.test(errMsg) || attempt >= maxRetries) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt); // 1s, 2s
      appendDebugLog(`  [retry] attempt ${attempt + 1}/${maxRetries} after ${delay}ms: ${errMsg.slice(0, 200)}\n`);
      // Abort-aware delay
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { settled = true; cleanup(); resolve(); }, delay);
        let onAbort;
        const cleanup = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); };
        if (signal) {
          onAbort = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); } };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
  throw lastErr;
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
      description: 'Read the contents of a file. Can read any file on the system, not just inside the project. Use relative paths for project files or absolute paths (e.g. C:\\path\\to\\file) for files elsewhere. Supports optional start_line/end_line for reading specific sections of large files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path for project files (e.g., "src/App.tsx") or absolute path for any file (e.g., "C:\\\\Users\\\\user\\\\other-project\\\\file.ts")'
          },
          start_line: {
            type: 'integer',
            description: 'Line number to start reading from (1-based). Use with end_line to read specific sections of large files.'
          },
          end_line: {
            type: 'integer',
            description: 'Line number to stop reading at (inclusive). Use with start_line to read specific sections of large files.'
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
            description: 'Relative path for project dirs (e.g., "src") or absolute path for any dir (e.g., "C:\\\\Projects\\\\my-app")'
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
      description: 'Search for a pattern in files. Path can be a directory (searches recursively) or a single file. Can search anywhere on the system. Use relative paths for project files or absolute paths for anywhere else.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The search pattern (supports regex)'
          },
          path: {
            type: 'string',
            description: 'The directory or file to search in (default: "."). Can be an absolute path like "C:\\\\other-project\\\\file.js"'
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
      description: 'Get tasks. Filter by status (not_started, in_progress, completed) or project name. Leave filters empty to get all urgent/upcoming tasks.',
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
      description: 'Create a new task.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          project: { type: 'string', description: 'Project name' },
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
      description: 'Get upcoming calendar events.',
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
      description: 'Get a summary of recent unread emails.',
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
      description: 'Search saved memories and context notes.',
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
      name: 'ripley_help',
      description: 'Get detailed documentation about Ripley Code features. Use this when a user asks how to do something in Ripley, or when you need to guide them through a feature.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The topic to look up: "overview", "hooks", "models", "commands", "project-instructions", "agents"'
          }
        },
        required: []
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
const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_files', 'search_code', 'ripley_help', 'ask_human']);
const READ_ONLY_TOOLS = TOOLS.filter(t => READ_ONLY_TOOL_NAMES.has(t.function.name));

const IGNORE_PATTERNS = ['node_modules', '.git', '.next', 'dist', 'build', '.ripley'];
const MAX_ITERATIONS = 30;
const WRITE_TOOL_NAMES = new Set(['create_file', 'edit_file', 'run_command']);
const CONTEXT_TRIM_THRESHOLD = 0.65; // 65% of context limit - trim earlier to save tokens
const CONTEXT_TRIM_KEEP_RECENT = 6;  // Keep last N messages intact

function estimateTokenCount(messages) {
  return Math.ceil(JSON.stringify(messages).length / 3.5);
}

function trimContextIfNeeded(messages, contextLimit) {
  if (!contextLimit || contextLimit <= 0) return;
  const estimated = estimateTokenCount(messages);
  if (estimated < contextLimit * CONTEXT_TRIM_THRESHOLD) return;

  // Truncate old tool result messages, keeping the last CONTEXT_TRIM_KEEP_RECENT intact
  const protectedStart = Math.max(0, messages.length - CONTEXT_TRIM_KEEP_RECENT);
  let trimmed = 0;
  for (let i = 1; i < protectedStart; i++) { // skip system message at index 0
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 300) {
      msg.content = msg.content.substring(0, 150) + '\n[truncated]';
      trimmed++;
    }
  }
  if (trimmed > 0) {
    appendDebugLog(`  [context trim] Truncated ${trimmed} old tool results (estimated ${estimated} tokens, limit ${contextLimit})\n`);
  }
}

// ─── Tool Executors ─────────────────────────────────────────────────────────

function executeReadFile(projectDir, filePath, startLine, endLine) {
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
    const lines = content.split('\n');
    const totalLines = lines.length;

    // Line-range reading
    if (startLine != null || endLine != null) {
      const start = Math.max(1, startLine || 1);
      const end = Math.min(totalLines, endLine || totalLines);
      if (start > end) {
        return { error: `start_line (${start}) must be less than or equal to end_line (${end})` };
      }
      const sliced = lines.slice(start - 1, end);
      const numbered = sliced.map((line, i) => `${start + i}: ${line}`).join('\n');
      const maxLength = 20000;
      if (numbered.length > maxLength) {
        return {
          content: numbered.substring(0, maxLength),
          truncated: true,
          totalLines,
          startLine: start,
          endLine: end,
          hint: `Requested range still exceeds display limit. Try a narrower range (e.g., start_line=${start}, end_line=${start + 200}).`
        };
      }
      return { content: numbered, totalLines, startLine: start, endLine: end };
    }

    // Full file reading with improved truncation message
    const maxLength = 20000;
    if (content.length > maxLength) {
      return {
        content: content.substring(0, maxLength),
        truncated: true,
        totalLength: content.length,
        totalLines,
        hint: `File is ${totalLines} lines (${content.length} chars). Only the first portion was returned. Use start_line/end_line to read specific sections, or use search_code to find the content you need.`
      };
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
          if (recursive && results.length < 500) {
            listDir(path.join(dir, entry.name), relativePath);
          }
        } else {
          results.push({ name: relativePath, type: 'file' });
        }
        if (results.length >= 500) break;
      }
    }
    listDir(fullPath);
    // Compact format: just paths with type indicator (/ suffix for dirs)
    const compact = results.map(f => f.type === 'directory' ? f.name + '/' : f.name);
    return { files: compact, count: results.length, ...(results.length >= 500 ? { truncated: true, limit: 500 } : {}) };
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

    // Handle single file search (fixes ENOTDIR when path is a file)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const matches = [];
        lines.forEach((line, idx) => {
          if (regex.test(line)) {
            matches.push({ line: idx + 1, content: line.trim().substring(0, 200) });
          }
        });
        if (matches.length > 0) {
          return { results: [{ file: path.relative(projectDir, fullPath), matches: matches.slice(0, 20) }] };
        }
        return { results: [] };
      } catch {
        return { error: `Could not read file: ${searchPath}` };
      }
    }

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
      const raw = (stdout + stderr);
      finish(resolve, {
        error: err.message,
        output: raw.substring(0, 10000),
        ...(raw.length > 10000 ? { truncated: true, totalLength: raw.length } : {})
      });
    });

    child.on('close', (code) => {
      const output = stdout + stderr;
      if (code === 0) {
        const limit = 15000;
        finish(resolve, {
          success: true,
          output: output.substring(0, limit),
          ...(output.length > limit ? { truncated: true, totalLength: output.length } : {})
        });
      } else {
        const limit = 10000;
        finish(resolve, {
          error: `Command failed with exit code ${code}`,
          output: output.substring(0, limit),
          exitCode: code,
          ...(output.length > limit ? { truncated: true, totalLength: output.length } : {})
        });
      }
    });

    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      const raw = (stdout + stderr);
      finish(resolve, {
        error: `Command timed out after ${timeoutMs}ms`,
        output: raw.substring(0, 10000),
        exitCode: 124,
        ...(raw.length > 10000 ? { truncated: true, totalLength: raw.length } : {})
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
  // Health gate: fail fast if MCP is unreachable instead of waiting 60s per tool
  const healthy = await checkMcpHealth();
  if (!healthy) {
    return {
      error: 'MCP server is unreachable. Proceed without external services. Do NOT retry MCP tools until the server is back.',
      category: 'TRANSIENT',
      retryable: false,
      guidance: 'The MCP server is down. Skip MCP-dependent steps and work with what you have.'
    };
  }
  const client = getMcpClient();
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Determine the MCP call to make
    const makeMcpCall = async () => {
      switch (toolName) {
        case 'get_tasks':
          return callMcpWithCompatibility(client, 'list_tasks', {
            status: args.status,
            project: args.project,
            limit: args.limit || 20
          });
        case 'create_task':
          return callMcpWithCompatibility(client, 'create_task', args);
        case 'get_calendar':
          return callMcpWithCompatibility(client, 'list_events', {
            maxResults: args.maxResults || 10,
            timeMin: args.timeMin,
            timeMax: args.timeMax
          });
        case 'get_email_summary':
          return callMcpWithCompatibility(client, 'gmail_summary', {});
        case 'search_memory':
          return callMcpWithCompatibility(client, 'search_memory', { query: args.query });
        case 'deep_research':
          return callMcpWithCompatibility(client, 'deep_research', {
            query: args.query,
            ...(args.focus_areas ? { focus_areas: args.focus_areas } : {})
          });
        case 'web_search':
          return callMcpWithCompatibility(client, 'web_search', {
            query: args.query,
            ...(args.count ? { count: args.count } : {})
          });
        case 'call_mcp':
          return callMcpWithCompatibility(client, args.tool, args.args || {});
        default:
          throw new Error(`Unknown MCP tool: ${toolName}`);
      }
    };

    // Wrap with retry for transient failures (2 retries, 1s/2s backoff)
    const result = await withRetry(makeMcpCall, { maxRetries: 2, baseDelay: 1000, signal });

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Parse JSON strings to avoid double-encoding when serialized later
    let parsed = result;
    try { parsed = JSON.parse(result); } catch {}
    return { result: parsed, _mcp: true };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // Mark MCP as unhealthy on connection errors so subsequent calls fail fast
    if (TRANSIENT_ERROR_RE.test(err.message)) {
      mcpHealthy = false;
      mcpHealthCheckAt = Date.now();
    }
    return { error: `MCP error: ${err.message}` };
  }
}

// Ripley Code docs directory (co-located with the CLI source)
const RIPLEY_DOCS_DIR = path.join(__dirname, '..', 'docs');
const VALID_HELP_TOPICS = new Set(['overview', 'hooks', 'models', 'commands', 'project-instructions', 'agents']);

function executeRipleyHelp(topic) {
  const normalized = (topic || '').trim().toLowerCase();
  if (!normalized) {
    // Return the overview with the topic list
    try {
      return { content: fs.readFileSync(path.join(RIPLEY_DOCS_DIR, 'overview.md'), 'utf-8') };
    } catch {
      return { error: 'Help docs not found.' };
    }
  }
  if (!VALID_HELP_TOPICS.has(normalized)) {
    return { error: `Unknown topic "${topic}". Valid topics: ${[...VALID_HELP_TOPICS].join(', ')}` };
  }
  try {
    const content = fs.readFileSync(path.join(RIPLEY_DOCS_DIR, `${normalized}.md`), 'utf-8');
    return { content };
  } catch {
    return { error: `Help doc for "${topic}" not found.` };
  }
}

async function executeTool(projectDir, toolName, args, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  switch (toolName) {
    case 'read_file':
      return executeReadFile(projectDir, args.path, args.start_line, args.end_line);
    case 'list_files':
      return executeListFiles(projectDir, args.path, args.recursive);
    case 'search_code':
      return executeSearchCode(projectDir, args.pattern, args.path, args.file_pattern, { signal });
    case 'create_file':
      return executeCreateFile(projectDir, args.path, args.content);
    case 'edit_file':
      return executeEditFile(projectDir, args.path, args.content);
    case 'ripley_help':
      return executeRipleyHelp(args.topic);
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

// ─── Repetition Detection ─────────────────────────────────────────────────────

/**
 * Detects degenerate model output where the same phrase repeats endlessly.
 * Returns true if the recent output is stuck in a repetition loop.
 */
function detectRepetition(text, windowSize = 500) {
  if (text.length < windowSize) return false;
  const tail = text.slice(-windowSize);
  // Check for a repeating substring (10-80 chars) that fills 80%+ of the window
  for (let len = 10; len <= 80; len++) {
    const phrase = tail.slice(-len);
    let count = 0;
    let pos = 0;
    while ((pos = tail.indexOf(phrase, pos)) !== -1) {
      count++;
      pos += phrase.length;
    }
    if (count >= Math.floor(windowSize / len) * 0.7) return true;
  }
  return false;
}

async function consumeStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let thinkBuffer = '';   // accumulates text inside a think block
  let inThink = false;
  let repetitionDetected = false;

  const flush = (text) => {
    const clean = stripControlTokens(text);
    if (!clean) return;
    fullContent += clean;
    if (!repetitionDetected) {
      onToken(clean);
      // Check for repetition every 200 chars
      if (fullContent.length % 200 < clean.length && detectRepetition(fullContent)) {
        repetitionDetected = true;
        onToken('\n\n[Repetition detected - output truncated]');
        appendDebugLog(`  [repetition-guard] Streaming output truncated at ${fullContent.length} chars\n`);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // If repetition detected, still consume the stream to avoid backpressure, but don't process
    if (repetitionDetected) continue;

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
    this.onIntermediateContent = options.onIntermediateContent || (() => {}); // model narration between tool rounds
    this.onFileWrite = options.onFileWrite || null;           // callback(path, action) after file write
    this.onCommandComplete = options.onCommandComplete || null; // callback(command, result) after command
    this.customToolExecutors = options.customToolExecutors || null; // Map<string, async fn>
    this.customTools = options.customTools || [];                   // Extra tool definitions to append
    this._lastWrittenFiles = null;
    this.totalTokens = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.lastTurnTokens = 0;
    this.lastTurnMessagesEstimate = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
  }

  /**
   * Simulate streaming by emitting content in small word-sized chunks.
   * Makes non-streaming responses render progressively like real streaming.
   */
  getWrittenFiles() {
    return [...(this._lastWrittenFiles || [])];
  }

  async emitStreaming(content) {
    // Truncate degenerate repetitive output before emitting
    if (content.length > 500 && detectRepetition(content)) {
      // Find where the repetition starts and truncate there
      const truncAt = Math.min(content.length, 500);
      content = content.slice(0, truncAt) + '\n\n[Repetition detected - output truncated]';
      appendDebugLog(`  [repetition-guard] emitStreaming truncated at ${truncAt} chars\n`);
    }
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
  /**
   * Inject a steering message into the live agentic loop without restarting.
   * The message will be appended before the next API call.
   */
  injectSteer(text) {
    this._pendingSteers = this._pendingSteers || [];
    this._pendingSteers.push(text);
  }

  async run(messages, projectDir, options = {}) {
    let iterations = 0;
    const toolCallHistory = []; // Track tool calls for loop detection
    const failedMcpTools = new Set(); // Track MCP tools that returned "Unknown tool" errors
    let readOnlyStreak = 0; // Consecutive iterations with only read-only tool calls
    let loopWarningCount = 0; // How many times loop detection has fired
    const writtenFiles = [];
    this._lastWrittenFiles = null;
    this._pendingSteers = [];
    this.totalTokens = 0; // Track cumulative tokens across iterations
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.lastTurnTokens = 0;
    this.lastTurnMessagesEstimate = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;

    const logRunTotals = (phase) => {
      // Estimate context from actual messages when API doesn't return usage
      this.lastTurnMessagesEstimate = Math.ceil(JSON.stringify(messages).length / 3.5);
      appendDebugLog(
        `run_totals phase=${phase} ` +
        `iterations=${iterations} ` +
        `prompt=${this.totalPromptTokens} ` +
        `completion=${this.totalCompletionTokens} ` +
        `total=${this.totalTokens} ` +
        `cache_read=${this.totalCacheReadTokens} ` +
        `cache_create=${this.totalCacheCreationTokens} ` +
        `messagesEstimate=${this.lastTurnMessagesEstimate}\n`
      );
    };

    // Discover available MCP tools and inject into call_mcp description
    try {
      const client = getMcpClient();
      const mcpToolNames = await getAvailableMcpToolNames(client);
      if (mcpToolNames && mcpToolNames.size > 0) {
        const toolList = [...mcpToolNames].sort().join(', ');
        // Patch call_mcp description for this run (on a clone to avoid mutating the shared TOOLS array)
        const baseTools = options.tools || TOOLS;
        const callMcpIdx = baseTools.findIndex(t => t.function?.name === 'call_mcp');
        if (callMcpIdx >= 0) {
          const orig = baseTools[callMcpIdx];
          const baseDesc = orig.function.description.replace(/\.\s*Available MCP tools:.*$/, '');
          baseTools[callMcpIdx] = {
            ...orig,
            function: { ...orig.function, description: `${baseDesc}. Available MCP tools: ${toolList}` }
          };
        }
        appendDebugLog(`[MCP discovery] ${mcpToolNames.size} tools available: ${toolList.slice(0, 300)}\n`);
      }
    } catch (err) {
      appendDebugLog(`[MCP discovery] Failed: ${err.message}\n`);
    }

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Check if aborted before each iteration
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Trim context if approaching limit
      const contextLimit = options.contextLimit || 0;
      if (contextLimit > 0) {
        trimContextIfNeeded(messages, contextLimit);
      }

      // Inject any pending steer messages before the API call
      if (this._pendingSteers && this._pendingSteers.length > 0) {
        for (const steerText of this._pendingSteers) {
          messages.push({
            role: 'user',
            content: `## Steering Message\n\nAdditional guidance for this turn:\n\n${steerText}`
          });
          appendDebugLog(`  [steer injected]: ${steerText.slice(0, 200)}\n`);
        }
        this._pendingSteers = [];
      }

      // Merge custom tools into the tool list
      const baseTools = options.tools || TOOLS;
      const mergedTools = this.customTools.length > 0
        ? [...baseTools, ...this.customTools]
        : baseTools;

      // Use non-streaming for tool-call iterations (need full response to parse tool_calls)
      appendDebugLog(`\n--- sending iteration ${iterations} (${messages.length} msgs, model=${options.model || 'default'}) ---\n`);
      const chatOpts = {
        model: options.model,
        temperature: options.temperature ?? 0.6,
        topP: options.topP,
        repeatPenalty: options.repeatPenalty,
        reasoningEffort: options.reasoningEffort,
        maxTokens: options.maxTokens ?? 32000,
        tools: mergedTools,
        toolChoice: 'auto',
        thinking: (options.thinkingBudget && options.thinkingBudget > 0) ? options.thinkingBudget : false,
        signal: options.signal
      };
      const data = await withRetry(
        () => this.lmStudio.chat(messages, chatOpts),
        { maxRetries: 1, baseDelay: 2000, signal: options.signal }
      );

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

        // Surface model narration between tool rounds
        if (assistantMessage.content) {
          const narration = stripControlTokens(assistantMessage.content).trim();
          if (narration) this.onIntermediateContent(narration);
        }

        let mcpDataSummaries = [];
        let failedResearchTools = [];

        // ─── Execute one tool call and return its result + metadata ───
        const executeOneToolCall = async (toolCall) => {
          const functionName = toolCall.function.name;
          let args;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          // Track tool calls for loop detection
          const trackingName = (functionName === 'call_mcp' && args.tool) ? args.tool : functionName;
          const trackingEntry = { signature: `${trackingName}:${JSON.stringify(args)}`, name: trackingName, hadError: false };
          toolCallHistory.push(trackingEntry);

          this.onToolCall(functionName, args);

          const startTime = Date.now();

          // Execute tool
          let result;
          const customExec = this.customToolExecutors || options.customToolExecutors;
          if (customExec?.has?.(functionName)) {
            result = await customExec.get(functionName)(args, { signal: options.signal });
          } else if (options.readOnly && !READ_ONLY_TOOL_NAMES.has(functionName)) {
            result = { error: `Tool "${functionName}" is blocked in plan mode. Only ${[...READ_ONLY_TOOL_NAMES].join(', ')} are available.` };
          } else if (MCP_TOOLS.has(functionName)) {
            result = await executeMcpTool(functionName, args, { signal: options.signal });
          } else {
            result = await executeTool(projectDir, functionName, args, { signal: options.signal });
          }

          const elapsed = Date.now() - startTime;

          // Enrich errors with category/guidance for the AI
          if (result.error) {
            result = enrichToolError(functionName, args, result);
            trackingEntry.hadError = true;
          }

          this.onToolResult(functionName, !result.error, result, elapsed);

          appendDebugLog(`  tool: ${functionName} (${elapsed}ms) -> ${JSON.stringify(result).slice(0, 200)}\n`);

          // Track written files for reporting
          if ((functionName === 'create_file' || functionName === 'edit_file') && result.success) {
            writtenFiles.push(result.path);
            if (this.onFileWrite) this.onFileWrite(result.path, functionName);
          }

          // Track command execution for hooks
          if (functionName === 'run_command' && !result.error) {
            if (this.onCommandComplete) this.onCommandComplete(args.command, result);
          }

          return { toolCall, functionName, args, result };
        };

        // ─── Partition into parallel-safe and serial sets ───
        const SERIAL_TOOLS = new Set(['create_file', 'edit_file', 'run_command']);
        const parallelCalls = [];
        const serialCalls = [];
        for (const tc of assistantMessage.tool_calls) {
          const name = tc.function.name;
          if (SERIAL_TOOLS.has(name)) {
            serialCalls.push(tc);
          } else {
            parallelCalls.push(tc);
          }
        }

        // Execute parallel batch first (read-only and MCP calls)
        const allResults = [];
        if (parallelCalls.length > 1) {
          appendDebugLog(`  [parallel] Running ${parallelCalls.length} tools in parallel\n`);
          const settled = await Promise.allSettled(
            parallelCalls.map(tc => executeOneToolCall(tc))
          );
          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') {
              allResults.push(outcome.value);
            } else {
              // Should not happen (executeOneToolCall catches errors), but handle gracefully
              appendDebugLog(`  [parallel] Unexpected rejection: ${outcome.reason}\n`);
            }
          }
        } else if (parallelCalls.length === 1) {
          allResults.push(await executeOneToolCall(parallelCalls[0]));
        }

        // Execute serial batch sequentially
        for (const tc of serialCalls) {
          if (options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          allResults.push(await executeOneToolCall(tc));
        }

        // Push results to messages in original tool_call order (API requires matching order)
        const resultMap = new Map(allResults.map(r => [r.toolCall.id, r]));
        for (const tc of assistantMessage.tool_calls) {
          const r = resultMap.get(tc.id);
          if (!r) continue;
          const { functionName, args, result } = r;
          const effectiveName = (functionName === 'call_mcp' && args.tool) ? args.tool : functionName;

          let resultContent;
          if (result._mcp) {
            const clean = { ...result };
            delete clean._mcp;
            resultContent = JSON.stringify(clean);
            if (!result.error) {
              const preview = JSON.stringify(clean.result).slice(0, 500);
              mcpDataSummaries.push(`${effectiveName}: ${preview}`);
            }
          } else {
            resultContent = JSON.stringify(result);
          }

          if (result.error && (effectiveName === 'deep_research' || effectiveName === 'web_search')) {
            failedResearchTools.push(effectiveName);
          }

          if (functionName === 'call_mcp' && result.error) {
            const errorStr = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
            if (errorStr.includes('Unknown tool')) {
              const failedToolName = args.tool || effectiveName;
              failedMcpTools.add(failedToolName);
              appendDebugLog(`  [MCP] Unknown tool detected: ${failedToolName}, adding to failed set\n`);
            }
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultContent
          });
        }

        // After all tool results, inject a single consolidated system nudge
        const nudgeParts = [];

        if (mcpDataSummaries.length > 0) {
          nudgeParts.push('Present the tool data above to the user. Do NOT say you cannot access it.');
          const hasSearchResults = mcpDataSummaries.some(s => s.startsWith('deep_research:') || s.startsWith('web_search:'));
          if (hasSearchResults) {
            nudgeParts.push('Search results: ONLY state facts from results above. Do NOT extrapolate or invent details. Say "could not confirm" for gaps.');
          }
        }

        if (failedResearchTools.length > 0) {
          nudgeParts.push(`Research tools FAILED: ${failedResearchTools.join(', ')}. Tell user which lookups failed. Do NOT fill gaps from training data.`);
        }

        if (failedMcpTools.size > 0) {
          nudgeParts.push(`Non-existent MCP tools (do NOT retry): ${[...failedMcpTools].join(', ')}`);
        }

        if (nudgeParts.length > 0) {
          messages.push({
            role: 'system',
            content: nudgeParts.join('\n')
          });
        }

        // Track read-only streaks (iterations with no writes or commands)
        const thisIterToolNames = assistantMessage.tool_calls.map(t => t.function.name);
        const hadWriteAction = thisIterToolNames.some(n => WRITE_TOOL_NAMES.has(n));
        if (hadWriteAction) {
          readOnlyStreak = 0;
        } else {
          readOnlyStreak++;
        }

        // Loop detection: inject nudge or hard-break after all tool results
        // Only count calls that had errors - successful calls to the same tool are legitimate
        if (toolCallHistory.length >= 3) {
          const last = toolCallHistory[toolCallHistory.length - 1];
          const recent6 = toolCallHistory.slice(-6);
          const identicalCount = recent6.filter(e => e.signature === last.signature).length;
          const lastToolName = last.name;
          const recent8 = toolCallHistory.slice(-8);
          // Count how many of those same-name calls had errors
          const sameToolErrorCount = recent8.filter(e => e.name === lastToolName && e.hadError).length;

          // Trigger on: identical calls 3+ times, OR same tool with errors 4+ times in 8 calls
          if (identicalCount >= 3 || sameToolErrorCount >= 4) {
            loopWarningCount++;
            const loopNudge = identicalCount >= 3
              ? `WARNING: You have called ${lastToolName} with the same arguments ${identicalCount} times. This approach is not working.`
              : `WARNING: You have called ${lastToolName} ${sameToolErrorCount} times with errors in the last 8 calls. This tool is failing repeatedly. Consider a different approach.`;

            // Hard break on second loop detection (first one was a nudge)
            if (loopWarningCount >= 2) {
              appendDebugLog(`  [LOOP BREAKER] Forcing stop after ${loopWarningCount} loop warnings, ${iterations} iterations\n`);
              this.onWarning(`Loop detected: ${lastToolName} called repeatedly without progress. Stopping after ${iterations} iterations.`);
              messages.push({
                role: 'system',
                content: `STOP. You are stuck in a loop calling ${lastToolName} repeatedly. ` +
                  `You MUST provide your response NOW with whatever information you have gathered so far. ` +
                  `Do NOT call any more tools. Summarize what you found and what you could not resolve.`
              });
              // Force one more iteration without tools to get the final response
              const finalData = await this.lmStudio.chat(messages, {
                model: options.model,
                temperature: options.temperature ?? 0.6,
                maxTokens: options.maxTokens ?? 32000,
                signal: options.signal
              });
              const finalContent = stripControlTokens(finalData.choices?.[0]?.message?.content || '');
              this._lastWrittenFiles = [...writtenFiles];
              logRunTotals('loop-break');
              const loopResponse = finalContent || 'I got stuck in a loop and could not complete the task. Please try rephrasing your request.';
              await this.emitStreaming(loopResponse);
              this.onContent(loopResponse);
              return loopResponse;
            }

            messages.push({
              role: 'system',
              content: `${loopNudge} Try a different strategy:\n` +
                `- For large files: use read_file with start_line/end_line to read specific sections\n` +
                `- For search: try a different pattern, or use search_code with the file path directly\n` +
                `- For commands: run_command uses cmd.exe on Windows (not PowerShell). Use findstr, type, dir.\n` +
                `- Consider explaining the blocker to the user via ask_human instead of retrying`
            });
          }
        }

        // Hard break if 15+ consecutive read-only iterations with no progress
        if (readOnlyStreak >= 15) {
          appendDebugLog(`  [NO-PROGRESS BREAKER] ${readOnlyStreak} consecutive read-only iterations\n`);
          this.onWarning(`No write actions for ${readOnlyStreak} consecutive iterations. Stopping.`);
          messages.push({
            role: 'system',
            content: 'STOP. You have spent too many iterations reading files and searching without making any changes. ' +
              'Provide your response NOW. Summarize what you found and what changes are needed.'
          });
          const npData = await this.lmStudio.chat(messages, {
            model: options.model,
            temperature: options.temperature ?? 0.6,
            maxTokens: options.maxTokens ?? 32000,
            signal: options.signal
          });
          const npContent = stripControlTokens(npData.choices?.[0]?.message?.content || '');
          this._lastWrittenFiles = [...writtenFiles];
          logRunTotals('no-progress-break');
          const npResponse = npContent || 'I spent too many iterations researching without making progress. Please try a more specific request.';
          await this.emitStreaming(npResponse);
          this.onContent(npResponse);
          return npResponse;
        }

        appendDebugLog(`  writtenFiles: ${writtenFiles}\n`);
        this._lastWrittenFiles = [...writtenFiles];

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
        // IMPORTANT: Only strip if </think> appears at the very start or after only whitespace,
        // meaning the entire content up to that point is reasoning (no real answer before it).
        // The original greedy /^[\s\S]*?<\/think>/ was too aggressive - it matched and wiped
        // the full response when a model appended </think> to the end of its answer (e.g.,
        // "We moved Kim's dashboard to this url</think>"), leaving existingContent empty and
        // causing Ripley to silently stop producing output.
        const orphanMatch = existingContent.match(/^([\s\S]*?)<\/think(?:ing)?>\s*/i);
        if (orphanMatch) {
          const beforeClose = orphanMatch[1];
          const afterClose = existingContent.slice(orphanMatch[0].length).trim();
          // Only treat as orphan reasoning if there is actual content AFTER the </think> tag.
          // If nothing follows it, the text before it is the real answer - don't strip it.
          if (afterClose) {
            inlineReasoning += beforeClose.trim();
            existingContent = afterClose;
          } else {
            // No content after </think> - the text before is the real answer.
            // Just strip the trailing </think> tag so it doesn't appear in output.
            existingContent = existingContent.replace(/<\/think(?:ing)?>\s*$/i, '');
          }
        }
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
        if (options.thinkingBudget && options.thinkingBudget > 0) {
          const thinkData = await this.lmStudio.chat(messages, {
            model: options.model,
            temperature: options.temperature ?? 0.6,
            topP: options.topP,
            repeatPenalty: options.repeatPenalty,
            reasoningEffort: options.reasoningEffort,
            maxTokens: options.maxTokens ?? 32000,
            thinking: options.thinkingBudget,
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
