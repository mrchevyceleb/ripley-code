#!/usr/bin/env node

/**
 * Ripley Code v4.0.0 - Your local AI coding agent
 *
 * Direct to LM Studio - no middleware needed.
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
const { formatOperationsBatch, formatCompactSummary, colors: c } = require('./lib/diffViewer');
const { MarkdownRenderer } = require('./lib/markdownRenderer');
const LmStudio = require('./lib/lmStudio');
const PromptManager = require('./lib/promptManager');
const ModelRegistry = require('./lib/modelRegistry');
const { AgenticRunner, setMcpClient } = require('./lib/agenticRunner');
const McpClient = require('./lib/mcpClient');
const { pick } = require('./lib/interactivePicker');

// =============================================================================
// CONFIGURATION
// =============================================================================

const VERSION = '4.0.0';

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
let lmStudio = null;
let promptManager = null;
let modelRegistry = null;
let mcpClient = null;
let conversationHistory = [];
let lastKnownTokens = 0; // Track actual token usage from API responses
let rl = null;

// Interaction modes: 'code' (default), 'plan' (preview only), 'ask' (no operations)
let interactionMode = 'code';

// Active prompt name (default: 'base', user can switch with /prompt)
let activePrompt = 'base';

// Thinking mode: when enabled, models that support it will reason before answering
let thinkingMode = false;

// Abort controller for cancelling requests with Escape (double-press)
let currentAbortController = null;
let lastEscapeTime = 0;

// =============================================================================
// ASCII ART & UI
// =============================================================================

function showBanner() {
  console.clear();
  console.log(`
${c.orange}
    ██████╗ ██╗██████╗ ██╗     ███████╗██╗   ██╗
    ██╔══██╗██║██╔══██╗██║     ██╔════╝╚██╗ ██╔╝
    ██████╔╝██║██████╔╝██║     █████╗   ╚████╔╝
    ██╔══██╗██║██╔═══╝ ██║     ██╔══╝    ╚██╔╝
    ██║  ██║██║██║     ███████╗███████╗   ██║
    ╚═╝  ╚═╝╚═╝╚═╝     ╚══════╝╚══════╝   ╚═╝
${c.reset}
${c.cyan}    ═══════════════════════════════════════════${c.reset}
${c.dim}    Ripley Code • v${VERSION} • Direct to LM Studio${c.reset}
${c.cyan}    ═══════════════════════════════════════════${c.reset}
`);
}

function showHelp() {
  console.log(`
${c.orange}${c.dim}File Commands:${c.reset}
${c.yellow}  /files${c.reset}              List files in context
${c.yellow}  /read <path>${c.reset}        Add file to context (or use @filename)
${c.yellow}  /unread <path>${c.reset}      Remove file from context
${c.yellow}  /tree${c.reset}               Show project structure
${c.yellow}  /find <pattern>${c.reset}     Find files matching pattern
${c.yellow}  /grep <text>${c.reset}        Search for text in files
${c.yellow}  /image <path>${c.reset}       Add image (vision model or Gemini fallback)

${c.orange}${c.dim}Git Commands:${c.reset}
${c.yellow}  /git${c.reset}                Show git status
${c.yellow}  /diff${c.reset}               Show uncommitted changes
${c.yellow}  /log${c.reset}                Show recent commits

${c.orange}${c.dim}Session Commands:${c.reset}
${c.yellow}  /clear${c.reset}              Clear conversation & context
${c.yellow}  /clearhistory${c.reset}       Clear conversation only
${c.yellow}  /save <name>${c.reset}        Save conversation
${c.yellow}  /load <name>${c.reset}        Load saved conversation
${c.yellow}  /sessions${c.reset}           List saved sessions
${c.yellow}  /context${c.reset}            Show context size & tokens
${c.yellow}  /tokens${c.reset}             Show token usage this session
${c.yellow}  /compact${c.reset}            Toggle compact mode
${c.yellow}  /think${c.reset}              Toggle thinking mode (gpt-oss reasons before answering)

${c.orange}${c.dim}Modes:${c.reset}
${c.yellow}  /plan${c.reset}               Toggle PLAN mode (creates plan, no code)
${c.yellow}  /implement${c.reset}          Execute the saved plan
${c.yellow}  /ask${c.reset}                Toggle ASK mode (questions only, no file ops)
${c.yellow}  /mode${c.reset}               Show current mode
${c.yellow}  /yolo${c.reset}               Toggle YOLO mode (auto-apply all changes)
${c.yellow}  /agent${c.reset}              Show agentic mode info (always on)
${c.yellow}  /model [name]${c.reset}      Show/switch model (nemotron, coder, max, vision...)
${c.yellow}  /prompt [name]${c.reset}     Show/switch prompt (base, code-agent, or any .md)

${c.orange}${c.dim}Config Commands:${c.reset}
${c.yellow}  /config${c.reset}             Show current config
${c.yellow}  /set <key> <value>${c.reset}  Update config setting
${c.yellow}  /instructions${c.reset}       Edit project instructions
${c.yellow}  /mcp${c.reset}                Show MCP server status & tools
${c.yellow}  /watch${c.reset}              Toggle file watch mode
${c.yellow}  /stream${c.reset}             Toggle streaming mode

${c.orange}${c.dim}System Commands:${c.reset}
${c.yellow}  /run <cmd>${c.reset}          Run a shell command
${c.yellow}  /undo${c.reset}               Show recent backups
${c.yellow}  /restore <path>${c.reset}     Restore file from backup
${c.yellow}  /commands${c.reset}           List custom commands (~/.ripley/Commands/)
${c.yellow}  /version${c.reset}            Show version
${c.yellow}  /help${c.reset}               Show this help
${c.yellow}  /exit${c.reset}               Exit Ripley

${c.orange}${c.dim}Tips:${c.reset}
${c.gray}  • Use ${c.cyan}@filename${c.gray} in messages to auto-load files
${c.gray}  • Press ${c.cyan}↑${c.gray}/${c.cyan}↓${c.gray} to navigate command history
${c.gray}  • Press ${c.cyan}Tab${c.gray} for completion
${c.gray}  • Press ${c.cyan}Shift+Tab${c.gray} to cycle modes (code → plan → ask)
${c.gray}  • Press ${c.cyan}Alt+V${c.gray} to paste screenshot from clipboard
${c.gray}  • Press ${c.cyan}Esc Esc${c.gray} to cancel current request
${c.gray}  • Create ${c.cyan}RIPLEY.md${c.gray} in your project root for project-specific AI instructions
${c.reset}
`);
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
  tokenCounter = new TokenCounter(config);
  imageHandler = new ImageHandler(projectDir);

  // Initialize LM Studio client
  const lmStudioUrl = config.get('lmStudioUrl') || 'http://localhost:1234';
  lmStudio = new LmStudio({ baseUrl: lmStudioUrl });

  // Initialize prompt manager (loads .md files from prompts/ directory)
  const promptsDir = path.join(__dirname, 'prompts');
  promptManager = new PromptManager(promptsDir);

  // Initialize model registry
  const modelsPath = path.join(__dirname, 'models.json');
  modelRegistry = new ModelRegistry(modelsPath, lmStudio);

  // Restore last active model from config
  const savedModel = config.get('activeModel');
  if (savedModel && modelRegistry.get(savedModel)) {
    modelRegistry.setCurrent(savedModel);
  } else {
    modelRegistry.setCurrent(modelRegistry.getDefault());
  }

  // Restore active prompt from config
  activePrompt = config.get('activePrompt') || 'base';

  // Try to get Gemini API key from: 1) project config, 2) global config, 3) env var
  let geminiKey = config.get('geminiApiKey');
  if (!geminiKey) {
    const globalConfigPath = path.join(__dirname, '.ripley', 'config.json');
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
      console.log(`\n${c.dim}  📁 ${file} ${type}${c.reset}`);
    },
    onError: (file, error) => {
      console.log(`\n${c.red}  ⚠ Watch error: ${file}: ${error.message}${c.reset}`);
    }
  });

  // Get project summary
  const summary = contextBuilder.getSummary();

  console.log(`${c.green}  ✓${c.reset} Project: ${c.white}${path.basename(projectDir)}${c.reset}`);
  console.log(`${c.green}  ✓${c.reset} Files: ${summary.sourceFiles} source files in ${summary.totalDirs} directories`);

  // Load priority files
  contextBuilder.loadPriorityFiles();
  console.log(`${c.green}  ✓${c.reset} Context: ${contextBuilder.getLoadedFiles().length} files loaded`);

  // Check for project instructions (RIPLEY.md or .ripley/instructions.md)
  const instructions = config.getInstructions();
  if (instructions) {
    console.log(`${c.green}  ✓${c.reset} Project instructions loaded ${c.dim}(${instructions.source})${c.reset}`);
  }

  // Show model info
  const currentModel = modelRegistry.getCurrentModel();
  if (currentModel) {
    console.log(`${c.green}  ✓${c.reset} Model: ${c.white}${currentModel.name}${c.reset} ${c.dim}(${currentModel.key})${c.reset}`);
  }

  // Show prompt info
  console.log(`${c.green}  ✓${c.reset} Prompt: ${c.white}${activePrompt}${c.reset} ${c.dim}(${promptManager.list().length} available)${c.reset}`);

  // Vision capability
  if (modelRegistry.currentSupportsVision()) {
    console.log(`${c.green}  ✓${c.reset} Vision: local model (direct)`);
  } else if (visionAnalyzer.isEnabled()) {
    console.log(`${c.green}  ✓${c.reset} Vision: Gemini fallback`);
  } else {
    console.log(`${c.dim}  ○ Vision disabled (no vision model or GEMINI_API_KEY)${c.reset}`);
  }

  // Initialize MCP client
  const mcpUrl = config.get('mcpUrl') || process.env.MCP_SERVER_URL || null;
  mcpClient = new McpClient(mcpUrl ? { url: mcpUrl } : {});
  setMcpClient(mcpClient);

  console.log(`${c.cyan}  ✓${c.reset} Mode: always agentic ${c.dim}(reads files on demand, streams final response)${c.reset}`);
}

async function checkConnection() {
  const connected = await lmStudio.isConnected();
  if (connected) {
    console.log(`${c.green}  ✓${c.reset} LM Studio: Connected (${lmStudio.baseUrl})`);

    // Auto-discover model IDs
    const discovery = await modelRegistry.discover();
    if (discovery.matched > 0) {
      console.log(`${c.green}  ✓${c.reset} Models: ${discovery.matched} matched from ${discovery.total} loaded`);
    }
  } else {
    console.log(`${c.red}  ✗${c.reset} Cannot connect to LM Studio at ${lmStudio.baseUrl}`);
    console.log(`${c.dim}    Make sure LM Studio is running${c.reset}\n`);
    return false;
  }

  // Check MCP server connection
  const mcpConnected = await mcpClient.isConnected();
  if (mcpConnected) {
    const status = mcpClient.getStatus();
    const serverLabel = status.serverName ? `${status.serverName}` : 'assistant-mcp';
    console.log(`${c.green}  ✓${c.reset} MCP: ${serverLabel} ${c.dim}(${status.url})${c.reset}`);
  } else {
    console.log(`${c.yellow}  ○${c.reset} MCP: Not connected ${c.dim}(${mcpClient.url})${c.reset}`);
    console.log(`${c.dim}    Tools like get_tasks, get_calendar will fail. Set mcpUrl with /set${c.reset}`);
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
  constructor(maxWidth = null) {
    // Use terminal width minus some padding, or default to 80
    this.maxWidth = maxWidth || Math.min(process.stdout.columns - 4 || 76, 100);
    this.currentLineLength = 0;
    this.wordBuffer = '';
  }

  write(text) {
    let output = '';

    for (const char of text) {
      if (char === '\n') {
        // Flush word buffer and reset line
        output += this.wordBuffer + '\n';
        this.wordBuffer = '';
        this.currentLineLength = 0;
      } else if (char === ' ' || char === '\t') {
        // Word boundary - check if we need to wrap
        if (this.currentLineLength + this.wordBuffer.length + 1 > this.maxWidth && this.currentLineLength > 0) {
          // Wrap to new line
          output += '\n' + this.wordBuffer + char;
          this.currentLineLength = this.wordBuffer.length + 1;
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
    console.log(`\n${c.dim}  No custom commands directory found at ${COMMANDS_DIR}${c.reset}\n`);
    return;
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.log(`\n${c.dim}  No custom commands found in ${COMMANDS_DIR}${c.reset}\n`);
    return;
  }

  console.log(`\n${c.cyan}  Custom Commands${c.reset} ${c.dim}(${COMMANDS_DIR})${c.reset}\n`);
  for (const file of files) {
    const name = file.replace('.md', '');
    // Read first non-empty, non-heading line as description
    const content = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const desc = lines[0] || '';
    console.log(`  ${c.green}/${name}${c.reset}  ${c.dim}${desc.slice(0, 60)}${c.reset}`);
  }
  console.log();
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
      console.log(`\n${c.cyan}  Checking for updates...${c.reset}`);
      const { execSync } = require('child_process');
      try {
        const result = execSync('npm install -g mrchevyceleb/ripley-code', {
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        console.log(`${c.green}  ✓ Updated! Restart Ripley to use the new version.${c.reset}\n`);
      } catch (err) {
        console.log(`${c.red}  ✗ Update failed: ${err.message}${c.reset}\n`);
      }
      return true;
    }

    case '/version':
    case '/v':
      console.log(`\n${c.cyan}  Ripley Code v${VERSION}${c.reset}\n`);
      return true;

    case '/files':
    case '/ls':
      const files = contextBuilder.getLoadedFiles();
      if (files.length === 0) {
        console.log(`\n${c.dim}  No files in context${c.reset}\n`);
      } else {
        console.log(`\n${c.cyan}  Files in context (${files.length}):${c.reset}`);
        files.forEach(f => console.log(`${c.dim}    • ${f}${c.reset}`));
        console.log();
      }
      return true;

    case '/read':
    case '/add':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /read <filepath>${c.reset}\n`);
        return true;
      }
      if (args.includes('*')) {
        const { glob } = require('glob');
        try {
          const matches = await glob(args, { cwd: projectDir, nodir: true });
          if (matches.length === 0) {
            console.log(`\n${c.yellow}  No files matched: ${args}${c.reset}\n`);
          } else {
            let count = 0;
            for (const file of matches.slice(0, 20)) {
              const result = contextBuilder.loadFile(file);
              if (result.success && !result.alreadyLoaded) {
                count++;
                if (watcher.isEnabled()) watcher.addFile(file);
              }
            }
            console.log(`\n${c.green}  ✓ Added ${count} files to context${c.reset}\n`);
          }
        } catch (error) {
          console.log(`\n${c.red}  ✗ Invalid pattern: ${error.message}${c.reset}\n`);
        }
      } else {
        const readResult = contextBuilder.loadFile(args);
        if (readResult.success) {
          if (readResult.alreadyLoaded) {
            console.log(`\n${c.yellow}  File already in context: ${args}${c.reset}\n`);
          } else {
            console.log(`\n${c.green}  ✓ Added to context: ${args}${c.reset}\n`);
            if (watcher.isEnabled()) watcher.addFile(args);
          }
        } else {
          console.log(`\n${c.red}  ✗ ${readResult.error}${c.reset}\n`);
        }
      }
      return true;

    case '/unread':
    case '/remove':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /unread <filepath>${c.reset}\n`);
        return true;
      }
      const unreadResult = contextBuilder.unloadFile(args);
      if (unreadResult.success) {
        console.log(`\n${c.green}  ✓ Removed from context: ${args}${c.reset}\n`);
        watcher.removeFile(args);
      } else {
        console.log(`\n${c.red}  ✗ ${unreadResult.error}${c.reset}\n`);
      }
      return true;

    case '/tree':
      const structure = contextBuilder.scanDirectory();
      const tree = contextBuilder.buildTreeString(structure);
      console.log(`\n${c.cyan}  Project Structure:${c.reset}\n`);
      console.log(tree);
      return true;

    case '/find':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /find <pattern>${c.reset}\n`);
        return true;
      }
      try {
        const { glob } = require('glob');
        const matches = await glob(args, { cwd: projectDir, nodir: true, ignore: ['node_modules/**', '.git/**'] });
        if (matches.length === 0) {
          console.log(`\n${c.dim}  No files found matching: ${args}${c.reset}\n`);
        } else {
          console.log(`\n${c.cyan}  Files matching "${args}" (${matches.length}):${c.reset}`);
          matches.slice(0, 30).forEach(f => console.log(`${c.dim}    ${f}${c.reset}`));
          if (matches.length > 30) console.log(`${c.dim}    ... and ${matches.length - 30} more${c.reset}`);
          console.log();
        }
      } catch (error) {
        console.log(`\n${c.red}  ✗ ${error.message}${c.reset}\n`);
      }
      return true;

    case '/grep':
    case '/search':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /grep <text>${c.reset}\n`);
        return true;
      }
      console.log(`\n${c.dim}  Searching for "${args}"...${c.reset}`);
      try {
        const results = await searchInFiles(args);
        if (results.length === 0) {
          console.log(`${c.dim}  No matches found${c.reset}\n`);
        } else {
          console.log(`\n${c.cyan}  Found ${results.length} matches:${c.reset}`);
          results.slice(0, 20).forEach(r => {
            console.log(`${c.green}  ${r.file}${c.reset}:${c.yellow}${r.line}${c.reset}`);
            console.log(`${c.dim}    ${r.text.trim().substring(0, 80)}${c.reset}`);
          });
          if (results.length > 20) console.log(`${c.dim}  ... and ${results.length - 20} more${c.reset}`);
          console.log();
        }
      } catch (error) {
        console.log(`${c.red}  ✗ ${error.message}${c.reset}\n`);
      }
      return true;

    case '/image':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /image <path>${c.reset}`);
        console.log(`${c.dim}  Add an image to the next message (for vision models)${c.reset}\n`);
        return true;
      }
      const imgResult = imageHandler.addImage(args);
      if (imgResult.success) {
        console.log(`\n${c.green}  ✓ Image queued: ${args}${c.reset}`);
        console.log(`${c.dim}  Will be included in your next message${c.reset}\n`);
      } else {
        console.log(`\n${c.red}  ✗ ${imgResult.error}${c.reset}\n`);
      }
      return true;

    case '/git':
    case '/status':
      try {
        const result = await commandRunner.git('status --short');
        if (result.success) {
          if (result.stdout) {
            console.log(`\n${c.cyan}  Git Status:${c.reset}`);
            console.log(result.stdout.split('\n').map(l => `  ${l}`).join('\n'));
            console.log();
          } else {
            console.log(`\n${c.green}  ✓ Working tree clean${c.reset}\n`);
          }
        } else {
          console.log(`\n${c.dim}  Not a git repository${c.reset}\n`);
        }
      } catch {
        console.log(`\n${c.dim}  Git not available${c.reset}\n`);
      }
      return true;

    case '/diff':
      try {
        const result = await commandRunner.git('diff --stat');
        if (result.success && result.stdout) {
          console.log(`\n${c.cyan}  Uncommitted Changes:${c.reset}`);
          console.log(result.stdout.split('\n').map(l => `  ${l}`).join('\n'));
          console.log();
        } else {
          console.log(`\n${c.dim}  No uncommitted changes${c.reset}\n`);
        }
      } catch {
        console.log(`\n${c.dim}  Git not available${c.reset}\n`);
      }
      return true;

    case '/log':
      try {
        const result = await commandRunner.git('log --oneline -10');
        if (result.success && result.stdout) {
          console.log(`\n${c.cyan}  Recent Commits:${c.reset}`);
          console.log(result.stdout.split('\n').map(l => `  ${l}`).join('\n'));
          console.log();
        } else {
          console.log(`\n${c.dim}  No commits yet${c.reset}\n`);
        }
      } catch {
        console.log(`\n${c.dim}  Git not available${c.reset}\n`);
      }
      return true;

    case '/clear':
      conversationHistory = [];
      lastKnownTokens = 0;
      contextBuilder.clearFiles();
      contextBuilder.loadPriorityFiles();
      tokenCounter.resetSession();
      imageHandler.clearPending();
      console.log(`\n${c.green}  ✓ Cleared conversation and reset context${c.reset}\n`);
      return true;

    case '/clearhistory':
      conversationHistory = [];
      lastKnownTokens = 0;
      tokenCounter.resetSession();
      console.log(`\n${c.green}  ✓ Cleared conversation history${c.reset}\n`);
      return true;

    case '/save':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /save <session-name>${c.reset}\n`);
        return true;
      }
      const savedFile = config.saveConversation(args, conversationHistory);
      console.log(`\n${c.green}  ✓ Saved session: ${savedFile}${c.reset}\n`);
      return true;

    case '/load':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /load <session-file>${c.reset}\n`);
        return true;
      }
      const loadedHistory = config.loadConversation(args);
      if (loadedHistory) {
        conversationHistory = loadedHistory;
        console.log(`\n${c.green}  ✓ Loaded ${loadedHistory.length} messages${c.reset}\n`);
      } else {
        console.log(`\n${c.red}  ✗ Session not found: ${args}${c.reset}\n`);
      }
      return true;

    case '/sessions':
      const sessions = config.listConversations();
      if (sessions.length === 0) {
        console.log(`\n${c.dim}  No saved sessions${c.reset}\n`);
      } else {
        console.log(`\n${c.cyan}  Saved Sessions:${c.reset}`);
        sessions.slice(0, 10).forEach(s => {
          const date = new Date(s.savedAt).toLocaleDateString();
          console.log(`${c.dim}    • ${s.filename} (${s.messageCount} messages, ${date})${c.reset}`);
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

      console.log(`\n${c.cyan}  Context Summary:${c.reset}`);
      console.log(`${c.dim}    Files loaded: ${loadedFiles.length}${c.reset}`);
      console.log(`${c.dim}    Characters: ${charCount.toLocaleString()}${c.reset}`);
      console.log(`${c.dim}    Est. tokens: ~${tokenEstimate.toLocaleString()}${c.reset}`);
      if (limit.isWarning) {
        console.log(`${c.yellow}    ⚠ ${Math.round(limit.percentage * 100)}% of token limit${c.reset}`);
      }
      console.log(`${c.dim}    Compact mode: ${config.get('compactMode') ? 'ON' : 'OFF'}${c.reset}`);
      console.log(`${c.dim}    Streaming: ${config.get('streamingEnabled') ? 'ON' : 'OFF'}${c.reset}`);
      console.log(`${c.dim}    Watch mode: ${watcher.isEnabled() ? 'ON' : 'OFF'}${c.reset}`);
      console.log();
      return true;

    case '/tokens':
      const usage = tokenCounter.getSessionUsage();
      console.log(`\n${c.cyan}  Token Usage This Session:${c.reset}`);
      console.log(`${c.dim}    Input:  ${tokenCounter.formatCount(usage.input)}${c.reset}`);
      console.log(`${c.dim}    Output: ${tokenCounter.formatCount(usage.output)}${c.reset}`);
      console.log(`${c.dim}    Total:  ${tokenCounter.formatCount(usage.total)}${c.reset}`);
      console.log();
      return true;

    case '/think':
      if (!modelRegistry.currentSupportsThinking()) {
        console.log(`\n${c.yellow}  ⚠ Current model (${modelRegistry.getCurrent()}) doesn't support thinking mode.${c.reset}`);
        console.log(`${c.dim}  Switch to gpt-oss (/model gpt-oss) to use thinking.${c.reset}\n`);
      } else {
        thinkingMode = !thinkingMode;
        const thinkIcon = thinkingMode ? `${c.cyan}🧠 ON${c.reset}` : `${c.dim}OFF${c.reset}`;
        console.log(`\n${c.green}  ✓ Thinking mode: ${thinkIcon}${c.reset}`);
        if (thinkingMode) {
          console.log(`${c.dim}  gpt-oss will reason before responding. Slower but smarter.${c.reset}`);
        }
        console.log();
      }
      return true;

    case '/compact':
      const newCompact = !config.get('compactMode');
      config.set('compactMode', newCompact);
      console.log(`\n${c.green}  ✓ Compact mode: ${newCompact ? 'ON' : 'OFF'}${c.reset}\n`);
      return true;

    case '/stream':
      const newStream = !config.get('streamingEnabled');
      config.set('streamingEnabled', newStream);
      console.log(`\n${c.green}  ✓ Streaming: ${newStream ? 'ON' : 'OFF'}${c.reset}\n`);
      return true;

    case '/watch':
      if (watcher.isEnabled()) {
        watcher.stop();
        console.log(`\n${c.green}  ✓ Watch mode: OFF${c.reset}\n`);
      } else {
        watcher.start();
        console.log(`\n${c.green}  ✓ Watch mode: ON${c.reset}`);
        console.log(`${c.dim}    Watching ${watcher.getWatchedFiles().length} files${c.reset}\n`);
      }
      return true;

    case '/yolo':
      const newYolo = !config.get('yoloMode');
      config.set('yoloMode', newYolo);
      if (newYolo) {
        console.log(`\n${c.orange}  🔥 YOLO MODE: ON${c.reset}`);
        console.log(`${c.dim}    File changes and commands will be applied automatically without confirmation.${c.reset}`);
        console.log(`${c.dim}    Dangerous commands still require typing 'yes'.${c.reset}\n`);
      } else {
        console.log(`\n${c.green}  ✓ YOLO mode: OFF${c.reset}`);
        console.log(`${c.dim}    Back to normal confirmation prompts.${c.reset}\n`);
      }
      return true;

    case '/agent':
      console.log(`\n${c.cyan}  Ripley is always agentic.${c.reset}`);
      console.log(`${c.dim}    The AI reads files on demand and streams the final response.${c.reset}\n`);
      return true;

    case '/plan':
      if (interactionMode === 'plan') {
        interactionMode = 'code';
        console.log(`\n${c.green}  ✓ Switched to CODE mode${c.reset}`);
        console.log(`${c.dim}    File operations and commands will be executed normally.${c.reset}\n`);
      } else {
        interactionMode = 'plan';
        console.log(`\n${c.cyan}  📋 PLAN MODE: ON${c.reset}`);
        console.log(`${c.dim}    AI will create a plan (saved to .ripley/plan.md) instead of code.${c.reset}`);
        console.log(`${c.dim}    Use /implement to execute the plan, or /plan to switch back.${c.reset}\n`);
      }
      return true;

    case '/implement':
      const planPath = path.join(projectDir, '.ripley', 'plan.md');
      if (!fs.existsSync(planPath)) {
        console.log(`\n${c.yellow}  No plan found. Use /plan mode first to create one.${c.reset}\n`);
        return true;
      }
      const planContent = fs.readFileSync(planPath, 'utf-8');
      console.log(`\n${c.cyan}  📋 Plan to implement:${c.reset}\n`);
      console.log(planContent.split('\n').map(l => `  ${l}`).join('\n'));
      console.log();

      const confirmImpl = await askQuestion(`${c.yellow}Implement this plan? (y/n): ${c.reset}`);
      if (confirmImpl.toLowerCase() === 'y' || confirmImpl.toLowerCase() === 'yes') {
        // Switch to code mode and send the plan for implementation
        const prevMode = interactionMode;
        interactionMode = 'code';
        console.log(`\n${c.cyan}  🚀 Implementing plan...${c.reset}\n`);
        await sendMessage(`Please implement this plan:\n\n${planContent}\n\nApply the changes now using <file_operation> tags.`);
        interactionMode = prevMode;
      } else {
        console.log(`${c.dim}  Plan not implemented.${c.reset}\n`);
      }
      return true;

    case '/ask':
      if (interactionMode === 'ask') {
        interactionMode = 'code';
        console.log(`\n${c.green}  ✓ Switched to CODE mode${c.reset}`);
        console.log(`${c.dim}    File operations and commands will be executed normally.${c.reset}\n`);
      } else {
        interactionMode = 'ask';
        console.log(`\n${c.magenta}  💬 ASK MODE: ON${c.reset}`);
        console.log(`${c.dim}    Question-only mode - AI will answer questions without generating code operations.${c.reset}`);
        console.log(`${c.dim}    Use /ask again to switch back to code mode.${c.reset}\n`);
      }
      return true;

    case '/mode':
      const modeColors = { code: c.green, plan: c.cyan, ask: c.magenta };
      const modeIcons = { code: '⚡', plan: '📋', ask: '💬' };
      console.log(`\n  Current mode: ${modeColors[interactionMode]}${modeIcons[interactionMode]} ${interactionMode.toUpperCase()}${c.reset}`);
      console.log(`${c.dim}    /plan - Preview changes without executing${c.reset}`);
      console.log(`${c.dim}    /ask  - Question-only mode (no operations)${c.reset}`);
      console.log(`${c.dim}    Use /plan or /ask again to return to code mode${c.reset}\n`);
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
          console.log(`${c.green}  ✓ Prompt: ${selectedPrompt.key}${c.reset}\n`);
        } else {
          console.log(`${c.dim}  Cancelled${c.reset}\n`);
        }
        return true;
      }

      if (!promptManager.has(requestedPrompt)) {
        console.log(`\n${c.red}  Unknown prompt: "${requestedPrompt}". Available: ${promptManager.list().join(', ')}${c.reset}\n`);
        return true;
      }

      activePrompt = requestedPrompt;
      config.set('activePrompt', requestedPrompt);
      console.log(`\n${c.green}  ✓ Prompt: ${requestedPrompt}${c.reset}\n`);
      return true;

    case '/model':
    case '/models':
      const modelArg = args.trim().toLowerCase();

      // Helper: switch model in registry + LM Studio
      async function switchModel(modelKey) {
        const oldModel = modelRegistry.getCurrentModel();
        modelRegistry.setCurrent(modelKey);
        config.set('activeModel', modelKey);
        lastKnownTokens = 0; // Reset context counter for new model
        const switched = modelRegistry.getCurrentModel();

        console.log(`${c.green}  ✓ Model: ${switched.name}${c.reset} ${c.dim}(${switched.key})${c.reset}`);

        // Show auto-prompt switch
        const autoPrompt = modelRegistry.getPrompt();
        if (promptManager.has(autoPrompt)) {
          console.log(`${c.dim}  Prompt: ${autoPrompt}${c.reset}`);
        }

        // Load model in LM Studio (unload old one first)
        if (switched.id && (!oldModel || switched.id !== oldModel.id)) {
          try {
            // Unload old model by finding its real instance ID
            const loaded = await lmStudio.getLoadedInstances();
            for (const inst of loaded) {
              try {
                await lmStudio.unloadModel(inst.instanceId);
                console.log(`${c.dim}  Unloaded ${inst.displayName || inst.key}${c.reset}`);
              } catch (err) {
                console.log(`${c.yellow}  ⚠ Could not unload ${inst.key}: ${err.message}${c.reset}`);
              }
            }
            console.log(`${c.dim}  Loading ${switched.name} in LM Studio...${c.reset}`);
            const result = await lmStudio.loadModel(switched.id);
            console.log(`${c.green}  ✓ Loaded in ${result.load_time_seconds?.toFixed(1)}s${c.reset}`);
          } catch (err) {
            console.log(`${c.yellow}  ⚠ Could not auto-load: ${err.message}${c.reset}`);
            console.log(`${c.dim}  Load it manually in LM Studio${c.reset}`);
          }
        }

        if (switched.tags?.includes('max-quality')) {
          console.log(`${c.yellow}  ⚠ This model may be slow (spills to CPU)${c.reset}`);
        }
        if (switched.tags?.includes('vision')) {
          console.log(`${c.green}  ✓ Vision enabled (local)${c.reset}`);
        }
        console.log();
      }

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

        const selected = await pick(pickerItems, { title: 'Switch Model' });
        if (selected) {
          await switchModel(selected.key);
        } else {
          console.log(`${c.dim}  Cancelled${c.reset}\n`);
        }
        return true;
      }

      try {
        await switchModel(modelArg);
      } catch (err) {
        console.log(`\n${c.red}  ✗ ${err.message}${c.reset}\n`);
      }
      return true;

    case '/mcp':
      console.log(`\n${c.cyan}  MCP Server Status${c.reset}`);
      try {
        const mcpConnected = await mcpClient.isConnected();
        const mcpStatus = mcpClient.getStatus();

        if (mcpConnected) {
          const serverLabel = mcpStatus.serverName || 'assistant-mcp';
          const serverVer = mcpStatus.serverVersion ? ` v${mcpStatus.serverVersion}` : '';
          console.log(`${c.green}  ✓ Connected${c.reset} to ${serverLabel}${serverVer}`);
          console.log(`${c.dim}    URL: ${mcpStatus.url}${c.reset}`);
          if (mcpStatus.sessionId) {
            console.log(`${c.dim}    Session: ${mcpStatus.sessionId}${c.reset}`);
          }

          // List available tools
          try {
            const tools = await mcpClient.listTools();
            console.log(`\n${c.cyan}  Available Tools (${tools.length}):${c.reset}`);
            for (const tool of tools) {
              console.log(`${c.yellow}    ${tool.name}${c.reset}${tool.description ? ` ${c.dim}- ${tool.description.slice(0, 60)}${c.reset}` : ''}`);
            }
          } catch (toolErr) {
            console.log(`\n${c.yellow}  Could not list tools: ${toolErr.message}${c.reset}`);
          }
        } else {
          console.log(`${c.red}  ✗ Not connected${c.reset}`);
          console.log(`${c.dim}    URL: ${mcpStatus.url}${c.reset}`);
          console.log(`${c.dim}    Set URL: /set mcpUrl <url>${c.reset}`);
        }
      } catch (mcpErr) {
        console.log(`${c.red}  ✗ Error: ${mcpErr.message}${c.reset}`);
      }
      console.log();
      return true;

    case '/config':
      const allConfig = config.getAll();
      console.log(`\n${c.cyan}  Configuration:${c.reset}`);
      Object.entries(allConfig).forEach(([key, value]) => {
        const displayValue = Array.isArray(value) ? `[${value.length} items]` : String(value);
        console.log(`${c.dim}    ${key}: ${c.white}${displayValue}${c.reset}`);
      });
      console.log();
      return true;

    case '/set':
      const setParts = args.split(/\s+/);
      if (setParts.length < 2) {
        console.log(`\n${c.yellow}  Usage: /set <key> <value>${c.reset}`);
        console.log(`${c.dim}  Example: /set compactMode true${c.reset}\n`);
        return true;
      }
      const [setKey, ...setValueParts] = setParts;
      let setValue = setValueParts.join(' ');
      // Parse booleans and numbers
      if (setValue === 'true') setValue = true;
      else if (setValue === 'false') setValue = false;
      else if (!isNaN(Number(setValue))) setValue = Number(setValue);

      config.set(setKey, setValue);
      console.log(`\n${c.green}  ✓ Set ${setKey} = ${setValue}${c.reset}\n`);
      return true;

    case '/instructions':
      const existingInstructions = config.getInstructions();
      if (existingInstructions) {
        console.log(`\n${c.cyan}  Project Instructions (${existingInstructions.source}):${c.reset}`);
        const preview = existingInstructions.content.substring(0, 500);
        console.log(`${c.dim}${preview}${existingInstructions.content.length > 500 ? '...' : ''}${c.reset}`);
        const editPath = existingInstructions.source === 'RIPLEY.md'
          ? path.join(projectDir, 'RIPLEY.md')
          : path.join(projectDir, '.ripley', 'instructions.md');
        console.log(`\n${c.dim}  Edit: ${editPath}${c.reset}\n`);
      } else {
        config.createDefaultInstructions();
        console.log(`\n${c.green}  ✓ Created RIPLEY.md${c.reset}`);
        console.log(`${c.dim}  Edit: ${path.join(projectDir, 'RIPLEY.md')}${c.reset}\n`);
      }
      return true;

    case '/run':
    case '/exec':
    case '/$':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /run <command>${c.reset}\n`);
        return true;
      }
      console.log(`\n${c.dim}  Running: ${args}${c.reset}\n`);
      try {
        const result = await commandRunner.run(args, {
          onStdout: data => process.stdout.write(data),
          onStderr: data => process.stderr.write(data)
        });
        console.log(`\n${result.success ? c.green : c.red}  Exit code: ${result.code}${c.reset}\n`);
      } catch (error) {
        console.log(`\n${c.red}  Error: ${error.message}${c.reset}\n`);
      }
      return true;

    case '/undo':
    case '/backups':
      const backups = fileManager.getBackups();
      if (backups.length === 0) {
        console.log(`\n${c.dim}  No backups available${c.reset}\n`);
      } else {
        console.log(`\n${c.cyan}  Recent backups:${c.reset}`);
        backups.slice(0, 10).forEach(b => {
          const time = new Date(b.timestamp).toLocaleString();
          console.log(`${c.dim}    • ${b.name} (${time})${c.reset}`);
        });
        console.log();
      }
      return true;

    case '/restore':
      if (!args) {
        console.log(`\n${c.yellow}  Usage: /restore <filepath>${c.reset}\n`);
        return true;
      }
      const restoreResult = fileManager.restoreLatest(args);
      if (restoreResult.success) {
        console.log(`\n${c.green}  ✓ Restored: ${restoreResult.restored}${c.reset}\n`);
      } else {
        console.log(`\n${c.red}  ✗ ${restoreResult.error}${c.reset}\n`);
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
      console.log(`\n${c.cyan}  👋 See you later!${c.reset}\n`);
      process.exit(0);

    case '/commands':
      listCustomCommands();
      return true;

    default:
      // Check for custom commands in ~/.ripley/Commands/
      const customResult = loadCustomCommand(cmd);
      if (customResult) {
        console.log(`\n${c.cyan}  Running custom command: ${customResult.name}${c.reset}`);
        console.log(`${c.dim}  Source: ${customResult.source}${c.reset}\n`);
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

  console.log(`\n${c.yellow}  ⚡ Auto-compacting context...${c.reset}`);

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
    const data = await lmStudio.chat(summaryMessages, {
      model: modelRegistry.getCurrentId(),
      temperature: 0.3,
      maxTokens: 1500,
      thinking: false
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
    console.log(`${c.green}  ✓ Context compacted (summary + last 2 turns retained)${c.reset}\n`);
  } catch (err) {
    // Fallback: just trim to last 20 messages
    conversationHistory = conversationHistory.slice(-20);
    console.log(`${c.yellow}  ⚠ Compaction failed (${err.message}), trimmed to 20 messages${c.reset}\n`);
  }
}

async function sendMessage(message) {
  // Load @ mentioned files
  const loadedFromMentions = await loadMentionedFiles(message);
  if (loadedFromMentions.length > 0) {
    console.log(`${c.dim}  Loaded: ${loadedFromMentions.join(', ')}${c.reset}`);
  }

  // Check for pending images and analyze them with vision AI
  const pendingImages = imageHandler.consumePendingImages();
  let imageAnalysis = '';

  if (pendingImages.length > 0) {
    console.log(`${c.dim}  Including ${pendingImages.length} image(s)${c.reset}`);

    if (modelRegistry.currentSupportsVision()) {
      // Local vision model - images will be sent directly as multimodal content
      console.log(`${c.green}  ✓ Using local vision model${c.reset}`);
    } else if (visionAnalyzer.isEnabled()) {
      // Gemini fallback - convert images to text analysis
      console.log(`${c.cyan}  🔍 Analyzing image(s) with Gemini...${c.reset}`);
      const analysis = await visionAnalyzer.analyzeImages(pendingImages, message);
      if (analysis) {
        imageAnalysis = visionAnalyzer.formatForPrompt(analysis);
        console.log(`${c.green}  ✓ Image analysis complete${c.reset}`);
      } else {
        console.log(`${c.yellow}  ⚠ Image analysis failed, sending without description${c.reset}`);
      }
    } else {
      console.log(`${c.yellow}  ⚠ No vision capability (load a vision model or set GEMINI_API_KEY)${c.reset}`);
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

  let fullMessage = `## Project Overview\n\nWorking directory: ${projectDir}\n\nFiles available (use read_file to examine if needed):\n${fileList.slice(0, 20).join('\n')}${fileList.length > 20 ? `\n... and ${fileList.length - 20} more (use list_files to explore)` : ''}`;

  // NOTE: Project instructions (RIPLEY.md) are now injected in the system prompt,
  // not here in the user message. This gives them higher priority with local models.

  if (imageAnalysis) {
    fullMessage += `\n\n## Image Analysis\n\n${imageAnalysis}`;
  }

  fullMessage += `\n\n## Request\n\n${message}${systemNote}`;

  try {
    await sendAgenticMessage(fullMessage, pendingImages, message);
  } catch (error) {
    console.log(`\n${c.red}  ✗ Error: ${error.message}${c.reset}`);
    console.log(`${c.dim}    Make sure LM Studio is running at ${lmStudio.baseUrl}${c.reset}\n`);
  }
}

async function sendStreamingMessage(message, images = [], rawMessage = '') {
  // Fun thinking messages that rotate while generating
  const thinkingMessages = [
    'Brewing some code...',
    'Consulting the matrix...',
    'Waking up neurons...',
    'Channeling the code spirits...',
    'Asking the rubber duck...',
    'Compiling thoughts...',
    'Searching the codeverse...',
    'Summoning syntax...',
    'Debugging reality...',
    'Caffeinating...',
    'Reading the docs (jk)...',
    'Connecting synapses...',
    'Loading creativity...',
    'Thinking really hard...',
    'Almost there...'
  ];
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

    // Change message every ~2 seconds (20 ticks at 100ms)
    if (tickCount % 20 === 0) {
      const messages = isGenerating ? generatingMessages : thinkingMessages;
      messageIndex = (messageIndex + 1) % messages.length;
    }

    const messages = isGenerating ? generatingMessages : thinkingMessages;
    const currentMessage = messages[messageIndex % messages.length];
    const tokenInfo = isGenerating ? ` ${c.dim}(${tokenCount} tokens)${c.reset}` : '';
    const statusText = `${c.cyan}  ${spinnerFrames[spinnerIndex]} ${currentMessage}${c.reset}${tokenInfo}`;

    // Save cursor, move to status line, clear and write, restore cursor
    if (isGenerating) {
      // During generation: show status on same line, don't interfere with output
      // We'll show a brief status that doesn't disrupt the flow
    } else {
      // During initial thinking: show on current line
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(statusText);
      statusLineLength = statusText.length;
    }
  };

  // Start the status animation
  const startThinking = () => {
    process.stdout.write(`\n${c.cyan}  ${spinnerFrames[0]} ${thinkingMessages[0]}${c.reset}`);
    statusInterval = setInterval(updateStatus, 100);
  };

  // Transition to generating mode (first token received)
  const startGenerating = () => {
    isGenerating = true;
    messageIndex = 0;
    tickCount = 0;
    // Clear the thinking line and show AI label on same line
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${c.cyan}Ripley →${c.reset} `);
  };

  const stopStatus = () => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  };

  // Determine which prompt to use
  let promptMode;
  if (interactionMode === 'plan' && promptManager.has('plan')) {
    promptMode = 'plan';
  } else if (interactionMode === 'ask') {
    promptMode = 'base';
  } else {
    promptMode = activePrompt;
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

  // Handle vision: if current model supports vision and we have images, use multimodal
  if (images.length > 0 && modelRegistry.currentSupportsVision()) {
    messages.push(visionAnalyzer.buildMultimodalMessage(message, images));
  } else {
    messages.push({ role: 'user', content: message });
  }

  // Create abort controller for this request
  currentAbortController = new AbortController();

  // Start the fun thinking animation
  startThinking();

  const streamInferenceSettings = modelRegistry.getInferenceSettings();
  const response = await lmStudio.chatStream(messages, {
    model: modelRegistry.getCurrentId(),
    temperature: streamInferenceSettings.temperature,
    topP: streamInferenceSettings.topP,
    repeatPenalty: streamInferenceSettings.repeatPenalty,
    signal: currentAbortController.signal
  });

  let fullResponse = '';
  let firstTokenReceived = false;
  const wordWrapper = new StreamingWordWrapper();
  const markdownRenderer = new MarkdownRenderer();

  const streamHandler = new StreamHandler({
    onToken: (token) => {
      // Transition from thinking to generating on first token
      if (!firstTokenReceived) {
        firstTokenReceived = true;
        startGenerating();
      }
      tokenCount++;
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
    },
    onError: (error) => {
      stopStatus();
      console.log(`\n${c.red}  Stream error: ${error.message}${c.reset}`);
    }
  });

  try {
    await streamHandler.handleStream(response);
  } catch (error) {
    stopStatus();
    // Check if this was an abort
    if (error.name === 'AbortError') {
      currentAbortController = null;
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

  // Process the response
  await processAIResponse(fullResponse, message);
}

async function sendAgenticMessage(message, images = [], rawMessage = '') {
  const markdownRenderer = new MarkdownRenderer();
  const wordWrapper = new StreamingWordWrapper();

  const toolMessages = {
    read_file: '📖 Reading',
    list_files: '📁 Listing',
    search_code: '🔍 Searching',
    create_file: '✍️  Writing',
    edit_file: '✏️  Editing',
    run_command: '⚡ Running'
  };

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  let statusInterval = null;
  let currentStatus = 'Thinking...';
  let toolCallsDisplayed = [];
  let streamingStarted = false;

  const updateSpinner = () => {
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${c.cyan}  ${spinnerFrames[spinnerIndex]} ${currentStatus}${c.reset}`);
  };

  const startSpinner = () => {
    process.stdout.write(`\n${c.cyan}  ${spinnerFrames[0]} ${currentStatus}${c.reset}`);
    statusInterval = setInterval(updateSpinner, 100);
  };

  const stopSpinner = () => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
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

  if (images.length > 0 && modelRegistry.currentSupportsVision()) {
    messages.push(visionAnalyzer.buildMultimodalMessage(message, images));
  } else {
    messages.push({ role: 'user', content: message });
  }

  startSpinner();

  try {
    const runner = new AgenticRunner(lmStudio, {
      onToolCall: (tool, args) => {
        const toolMsg = toolMessages[tool] || '🔧 Using';
        const detail = args.path || args.pattern || args.command || '';
        currentStatus = `${toolMsg} ${detail}...`;
        updateSpinner();
        toolCallsDisplayed.push({ tool, args });
      },
      onToolResult: (tool, success) => {
        // Spinner continues
      },
      onToken: (token) => {
        // First token: stop spinner, print header, start streaming
        if (!streamingStarted) {
          streamingStarted = true;
          stopSpinner();

          // Show tool call summary
          if (toolCallsDisplayed.length > 0) {
            console.log(`${c.dim}┌─ ${toolCallsDisplayed.length} action(s)${c.reset}`);
            for (const tc of toolCallsDisplayed) {
              const icon = toolMessages[tc.tool]?.split(' ')[0] || '🔧';
              console.log(`${c.dim}│ ${icon} ${tc.args.path || tc.args.pattern || tc.args.command || tc.tool}${c.reset}`);
            }
            console.log(`${c.dim}└─${c.reset}`);
          }

          process.stdout.write(`${c.cyan}Ripley →${c.reset} `);
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
        stopSpinner();
        console.log(`${c.dim}┌─ 🧠 Reasoning${c.reset}`);
        const lines = reasoning.trim().split('\n');
        for (const line of lines) {
          console.log(`${c.dim}│ ${line}${c.reset}`);
        }
        console.log(`${c.dim}└─${c.reset}\n`);
      },
      onWarning: (msg) => {
        console.log(`\n${c.yellow}  ⚠ ${msg}${c.reset}`);
      }
    });

    // Use model-specific inference settings
    currentAbortController = new AbortController();
    const inferenceSettings = modelRegistry.getInferenceSettings();
    const fullResponse = await runner.run(messages, projectDir, {
      model: modelRegistry.getCurrentId(),
      temperature: inferenceSettings.temperature,
      topP: inferenceSettings.topP,
      repeatPenalty: inferenceSettings.repeatPenalty,
      thinking: thinkingMode && modelRegistry.currentSupportsThinking(),
      signal: currentAbortController.signal
    });

    // Update context usage from actual API token count
    if (runner.totalTokens > 0) {
      lastKnownTokens = runner.totalTokens;
    }

    stopSpinner();
    console.log('\n');

    if (fullResponse) {
      let cleaned = fullResponse;
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
      cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
      cleaned = cleaned.replace(/^[\s\S]*?<\/think>\s*/i, '');
      cleaned = cleaned.replace(/^[\s\S]*?<\/thinking>\s*/i, '');
      await processAIResponse(cleaned.trim(), rawMessage || message);
    }

  } catch (error) {
    stopSpinner();
    currentAbortController = null;
    if (error.name === 'AbortError') {
      console.log(`\n\n${c.yellow}  ⚠ Request cancelled${c.reset}\n`);
      return;
    }
    throw error;
  }
  currentAbortController = null;
}

