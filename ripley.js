#!/usr/bin/env node

/**
 * Ripley Code v4.0.0 - Your local AI coding agent
 *
 * Local + remote providers with direct model connections.
 *
 * Features:
 * - Named model profiles with /model switching
 * - Streaming responses with markdown rendering
 * - File read/write with diffs and backups
 * - Agentic mode (AI reads files on demand)
 * - Local vision model support with Gemini fallback
 * - @ mentions for quick file loading
 * - Command history, tab completion, watch mode
 * - Conversation save/load, token tracking
 * - Extensible prompts (drop .md files in prompts/)
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FileManager = require('./lib/fileManager');
const ContextBuilder = require('./lib/contextBuilder');
const CommandRunner = require('./lib/commandRunner');
const Config = require('./lib/config');
const HistoryManager = require('./lib/historyManager');
const Completer = require('./lib/completer');
const TokenCounter = require('./lib/tokenCounter');
const Watcher = require('./lib/watcher');
const ImageHandler = require('./lib/imageHandler');
const VisionAnalyzer = require('./lib/visionAnalyzer');
const { StreamHandler } = require('./lib/streamHandler');
const { parseResponse } = require('./lib/parser');
const { formatOperationsBatch, formatCompactSummary, colors: rawColors } = require('./lib/diffViewer');
const { MarkdownRenderer } = require('./lib/markdownRenderer');
const LmStudio = require('./lib/lmStudio');
const PromptManager = require('./lib/promptManager');
const ModelRegistry = require('./lib/modelRegistry');
const { ProviderStore, PROVIDERS } = require('./lib/providerStore');
const { ProviderManager, PROVIDER_LABELS } = require('./lib/providerManager');
const { AgenticRunner, TOOLS, READ_ONLY_TOOLS, setMcpClient } = require('./lib/agenticRunner');
const { SubAgentManager, SPAWN_AGENT_TOOL_DEF } = require('./lib/subAgentManager');
const { HookManager, REFINE_SYSTEM_PROMPT } = require('./lib/hookManager');
const McpClient = require('./lib/mcpClient');
const { pick, pickToggle, isPickerActive } = require('./lib/interactivePicker');
const StatusBar = require('./lib/statusBar');
const borderRenderer = require('./lib/borderRenderer');
const InlineComplete = require('./lib/inlineComplete');

// =============================================================================
// ASK_HUMAN TOOL DEFINITION
// =============================================================================

const ASK_HUMAN_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'ask_human',
    description: 'Ask the user a question and wait for their response. Use this when you need clarification, want to confirm an approach, or need the user to make a decision before proceeding. The user will see your question and can type a response.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user. Be specific and concise.'
        }
      },
      required: ['question']
    }
  }
};

// Resolver for pending ask_human interactions.
// Set by the ask_human executor, resolved by handleLine when user answers.
let pendingHumanQuestion = null; // { resolve, question }

// =============================================================================
// CONFIGURATION
// =============================================================================

const VERSION = '4.0.0';
const PAD = '  '; // Global left padding for all output
const DEBUG_DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);
const NEXT_TURN_RESERVE_TOKENS = 1200;
const COMPACTION_SAFETY_BUFFER = 0.05;
const missingColorTokens = new Set();
const c = new Proxy(rawColors, {
  get(target, prop) {
    if (typeof prop !== 'string') return target[prop];
    if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
    // Guard against "undefined" leaking into terminal output.
    missingColorTokens.add(prop);
    return '';
  }
});

// =============================================================================
// GLOBALS
// =============================================================================

let projectDir = process.cwd();
let config = null;
let fileManager = null;
let contextBuilder = null;
let commandRunner = null;
let historyManager = null;
let completer = null;
let tokenCounter = null;
let watcher = null;
let imageHandler = null;
let visionAnalyzer = null;
let showGeminiKeyPrompt = null; // assigned in createReadlineInterface (needs readline closure)
let awaitingGeminiKey = false;
let geminiKeyCallback = null;
let lmStudio = null;
let promptManager = null;
let modelRegistry = null;
let providerStore = null;
let providerManager = null;
let mcpClient = null;
let subAgentManager = null;
let hookManager = null;
let statusBar = null;
let inlineComplete = null;
let conversationHistory = [];
let lastKnownTokens = 0; // Track actual token usage from API responses
let projectedContextTokens = 0; // Estimated next-request prompt tokens
let rl = null;
let runtimeLogPath = null;
let sessionEndLogged = false;

// Interaction modes: 'work' (default), 'plan' (explore + structured plan), 'ask' (no operations)
let interactionMode = 'work';

// Active prompt name (default: 'base', user can switch with /prompt)
let activePrompt = 'base';

// Thinking level: 'off' | 'low' | 'medium' | 'high'
// Controls budget_tokens sent to models that support thinking
let thinkingLevel = 'off';
const THINKING_LEVELS = ['off', 'low', 'medium', 'high'];
const DEFAULT_THINKING_BUDGETS = { low: 1024, medium: 4096, high: 16384 };

function getThinkingBudget() {
  if (thinkingLevel === 'off') return 0;
  const model = modelRegistry?.getCurrentModel();
  const budgets = model?.thinkingBudgets || DEFAULT_THINKING_BUDGETS;
  return budgets[thinkingLevel] ?? DEFAULT_THINKING_BUDGETS[thinkingLevel] ?? 0;
}

// Queued steering inputs to inject before the next request(s)
let queuedSteeringMessages = [];
let midTurnSteerRequested = false;

// Abort controller for cancelling requests with Escape (double-press)
let currentAbortController = null;
let lastEscapeTime = 0;

// Mid-turn input: prompt is always visible during AI work (like Claude Code)
let promptDuringWork = false;       // true when prompt is shown below spinner during AI work
let renderWorkingPrompt = null;     // function to re-render spinner + prompt during work
let restorePromptFn = null;         // set by main(), restores normal readline prompt

// Build the full user prompt prefix (model, context%, mode) for use anywhere
function buildPromptPrefix() {
  const currentModel = modelRegistry?.getCurrentModel();
  const parts = modelDisplayParts(currentModel);
  const modelName = currentModel
    ? (currentModel.key.startsWith(`${parts.provider}:`)
      ? currentModel.key
      : `${parts.provider}:${currentModel.key}`)
    : '?';
  const limit = modelRegistry?.getContextLimit() || 0;
  const usedTokens = projectedContextTokens > 0
    ? projectedContextTokens
    : estimateNextTurnContextTokens();
  const pct = contextPercentForTokens(usedTokens, limit);
  const modeIcon = { work: '\u{1F527}', plan: '\u{1F4CB}', ask: '\u{1F4AC}' }[interactionMode] || '\u{1F527}';
  const think = (thinkingLevel !== 'off' && modelRegistry?.currentSupportsThinking()) ? ` ${c.cyan}\u{1F9E0}${thinkingLevel}${c.reset}` : '';
  let pctColor = c.green;
  if (pct >= 80) pctColor = c.red;
  else if (pct >= 50) pctColor = c.yellow;
  return `${borderRenderer.prefix('user')}${c.green}${modeIcon}${c.reset} ${c.dim}[${modelName}]${c.reset}${think} ${c.dim}ctx:${c.reset}${pctColor}${pct}%${c.reset} ${c.orange}You \u2192 ${c.reset}`;
}

// Truncate an ANSI-decorated string to fit within the terminal width.
// Walks visible characters only, keeping ANSI escape sequences intact.
function fitToTerminal(str) {
  // Reserve 2 columns as safety margin for wide chars (emoji = 2 cols)
  const cols = (process.stdout.columns || 120) - 2;
  if (cols < 10) return str;
  let visible = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      // Skip entire ANSI escape sequence
      const end = str.indexOf('m', i);
      if (end !== -1) { i = end + 1; continue; }
    }
    // Emoji and wide chars take 2 columns. Check surrogate pairs and common wide ranges.
    const code = str.codePointAt(i);
    const charWidth = (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x2B50 && code <= 0x2B55) || code > 0xFFFF) ? 2 : 1;
    visible += charWidth;
    if (visible >= cols) return str.slice(0, i) + '\x1b[0m';
    i += (code > 0xFFFF) ? 2 : 1; // Skip surrogate pair
  }
  return str;
}

function isDebugLoggingEnabled() {
  const raw = (process.env.RIPLEY_DEBUG || '').trim().toLowerCase();
  if (!raw) return true; // default ON for active development
  return !DEBUG_DISABLED_VALUES.has(raw);
}

function defaultDebugLogPath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), '.ripley', 'logs', `ripley-${day}.log`);
}

function appendDebugLog(line) {
  if (!isDebugLoggingEnabled()) return;
  const target = process.env.RIPLEY_DEBUG_PATH || runtimeLogPath || defaultDebugLogPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, line, 'utf-8');
  } catch {
    // Logging is best-effort; never fail user flow.
  }
}

function initDebugLogging() {
  const enabled = isDebugLoggingEnabled();
  process.env.RIPLEY_DEBUG = enabled ? '1' : '0';
  if (!enabled) return null;

  const configured = (process.env.RIPLEY_DEBUG_PATH || '').trim();
  const target = configured || defaultDebugLogPath();
  process.env.RIPLEY_DEBUG_PATH = target;
  runtimeLogPath = target;

  appendDebugLog(
    `\n=== session_start ${new Date().toISOString()} pid=${process.pid} version=${VERSION} cwd=${projectDir} ===\n`
  );
  return target;
}

function logSessionEnd(reason, detail = '') {
  if (sessionEndLogged) return;
  sessionEndLogged = true;
  appendDebugLog(`=== session_end ${new Date().toISOString()} reason=${reason}${detail} ===\n`);
}

// =============================================================================
// ASCII ART & UI
// =============================================================================

const BANNER_ART_LINES = [
  '██████╗ ██╗██████╗ ██╗     ███████╗██╗   ██╗',
  '██╔══██╗██║██╔══██╗██║     ██╔════╝╚██╗ ██╔╝',
  '██████╔╝██║██████╔╝██║     █████╗   ╚████╔╝',
  '██╔══██╗██║██╔═══╝ ██║     ██╔══╝    ╚██╔╝',
  '██║  ██║██║██║     ███████╗███████╗   ██║',
  '╚═╝  ╚═╝╚═╝╚═╝     ╚══════╝╚══════╝   ╚═╝'
];
const BANNER_WIDTH = 43;
const ANIM_DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BANNER_ANIMATION_TOTAL_MS = 2500;
const BANNER_PULSE_STEPS = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldAnimateBanner() {
  const disabled = (process.env.RIPLEY_NO_ANIM || '').trim().toLowerCase();
  if (ANIM_DISABLED_VALUES.has(disabled)) return false;
  return Boolean(process.stdout.isTTY) && !Boolean(process.env.CI);
}

function renderBannerFrame(activeLine = null, forceColor = null) {
  const logo = BANNER_ART_LINES
    .map((line, i) => {
      let color = forceColor || c.orange;
      if (!forceColor && activeLine !== null) {
        if (i === activeLine) color = c.yellow;
        else if (i > activeLine) color = c.gray;
      }
      return `${color}${PAD}${line}${c.reset}`;
    })
    .join('\n');

  const separator = `${PAD}${c.cyan}${'═'.repeat(BANNER_WIDTH)}${c.reset}`;
  const subtitle = `${PAD}${c.dim}Ripley Code • v${VERSION} • Local + Remote Models${c.reset}`;
  return `\n${logo}\n${separator}\n${subtitle}\n${separator}\n`;
}

async function showBanner() {
  const animate = shouldAnimateBanner();
  const canControlCursor = Boolean(process.stdout.isTTY);
  if (canControlCursor) process.stdout.write('\x1b[?25l');
  try {
    if (!animate) {
      console.clear();
      console.log(renderBannerFrame());
      return;
    }

    const totalSteps = BANNER_ART_LINES.length + BANNER_PULSE_STEPS;
    const stepDelay = Math.max(50, Math.floor(BANNER_ANIMATION_TOTAL_MS / totalSteps));

    for (let i = 0; i < BANNER_ART_LINES.length; i++) {
      console.clear();
      console.log(renderBannerFrame(i));
      await sleep(stepDelay);
    }

    for (let i = 0; i < BANNER_PULSE_STEPS; i++) {
      const pulseColor = i % 2 === 0 ? c.yellow : c.orange;
      console.clear();
      console.log(renderBannerFrame(null, pulseColor));
      await sleep(stepDelay);
    }

    console.clear();
    console.log(renderBannerFrame());
  } finally {
    if (canControlCursor) process.stdout.write('\x1b[?25h');
  }
}

function showHelp() {
  const P = PAD;
  console.log(`
${P}${c.orange}${c.dim}File Commands:${c.reset}
${P}${c.yellow}/files${c.reset}              List files in context
${P}${c.yellow}/read <path>${c.reset}        Add file to context (or use @filename)
${P}${c.yellow}/unread <path>${c.reset}      Remove file from context
${P}${c.yellow}/tree${c.reset}               Show project structure
${P}${c.yellow}/find <pattern>${c.reset}     Find files matching pattern
${P}${c.yellow}/grep <text>${c.reset}        Search for text in files
${P}${c.yellow}/image <path>${c.reset}       Add image (vision model or Gemini fallback)

${P}${c.orange}${c.dim}Git Commands:${c.reset}
${P}${c.yellow}/git${c.reset}                Show git status
${P}${c.yellow}/diff${c.reset}               Show uncommitted changes
${P}${c.yellow}/log${c.reset}                Show recent commits

${P}${c.orange}${c.dim}Session Commands:${c.reset}
${P}${c.yellow}/clear${c.reset}              Clear conversation & context
${P}${c.yellow}/clearhistory${c.reset}       Clear conversation only
${P}${c.yellow}/save <name>${c.reset}        Save conversation
${P}${c.yellow}/load <name>${c.reset}        Load saved conversation
${P}${c.yellow}/sessions${c.reset}           List saved sessions
${P}${c.yellow}/context${c.reset}            Show context size & tokens
${P}${c.yellow}/tokens${c.reset}             Show token usage this session
${P}${c.yellow}/compact${c.reset}            Toggle compact mode
${P}${c.yellow}/think [level]${c.reset}       Set thinking level: off, low, medium, high (cycles if no arg)

${P}${c.orange}${c.dim}Modes:${c.reset}
${P}${c.yellow}/work${c.reset}               Switch to WORK mode (execute operations)
${P}${c.yellow}/plan${c.reset}               Toggle PLAN mode (explore + structured plan + review)
${P}${c.yellow}/implement${c.reset}          Execute the saved plan from .ripley/plan.md
${P}${c.yellow}/ask${c.reset}                Toggle ASK mode (questions only, no file ops)
${P}${c.yellow}/mode${c.reset}               Show current mode
${P}${c.yellow}/yolo${c.reset}               Toggle YOLO mode (auto-apply all changes)
${P}${c.yellow}/agent [model] [task]${c.reset} Spawn sub-agent (no args = interactive picker)
${P}${c.yellow}/hooks${c.reset}               Manage lifecycle hooks (add, edit, remove, toggle, test)
${P}${c.yellow}/steer <text>${c.reset}       Steer next turn (or interrupt + redirect current turn)
${P}${c.yellow}/model [name]${c.reset}      Show/switch model
${P}${c.yellow}/model search <query>${c.reset} Search OpenRouter models and add one
${P}${c.yellow}/connect [provider]${c.reset} Connect provider (Anthropic, OpenAI OAuth, OpenRouter)
${P}${c.yellow}/prompt [name]${c.reset}     Show/switch prompt (base, code-agent, or any .md)

${P}${c.orange}${c.dim}Config Commands:${c.reset}
${P}${c.yellow}/config${c.reset}             Show current config
${P}${c.yellow}/set <key> <value>${c.reset}  Update config setting
${P}${c.yellow}/instructions${c.reset}       Edit project instructions
${P}${c.yellow}/mcp${c.reset}                MCP server status, setup, auth, tools
${P}${c.yellow}/watch${c.reset}              Toggle file watch mode
${P}${c.yellow}/stream${c.reset}             Toggle streaming mode

${P}${c.orange}${c.dim}System Commands:${c.reset}
${P}${c.yellow}/run <cmd>${c.reset}          Run a shell command
${P}${c.yellow}/undo${c.reset}               Show recent backups
${P}${c.yellow}/restore <path>${c.reset}     Restore file from backup
${P}${c.yellow}/commands${c.reset}           List custom commands (~/.ripley/Commands/)
${P}${c.yellow}/version${c.reset}            Show version
${P}${c.yellow}/help${c.reset}               Show this help
${P}${c.yellow}/exit${c.reset}               Exit Ripley

${P}${c.orange}${c.dim}Tips:${c.reset}
${P}${c.gray}• Use ${c.cyan}@filename${c.gray} in messages to auto-load files
${P}${c.gray}• Press ${c.cyan}↑${c.gray}/${c.cyan}↓${c.gray} to navigate command history
${P}${c.gray}• Press ${c.cyan}Tab${c.gray} for completion
${P}${c.gray}• Press ${c.cyan}Shift+Tab${c.gray} to cycle modes (work → plan → ask)
${P}${c.gray}• Press ${c.cyan}Alt+V${c.gray} to paste screenshot from clipboard
${P}${c.gray}• Press ${c.cyan}Esc Esc${c.gray} to cancel current request
${P}${c.gray}• Create ${c.cyan}RIPLEY.md${c.gray} in your project root for project-specific AI instructions
${c.reset}`);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

function initProject() {
  // Initialize all components
  config = new Config(projectDir);
  fileManager = new FileManager(projectDir);
  contextBuilder = new ContextBuilder(fileManager, config.get('ignorePatterns'));
  commandRunner = new CommandRunner(projectDir);
  historyManager = new HistoryManager(path.join(projectDir, '.ripley'));
  completer = new Completer(projectDir, contextBuilder);
  inlineComplete = new InlineComplete();
  inlineComplete.projectDir = projectDir;
  inlineComplete.setCommands(completer.commands);
  tokenCounter = new TokenCounter(config);
  imageHandler = new ImageHandler(projectDir);

  // Initialize LM Studio + provider manager
  const lmStudioUrl = config.get('lmStudioUrl') || 'http://localhost:1234';
  lmStudio = new LmStudio({ baseUrl: lmStudioUrl });
  providerStore = new ProviderStore();
  providerManager = new ProviderManager({ lmStudio, store: providerStore });

  // Initialize prompt manager (loads .md files from prompts/ directory)
  const promptsDir = path.join(__dirname, 'prompts');
  promptManager = new PromptManager(promptsDir);

  // Initialize model registry (local + connected remote models)
  const modelsPath = path.join(__dirname, 'models.json');
  modelRegistry = new ModelRegistry(modelsPath, lmStudio, providerStore);

  // Restore last active model from config
  const legacyModelAliasMap = {
    'anthropic:claude-sonnet-4.7': 'anthropic:claude-sonnet-4.6',
    'openrouter:claude-sonnet-4.7': 'openrouter:claude-sonnet-4.6'
  };
  let savedModel = config.get('activeModel');
  if (legacyModelAliasMap[savedModel]) {
    savedModel = legacyModelAliasMap[savedModel];
    config.set('activeModel', savedModel);
  }
  if (savedModel && modelRegistry.get(savedModel)) {
    modelRegistry.setCurrent(savedModel);
  } else {
    modelRegistry.setCurrent(modelRegistry.getDefault());
  }

  // Set active prompt from the model's configured prompt (so it matches what agentic mode uses)
  const modelPromptName = modelRegistry.getPrompt();
  if (promptManager.has(modelPromptName)) {
    activePrompt = modelPromptName;
  } else if (promptManager.has('code-agent')) {
    activePrompt = 'code-agent';
  } else {
    activePrompt = config.get('activePrompt') || 'base';
  }

  // Try to get Gemini API key from: 1) project config, 2) global config, 3) env var
  let geminiKey = config.get('geminiApiKey');
  if (!geminiKey) {
    const globalConfigPath = path.join(os.homedir(), '.ripley', 'config.json');
    try {
      if (fs.existsSync(globalConfigPath)) {
        const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
        geminiKey = globalConfig.geminiApiKey;
      }
    } catch {}
  }
  geminiKey = geminiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  visionAnalyzer = new VisionAnalyzer({ apiKey: geminiKey });

  // Initialize watcher (but don't start yet)
  watcher = new Watcher(projectDir, contextBuilder, {
    onChange: (file, type) => {
      console.log(`\n${PAD}${c.dim}📁 ${file} ${type}${c.reset}`);
    },
    onError: (file, error) => {
      console.log(`\n${PAD}${c.red}⚠ Watch error: ${file}: ${error.message}${c.reset}`);
    }
  });

  // Get project summary
  const summary = contextBuilder.getSummary();

  console.log(`${PAD}${c.green}✓${c.reset} Project: ${c.white}${path.basename(projectDir)}${c.reset}`);
  console.log(`${PAD}${c.green}✓${c.reset} Files: ${summary.sourceFiles} source files in ${summary.totalDirs} directories`);

  // Load priority files
  contextBuilder.loadPriorityFiles();
  console.log(`${PAD}${c.green}✓${c.reset} Context: ${contextBuilder.getLoadedFiles().length} files loaded`);

  // Check for project instructions (RIPLEY.md or .ripley/instructions.md)
  const instructions = config.getInstructions();
  if (instructions) {
    console.log(`${PAD}${c.green}✓${c.reset} Project instructions loaded ${c.dim}(${instructions.source})${c.reset}`);
  }

  // Show model info
  const currentModel = modelRegistry.getCurrentModel();
  if (currentModel) {
    const providerLabel = PROVIDER_LABELS[currentModel.provider || 'local'] || currentModel.provider || 'local';
    console.log(`${PAD}${c.green}✓${c.reset} Model: ${c.white}${currentModel.name}${c.reset} ${c.dim}(${currentModel.key}, ${providerLabel})${c.reset}`);
  }

  // Show prompt info
  console.log(`${PAD}${c.green}✓${c.reset} Prompt: ${c.white}${activePrompt}${c.reset} ${c.dim}(${promptManager.list().length} available)${c.reset}`);

  // Vision capability
  if (modelRegistry.currentSupportsVision()) {
    const visionModel = modelRegistry.getCurrentModel();
    const visionProvider = visionModel?.provider || 'local';
    if (visionProvider === 'local') {
      console.log(`${PAD}${c.green}✓${c.reset} Vision: local model (direct)`);
    } else {
      const providerLabel = PROVIDER_LABELS[visionProvider] || visionProvider;
      console.log(`${PAD}${c.green}✓${c.reset} Vision: ${providerLabel} model (direct)`);
    }
  } else if (visionAnalyzer.isEnabled()) {
    console.log(`${PAD}${c.green}✓${c.reset} Vision: Gemini fallback`);
  } else {
    console.log(`${PAD}${c.dim}○ Vision disabled (paste an image with Alt+V to set up, or load a vision model)${c.reset}`);
  }

  // Initialize MCP client (project config -> global config -> env var)
  let mcpUrl = config.get('mcpUrl');
  if (!mcpUrl) {
    const globalConfigPath = path.join(os.homedir(), '.ripley', 'config.json');
    try {
      if (fs.existsSync(globalConfigPath)) {
        const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
        mcpUrl = globalConfig.mcpUrl;
      }
    } catch {}
  }
  mcpUrl = mcpUrl || process.env.MCP_SERVER_URL || null;
  mcpClient = new McpClient(mcpUrl ? { url: mcpUrl } : {});
  setMcpClient(mcpClient);

  // Initialize Sub-Agent Manager
  subAgentManager = new SubAgentManager({
    providerManager,
    modelRegistry,
    promptManager,
    config,
    projectDir
  });

  // Initialize Hook Manager
  hookManager = new HookManager({
    config,
    subAgentManager,
    projectDir,
    refineFn: async (naturalLanguage, modelKey, systemPrompt) => {
      try {
        const resolved = modelRegistry.resolveModelKey(modelKey || 'local:current');
        if (!resolved) return naturalLanguage;
        const client = await providerManager.getClientForModel(resolved);
        const result = await client.chat([
          { role: 'system', content: systemPrompt || REFINE_SYSTEM_PROMPT },
          { role: 'user', content: naturalLanguage }
        ], { model: resolved.id, temperature: 0.3, maxTokens: 2000 });
        return result.choices?.[0]?.message?.content || naturalLanguage;
      } catch {
        return naturalLanguage;
      }
    },
    onHookStart: (hookDef) => {
      console.log(`${PAD}${c.cyan}> Hook: ${hookDef.name}${c.reset}`);
    },
    onHookComplete: (hookDef, result) => {
      const preview = result.length > 80 ? result.slice(0, 77) + '...' : result;
      console.log(`${PAD}${c.green}+ Hook complete: ${hookDef.name}${c.reset} ${c.dim}${preview.split('\n')[0]}${c.reset}`);
    },
    onHookError: (hookDef, err) => {
      console.log(`${PAD}${c.red}x Hook failed: ${hookDef.name} - ${err.message || err}${c.reset}`);
    },
    onHookProgress: (hookDef, agentLabel, turn, maxTurns) => {
      console.log(`${PAD}  ${c.dim}Agent ${agentLabel} (turn ${turn}/${maxTurns})...${c.reset}`);
    }
  });
  const hookList = hookManager.listAll();
  if (hookList.length > 0) {
    const enabledCount = hookList.filter(h => h.enabled).length;
    console.log(`${PAD}${c.cyan}✓${c.reset} Hooks: ${enabledCount} active ${c.dim}(/hooks to manage)${c.reset}`);
  }

  console.log(`${PAD}${c.cyan}✓${c.reset} Mode: always agentic ${c.dim}(reads files on demand, streams final response)${c.reset}`);
}

function activeProviderKey() {
  return modelRegistry.getCurrentProvider() || 'local';
}

function currentModelLabel() {
  const model = modelRegistry.getCurrentModel();
  if (!model) return '?';
  return `${model.name} (${model.key})`;
}

async function getActiveClient() {
  const model = modelRegistry.getCurrentModel();
  if (!model) throw new Error('No active model selected');
  return await providerManager.getClientForModel(model);
}

async function syncLocalModelToLmStudio(activeModel) {
  if (!activeModel || (activeModel.provider || 'local') !== 'local' || !activeModel.id) return;
  try {
    const loaded = await lmStudio.getLoadedInstances();
    const activeLoaded = loaded.some(inst => (inst.key || inst.id || '').includes(activeModel.id));
    for (const inst of loaded) {
      const instId = inst.key || inst.id || '';
      if (!instId.includes(activeModel.id)) {
        try {
          await lmStudio.unloadModel(inst.instanceId);
          console.log(`${PAD}${c.dim}  Ejected ${inst.displayName || inst.key}${c.reset}`);
        } catch {}
      }
    }
    if (!activeLoaded) {
      const ctxLen = activeModel.contextLimit || 32768;
      console.log(`${PAD}${c.dim}  Loading ${activeModel.name} (ctx: ${(ctxLen / 1024).toFixed(0)}K)...${c.reset}`);
      const result = await lmStudio.loadModel(activeModel.id, { contextLength: ctxLen });
      console.log(`${PAD}${c.green}✓${c.reset} ${activeModel.name} loaded in ${result.load_time_seconds?.toFixed(1)}s`);
    }
  } catch (err) {
    console.log(`${PAD}${c.yellow}⚠ Model sync: ${err.message}${c.reset}`);
  }
}

async function checkConnection() {
  modelRegistry.refreshRemoteModels();
  const activeProvider = activeProviderKey();
  const activeModel = modelRegistry.getCurrentModel();

  const lmConnected = await lmStudio.isConnected();
  if (lmConnected) {
    console.log(`${PAD}${c.green}✓${c.reset} LM Studio: Connected (${lmStudio.baseUrl})`);
    const discovery = await modelRegistry.discover();
    if (discovery.matched > 0) {
      console.log(`${PAD}${c.green}✓${c.reset} Models: ${discovery.matched} matched from ${discovery.total} loaded`);
    }
    if (activeProvider === 'local') {
      await syncLocalModelToLmStudio(activeModel);
    }
  } else {
    const prefix = activeProvider === 'local' ? c.red : c.yellow;
    const mark = activeProvider === 'local' ? '✗' : '○';
    console.log(`${PAD}${prefix}${mark}${c.reset} LM Studio: Not connected (${lmStudio.baseUrl})`);
    if (activeProvider === 'local') {
      console.log(`${PAD}${c.dim}  Active model is local. Start LM Studio or switch to a connected remote model.${c.reset}\n`);
      return false;
    }
  }

  if (activeProvider !== 'local') {
    try {
      const client = await getActiveClient();
      const connected = await client.isConnected();
      const providerLabel = providerManager.getProviderLabel(activeProvider);
      if (!connected) {
        console.log(`${PAD}${c.red}✗${c.reset} ${providerLabel}: Connection failed for ${currentModelLabel()}`);
        return false;
      }
      console.log(`${PAD}${c.green}✓${c.reset} ${providerLabel}: Connected (${currentModelLabel()})`);
    } catch (err) {
      console.log(`${PAD}${c.red}✗${c.reset} ${err.message}`);
      return false;
    }
  }

  const mcpConnected = await mcpClient.isConnected();
  if (mcpConnected) {
    const status = mcpClient.getStatus();
    const serverLabel = status.serverName ? `${status.serverName}` : 'MCP server';
    console.log(`${PAD}${c.green}✓${c.reset} MCP: ${serverLabel} ${c.dim}(${status.url})${c.reset}`);
  } else {
    console.log(`${PAD}${c.yellow}○${c.reset} MCP: Not connected ${c.dim}(${mcpClient.url})${c.reset}`);
    console.log(`${PAD}${c.dim}  Tools like get_tasks, get_calendar will fail. Run /mcp to set up.${c.reset}`);
  }

  return true;
}

// =============================================================================
// @ MENTION HANDLING
// =============================================================================

function extractFileMentions(message) {
  const mentionRegex = /@([\w.\/\\*\-\[\]]+)/g;
  const mentions = [];
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    mentions.push(match[1]);
  }

  return mentions;
}

async function loadMentionedFiles(message) {
  const mentions = extractFileMentions(message);
  const loaded = [];

  for (const mention of mentions) {
    if (mention.includes('*')) {
      const { glob } = require('glob');
      try {
        const files = await glob(mention, { cwd: projectDir, nodir: true });
        for (const file of files.slice(0, 10)) {
          const result = contextBuilder.loadFile(file);
          if (result.success && !result.alreadyLoaded) {
            loaded.push(file);
            if (watcher.isEnabled()) watcher.addFile(file);
          }
        }
      } catch {
        // Invalid glob
      }
    } else {
      const result = contextBuilder.loadFile(mention);
      if (result.success && !result.alreadyLoaded) {
        loaded.push(mention);
        if (watcher.isEnabled()) watcher.addFile(mention);
      }
    }
  }

  return loaded;
}

// =============================================================================
// WORD WRAP HELPER FOR STREAMING OUTPUT
// =============================================================================

class StreamingWordWrapper {
  constructor(maxWidth = null, linePrefix = PAD) {
    this.linePrefix = linePrefix;
    const prefixLen = borderRenderer.stripAnsi(linePrefix).length;
    // Use terminal width minus prefix visual width and right padding
    this.maxWidth = maxWidth || Math.max((process.stdout.columns || 80) - prefixLen - PAD.length, 40);
    this.currentLineLength = 0;
    this.wordBuffer = '';
  }

  write(text) {
    let output = '';

    for (const char of text) {
      if (char === '\n') {
        // Flush word buffer and reset line, pad next line with border prefix
        output += this.wordBuffer + '\n' + this.linePrefix;
        this.wordBuffer = '';
        this.currentLineLength = borderRenderer.stripAnsi(this.linePrefix).length;
      } else if (char === ' ' || char === '\t') {
        // Word boundary - check if we need to wrap
        if (this.currentLineLength + this.wordBuffer.length + 1 > this.maxWidth && this.currentLineLength > 0) {
          // Wrap to new line with border prefix
          output += '\n' + this.linePrefix + this.wordBuffer + char;
          this.currentLineLength = borderRenderer.stripAnsi(this.linePrefix).length + this.wordBuffer.length + 1;
        } else {
          output += this.wordBuffer + char;
          this.currentLineLength += this.wordBuffer.length + 1;
        }
        this.wordBuffer = '';
      } else {
        // Building a word
        this.wordBuffer += char;
      }
    }

    return output;
  }

  flush() {
    // Return any remaining buffered word
    const remaining = this.wordBuffer;
    this.wordBuffer = '';
    return remaining;
  }
}

// =============================================================================
// SEARCH HELPER
// =============================================================================

async function searchInFiles(searchText) {
  const { glob } = require('glob');
  const results = [];

  const sourceFiles = await glob('**/*.{js,jsx,ts,tsx,vue,svelte,py,rb,go,rs,java,css,scss,html,json,md}', {
    cwd: projectDir,
    nodir: true,
    ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**']
  });

  const searchLower = searchText.toLowerCase();

  for (const file of sourceFiles) {
    try {
      const content = fs.readFileSync(path.join(projectDir, file), 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(searchLower)) {
          results.push({ file, line: idx + 1, text: line });
        }
      });

      if (results.length >= 100) return results;
    } catch {
      // Skip
    }
  }

  return results;
}

