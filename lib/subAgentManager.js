/**
 * Sub-Agent Manager for Ripley Code v4
 * Orchestrates sub-agent lifecycle: spawn, track, cancel.
 * Any model on any provider can spawn sub-agents on any other provider/model.
 */

const { AgenticRunner, TOOLS, READ_ONLY_TOOLS } = require('./agenticRunner');
const crypto = require('crypto');

const MAX_DEPTH = 2;
const DEFAULT_MAX_ITERATIONS_SUBAGENT = 25;
const DEFAULT_TIMEOUT_CLOUD_MS = 120_000;
const DEFAULT_TIMEOUT_LOCAL_MS = 300_000;
const DEFAULT_MAX_TOKENS_SUBAGENT = 16384;
const MAX_CONCURRENT_CLOUD = 5;

const SUB_AGENT_DIRECTIVE = [
  'You are a sub-agent spawned to perform a specific task. Focus exclusively on the task.',
  'You have full tool access. Complete the task and report findings concisely.',
  'Do not ask follow-up questions. Do not suggest next steps. Just do the work and report.'
].join('\n');

class SubAgentManager {
  constructor(options = {}) {
    this.providerManager = options.providerManager;
    this.modelRegistry = options.modelRegistry;
    this.promptManager = options.promptManager;
    this.config = options.config;
    this.projectDir = options.projectDir || process.cwd();

    // Callbacks
    this.onAgentStart = options.onAgentStart || (() => {});
    this.onAgentToolCall = options.onAgentToolCall || (() => {});
    this.onAgentToolResult = options.onAgentToolResult || (() => {});
    this.onAgentComplete = options.onAgentComplete || (() => {});
    this.onAgentError = options.onAgentError || (() => {});

    // Active agents map: id -> SubAgent record
    this.agents = new Map();
  }

