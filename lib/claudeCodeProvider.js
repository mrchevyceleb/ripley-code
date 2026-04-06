/**
 * Claude Code CLI Provider for Banana Code
 *
 * Uses the Claude Code CLI binary as a model provider via `claude -p` (print mode).
 * This spawns the real `claude` binary with the user's own subscription auth.
 * No OAuth tokens are extracted or proxied. TOS-compliant.
 *
 * The prompt is piped via stdin (not CLI args) to avoid OS command-line length limits.
 * --system-prompt is used for Banana's system prompt so it doesn't collide with CLAUDE.md.
 * --tools "" disables all built-in tools so Claude acts as a pure model provider.
 *
 * Interface matches OpenAICompatibleClient: chat(), chatStream(), isConnected(), listModels()
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Where the claude binary is typically installed
const CLAUDE_PATHS_WIN = [
  path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  path.join(os.homedir(), '.local', 'bin', 'claude')
];
const CLAUDE_PATHS_UNIX = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude'
];

const CLAUDE_MODELS = {
  'opus': { id: 'opus', name: 'Claude Opus', contextLimit: 200000 },
  'sonnet': { id: 'sonnet', name: 'Claude Sonnet', contextLimit: 200000 },
  'haiku': { id: 'haiku', name: 'Claude Haiku', contextLimit: 200000 }
};

const DEFAULT_MODEL = 'sonnet';

// Env vars safe to pass to the claude subprocess (no API keys or secrets)
const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'SHELL', 'TERM',
  'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'USER', 'USERNAME', 'LOGNAME', 'HOSTNAME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'WINDIR', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'PATHEXT'
]);

function buildSafeEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key) || SAFE_ENV_KEYS.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Find the claude binary path.
 * Checks known install locations first, then falls back to PATH.
 */
function findClaudeBinary() {
  const candidates = process.platform === 'win32' ? CLAUDE_PATHS_WIN : CLAUDE_PATHS_UNIX;

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // continue
    }
  }

  // Fall back to just 'claude' on PATH
  return 'claude';
}

/**
 * Convert OpenAI-style messages array into { systemPrompt, userPrompt }.
 * System messages become the --system-prompt flag.
 * Everything else is flattened into a conversation string piped via stdin.
 */
function splitMessages(messages) {
  const systemParts = [];
  const conversationParts = [];

  for (const msg of messages) {
    if (!msg || !msg.role) continue;

    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content
            .filter(c => c && (typeof c === 'string' || c.type === 'text'))
            .map(c => typeof c === 'string' ? c : c.text)
            .join('\n')
          : '');
      if (text) conversationParts.push(`[User]\n${text}`);
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content
            .filter(c => c && (typeof c === 'string' || c.type === 'text'))
            .map(c => typeof c === 'string' ? c : c.text)
            .join('\n')
          : '');
      if (text) conversationParts.push(`[Assistant]\n${text}`);
      continue;
    }

    if (msg.role === 'tool') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || {});
      conversationParts.push(`[Tool Result]\n${text}`);
    }
  }

  return {
    systemPrompt: systemParts.join('\n\n').trim(),
    userPrompt: conversationParts.join('\n\n').trim()
  };
}

/**
 * Map a Banana Code model alias to a claude CLI --model flag value.
 */
function resolveClaudeModel(modelOption) {
  if (!modelOption || typeof modelOption !== 'string') return DEFAULT_MODEL;
  const lower = modelOption.toLowerCase().replace(/^claude-code[:/]/, '');
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return DEFAULT_MODEL;
}

class ClaudeCodeClient {
  constructor(options = {}) {
    this.claudeBinary = options.claudeBinary || findClaudeBinary();
    this.label = 'Claude Code';
    this.defaultModel = options.model || DEFAULT_MODEL;
  }

  /**
   * Build the base args for claude -p. Prompt comes from stdin.
   */
  _buildArgs(model, systemPrompt, format) {
    const args = ['-p', '--output-format', format, '--model', model];
    args.push('--tools', '');
    args.push('--no-session-persistence');
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    if (format === 'stream-json') {
      args.push('--verbose', '--include-partial-messages');
    }
    return args;
  }