// =============================================================================
// CUSTOM COMMANDS (~/.ripley/Commands/)
// =============================================================================

const COMMANDS_DIR = path.join(require('os').homedir(), '.ripley', 'Commands');

/**
 * Load a custom command from ~/.ripley/Commands/<name>.md
 * Returns { name, content, source } or null if not found.
 */
function loadCustomCommand(cmd) {
  // Strip leading slash: /push -> push
  const name = cmd.replace(/^\//, '');
  const filePath = path.join(COMMANDS_DIR, `${name}.md`);

  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return { name, content, source: filePath };
  } catch {
    return null;
  }
}

/**
 * List all available custom commands from ~/.ripley/Commands/
 */
function listCustomCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) {
    console.log(`\n${PAD}${c.dim}No custom commands directory found at ${COMMANDS_DIR}${c.reset}\n`);
    return;
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.log(`\n${PAD}${c.dim}No custom commands found in ${COMMANDS_DIR}${c.reset}\n`);
    return;
  }

  console.log(`\n${PAD}${c.cyan}Custom Commands${c.reset} ${c.dim}(${COMMANDS_DIR})${c.reset}\n`);
  for (const file of files) {
    const name = file.replace('.md', '');
    // Read first non-empty, non-heading line as description
    const content = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const desc = lines[0] || '';
    console.log(`${PAD}${c.green}/${name}${c.reset}  ${c.dim}${desc.slice(0, 60)}${c.reset}`);
  }
  console.log();
}

function normalizeProviderKey(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  if (key === 'lmstudio' || key === 'local') return 'local';
  if (PROVIDERS.includes(key)) return key;
  return null;
}

function modelDisplayParts(model) {
  if (!model) return { provider: 'local', providerLabel: 'LM Studio', label: '?' };
  const provider = model.provider || 'local';
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  return {
    provider,
    providerLabel,
    label: `${model.name} (${model.key})`
  };
}

function resolveActivePromptMode() {
  if (!promptManager) return activePrompt || 'base';

  if (interactionMode === 'plan' && promptManager.has('plan')) {
    return 'plan';
  }

  const modelPrompt = modelRegistry ? modelRegistry.getPrompt() : null;
  if (modelPrompt && promptManager.has(modelPrompt)) {
    return modelPrompt;
  }

  if (promptManager.has('code-agent')) {
    return 'code-agent';
  }

  if (promptManager.has(activePrompt)) {
    return activePrompt;
  }

  return 'base';
}

function buildFullSystemPrompt(promptMode = resolveActivePromptMode()) {
  const systemPrompt = promptManager ? promptManager.get(promptMode) : '';
  const instructions = config ? config.getInstructions() : null;
  let fullSystemPrompt = systemPrompt || '';
  if (instructions) {
    fullSystemPrompt += `\n\n## Project Instructions (from ${instructions.source})\n\n${instructions.content}`;
  }
  return fullSystemPrompt;
}

function estimateTokensForValue(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  if (tokenCounter) return tokenCounter.estimateTokens(text);
  return Math.ceil(text.length / 4);
}

function estimatePromptTokensForMessages(messages, options = {}) {
  const reserveTokens = Math.max(0, Number(options.reserveTokens) || 0);
  const toolSchema = options.toolSchema || null;
  const payload = Array.isArray(messages) ? messages : [];
  let total = estimateTokensForValue(payload);
  if (toolSchema) {
    total += estimateTokensForValue(toolSchema);
  }
  total += reserveTokens;
  return Math.max(0, Math.floor(total));
}

function contextPercentForTokens(tokens, contextLimit = modelRegistry?.getContextLimit?.() || 0) {
  const limit = Number(contextLimit) || 0;
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, Number(tokens) || 0) / limit) * 100));
}

function setContextEstimate(tokens, options = {}) {
  const normalized = Math.max(0, Math.floor(Number(tokens) || 0));
  projectedContextTokens = normalized;
  if (options.persistActual) {
    lastKnownTokens = normalized;
  }

  if (statusBar && modelRegistry) {
    const limit = modelRegistry.getContextLimit();
    statusBar.update({
      contextTokens: normalized,
      contextPct: contextPercentForTokens(normalized, limit),
      contextLimit: limit
    });
  }
}

function estimateNextTurnContextTokens() {
  if (!modelRegistry || !promptManager) return Math.max(projectedContextTokens, lastKnownTokens);

  const promptMode = resolveActivePromptMode();
  const fullSystemPrompt = buildFullSystemPrompt(promptMode);
  const messages = [];
  if (fullSystemPrompt) {
    messages.push({ role: 'system', content: fullSystemPrompt });
  }
  messages.push(...conversationHistory);

  const toolSchema = interactionMode === 'plan' ? READ_ONLY_TOOLS : TOOLS;
  return estimatePromptTokensForMessages(messages, {
    toolSchema,
    reserveTokens: NEXT_TURN_RESERVE_TOKENS
  });
}

function refreshIdleContextEstimate() {
  const estimated = estimateNextTurnContextTokens();
  if (estimated > 0) {
    setContextEstimate(estimated);
  }
}

function tokenizeSearchQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseRemoteContextLimit(model) {
  const candidates = [
    model?.contextLength,
    model?.context_length,
    model?.maxContextTokens,
    model?.max_context_tokens
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return 200000;
}

function buildAliasFromModelId(modelId, existingAliases = []) {
  const existing = new Set(existingAliases.map(a => String(a || '').toLowerCase()));
  let base = String(modelId || '').trim().toLowerCase();
  if (base.includes('/')) {
    const parts = base.split('/');
    base = parts[parts.length - 1] || base;
  }
  base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'model';
  if (base.length > 48) base = base.slice(0, 48).replace(/-+$/g, '');

  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

async function searchOpenRouterModels(query, options = {}) {
  const limit = options.limit || 80;
  const client = await providerManager.getClientForProvider('openrouter');
  const listed = await client.listModels();
  if (!Array.isArray(listed) || listed.length === 0) return [];

  const rawQuery = String(query || '').trim().toLowerCase();
  const tokens = tokenizeSearchQuery(rawQuery);

  const ranked = [];
  for (const model of listed) {
    const id = String(model?.id || '').trim();
    if (!id) continue;
    const name = String(model?.name || '').trim();
    const description = String(model?.description || '').trim();
    const haystack = `${id} ${name} ${description}`.toLowerCase();

    if (tokens.length > 0 && !tokens.every(token => haystack.includes(token))) {
      continue;
    }

    let score = 0;
    if (rawQuery) {
      const idLower = id.toLowerCase();
      const nameLower = name.toLowerCase();
      if (idLower === rawQuery) score += 300;
      else if (idLower.startsWith(rawQuery)) score += 180;
      else if (idLower.includes(rawQuery)) score += 110;
      if (nameLower === rawQuery) score += 200;
      else if (nameLower.startsWith(rawQuery)) score += 120;
      else if (nameLower.includes(rawQuery)) score += 80;
      score += Math.max(0, 40 - Math.min(40, id.length));
    }

    ranked.push({
      id,
      name: name || id,
      contextLimit: parseRemoteContextLimit(model),
      score
    });
  }

  ranked.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return ranked.slice(0, limit);
}

function openUrlInBrowser(url) {
  try {
    const { exec } = require('child_process');
    const escaped = url.replace(/"/g, '\\"');
    if (process.platform === 'win32') {
      exec(`start "" "${escaped}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${escaped}"`);
    } else {
      exec(`xdg-open "${escaped}"`);
    }
    return true;
  } catch {
    return false;
  }
}

function steeringEnabled() {
  return !config || config.get('steeringEnabled') !== false;
}

function normalizeSteeringText(value) {
  const text = String(value || '').trim();
  return text;
}

function queueSteeringMessage(text) {
  const normalized = normalizeSteeringText(text);
  if (!normalized) return false;
  queuedSteeringMessages.push(normalized);
  return true;
}

function clearSteeringMessages() {
  queuedSteeringMessages = [];
}

function appendQueuedSteeringMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  if (!steeringEnabled() || queuedSteeringMessages.length === 0) return 0;

  for (const steeringText of queuedSteeringMessages) {
    messages.push({
      role: 'user',
      content: `## Steering Message\n\nAdditional guidance for this turn:\n\n${steeringText}`
    });
  }
  return queuedSteeringMessages.length;
}

function requestMidTurnSteer(text) {
  const normalized = normalizeSteeringText(text);
  if (!normalized) return false;
  if (!currentAbortController) return false;

  queueSteeringMessage(normalized);
  midTurnSteerRequested = true;
  currentAbortController.abort();
  return true;
}

async function switchModel(modelKey, options = {}) {
  const silent = options.silent === true;
  const oldModel = modelRegistry.getCurrentModel();

  modelRegistry.setCurrent(modelKey);
  config.set('activeModel', modelKey);
  lastKnownTokens = 0;
  projectedContextTokens = 0;
  const switched = modelRegistry.getCurrentModel();
  const parts = modelDisplayParts(switched);

  if (!silent) {
    console.log(`${PAD}${c.green}✓ Model: ${switched.name}${c.reset} ${c.dim}(${switched.key}, ${parts.providerLabel})${c.reset}`);
  }

  if (statusBar) {
    statusBar.update({
      modelName: `${parts.providerLabel}: ${switched.name || switched.key}`,
      modelId: switched.id || '',
      contextLimit: switched.contextLimit || modelRegistry.getContextLimit()
    });
  }
  refreshIdleContextEstimate();

  const autoPrompt = modelRegistry.getPrompt();
  if (promptManager.has(autoPrompt) && !silent) {
    console.log(`${PAD}${c.dim}Prompt: ${autoPrompt}${c.reset}`);
  }

  const provider = switched.provider || 'local';
  if (provider === 'local') {
    if (switched.id && (!oldModel || switched.id !== oldModel.id || (oldModel.provider || 'local') !== 'local')) {
      try {
        const loaded = await lmStudio.getLoadedInstances();
        for (const inst of loaded) {
          try {
            await lmStudio.unloadModel(inst.instanceId);
            if (!silent) console.log(`${PAD}${c.dim}Unloaded ${inst.displayName || inst.key}${c.reset}`);
          } catch (err) {
            // 404 = model already ejected by LM Studio (normal during swap)
            if (!silent && !err.message.includes('404')) {
              console.log(`${PAD}${c.yellow}⚠ Could not unload ${inst.key}: ${err.message}${c.reset}`);
            }
          }
        }
        const ctxLen = switched.contextLimit || 32768;
        if (!silent) console.log(`${PAD}${c.dim}Loading ${switched.name} in LM Studio (ctx: ${(ctxLen / 1024).toFixed(0)}K)...${c.reset}`);
        const result = await lmStudio.loadModel(switched.id, { contextLength: ctxLen });
        if (!silent) console.log(`${PAD}${c.green}✓ Loaded in ${result.load_time_seconds?.toFixed(1)}s${c.reset}`);
      } catch (err) {
        if (!silent) {
          console.log(`${PAD}${c.yellow}⚠ Could not auto-load: ${err.message}${c.reset}`);
          console.log(`${PAD}${c.dim}Load it manually in LM Studio${c.reset}`);
        }
      }
    }
    if (switched.tags?.includes('vision') && !silent) {
      console.log(`${PAD}${c.green}✓ Vision enabled (local)${c.reset}`);
    }
  } else {
    try {
      const client = await providerManager.getClientForModel(switched);
      const ok = await client.isConnected({ throwOnError: true });
      if (!ok) throw new Error(`${parts.providerLabel} rejected the connection`);
      if (!silent) console.log(`${PAD}${c.green}✓ Connected via ${parts.providerLabel}${c.reset}`);
    } catch (err) {
      throw new Error(`Could not connect to ${parts.providerLabel}: ${err.message}`);
    }
  }

  if (switched.tags?.includes('max-quality') && !silent) {
    console.log(`${PAD}${c.yellow}⚠ This model may be slow (spills to CPU)${c.reset}`);
  }

  if (!silent) console.log();
}

function listProviderStatus() {
  const activeProvider = activeProviderKey();
  const activeModel = modelRegistry.getCurrentModel();
  const connected = providerStore.listProviders();

  console.log(`\n${PAD}${c.cyan}Provider Connections:${c.reset}`);
  console.log(`${PAD}${c.dim}  Active model: ${activeModel ? `${activeModel.name} (${activeModel.key})` : '?'}${c.reset}`);

  console.log(`${PAD}${c.dim}  local (LM Studio): always available if LM Studio is running${c.reset}`);
  for (const record of connected) {
    const dot = record.connected ? `${c.green}●${c.reset}` : `${c.red}●${c.reset}`;
    const marker = activeProvider === record.provider ? `${c.cyan}*${c.reset}` : ' ';
    const modelCount = Object.keys(record.models || {}).length;
    console.log(`${PAD}${marker} ${record.provider}: ${dot} ${record.connected ? 'connected' : 'not connected'} ${c.dim}(${modelCount} aliases)${c.reset}`);
  }
  console.log();
}

async function connectProviderInteractive(provider) {
  if (!provider) {
    const providerItems = PROVIDERS.map(p => ({
      key: p,
      label: PROVIDER_LABELS[p] || p,
      description: p === 'openai'
        ? 'OAuth device login for Codex subscription'
        : 'Connect with API key',
      tags: ['provider'],
      active: providerStore.isConnected(p)
    }));
    const selected = await pick(providerItems, { title: 'Connect Provider' });
    if (!selected) {
      console.log(`${PAD}${c.dim}Cancelled${c.reset}\n`);
      return;
    }
    provider = selected.key;
  }
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  if (provider === 'anthropic' || provider === 'openrouter') {
    const label = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
    console.log(`\n${PAD}${c.cyan}${providerLabel} Connection${c.reset}`);
    const apiKey = await askQuestion(`${PAD}${c.yellow}Paste ${label}: ${c.reset}`);
    if (!apiKey || !apiKey.trim()) {
      console.log(`${PAD}${c.yellow}Cancelled (empty key).${c.reset}\n`);
      return;
    }
    providerStore.connectWithApiKey(provider, apiKey.trim());
    modelRegistry.refreshRemoteModels();
    console.log(`${PAD}${c.green}✓ Connected ${providerLabel}${c.reset}`);
    console.log(`${PAD}${c.dim}Use /model to switch to ${providerLabel} models.${c.reset}\n`);
    return;
  }

  if (provider === 'openai') {
    console.log(`\n${PAD}${c.cyan}OpenAI OAuth (Codex subscription)${c.reset}`);
    const device = await providerManager.beginOpenAIDeviceLogin();
    console.log(`${PAD}${c.dim}1) Open:${c.reset} ${c.cyan}${device.verificationUrl}${c.reset}`);
    console.log(`${PAD}${c.dim}2) Enter code:${c.reset} ${c.yellow}${device.userCode}${c.reset}`);
    const opened = openUrlInBrowser(device.verificationUrl);
    if (opened) {
      console.log(`${PAD}${c.dim}Opened browser automatically.${c.reset}`);
    }
    console.log(`${PAD}${c.dim}Waiting for authorization (up to 15 minutes)...${c.reset}`);
    await providerManager.completeOpenAIDeviceLogin(device);
    modelRegistry.refreshRemoteModels();
    console.log(`${PAD}${c.green}✓ Connected OpenAI via OAuth${c.reset}`);
    console.log(`${PAD}${c.dim}Use /model to switch to OpenAI Codex models.${c.reset}\n`);
    return;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// =============================================================================
// COMMANDS
// =============================================================================

async function handleCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  switch (cmd) {
    case '/help':
    case '/?':
      showHelp();
      return true;

    case '/update': {
      console.log(`\n${PAD}${c.cyan}Checking for updates...${c.reset}`);
      const { execSync } = require('child_process');
      try {
        const result = execSync('npm install -g mrchevyceleb/ripley-code', {
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        console.log(`${PAD}${c.green}✓ Updated! Restart Ripley to use the new version.${c.reset}\n`);
      } catch (err) {
        console.log(`${PAD}${c.red}✗ Update failed: ${err.message}${c.reset}\n`);
      }
      return true;
    }

    case '/version':
    case '/v':
      console.log(`\n${PAD}${c.cyan}Ripley Code v${VERSION}${c.reset}\n`);
      return true;

    case '/files':
    case '/ls':
      const files = contextBuilder.getLoadedFiles();
      if (files.length === 0) {
        console.log(`\n${PAD}${c.dim}No files in context${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.cyan}Files in context (${files.length}):${c.reset}`);
        files.forEach(f => console.log(`${PAD}${c.dim}  • ${f}${c.reset}`));
        console.log();
      }
      return true;

    case '/read':
    case '/add':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /read <filepath>${c.reset}\n`);
        return true;
      }
      if (args.includes('*')) {
        const { glob } = require('glob');
        try {
          const matches = await glob(args, { cwd: projectDir, nodir: true });
          if (matches.length === 0) {
            console.log(`\n${PAD}${c.yellow}No files matched: ${args}${c.reset}\n`);
          } else {
            let count = 0;
            for (const file of matches.slice(0, 20)) {
              const result = contextBuilder.loadFile(file);
              if (result.success && !result.alreadyLoaded) {
                count++;
                if (watcher.isEnabled()) watcher.addFile(file);
              }
            }
            console.log(`\n${PAD}${c.green}  ✓ Added ${count} files to context${c.reset}\n`);
          }
        } catch (error) {
          console.log(`\n${PAD}${c.red}✗ Invalid pattern: ${error.message}${c.reset}\n`);
        }
      } else {
        const readResult = contextBuilder.loadFile(args);
        if (readResult.success) {
          if (readResult.alreadyLoaded) {
            console.log(`\n${PAD}${c.yellow}File already in context: ${args}${c.reset}\n`);
          } else {
            console.log(`\n${PAD}${c.green}  ✓ Added to context: ${args}${c.reset}\n`);
            if (watcher.isEnabled()) watcher.addFile(args);
          }
        } else {
          console.log(`\n${PAD}${c.red}✗ ${readResult.error}${c.reset}\n`);
        }
      }
      return true;

    case '/unread':
    case '/remove':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /unread <filepath>${c.reset}\n`);
        return true;
      }
      const unreadResult = contextBuilder.unloadFile(args);
      if (unreadResult.success) {
        console.log(`\n${PAD}${c.green}  ✓ Removed from context: ${args}${c.reset}\n`);
        watcher.removeFile(args);
      } else {
        console.log(`\n${PAD}${c.red}✗ ${unreadResult.error}${c.reset}\n`);
      }
      return true;

    case '/tree':
      const structure = contextBuilder.scanDirectory();
      const tree = contextBuilder.buildTreeString(structure);
      console.log(`\n${PAD}${c.cyan}Project Structure:${c.reset}\n`);
      console.log(tree);
      return true;

    case '/find':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /find <pattern>${c.reset}\n`);
        return true;
      }
      try {
        const { glob } = require('glob');
        const matches = await glob(args, { cwd: projectDir, nodir: true, ignore: ['node_modules/**', '.git/**'] });
        if (matches.length === 0) {
          console.log(`\n${PAD}${c.dim}No files found matching: ${args}${c.reset}\n`);
        } else {
          console.log(`\n${PAD}${c.cyan}Files matching "${args}" (${matches.length}):${c.reset}`);
          matches.slice(0, 30).forEach(f => console.log(`${PAD}${c.dim}  ${f}${c.reset}`));
          if (matches.length > 30) console.log(`${PAD}${c.dim}  ... and ${matches.length - 30} more${c.reset}`);
          console.log();
        }
      } catch (error) {
        console.log(`\n${PAD}${c.red}✗ ${error.message}${c.reset}\n`);
      }
      return true;

    case '/grep':
    case '/search':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /grep <text>${c.reset}\n`);
        return true;
      }
      console.log(`\n${PAD}${c.dim}Searching for "${args}"...${c.reset}`);
      try {
        const results = await searchInFiles(args);
        if (results.length === 0) {
          console.log(`${PAD}${c.dim}No matches found${c.reset}\n`);
        } else {
          console.log(`\n${PAD}${c.cyan}Found ${results.length} matches:${c.reset}`);
          results.slice(0, 20).forEach(r => {
            console.log(`${PAD}${c.green}  ${r.file}${c.reset}:${c.yellow}${r.line}${c.reset}`);
            console.log(`${PAD}${c.dim}  ${r.text.trim().substring(0, 80)}${c.reset}`);
          });
          if (results.length > 20) console.log(`${PAD}${c.dim}... and ${results.length - 20} more${c.reset}`);
          console.log();
        }
      } catch (error) {
        console.log(`${PAD}${c.red}✗ ${error.message}${c.reset}\n`);
      }
      return true;

    case '/image':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /image <path>${c.reset}`);
        console.log(`${PAD}${c.dim}Add an image to the next message (for vision models)${c.reset}\n`);
        return true;
      }
      const imgResult = imageHandler.addImage(args);
      if (imgResult.success) {
        console.log(`\n${PAD}${c.green}  ✓ Image queued: ${args}${c.reset}`);
        console.log(`${PAD}${c.dim}Will be included in your next message${c.reset}`);
        if (!modelRegistry.currentSupportsVision() && !visionAnalyzer.isEnabled()) {
          showGeminiKeyPrompt();
          return true;
        }
        console.log();
      } else {
        console.log(`\n${PAD}${c.red}✗ ${imgResult.error}${c.reset}\n`);
      }
      return true;

    case '/git':
    case '/status':
      try {
        const result = await commandRunner.git('status --short');
        if (result.success) {
          if (result.stdout) {
            console.log(`\n${PAD}${c.cyan}Git Status:${c.reset}`);
            console.log(result.stdout.split('\n').map(l => PAD + l).join('\n'));
            console.log();
          } else {
            console.log(`\n${PAD}${c.green}  ✓ Working tree clean${c.reset}\n`);
          }
        } else {
          console.log(`\n${PAD}${c.dim}Not a git repository${c.reset}\n`);
        }
      } catch {
        console.log(`\n${PAD}${c.dim}Git not available${c.reset}\n`);
      }
      return true;

    case '/diff':
      try {
        const result = await commandRunner.git('diff --stat');
        if (result.success && result.stdout) {
          console.log(`\n${PAD}${c.cyan}Uncommitted Changes:${c.reset}`);
          console.log(result.stdout.split('\n').map(l => PAD + l).join('\n'));
          console.log();
        } else {
          console.log(`\n${PAD}${c.dim}No uncommitted changes${c.reset}\n`);
        }
      } catch {
        console.log(`\n${PAD}${c.dim}Git not available${c.reset}\n`);
      }
      return true;

    case '/log':
      try {
        const result = await commandRunner.git('log --oneline -10');
        if (result.success && result.stdout) {
          console.log(`\n${PAD}${c.cyan}Recent Commits:${c.reset}`);
          console.log(result.stdout.split('\n').map(l => PAD + l).join('\n'));
          console.log();
        } else {
          console.log(`\n${PAD}${c.dim}No commits yet${c.reset}\n`);
        }
      } catch {
        console.log(`\n${PAD}${c.dim}Git not available${c.reset}\n`);
      }
      return true;

    case '/clear':
      conversationHistory = [];
      lastKnownTokens = 0;
      contextBuilder.clearFiles();
      contextBuilder.loadPriorityFiles();
      tokenCounter.resetSession();
      imageHandler.clearPending();
      setContextEstimate(0);
      if (statusBar) {
        statusBar.update({ sessionIn: 0, sessionOut: 0 });
        statusBar.reinstall();
      }
      console.clear();
      refreshIdleContextEstimate();
      if (rl) {
        rl.setPrompt(buildPromptPrefix());
        rl.prompt(false);
      }
      console.log(`\n${PAD}${c.green}  ✓ Cleared conversation and reset context${c.reset}\n`);
      return true;

    case '/clearhistory':
      conversationHistory = [];
      lastKnownTokens = 0;
      tokenCounter.resetSession();
      setContextEstimate(0);
      refreshIdleContextEstimate();
      if (rl) {
        rl.setPrompt(buildPromptPrefix());
        rl.prompt(false);
      }
      console.log(`\n${PAD}${c.green}  ✓ Cleared conversation history${c.reset}\n`);
      return true;

    case '/save':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /save <session-name>${c.reset}\n`);
        return true;
      }
      const savedFile = config.saveConversation(args, conversationHistory);
      console.log(`\n${PAD}${c.green}  ✓ Saved session: ${savedFile}${c.reset}\n`);
      return true;

    case '/load':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /load <session-file>${c.reset}\n`);
        return true;
      }
      const loadedHistory = config.loadConversation(args);
      if (loadedHistory) {
        conversationHistory = loadedHistory;
        console.log(`\n${PAD}${c.green}  ✓ Loaded ${loadedHistory.length} messages${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.red}✗ Session not found: ${args}${c.reset}\n`);
      }
      return true;

    case '/sessions':
      const sessions = config.listConversations();
      if (sessions.length === 0) {
        console.log(`\n${PAD}${c.dim}No saved sessions${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.cyan}Saved Sessions:${c.reset}`);
        sessions.slice(0, 10).forEach(s => {
          const date = new Date(s.savedAt).toLocaleDateString();
          console.log(`${PAD}${c.dim}  • ${s.filename} (${s.messageCount} messages, ${date})${c.reset}`);
        });
        console.log();
      }
      return true;

    case '/context':
      const ctx = contextBuilder.buildContext();
      const charCount = ctx.length;
      const tokenEstimate = tokenCounter.estimateTokens(ctx);
      const loadedFiles = contextBuilder.getLoadedFiles();
      const limit = tokenCounter.checkLimit(tokenEstimate);

      console.log(`\n${PAD}${c.cyan}Context Summary:${c.reset}`);
      console.log(`${PAD}${c.dim}  Files loaded: ${loadedFiles.length}${c.reset}`);
      console.log(`${PAD}${c.dim}  Characters: ${charCount.toLocaleString()}${c.reset}`);
      console.log(`${PAD}${c.dim}  Est. tokens: ~${tokenEstimate.toLocaleString()}${c.reset}`);
      if (limit.isWarning) {
        console.log(`${PAD}${c.yellow}  ⚠ ${Math.round(limit.percentage * 100)}% of token limit${c.reset}`);
      }
      console.log(`${PAD}${c.dim}  Compact mode: ${config.get('compactMode') ? 'ON' : 'OFF'}${c.reset}`);
      console.log(`${PAD}${c.dim}  Steering: ${steeringEnabled() ? 'ON' : 'OFF'} (${queuedSteeringMessages.length} pending)${c.reset}`);
      console.log(`${PAD}${c.dim}  Streaming: ${config.get('streamingEnabled') ? 'ON' : 'OFF'}${c.reset}`);
      console.log(`${PAD}${c.dim}  Watch mode: ${watcher.isEnabled() ? 'ON' : 'OFF'}${c.reset}`);
      const ctxWindowLimit = modelRegistry.getContextLimit();
      const ctxWindowUsed = projectedContextTokens > 0
        ? projectedContextTokens
        : estimateNextTurnContextTokens();
      const ctxWindowPct = contextPercentForTokens(ctxWindowUsed, ctxWindowLimit);
      console.log(`${PAD}${c.dim}  ────────────────────────────${c.reset}`);
      console.log(`${PAD}${c.dim}  Context window: ~${ctxWindowUsed.toLocaleString()} / ${ctxWindowLimit.toLocaleString()} tokens (${ctxWindowPct}%)${c.reset}`);
      if (ctxWindowPct >= 80) {
        console.log(`${PAD}${c.yellow}  ⚠ Context window is ${ctxWindowPct}% full${c.reset}`);
      }
      console.log();
      return true;

    case '/tokens':
      const usage = tokenCounter.getSessionUsage();
      console.log(`\n${PAD}${c.cyan}Token Usage This Session:${c.reset}`);
      console.log(`${PAD}${c.dim}  Input:  ${tokenCounter.formatCount(usage.input)}${c.reset}`);
      console.log(`${PAD}${c.dim}  Output: ${tokenCounter.formatCount(usage.output)}${c.reset}`);
      console.log(`${PAD}${c.dim}  Total:  ${tokenCounter.formatCount(usage.total)}${c.reset}`);
      console.log();
      return true;

    case '/think': {
      if (!modelRegistry.currentSupportsThinking()) {
        console.log(`\n${PAD}${c.yellow}⚠ Current model (${modelRegistry.getCurrent()}) doesn't support thinking mode.${c.reset}`);
        console.log(`${PAD}${c.dim}Switch to a model with reasoning support via /model.${c.reset}\n`);
        return true;
      }
      const requested = args.trim().toLowerCase();
      if (requested && THINKING_LEVELS.includes(requested)) {
        thinkingLevel = requested;
      } else if (requested) {
        console.log(`\n${PAD}${c.yellow}⚠ Invalid level "${requested}". Use: ${THINKING_LEVELS.join(', ')}${c.reset}\n`);
        return true;
      } else {
        const idx = THINKING_LEVELS.indexOf(thinkingLevel);
        thinkingLevel = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
      }
      if (thinkingLevel === 'off') {
        console.log(`\n${PAD}${c.green}  ✓ Thinking: ${c.dim}OFF${c.reset}`);
      } else {
        const budget = getThinkingBudget();
        console.log(`\n${PAD}${c.green}  ✓ Thinking: ${c.cyan}🧠 ${thinkingLevel.toUpperCase()}${c.reset} ${c.dim}(${budget} budget tokens)${c.reset}`);
        console.log(`${PAD}${c.dim}Model will reason before responding. Slower but smarter.${c.reset}`);
      }
      console.log();
      return true;
    }

    case '/steer':
    case '/steering': {
      const steerInput = args.trim();

      if (!steerInput || steerInput === 'status') {
        console.log(`\n${PAD}${c.cyan}Steering${c.reset}`);
        console.log(`${PAD}${c.dim}  Enabled: ${steeringEnabled() ? 'ON' : 'OFF'}${c.reset}`);
        console.log(`${PAD}${c.dim}  Pending messages: ${queuedSteeringMessages.length}${c.reset}`);
        if (queuedSteeringMessages.length > 0) {
          queuedSteeringMessages.forEach((msg, idx) => {
            console.log(`${PAD}${c.dim}  ${idx + 1}. ${msg}${c.reset}`);
          });
        }
        console.log(`${PAD}${c.dim}Usage: /steer <text> | /steer show | /steer clear | /steer on | /steer off${c.reset}\n`);
        return true;
      }

      const lowerSteer = steerInput.toLowerCase();
      if (currentAbortController && !['status', 'show', 'list', 'clear', 'on', 'enable', 'off', 'disable'].includes(lowerSteer)) {
        if (requestMidTurnSteer(steerInput)) {
          console.log(`\n${PAD}${c.cyan}Steering received. Redirecting current turn...${c.reset}\n`);
        } else {
          console.log(`\n${PAD}${c.yellow}Could not apply mid-turn steering.${c.reset}\n`);
        }
        return true;
      }

      if (lowerSteer === 'show' || lowerSteer === 'list') {
        if (queuedSteeringMessages.length === 0) {
          console.log(`\n${PAD}${c.dim}No queued steering messages.${c.reset}\n`);
          return true;
        }
        console.log(`\n${PAD}${c.cyan}Queued Steering Messages:${c.reset}`);
        queuedSteeringMessages.forEach((msg, idx) => {
          console.log(`${PAD}${c.dim}  ${idx + 1}. ${msg}${c.reset}`);
        });
        console.log();
        return true;
      }

      if (lowerSteer === 'clear') {
        clearSteeringMessages();
        console.log(`\n${PAD}${c.green}  OK Cleared queued steering messages${c.reset}\n`);
        return true;
      }

      if (lowerSteer === 'on' || lowerSteer === 'enable') {
        config.set('steeringEnabled', true);
        console.log(`\n${PAD}${c.green}  OK Steering: ON${c.reset}\n`);
        return true;
      }

      if (lowerSteer === 'off' || lowerSteer === 'disable') {
        config.set('steeringEnabled', false);
        console.log(`\n${PAD}${c.green}  OK Steering: OFF${c.reset}\n`);
        return true;
      }

      if (queueSteeringMessage(steerInput)) {
        if (!steeringEnabled()) {
          console.log(`\n${PAD}${c.yellow}Warning: Steering is currently OFF. Enable with /steer on.${c.reset}`);
        }
        console.log(`${PAD}${c.green}  OK Queued steering message (${queuedSteeringMessages.length} pending)${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.yellow}Usage: /steer <text>${c.reset}\n`);
      }
      return true;
    }

    case '/ctx':
      if (activeProviderKey() !== 'local') {
        console.log(`\n${PAD}${c.yellow}/ctx is only available for local LM Studio models.${c.reset}\n`);
        return true;
      }
      if (!args) {
        const currentCtx = modelRegistry.getContextLimit();
        console.log(`\n${PAD}${c.cyan}Context: ${(currentCtx / 1024).toFixed(0)}K${c.reset} ${c.dim}(${currentCtx.toLocaleString()} tokens)${c.reset}`);
        console.log(`${PAD}${c.dim}Usage: /ctx 16k | /ctx 32k | /ctx 64k | /ctx 131072${c.reset}\n`);
        return true;
      }
      // Parse context size: "16k", "32K", "65536", etc.
      let newCtx;
      const ctxMatch = args.trim().match(/^(\d+)\s*[kK]$/);
      if (ctxMatch) {
        newCtx = parseInt(ctxMatch[1]) * 1024;
      } else {
        newCtx = parseInt(args.trim());
      }
      if (!newCtx || isNaN(newCtx) || newCtx < 1024) {
        console.log(`\n${PAD}${c.red}Invalid context size. Use: /ctx 16k, /ctx 32k, /ctx 131072${c.reset}\n`);
        return true;
      }
      try {
        const currentModelData = modelRegistry.getCurrentModel();
        if (!currentModelData?.id) {
          console.log(`\n${PAD}${c.red}No model loaded.${c.reset}\n`);
          return true;
        }
        // Unload current model
        console.log(`${PAD}${c.dim}Reloading ${currentModelData.name} with ${(newCtx / 1024).toFixed(0)}K context...${c.reset}`);
        const loadedInstances = await lmStudio.getLoadedInstances();
        for (const inst of loadedInstances) {
          try { await lmStudio.unloadModel(inst.instanceId); } catch {}
        }
        // Reload with new context
        const ctxResult = await lmStudio.loadModel(currentModelData.id, { contextLength: newCtx });
        console.log(`${PAD}${c.green}✓ Reloaded with ${(newCtx / 1024).toFixed(0)}K context${c.reset} ${c.dim}(${ctxResult.load_time_seconds?.toFixed(1)}s)${c.reset}\n`);
        if (statusBar) statusBar.update({ contextLimit: newCtx });
      } catch (err) {
        console.log(`\n${PAD}${c.red}Failed: ${err.message}${c.reset}`);
        console.log(`${PAD}${c.dim}Try loading manually in LM Studio with reduced context${c.reset}\n`);
      }
      return true;

    case '/compact':
      if (conversationHistory.length < 4) {
        console.log(`\n${PAD}${c.yellow}Not enough conversation to compact${c.reset}\n`);
      } else {
        await compactHistory();
      }
      // Also enable auto-compact mode
      if (!config.get('compactMode')) {
        config.set('compactMode', true);
      }
      return true;

    case '/stream':
      const newStream = !config.get('streamingEnabled');
      config.set('streamingEnabled', newStream);
      console.log(`\n${PAD}${c.green}  ✓ Streaming: ${newStream ? 'ON' : 'OFF'}${c.reset}\n`);
      return true;

    case '/watch':
      if (watcher.isEnabled()) {
        watcher.stop();
        console.log(`\n${PAD}${c.green}  ✓ Watch mode: OFF${c.reset}\n`);
      } else {
        watcher.start();
        console.log(`\n${PAD}${c.green}  ✓ Watch mode: ON${c.reset}`);
        console.log(`${PAD}${c.dim}  Watching ${watcher.getWatchedFiles().length} files${c.reset}\n`);
      }
      return true;

    case '/yolo':
      const newYolo = !config.get('yoloMode');
      config.set('yoloMode', newYolo);
      if (newYolo) {
        console.log(`\n${c.orange}  🔥 YOLO MODE: ON${c.reset}`);
        console.log(`${PAD}${c.dim}  File changes and commands will be applied automatically without confirmation.${c.reset}`);
        console.log(`${PAD}${c.dim}  Dangerous commands still require typing 'yes'.${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.green}  ✓ YOLO mode: OFF${c.reset}`);
        console.log(`${PAD}${c.dim}  Back to normal confirmation prompts.${c.reset}\n`);
      }
      return true;

    case '/agent':
      await handleAgentCommand(args);
      return true;

    case '/hooks':
      await handleHooksCommand(args);
      return true;

    case '/work':
    case '/code':
      interactionMode = 'work';
      if (statusBar) statusBar.update({ mode: 'work' });
      console.log(`\n${PAD}${c.green}  ✓ Switched to WORK mode${c.reset}`);
      console.log(`${PAD}${c.dim}  File operations and commands will be executed normally.${c.reset}\n`);
      return true;

    case '/plan':
      if (interactionMode === 'plan') {
        interactionMode = 'work';
        if (statusBar) statusBar.update({ mode: 'work' });
        console.log(`\n${PAD}${c.green}  ✓ Switched to WORK mode${c.reset}`);
        console.log(`${PAD}${c.dim}  File operations and commands will be executed normally.${c.reset}\n`);
      } else {
        interactionMode = 'plan';
        if (statusBar) statusBar.update({ mode: 'plan' });
        console.log(`\n${PAD}${c.cyan}📋 PLAN MODE: ON${c.reset}`);
        console.log(`${PAD}${c.dim}  AI explores the codebase and builds a structured plan.${c.reset}`);
        console.log(`${PAD}${c.dim}  After the plan, choose: implement, reject, or refine.${c.reset}\n`);
      }
      return true;

    case '/implement':
      const planPath = path.join(projectDir, '.ripley', 'plan.md');
      if (!fs.existsSync(planPath)) {
        console.log(`\n${PAD}${c.yellow}No plan found. Use /plan mode first to create one.${c.reset}\n`);
        return true;
      }
      const planContent = fs.readFileSync(planPath, 'utf-8');
      console.log(`\n${PAD}${c.cyan}📋 Plan to implement:${c.reset}\n`);
      console.log(planContent.split('\n').map(l => PAD + l).join('\n'));
      console.log();

      const confirmImpl = await askQuestion(`${c.yellow}Implement this plan? (y/n): ${c.reset}`);
      if (confirmImpl.toLowerCase() === 'y' || confirmImpl.toLowerCase() === 'yes') {
        // Switch to code mode and send the plan for implementation
        const prevMode = interactionMode;
        interactionMode = 'work';
        if (statusBar) statusBar.update({ mode: 'work' });
        console.log(`\n${PAD}${c.cyan}🚀 Implementing plan...${c.reset}\n`);
        await sendMessage(`Please implement this plan:\n\n${planContent}\n\nApply the changes now using <file_operation> tags.`);
        interactionMode = prevMode;
        if (statusBar) statusBar.update({ mode: prevMode });
      } else {
        console.log(`${PAD}${c.dim}Plan not implemented.${c.reset}\n`);
      }
      return true;

    case '/ask':
      if (interactionMode === 'ask') {
        interactionMode = 'work';
        if (statusBar) statusBar.update({ mode: 'work' });
        console.log(`\n${PAD}${c.green}  ✓ Switched to WORK mode${c.reset}`);
        console.log(`${PAD}${c.dim}  File operations and commands will be executed normally.${c.reset}\n`);
      } else {
        interactionMode = 'ask';
        if (statusBar) statusBar.update({ mode: 'ask' });
        console.log(`\n${c.magenta}  💬 ASK MODE: ON${c.reset}`);
        console.log(`${PAD}${c.dim}  Question-only mode - AI will answer questions without generating code operations.${c.reset}`);
        console.log(`${PAD}${c.dim}  Use /ask again to switch back to work mode.${c.reset}\n`);
      }
      return true;

    case '/mode':
      const modeColors = { work: c.green, plan: c.cyan, ask: c.magenta };
      const modeIcons = { work: '🔧', plan: '📋', ask: '💬' };
      console.log(`\n${PAD}Current mode: ${modeColors[interactionMode]}${modeIcons[interactionMode]} ${interactionMode.toUpperCase()}${c.reset}`);
      console.log(`${PAD}${c.dim}  /work - Execute file operations and commands${c.reset}`);
      console.log(`${PAD}${c.dim}  /plan - Explore codebase and build structured plan${c.reset}`);
      console.log(`${PAD}${c.dim}  /ask  - Question-only mode (no operations)${c.reset}\n`);
      return true;

    case '/prompt':
      const requestedPrompt = args.trim().toLowerCase();

      if (!requestedPrompt) {
        // Interactive prompt picker
        const available = promptManager.list();
        const promptItems = available.map(name => ({
          key: name,
          label: name,
          description: '',
          tags: [],
          active: name === activePrompt
        }));

        const selectedPrompt = await pick(promptItems, { title: 'Switch Prompt' });
        if (selectedPrompt) {
          activePrompt = selectedPrompt.key;
          config.set('activePrompt', selectedPrompt.key);
          console.log(`${PAD}${c.green}✓ Prompt: ${selectedPrompt.key}${c.reset}\n`);
        } else {
          console.log(`${PAD}${c.dim}Cancelled${c.reset}\n`);
        }
        return true;
      }

      if (!promptManager.has(requestedPrompt)) {
        console.log(`\n${PAD}${c.red}Unknown prompt: "${requestedPrompt}". Available: ${promptManager.list().join(', ')}${c.reset}\n`);
        return true;
      }

      activePrompt = requestedPrompt;
      config.set('activePrompt', requestedPrompt);
      console.log(`\n${PAD}${c.green}  ✓ Prompt: ${requestedPrompt}${c.reset}\n`);
      return true;

    case '/model':
    case '/models':
      const modelArgRaw = args.trim();
      const modelArg = modelArgRaw.toLowerCase();

      if (!modelArg) {
        // Interactive model picker
        const models = modelRegistry.list();
        const current = modelRegistry.getCurrent();
        const pickerItems = models.map(m => ({
          key: m.key,
          label: m.name,
          description: m.description || '',
          tags: m.tags || [],
          active: m.key === current
        }));

        const selected = await pick(pickerItems, {
          title: 'Switch Model',
          showVisionIndicator: true
        });
        if (selected) {
          await switchModel(selected.key);
        } else {
          console.log(`${PAD}${c.dim}Cancelled${c.reset}\n`);
        }
        return true;
      }

      if (modelArg === 'search' || modelArg.startsWith('search ')) {
        const query = modelArgRaw.slice('search '.length).trim();
        if (!query) {
          console.log(`\n${PAD}${c.yellow}Usage: /model search <query>${c.reset}\n`);
          return true;
        }

        const envFallback = !!process.env.OPENROUTER_API_KEY;
        if (!providerStore.isConnected('openrouter') && !envFallback) {
          console.log(`\n${PAD}${c.red}âœ— OpenRouter is not connected. Run /connect openrouter.${c.reset}\n`);
          return true;
        }

        try {
          console.log(`\n${PAD}${c.cyan}Searching OpenRouter models for "${query}"...${c.reset}`);
          const results = await searchOpenRouterModels(query, { limit: 80 });
          if (results.length === 0) {
            console.log(`${PAD}${c.yellow}No OpenRouter models matched "${query}".${c.reset}\n`);
            return true;
          }

          const pickerItems = results.map((m) => ({
            key: m.id,
            label: m.name,
            description: '',
            tags: ['openrouter', `ctx:${Math.round(m.contextLimit / 1000)}k`],
            active: false
          }));

          const selected = await pick(pickerItems, { title: `OpenRouter Search: "${query}" (${results.length})` });
          if (!selected) {
            console.log(`${PAD}${c.dim}Cancelled${c.reset}\n`);
            return true;
          }

          const selectedId = selected.key;
          const existingModels = providerStore.getModels('openrouter');
          const selectedIdLower = String(selectedId || '').toLowerCase();
          const existingEntry = Object.entries(existingModels).find(([, model]) =>
            String(model?.id || '').toLowerCase() === selectedIdLower
          );

          let alias;
          if (existingEntry) {
            alias = existingEntry[0];
          } else {
            alias = buildAliasFromModelId(selectedId, Object.keys(existingModels));
            const picked = results.find((m) => m.id === selectedId);
            providerStore.setModelId('openrouter', alias, selectedId, {
              name: selected.label || selectedId,
              contextLimit: picked?.contextLimit || 200000,
              supportsThinking: true,
              prompt: 'code-agent'
            });
            modelRegistry.refreshRemoteModels();
            console.log(`${PAD}${c.green}âœ“ Added OpenRouter alias: ${alias} -> ${selectedId}${c.reset}`);
          }

          await switchModel(`openrouter:${alias}`);
        } catch (err) {
          console.log(`\n${PAD}${c.red}âœ— ${err.message}${c.reset}\n`);
        }
        return true;
      }

      try {
        await switchModel(modelArg);
      } catch (err) {
        console.log(`\n${PAD}${c.red}✗ ${err.message}${c.reset}\n`);
      }
      return true;

    case '/connect': {
      const connectArgs = args.trim();
      if (!connectArgs || connectArgs === 'status' || connectArgs === 'list') {
        if (!connectArgs) {
          await connectProviderInteractive(null);
        } else {
          listProviderStatus();
        }
        return true;
      }

      const [subcommand, secondArg] = connectArgs.split(/\s+/, 2);
      const normalizedSub = subcommand.toLowerCase();

      if (normalizedSub === 'disconnect') {
        const provider = normalizeProviderKey(secondArg);
        if (!provider || provider === 'local') {
          console.log(`\n${PAD}${c.yellow}Usage: /connect disconnect <anthropic|openai|openrouter>${c.reset}\n`);
          return true;
        }
        const wasActiveProvider = (modelRegistry.getCurrentModel()?.provider || 'local') === provider;
        providerStore.disconnect(provider);
        modelRegistry.refreshRemoteModels();
        if (wasActiveProvider) {
          const fallback = modelRegistry.getDefault();
          if (fallback) await switchModel(fallback);
        }
        console.log(`\n${PAD}${c.green}✓ Disconnected ${PROVIDER_LABELS[provider] || provider}${c.reset}\n`);
        return true;
      }

      if (normalizedSub === 'use') {
        const provider = normalizeProviderKey(secondArg);
        if (!provider) {
          console.log(`\n${PAD}${c.yellow}Usage: /connect use <local|anthropic|openai|openrouter>${c.reset}\n`);
          return true;
        }

        const envFallback = (provider === 'anthropic' && !!process.env.ANTHROPIC_API_KEY)
          || (provider === 'openrouter' && !!process.env.OPENROUTER_API_KEY);
        if (provider !== 'local' && !providerStore.isConnected(provider) && !envFallback) {
          console.log(`\n${PAD}${c.red}✗ ${PROVIDER_LABELS[provider] || provider} is not connected. Run /connect ${provider}.${c.reset}\n`);
          return true;
        }

        const candidate = modelRegistry.list().find(m => (m.provider || 'local') === provider);
        if (!candidate) {
          console.log(`\n${PAD}${c.red}✗ No models available for ${PROVIDER_LABELS[provider] || provider}.${c.reset}\n`);
          return true;
        }

        await switchModel(candidate.key);
        return true;
      }

      const provider = normalizeProviderKey(subcommand);
      if (!provider || provider === 'local') {
        console.log(`\n${PAD}${c.yellow}Usage:${c.reset}`);
        console.log(`${PAD}${c.dim}  /connect${c.reset}`);
        console.log(`${PAD}${c.dim}  /connect <anthropic|openai|openrouter>${c.reset}`);
        console.log(`${PAD}${c.dim}  /connect status${c.reset}`);
        console.log(`${PAD}${c.dim}  /connect disconnect <provider>${c.reset}`);
        console.log(`${PAD}${c.dim}  /connect use <local|provider>${c.reset}\n`);
        return true;
      }

      try {
        await connectProviderInteractive(provider);
      } catch (err) {
        console.log(`\n${PAD}${c.red}✗ ${err.message}${c.reset}\n`);
      }
      return true;
    }

    case '/mcp': {
      const mcpSubcommand = args.trim().toLowerCase();

      // /mcp disconnect - clear saved URL and reset client
      if (mcpSubcommand === 'disconnect') {
        config.set('mcpUrl', null);
        mcpClient.url = '';
        mcpClient.sessionId = null;
        mcpClient.initialized = false;
        mcpClient.serverInfo = null;
        if (statusBar) statusBar.update({ mcpConnected: false });
        console.log(`\n${PAD}${c.green}✓${c.reset} MCP disconnected and URL cleared.\n`);
        return true;
      }

      // /mcp auth - check and set up Google OAuth
      if (mcpSubcommand === 'auth') {
        try {
          const authConnected = await mcpClient.isConnected();
          if (!authConnected) {
            console.log(`\n${PAD}${c.red}✗ MCP not connected. Run /mcp first.${c.reset}\n`);
            return true;
          }
          console.log(`\n${PAD}${c.cyan}Google Auth Status${c.reset}`);
          console.log(`${PAD}${c.dim}Checking...${c.reset}`);
          const authResult = await mcpClient.callTool('check_google_auth', {});
          const authText = typeof authResult === 'string' ? authResult : JSON.stringify(authResult);
          const isAuthed = /authorized|authenticated|connected|valid/i.test(authText) && !/not\s+(authorized|authenticated|connected)/i.test(authText);

          if (isAuthed) {
            console.log(`${PAD}${c.green}✓ Google account authorized${c.reset}`);
            console.log(`${PAD}${c.dim}  Gmail, Calendar, and Drive tools are available.${c.reset}`);
          } else {
            console.log(`${PAD}${c.yellow}○ Google account not authorized${c.reset}`);
            console.log(`${PAD}${c.dim}  Gmail, Calendar, and Drive require Google OAuth.${c.reset}`);
            console.log();
            const doAuth = await askQuestion(`${PAD}${c.cyan}Start Google auth flow? (y/n): ${c.reset}`);
            if (doAuth.trim().toLowerCase() === 'y') {
              console.log(`${PAD}${c.dim}Starting authorization...${c.reset}`);
              const startResult = await mcpClient.callTool('authorize_google', {});
              const startText = typeof startResult === 'string' ? startResult : JSON.stringify(startResult);

              // Look for an auth URL in the response
              const urlMatch = startText.match(/https?:\/\/\S+/);
              if (urlMatch) {
                console.log(`\n${PAD}${c.cyan}Open this URL in your browser:${c.reset}`);
                console.log(`${PAD}${c.white}${urlMatch[0]}${c.reset}`);
                console.log();
                const authCode = await askQuestion(`${PAD}${c.cyan}Paste the authorization code: ${c.reset}`);
                const code = authCode.trim();
                if (code) {
                  console.log(`${PAD}${c.dim}Completing authorization...${c.reset}`);
                  const completeResult = await mcpClient.callTool('complete_google_auth', { code });
                  const completeText = typeof completeResult === 'string' ? completeResult : JSON.stringify(completeResult);
                  if (/success|authorized|complete/i.test(completeText)) {
                    console.log(`${PAD}${c.green}✓ Google account authorized!${c.reset}`);
                    console.log(`${PAD}${c.dim}  Gmail, Calendar, and Drive tools are now available.${c.reset}`);
                  } else {
                    console.log(`${PAD}${c.yellow}Server response: ${completeText.slice(0, 200)}${c.reset}`);
                  }
                } else {
                  console.log(`${PAD}${c.dim}Skipped${c.reset}`);
                }
              } else {
                // Server might handle auth differently (e.g. auto-open browser)
                console.log(`${PAD}${c.dim}${startText.slice(0, 300)}${c.reset}`);
              }
            } else {
              console.log(`${PAD}${c.dim}Skipped${c.reset}`);
            }
          }
        } catch (authErr) {
          console.log(`${PAD}${c.red}✗ Auth check failed: ${authErr.message}${c.reset}`);
          console.log(`${PAD}${c.dim}  Your MCP server may not support Google auth tools.${c.reset}`);
        }
        console.log();
        return true;
      }

      console.log(`\n${PAD}${c.cyan}MCP Server Status${c.reset}`);
      try {
        const mcpConnected = await mcpClient.isConnected();
        if (statusBar) statusBar.update({ mcpConnected });
        const mcpStatus = mcpClient.getStatus();

        if (mcpConnected && mcpSubcommand !== 'connect') {
          const serverLabel = mcpStatus.serverName || 'MCP server';
          const serverVer = mcpStatus.serverVersion ? ` v${mcpStatus.serverVersion}` : '';
          console.log(`${PAD}${c.green}✓ Connected${c.reset} to ${serverLabel}${serverVer}`);
          console.log(`${PAD}${c.dim}  URL: ${mcpStatus.url}${c.reset}`);
          if (mcpStatus.sessionId) {
            console.log(`${PAD}${c.dim}  Session: ${mcpStatus.sessionId}${c.reset}`);
          }

          // Check Google auth status
          try {
            const gAuthResult = await mcpClient.callTool('check_google_auth', {});
            const gAuthText = typeof gAuthResult === 'string' ? gAuthResult : JSON.stringify(gAuthResult);
            const gAuthed = /authorized|authenticated|connected|valid/i.test(gAuthText) && !/not\s+(authorized|authenticated|connected)/i.test(gAuthText);
            if (gAuthed) {
              console.log(`${PAD}${c.green}✓${c.reset} Google: authorized`);
            } else {
              console.log(`${PAD}${c.yellow}○${c.reset} Google: not authorized ${c.dim}(run /mcp auth to set up)${c.reset}`);
            }
          } catch {
            // Server doesn't support Google auth check - skip silently
          }

          // List available tools
          try {
            const tools = await mcpClient.listTools();
            console.log(`\n${PAD}${c.cyan}Available Tools (${tools.length}):${c.reset}`);
            for (const tool of tools) {
              console.log(`${PAD}${c.yellow}  ${tool.name}${c.reset}${tool.description ? ` ${c.dim}- ${tool.description.slice(0, 60)}${c.reset}` : ''}`);
            }
          } catch (toolErr) {
            console.log(`\n${PAD}${c.yellow}Could not list tools: ${toolErr.message}${c.reset}`);
          }
          console.log(`\n${PAD}${c.dim}  /mcp connect    Change server URL${c.reset}`);
          console.log(`${PAD}${c.dim}  /mcp auth       Google OAuth setup${c.reset}`);
          console.log(`${PAD}${c.dim}  /mcp disconnect  Disconnect and clear URL${c.reset}`);
        } else {
          // Not connected or explicit /mcp connect - run setup wizard
          if (!mcpSubcommand) {
            console.log(`${PAD}${c.red}✗ Not connected${c.reset}`);
            if (mcpStatus.url) {
              console.log(`${PAD}${c.dim}  URL: ${mcpStatus.url}${c.reset}`);
            }
          }

          console.log(`\n${PAD}${c.cyan}MCP Setup${c.reset}`);
          console.log(`${PAD}${c.dim}  MCP servers provide external tools (tasks, calendar, email, etc.)${c.reset}`);
          console.log(`${PAD}${c.dim}  Enter the URL of your MCP server, or press Enter to skip.${c.reset}`);
          if (mcpStatus.url) {
            console.log(`${PAD}${c.dim}  Current: ${mcpStatus.url}${c.reset}`);
          }
          console.log();

          const mcpInput = await askQuestion(`${PAD}${c.cyan}MCP server URL: ${c.reset}`);
          const mcpUrl = mcpInput.trim();

          if (!mcpUrl) {
            console.log(`${PAD}${c.dim}Skipped${c.reset}\n`);
          } else {
            // Validate URL format
            try {
              new URL(mcpUrl);
            } catch {
              console.log(`${PAD}${c.red}✗ Invalid URL format${c.reset}\n`);
              return true;
            }

            console.log(`${PAD}${c.dim}Testing connection...${c.reset}`);
            // Normalize: strip trailing slash
            let finalUrl = mcpUrl.replace(/\/+$/, '');

            // Auto-discover MCP endpoint via /connect if user gave a base URL
            if (!finalUrl.endsWith('/mcp') && !finalUrl.endsWith('/sse')) {
              try {
                const discoverRes = await fetch(finalUrl + '/connect', {
                  signal: AbortSignal.timeout(8000)
                });
                if (discoverRes.ok) {
                  const discovery = await discoverRes.json();
                  const mcpEndpoint = discovery?.endpoints?.mcp_streamable_http;
                  if (mcpEndpoint) {
                    console.log(`${PAD}${c.dim}  Discovered MCP endpoint: ${mcpEndpoint}${c.reset}`);
                    finalUrl = mcpEndpoint;
                  }
                }
              } catch {
                // Discovery not available, continue with fallback logic
              }
            }

            mcpClient.url = finalUrl;
            mcpClient.sessionId = null;
            mcpClient.initialized = false;
            mcpClient.serverInfo = null;

            let testOk = await mcpClient.isConnected();

            // If still failed, try appending /mcp (common MCP endpoint path)
            if (!testOk && !finalUrl.endsWith('/mcp')) {
              const withMcp = mcpUrl.replace(/\/+$/, '') + '/mcp';
              console.log(`${PAD}${c.dim}  Trying ${withMcp}...${c.reset}`);
              mcpClient.url = withMcp;
              mcpClient.sessionId = null;
              mcpClient.initialized = false;
              mcpClient.serverInfo = null;
              testOk = await mcpClient.isConnected();
              if (testOk) finalUrl = withMcp;
            }

            if (testOk) {
              config.set('mcpUrl', finalUrl);
              if (statusBar) statusBar.update({ mcpConnected: true });
              const info = mcpClient.getStatus();
              const label = info.serverName || 'MCP server';
              const ver = info.serverVersion ? ` v${info.serverVersion}` : '';
              console.log(`${PAD}${c.green}✓ Connected${c.reset} to ${label}${ver}`);
              console.log(`${PAD}${c.dim}  URL saved to config${c.reset}`);

              // Show tool count
              try {
                const tools = await mcpClient.listTools();
                console.log(`${PAD}${c.dim}  ${tools.length} tools available${c.reset}`);
              } catch {}
            } else {
              console.log(`${PAD}${c.red}✗ Could not connect to ${mcpUrl}${c.reset}`);
              console.log(`${PAD}${c.dim}  URL not saved. Check the server is running and try again.${c.reset}`);
              // Revert to previous URL
              const prevUrl = config.get('mcpUrl') || '';
              mcpClient.url = prevUrl;
              mcpClient.sessionId = null;
              mcpClient.initialized = false;
              mcpClient.serverInfo = null;
            }
          }
        }
      } catch (mcpErr) {
        console.log(`${PAD}${c.red}✗ Error: ${mcpErr.message}${c.reset}`);
      }
      console.log();
      return true;
    }

    case '/config':
      const allConfig = config.getAll();
      console.log(`\n${PAD}${c.cyan}Configuration:${c.reset}`);
      Object.entries(allConfig).forEach(([key, value]) => {
        const displayValue = Array.isArray(value) ? `[${value.length} items]` : String(value);
        console.log(`${PAD}${c.dim}  ${key}: ${c.white}${displayValue}${c.reset}`);
      });
      console.log();
      return true;

    case '/set':
      const setParts = args.split(/\s+/);
      if (setParts.length < 2) {
        console.log(`\n${PAD}${c.yellow}Usage: /set <key> <value>${c.reset}`);
        console.log(`${PAD}${c.dim}Example: /set compactMode true${c.reset}\n`);
        return true;
      }
      const [setKey, ...setValueParts] = setParts;
      let setValue = setValueParts.join(' ');
      // Parse booleans and numbers
      if (setValue === 'true') setValue = true;
      else if (setValue === 'false') setValue = false;
      else if (!isNaN(Number(setValue))) setValue = Number(setValue);

      config.set(setKey, setValue);
      console.log(`\n${PAD}${c.green}  ✓ Set ${setKey} = ${setValue}${c.reset}\n`);
      return true;

    case '/instructions':
      const existingInstructions = config.getInstructions();
      if (existingInstructions) {
        console.log(`\n${PAD}${c.cyan}Project Instructions (${existingInstructions.source}):${c.reset}`);
        const preview = existingInstructions.content.substring(0, 500);
        console.log(`${PAD}${c.dim}${preview}${existingInstructions.content.length > 500 ? '...' : ''}${c.reset}`);
        const editPath = existingInstructions.source === 'RIPLEY.md'
          ? path.join(projectDir, 'RIPLEY.md')
          : path.join(projectDir, '.ripley', 'instructions.md');
        console.log(`\n${PAD}${c.dim}Edit: ${editPath}${c.reset}\n`);
      } else {
        config.createDefaultInstructions();
        console.log(`\n${PAD}${c.green}  ✓ Created RIPLEY.md${c.reset}`);
        console.log(`${PAD}${c.dim}Edit: ${path.join(projectDir, 'RIPLEY.md')}${c.reset}\n`);
      }
      return true;

    case '/run':
    case '/exec':
    case '/$':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /run <command>${c.reset}\n`);
        return true;
      }
      console.log(`\n${PAD}${c.dim}Running: ${args}${c.reset}\n`);
      try {
        const result = await commandRunner.run(args, {
          onStdout: data => process.stdout.write(data),
          onStderr: data => process.stderr.write(data)
        });
        console.log(`\n${result.success ? c.green : c.red}  Exit code: ${result.code}${c.reset}\n`);
      } catch (error) {
        console.log(`\n${PAD}${c.red}Error: ${error.message}${c.reset}\n`);
      }
      return true;

    case '/undo':
    case '/backups':
      const backups = fileManager.getBackups();
      if (backups.length === 0) {
        console.log(`\n${PAD}${c.dim}No backups available${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.cyan}Recent backups:${c.reset}`);
        backups.slice(0, 10).forEach(b => {
          const time = new Date(b.timestamp).toLocaleString();
          console.log(`${PAD}${c.dim}  • ${b.name} (${time})${c.reset}`);
        });
        console.log();
      }
      return true;

    case '/restore':
      if (!args) {
        console.log(`\n${PAD}${c.yellow}Usage: /restore <filepath>${c.reset}\n`);
        return true;
      }
      const restoreResult = fileManager.restoreLatest(args);
      if (restoreResult.success) {
        console.log(`\n${PAD}${c.green}  ✓ Restored: ${restoreResult.restored}${c.reset}\n`);
      } else {
        console.log(`\n${PAD}${c.red}✗ ${restoreResult.error}${c.reset}\n`);
      }
      return true;

    case '/exit':
    case '/quit':
    case '/q':
      // Auto-save if enabled
      if (config.get('autoSaveHistory') && conversationHistory.length > 0) {
        config.saveConversation('autosave', conversationHistory);
      }
      watcher.stop();
      logSessionEnd('exit', ' code=0 phase=command');
      console.log(`\n${PAD}${c.cyan}👋 See you later!${c.reset}\n`);
      process.exit(0);

    case '/commands':
      listCustomCommands();
      return true;

    default:
      // Check for custom commands in ~/.ripley/Commands/
      const customResult = loadCustomCommand(cmd);
      if (customResult) {
        console.log(`\n${PAD}${c.cyan}Running custom command: ${customResult.name}${c.reset}`);
        console.log(`${PAD}${c.dim}Source: ${customResult.source}${c.reset}\n`);
        await sendMessage(customResult.content);
        return true;
      }
      return false;
  }
}

// =============================================================================
// AI INTERACTION
// =============================================================================

/**
 * Auto-compaction: summarize conversationHistory when context approaches 80%.
 * Replaces the full history with a compact summary + the last 4 messages.
 */
async function compactHistory() {
  if (conversationHistory.length < 4) return; // nothing meaningful to compact

  console.log(`\n${PAD}${c.yellow}⚡ Auto-compacting context...${c.reset}`);

  // Build a summarization prompt from the full history
  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content || '').slice(0, 2000)}`)
    .join('\n\n');

  const summaryMessages = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Summarize the following conversation concisely, preserving key decisions, file changes, and important context. Output only the summary, no preamble.'
    },
    {
      role: 'user',
      content: `Summarize this conversation:\n\n${historyText}`
    }
  ];

  try {
    const activeClient = await getActiveClient();
    const activeModelMeta = modelRegistry.getCurrentModel();
    const data = await activeClient.chat(summaryMessages, {
      model: modelRegistry.getCurrentId(),
      temperature: 0.3,
      maxTokens: 1500,
      thinking: false,
      reasoningEffort: activeModelMeta?.reasoningEffort
    });
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('Empty summary');

    // Keep the last 4 messages (2 turns) for continuity, prefix with summary
    const recent = conversationHistory.slice(-4);
    conversationHistory = [
      { role: 'user', content: '[Conversation summary]\n' + summary },
      { role: 'assistant', content: 'Understood. I have the context from our previous conversation.' },
      ...recent
    ];
    console.log(`${PAD}${c.green}✓ Context compacted (summary + last 2 turns retained)${c.reset}\n`);
  } catch (err) {
    // Fallback: just trim to last 20 messages
    conversationHistory = conversationHistory.slice(-20);
    console.log(`${PAD}${c.yellow}⚠ Compaction failed (${err.message}), trimmed to 20 messages${c.reset}\n`);
  }
}