  /**
   * Spawn a sub-agent on a given model/provider.
   *
   * @param {string} modelKey - "provider:alias" format, e.g. "anthropic:claude-sonnet-4.6", "local:current"
   * @param {string} task - Task description
   * @param {Object} options
   * @param {string} options.context - Optional context string
   * @param {string[]} options.files - File paths to pre-read and inject
   * @param {boolean} options.readOnly - Restrict to read-only tools
   * @param {number} options.maxIterations - Default 25
   * @param {number} options.timeout - Timeout in ms
   * @param {number} options.depth - Recursion depth (0 = main, 1 = first sub-agent)
   * @param {AbortSignal} options.signal - Parent abort signal
   * @returns {Object} - { id, result, error, tokens, toolCalls, elapsed }
   */
  async spawn(modelKey, task, options = {}) {
    const depth = options.depth || 1;

    // Resolve model - fall back to current model if requested model not found
    let resolved = this.modelRegistry.resolveModelKey(modelKey);
    if (!resolved) {
      resolved = this.modelRegistry.getCurrentModel();
      if (!resolved) {
        return {
          error: `Could not resolve model "${modelKey}" and no current model available. Use /agent models to see available models.`,
          tokens: 0,
          toolCalls: 0
        };
      }
    }

    const id = crypto.randomBytes(4).toString('hex');
    const isLocal = (resolved.provider || 'local') === 'local';
    const timeout = options.timeout || (isLocal ? DEFAULT_TIMEOUT_LOCAL_MS : DEFAULT_TIMEOUT_CLOUD_MS);
    const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS_SUBAGENT;

    const agent = {
      id,
      model: resolved.key,
      provider: resolved.provider || 'local',
      providerModelId: resolved.providerModelId || resolved.id,
      task,
      status: 'running',
      result: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      toolCalls: [],
      tokens: { prompt: 0, completion: 0, total: 0 },
      depth,
      parentId: options.parentId || null
    };

    this.agents.set(id, agent);
    this.onAgentStart(agent);

    try {
      // Get provider client for this model
      const client = await this.providerManager.getClientForModel(resolved);

      // Build system prompt
      const basePrompt = this._buildSystemPrompt(resolved);
      const systemContent = this._assembleSystemPrompt(basePrompt, task, options, resolved);

      // Build messages
      const messages = [
        { role: 'system', content: systemContent }
      ];

      // Pre-read files if requested
      if (options.files && options.files.length > 0) {
        const fileContents = this._readFiles(options.files);
        if (fileContents) {
          messages.push({ role: 'user', content: `Here are the relevant files:\n\n${fileContents}` });
        }
      }

      // Main task message
      messages.push({ role: 'user', content: task });

      // Create runner
      const runner = new AgenticRunner(client, {
        onToolCall: (tool, args) => {
          agent.toolCalls.push({ tool, args, timestamp: Date.now() });
          this.onAgentToolCall(agent, tool, args);
        },
        onToolResult: (tool, success, result) => {
          this.onAgentToolResult(agent, tool, success, result);
        },
        onToken: () => {},       // sub-agents don't stream to terminal
        onContent: () => {},
        onReasoning: () => {},
        onWarning: () => {},
        onIntermediateContent: () => {}
      });

      // Set up abort with timeout
      const abortController = new AbortController();
      agent.abortController = abortController;
      const timeoutId = setTimeout(() => abortController.abort(), timeout);

      // Forward parent signal
      if (options.signal) {
        if (options.signal.aborted) {
          abortController.abort();
        } else {
          options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
        }
      }

      // Build tool list and custom executors
      const baseTools = options.readOnly ? READ_ONLY_TOOLS : TOOLS;
      let customTools = [];
      let customToolExecutors = new Map();
      if (depth < MAX_DEPTH) {
        customTools = [SPAWN_AGENT_TOOL_DEF];
        customToolExecutors.set('spawn_agent', async (args, opts) => {
          return await this.spawn(args.model, args.task, {
            context: args.context,
            readOnly: args.read_only,
            depth: depth + 1,
            parentId: id,
            signal: opts.signal
          });
        });
      }

      try {
        const result = await runner.run(messages, this.projectDir, {
          model: resolved.providerModelId || resolved.id,
          temperature: resolved.inferenceSettings?.temperature ?? 0.5,
          topP: resolved.inferenceSettings?.topP,
          reasoningEffort: resolved.reasoningEffort,
          maxTokens: DEFAULT_MAX_TOKENS_SUBAGENT,
          tools: [...baseTools, ...customTools],
          readOnly: options.readOnly || false,
          signal: abortController.signal,
          customToolExecutors,
          customTools
        });

        clearTimeout(timeoutId);

        agent.status = 'completed';
        agent.result = result;
        agent.completedAt = Date.now();
        agent.tokens = {
          prompt: runner.totalPromptTokens,
          completion: runner.totalCompletionTokens,
          total: runner.totalTokens
        };

        this.onAgentComplete(agent);

        return {
          id,
          result: result || '(No response from sub-agent)',
          tokens: agent.tokens.total,
          toolCalls: agent.toolCalls.length,
          elapsed: agent.completedAt - agent.startedAt,
          model: resolved.key,
          provider: resolved.provider
        };

      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }

    } catch (err) {
      agent.status = 'failed';
      agent.error = err.message || String(err);
      agent.completedAt = Date.now();
      this.onAgentError(agent, err);

      return {
        id,
        error: `Sub-agent failed: ${agent.error}`,
        tokens: agent.tokens?.total || 0,
        toolCalls: agent.toolCalls?.length || 0,
        elapsed: (agent.completedAt || Date.now()) - agent.startedAt,
        model: modelKey,
        provider: agent.provider
      };
    }
  }

