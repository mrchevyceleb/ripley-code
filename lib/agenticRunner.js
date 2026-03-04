/**
 * Agentic Runner for Ripley Code v4
 * Tool-calling loop - extracted from the AI Router's agentic endpoint.
 * Runs locally, no middleware needed.
 */

const fs = require('fs');
const path = require('path');
const McpClient = require('./mcpClient');

// Shared MCP client - set from outside via setMcpClient()
let mcpClient = null;
function getMcpClient() {
  if (!mcpClient) mcpClient = new McpClient();
  return mcpClient;
}
function setMcpClient(client) {
  mcpClient = client;
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
      description: 'GENERIC TOOL WRAPPER - call ANY external service by name. Pass the tool name and args. Available tools include: gmail (check email), gmail_send, gmail_reply, slack_send_message, slack_read_channel, slack_read_dms, create_event, list_events, get_freebusy, sync_tasks, list_tasks, update_task, complete_task, create_task, web_search, quick_search, deep_research, save_memory, search_memory, recent_memories, session_start_context, extract_memories, monday, stripe, telegram, process_inbox, urgent_tasks, and many more. USE THIS for any external data or service.',
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
const MAX_ITERATIONS = 25;

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
        maxTokens: options.maxTokens ?? 32000,
        tools: TOOLS,
        toolChoice: 'auto',
        thinking: options.thinking ?? false,
        signal: options.signal
      });

      const choice = data.choices[0];
      const assistantMessage = choice.message;

      // Track token usage from API response
      if (data.usage?.total_tokens) {
        this.totalTokens = data.usage.total_tokens;
      }

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

        if (process.env.RIPLEY_DEBUG) {
          const fs2 = require('fs');
          const debugPath = process.env.RIPLEY_DEBUG_PATH || require('os').tmpdir() + '/ripley-debug.log';
          fs2.appendFileSync(debugPath, `  writtenFiles: ${writtenFiles}\n`);
        }

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
          return content;
        }

        // Normal streaming final response
        const streamResponse = await this.lmStudio.chatStream(messages, {
          model: options.model,
          temperature: options.temperature ?? 0.6,
          topP: options.topP,
          repeatPenalty: options.repeatPenalty,
          maxTokens: options.maxTokens ?? 32000,
          thinking: false,
          signal: options.signal
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

module.exports = { AgenticRunner, TOOLS, executeTool, setMcpClient };