async function sendMessage(message) {
  // Load @ mentioned files
  const loadedFromMentions = await loadMentionedFiles(message);
  if (loadedFromMentions.length > 0) {
    console.log(`${PAD}${c.dim}Loaded: ${loadedFromMentions.join(', ')}${c.reset}`);
  }

  // Check for pending images and analyze them with vision AI
  const pendingImages = imageHandler.consumePendingImages();
  let imageAnalysis = '';

  if (pendingImages.length > 0) {
    console.log(`${PAD}${c.dim}Including ${pendingImages.length} image(s)${c.reset}`);

    if (modelRegistry.currentSupportsVision()) {
      const visionModel = modelRegistry.getCurrentModel();
      const visionProvider = visionModel?.provider || 'local';
      const providerLabel = visionProvider === 'local'
        ? 'local'
        : (PROVIDER_LABELS[visionProvider] || visionProvider);
      console.log(`${PAD}${c.green}✓ Using ${providerLabel} vision model${c.reset}`);
    } else if (visionAnalyzer.isEnabled()) {
      // Gemini fallback - convert images to text analysis
      console.log(`${PAD}${c.cyan}🔍 Analyzing image(s) with Gemini...${c.reset}`);
      const analysis = await visionAnalyzer.analyzeImages(pendingImages, message);
      if (analysis) {
        imageAnalysis = visionAnalyzer.formatForPrompt(analysis);
        console.log(`${PAD}${c.green}✓ Image analysis complete${c.reset}`);
      } else {
        console.log(`${PAD}${c.yellow}⚠ Image analysis failed, sending without description${c.reset}`);
      }
    } else {
      console.log(`${PAD}${c.yellow}⚠ No vision capability. Paste an image with Alt+V to set up your Gemini API key.${c.reset}`);
    }
  }

  // Get project instructions
  const instructions = config.getInstructions();

  // Build full message - differs based on agentic mode
  let systemNote = '';
  if (config.get('compactMode')) {
    systemNote = '\n\n[USER PREFERENCE: Be concise. Shorter explanations, focus on code changes.]';
  }

  // Always agentic: send a file list, let the model read what it needs
  const structure = contextBuilder.scanDirectory();
  const fileList = [];
  const collectFiles = (items, prefix = '') => {
    for (const item of items) {
      if (item.type === 'file') {
        fileList.push(prefix + item.name);
      } else if (item.children) {
        collectFiles(item.children, prefix + item.name + '/');
      }
    }
  };
  collectFiles(structure);

  const FILE_LIST_CAP = 50;
  let fullMessage = `## Project Overview\n\nWorking directory: ${projectDir}\n\nFiles available (use read_file to examine if needed):\n${fileList.slice(0, FILE_LIST_CAP).join('\n')}${fileList.length > FILE_LIST_CAP ? `\n... and ${fileList.length - FILE_LIST_CAP} more (use list_files to explore)` : ''}`;
  const hasVisionImages = pendingImages.length > 0 && modelRegistry.currentSupportsVision();

  // NOTE: Project instructions (RIPLEY.md) are now injected in the system prompt,
  // not here in the user message. This gives them higher priority with local models.

  if (imageAnalysis) {
    fullMessage += `\n\n## Image Analysis\n\n${imageAnalysis}`;
  }

  fullMessage += `\n\n## Request\n\n${message}${systemNote}`;
  if (hasVisionImages) {
    fullMessage += '\n\n## Vision Guidance\n\nUse attached image content as the primary source of truth for this request. Do not call file tools unless the user explicitly asks for repository/file analysis.';
  } else if (imageAnalysis) {
    fullMessage += '\n\n## Vision Guidance\n\nThe user pasted screenshot(s) which were analyzed by a vision AI. The Image Analysis section above is your primary source of truth for this request. Focus on describing and responding to the image content, not the project file listing. Do not call file tools unless the user explicitly asks for repository/file analysis.';
  }

  try {
    await sendAgenticMessage(fullMessage, pendingImages, message);
  } catch (error) {
    const provider = activeProviderKey();
    const providerLabel = providerManager.getProviderLabel(provider);
    console.log(`\n${PAD}${c.red}✗ Error: ${error.message}${c.reset}`);
    if (provider === 'local') {
      console.log(`${PAD}${c.dim}  Make sure LM Studio is running at ${lmStudio.baseUrl}${c.reset}\n`);
    } else {
      console.log(`${PAD}${c.dim}  Check your ${providerLabel} connection with /connect status${c.reset}\n`);
    }
  }
}