  /**
   * Non-streaming chat: spawns `claude -p` with --output-format json.
   * Prompt is piped via stdin to avoid OS command-line length limits.
   * Returns OpenAI-compatible response format.
   */
  async chat(messages, options = {}) {
    const { systemPrompt, userPrompt } = splitMessages(messages);
    const model = resolveClaudeModel(options.model);
    const args = this._buildArgs(model, systemPrompt, 'json');
    const timeout = options.timeout || 300000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const child = spawn(this.claudeBinary, args, {
        env: buildSafeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      // Timeout watchdog
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        settle(reject, new Error('Claude Code request timed out'));
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        settle(reject, new Error(`Claude Code process error: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (code !== 0 && !stdout.trim()) {
          settle(reject, new Error(`Claude Code exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());

          if (result.is_error) {
            settle(reject, new Error(`Claude Code error: ${result.result || 'Unknown error'}`));
            return;
          }

          const text = result.result || '';
          const usage = result.usage || {};
          const modelUsage = result.modelUsage || {};
          const modelKey = Object.keys(modelUsage)[0];
          const modelStats = modelKey ? modelUsage[modelKey] : {};

          settle(resolve, {
            id: result.session_id || null,
            object: 'chat.completion',
            choices: [{
              index: 0,
              finish_reason: result.stop_reason === 'end_turn' ? 'stop' : (result.stop_reason || 'stop'),
              message: {
                role: 'assistant',
                content: text
              }
            }],
            usage: {
              prompt_tokens: modelStats.inputTokens || usage.input_tokens || 0,
              completion_tokens: modelStats.outputTokens || usage.output_tokens || 0,
              total_tokens: (modelStats.inputTokens || usage.input_tokens || 0) + (modelStats.outputTokens || usage.output_tokens || 0),
              cache_read_input_tokens: modelStats.cacheReadInputTokens || usage.cache_read_input_tokens || 0,
              cache_creation_input_tokens: modelStats.cacheCreationInputTokens || usage.cache_creation_input_tokens || 0
            },
            _claude_code: {
              cost_usd: result.total_cost_usd || modelStats.costUSD || 0,
              duration_ms: result.duration_ms || 0,
              model: modelKey || model,
              session_id: result.session_id
            }
          });
        } catch {
          settle(reject, new Error(`Claude Code returned invalid JSON: ${stdout.slice(0, 200)}`));
        }
      });

      // Handle abort signal
      if (options.signal) {
        if (options.signal.aborted) {
          child.kill('SIGTERM');
          settle(reject, new Error('Claude Code request was cancelled'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
          settle(reject, new Error('Claude Code request was cancelled'));
        }, { once: true });
      }

      // Pipe prompt via stdin and close it
      try {
        child.stdin.write(userPrompt || '\n');
        child.stdin.end();
      } catch (e) {
        settle(reject, new Error(`Claude Code stdin error: ${e.message}`));
      }
    });
  }

  /**
   * Streaming chat: spawns `claude -p` with --output-format stream-json --verbose.
   * Returns a Response object with an SSE body stream (matching OpenAI format)
   * that Banana Code's StreamHandler can consume.
   *
   * Parses Claude's stream-json events:
   *   - stream_event with content_block_delta -> incremental text
   *   - assistant (full message) -> fallback if no deltas received
   *   - result -> final metadata, sends [DONE]
   */
  async chatStream(messages, options = {}) {
    const { systemPrompt, userPrompt } = splitMessages(messages);
    const model = resolveClaudeModel(options.model);
    const args = this._buildArgs(model, systemPrompt, 'stream-json');
    const IDLE_TIMEOUT = 60000;

    const child = spawn(this.claudeBinary, args, {
      env: buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    // Handle abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill('SIGTERM');
        throw new Error('Claude Code request was cancelled');
      }
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      }, { once: true });
    }

    // Pipe prompt via stdin and close it
    try {
      child.stdin.write(userPrompt || '\n');
      child.stdin.end();
    } catch {
      child.kill('SIGTERM');
      throw new Error('Claude Code: failed to write prompt to stdin');
    }

    const encoder = new TextEncoder();
    let stderrData = '';
    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (stderrData.length > 2000) stderrData = stderrData.slice(-2000);
    });

    const readable = new ReadableStream({
      start(controller) {
        let buffer = '';
        let closed = false;
        let sentAnyContent = false;
        let idleTimer = null;

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (!closed) {
              child.kill('SIGTERM');
              closeStream();
            }
          }, IDLE_TIMEOUT);
        };

        const closeStream = () => {
          if (closed) return;
          closed = true;
          if (idleTimer) clearTimeout(idleTimer);
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch {
            // Already closed
          }
        };

        const emitText = (text) => {
          if (!text || closed) return;
          sentAnyContent = true;
          resetIdleTimer();
          const sseData = JSON.stringify({
            choices: [{ delta: { content: text } }]
          });
          try {
            controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
          } catch {
            // Stream closed
          }
        };

        resetIdleTimer();

        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let parsed;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              continue;
            }

            // Incremental text deltas (the real streaming path)
            if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta') {
              const delta = parsed.event.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                emitText(delta.text);
              }
              continue;
            }

            // Full assistant message (fallback if no deltas were received)
            if (parsed.type === 'assistant' && parsed.message?.content && !sentAnyContent) {
              for (const block of parsed.message.content) {
                if (block.type === 'text' && block.text) {
                  emitText(block.text);
                }
              }
              continue;
            }

            // Final result - stream is done
            if (parsed.type === 'result') {
              // If nothing was streamed yet, send the result text as fallback
              if (!sentAnyContent && parsed.result && typeof parsed.result === 'string') {
                emitText(parsed.result);
              }
              closeStream();
              return;
            }
          }
        });

        child.stdout.on('end', () => {
          // Process remaining buffer
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              if (parsed.type === 'result') {
                if (!sentAnyContent && parsed.result && typeof parsed.result === 'string') {
                  emitText(parsed.result);
                }
              }
            } catch {
              // ignore
            }
          }
          closeStream();
        });

        child.on('error', (err) => {
          if (idleTimer) clearTimeout(idleTimer);
          if (!closed) {
            closed = true;
            try {
              controller.error(new Error(`Claude Code process error: ${err.message}`));
            } catch {
              // Already closed
            }
          }
        });

        child.on('exit', (code) => {
          if (code !== 0 && !closed) {
            if (idleTimer) clearTimeout(idleTimer);
            closed = true;
            try {
              controller.error(new Error(`Claude Code exited with code ${code}${stderrData ? ': ' + stderrData.slice(0, 500) : ''}`));
            } catch {
              // Already closed
            }
          }
        });
      },

      cancel() {
        child.kill('SIGTERM');
      }
    });

    return new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }

  /**
   * Check if Claude Code CLI is installed.
   * Verifies the binary exists and responds to --version.
   */
  async isConnected(options = {}) {
    const throwOnError = options.throwOnError === true;
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        windowsHide: true
      });

      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

      child.on('error', (err) => {
        if (throwOnError) {
          reject(new Error(`Claude Code CLI not found or not working: ${err.message}`));
        } else {
          resolve(false);
        }
      });

      child.on('close', (code) => {
        const version = stdout.trim();
        // Accept any successful exit with version-like output
        if (code === 0 && version) {
          resolve(true);
        } else if (throwOnError) {
          reject(new Error(`Claude Code CLI check failed (exit ${code}): ${version || 'no output'}`));
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * List available Claude models.
   * Claude Code CLI doesn't have a models endpoint, so we return hardcoded options.
   */
  async listModels() {
    return Object.entries(CLAUDE_MODELS).map(([key, model]) => ({
      id: model.id,
      object: 'model',
      owned_by: 'anthropic',
      ...model
    }));
  }
}

module.exports = {
  ClaudeCodeClient,
  findClaudeBinary,
  CLAUDE_MODELS,
  DEFAULT_MODEL
};
