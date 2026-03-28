/**
 * Hook Manager for Banana Code
 * Executes user-defined hooks at key lifecycle points.
 * Supports single-agent hooks, multi-agent A/B hooks, and shell hooks.
 *
 * Hooks are loaded from two locations:
 *   - Global:  ~/.banana/hooks.json   (default, applies to all projects)
 *   - Project: <projectDir>/.banana/hooks.json  (overrides global by name)
 *
 * Agent hook format (new):
 *   { name, enabled, agentA: { model, task }, agentB?: { model, task },
 *     maxTurns, readOnly, trigger, inject, timeout }
 *
 * Legacy agent hook format (still supported):
 *   { name, enabled, agent, task, readOnly, trigger, inject, timeout }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DEFAULT_AGENT_TIMEOUT = 60000;
const DEFAULT_SHELL_TIMEOUT = 30000;
const DEFAULT_MAX_TURNS = 3;
const VALID_HOOK_POINTS = ['beforeTurn', 'afterTurn', 'afterWrite', 'afterCommand', 'onError'];
const VALID_TRIGGERS = ['always', 'fileChanged', 'commandRan', 'hasErrors'];
const VALID_INJECT_MODES = ['prepend', 'system', 'append'];

const REFINE_SYSTEM_PROMPT = `You are an expert at writing clear, actionable instructions for AI coding agents.
Given a natural language description of what the user wants the agent to do, create a well-structured set of instructions.

Rules:
- State the agent's goal clearly in one sentence
- List specific steps or checks to perform
- Specify the expected output format
- Include constraints or boundaries
- Be concise but thorough

Output ONLY the refined instructions. No preamble, no explanation, no markdown fences.`;

const PROMPT_HOOK_SYSTEM = `You are an expert at configuring automated hooks for an AI coding assistant called Banana Code.
Given a user's natural language description of what they want a hook to do, generate a complete hook configuration.

Available hook points:
- beforeTurn: Runs before each AI request (good for: gathering context, pre-checks)
- afterTurn: Runs after each AI response (good for: reviews, validation, summaries)
- afterWrite: Runs after a file is written (good for: linting, formatting, tests)
- afterCommand: Runs after a shell command (good for: monitoring, logging)
- onError: Runs when an error occurs (good for: debugging, recovery)

Available triggers:
- always: Fire every time the hook point is reached
- fileChanged: Only when files were changed
- commandRan: Only when a command was run
- hasErrors: Only when an error occurred

Respond with ONLY valid JSON (no markdown fences, no explanation) in this exact format:
{
  "name": "short-kebab-case-name",
  "hookPoint": "afterTurn",
  "trigger": "always",
  "inject": "prepend",
  "readOnly": true,
  "task": "Detailed instructions for what the agent should do..."
}

Pick the most appropriate hookPoint and trigger based on the user's description.
Set readOnly to true unless the user explicitly wants the hook to modify files.
The "task" field should be detailed, structured agent instructions (not the user's raw input).
The inject mode should almost always be "prepend" unless the user specifies otherwise.`;

class HookManager {
  constructor(options = {}) {
    this.config = options.config;
    this.subAgentManager = options.subAgentManager;
    this.projectDir = options.projectDir || process.cwd();
    this.globalDir = path.join(os.homedir(), '.banana');

    // For AI instruction refinement: async (naturalLanguage, modelKey) => refinedText
    this.refineFn = options.refineFn || null;

    // Callbacks for UI
    this.onHookStart = options.onHookStart || (() => {});
    this.onHookComplete = options.onHookComplete || (() => {});
    this.onHookError = options.onHookError || (() => {});
    this.onHookProgress = options.onHookProgress || (() => {});

    this._merged = null; // lazy loaded merged view
  }

  // ---------------------------------------------------------------------------
  // Config I/O
  // ---------------------------------------------------------------------------

  _globalHooksPath() {
    return path.join(this.globalDir, 'hooks.json');
  }

  _projectHooksPath() {
    return path.join(this.projectDir, '.banana', 'hooks.json');
  }

  _readHooksFile(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // file missing or invalid
    }
    return {};
  }

  _writeHooksFile(filePath, hookConfig) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(hookConfig, null, 2));
  }

  /**
   * Load and merge hooks from global + project.
   * Project hooks with the same name override global hooks (cross-point dedup).
   * Each hook gets a _scope property ('global' or 'project') for display/routing.
   */
  loadHooks() {
    const globalHooks = this._readHooksFile(this._globalHooksPath());
    const projectHooks = this._readHooksFile(this._projectHooksPath());

    // Collect all project hook names across all points for cross-point dedup.
    const projectNames = new Set();
    for (const point of VALID_HOOK_POINTS) {
      const list = Array.isArray(projectHooks[point]) ? projectHooks[point] : [];
      for (const h of list) projectNames.add(h.name);
    }

    const merged = {};

    for (const point of VALID_HOOK_POINTS) {
      const globalList = Array.isArray(globalHooks[point]) ? globalHooks[point] : [];
      const projectList = Array.isArray(projectHooks[point]) ? projectHooks[point] : [];

      const byName = new Map();
      for (const h of globalList) {
        if (!projectNames.has(h.name)) {
          byName.set(h.name, { ...h, _scope: 'global' });
        }
      }
      for (const h of projectList) {
        byName.set(h.name, { ...h, _scope: 'project' });
      }

      if (byName.size > 0) {
        merged[point] = [...byName.values()];
      }
    }

    this._merged = merged;
    return merged;
  }

  _getHooks() {
    if (!this._merged) this.loadHooks();
    return this._merged;
  }

  _saveToScope(scope, hookPoint, hookDef) {
    const filePath = scope === 'project' ? this._projectHooksPath() : this._globalHooksPath();
    const existing = this._readHooksFile(filePath);
    if (!existing[hookPoint]) existing[hookPoint] = [];

    const clean = this._stripRuntime(hookDef);

    const idx = existing[hookPoint].findIndex(h => h.name === clean.name);
    if (idx >= 0) {
      existing[hookPoint][idx] = clean;
    } else {
      existing[hookPoint].push(clean);
    }

    this._writeHooksFile(filePath, existing);
  }

  _removeFromFile(filePath, name) {
    const existing = this._readHooksFile(filePath);
    let removed = false;
    for (const point of VALID_HOOK_POINTS) {
      if (!existing[point]) continue;
      const before = existing[point].length;
      existing[point] = existing[point].filter(h => h.name !== name);
      if (existing[point].length < before) removed = true;
      if (existing[point].length === 0) delete existing[point];
    }
    if (removed) this._writeHooksFile(filePath, existing);
    return removed;
  }

  _findHookScope(name) {
    const projectHooks = this._readHooksFile(this._projectHooksPath());
    for (const point of VALID_HOOK_POINTS) {
      if (projectHooks[point]?.some(h => h.name === name)) return 'project';
    }
    const globalHooks = this._readHooksFile(this._globalHooksPath());
    for (const point of VALID_HOOK_POINTS) {
      if (globalHooks[point]?.some(h => h.name === name)) return 'global';
    }
    return null;
  }

  _findHookPoint(name) {
    const hooks = this._getHooks();
    for (const point of VALID_HOOK_POINTS) {
      if (hooks[point]?.some(h => h.name === name)) return point;
    }
    return null;
  }

  /** Strip runtime-only properties before writing to disk. */
  _stripRuntime(hookDef) {
    const clean = { ...hookDef };
    delete clean._scope;
    delete clean.hookPoint;
    return clean;
  }

  // ---------------------------------------------------------------------------
  // Hook normalization (legacy <-> new format)
  // ---------------------------------------------------------------------------

  /**
   * Normalize to the new agentA/agentB format for execution.
   * Old: { agent, task }  ->  { agentA: { model, task }, maxTurns: 1 }
   */
  _normalize(hookDef) {
    if (hookDef.agentA) return hookDef; // already new format
    if (hookDef.agent && hookDef.task) {
      return {
        ...hookDef,
        agentA: { model: hookDef.agent, task: hookDef.task },
        maxTurns: 1
      };
    }
    return hookDef; // shell hook or invalid
  }

  // ---------------------------------------------------------------------------
  // Hook execution
  // ---------------------------------------------------------------------------

  async runHooks(hookPoint, context = {}, options = {}) {
    if ((options.depth || 0) > 0) return [];

    const hooks = this._getHooks();
    const pointHooks = hooks[hookPoint];
    if (!Array.isArray(pointHooks) || pointHooks.length === 0) return [];

    const results = [];

    for (const hookDef of pointHooks) {
      if (!hookDef.enabled) continue;
      if (!this.checkTrigger(hookDef, context)) continue;

      try {
        this.onHookStart(hookDef);
        let result;

        if (hookDef.agentA || hookDef.agent) {
          result = await this.executeAgentHook(hookDef, context);
        } else if (hookDef.command) {
          result = await this.executeShellHook(hookDef, context);
        } else {
          continue;
        }

        const formatted = this.formatHookResult(hookDef, result);
        this.onHookComplete(hookDef, formatted);
        results.push({
          name: hookDef.name,
          result: formatted,
          inject: hookDef.inject || 'prepend',
          error: null
        });
      } catch (err) {
        this.onHookError(hookDef, err);
        results.push({
          name: hookDef.name,
          result: null,
          inject: null,
          error: err.message || String(err)
        });
      }
    }

    return results;
  }

  async runSingleHook(name, context = {}) {
    const hooks = this._getHooks();
    for (const point of VALID_HOOK_POINTS) {
      if (!hooks[point]) continue;
      const hookDef = hooks[point].find(h => h.name === name);
      if (!hookDef) continue;

      try {
        this.onHookStart(hookDef);
        let result;
        if (hookDef.agentA || hookDef.agent) {
          result = await this.executeAgentHook(hookDef, context);
        } else if (hookDef.command) {
          result = await this.executeShellHook(hookDef, context);
        } else {
          return { name, result: null, error: 'Invalid hook (no agent or command)' };
        }
        const formatted = this.formatHookResult(hookDef, result);
        this.onHookComplete(hookDef, formatted);
        return { name, result: formatted, inject: hookDef.inject || 'prepend', error: null };
      } catch (err) {
        this.onHookError(hookDef, err);
        return { name, result: null, error: err.message || String(err) };
      }
    }
    return null;
  }

  /**
   * Execute an agent hook. Handles both single-agent and multi-agent A/B hooks.
   */
  async executeAgentHook(hookDef, context) {
    if (!this.subAgentManager) {
      throw new Error('Sub-agent manager not available');
    }

    const normalized = this._normalize(hookDef);

    if (!normalized.agentB) {
      return this._executeSingleAgent(normalized.agentA, normalized, context);
    }

    return this._executeMultiAgent(normalized, context);
  }

  async _executeSingleAgent(agentConfig, hookDef, context) {
    const timeout = hookDef.timeout || DEFAULT_AGENT_TIMEOUT;
    let composedTask = agentConfig.task || 'Review the recent changes.';
    composedTask += this._buildContextSuffix(context);

    const result = await this.subAgentManager.spawn(agentConfig.model, composedTask, {
      readOnly: hookDef.readOnly !== false,
      timeout,
      depth: 1
    });

    if (result.error) throw new Error(result.error);
    return result.result || '(no output)';
  }

  async _executeMultiAgent(hookDef, context) {
    // Clamp to at least 2 when Agent B exists so both agents run
    const rawTurns = hookDef.maxTurns || DEFAULT_MAX_TURNS;
    const maxTurns = hookDef.agentB ? Math.max(rawTurns, 2) : rawTurns;
    const timeout = hookDef.timeout || DEFAULT_AGENT_TIMEOUT;
    const contextSuffix = this._buildContextSuffix(context);

    let lastOutput = '';

    for (let turn = 0; turn < maxTurns; turn++) {
      const isAgentA = (turn % 2 === 0);
      const agentConfig = isAgentA ? hookDef.agentA : hookDef.agentB;
      if (!agentConfig) break;

      const agentLabel = isAgentA ? 'A' : 'B';
      this.onHookProgress(hookDef, agentLabel, turn + 1, maxTurns);

      let task = agentConfig.task;
      if (turn === 0) {
        task += contextSuffix;
      } else {
        task += `\n\n--- Output from Agent ${isAgentA ? 'B' : 'A'} ---\n${lastOutput}`;
      }

      const result = await this.subAgentManager.spawn(agentConfig.model, task, {
        readOnly: hookDef.readOnly !== false,
        timeout,
        depth: 1
      });

      if (result.error) throw new Error(result.error);
      lastOutput = result.result || '(no output)';
    }

    return lastOutput;
  }

  _buildContextSuffix(context) {
    let suffix = '';
    if (context.files && context.files.length > 0) {
      suffix += `\n\nFiles changed: ${context.files.join(', ')}`;
    }
    if (context.response) {
      const preview = context.response.length > 2000
        ? context.response.slice(0, 2000) + '\n...(truncated)'
        : context.response;
      suffix += `\n\nRecent AI response:\n${preview}`;
    }
    if (context.error) {
      suffix += `\n\nError that occurred:\n${context.error.message || context.error}`;
    }
    return suffix;
  }

  async executeShellHook(hookDef, context) {
    const timeout = hookDef.timeout || DEFAULT_SHELL_TIMEOUT;
    let command = hookDef.command;

    if (context.file) {
      command = command.replace(/\{\{file\}\}/g, context.file);
    }
    if (context.files && context.files.length > 0) {
      command = command.replace(/\{\{files\}\}/g, context.files.join(' '));
      if (!context.file) {
        command = command.replace(/\{\{file\}\}/g, context.files[0]);
      }
    }
    command = command.replace(/\{\{projectDir\}\}/g, this.projectDir);

    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWin ? ['/c', command] : ['-c', command];

      let stdout = '';
      let stderr = '';

      const proc = spawn(shell, shellArgs, {
        cwd: this.projectDir,
        env: { ...process.env }
      });

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Shell hook "${hookDef.name}" timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(`Exit code ${code}\n${stderr || stdout}`.trim());
        } else {
          resolve(stdout.trim() || '(no output)');
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Trigger checking
  // ---------------------------------------------------------------------------

  checkTrigger(hookDef, context) {
    const trigger = hookDef.trigger || 'always';
    switch (trigger) {
      case 'always': return true;
      case 'fileChanged': return context.files && context.files.length > 0;
      case 'commandRan': return context.commandRan === true;
      case 'hasErrors': return !!context.error;
      default: return true;
    }
  }

  // ---------------------------------------------------------------------------
  // Result formatting
  // ---------------------------------------------------------------------------

  formatHookResult(hookDef, result) {
    return `## Hook: ${hookDef.name}\n\n${result}`;
  }

  // ---------------------------------------------------------------------------
  // AI instruction refinement
  // ---------------------------------------------------------------------------

  async _refineInstructions(naturalLanguage, modelKey) {
    if (!this.refineFn) return naturalLanguage;
    try {
      const refined = await this.refineFn(naturalLanguage, modelKey);
      return refined || naturalLanguage;
    } catch {
      return naturalLanguage;
    }
  }

  /**
   * Interactive prompt for agent instructions with AI refinement.
   * Shows a label, asks for natural language, refines via AI, lets user accept/retry/use raw.
   */
  async _askForInstructions(label, modelKey, askQuestion) {
    console.log(`\n  ${label}`);
    const rawInput = await askQuestion('  Describe what this agent should do: ');
    if (!rawInput || !rawInput.trim()) return null;
    const raw = rawInput.trim();

    if (!this.refineFn) return raw;

    console.log('  Refining instructions...');
    const refined = await this._refineInstructions(raw, modelKey);

    if (refined && refined !== raw) {
      console.log('');
      const lines = refined.split('\n');
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      console.log('');

      const accept = await askQuestion('  (Y)es accept / (R)etry / (U)se my original: ');
      const choice = (accept || 'y').trim().toLowerCase();

      if (choice.startsWith('r')) {
        return this._askForInstructions(label, modelKey, askQuestion);
      }
      if (choice.startsWith('u')) {
        return raw;
      }
      return refined;
    }

    return raw;
  }

  // ---------------------------------------------------------------------------
  // Model picker helper
  // ---------------------------------------------------------------------------

  _buildModelItems(modelRegistry) {
    if (!modelRegistry) return null;
    const models = modelRegistry.list();
    const items = [];
    for (const m of models) {
      const provider = m.provider || 'local';
      const key = provider === 'local' ? m.key : `${provider}:${m.key}`;
      items.push({
        key,
        label: key,
        description: m.name || '',
        active: m.active
      });
    }
    return items.length > 0 ? items : null;
  }

  async _pickModel(pickFn, askQuestion, modelRegistry, title) {
    const items = this._buildModelItems(modelRegistry);
    if (items) {
      const choice = await pickFn(items, { title });
      return choice ? choice.key : null;
    }
    const input = await askQuestion(`  Model key (e.g. openai:gpt-4o): `);
    return input?.trim() || null;
  }

  _injectItems() {
    return [
      { key: 'prepend', label: 'Before next turn', description: 'AI sees hook output before your next message (recommended)' },
      { key: 'system', label: 'Background context', description: 'Added as invisible system context the AI can reference' },
      { key: 'append', label: 'After next message', description: 'AI sees hook output after your next message' }
    ];
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  addHook(hookPoint, hookDef, scope = 'global') {
    hookDef.enabled = hookDef.enabled !== false;
    this._saveToScope(scope, hookPoint, hookDef);
    this._merged = null;
    return hookDef;
  }

  removeHook(name) {
    const scope = this._findHookScope(name);
    if (!scope) return false;
    const filePath = scope === 'project' ? this._projectHooksPath() : this._globalHooksPath();
    const removed = this._removeFromFile(filePath, name);
    if (removed) this._merged = null;
    return removed;
  }

  toggleHook(name) {
    const scope = this._findHookScope(name);
    if (!scope) return null;

    const filePath = scope === 'project' ? this._projectHooksPath() : this._globalHooksPath();
    const existing = this._readHooksFile(filePath);

    for (const point of VALID_HOOK_POINTS) {
      if (!existing[point]) continue;
      for (const h of existing[point]) {
        if (h.name === name) {
          h.enabled = !h.enabled;
          delete h._scope;
          this._writeHooksFile(filePath, existing);
          this._merged = null;
          return h.enabled;
        }
      }
    }
    return null;
  }

  updateHook(name, updates) {
    const scope = this._findHookScope(name);
    if (!scope) return null;

    const filePath = scope === 'project' ? this._projectHooksPath() : this._globalHooksPath();
    const existing = this._readHooksFile(filePath);

    for (const point of VALID_HOOK_POINTS) {
      if (!existing[point]) continue;
      for (const h of existing[point]) {
        if (h.name === name) {
          Object.assign(h, updates);
          delete h._scope;
          this._writeHooksFile(filePath, existing);
          this._merged = null;
          return h;
        }
      }
    }
    return null;
  }

  listAll() {
    const hooks = this._getHooks();
    const all = [];
    for (const point of VALID_HOOK_POINTS) {
      if (!hooks[point]) continue;
      for (const h of hooks[point]) {
        all.push({ ...h, hookPoint: point });
      }
    }
    return all;
  }

  // ---------------------------------------------------------------------------
  // Add wizard
  // ---------------------------------------------------------------------------

  async runAddWizard(pickFn, askQuestion, modelRegistry) {
    // 1. Scope
    const scopeItems = [
      { key: 'global', label: 'Global', description: 'Applies to all projects (~/.banana/hooks.json)' },
      { key: 'project', label: 'Project', description: 'Only this project (.banana/hooks.json)' }
    ];
    const scopeChoice = await pickFn(scopeItems, { title: 'Hook Scope' });
    if (!scopeChoice) return null;
    const scope = scopeChoice.key;

    // 2. Hook point
    const pointItems = VALID_HOOK_POINTS.map(p => ({
      key: p,
      label: p,
      description: {
        beforeTurn: 'Runs before each AI request',
        afterTurn: 'Runs after each AI response',
        afterWrite: 'Runs after a file is written',
        afterCommand: 'Runs after a shell command',
        onError: 'Runs when an error occurs'
      }[p] || ''
    }));
    const pointChoice = await pickFn(pointItems, { title: 'Hook Point' });
    if (!pointChoice) return null;

    // 3. Hook type
    const typeItems = [
      { key: 'prompt', label: 'Prompt', description: 'Describe what you want - AI configures everything' },
      { key: 'agent', label: 'Agent Hook', description: 'Manually configure agent(s) with instructions' },
      { key: 'shell', label: 'Shell Hook', description: 'Run a shell command' }
    ];
    const typeChoice = await pickFn(typeItems, { title: 'Hook Type' });
    if (!typeChoice) return null;

    // --- PROMPT PATH: AI generates the full hook from a description ---
    if (typeChoice.key === 'prompt') {
      return this._runPromptWizard(pickFn, askQuestion, modelRegistry, scope, pointChoice.key);
    }

    // 4. Name
    const name = await askQuestion('  Hook name: ');
    if (!name || !name.trim()) return null;
    const hookName = name.trim();

    const hookDef = { name: hookName, enabled: true };

    if (typeChoice.key === 'agent') {
      // --- AGENT A ---
      console.log(`\n  --- AGENT A ---`);

      const modelA = await this._pickModel(pickFn, askQuestion, modelRegistry, 'Agent A Model');
      if (!modelA) return null;

      const taskA = await this._askForInstructions(
        'INSTRUCTIONS FOR AGENT A',
        modelA,
        askQuestion
      );
      if (!taskA) return null;

      hookDef.agentA = { model: modelA, task: taskA };

      // --- AGENT B (optional) ---
      const addBItems = [
        { key: 'yes', label: 'Yes', description: 'Add a second agent that processes Agent A output' },
        { key: 'no', label: 'No', description: 'Single agent hook' }
      ];
      const addBChoice = await pickFn(addBItems, { title: 'Add Agent B?' });

      if (addBChoice && addBChoice.key === 'yes') {
        console.log(`\n  --- AGENT B ---`);

        const modelB = await this._pickModel(pickFn, askQuestion, modelRegistry, 'Agent B Model');
        if (!modelB) return null;

        const taskB = await this._askForInstructions(
          'INSTRUCTIONS FOR AGENT B',
          modelB,
          askQuestion
        );
        if (!taskB) return null;

        hookDef.agentB = { model: modelB, task: taskB };

        // Max turns
        const maxInput = await askQuestion(`  Max turns (default ${DEFAULT_MAX_TURNS}): `);
        const parsed = parseInt(maxInput, 10);
        hookDef.maxTurns = (parsed > 0) ? parsed : DEFAULT_MAX_TURNS;
      } else {
        hookDef.maxTurns = 1;
      }

      // Read-only?
      const readOnlyInput = await askQuestion('  Read-only agents? (Y/n): ');
      hookDef.readOnly = !readOnlyInput.trim() || readOnlyInput.trim().toLowerCase().startsWith('y');

      // Where does the hook's output go?
      const injectChoice = await pickFn(this._injectItems(), { title: 'Where Should Hook Output Go?' });
      hookDef.inject = injectChoice ? injectChoice.key : 'prepend';

    } else {
      // Shell hook
      console.log('  Available templates: {{file}}, {{files}}, {{projectDir}}');
      const command = await askQuestion('  Command: ');
      if (!command || !command.trim()) return null;
      hookDef.command = command.trim();
    }

    // Trigger
    const triggerItems = VALID_TRIGGERS.map(t => ({
      key: t,
      label: t,
      description: {
        always: 'Always fire',
        fileChanged: 'Only when files were changed',
        commandRan: 'Only when a command was run',
        hasErrors: 'Only when an error occurred'
      }[t] || ''
    }));
    const triggerChoice = await pickFn(triggerItems, { title: 'Trigger' });
    hookDef.trigger = triggerChoice ? triggerChoice.key : 'always';

    // Timeout
    const defaultTimeout = typeChoice.key === 'agent' ? DEFAULT_AGENT_TIMEOUT : DEFAULT_SHELL_TIMEOUT;
    const timeoutInput = await askQuestion(`  Timeout in ms (default ${defaultTimeout}): `);
    const parsedTimeout = parseInt(timeoutInput, 10);
    if (parsedTimeout > 0) {
      hookDef.timeout = parsedTimeout;
    }

    // Save
    this.addHook(pointChoice.key, hookDef, scope);
    return { hookPoint: pointChoice.key, hookDef, scope };
  }

  // ---------------------------------------------------------------------------
  // Prompt wizard (AI-generated hook from natural language)
  // ---------------------------------------------------------------------------

  async _runPromptWizard(pickFn, askQuestion, modelRegistry, scope, suggestedHookPoint) {
    if (!this.refineFn) {
      console.log('  AI refinement not available. Use Agent Hook instead.');
      return null;
    }

    // Pick model for the hook agent (will also be used for generation)
    const model = await this._pickModel(pickFn, askQuestion, modelRegistry, 'Model for this Hook');
    if (!model) return null;

    console.log('\n  Describe what this hook should do (plain English):');
    const description = await askQuestion('  > ');
    if (!description?.trim()) return null;

    console.log('  Generating hook configuration...');

    let generated;
    try {
      const raw = await this.refineFn(
        `Hook point the user already selected: ${suggestedHookPoint}\n\nUser request: ${description.trim()}`,
        model,
        PROMPT_HOOK_SYSTEM
      );
      generated = JSON.parse(raw);
    } catch {
      console.log('  Could not parse AI response. Falling back to defaults.');
      generated = null;
    }

    // Build hook from AI output or defaults
    const hookPoint = generated?.hookPoint && VALID_HOOK_POINTS.includes(generated.hookPoint)
      ? generated.hookPoint : suggestedHookPoint;
    const hookName = generated?.name || description.trim().slice(0, 30).replace(/\s+/g, '-').toLowerCase();
    const task = generated?.task || description.trim();
    const trigger = generated?.trigger && VALID_TRIGGERS.includes(generated.trigger)
      ? generated.trigger : 'always';
    const inject = generated?.inject && VALID_INJECT_MODES.includes(generated.inject)
      ? generated.inject : 'prepend';
    const readOnly = generated?.readOnly !== false;

    // Show generated config
    console.log('');
    console.log(`  Name:       ${hookName}`);
    console.log(`  Hook Point: ${hookPoint}`);
    console.log(`  Model:      ${model}`);
    console.log(`  Trigger:    ${trigger}`);
    console.log(`  Inject:     ${inject}`);
    console.log(`  Read-only:  ${readOnly ? 'Yes' : 'No'}`);
    console.log(`  Task:`);
    const taskLines = task.split('\n');
    for (const line of taskLines.slice(0, 15)) {
      console.log(`    ${line}`);
    }
    if (taskLines.length > 15) console.log(`    ...(${taskLines.length - 15} more lines)`);
    console.log('');

    const confirm = await askQuestion('  Create this hook? (Y/n): ');
    if (confirm?.trim().toLowerCase().startsWith('n')) {
      return null;
    }

    const hookDef = {
      name: hookName,
      enabled: true,
      agentA: { model, task },
      maxTurns: 1,
      readOnly,
      trigger,
      inject
    };

    this.addHook(hookPoint, hookDef, scope);
    return { hookPoint, hookDef, scope };
  }

  // ---------------------------------------------------------------------------
  // Edit wizard
  // ---------------------------------------------------------------------------

  async runEditWizard(pickFn, askQuestion, modelRegistry, hookName) {
    // If no name given, let user pick from list
    if (!hookName) {
      const allHooks = this.listAll();
      if (allHooks.length === 0) {
        console.log('  No hooks to edit.');
        return null;
      }
      const hookItems = allHooks.map(h => {
        const type = h.agentA ? 'agent A/B' : h.agent ? 'agent' : 'shell';
        return {
          key: h.name,
          label: h.name,
          description: `${h.hookPoint}, ${h._scope}, ${type}`
        };
      });
      const picked = await pickFn(hookItems, { title: 'Select Hook to Edit' });
      if (!picked) return null;
      hookName = picked.key;
    }

    // Find the hook
    const allHooks = this.listAll();
    const hook = allHooks.find(h => h.name === hookName);
    if (!hook) {
      console.log(`  Hook "${hookName}" not found.`);
      return null;
    }

    const normalized = this._normalize(hook);
    const isAgent = !!(normalized.agentA || hook.agent);
    const isMultiAgent = !!normalized.agentB;

    // Show current config
    console.log('');
    console.log(`  Current configuration for "${hookName}":`);
    console.log(`  Scope: ${hook._scope || 'global'}`);
    console.log(`  Hook Point: ${hook.hookPoint}`);
    if (isAgent) {
      const aModel = normalized.agentA?.model || hook.agent;
      const aTask = normalized.agentA?.task || hook.task;
      console.log(`  Agent A: ${aModel}`);
      console.log(`    Task: ${aTask?.slice(0, 80)}${(aTask?.length || 0) > 80 ? '...' : ''}`);
      if (isMultiAgent) {
        console.log(`  Agent B: ${normalized.agentB.model}`);
        console.log(`    Task: ${normalized.agentB.task?.slice(0, 80)}${(normalized.agentB.task?.length || 0) > 80 ? '...' : ''}`);
        console.log(`  Max Turns: ${normalized.maxTurns || DEFAULT_MAX_TURNS}`);
      }
      console.log(`  Read-only: ${hook.readOnly !== false ? 'Yes' : 'No'}`);
      console.log(`  Inject: ${hook.inject || 'prepend'}`);
    } else {
      console.log(`  Command: ${hook.command}`);
    }
    console.log(`  Trigger: ${hook.trigger || 'always'}`);
    console.log(`  Timeout: ${hook.timeout || (isAgent ? DEFAULT_AGENT_TIMEOUT : DEFAULT_SHELL_TIMEOUT)}ms`);
    console.log('');

    // Build editable fields
    const fields = [];
    if (isAgent) {
      fields.push({ key: 'agentA.model', label: 'Agent A Model' });
      fields.push({ key: 'agentA.task', label: 'Agent A Instructions' });
      if (isMultiAgent) {
        fields.push({ key: 'agentB.model', label: 'Agent B Model' });
        fields.push({ key: 'agentB.task', label: 'Agent B Instructions' });
        fields.push({ key: 'maxTurns', label: 'Max Turns' });
      } else {
        fields.push({ key: 'addAgentB', label: 'Add Agent B' });
      }
      if (isMultiAgent) {
        fields.push({ key: 'removeAgentB', label: 'Remove Agent B' });
      }
      fields.push({ key: 'readOnly', label: 'Read-only' });
      fields.push({ key: 'inject', label: 'Inject Mode' });
    } else {
      fields.push({ key: 'command', label: 'Command' });
    }
    fields.push({ key: 'trigger', label: 'Trigger' });
    fields.push({ key: 'timeout', label: 'Timeout' });
    fields.push({ key: 'done', label: 'Save & Exit' });

    const updates = {};
    let editing = true;

    while (editing) {
      const fieldChoice = await pickFn(
        fields.map(f => ({ key: f.key, label: f.label, description: '' })),
        { title: 'Edit Field' }
      );
      if (!fieldChoice || fieldChoice.key === 'done') {
        editing = false;
        break;
      }

      switch (fieldChoice.key) {
        case 'agentA.model': {
          const model = await this._pickModel(pickFn, askQuestion, modelRegistry, 'Agent A Model');
          if (model) {
            if (!updates.agentA) updates.agentA = { ...(normalized.agentA || {}) };
            updates.agentA.model = model;
            // Also clear legacy fields if present
            updates.agent = undefined;
          }
          break;
        }
        case 'agentA.task': {
          const modelKey = updates.agentA?.model || normalized.agentA?.model || hook.agent;
          const task = await this._askForInstructions('INSTRUCTIONS FOR AGENT A', modelKey, askQuestion);
          if (task) {
            if (!updates.agentA) updates.agentA = { ...(normalized.agentA || {}) };
            updates.agentA.task = task;
            updates.task = undefined;
          }
          break;
        }
        case 'agentB.model': {
          const model = await this._pickModel(pickFn, askQuestion, modelRegistry, 'Agent B Model');
          if (model) {
            if (!updates.agentB) updates.agentB = { ...(normalized.agentB || {}) };
            updates.agentB.model = model;
          }
          break;
        }
        case 'agentB.task': {
          const modelKey = updates.agentB?.model || normalized.agentB?.model;
          const task = await this._askForInstructions('INSTRUCTIONS FOR AGENT B', modelKey, askQuestion);
          if (task) {
            if (!updates.agentB) updates.agentB = { ...(normalized.agentB || {}) };
            updates.agentB.task = task;
          }
          break;
        }
        case 'addAgentB': {
          console.log(`\n  --- AGENT B ---`);
          const model = await this._pickModel(pickFn, askQuestion, modelRegistry, 'Agent B Model');
          if (!model) break;
          const task = await this._askForInstructions('INSTRUCTIONS FOR AGENT B', model, askQuestion);
          if (!task) break;
          updates.agentB = { model, task };
          const maxInput = await askQuestion(`  Max turns (default ${DEFAULT_MAX_TURNS}): `);
          const parsed = parseInt(maxInput, 10);
          updates.maxTurns = (parsed > 0) ? parsed : DEFAULT_MAX_TURNS;
          // Update field list to reflect the change
          const addIdx = fields.findIndex(f => f.key === 'addAgentB');
          if (addIdx >= 0) {
            fields.splice(addIdx, 1,
              { key: 'agentB.model', label: 'Agent B Model' },
              { key: 'agentB.task', label: 'Agent B Instructions' },
              { key: 'maxTurns', label: 'Max Turns' },
              { key: 'removeAgentB', label: 'Remove Agent B' }
            );
          }
          break;
        }
        case 'removeAgentB': {
          updates.agentB = null;
          updates.maxTurns = 1;
          // Update field list
          const bModelIdx = fields.findIndex(f => f.key === 'agentB.model');
          const removeIdx = fields.findIndex(f => f.key === 'removeAgentB');
          if (bModelIdx >= 0 && removeIdx >= 0) {
            fields.splice(bModelIdx, removeIdx - bModelIdx + 1,
              { key: 'addAgentB', label: 'Add Agent B' }
            );
          }
          console.log('  Agent B removed.');
          break;
        }
        case 'maxTurns': {
          const current = updates.maxTurns || normalized.maxTurns || DEFAULT_MAX_TURNS;
          const input = await askQuestion(`  Max turns (current: ${current}): `);
          const parsed = parseInt(input, 10);
          if (parsed > 0) updates.maxTurns = parsed;
          break;
        }
        case 'readOnly': {
          const current = hook.readOnly !== false;
          const input = await askQuestion(`  Read-only? (current: ${current ? 'Yes' : 'No'}) (Y/n): `);
          if (input?.trim()) {
            updates.readOnly = input.trim().toLowerCase().startsWith('y');
          }
          break;
        }
        case 'inject': {
          const choice = await pickFn(this._injectItems(), { title: 'Where Should Hook Output Go?' });
          if (choice) updates.inject = choice.key;
          break;
        }
        case 'command': {
          console.log('  Available templates: {{file}}, {{files}}, {{projectDir}}');
          const input = await askQuestion(`  Command (current: ${hook.command}): `);
          if (input?.trim()) updates.command = input.trim();
          break;
        }
        case 'trigger': {
          const triggerItems = VALID_TRIGGERS.map(t => ({
            key: t, label: t, description: ''
          }));
          const choice = await pickFn(triggerItems, { title: 'Trigger' });
          if (choice) updates.trigger = choice.key;
          break;
        }
        case 'timeout': {
          const current = hook.timeout || (isAgent ? DEFAULT_AGENT_TIMEOUT : DEFAULT_SHELL_TIMEOUT);
          const input = await askQuestion(`  Timeout in ms (current: ${current}): `);
          const parsed = parseInt(input, 10);
          if (parsed > 0) updates.timeout = parsed;
          break;
        }
      }
    }

    // Apply updates
    if (Object.keys(updates).length === 0) return null;

    // If migrating from legacy format, ensure old fields get removed
    if (hook.agent && (updates.agentA || updates.agentB)) {
      if (!updates.agentA) {
        updates.agentA = { model: hook.agent, task: hook.task };
      }
      if (updates.agent === undefined) updates.agent = null; // mark for deletion
      else if (!('agent' in updates)) updates.agent = null;
      if (updates.task === undefined) updates.task = null;
      else if (!('task' in updates)) updates.task = null;
    }

    const scope = this._findHookScope(hookName);
    const hookPoint = this._findHookPoint(hookName);
    if (scope && hookPoint) {
      const filePath = scope === 'project' ? this._projectHooksPath() : this._globalHooksPath();
      const existing = this._readHooksFile(filePath);

      if (existing[hookPoint]) {
        for (const h of existing[hookPoint]) {
          if (h.name === hookName) {
            for (const [k, v] of Object.entries(updates)) {
              if (v === undefined || v === null) {
                delete h[k];
              } else {
                h[k] = v;
              }
            }
            delete h._scope;
            delete h.hookPoint;
            break;
          }
        }
        this._writeHooksFile(filePath, existing);
        this._merged = null;
      }
    }

    return { hookName, updates };
  }
}

module.exports = {
  HookManager,
  VALID_HOOK_POINTS,
  VALID_TRIGGERS,
  VALID_INJECT_MODES,
  DEFAULT_AGENT_TIMEOUT,
  DEFAULT_SHELL_TIMEOUT,
  DEFAULT_MAX_TURNS,
  REFINE_SYSTEM_PROMPT,
  PROMPT_HOOK_SYSTEM
};