async function sendStreamingMessage(message, images = [], rawMessage = '') {
  // Contextual thinking message derived from user input
  const streamUserText = (rawMessage || message || '').trim().replace(/[\r\n]+/g, ' ');
  let thinkingMessage;
  if (streamUserText.length > 0) {
    let summary = streamUserText;
    if (summary.length > 45) {
      summary = summary.substring(0, 45).replace(/\s+\S*$/, '') + '...';
    }
    thinkingMessage = `Thinking about "${summary}"`;
  } else {
    thinkingMessage = 'Thinking...';
  }
  const generatingMessages = [
    'Writing code...',
    'Crafting response...',
    'Generating...',
    'Building solution...',
    'Creating magic...',
    'Typing furiously...',
    'Almost done...',
    'Putting pieces together...',
    'Polishing...'
  ];
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  let messageIndex = 0;
  let statusInterval = null;
  let isGenerating = false;
  let tickCount = 0;
  let tokenCount = 0;
  let statusLineLength = 0;

  // Update status line (shown during both thinking and generating)
  const updateStatus = () => {
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    tickCount++;

    let currentMessage;
    if (isGenerating) {
      // Cycle generating messages every ~2 seconds
      if (tickCount % 20 === 0) {
        messageIndex = (messageIndex + 1) % generatingMessages.length;
      }
      currentMessage = generatingMessages[messageIndex % generatingMessages.length];
    } else {
      // Show contextual thinking with elapsed time after 3s
      const elapsed = Math.floor(tickCount / 10);
      currentMessage = elapsed >= 3 ? `${thinkingMessage} (${elapsed}s)` : thinkingMessage;
    }

    const tokenInfo = isGenerating ? ` ${c.dim}(${tokenCount} tokens)${c.reset}` : '';
    const statusText = `${borderRenderer.prefix('thinking')}${c.cyan}${spinnerFrames[spinnerIndex]} ${currentMessage}${c.reset}${tokenInfo}`;

    if (isGenerating) {
      // During generation: show status on same line, don't interfere with output
    } else if (promptDuringWork) {
      // Prompt is below spinner - use save/restore to update spinner line above
      process.stdout.write(`\x1b[s\x1b[A\x1b[2K\x1b[0G${fitToTerminal(statusText)}\x1b[u`);
      statusLineLength = statusText.length;
    } else {
      // During initial thinking: show on current line
      process.stdout.write(`\x1b[2K\x1b[0G${fitToTerminal(statusText)}`);
      statusLineLength = statusText.length;
    }

    // Keep the pinned bar alive during spinner updates.
    if (statusBar) {
      statusBar.refresh();
    }
  };

  // Get current spinner text for re-rendering
  const getStreamSpinnerText = () => {
    const elapsed = Math.floor(tickCount / 10);
    const msg = elapsed >= 3 ? `${thinkingMessage} (${elapsed}s)` : thinkingMessage;
    return `${borderRenderer.prefix('thinking')}${c.cyan}${spinnerFrames[spinnerIndex]} ${msg}${c.reset}`;
  };

  // Start the status animation with always-visible prompt below spinner
  const startThinking = () => {
    process.stdout.write(`\n${borderRenderer.prefix('thinking')}${c.cyan}${spinnerFrames[0]} ${thinkingMessage}${c.reset}`);
    statusInterval = setInterval(updateStatus, 100);
    // Show prompt below spinner so user can type at any time
    promptDuringWork = true;
    rl.setPrompt(buildPromptPrefix());
    process.stdout.write('\n');
    rl.prompt(false);
    // Store re-render function for use by handleLine/flushSteerPasteBuffer
    renderWorkingPrompt = () => {
      process.stdout.write(`${fitToTerminal(getStreamSpinnerText())}\n`);
      rl.setPrompt(buildPromptPrefix());
      rl.prompt(false);
      if (statusBar) statusBar.render();
    };
    if (statusBar) {
      statusBar.setInputHint('Esc\u00d72 to cancel');
      statusBar.render();
    }
  };

  // Transition to generating mode (first token received)
  const startGenerating = () => {
    isGenerating = true;
    messageIndex = 0;
    tickCount = 0;
    // Clear prompt line and spinner line, then show AI label
    if (promptDuringWork) {
      process.stdout.write('\x1b[2K\x1b[0G');           // Clear prompt line
      process.stdout.write('\x1b[A\x1b[2K\x1b[0G');     // Move up, clear spinner line
      promptDuringWork = false;
      renderWorkingPrompt = null;
    } else {
      process.stdout.write('\x1b[2K\x1b[0G');
    }
    const aiLabel = `${borderRenderer.prefix('ai')}${c.cyan}Ripley →${c.reset} `;
    process.stdout.write(aiLabel);
    // Tell word wrapper how much of the first line is already used
    wordWrapper.currentLineLength = borderRenderer.stripAnsi(aiLabel).length;
    if (statusBar) statusBar.refresh();
  };

  const stopStatus = () => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    // Clean up prompt-during-work if it was still active
    if (promptDuringWork && rl) {
      rl.write(null, { ctrl: true, name: 'u' }); // Clear any typed text
      process.stdout.write('\x1b[2K\x1b[0G');     // Clear prompt line
      process.stdout.write('\x1b[A\x1b[2K\x1b[0G'); // Move up, clear spinner line
      if (restorePromptFn) restorePromptFn();
    }
    promptDuringWork = false;
    renderWorkingPrompt = null;
    if (statusBar) {
      statusBar.setInputHint('');
      statusBar.render();
    }
  };

  // Determine which prompt to use - mirror agentic path's model-specific logic
  let promptMode;
  if (interactionMode === 'plan' && promptManager.has('plan')) {
    promptMode = 'plan';
  } else if (interactionMode === 'ask') {
    promptMode = 'base';
  } else {
    const streamModelPrompt = modelRegistry.getPrompt();
    if (promptManager.has(streamModelPrompt)) {
      promptMode = streamModelPrompt;
    } else if (promptManager.has('code-agent')) {
      promptMode = 'code-agent';
    } else {
      promptMode = activePrompt;
    }
  }

  // Build messages array for LM Studio
  const messages = [];
  const systemPrompt = promptManager.get(promptMode);
  const streamInstructions = config.getInstructions();
  let fullSystemPrompt = systemPrompt || '';
  if (streamInstructions) {
    fullSystemPrompt += `\n\n## Project Instructions (from ${streamInstructions.source})\n\n${streamInstructions.content}`;
  }
  if (fullSystemPrompt) {
    messages.push({ role: 'system', content: fullSystemPrompt });
  }
  messages.push(...conversationHistory);
  const streamSteeringCount = appendQueuedSteeringMessages(messages);

  // Handle vision: if current model supports vision and we have images, use multimodal
  if (images.length > 0 && modelRegistry.currentSupportsVision()) {
    messages.push(visionAnalyzer.buildMultimodalMessage(message, images));
  } else {
    messages.push({ role: 'user', content: message });
  }
  setContextEstimate(estimatePromptTokensForMessages(messages, { reserveTokens: 64 }));

  // Create abort controller for this request
  currentAbortController = new AbortController();

  // Start the fun thinking animation
  startThinking();
  if (statusBar) statusBar.startTiming();

  const streamInferenceSettings = modelRegistry.getInferenceSettings();
  const activeClient = await getActiveClient();
  const streamModelMeta = modelRegistry.getCurrentModel();
  const response = await activeClient.chatStream(messages, {
    model: modelRegistry.getCurrentId(),
    temperature: streamInferenceSettings.temperature,
    topP: streamInferenceSettings.topP,
    repeatPenalty: streamInferenceSettings.repeatPenalty,
    thinking: (thinkingLevel !== 'off' && modelRegistry.currentSupportsThinking()) ? getThinkingBudget() : false,
    signal: currentAbortController.signal,
    reasoningEffort: streamModelMeta?.reasoningEffort
  });

  let fullResponse = '';
  let firstTokenReceived = false;
  const wordWrapper = new StreamingWordWrapper(null, borderRenderer.prefix('ai'));
  const markdownRenderer = new MarkdownRenderer();

  const streamHandler = new StreamHandler({
    onToken: (token) => {
      // Transition from thinking to generating on first token
      if (!firstTokenReceived) {
        firstTokenReceived = true;
        startGenerating();
      }
      tokenCount++;
      if (statusBar) statusBar.update({ sessionOut: tokenCount });
      // Render Markdown to ANSI-styled output, then word-wrap
      const rendered = markdownRenderer.render(token);
      const wrapped = wordWrapper.write(rendered);
      if (wrapped) process.stdout.write(wrapped);
    },
    onComplete: (response) => {
      // Flush Markdown buffer first, then word wrapper
      const mdRemaining = markdownRenderer.flush();
      if (mdRemaining) {
        const wrapped = wordWrapper.write(mdRemaining);
        if (wrapped) process.stdout.write(wrapped);
      }
      const remaining = wordWrapper.flush();
      if (remaining) process.stdout.write(remaining);
      fullResponse = response;
      stopStatus();
      midTurnSteerRequested = false; // Clear stale steer flag on normal completion
      if (statusBar) statusBar.stopTiming();
    },
    onError: (error) => {
      stopStatus();
      if (statusBar) statusBar.stopTiming();
      console.log(`\n${PAD}${c.red}Stream error: ${error.message}${c.reset}`);
    }
  });

  try {
    await streamHandler.handleStream(response);
  } catch (error) {
    stopStatus();
    // Check if this was an abort
    if (error.name === 'AbortError') {
      currentAbortController = null;
      if (midTurnSteerRequested) {
        midTurnSteerRequested = false;
        console.log(`\n${PAD}${c.cyan}Steering update applied. Continuing...${c.reset}`);
        return await sendStreamingMessage(message, images, rawMessage);
      }
      return; // Don't process, user cancelled
    }
    // If streaming fails, the response might not be SSE format
    // Try to read as regular JSON
    const text = await response.text();
    const { renderMarkdown } = require('./lib/markdownRenderer');
    try {
      const data = JSON.parse(text);
      fullResponse = data.reply || text;
      console.log(renderMarkdown(fullResponse));
    } catch {
      fullResponse = text;
      console.log(renderMarkdown(text));
    }
  }

  // Clear abort controller
  currentAbortController = null;

  console.log('\n'); // Add spacing after response for readability

  if (streamSteeringCount > 0) {
    clearSteeringMessages();
  }

  // Process the response
  await processAIResponse(fullResponse, message);
}

// =============================================================================
// HOOKS COMMAND HANDLER
// =============================================================================

async function handleHooksCommand(args) {
  if (!hookManager) {
    console.log(`\n${PAD}${c.red}Hook manager not initialized.${c.reset}\n`);
    return;
  }

  const parts = (args || '').trim().split(/\s+/);
  const subCommand = parts[0]?.toLowerCase();

  // /hooks (no args) or /hooks list
  if (!subCommand || subCommand === 'list') {
    const hooks = hookManager.listAll();
    if (hooks.length === 0) {
      console.log(`\n${PAD}${c.dim}No hooks configured. Use /hooks add to create one.${c.reset}\n`);
      return;
    }

    // Build items for interactive toggle
    const toggleItems = hooks.map(h => {
      let desc;
      if (h.agentA) {
        const hasB = !!h.agentB;
        const label = hasB ? `A: ${h.agentA.model} / B: ${h.agentB.model}` : `agent: ${h.agentA.model}`;
        const turns = hasB ? `, ${h.maxTurns || 3} turns` : '';
        desc = `${h.hookPoint}, ${h.trigger || 'always'}, ${label}${turns}`;
      } else if (h.agent) {
        desc = `${h.hookPoint}, ${h.trigger || 'always'}, agent: ${h.agent}`;
      } else {
        desc = `${h.hookPoint}, ${h.trigger || 'always'}, cmd: ${h.command}`;
      }
      return {
        key: h.name,
        description: desc,
        meta: h._scope === 'project' ? 'project' : 'global',
        enabled: h.enabled !== false,
        _hookName: h.name
      };
    });

    await pickToggle(toggleItems, {
      title: `Hooks (${hooks.length})`,
      onToggle: (item, newEnabled) => {
        const result = hookManager.toggleHook(item._hookName);
        if (result === null) return false;
        return true;
      }
    });
    console.log('');
    return;
  }

  // /hooks add - interactive wizard
  if (subCommand === 'add') {
    console.log(`\n${PAD}${c.orange}Add Hook${c.reset}\n`);
    const result = await hookManager.runAddWizard(pick, askQuestion, modelRegistry);
    if (result) {
      const scopeLabel = result.scope === 'project' ? 'project' : 'global';
      console.log(`\n${PAD}${c.green}Hook "${result.hookDef.name}" added to ${result.hookPoint} (${scopeLabel}).${c.reset}\n`);
    } else {
      console.log(`${PAD}${c.dim}Cancelled.${c.reset}\n`);
    }
    return;
  }

  // /hooks remove <name>
  if (subCommand === 'remove' || subCommand === 'rm') {
    const name = parts.slice(1).join(' ');
    if (!name) {
      console.log(`\n${PAD}${c.yellow}Usage: /hooks remove <name>${c.reset}\n`);
      return;
    }
    const removed = hookManager.removeHook(name);
    if (removed) {
      console.log(`\n${PAD}${c.green}Hook "${name}" removed.${c.reset}\n`);
    } else {
      console.log(`\n${PAD}${c.red}Hook "${name}" not found.${c.reset}\n`);
    }
    return;
  }

  // /hooks toggle <name>
  if (subCommand === 'toggle') {
    const name = parts.slice(1).join(' ');
    if (!name) {
      console.log(`\n${PAD}${c.yellow}Usage: /hooks toggle <name>${c.reset}\n`);
      return;
    }
    const newState = hookManager.toggleHook(name);
    if (newState === null) {
      console.log(`\n${PAD}${c.red}Hook "${name}" not found.${c.reset}\n`);
    } else {
      console.log(`\n${PAD}${c.green}Hook "${name}": ${newState ? 'enabled' : 'disabled'}${c.reset}\n`);
    }
    return;
  }

  // /hooks edit [name]
  if (subCommand === 'edit') {
    const name = parts.slice(1).join(' ') || null;
    console.log(`\n${PAD}${c.orange}Edit Hook${c.reset}\n`);
    const result = await hookManager.runEditWizard(pick, askQuestion, modelRegistry, name);
    if (result) {
      console.log(`\n${PAD}${c.green}Hook "${result.hookName}" updated.${c.reset}\n`);
    } else {
      console.log(`${PAD}${c.dim}No changes made.${c.reset}\n`);
    }
    return;
  }

  // /hooks test <name>
  if (subCommand === 'test') {
    const name = parts.slice(1).join(' ');
    if (!name) {
      console.log(`\n${PAD}${c.yellow}Usage: /hooks test <name>${c.reset}\n`);
      return;
    }
    const hooks = hookManager.listAll();
    const hook = hooks.find(h => h.name === name);
    if (!hook) {
      console.log(`\n${PAD}${c.red}Hook "${name}" not found.${c.reset}\n`);
      return;
    }
    console.log(`\n${PAD}${c.cyan}Testing hook "${name}"...${c.reset}`);
    try {
      const result = await hookManager.runSingleHook(name, {
        response: 'Test response',
        files: ['test.js'],
        error: hook.trigger === 'hasErrors' ? new Error('Test error') : null,
        commandRan: hook.trigger === 'commandRan'
      });
      if (result) {
        if (result.error) {
          console.log(`${PAD}${c.red}Error: ${result.error}${c.reset}`);
        } else {
          console.log(`${PAD}${c.green}Result:${c.reset}`);
          const allLines = result.result.split('\n');
          const lines = allLines.slice(0, 10);
          for (const line of lines) {
            console.log(`${PAD}  ${line}`);
          }
          if (allLines.length > 10) {
            console.log(`${PAD}  ${c.dim}...(${allLines.length - 10} more lines)${c.reset}`);
          }
        }
      } else {
        console.log(`${PAD}${c.dim}Hook not found.${c.reset}`);
      }
    } catch (err) {
      console.log(`${PAD}${c.red}Test failed: ${err.message}${c.reset}`);
    }
    console.log('');
    return;
  }

  // Default: show help
  console.log(`
${PAD}${c.orange}Hook System${c.reset}
${PAD}${c.dim}Automated actions at lifecycle points.${c.reset}

${PAD}${c.yellow}/hooks${c.reset}                  List all hooks
${PAD}${c.yellow}/hooks add${c.reset}              Create a hook (with AI-refined instructions)
${PAD}${c.yellow}/hooks edit [name]${c.reset}      Edit an existing hook
${PAD}${c.yellow}/hooks remove <name>${c.reset}    Remove a hook by name
${PAD}${c.yellow}/hooks toggle <name>${c.reset}    Enable/disable a hook
${PAD}${c.yellow}/hooks test <name>${c.reset}      Test-fire a hook

${PAD}${c.dim}Hook points: beforeTurn, afterTurn, afterWrite, afterCommand, onError${c.reset}
${PAD}${c.dim}Hook types: Prompt (AI-configured) | Agent A/B (manual) | Shell (command)${c.reset}
${PAD}${c.dim}Scopes: Global (~/.ripley/hooks.json) or Project (.ripley/hooks.json)${c.reset}
`);
}

// =============================================================================
// SUB-AGENT COMMAND HANDLER
// =============================================================================

