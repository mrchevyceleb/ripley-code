/**
 * Agentic Runner for Ripley Code v4
 * Tool-calling loop - extracted from the AI Router's agentic endpoint.
 * Runs locally, no middleware needed.
 */

const fs = require('fs');
const path = require('path');
const McpClient = require('./mcpClient');

// Singleton MCP client
let mcpClient = null;
function getMcpClient() {
  if (!mcpClient) mcpClient = new McpClient();
  return mcpClient;
}

// Tool definitions (OpenAI-compatible format)
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the project. Use this to examine code, configs, or any text file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative path to the file (e.g., "src/App.tsx", "package.json")'
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
      description: 'List files and directories in a given path. Use this to explore the project structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative directory path to list (e.g., "src", ".", "src/components")'
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
      description: 'Search for a pattern in files. Use this to find specific code, functions, or text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The search pattern (supports regex)'
          },
          path: {
            type: 'string',
            description: 'The directory to search in (default: ".")'
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
      name: 'call_mcp',
      description: 'Call any tool on the assistant-mcp server. Use this as an escape hatch when a specific tool isn\'t available above. Available tools include: gmail_send, gmail_reply, slack_send_message, slack_read_channel, create_event, update_task, complete_task, stripe operations, monday.com operations, web_search, quick_search.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The MCP tool name (e.g., "gmail_send", "slack_send_message")' },
          args: { type: 'object', description: 'Tool arguments as a JSON object' }
        },
        required: ['tool']
      }
    }
  }
];

const IGNORE_PATTERNS = ['node_modules', '.git', '.next', 'dist', 'build', '.ripley'];
const MAX_ITERATIONS = 10;

// ─── Tool Executors ─────────────────────────────────────────────────────────

function executeReadFile(projectDir, filePath) {
  try {
    const fullPath = path.resolve(projectDir, filePath);
    const resolvedProject = path.resolve(projectDir);
    if (!fullPath.startsWith(resolvedProject)) {
      return { error: 'Access denied: path outside project directory' };
    }
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
    return { error: err.message };
  }
}

function executeListFiles(projectDir, dirPath, recursive = false) {
  try {
    const fullPath = path.resolve(projectDir, dirPath || '.');
    const resolvedProject = path.resolve(projectDir);
    if (!fullPath.startsWith(resolvedProject)) {
      return { error: 'Access denied: path outside project directory' };
    }
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
    return { error: err.message };
  }
}