async function sendNonStreamingMessage(message, images = [], rawMessage = '') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const modeColors = { code: c.cyan, plan: c.cyan, ask: c.magenta };
  let i = 0;
  const spinner = setInterval(() => {
    process.stdout.write(`\r${modeColors[interactionMode]}  ${frames[i]} ${c.dim}Ripley is thinking...${c.reset}`);
    i = (i + 1) % frames.length;
  }, 80);

  try {
    // Determine prompt
    let promptMode;
    if (interactionMode === 'ask') {
      promptMode = 'base';
    } else {
      promptMode = activePrompt;
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

    // Handle vision
    if (images.length > 0 && modelRegistry.currentSupportsVision()) {
      messages.push(visionAnalyzer.buildMultimodalMessage(message, images));
    } else {
      messages.push({ role: 'user', content: message });
    }

    const compactInferenceSettings = modelRegistry.getInferenceSettings();
    const data = await lmStudio.chat(messages, {
      model: modelRegistry.getCurrentId(),
      temperature: compactInferenceSettings.temperature,
      topP: compactInferenceSettings.topP,
      repeatPenalty: compactInferenceSettings.repeatPenalty
    });

    clearInterval(spinner);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const reply = data.choices?.[0]?.message?.content || '';

    const { renderMarkdown } = require('./lib/markdownRenderer');
    console.log(`\n${c.cyan}Ripley →${c.reset} `);
    console.log(renderMarkdown(reply));
    console.log();

    await processAIResponse(reply, message);

  } catch (error) {
    clearInterval(spinner);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    throw error;
  }
}