async function handleAgentCommand(args) {
  if (!subAgentManager) {
    console.log(`\n${PAD}${c.red}Sub-agent manager not initialized.${c.reset}\n`);
    return;
  }

  let parts = (args || '').trim().split(/\s+/);
  let subCommand = parts[0]?.toLowerCase();

  // /agent (no args) - interactive mode
  if (!subCommand) {
    // Show interactive model picker
    const models = modelRegistry.list();
    const grouped = {};
    for (const m of models) {
      const provider = m.provider || 'local';
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push(m);
    }
    const modelItems = [];
    for (const [provider, providerModels] of Object.entries(grouped)) {
      for (const m of providerModels) {
        const key = m.provider === 'local' ? m.key : `${m.provider}:${m.key}`;
        modelItems.push({
          key,
          label: key,
          description: m.name || '',
          active: m.active
        });
      }
    }

    if (modelItems.length === 0) {
      console.log(`\n${PAD}${c.yellow}No models available. Use /connect to add a provider.${c.reset}\n`);
      return;
    }

    console.log('');
    const modelChoice = await pick(modelItems, { title: 'Select model for sub-agent' });
    if (!modelChoice) {
      console.log(`${PAD}${c.dim}Cancelled.${c.reset}\n`);
      return;
    }

    const taskInput = await askQuestion(`${PAD}${c.yellow}Task: ${c.reset}`);
    if (!taskInput || !taskInput.trim()) {
      console.log(`${PAD}${c.dim}No task provided. Cancelled.${c.reset}\n`);
      return;
    }

    // Reuse the spawn logic below
    parts = [modelChoice.key, ...taskInput.trim().split(/\s+/)];
    subCommand = parts[0]?.toLowerCase();
    // Fall through to spawn logic at the bottom
  }

  // /agent help
  if (subCommand === 'help') {
    console.log(`
${PAD}${c.orange}Sub-Agent System${c.reset}
${PAD}${c.dim}Spawn sub-agents on any connected model/provider.${c.reset}

${PAD}${c.yellow}/agent${c.reset}                    Interactive model picker + task prompt
${PAD}${c.yellow}/agent <model> <task>${c.reset}      Spawn a sub-agent
${PAD}${c.yellow}/agent list${c.reset}                 List all session agents
${PAD}${c.yellow}/agent status <id>${c.reset}           Show agent details
${PAD}${c.yellow}/agent models${c.reset}               List available models
${PAD}${c.yellow}/agent help${c.reset}                 Show this help

${PAD}${c.dim}Model format: "provider:alias" (e.g., anthropic:claude-sonnet-4.6, local:current)${c.reset}
${PAD}${c.dim}AI can also spawn agents via the spawn_agent tool during conversations.${c.reset}
`);
    return;
  }

  // /agent list
  if (subCommand === 'list') {
    const agents = subAgentManager.listAgents();
    if (agents.length === 0) {
      console.log(`\n${PAD}${c.dim}No agents spawned this session.${c.reset}\n`);
      return;
    }
    console.log(`\n${PAD}${c.orange}Session Agents (${agents.length})${c.reset}`);
    for (const agent of agents) {
      const statusIcon = agent.status === 'completed' ? `${c.green}done${c.reset}`
        : agent.status === 'failed' ? `${c.red}fail${c.reset}`
        : agent.status === 'cancelled' ? `${c.yellow}cancelled${c.reset}`
        : `${c.cyan}running${c.reset}`;
      const elapsed = agent.completedAt
        ? `${((agent.completedAt - agent.startedAt) / 1000).toFixed(1)}s`
        : 'running';
      const tokens = agent.tokens?.total ? `${(agent.tokens.total / 1000).toFixed(1)}k tok` : '';
      const steps = agent.toolCalls?.length || 0;
      console.log(`${PAD}  ${c.dim}${agent.id}${c.reset} [${statusIcon}] ${c.white}${agent.model}${c.reset} ${c.dim}(${steps} steps, ${elapsed}${tokens ? ', ' + tokens : ''})${c.reset}`);
      const taskPreview = agent.task.length > 60 ? agent.task.slice(0, 57) + '...' : agent.task;
      console.log(`${PAD}    ${c.dim}Task: ${taskPreview}${c.reset}`);
    }
    console.log('');
    return;
  }

  // /agent status <id>
  if (subCommand === 'status') {
    const agentId = parts[1];
    if (!agentId) {
      console.log(`\n${PAD}${c.yellow}Usage: /agent status <id>${c.reset}\n`);
      return;
    }
    const agent = subAgentManager.getAgent(agentId);
    if (!agent) {
      console.log(`\n${PAD}${c.red}Agent "${agentId}" not found.${c.reset}\n`);
      return;
    }
    const elapsed = agent.completedAt
      ? `${((agent.completedAt - agent.startedAt) / 1000).toFixed(1)}s`
      : `${((Date.now() - agent.startedAt) / 1000).toFixed(1)}s (running)`;
    console.log(`
${PAD}${c.orange}Agent ${agent.id}${c.reset}
${PAD}  Model:    ${c.white}${agent.model}${c.reset} (${agent.provider})
${PAD}  Status:   ${agent.status}
${PAD}  Task:     ${agent.task}
${PAD}  Elapsed:  ${elapsed}
${PAD}  Steps:    ${agent.toolCalls?.length || 0}
${PAD}  Tokens:   ${agent.tokens?.total || 0} (prompt: ${agent.tokens?.prompt || 0}, completion: ${agent.tokens?.completion || 0})
${PAD}  Depth:    ${agent.depth}
`);
    if (agent.toolCalls?.length > 0) {
      console.log(`${PAD}  ${c.dim}Tool calls:${c.reset}`);
      for (const tc of agent.toolCalls) {
        const detail = tc.args?.path || tc.args?.pattern || tc.args?.command || tc.args?.query || '';
        console.log(`${PAD}    ${c.dim}${tc.tool}${detail ? ' ' + detail : ''}${c.reset}`);
      }
      console.log('');
    }
    if (agent.result) {
      const preview = agent.result.length > 500 ? agent.result.slice(0, 497) + '...' : agent.result;
      console.log(`${PAD}  ${c.dim}Result:${c.reset}`);
      console.log(`${PAD}  ${preview}\n`);
    }
    if (agent.error) {
      console.log(`${PAD}  ${c.red}Error: ${agent.error}${c.reset}\n`);
    }
    return;
  }

  // /agent models
  if (subCommand === 'models') {
    const models = modelRegistry.list();
    console.log(`\n${PAD}${c.orange}Available Models for Sub-Agents${c.reset}`);
    const grouped = {};
    for (const m of models) {
      const provider = m.provider || 'local';
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push(m);
    }
    for (const [provider, providerModels] of Object.entries(grouped)) {
      const label = PROVIDER_LABELS[provider] || provider;
      console.log(`\n${PAD}  ${c.cyan}${label}${c.reset}`);
      for (const m of providerModels) {
        const key = m.provider === 'local' ? m.key : `${m.provider}:${m.key}`;
        const active = m.active ? ` ${c.green}(active)${c.reset}` : '';
        console.log(`${PAD}    ${c.white}${key}${c.reset}${active} ${c.dim}${m.name || ''}${c.reset}`);
      }
    }
    console.log('');
    return;
  }

  // /agent <model> <task> - spawn a sub-agent
  const modelKey = parts[0];
  const task = parts.slice(1).join(' ');
  if (!task) {
    console.log(`\n${PAD}${c.yellow}Usage: /agent <model> <task>${c.reset}`);
    console.log(`${PAD}${c.dim}Example: /agent anthropic:claude-sonnet-4.6 review the auth flow${c.reset}\n`);
    return;
  }

  // Resolve to verify the model exists
  const resolved = modelRegistry.resolveModelKey(modelKey);
  if (!resolved) {
    console.log(`\n${PAD}${c.red}Could not resolve model "${modelKey}".${c.reset}`);
    console.log(`${PAD}${c.dim}Use /agent models to see available models.${c.reset}\n`);
    return;
  }

  const providerLabel = PROVIDER_LABELS[resolved.provider || 'local'] || resolved.provider || 'local';
  console.log(`\n${PAD}${c.cyan}-- Sub-Agent [${resolved.key}] (${providerLabel}) -----${c.reset}`);
  console.log(`${PAD}${c.dim}| Task: ${task}${c.reset}`);

  // Set up UI callbacks
  let agentStepCount = 0;
  subAgentManager.onAgentToolCall = (agent, tool, toolArgs) => {
    agentStepCount++;
    const toolIcons = {
      read_file: '> Reading', list_files: '> Listing', search_code: '> Searching',
      create_file: '> Creating', edit_file: '> Editing', run_command: '> Running',
      spawn_agent: '> Spawning agent'
    };
    const detail = toolArgs.path || toolArgs.pattern || toolArgs.command || toolArgs.query || toolArgs.model || '';
    console.log(`${PAD}${c.dim}| ${toolIcons[tool] || '> ' + tool} ${detail}${c.reset}`);
  };
  subAgentManager.onAgentComplete = (agent) => {
    const elapsed = ((agent.completedAt - agent.startedAt) / 1000).toFixed(1);
    const tokens = agent.tokens?.total ? `${(agent.tokens.total / 1000).toFixed(1)}k tokens` : '';
    console.log(`${PAD}${c.dim}| -- ${agent.toolCalls?.length || 0} steps --${c.reset}`);
    console.log(`${PAD}${c.cyan}+-- Complete (${tokens}${tokens ? ', ' : ''}${elapsed}s)${c.reset}`);
  };
  subAgentManager.onAgentError = (agent, err) => {
    console.log(`${PAD}${c.red}+-- Failed: ${err.message || err}${c.reset}`);
  };

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
    process.stdout.write(`\x1b[2K\x1b[0G${PAD}${c.cyan}${spinnerFrames[spinnerIdx]} Working...${c.reset}`);
  }, 100);

  try {
    const result = await subAgentManager.spawn(modelKey, task, { depth: 1 });
    clearInterval(spinnerInterval);
    process.stdout.write('\x1b[2K\x1b[0G');

    if (result.error) {
      console.log(`\n${PAD}${c.red}Error: ${result.error}${c.reset}\n`);
    } else if (result.result) {
      console.log(`${PAD}|`);
      // Render result with markdown
      const mdRenderer = new MarkdownRenderer();
      const rendered = mdRenderer.render(result.result) + mdRenderer.flush();
      const lines = rendered.split('\n');
      for (const line of lines) {
        console.log(`${PAD}${c.dim}|${c.reset} ${line}`);
      }
      console.log('');

      // Add sub-agent result to conversation so the main model has context
      conversationHistory.push({
        role: 'user',
        content: `[Sub-agent result from ${result.model || modelKey}]\nTask: ${task}`
      });
      conversationHistory.push({
        role: 'assistant',
        content: result.result
      });
    }

    // Update token counter
    if (result.tokens > 0 && tokenCounter) {
      // Split roughly 70/30 for prompt/completion estimate
      const estPrompt = Math.floor(result.tokens * 0.7);
      const estCompletion = result.tokens - estPrompt;
      tokenCounter.addUsage(estPrompt, estCompletion);
    }

  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\x1b[2K\x1b[0G');
    console.log(`\n${PAD}${c.red}Sub-agent error: ${err.message || err}${c.reset}\n`);
  }
}

async function sendAgenticMessage(message, images = [], rawMessage = '') {
  const markdownRenderer = new MarkdownRenderer();
  const wordWrapper = new StreamingWordWrapper(null, borderRenderer.prefix('ai'));

  const toolMessages = {
    read_file: '📖 Reading',
    list_files: '📁 Listing',
    search_code: '🔍 Searching',
    create_file: '✍️  Creating',
    edit_file: '✏️  Editing',
    run_command: '⚡ Running',
    get_tasks: '📋 Fetching tasks',
    create_task: '📋 Creating task',
    get_calendar: '📅 Checking calendar',
    get_email_summary: '📧 Reading emails',
    search_memory: '🧠 Searching memory',
    deep_research: '🔬 Deep researching',
    web_search: '🌐 Web searching',
    call_mcp: '🔌 Calling service',
    spawn_agent: '🤖 Spawning agent',
    ask_human: '💬 Asking you'
  };

  // Contextual thinking message from user input
  const agenticUserText = (rawMessage || message || '').trim().replace(/[\r\n]+/g, ' ');
  let agenticThinking;
  if (agenticUserText.length > 0) {
    let summary = agenticUserText;
    if (summary.length > 45) {
      summary = summary.substring(0, 45).replace(/\s+\S*$/, '') + '...';
    }
    agenticThinking = `Thinking about "${summary}"`;
  } else {
    agenticThinking = 'Thinking...';
  }

  // Reset prompt-during-work state from any previous run
  promptDuringWork = false;
  renderWorkingPrompt = null;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  let statusInterval = null;
  let currentStatus = agenticThinking;
  let toolCallsDisplayed = [];
  let streamingStarted = false;
  let spinnerTick = 0;
  let streamedTokenCount = 0;
  let stepCount = 0;

  // Get current spinner text for re-rendering after layout changes
  const getSpinnerText = () => {
    let displayStatus = currentStatus;
    if (stepCount === 0) {
      const elapsed = Math.floor(spinnerTick / 10);
      if (elapsed >= 3) {
        displayStatus = `${currentStatus} (${elapsed}s)`;
      }
    }
    return `${borderRenderer.prefix('thinking')}${c.cyan}${spinnerFrames[spinnerIndex]} ${displayStatus}${c.reset}`;
  };

  const updateSpinner = () => {
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    spinnerTick++;
    const statusText = fitToTerminal(getSpinnerText());

    if (promptDuringWork) {
      // Prompt is below spinner - use save/restore to update spinner line above
      process.stdout.write(`\x1b[s\x1b[A\x1b[2K\x1b[0G${statusText}\x1b[u`);
    } else {
      process.stdout.write(`\x1b[2K\x1b[0G${statusText}`);
    }
    if (statusBar) {
      statusBar.refresh();
    }
  };

  const startSpinner = () => {
    process.stdout.write(`\n${borderRenderer.prefix('thinking')}${c.cyan}${spinnerFrames[0]} ${currentStatus}${c.reset}`);
    statusInterval = setInterval(updateSpinner, 100);
    // Show prompt below spinner so user can type at any time
    promptDuringWork = true;
    rl.setPrompt(buildPromptPrefix());
    process.stdout.write('\n');
    rl.prompt(false);
    // Store re-render function for use by handleLine/flushSteerPasteBuffer
    renderWorkingPrompt = () => {
      process.stdout.write(`${fitToTerminal(getSpinnerText())}\n`);
      rl.setPrompt(buildPromptPrefix());
      rl.prompt(false);
      if (statusBar) statusBar.render();
    };
    if (statusBar) {
      statusBar.setInputHint('Esc\u00d72 to cancel');
      statusBar.render();
    }
  };

  const stopSpinner = () => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    // Clean up prompt-during-work
    if (promptDuringWork && rl) {
      rl.write(null, { ctrl: true, name: 'u' }); // Clear any typed text
      process.stdout.write('\x1b[2K\x1b[0G');     // Clear prompt line
      process.stdout.write('\x1b[A\x1b[2K\x1b[0G'); // Move up, clear spinner line
      if (restorePromptFn) restorePromptFn();
    } else {
      process.stdout.write('\x1b[2K\x1b[0G');
    }
    promptDuringWork = false;
    renderWorkingPrompt = null;
    if (statusBar) {
      statusBar.setInputHint('');
      statusBar.render();
    }
  };

  // Determine prompt - use model-specific prompt if available
  let promptMode;
  if (interactionMode === 'plan' && promptManager.has('plan')) {
    promptMode = 'plan';
  } else {
    // Model-specific prompt (e.g., code-agent-gptoss) > generic code-agent > active prompt
    const modelPrompt = modelRegistry.getPrompt();
    if (promptManager.has(modelPrompt)) {
      promptMode = modelPrompt;
    } else if (promptManager.has('code-agent')) {
      promptMode = 'code-agent';
    } else {
      promptMode = activePrompt;
    }
  }

  // Build messages array
  const messages = [];
  const systemPrompt = promptManager.get(promptMode);
  const instructions = config.getInstructions();
  // Combine base prompt + project instructions into one system message
  let fullSystemPrompt = systemPrompt || '';
  if (instructions) {
    fullSystemPrompt += `\n\n## Project Instructions (from ${instructions.source})\n\n${instructions.content}`;
  }
  if (fullSystemPrompt) {
    messages.push({ role: 'system', content: fullSystemPrompt });
  }
  messages.push(...conversationHistory);
  const agenticSteeringCount = appendQueuedSteeringMessages(messages);

  if (images.length > 0 && modelRegistry.currentSupportsVision()) {
    messages.push(visionAnalyzer.buildMultimodalMessage(message, images));
  } else {
    messages.push({ role: 'user', content: message });
  }
  const toolSchema = interactionMode === 'plan' ? READ_ONLY_TOOLS : TOOLS;
  setContextEstimate(estimatePromptTokensForMessages(messages, {
    toolSchema,
    reserveTokens: 64
  }));

  // beforeTurn hooks
  if (hookManager) {
    try {
      const hookResults = await hookManager.runHooks('beforeTurn', {
        message,
        conversationHistory
      });
      for (const hr of hookResults) {
        if (hr.result && hr.inject) {
          queueSteeringMessage(hr.result);
        }
      }
      // Re-append if new steering was queued by hooks
      if (hookResults.some(hr => hr.result)) {
        appendQueuedSteeringMessages(messages);
      }
    } catch {
      // Hook failures never break the main flow
    }
  }

  startSpinner();
  if (statusBar) statusBar.startTiming();

  try {
    const activeClient = await getActiveClient();
    const runner = new AgenticRunner(activeClient, {
      onFileWrite: hookManager ? (filePath, action) => {
        hookManager.runHooks('afterWrite', { file: filePath, files: [filePath] }).catch(() => {});
      } : null,
      onCommandComplete: hookManager ? (command, result) => {
        hookManager.runHooks('afterCommand', { command, commandRan: true }).catch(() => {});
      } : null,
      onToolCall: (tool, args) => {
        stepCount++;
        const toolMsg = toolMessages[tool] || '🔧 Using';
        let detail = args.path || args.pattern || args.command || args.query || args.question || (tool === 'call_mcp' ? args.tool : '') || (tool === 'spawn_agent' ? args.model : '') || '';
        // Truncate detail to prevent spinner line from wrapping past terminal width
        const maxDetail = Math.max(20, (process.stdout.columns || 120) - 30);
        if (detail.length > maxDetail) detail = detail.slice(0, maxDetail - 3) + '...';
        currentStatus = detail
          ? `Step ${stepCount} · ${toolMsg} ${detail}`
          : `Step ${stepCount} · ${toolMsg}`;
        updateSpinner();
        toolCallsDisplayed.push({ tool, args, stepNum: stepCount });
      },
      onToolResult: (tool, success, result) => {
        if (toolCallsDisplayed.length > 0) {
          const last = toolCallsDisplayed[toolCallsDisplayed.length - 1];
          last.success = success;
          if (result?._mcp && success) {
            last.mcpPreview = JSON.stringify(result.result || '').slice(0, 100);
          } else if (result?.error) {
            last.errorMsg = String(result.error).slice(0, 120);
          }
          // Print completed step as a permanent line
          const icon = toolMessages[tool]?.split(' ')[0] || '🔧';
          let detail = last.args.path || last.args.pattern || last.args.command || last.args.query || last.args.question || (tool === 'call_mcp' ? last.args.tool : '') || (tool === 'spawn_agent' ? last.args.model : '') || '';
          const maxLen = Math.max(20, (process.stdout.columns || 120) - 20);
          if (detail.length > maxLen) detail = detail.slice(0, maxLen - 3) + '...';
          const label = detail || (toolMessages[tool] || tool).replace(/^\S+\s*/, '');
          const status = success === false
            ? `${c.red}✗${c.reset}`
            : `${c.green}✓${c.reset}`;
          const errInfo = (!success && last.errorMsg) ? ` ${c.red}${last.errorMsg}${c.reset}` : '';
          // Clear spinner line, print permanent step, restart spinner on next line
          if (promptDuringWork) {
            // Clear prompt line, move up and clear spinner line
            process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          } else {
            process.stdout.write(`\x1b[2K\x1b[0G`);
          }
          console.log(`${borderRenderer.prefix('tool')}${status} ${c.dim}${last.stepNum}. ${icon} ${label}${errInfo}${c.reset}`);
          if (promptDuringWork && renderWorkingPrompt) {
            // Re-render spinner + prompt below the permanent output
            renderWorkingPrompt();
          }
        }
      },
      onIntermediateContent: (text) => {
        // Surface model narration between tool rounds
        // Grab first sentence or first 120 chars as a brief status line
        let narration = text.replace(/<[^>]+>/g, '').trim();
        const firstSentence = narration.match(/^[^.!?\n]+[.!?]?/);
        if (firstSentence) narration = firstSentence[0];
        if (narration.length > 120) narration = narration.slice(0, 117) + '...';
        if (narration) {
          if (promptDuringWork) {
            process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          } else {
            process.stdout.write(`\x1b[2K\x1b[0G`);
          }
          console.log(`${borderRenderer.prefix('thinking')}${c.cyan}> ${narration}${c.reset}`);
          if (promptDuringWork && renderWorkingPrompt) {
            renderWorkingPrompt();
          }
        }
      },
      onToken: (token) => {
        // First token: stop spinner, print separator, start streaming
        if (!streamingStarted) {
          streamingStarted = true;
          stopSpinner();

          // Re-apply scroll region before writing response text.
          // A prior resize or bar repaint can leave the cursor stranded in the
          // status bar area, causing the entire response to be invisible.
          if (statusBar) statusBar.install();

          // Brief summary line if there were steps
          if (toolCallsDisplayed.length > 0) {
            const stepWord = toolCallsDisplayed.length === 1 ? 'step' : 'steps';
            console.log(`${borderRenderer.prefix('tool')}${c.dim}── ${toolCallsDisplayed.length} ${stepWord} completed ──${c.reset}`);
          }

          const agenticAiLabel = `${borderRenderer.prefix('ai')}${c.cyan}Ripley →${c.reset} `;
          process.stdout.write(agenticAiLabel);
          wordWrapper.currentLineLength = borderRenderer.stripAnsi(agenticAiLabel).length;
        }

        streamedTokenCount++;
        if (statusBar) {
          const currentOut = tokenCounter.sessionTokens?.output || 0;
          statusBar.update({ sessionOut: currentOut + streamedTokenCount });
        }

        // Strip leading think blocks from stream (they arrive token by token)
        const rendered = markdownRenderer.render(token);
        const wrapped = wordWrapper.write(rendered);
        if (wrapped) process.stdout.write(wrapped);
      },
      onContent: (content) => {
        // Flush remaining markdown/word buffer
        const mdRemaining = markdownRenderer.flush();
        if (mdRemaining) {
          const wrapped = wordWrapper.write(mdRemaining);
          if (wrapped) process.stdout.write(wrapped);
        }
        const remaining = wordWrapper.flush();
        if (remaining) process.stdout.write(remaining);

        if (!streamingStarted) {
          // Edge case: empty response, no tokens fired
          stopSpinner();
        }
      },
      onReasoning: (reasoning) => {
        // Clear spinner+prompt before printing reasoning block
        if (promptDuringWork) {
          process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
        } else {
          process.stdout.write('\x1b[2K\x1b[0G');
        }
        console.log(`${borderRenderer.prefix('thinking')}${c.dim}┌─ 🧠 Reasoning${c.reset}`);
        const lines = reasoning.trim().split('\n');
        for (const line of lines) {
          console.log(`${borderRenderer.prefix('thinking')}${c.dim}│ ${line}${c.reset}`);
        }
        console.log(`${borderRenderer.prefix('thinking')}${c.dim}└─${c.reset}`);
        // Re-render spinner + prompt after reasoning block
        if (promptDuringWork && renderWorkingPrompt) {
          renderWorkingPrompt();
        }
      },
      onWarning: (msg) => {
        if (promptDuringWork) {
          process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          console.log(`${PAD}${c.yellow}⚠ ${msg}${c.reset}`);
          if (renderWorkingPrompt) renderWorkingPrompt();
        } else {
          console.log(`\n${PAD}${c.yellow}⚠ ${msg}${c.reset}`);
        }
      },
      // Custom tools: ask_human (always), spawn_agent (work mode only)
      customTools: [
        ASK_HUMAN_TOOL_DEF,
        ...((interactionMode !== 'plan' && subAgentManager) ? [SPAWN_AGENT_TOOL_DEF] : [])
      ],
      customToolExecutors: new Map([
        ['ask_human', async (args, opts) => {
          const question = args.question || 'Do you have any input?';

          // Stop spinner and show question UI
          if (statusInterval) {
            clearInterval(statusInterval);
            statusInterval = null;
          }

          // Clear spinner + prompt lines if active
          if (promptDuringWork) {
            process.stdout.write('\x1b[2K\x1b[0G');           // Clear prompt line
            process.stdout.write('\x1b[A\x1b[2K\x1b[0G');     // Move up, clear spinner line
          } else {
            process.stdout.write('\x1b[2K\x1b[0G');
          }

          // Display the question prominently
          const cols = process.stdout.columns || 80;
          const border = '─'.repeat(Math.min(cols - 6, 60));
          console.log(`${borderRenderer.prefix('tool')}${c.cyan}┌─ Question ${border}${c.reset}`);
          // Word-wrap the question for readability
          const maxLineLen = Math.min(cols - 8, 76);
          const words = question.split(/\s+/);
          let line = '';
          for (const word of words) {
            if (line.length + word.length + 1 > maxLineLen && line.length > 0) {
              console.log(`${borderRenderer.prefix('tool')}${c.cyan}│${c.reset} ${line}`);
              line = word;
            } else {
              line = line ? `${line} ${word}` : word;
            }
          }
          if (line) {
            console.log(`${borderRenderer.prefix('tool')}${c.cyan}│${c.reset} ${line}`);
          }
          console.log(`${borderRenderer.prefix('tool')}${c.cyan}└${border}─${c.reset}`);

          // Show answer prompt
          promptDuringWork = false; // Temporarily disable spinner-based prompt
          const answerPrefix = `${PAD}${c.cyan}Answer →${c.reset} `;
          rl.setPrompt(answerPrefix);
          process.stdout.write('\n');
          rl.prompt(false);
          if (statusBar) {
            statusBar.setInputHint('Type your answer and press Enter');
            statusBar.render();
          }

          // Wait for user input, racing against abort signal
          const answer = await new Promise((resolve) => {
            pendingHumanQuestion = { resolve, question };
            // If aborted from outside the Escape handler, unblock the Promise
            if (opts.signal) {
              const onAbort = () => {
                if (pendingHumanQuestion) {
                  pendingHumanQuestion = null;
                  resolve('(cancelled)');
                }
              };
              if (opts.signal.aborted) { onAbort(); return; }
              opts.signal.addEventListener('abort', onAbort, { once: true });
            }
          });

          // Resume spinner
          promptDuringWork = true;
          const steerPrefix = `${PAD}${c.dim}>${c.reset} `;
          rl.setPrompt(steerPrefix);

          // Show answer confirmation
          console.log(`${borderRenderer.prefix('tool')}${c.green}✓${c.reset} ${c.dim}Answer received${c.reset}`);

          // Restart spinner + prompt
          statusInterval = setInterval(updateSpinner, 100);
          process.stdout.write(`\n${fitToTerminal(getSpinnerText())}\n`);
          rl.prompt(false);
          renderWorkingPrompt = () => {
            process.stdout.write(`${fitToTerminal(getSpinnerText())}\n`);
            rl.prompt(false);
            if (statusBar) statusBar.render();
          };
          if (statusBar) {
            statusBar.setInputHint('Esc\u00d72 to cancel');
            statusBar.render();
          }

          return { response: answer };
        }],
        ...(subAgentManager ? [['spawn_agent', async (args, opts) => {
          // UI: show sub-agent spawning inline
          const resolved = modelRegistry.resolveModelKey(args.model);
          const modelLabel = resolved?.key || args.model;
          const providerLabel = PROVIDER_LABELS[resolved?.provider || 'local'] || resolved?.provider || 'local';

          // Clear spinner+prompt before sub-agent output
          if (promptDuringWork) {
            process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          } else {
            process.stdout.write(`\x1b[2K\x1b[0G`);
          }
          console.log(`${borderRenderer.prefix('tool')}${c.cyan}> Spawning agent [${modelLabel}] (${providerLabel})${c.reset}`);
          console.log(`${borderRenderer.prefix('tool')}${c.dim}  Task: "${args.task?.slice(0, 80) || ''}"${c.reset}`);
          if (promptDuringWork && renderWorkingPrompt) {
            renderWorkingPrompt();
          }

          // Set sub-agent callbacks for inline display
          subAgentManager.onAgentToolCall = (agent, tool, toolArgs) => {
            const detail = toolArgs.path || toolArgs.pattern || toolArgs.command || toolArgs.query || '';
            if (promptDuringWork) {
              process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
            }
            console.log(`${borderRenderer.prefix('tool')}${c.dim}  | > ${tool} ${detail}${c.reset}`);
            if (promptDuringWork && renderWorkingPrompt) renderWorkingPrompt();
          };
          subAgentManager.onAgentComplete = (agent) => {
            const elapsed = ((agent.completedAt - agent.startedAt) / 1000).toFixed(1);
            const tokens = agent.tokens?.total ? `${(agent.tokens.total / 1000).toFixed(1)}k tokens` : '';
            const steps = agent.toolCalls?.length || 0;
            if (promptDuringWork) {
              process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
            }
            console.log(`${borderRenderer.prefix('tool')}${c.dim}  +-- Complete (${steps} steps, ${elapsed}s${tokens ? ', ' + tokens : ''})${c.reset}`);
            if (promptDuringWork && renderWorkingPrompt) renderWorkingPrompt();
          };
          subAgentManager.onAgentError = (agent, err) => {
            if (promptDuringWork) {
              process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
            }
            console.log(`${borderRenderer.prefix('tool')}${c.red}  +-- Failed: ${err.message || err}${c.reset}`);
            if (promptDuringWork && renderWorkingPrompt) renderWorkingPrompt();
          };

          const result = await subAgentManager.spawn(args.model, args.task, {
            context: args.context,
            readOnly: args.read_only,
            depth: 1,
            signal: opts.signal
          });

          // Track sub-agent tokens in session totals
          if (result.tokens > 0 && tokenCounter) {
            const estPrompt = Math.floor(result.tokens * 0.7);
            const estCompletion = result.tokens - estPrompt;
            tokenCounter.addUsage(estPrompt, estCompletion);
          }

          return result;
        }]] : [])
      ])
    });

    // Use model-specific inference settings
    currentAbortController = new AbortController();
    const inferenceSettings = modelRegistry.getInferenceSettings();
    const agenticModelMeta = modelRegistry.getCurrentModel();
    const fullResponse = await runner.run(messages, projectDir, {
      model: modelRegistry.getCurrentId(),
      temperature: inferenceSettings.temperature,
      topP: inferenceSettings.topP,
      repeatPenalty: inferenceSettings.repeatPenalty,
      thinkingBudget: (thinkingLevel !== 'off' && modelRegistry.currentSupportsThinking()) ? getThinkingBudget() : 0,
      signal: currentAbortController.signal,
      reasoningEffort: agenticModelMeta?.reasoningEffort,
      tools: interactionMode === 'plan' ? READ_ONLY_TOOLS : undefined,
      readOnly: interactionMode === 'plan'
    });

    // Update context usage from actual API token count, or estimate from messages
    if (runner.lastTurnTokens > 0) {
      setContextEstimate(runner.lastTurnTokens, { persistActual: true });
    } else if (runner.lastTurnMessagesEstimate > 0) {
      setContextEstimate(runner.lastTurnMessagesEstimate);
    }
    if (runner.totalPromptTokens > 0 || runner.totalCompletionTokens > 0) {
      tokenCounter.addUsage(runner.totalPromptTokens, runner.totalCompletionTokens);
    }

    stopSpinner();
    // Clear stale midTurnSteerRequested if the run completed normally
    // (prevents ghost steers if abort raced with completion)
    midTurnSteerRequested = false;
    if (statusBar) {
      statusBar.stopTiming();
      statusBar.update({
        sessionIn: tokenCounter.sessionTokens?.input || 0,
        sessionOut: tokenCounter.sessionTokens?.output || 0,
        contextTokens: projectedContextTokens,
        contextPct: contextPercentForTokens(projectedContextTokens, modelRegistry.getContextLimit())
      });
    }
    console.log('\n');

    // Clear abort controller before processAIResponse so the plan review
    // prompt isn't hijacked by the mid-turn steering keypress handler.
    currentAbortController = null;

    if (agenticSteeringCount > 0) {
      clearSteeringMessages();
    }

    if (fullResponse) {
      let cleaned = fullResponse;
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
      cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
      cleaned = cleaned.replace(/^[\s\S]*?<\/think>\s*/i, '');
      cleaned = cleaned.replace(/^[\s\S]*?<\/thinking>\s*/i, '');
      await processAIResponse(cleaned.trim(), rawMessage || message, {
        skipTokenEstimate: true,
        executeActions: false
      });
    }

    // afterTurn hooks
    if (hookManager && fullResponse) {
      try {
        const hookResults = await hookManager.runHooks('afterTurn', {
          response: fullResponse,
          files: runner.getWrittenFiles(),
          conversationHistory
        });
        for (const hr of hookResults) {
          if (hr.result && hr.inject) {
            queueSteeringMessage(hr.result);
          }
        }
      } catch (hookErr) {
        // Hook failures never break the main flow
      }
    }

  } catch (error) {
    stopSpinner();
    currentAbortController = null;
    if (error.name === 'AbortError') {
      if (midTurnSteerRequested) {
        midTurnSteerRequested = false;
        console.log(`\n${PAD}${c.cyan}Steering update applied. Continuing...${c.reset}`);
        return await sendAgenticMessage(message, images, rawMessage);
      }
      console.log(`\n\n${c.yellow}⚠ Request cancelled${c.reset}\n`);
      return;
    }
    // onError hooks (non-abort errors)
    if (hookManager) {
      try {
        await hookManager.runHooks('onError', { error });
      } catch {
        // Hook failures never break the main flow
      }
    }
    throw error;
  }
  currentAbortController = null;
}