function executeSearchCode(projectDir, pattern, searchPath = '.', filePattern = '*') {
  try {
    const fullPath = path.resolve(projectDir, searchPath);
    const resolvedProject = path.resolve(projectDir);
    if (!fullPath.startsWith(resolvedProject)) {
      return { error: 'Access denied: path outside project directory' };
    }

    const results = [];
    const regex = new RegExp(pattern, 'gi');

    function searchDir(dir) {
      if (results.length >= 50) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE_PATTERNS.includes(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          searchDir(entryPath);
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
        }
        if (results.length >= 50) break;
      }
    }
    searchDir(fullPath);
    return { results };
  } catch (err) {
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

function executeRunCommand(projectDir, command) {
  const { execSync } = require('child_process');
  try {
    // Basic safety check - block destructive commands
    const dangerous = /\b(rm\s+-rf|del\s+\/[sqf]|format\s+[a-z]:)\b/i;
    if (dangerous.test(command)) {
      return { error: 'Blocked: command appears destructive. Use a safer alternative.' };
    }
    const output = execSync(command, {
      cwd: projectDir,
      timeout: 30000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, output: output.substring(0, 5000) };
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    return { error: err.message, output: output.substring(0, 2000), exitCode: err.status };
  }
}

async function executeMcpTool(toolName, args) {
  const client = getMcpClient();
  try {
    let result;
    switch (toolName) {
      case 'get_tasks':
        result = await client.callTool('list_tasks', {
          status: args.status,
          project: args.project,
          limit: args.limit || 20
        });
        break;
      case 'create_task':
        result = await client.callTool('create_task', args);
        break;
      case 'get_calendar':
        result = await client.callTool('list_events', {
          maxResults: args.maxResults || 10,
          timeMin: args.timeMin,
          timeMax: args.timeMax
        });
        break;
      case 'get_email_summary':
        result = await client.callTool('gmail_summary', {});
        break;
      case 'search_memory':
        result = await client.callTool('search_memory', { query: args.query });
        break;
      case 'call_mcp':
        result = await client.callTool(args.tool, args.args || {});
        break;
      default:
        return { error: `Unknown MCP tool: ${toolName}` };
    }
    return { result };
  } catch (err) {
    return { error: `MCP error: ${err.message}` };
  }
}

function executeTool(projectDir, toolName, args) {
  // MCP tools are async - handled separately in the loop
  switch (toolName) {
    case 'read_file':
      return executeReadFile(projectDir, args.path);
    case 'list_files':
      return executeListFiles(projectDir, args.path, args.recursive);
    case 'search_code':
      return executeSearchCode(projectDir, args.pattern, args.path, args.file_pattern);
    case 'create_file':
      return executeCreateFile(projectDir, args.path, args.content);
    case 'edit_file':
      return executeEditFile(projectDir, args.path, args.content);
    case 'run_command':
      return executeRunCommand(projectDir, args.command);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const MCP_TOOLS = new Set(['get_tasks', 'create_task', 'get_calendar', 'get_email_summary', 'search_memory', 'call_mcp']);

// ─── SSE Stream Parser ───────────────────────────────────────────────────────

/**
 * Consume an SSE stream response and call onToken for each text chunk.
 * Strips <think>...</think> blocks before firing tokens.
 * Returns the full assembled content string (think blocks removed).
 */
async function consumeStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let thinkBuffer = '';   // accumulates text inside a think block
  let inThink = false;

  const flush = (text) => {
    fullContent += text;
    onToken(text);
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

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Use non-streaming for tool-call iterations (need full response to parse tool_calls)
      const data = await this.lmStudio.chat(messages, {
        model: options.model,
        temperature: options.temperature ?? 0.6,
        maxTokens: options.maxTokens ?? 10000,
        tools: TOOLS,
        toolChoice: 'auto',
        thinking: options.thinking ?? false
      });

      const choice = data.choices[0];
      const assistantMessage = choice.message;

      // DEBUG: log raw response to understand model behavior
      if (process.env.RIPLEY_DEBUG) {
        const fs2 = require('fs');
        const debugPath = process.env.RIPLEY_DEBUG_PATH || require('os').tmpdir() + '/ripley-debug.log';
        fs2.appendFileSync(debugPath,
          `\n=== iteration ${iterations} ===\n` +
          `finish_reason: ${choice.finish_reason}\n` +
          `tool_calls: ${JSON.stringify(assistantMessage.tool_calls?.map(t => ({ name: t.function.name, args: t.function.arguments })), null, 2)}\n` +
          `content: ${(assistantMessage.content || '').slice(0, 500)}\n`
        );
      }

      // Check if model wants to call tools
      if (choice.finish_reason === 'tool_calls' && assistantMessage.tool_calls) {
        // Add assistant message to history
        messages.push(assistantMessage);

        let wroteFile = false;

        for (const toolCall of assistantMessage.tool_calls) {
          const functionName = toolCall.function.name;
          let args;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          this.onToolCall(functionName, args);

          // Execute tool - MCP tools are async
          const result = MCP_TOOLS.has(functionName)
            ? await executeMcpTool(functionName, args)
            : executeTool(projectDir, functionName, args);

          this.onToolResult(functionName, !result.error, result);

          // DEBUG: log tool result
          if (process.env.RIPLEY_DEBUG) {
            const fs2 = require('fs');
            const debugPath = process.env.RIPLEY_DEBUG_PATH || require('os').tmpdir() + '/ripley-debug.log';
            fs2.appendFileSync(debugPath,
              `  tool: ${functionName} -> ${JSON.stringify(result).slice(0, 200)}\n`
            );
          }

          // Track if a write happened this iteration
          if ((functionName === 'create_file' || functionName === 'edit_file') && result.success) {
            wroteFile = true;
            writtenFiles.push(result.path);
          }

          // Add result to messages
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        if (process.env.RIPLEY_DEBUG) {
          const fs2 = require('fs');
          const debugPath = process.env.RIPLEY_DEBUG_PATH || require('os').tmpdir() + '/ripley-debug.log';
          fs2.appendFileSync(debugPath, `  wroteFile: ${wroteFile}, files: ${writtenFiles}\n`);
        }

        // Files were written - don't loop again. Emit a synthetic summary and exit.
        if (wroteFile) {
          const summary = `Created ${writtenFiles.join(', ')}.`;
          // Fire token/content so the UI shows something
          this.onToken(summary);
          this.onContent(summary);
          return summary;
        }

      } else {
        // Final response - no more tool calls.
        // If thinking is enabled, use non-streaming to capture reasoning field, then emit.
        if (options.thinking) {
          const thinkData = await this.lmStudio.chat(messages, {
            model: options.model,
            temperature: options.temperature ?? 0.6,
            maxTokens: options.maxTokens ?? 10000,
            thinking: true
          });
          const thinkMsg = thinkData.choices[0]?.message;
          const reasoning = thinkMsg?.reasoning;
          const content = thinkMsg?.content || '';

          if (reasoning) this.onReasoning(reasoning);
          this.onToken(content);
          this.onContent(content);
          return content;
        }

        // Normal streaming final response
        const streamResponse = await this.lmStudio.chatStream(messages, {
          model: options.model,
          temperature: options.temperature ?? 0.6,
          maxTokens: options.maxTokens ?? 10000,
          thinking: false
        });

        const content = await consumeStream(streamResponse, (token) => {
          this.onToken(token);
        });

        this.onContent(content);
        return content;
      }
    }

    this.onWarning('Max tool iterations reached');
    return '';
  }
}

module.exports = { AgenticRunner, TOOLS, executeTool };