  /**
   * Spawn multiple agents. Cloud agents run concurrently (up to MAX_CONCURRENT_CLOUD),
   * local agents run sequentially.
   */
  async spawnParallel(specs, options = {}) {
    const cloudSpecs = [];
    const localSpecs = [];

    for (const spec of specs) {
      const resolved = this.modelRegistry.resolveModelKey(spec.model);
      if (resolved && (resolved.provider || 'local') === 'local') {
        localSpecs.push(spec);
      } else {
        cloudSpecs.push(spec);
      }
    }

    const results = [];

    // Cloud agents: run concurrently in batches
    if (cloudSpecs.length > 0) {
      for (let i = 0; i < cloudSpecs.length; i += MAX_CONCURRENT_CLOUD) {
        const batch = cloudSpecs.slice(i, i + MAX_CONCURRENT_CLOUD);
        const batchResults = await Promise.all(
          batch.map(spec => this.spawn(spec.model, spec.task, {
            ...options,
            context: spec.context,
            readOnly: spec.read_only,
            files: spec.files
          }))
        );
        results.push(...batchResults);
      }
    }

    // Local agents: sequential
    for (const spec of localSpecs) {
      const result = await this.spawn(spec.model, spec.task, {
        ...options,
        context: spec.context,
        readOnly: spec.read_only,
        files: spec.files
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Get a specific agent record.
   */
  getAgent(id) {
    return this.agents.get(id) || null;
  }

  /**
   * List all agents in this session.
   */
  listAgents() {
    return Array.from(this.agents.values());
  }

  /**
   * Cancel a running agent (best-effort via AbortController).
   */
  cancel(id) {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return false;
    agent.status = 'cancelled';
    agent.completedAt = Date.now();
    // Signal the abort controller to actually stop the runner
    if (agent.abortController) {
      agent.abortController.abort();
    }
    return true;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  _buildSystemPrompt(modelMeta) {
    // Use code-agent prompt as base, fall back to whatever is available
    const promptName = modelMeta.prompt || 'code-agent';
    if (this.promptManager && this.promptManager.has(promptName)) {
      return this.promptManager.get(promptName);
    }
    if (this.promptManager && this.promptManager.has('code-agent')) {
      return this.promptManager.get('code-agent');
    }
    return '';
  }

  _assembleSystemPrompt(basePrompt, task, options, modelMeta) {
    let prompt = basePrompt;
    prompt += `\n\n${SUB_AGENT_DIRECTIVE}`;

    // Add project instructions
    if (this.config) {
      const instructions = this.config.getInstructions();
      if (instructions) {
        prompt += `\n\n## Project Instructions (from ${instructions.source})\n\n${instructions.content}`;
      }
    }

    // Add context
    if (options.context) {
      prompt += `\n\n## Context from Parent Agent\n\n${options.context}`;
    }

    // Context budget: trim if exceeding ~50% of model's context limit
    const contextLimit = modelMeta.contextLimit || 32768;
    const maxPromptChars = Math.floor(contextLimit * 2); // rough char-to-token ratio
    if (prompt.length > maxPromptChars) {
      prompt = prompt.slice(0, maxPromptChars) + '\n\n[...context trimmed to fit model context window]';
    }

    return prompt;
  }

  _readFiles(filePaths) {
    const fs = require('fs');
    const path = require('path');
    const parts = [];

    for (const filePath of filePaths) {
      try {
        const fullPath = path.resolve(this.projectDir, filePath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          // Limit each file to 10k chars
          const trimmed = content.length > 10000
            ? content.slice(0, 10000) + '\n[...truncated]'
            : content;
          parts.push(`### ${filePath}\n\`\`\`\n${trimmed}\n\`\`\``);
        }
      } catch {
        // Skip unreadable files
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}

/**
 * Tool definition for spawn_agent, exported for use by ripley.js
 */
const SPAWN_AGENT_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'spawn_agent',
    description: 'Spawn a sub-agent on a different model. Use for code review, parallel research, complex reasoning, or delegating to specialized models. Use "local:current" to spawn on the same model you are running on.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model in "provider:alias" format. Use "local:current" for the same model (recommended default). Cloud examples: "anthropic:claude-sonnet-4-6", "openai:gpt-4o"'
        },
        task: {
          type: 'string',
          description: 'Clear task description for the sub-agent'
        },
        context: {
          type: 'string',
          description: 'Optional context (relevant code, findings, constraints)'
        },
        read_only: {
          type: 'boolean',
          description: 'Restrict to read-only tools. Default: false'
        }
      },
      required: ['model', 'task']
    }
  }
};

module.exports = { SubAgentManager, SPAWN_AGENT_TOOL_DEF, MAX_DEPTH };