async function sendNonStreamingMessage(message, images = [], rawMessage = '') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const modeColors = { work: c.cyan, plan: c.cyan, ask: c.magenta };
  let i = 0;
  let spinTick = 0;
  if (statusBar) statusBar.startTiming();
  const spinner = setInterval(() => {
    process.stdout.write(`\r${borderRenderer.prefix('thinking')}${modeColors[interactionMode]}${frames[i]} ${c.dim}Ripley is thinking...${c.reset}`);
    i = (i + 1) % frames.length;
    spinTick++;
    if (statusBar && spinTick % 10 === 0) {
      statusBar.render();
    }
  }, 80);

  try {
    // Determine prompt - mirror agentic path's model-specific logic
    let promptMode;
    if (interactionMode === 'ask') {
      promptMode = 'base';
    } else {
      const compactModelPrompt = modelRegistry.getPrompt();
      if (promptManager.has(compactModelPrompt)) {
        promptMode = compactModelPrompt;
      } else if (promptManager.has('code-agent')) {
        promptMode = 'code-agent';
      } else {
        promptMode = activePrompt;
      }
    }

    // Build messages array
    const messages = [];
    const systemPrompt = promptManager.get(promptMode);
    const compactInstructions = config.getInstructions();
    let fullSystemPrompt = systemPrompt || '';
    if (compactInstructions) {
      fullSystemPrompt += `\n\n## Project Instructions (from ${compactInstructions.source})\n\n${compactInstructions.content}`;
    }
    if (fullSystemPrompt) {
      messages.push({ role: 'system', content: fullSystemPrompt });
    }
    messages.push(...conversationHistory);
    const nonStreamSteeringCount = appendQueuedSteeringMessages(messages);

    // Handle vision
    if (images.length > 0 && modelRegistry.currentSupportsVision()) {
      messages.push(visionAnalyzer.buildMultimodalMessage(message, images));
    } else {
      messages.push({ role: 'user', content: message });
    }
    setContextEstimate(estimatePromptTokensForMessages(messages, { reserveTokens: 64 }));

    const compactInferenceSettings = modelRegistry.getInferenceSettings();
    const activeClient = await getActiveClient();
    const compactModelMeta = modelRegistry.getCurrentModel();
    const data = await activeClient.chat(messages, {
      model: modelRegistry.getCurrentId(),
      temperature: compactInferenceSettings.temperature,
      topP: compactInferenceSettings.topP,
      repeatPenalty: compactInferenceSettings.repeatPenalty,
      reasoningEffort: compactModelMeta?.reasoningEffort
    });
    const usage = data.usage || {};
    const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    if (promptTokens > 0) {
      setContextEstimate(promptTokens, { persistActual: true });
    }

    clearInterval(spinner);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const reply = data.choices?.[0]?.message?.content || '';

    if (statusBar) statusBar.stopTiming();
    const { renderMarkdown } = require('./lib/markdownRenderer');
    console.log(`\n${borderRenderer.prefix('ai')}${c.cyan}Ripley →${c.reset} `);
    console.log(renderMarkdown(reply));
    console.log();

    if (nonStreamSteeringCount > 0) clearSteeringMessages();
    await processAIResponse(reply, message);

  } catch (error) {
    clearInterval(spinner);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    throw error;
  }
}

async function processAIResponse(reply, originalMessage, options = {}) {
  const executeActions = options.executeActions !== false;

  // Track tokens (skip when exact API usage was already added)
  if (!options.skipTokenEstimate) {
    tokenCounter.trackUsage(originalMessage, reply);
  }

  // Update status bar with session token info (context values set by refreshIdleContextEstimate)
  if (statusBar) {
    statusBar.update({
      sessionIn: tokenCounter.sessionTokens?.input || 0,
      sessionOut: tokenCounter.sessionTokens?.output || 0
    });
  }

  // In plan mode: save plan, then interactive review flow
  if (interactionMode === 'plan') {
    // Save plan to file for reference
    const planPath = path.join(projectDir, '.ripley', 'plan.md');
    const ripleyDir = path.join(projectDir, '.ripley');
    if (!fs.existsSync(ripleyDir)) {
      fs.mkdirSync(ripleyDir, { recursive: true });
    }
    fs.writeFileSync(planPath, reply);
    console.log(`\n${PAD}${c.green}  ✓ Plan saved to .ripley/plan.md${c.reset}`);

    // Update conversation history
    conversationHistory.push({ role: 'user', content: originalMessage });
    conversationHistory.push({ role: 'assistant', content: reply });

    // Interactive review loop
    let reviewing = true;
    while (reviewing) {
      console.log(`${PAD}${c.cyan}┌─ Review Plan ─────────────────────────────${c.reset}`);
      console.log(`${PAD}${c.cyan}│${c.reset} ${c.green}Enter/y${c.reset} = implement  ${c.red}n${c.reset} = reject  ${c.yellow}or type feedback to refine${c.reset}`);
      console.log(`${PAD}${c.cyan}└───────────────────────────────────────────${c.reset}`);
      const reviewInput = await askQuestion(`${PAD}${c.yellow}> ${c.reset}`);
      const trimmed = reviewInput.trim().toLowerCase();

      if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') {
        // Implement the plan
        interactionMode = 'work';
        if (statusBar) statusBar.update({ mode: 'work' });
        console.log(`\n${PAD}${c.cyan}🚀 Implementing plan...${c.reset}\n`);
        await sendMessage(`Please implement this plan:\n\n${reply}\n\nApply the changes now using <file_operation> tags.`);
        reviewing = false;
      } else if (trimmed === 'n' || trimmed === 'no') {
        console.log(`\n${PAD}${c.dim}Plan rejected. Staying in plan mode.${c.reset}\n`);
        reviewing = false;
      } else {
        // Refinement feedback - stay in plan mode, send refinement
        console.log(`\n${PAD}${c.cyan}📋 Refining plan...${c.reset}\n`);
        await sendMessage(`Please refine the plan based on this feedback:\n\n${reviewInput}\n\nThe original plan was:\n\n${reply}`);
        // After refinement, the recursive processAIResponse call handles the next review
        reviewing = false;
      }
    }
    return;
  }

  // Parse response
  const parsed = parseResponse(reply);

  // Handle file operations based on interaction mode
  if (!executeActions) {
    if (parsed.fileOperations.length > 0 || parsed.commands.length > 0) {
      console.log(`${PAD}${c.dim}(action blocks in final text ignored in agentic mode)${c.reset}\n`);
    }
  } else if (parsed.fileOperations.length > 0) {
    if (interactionMode === 'ask') {
      // Ask mode: Ignore file operations completely
      console.log(`${PAD}${c.dim}(${parsed.fileOperations.length} file operation(s) skipped - ASK mode)${c.reset}\n`);
    } else {
      // Code mode: Normal execution
      await handleFileOperations(parsed.fileOperations);
    }
  }

  // Handle commands based on interaction mode
  let commandsExecuted = false;
  if (executeActions && parsed.commands.length > 0) {
    if (interactionMode === 'ask') {
      // Ask mode: Ignore commands completely
      console.log(`${PAD}${c.dim}(${parsed.commands.length} command(s) skipped - ASK mode)${c.reset}\n`);
    } else if (interactionMode === 'plan') {
      // Plan mode: Show commands but don't execute
      console.log(`${PAD}${c.cyan}📋 Commands that would run:${c.reset}`);
      parsed.commands.forEach((cmd, i) => {
        console.log(`${PAD}${c.dim}  ${i + 1}. ${cmd}${c.reset}`);
      });
      console.log();
    } else {
      // Code mode: Normal execution
      commandsExecuted = await handleCommands(parsed.commands);
    }
  }

  // Update conversation history
  conversationHistory.push({ role: 'user', content: originalMessage });
  conversationHistory.push({ role: 'assistant', content: reply });

  // Project next-turn prompt usage and compact before we hit hard limits.
  const projectedNextTokens = estimateNextTurnContextTokens();
  setContextEstimate(projectedNextTokens);
  const ctxLimit = modelRegistry.getContextLimit();
  const compactThreshold = Math.max(
    0.5,
    (config.get('tokenWarningThreshold') || 0.8) - COMPACTION_SAFETY_BUFFER
  );
  if (projectedNextTokens / ctxLimit >= compactThreshold) {
    await compactHistory();
  } else {
    // Trim history if too long (safety fallback)
    const historyLimit = config.get('historyLimit') || 50;
    if (conversationHistory.length > historyLimit) {
      conversationHistory = conversationHistory.slice(-historyLimit);
    }
  }
  refreshIdleContextEstimate();

}

async function handleFileOperations(operations) {
  // Show batched diff view
  console.log(formatOperationsBatch(operations, fileManager));

  // Check for YOLO mode - auto-apply without confirmation
  const yoloMode = config.get('yoloMode');
  let response;

  if (yoloMode) {
    console.log(`${c.orange}  🔥 YOLO: Auto-applying changes...${c.reset}\n`);
    response = 'y';
  } else {
    // Ask for confirmation
    const answer = await askQuestion(`${c.yellow}Apply these changes? (y/n/v for verbose): ${c.reset}`);
    response = answer.toLowerCase().trim();
  }

  if (response === 'y' || response === 'yes') {
    for (const op of operations) {
      try {
        let result;
        switch (op.action) {
          case 'create':
          case 'edit':
            result = fileManager.writeFile(op.path, op.content);
            if (result.success) {
              console.log(`${PAD}${c.green}✓ ${op.action === 'create' ? 'Created' : 'Updated'}: ${op.path}${c.reset}`);
              contextBuilder.loadFile(op.path);
              if (watcher.isEnabled()) watcher.addFile(op.path);
            } else {
              console.log(`${PAD}${c.red}✗ Failed: ${op.path} - ${result.error}${c.reset}`);
            }
            break;

          case 'delete':
            result = fileManager.deleteFile(op.path);
            if (result.success) {
              console.log(`${PAD}${c.green}✓ Deleted: ${op.path}${c.reset}`);
              contextBuilder.unloadFile(op.path);
              watcher.removeFile(op.path);
            } else {
              console.log(`${PAD}${c.red}✗ Failed: ${op.path} - ${result.error}${c.reset}`);
            }
            break;
        }
      } catch (error) {
        console.log(`${PAD}${c.red}✗ Error: ${error.message}${c.reset}`);
      }
    }
    console.log();
  } else if (response === 'v' || response === 'verbose') {
    // Show individual diffs then ask again
    for (const op of operations) {
      const existingContent = fileManager.exists(op.path) ? fileManager.readFile(op.path).content : null;
      const { formatOperation } = require('./lib/diffViewer');
      console.log(formatOperation(op, existingContent));
      console.log();
    }
    return handleFileOperations(operations); // Ask again
  } else {
    console.log(`${PAD}${c.yellow}Changes not applied${c.reset}\n`);
  }
}

/**
 * Pre-process commands to handle directory context
 * - Detects create-next-app/create-react-app and adds cd command
 * - Chains dependent commands properly
 */
function preprocessCommands(commands) {
  const processed = [];
  let projectDir = null;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i].trim();

    // Detect project creation commands that create a subdirectory
    const createAppMatch = cmd.match(/npx\s+create-(?:next|react|vue|vite|nuxt)-app(?:@\S+)?\s+(\S+)/i);
    const mkdirMatch = cmd.match(/^mkdir\s+(\S+)/);

    if (createAppMatch) {
      projectDir = createAppMatch[1];
      processed.push(cmd);
      // If next command doesn't start with cd and needs to run in project dir
      const nextCmd = commands[i + 1];
      if (nextCmd && !nextCmd.trim().startsWith('cd ') && needsProjectDir(nextCmd)) {
        processed.push(`cd ${projectDir}`);
      }
    } else if (mkdirMatch && commands[i + 1]?.includes('cd')) {
      // mkdir followed by cd - keep as is
      processed.push(cmd);
    } else if (cmd.startsWith('cd ')) {
      // Track directory changes
      const cdMatch = cmd.match(/^cd\s+(\S+)/);
      if (cdMatch) projectDir = cdMatch[1];
      processed.push(cmd);
    } else {
      processed.push(cmd);
    }
  }

  return processed;
}

/**
 * Check if a command needs to run in a project directory
 */
function needsProjectDir(cmd) {
  const projectCommands = [
    /^npm\s+(run|install|start|test|build)/i,
    /^npx\s+shadcn/i,
    /^yarn\s+(run|add|start|test|build)?/i,
    /^pnpm\s+(run|add|start|test|build)?/i,
  ];
  return projectCommands.some(pattern => pattern.test(cmd.trim()));
}

async function handleCommands(commands) {
  // Pre-process commands to handle directory changes
  const processedCommands = preprocessCommands(commands);

  console.log(`${c.orange}🔧 Suggested Commands:${c.reset}\n`);

  for (const cmd of processedCommands) {
    console.log(`${PAD}${c.dim}$ ${cmd}${c.reset}`);
  }
  console.log();

  // Check for YOLO mode - auto-run without confirmation
  const yoloMode = config.get('yoloMode');
  let shouldRun;

  if (yoloMode) {
    console.log(`${c.orange}  🔥 YOLO: Auto-running commands...${c.reset}\n`);
    shouldRun = true;
  } else {
    const answer = await askQuestion(`${c.yellow}Run these commands? (y/n): ${c.reset}`);
    shouldRun = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  }

  if (!shouldRun) {
    console.log(`${PAD}${c.yellow}Commands not executed${c.reset}\n`);
    return false;
  }

  if (shouldRun) {
    // Track working directory for cd commands
    let currentCwd = commandRunner.projectDir;

    for (const cmd of processedCommands) {
      // Handle cd commands specially - just change the working directory
      const cdMatch = cmd.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const targetDir = cdMatch[1].trim();
        const newCwd = path.isAbsolute(targetDir)
          ? targetDir
          : path.join(currentCwd, targetDir);

        if (fs.existsSync(newCwd)) {
          currentCwd = newCwd;
          console.log(`\n${PAD}${c.cyan}┌─ ${cmd}${c.reset}`);
          console.log(`${PAD}${c.cyan}└─${c.reset} ${c.green}✓ Changed directory to ${newCwd}${c.reset}`);
        } else {
          console.log(`\n${PAD}${c.cyan}┌─ ${cmd}${c.reset}`);
          console.log(`${PAD}${c.cyan}└─${c.reset} ${c.red}✗ Directory not found: ${newCwd}${c.reset}`);
        }
        continue;
      }

      console.log(`\n${PAD}${c.cyan}┌─ Running: ${cmd}${c.reset}`);
      console.log(`${PAD}${c.cyan}│${c.reset}`);

      if (commandRunner.isDangerous(cmd)) {
        const confirm = await askQuestion(`${c.red}⚠️  This looks dangerous. Type 'yes' to confirm: ${c.reset}`);
        if (confirm.toLowerCase() !== 'yes') {
          console.log(`${PAD}${c.yellow}Skipped${c.reset}`);
          continue;
        }
      }

      // Track elapsed time
      const startTime = Date.now();
      let lastOutputTime = Date.now();
      let lineCount = 0;

      // Spinner for periods of no output
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let frameIndex = 0;
      let spinnerInterval = null;
      let spinnerRestartTimeout = null;
      let commandFinished = false;

      const startSpinner = () => {
        if (spinnerInterval) return;
        spinnerInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          process.stdout.write(`\r${PAD}${c.cyan}│ ${c.dim}${frames[frameIndex]} Working... (${elapsed}s)${c.reset}    `);
          frameIndex = (frameIndex + 1) % frames.length;
        }, 80);
      };

      const stopSpinner = () => {
        if (spinnerInterval) {
          clearInterval(spinnerInterval);
          spinnerInterval = null;
          process.stdout.write('\r' + ' '.repeat(50) + '\r');
        }
      };

      const scheduleSpinnerRestart = () => {
        if (spinnerRestartTimeout) {
          clearTimeout(spinnerRestartTimeout);
        }
        spinnerRestartTimeout = setTimeout(() => {
          if (!commandFinished && Date.now() - lastOutputTime > 2000) {
            startSpinner();
          }
        }, 2000);
      };

      try {
        const result = await commandRunner.run(cmd, {
          cwd: currentCwd,
          onStdout: data => {
            stopSpinner();
            lastOutputTime = Date.now();
            const lines = data.toString().split('\n');
            lines.forEach(line => {
              if (line.trim()) {
                lineCount++;
                console.log(`${PAD}${c.cyan}│${c.reset} ${line}`);
              }
            });
            // Restart spinner if no output for a while
            scheduleSpinnerRestart();
          },
          onStderr: data => {
            stopSpinner();
            lastOutputTime = Date.now();
            const lines = data.toString().split('\n');
            lines.forEach(line => {
              if (line.trim()) {
                console.log(`${PAD}${c.cyan}│${c.reset} ${c.yellow}${line}${c.reset}`);
              }
            });
            scheduleSpinnerRestart();
          }
        });

        commandFinished = true;
        if (spinnerRestartTimeout) {
          clearTimeout(spinnerRestartTimeout);
          spinnerRestartTimeout = null;
        }
        stopSpinner();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`${PAD}${c.cyan}│${c.reset}`);
        if (result.success) {
          console.log(`${PAD}${c.cyan}└─${c.reset} ${c.green}✓ Done${c.reset} ${c.dim}(${elapsed}s)${c.reset}`);
        } else {
          console.log(`${PAD}${c.cyan}└─${c.reset} ${c.red}✗ Failed (exit code ${result.code})${c.reset} ${c.dim}(${elapsed}s)${c.reset}`);
        }
      } catch (error) {
        commandFinished = true;
        if (spinnerRestartTimeout) {
          clearTimeout(spinnerRestartTimeout);
          spinnerRestartTimeout = null;
        }
        stopSpinner();
        console.log(`${PAD}${c.cyan}└─${c.reset} ${c.red}✗ Error: ${error.message}${c.reset}`);
      }
    }
    console.log();
  }

  return true;
}