async function processAIResponse(reply, originalMessage) {
  // Track tokens
  tokenCounter.trackUsage(originalMessage, reply);

  // In plan mode, save the plan to file and don't parse for operations
  if (interactionMode === 'plan') {
    const planPath = path.join(projectDir, '.ripley', 'plan.md');
    const ripleyDir = path.join(projectDir, '.ripley');
    if (!fs.existsSync(ripleyDir)) {
      fs.mkdirSync(ripleyDir, { recursive: true });
    }
    fs.writeFileSync(planPath, reply);
    console.log(`\n${c.green}  ✓ Plan saved to .ripley/plan.md${c.reset}`);
    console.log(`${c.cyan}  Use /implement to execute this plan${c.reset}\n`);

    // Update conversation history
    conversationHistory.push({ role: 'user', content: originalMessage });
    conversationHistory.push({ role: 'assistant', content: reply });
    return;
  }

  // Parse response
  const parsed = parseResponse(reply);

  // Handle file operations based on interaction mode
  if (parsed.fileOperations.length > 0) {
    if (interactionMode === 'ask') {
      // Ask mode: Ignore file operations completely
      console.log(`${c.dim}  (${parsed.fileOperations.length} file operation(s) skipped - ASK mode)${c.reset}\n`);
    } else {
      // Code mode: Normal execution
      await handleFileOperations(parsed.fileOperations);
    }
  }

  // Handle commands based on interaction mode
  let commandsExecuted = false;
  if (parsed.commands.length > 0) {
    if (interactionMode === 'ask') {
      // Ask mode: Ignore commands completely
      console.log(`${c.dim}  (${parsed.commands.length} command(s) skipped - ASK mode)${c.reset}\n`);
    } else if (interactionMode === 'plan') {
      // Plan mode: Show commands but don't execute
      console.log(`${c.cyan}  📋 Commands that would run:${c.reset}`);
      parsed.commands.forEach((cmd, i) => {
        console.log(`${c.dim}    ${i + 1}. ${cmd}${c.reset}`);
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

  // Auto-compact if context usage hits 80%+
  const ctxLimit = modelRegistry.getContextLimit();
  const usedTokens = lastKnownTokens > 0
    ? lastKnownTokens
    : tokenCounter.estimateTokens(conversationHistory.map(m => m.content || '').join(' '));
  if (usedTokens / ctxLimit >= 0.80) {
    await compactHistory();
  } else {
    // Trim history if too long (safety fallback)
    const historyLimit = config.get('historyLimit') || 50;
    if (conversationHistory.length > historyLimit) {
      conversationHistory = conversationHistory.slice(-historyLimit);
    }
  }

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
              console.log(`${c.green}  ✓ ${op.action === 'create' ? 'Created' : 'Updated'}: ${op.path}${c.reset}`);
              contextBuilder.loadFile(op.path);
              if (watcher.isEnabled()) watcher.addFile(op.path);
            } else {
              console.log(`${c.red}  ✗ Failed: ${op.path} - ${result.error}${c.reset}`);
            }
            break;

          case 'delete':
            result = fileManager.deleteFile(op.path);
            if (result.success) {
              console.log(`${c.green}  ✓ Deleted: ${op.path}${c.reset}`);
              contextBuilder.unloadFile(op.path);
              watcher.removeFile(op.path);
            } else {
              console.log(`${c.red}  ✗ Failed: ${op.path} - ${result.error}${c.reset}`);
            }
            break;
        }
      } catch (error) {
        console.log(`${c.red}  ✗ Error: ${error.message}${c.reset}`);
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
    console.log(`${c.yellow}  Changes not applied${c.reset}\n`);
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
    console.log(`${c.dim}  $ ${cmd}${c.reset}`);
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
    console.log(`${c.yellow}  Commands not executed${c.reset}\n`);
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
          console.log(`\n${c.cyan}  ┌─ ${cmd}${c.reset}`);
          console.log(`${c.cyan}  └─${c.reset} ${c.green}✓ Changed directory to ${newCwd}${c.reset}`);
        } else {
          console.log(`\n${c.cyan}  ┌─ ${cmd}${c.reset}`);
          console.log(`${c.cyan}  └─${c.reset} ${c.red}✗ Directory not found: ${newCwd}${c.reset}`);
        }
        continue;
      }

      console.log(`\n${c.cyan}  ┌─ Running: ${cmd}${c.reset}`);
      console.log(`${c.cyan}  │${c.reset}`);

      if (commandRunner.isDangerous(cmd)) {
        const confirm = await askQuestion(`${c.red}  ⚠️  This looks dangerous. Type 'yes' to confirm: ${c.reset}`);
        if (confirm.toLowerCase() !== 'yes') {
          console.log(`${c.yellow}  Skipped${c.reset}`);
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

      const startSpinner = () => {
        if (spinnerInterval) return;
        spinnerInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          process.stdout.write(`\r${c.cyan}  │ ${c.dim}${frames[frameIndex]} Working... (${elapsed}s)${c.reset}    `);
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
                console.log(`${c.cyan}  │${c.reset} ${line}`);
              }
            });
            // Restart spinner if no output for a while
            setTimeout(() => {
              if (Date.now() - lastOutputTime > 2000) startSpinner();
            }, 2000);
          },
          onStderr: data => {
            stopSpinner();
            lastOutputTime = Date.now();
            const lines = data.toString().split('\n');
            lines.forEach(line => {
              if (line.trim()) {
                console.log(`${c.cyan}  │${c.reset} ${c.yellow}${line}${c.reset}`);
              }
            });
          }
        });

        stopSpinner();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`${c.cyan}  │${c.reset}`);
        if (result.success) {
          console.log(`${c.cyan}  └─${c.reset} ${c.green}✓ Done${c.reset} ${c.dim}(${elapsed}s)${c.reset}`);
        } else {
          console.log(`${c.cyan}  └─${c.reset} ${c.red}✗ Failed (exit code ${result.code})${c.reset} ${c.dim}(${elapsed}s)${c.reset}`);
        }
      } catch (error) {
        stopSpinner();
        console.log(`${c.cyan}  └─${c.reset} ${c.red}✗ Error: ${error.message}${c.reset}`);
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
    completer: (line) => completer.complete(line),
    terminal: true
  });

  // Handle keypress events: history, mode cycling, clipboard, escape
  // NOTE: Tab completion is handled by readline's built-in completer (not here)
  process.stdin.on('keypress', async (char, key) => {
    if (!key) return;

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
      const modes = ['code', 'plan', 'ask'];
      const currentIndex = modes.indexOf(interactionMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      interactionMode = modes[nextIndex];

      const modeColors = { code: c.green, plan: c.cyan, ask: c.magenta };
      const modeIcons = { code: '⚡', plan: '📋', ask: '💬' };
      const modeDescriptions = {
        code: 'Execute file operations and commands',
        plan: 'Preview changes without executing',
        ask: 'Question-only mode (no operations)'
      };

      process.stdout.write('\n');
      console.log(`${modeColors[interactionMode]}  ${modeIcons[interactionMode]} Mode: ${interactionMode.toUpperCase()}${c.reset} ${c.dim}- ${modeDescriptions[interactionMode]}${c.reset}`);
      rl.prompt(true);
      return;
    }

    // --- Alt+V: Paste screenshot from clipboard ---
    if (key.name === 'v' && key.meta) {
      process.stdout.write('\n');
      console.log(`${c.cyan}  📋 Pasting from clipboard...${c.reset}`);

      const result = await imageHandler.pasteFromClipboard();
      if (result.success) {
        const sizeKB = Math.round(result.data.size / 1024);
        console.log(`${c.green}  ✓ Screenshot added (${sizeKB}KB)${c.reset}`);

        if (visionAnalyzer.isEnabled()) {
          console.log(`${c.cyan}  🔍 Analyzing with Gemini...${c.reset}`);
          const analysis = await visionAnalyzer.analyzeImage(result.data, '');
          if (analysis) {
            console.log(`${c.green}  ✓ Image analyzed - ready for your question${c.reset}`);
            result.data.analysis = analysis;
          }
        }
        console.log(`${c.dim}  Type your question about the screenshot${c.reset}`);
      } else {
        console.log(`${c.red}  ✗ ${result.error}${c.reset}`);
      }
      console.log();
      rl.prompt(true);
      return;
    }

    // --- Escape x2: Cancel current request ---
    if (key.name === 'escape') {
      if (currentAbortController) {
        const now = Date.now();
        if (now - lastEscapeTime < 500) {
          // Double Escape within 500ms - cancel
          currentAbortController.abort();
          lastEscapeTime = 0;
        } else {
          // First Escape - show hint
          lastEscapeTime = now;
          process.stdout.write(`\n${c.dim}  Press Esc again to cancel${c.reset}`);
        }
      }
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
  const args = process.argv.slice(2);

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

Examples:
  ripley
  ripley yolo
  ripley "Add a dark mode toggle"
  ripley "Fix the bug in @src/api/auth.ts"
`);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`Ripley Code v${VERSION}`);
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
      console.log(`${c.green}✓ Initialized Ripley in ${projectDir}${c.reset}`);
      console.log(`${c.dim}  Edit RIPLEY.md to customize AI behavior${c.reset}`);
    } else {
      console.log(`${c.yellow}Ripley already initialized${c.reset}`);
    }
    process.exit(0);
  }

  // Check for yolo flag to start in YOLO mode
  const startInYolo = args.includes('yolo') || args.includes('--yolo');

  // Show banner and initialize
  showBanner();
  initProject();

  // Enable YOLO mode if started with 'yolo' argument
  if (startInYolo) {
    config.set('yoloMode', true);
    console.log(`${c.red}  ⚡ YOLO MODE ACTIVE${c.reset} ${c.dim}(auto-applying all changes)${c.reset}`);
  }

  const connected = await checkConnection();
  if (!connected) {
    process.exit(1);
  }

  console.log(`\n${c.dim}  Type ${c.yellow}/help${c.reset}${c.dim} for commands • ${c.yellow}@file${c.reset}${c.dim} to add files • ${c.yellow}/exit${c.reset}${c.dim} to quit${c.reset}\n`);

  // Create readline with history support
  rl = createReadlineInterface();

  // Handle one-shot mode (but not for special commands like init, yolo)
  const specialArgs = ['init', 'yolo', '--yolo'];
  if (args.length > 0 && !specialArgs.includes(args[0])) {
    const request = args.join(' ');
    await sendMessage(request);
    rl.close();
    process.exit(0);
  }

  // Interactive mode
  const getContextPercent = () => {
    // Use actual token count from last API response when available
    const limit = modelRegistry.getContextLimit();
    let usedTokens;
    if (lastKnownTokens > 0) {
      usedTokens = lastKnownTokens;
    } else {
      // Fallback: estimate from conversation history
      const historyText = conversationHistory.map(m => m.content || '').join(' ');
      usedTokens = tokenCounter.estimateTokens(historyText);
    }
    const pct = Math.min(100, Math.round((usedTokens / limit) * 100));

    // Color code: green < 50%, yellow 50-79%, red 80%+
    let color = c.green;
    if (pct >= 80) color = c.red;
    else if (pct >= 50) color = c.yellow;

    return `${color}${pct}%${c.reset}`;
  };

  const getPromptPrefix = () => {
    const modeIndicators = {
      code: `${c.green}⚡${c.reset}`,
      plan: `${c.cyan}📋${c.reset}`,
      ask: `${c.magenta}💬${c.reset}`
    };
    const modelName = modelRegistry.getCurrent() || '?';
    const ctxPct = getContextPercent();
    const thinkIndicator = (thinkingMode && modelRegistry.currentSupportsThinking()) ? ` ${c.cyan}🧠${c.reset}` : '';
    return `${modeIndicators[interactionMode]} ${c.dim}[${modelName}]${c.reset}${thinkIndicator} ${c.dim}ctx:${c.reset}${ctxPct} ${c.orange}You → ${c.reset}`;
  };

  const prompt = () => {
    rl.question(getPromptPrefix(), async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Add to history
      historyManager.add(trimmed);
      historyManager.resetIndex();

      // Handle bare "exit" or "quit" without slash
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        await handleCommand('/exit');
        return; // Won't reach here since /exit calls process.exit(0)
      }

      // Check for commands
      if (trimmed.startsWith('/')) {
        const handled = await handleCommand(trimmed);
        if (!handled) {
          console.log(`\n${c.dim}  Unknown command. Type /help or /commands for available commands.${c.reset}\n`);
        }
        prompt();
        return;
      }

      // Send message to AI
      await sendMessage(trimmed);
      prompt();
    });
  };

  prompt();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  if (config && config.get('autoSaveHistory') && conversationHistory.length > 0) {
    config.saveConversation('autosave', conversationHistory);
  }
  if (watcher) watcher.stop();
  console.log(`\n${c.cyan}  👋 See you later!${c.reset}\n`);
  process.exit(0);
});

main().catch(error => {
  console.error(`${c.red}Fatal error: ${error.message}${c.reset}`);
  if (watcher) watcher.stop();
  process.exit(1);
});