function askQuestion(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

// =============================================================================
// READLINE WITH HISTORY & COMPLETION
// =============================================================================

function createReadlineInterface() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line) => {
      if (inlineComplete && inlineComplete.consumeAccepted()) {
        return [[], line];
      }
      return completer.complete(line);
    },
    terminal: true
  });

  const repromptWithStatus = () => {
    if (statusBar) statusBar.reinstall();
    rl.prompt(true);
    if (statusBar) statusBar.render();
  };

  // Pre-handle keypress BEFORE readline: clear ghost text, accept on Tab/Right.
  // This fires before readline's internal handler, so the ghost is erased
  // before readline redraws or moves the cursor.
  process.stdin.prependListener('keypress', (char, key) => {
    if (!key) return;
    if (isPickerActive()) return;
    if (!inlineComplete) return;

    if (inlineComplete.hasGhost()) {
      // Erase ghost text from terminal (cursor is before the ghost)
      process.stdout.write('\x1b[K');

      if (key.name === 'tab' && !key.shift) {
        const ghost = inlineComplete.accept(true);
        if (ghost) rl.write(ghost);
        return;
      }

      if (key.name === 'right') {
        const ghost = inlineComplete.accept(false);
        if (ghost) rl.write(ghost);
        return;
      }

      // Any other key: just clear ghost state, readline handles the key normally
      inlineComplete.clearGhost();
    }
  });

  // Handle keypress events: history, mode cycling, clipboard, escape, inline complete
  process.stdin.on('keypress', async (char, key) => {
    if (!key) return;

    // When a picker UI (pick/pickToggle) is active, it owns all keypress
    // events. Don't let the global handler interfere with history, escape, etc.
    if (isPickerActive()) return;

    // Ghost was already cleared in prependListener. Re-suggest after readline processes key.
    if (key.name !== 'return' && key.name !== 'escape' && !key.ctrl) {
      setImmediate(() => {
        if (!rl.line) return;
        // Only show ghost when cursor is at end of line
        if (rl.cursor !== rl.line.length) return;
        const ghost = inlineComplete.suggest(rl.line);
        if (ghost) {
          inlineComplete.renderGhost(ghost);
          // Render dim ghost text after cursor, then move cursor back
          const cols = process.stdout.columns || 120;
          const available = cols - rl.cursor - 10; // rough margin for prompt
          if (available > 0) {
            const show = ghost.length > available ? ghost.slice(0, available) : ghost;
            process.stdout.write(`\x1b[2m${show}\x1b[0m\x1b[${show.length}D`);
          }
        }
      });
    }

    // Repaint status bar after readline processes the keypress.
    // Readline's line editing (especially backspace/delete) can overwrite
    // the bar rows when the prompt line wraps or redraws.
    if (statusBar) {
      setImmediate(() => statusBar.render());
    }

    // --- History navigation ---
    if (key.name === 'up') {
      const prev = historyManager.up(rl.line);
      rl.write(null, { ctrl: true, name: 'u' }); // Clear line
      rl.write(prev);
      return;
    }
    if (key.name === 'down') {
      const next = historyManager.down(rl.line);
      rl.write(null, { ctrl: true, name: 'u' }); // Clear line
      rl.write(next);
      return;
    }

    // --- Shift+Tab: Cycle through modes ---
    if (key.name === 'tab' && key.shift) {
      const modes = ['work', 'plan', 'ask'];
      const currentIndex = modes.indexOf(interactionMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      interactionMode = modes[nextIndex];
      if (statusBar) statusBar.update({ mode: interactionMode });

      const modeColors = { work: c.green, plan: c.cyan, ask: c.magenta };
      const modeIcons = { work: '🔧', plan: '📋', ask: '💬' };
      const modeDescriptions = {
        work: 'Execute file operations and commands',
        plan: 'Explore codebase and build structured plan',
        ask: 'Question-only mode (no operations)'
      };

      // Preserve the user's in-progress text across the mode switch
      const savedInput = rl.line || '';
      process.stdout.write('\x1b[2K\x1b[0G');
      console.log(`${modeColors[interactionMode]}  ${modeIcons[interactionMode]} Mode: ${interactionMode.toUpperCase()}${c.reset} ${c.dim}- ${modeDescriptions[interactionMode]}${c.reset}`);
      rl.write(null, { ctrl: true, name: 'u' });
      repromptWithStatus();
      if (savedInput) rl.write(savedInput);
      return;
    }

    // --- Alt+V: Paste screenshot from clipboard ---
    if (key.name === 'v' && key.meta) {
      process.stdout.write('\n');
      console.log(`${PAD}${c.cyan}📋 Pasting from clipboard...${c.reset}`);

      const result = await imageHandler.pasteFromClipboard();
      if (result.success) {
        const sizeKB = Math.round(result.data.size / 1024);
        console.log(`${PAD}${c.green}✓ Screenshot added (${sizeKB}KB)${c.reset}`);

        if (modelRegistry.currentSupportsVision() || visionAnalyzer.isEnabled()) {
          console.log(`${PAD}${c.dim}Type your question about the screenshot${c.reset}`);
          console.log();
          repromptWithStatus();
        } else {
          // No vision at all - prompt for Gemini API key
          showGeminiKeyPrompt();
        }
      } else {
        console.log(`${PAD}${c.red}✗ ${result.error}${c.reset}`);
        console.log();
        repromptWithStatus();
      }
      return;
    }

    // --- Escape: Cancel Gemini key prompt if active ---
    if (key.name === 'escape' && awaitingGeminiKey) {
      awaitingGeminiKey = false;
      process.stdout.write('\x1b[2K\x1b[0G');
      console.log(`${PAD}${c.dim}Cancelled${c.reset}\n`);
      if (geminiKeyCallback) {
        geminiKeyCallback(false);
        geminiKeyCallback = null;
      }
      showPrompt();
      return;
    }

    // --- Escape handling ---
    if (key.name === 'escape') {
      // During work with prompt visible: single Escape clears typed text
      if (currentAbortController && promptDuringWork && rl.line) {
        rl.write(null, { ctrl: true, name: 'u' }); // Clear typed text
        process.stdout.write('\x1b[2K\x1b[0G');
        rl.prompt(false);
        if (statusBar) statusBar.render();
        return;
      }
      // During ask_human: single Escape clears typed text
      if (pendingHumanQuestion && rl.line) {
        rl.write(null, { ctrl: true, name: 'u' });
        process.stdout.write('\x1b[2K\x1b[0G');
        rl.prompt(false);
        if (statusBar) statusBar.render();
        return;
      }
      // Double Escape: cancel current request
      if (currentAbortController) {
        const now = Date.now();
        if (now - lastEscapeTime < 1000) {
          // Clean up pending question if any
          if (pendingHumanQuestion) {
            pendingHumanQuestion.resolve('(cancelled)');
            pendingHumanQuestion = null;
          }
          currentAbortController.abort();
          lastEscapeTime = 0;
          // Force-clear spinner + prompt lines in case abort doesn't propagate immediately
          if (promptDuringWork) {
            process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
            promptDuringWork = false;
            renderWorkingPrompt = null;
            if (restorePromptFn) restorePromptFn();
            if (statusBar) { statusBar.setInputHint(''); statusBar.render(); }
          }
        } else {
          lastEscapeTime = now;
          // Show cancel hint in the status bar gap row
          if (statusBar) {
            statusBar.setInputHint('Press Esc again to cancel');
            statusBar.render();
            setTimeout(() => {
              if (pendingHumanQuestion) {
                statusBar.setInputHint('Type your answer and press Enter');
              } else if (promptDuringWork) {
                statusBar.setInputHint('Esc\u00d72 to cancel');
              } else {
                statusBar.setInputHint('');
              }
              statusBar.render();
            }, 2000);
          }
        }
      }
      return;
    }

    // --- During work, prompt is always visible - let keystrokes go to readline ---
    if (currentAbortController && promptDuringWork) {
      return;
    }
  });

  // Enable keypress events
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  return rl;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  initDebugLogging();
  const rawArgs = process.argv.slice(2);
  const disableStatusBar = rawArgs.includes('--no-status-bar');
  const args = rawArgs.filter(arg => arg !== '--no-status-bar');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Ripley Code v${VERSION} - AI Coding Agent

Usage:
  ripley              Start interactive mode
  ripley yolo         Start in YOLO mode (auto-apply all changes)
  ripley init         Initialize .ripley config
  ripley <request>    One-shot mode

Options:
  --help, -h          Show this help
  --version, -v       Show version
  --yolo              Start in YOLO mode
  --no-status-bar     Disable the pinned status bar (fallback UI mode)

Examples:
  ripley
  ripley yolo
  ripley "Add a dark mode toggle"
  ripley "Fix the bug in @src/api/auth.ts"
`);
    logSessionEnd('exit', ' code=0 phase=help');
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`Ripley Code v${VERSION}`);
    logSessionEnd('exit', ' code=0 phase=version');
    process.exit(0);
  }

  if (args[0] === 'init') {
    const ripleyDir = path.join(projectDir, '.ripley');
    if (!fs.existsSync(ripleyDir)) {
      fs.mkdirSync(ripleyDir, { recursive: true });
      fs.writeFileSync(
        path.join(ripleyDir, 'config.json'),
        JSON.stringify({ version: VERSION, created: new Date().toISOString() }, null, 2)
      );
      const cfg = new Config(projectDir);
      cfg.createDefaultInstructions();
      console.log(`${PAD}${c.green}✓ Initialized Ripley in ${projectDir}${c.reset}`);
      console.log(`${PAD}${c.dim}Edit RIPLEY.md to customize AI behavior${c.reset}`);
    } else {
      console.log(`${PAD}${c.yellow}Ripley already initialized${c.reset}`);
    }
    logSessionEnd('exit', ' code=0 phase=init');
    process.exit(0);
  }

  // Check for yolo flag to start in YOLO mode
  const startInYolo = args.includes('yolo') || args.includes('--yolo');

  // Show banner and initialize
  await showBanner();
  initProject();
  if (runtimeLogPath) {
    console.log(`${PAD}${c.dim}Logs: ${runtimeLogPath}${c.reset}`);
  }
  if (disableStatusBar) {
    console.log(`${PAD}${c.dim}Status bar disabled (${c.white}--no-status-bar${c.dim})${c.reset}`);
  }

  // Enable YOLO mode if started with 'yolo' argument
  if (startInYolo) {
    config.set('yoloMode', true);
    console.log(`${PAD}${c.red}⚡ YOLO MODE ACTIVE${c.reset} ${c.dim}(auto-applying all changes)${c.reset}`);
  }

  const connected = await checkConnection();
  if (!connected) {
    console.log(`${PAD}${c.yellow}⚠ Starting in setup mode.${c.reset} ${c.dim}Use /connect or /model to switch providers/models.${c.reset}\n`);
  }

  const enableStatusBar = Boolean(process.stdout.isTTY) && !disableStatusBar;
  if (enableStatusBar) {
    // Prepare status bar (but don't install yet - readline resets scroll region)
    statusBar = new StatusBar();
    const mcpIsConnected = await mcpClient.isConnected();
    const initialModel = modelRegistry.getCurrentModel();
    const initialParts = modelDisplayParts(initialModel);
    statusBar.update({
      modelName: `${initialParts.providerLabel}: ${initialModel?.name || '?'}`,
      modelId: modelRegistry.getCurrentId() || '',
      contextLimit: modelRegistry.getContextLimit(),
      mcpConnected: mcpIsConnected,
      mode: interactionMode
    });
    refreshIdleContextEstimate();
  }

  console.log(`\n${PAD}${c.dim}Type ${c.yellow}/help${c.reset}${c.dim} for commands • ${c.yellow}@file${c.reset}${c.dim} to add files • ${c.yellow}/exit${c.reset}${c.dim} to quit${c.reset}\n`);

  // Create readline first, THEN install status bar (readline resets terminal state)
  rl = createReadlineInterface();
  if (statusBar) {
    statusBar.install();
    // Clamp cursor into the scroll region so the first prompt isn't hidden
    // behind the status bar (the startup banner may have pushed it past the
    // scroll boundary).
    const rows = process.stdout.rows || 24;
    const scrollEnd = Math.max(1, rows - (4 /* BAR_HEIGHT */ + 1 /* GAP_ROWS */));
    process.stdout.write(`\x1b[${scrollEnd};1H`);
  }

  // Handle one-shot mode (but not for special commands like init, yolo)
  const specialArgs = ['init', 'yolo', '--yolo'];
  if (args.length > 0 && !specialArgs.includes(args[0])) {
    const request = args.join(' ');
    await sendMessage(request);
    rl.close();
    logSessionEnd('exit', ' code=0 phase=oneshot');
    process.exit(0);
  }

  // Interactive mode
  const getContextPercent = () => {
    const limit = modelRegistry.getContextLimit();
    const usedTokens = projectedContextTokens > 0
      ? projectedContextTokens
      : estimateNextTurnContextTokens();
    const pct = contextPercentForTokens(usedTokens, limit);

    // Color code: green < 50%, yellow 50-79%, red 80%+
    let color = c.green;
    if (pct >= 80) color = c.red;
    else if (pct >= 50) color = c.yellow;

    return `${color}${pct}%${c.reset}`;
  };

  // Shared prompt data used by both the live prompt and the highlighted repaint
  const getPromptData = () => {
    const currentModel = modelRegistry.getCurrentModel();
    const currentParts = modelDisplayParts(currentModel);
    const modelName = currentModel
      ? (currentModel.key.startsWith(`${currentParts.provider}:`)
        ? currentModel.key
        : `${currentParts.provider}:${currentModel.key}`)
      : '?';
    const limit = modelRegistry.getContextLimit();
    const usedTokens = projectedContextTokens > 0
      ? projectedContextTokens
      : estimateNextTurnContextTokens();
    const pct = contextPercentForTokens(usedTokens, limit);
    const modeIcon = { work: '🔧', plan: '📋', ask: '💬' }[interactionMode] || '🔧';
    const think = (thinkingLevel !== 'off' && modelRegistry.currentSupportsThinking()) ? ` 🧠${thinkingLevel}` : '';
    return { modelName, pct, modeIcon, think };
  };

  const getPromptPrefix = () => {
    const { modelName, pct, modeIcon, think } = getPromptData();
    let pctColor = c.green;
    if (pct >= 80) pctColor = c.red;
    else if (pct >= 50) pctColor = c.yellow;
    return `${borderRenderer.prefix('user')}${c.green}${modeIcon}${c.reset} ${c.dim}[${modelName}]${c.reset}${think ? ` ${c.cyan}🧠${c.reset}` : ''} ${c.dim}ctx:${c.reset}${pctColor}${pct}%${c.reset} ${c.orange}You → ${c.reset}`;
  };

  // Expose prompt restoration for mid-turn steering cleanup
  restorePromptFn = () => {
    if (rl) rl.setPrompt(getPromptPrefix());
  };

  // Build a highlighted version of the user prompt for post-submission repaint.
  // Light orange bg, dark text, no ANSI reset conflicts.
  const getHighlightedPrompt = (userText) => {
    const BG = '\x1b[48;2;200;120;40m';
    const FG = '\x1b[38;2;25;12;0m';
    const ACCENT = `\x1b[38;2;100;55;15m`;  // Dimmer accent for metadata
    const { modelName, pct, modeIcon, think } = getPromptData();
    const cols = process.stdout.columns || 120;
    const bgRow = `${BG}${' '.repeat(cols)}\x1b[0m`;
    const content = `${BG}${FG}  │ ${modeIcon} [${modelName}]${think} ${ACCENT}ctx:${pct}%${FG} You → ${userText}\x1b[K\x1b[0m`;
    return `${bgRow}\n${content}\n${bgRow}`;
  };

  const runStartupUiSelfCheck = () => {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 0;
    const rows = process.stdout.rows || 0;
    const warnings = [];

    if (rows > 0 && rows < 10) warnings.push(`terminal height is tight (${rows} rows)`);
    if (cols > 0 && cols < 60) warnings.push(`terminal width is tight (${cols} cols)`);

    const promptWidth = borderRenderer.stripAnsi(getPromptPrefix()).length;
    if (cols > 0 && promptWidth >= Math.max(1, cols - 2)) {
      warnings.push(`prompt prefix is too wide (${promptWidth}/${cols})`);
    }

    if (statusBar && rows > 0 && rows < 8) {
      warnings.push(`status bar has limited room (${rows} rows total)`);
    }

    if (missingColorTokens.size > 0) {
      warnings.push(`unknown color token(s): ${Array.from(missingColorTokens).join(', ')}`);
    }

    if (warnings.length === 0) {
      appendDebugLog(`[ui-check] ok rows=${rows} cols=${cols} statusBar=${statusBar ? 'on' : 'off'}\n`);
      return;
    }

    console.log(`${PAD}${c.yellow}âš  UI self-check warning(s): ${warnings.join('; ')}${c.reset}`);
    if (statusBar) {
      console.log(`${PAD}${c.dim}Tip: relaunch with --no-status-bar if this terminal still glitches.${c.reset}`);
    }
    appendDebugLog(`[ui-check] warn rows=${rows} cols=${cols} statusBar=${statusBar ? 'on' : 'off'} ${warnings.join(' | ')}\n`);
  };

  // Paste detection: buffer rapid lines and combine them into one message.
  // When pasting multi-line text, readline fires the callback for the first line,
  // then subsequent lines arrive as new 'line' events. We detect paste by
  // buffering lines that arrive within PASTE_DELAY_MS of each other.
  const PASTE_DELAY_MS = 80;
  let pasteBuffer = [];
  let pasteTimer = null;
  let waitingForInput = false;

  showGeminiKeyPrompt = (callback) => {
    awaitingGeminiKey = true;
    geminiKeyCallback = callback || null;
    console.log(`\n${PAD}${c.yellow}No Gemini API key set${c.reset}`);
    console.log(`${PAD}${c.dim}Vision needs either a vision model or a Gemini API key.${c.reset}`);
    console.log(`${PAD}${c.dim}Get a free key at: ${c.cyan}https://aistudio.google.com/apikey${c.reset}`);
    console.log();
    waitingForInput = true;
    rl.setPrompt(`${PAD}${c.cyan}Paste API key (Enter/Esc to skip): ${c.reset}`);
    rl.prompt(false);
    if (statusBar) statusBar.render();
  };

  const saveGeminiKey = (key) => {
    const globalDir = path.join(os.homedir(), '.ripley');
    const globalConfigPath = path.join(globalDir, 'config.json');
    try {
      fs.mkdirSync(globalDir, { recursive: true });
      let gc = {};
      if (fs.existsSync(globalConfigPath)) {
        gc = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
      }
      gc.geminiApiKey = key;
      fs.writeFileSync(globalConfigPath, JSON.stringify(gc, null, 2));
    } catch {}
    visionAnalyzer = new VisionAnalyzer({ apiKey: key });
    console.log(`\n${PAD}${c.green}✓ Gemini API key saved globally${c.reset}`);
    console.log(`${PAD}${c.dim}Vision is now enabled for all projects${c.reset}\n`);
  };

  const processInput = async (fullInput) => {
    // Handle Gemini API key input
    if (awaitingGeminiKey) {
      awaitingGeminiKey = false;
      const key = fullInput.split('\n')[0].trim();
      if (key) {
        saveGeminiKey(key);
        if (geminiKeyCallback) geminiKeyCallback(true);
      } else {
        console.log(`\n${PAD}${c.dim}Skipped${c.reset}\n`);
        if (geminiKeyCallback) geminiKeyCallback(false);
      }
      geminiKeyCallback = null;
      showPrompt();
      return;
    }

    const trimmed = fullInput.trim();

    if (!trimmed) {
      showPrompt();
      return;
    }

    // Add to history (first line only for multi-line pastes)
    const firstLine = trimmed.split('\n')[0];
    historyManager.add(firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine);
    historyManager.resetIndex();

    // Handle bare "exit" or "quit" without slash
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      await handleCommand('/exit');
      return;
    }

    // Check for commands (only if single line - don't treat pasted text as commands)
    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      const handled = await handleCommand(trimmed);
      if (!handled) {
        console.log(`\n${PAD}${c.dim}Unknown command. Type /help or /commands for available commands.${c.reset}\n`);
      }
      if (!awaitingGeminiKey) showPrompt();
      return;
    }

    // Repaint submitted input as a highlighted bar with vertical padding.
    process.stdout.write(`\x1b[A\r${getHighlightedPrompt(trimmed)}\n\n`);

    // Send message to AI
    await sendMessage(trimmed);
    showPrompt();
  };

  const flushPasteBuffer = async () => {
    // Stop accepting lines while we process this input
    waitingForInput = false;
    const fullInput = pasteBuffer.join('\n');
    const lineCount = pasteBuffer.length;
    pasteBuffer = [];
    pasteTimer = null;

    if (lineCount > 1) {
      console.log(`${PAD}${c.dim}(pasted ${lineCount} lines)${c.reset}`);
    }

    await processInput(fullInput);
  };

  // Steering paste buffer: collects rapid lines during mid-turn steering
  // so multi-line pastes become a single steering message.
  let steerPasteBuffer = [];
  let steerPasteTimer = null;

  const flushSteerPasteBuffer = () => {
    const fullText = steerPasteBuffer.join('\n').trim();
    const lineCount = steerPasteBuffer.length;
    steerPasteBuffer = [];
    steerPasteTimer = null;

    // If request already finished, discard
    if (!currentAbortController) return;

    if (!fullText) return;

    // Strip /steer prefix if they used it out of habit
    const cleanText = fullText.replace(/^\/steer(?:ing)?\s+/i, '');
    if (cleanText) {
      if (lineCount > 1 && promptDuringWork) {
        // Print paste indicator above spinner+prompt
        process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
        console.log(`${PAD}${c.dim}(pasted ${lineCount} lines as steering)${c.reset}`);
        if (renderWorkingPrompt) renderWorkingPrompt();
      }
      if (requestMidTurnSteer(cleanText)) {
        if (promptDuringWork) {
          process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          console.log(`${PAD}${c.cyan}Steering received. Redirecting...${c.reset}`);
          if (renderWorkingPrompt) renderWorkingPrompt();
        } else {
          console.log(`${PAD}${c.cyan}Steering received. Redirecting...${c.reset}\n`);
        }
      } else {
        if (promptDuringWork) {
          process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          console.log(`${PAD}${c.yellow}Could not apply steering.${c.reset}`);
          if (renderWorkingPrompt) renderWorkingPrompt();
        } else {
          console.log(`${PAD}${c.yellow}Could not apply steering.${c.reset}\n`);
        }
      }
    }
  };

  const handleLine = (input) => {
    // Only accept input when we're actually waiting for it.
    // This prevents output from commands, model switching, pickers, etc.
    // from being treated as user input.
    if (!waitingForInput) {
      // ask_human: resolve pending question with user's answer
      if (pendingHumanQuestion) {
        const answer = String(input || '').trim() || '(no answer)';
        const { resolve } = pendingHumanQuestion;
        pendingHumanQuestion = null;
        resolve(answer);
        return;
      }

      // Mid-turn steering: user typed while agent was working
      if (currentAbortController) {
        const trimmed = String(input || '').trim();

        if (!trimmed) {
          // Empty Enter: restore spinner+prompt layout.
          // After readline's Enter, cursor is at N+2. Layout:
          //   N:   spinner
          //   N+1: > (empty prompt)
          //   N+2: [cursor - readline's newline]
          // Move up to spinner line (N), clear all 3 lines, re-render.
          if (promptDuringWork) {
            process.stdout.write('\x1b[A\x1b[2K\x1b[A\x1b[2K\x1b[0G');
            // Clear the leftover line at N+2 as well
            process.stdout.write('\x1b[B\x1b[B\x1b[2K\x1b[A\x1b[A\x1b[0G');
            if (renderWorkingPrompt) renderWorkingPrompt();
          }
          return;
        }

        // Buffer lines for paste support, then process as steering
        steerPasteBuffer.push(trimmed);
        if (steerPasteTimer) clearTimeout(steerPasteTimer);
        steerPasteTimer = setTimeout(flushSteerPasteBuffer, PASTE_DELAY_MS);

        // Fix layout: readline added a newline after submitted text.
        // Cursor at N+2, spinner at N, old prompt+text at N+1.
        // Move to spinner line, clear all, re-render spinner+prompt.
        if (promptDuringWork) {
          process.stdout.write('\x1b[A\x1b[2K\x1b[A\x1b[2K\x1b[0G');
          process.stdout.write('\x1b[B\x1b[B\x1b[2K\x1b[A\x1b[A\x1b[0G');
          if (renderWorkingPrompt) renderWorkingPrompt();
        }
      }
      return;
    }

    pasteBuffer.push(input);

    // Reset the timer each time a new line arrives
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => flushPasteBuffer(), PASTE_DELAY_MS);
  };

  const showPrompt = () => {
    waitingForInput = true;
    refreshIdleContextEstimate();
    if (statusBar) statusBar.reinstall();
    const prefix = getPromptPrefix();
    rl.setPrompt(prefix);
    rl.prompt(false);
    if (statusBar) statusBar.render();
  };

  // Use 'line' event instead of rl.question() to catch all pasted lines
  rl.on('line', (input) => {
    handleLine(input);
  });

  const prompt = () => {
    showPrompt();
  };

  // Repaint prompt + bar after terminal resize when idle.
  // The StatusBar already handles its own resize (scroll region + bar repaint).
  // We only need to refresh the readline prompt on the current line, clearing
  // the old one first so we don't leave duplicate prompt ghosts on screen.
  let resizeRefreshTimer = null;
  process.stdout.on('resize', () => {
    if (resizeRefreshTimer) clearTimeout(resizeRefreshTimer);
    resizeRefreshTimer = setTimeout(() => {
      // During work with prompt visible: re-render prompt on resize
      if (promptDuringWork && currentAbortController) {
        if (renderWorkingPrompt) {
          // Re-render both spinner and prompt for new terminal width
          process.stdout.write('\x1b[2K\x1b[0G\x1b[A\x1b[2K\x1b[0G');
          renderWorkingPrompt();
        } else {
          rl.prompt(true);
        }
        if (statusBar) statusBar.render();
        return;
      }
      if (!waitingForInput) return;
      if (currentAbortController) return;
      // Clear the current line (old prompt text) before redrawing
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      // Refresh context estimate and prompt prefix, but skip reinstalling the
      // status bar (its own resize handler already did that).
      refreshIdleContextEstimate();
      const prefix = getPromptPrefix();
      rl.setPrompt(prefix);
      rl.prompt(true);  // preserveCursor: keep any text the user was typing
      if (statusBar) statusBar.render();
    }, 150);  // Run after StatusBar's 80ms debounce so scroll region is settled
  });

  runStartupUiSelfCheck();
  prompt();
  // Some terminals drop the first prompt paint; force one follow-up refresh.
  setTimeout(() => {
    if (!waitingForInput) return;
    if (currentAbortController) return;
    showPrompt();
  }, 20);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logSessionEnd('SIGINT');
  if (statusBar) statusBar.uninstall();
  if (config && config.get('autoSaveHistory') && conversationHistory.length > 0) {
    config.saveConversation('autosave', conversationHistory);
  }
  if (watcher) watcher.stop();
  console.log(`\n${PAD}${c.cyan}👋 See you later!${c.reset}\n`);
  process.exit(0);
});

main().catch(error => {
  logSessionEnd('crash', ` error=${error.message}`);
  if (statusBar) statusBar.uninstall();
  console.error(`${c.red}Fatal error: ${error.message}${c.reset}`);
  if (watcher) watcher.stop();
  process.exit(1);
});

process.on('exit', (code) => {
  logSessionEnd('exit', ` code=${code}`);
});

