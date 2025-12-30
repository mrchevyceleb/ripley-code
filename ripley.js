#!/usr/bin/env node

/**
 * Ripley Code v3.0.0 - Your local AI coding agent
 *
 * Features:
 * - Streaming responses
 * - File read/write with diffs and backups
 * - @ mentions for quick file loading
 * - Command history (up/down arrows)
 * - Tab completion
 * - Watch mode for file changes
 * - Conversation save/load
 * - Token tracking and cost estimation
 * - Image/screenshot support
 * - Project-specific instructions
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

// =============================================================================
// CONFIGURATION
// =============================================================================

const VERSION = '3.2.0';

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
let conversationHistory = [];
let rl = null;

// Interaction modes: 'code' (default), 'plan' (preview only), 'ask' (no operations)
let interactionMode = 'code';

// Prompt override: null = auto-detect, or 'base', 'landing', 'saas'
let promptOverride = null;

// Abort controller for cancelling requests with Escape
let currentAbortController = null;

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
${c.dim}    Ripley Code • v${VERSION} • AI Coding Agent${c.reset}
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
${c.yellow}  /image <path>${c.reset}       Add image (auto-analyzed with Gemini)

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

${c.orange}${c.dim}Modes:${c.reset}
${c.yellow}  /plan${c.reset}               Toggle PLAN mode (creates plan, no code)
${c.yellow}  /implement${c.reset}          Execute the saved plan
${c.yellow}  /ask${c.reset}                Toggle ASK mode (questions only, no file ops)
${c.yellow}  /mode${c.reset}               Show current mode
${c.yellow}  /yolo${c.reset}               Toggle YOLO mode (auto-apply all changes)
${c.yellow}  /prompt <type>${c.reset}      Set prompt: base, landing, saas, auto

${c.orange}${c.dim}Config Commands:${c.reset}
${c.yellow}  /config${c.reset}             Show current config
${c.yellow}  /set <key> <value>${c.reset}  Update config setting
${c.yellow}  /instructions${c.reset}       Edit project instructions
${c.yellow}  /watch${c.reset}              Toggle file watch mode
${c.yellow}  /stream${c.reset}             Toggle streaming mode

${c.orange}${c.dim}System Commands:${c.reset}
${c.yellow}  /run <cmd>${c.reset}          Run a shell command
${c.yellow}  /undo${c.reset}               Show recent backups
${c.yellow}  /restore <path>${c.reset}     Restore file from backup
${c.yellow}  /version${c.reset}            Show version
${c.yellow}  /help${c.reset}               Show this help
${c.yellow}  /exit${c.reset}               Exit Ripley

${c.orange}${c.dim}Tips:${c.reset}
${c.gray}  • Use ${c.cyan}@filename${c.gray} in messages to auto-load files
${c.gray}  • Press ${c.cyan}↑${c.gray}/${c.cyan}↓${c.gray} to navigate command history
${c.gray}  • Press ${c.cyan}Tab${c.gray} for completion
${c.gray}  • Press ${c.cyan}Shift+Tab${c.gray} to cycle modes (code → plan → ask)
${c.gray}  • Press ${c.cyan}Alt+V${c.gray} to paste screenshot from clipboard
${c.gray}  • Press ${c.cyan}Escape${c.gray} to cancel current request
${c.gray}  • Create ${c.cyan}.ripley/instructions.md${c.gray} for project-specific AI instructions
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

  // Try to get Gemini API key from: 1) project config, 2) global config, 3) env var
  let geminiKey = config.get('geminiApiKey');
  if (!geminiKey) {
    // Check global config in Ripley install directory
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

  // Check for project instructions
  const instructions = config.getInstructions();
  if (instructions) {
    console.log(`${c.green}  ✓${c.reset} Project instructions loaded`);
  }

  // Check for vision analyzer
  if (visionAnalyzer.isEnabled()) {
    console.log(`${c.green}  ✓${c.reset} Vision analysis enabled (Gemini)`);
  } else {
    console.log(`${c.dim}  ○ Vision analysis disabled (set GEMINI_API_KEY or GOOGLE_API_KEY)${c.reset}`);
  }
}

async function checkConnection() {
  const apiUrl = config.get('apiUrl');
  try {
    const response = await fetch(`${apiUrl}/api/health`);
    if (response.ok) {
      console.log(`${c.green}  ✓${c.reset} Connected to AI Router`);
      return true;
    }
  } catch {
    // Failed
  }
  console.log(`${c.red}  ✗${c.reset} Cannot connect to ${apiUrl}`);
  console.log(`${c.dim}    Make sure the AI Router is running${c.reset}\n`);
  return false;
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
      contextBuilder.clearFiles();
      contextBuilder.loadPriorityFiles();
      tokenCounter.resetSession();
      imageHandler.clearPending();
      console.log(`\n${c.green}  ✓ Cleared conversation and reset context${c.reset}\n`);
      return true;

    case '/clearhistory':
      conversationHistory = [];
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
      const validPrompts = ['base', 'landing', 'saas', 'auto'];
      const requestedPrompt = args.trim().toLowerCase();

      if (!requestedPrompt) {
        // Show current prompt setting
        const currentPrompt = promptOverride || 'auto';
        console.log(`\n${c.cyan}  Prompt Mode:${c.reset} ${c.yellow}${currentPrompt}${c.reset}`);
        console.log(`${c.dim}    /prompt base    - General coding assistant${c.reset}`);
        console.log(`${c.dim}    /prompt landing - HTML landing pages${c.reset}`);
        console.log(`${c.dim}    /prompt saas    - Next.js + Supabase apps${c.reset}`);
        console.log(`${c.dim}    /prompt auto    - Auto-detect from message${c.reset}\n`);
        return true;
      }

      if (!validPrompts.includes(requestedPrompt)) {
        console.log(`\n${c.red}  Invalid prompt. Use: base, landing, saas, or auto${c.reset}\n`);
        return true;
      }

      if (requestedPrompt === 'auto') {
        promptOverride = null;
        console.log(`\n${c.green}  ✓ Prompt mode: AUTO${c.reset} ${c.dim}(will detect from your message)${c.reset}\n`);
      } else {
        promptOverride = requestedPrompt;
        const promptDescriptions = {
          base: 'General coding assistant',
          landing: 'HTML landing pages',
          saas: 'Next.js + Supabase apps'
        };
        console.log(`\n${c.green}  ✓ Prompt mode: ${requestedPrompt.toUpperCase()}${c.reset} ${c.dim}(${promptDescriptions[requestedPrompt]})${c.reset}\n`);
      }
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
        console.log(`\n${c.cyan}  Project Instructions:${c.reset}`);
        console.log(`${c.dim}${existingInstructions.substring(0, 500)}${existingInstructions.length > 500 ? '...' : ''}${c.reset}`);
        console.log(`\n${c.dim}  Edit: ${path.join(projectDir, '.ripley', 'instructions.md')}${c.reset}\n`);
      } else {
        const created = config.createDefaultInstructions();
        console.log(`\n${c.green}  ✓ Created instructions template${c.reset}`);
        console.log(`${c.dim}  Edit: ${path.join(projectDir, '.ripley', 'instructions.md')}${c.reset}\n`);
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

    default:
      return false;
  }
}

// =============================================================================
// AI INTERACTION
// =============================================================================

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

    // Analyze images with Gemini if available
    if (visionAnalyzer.isEnabled()) {
      console.log(`${c.cyan}  🔍 Analyzing image(s) with Gemini...${c.reset}`);
      const analysis = await visionAnalyzer.analyzeImages(pendingImages, message);
      if (analysis) {
        imageAnalysis = visionAnalyzer.formatForPrompt(analysis);
        console.log(`${c.green}  ✓ Image analysis complete${c.reset}`);
      } else {
        console.log(`${c.yellow}  ⚠ Image analysis failed, sending without description${c.reset}`);
      }
    } else {
      console.log(`${c.yellow}  ⚠ No Gemini API key - use /set geminiApiKey YOUR_KEY then restart${c.reset}`);
    }
  }

  // Build context
  const context = contextBuilder.buildContext();

  // Check token limit
  const contextTokens = tokenCounter.estimateTokens(context);
  const limit = tokenCounter.checkLimit(contextTokens);

  if (limit.isWarning) {
    console.log(`${c.yellow}  ⚠ Context is ${Math.round(limit.percentage * 100)}% of token limit${c.reset}`);
  }

  // Get project instructions
  const instructions = config.getInstructions();

  // Build full message
  let systemNote = '';
  if (config.get('compactMode')) {
    systemNote = '\n\n[USER PREFERENCE: Be concise. Shorter explanations, focus on code changes.]';
  }

  let fullMessage = `## Current Project Context\n\n${context}`;

  if (instructions) {
    fullMessage += `\n\n## Project-Specific Instructions\n\n${instructions}`;
  }

  // Include image analysis if available
  if (imageAnalysis) {
    fullMessage += `\n\n## Image Analysis\n\n${imageAnalysis}`;
  }

  fullMessage += `\n\n## User Request\n\n${message}${systemNote}`;

  const apiUrl = config.get('apiUrl');
  const streamingEnabled = config.get('streamingEnabled');

  try {
    if (streamingEnabled) {
      await sendStreamingMessage(fullMessage, apiUrl, pendingImages, message);
    } else {
      await sendNonStreamingMessage(fullMessage, apiUrl, pendingImages, message);
    }
  } catch (error) {
    console.log(`\n${c.red}  ✗ Error: ${error.message}${c.reset}`);
    console.log(`${c.dim}    Make sure the AI Router is running at ${apiUrl}${c.reset}\n`);
  }
}

async function sendStreamingMessage(message, apiUrl, images = [], rawMessage = '') {
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
  // Priority: plan mode > promptOverride > interaction mode defaults
  let promptMode;
  if (interactionMode === 'plan') {
    promptMode = 'plan'; // Use plan prompt for planning mode
  } else if (promptOverride) {
    promptMode = promptOverride;
  } else if (interactionMode === 'ask') {
    promptMode = 'base';
  } else {
    promptMode = null; // Let router auto-detect based on message content
  }

  const body = {
    message,
    rawMessage, // User's actual input for mode detection
    conversationHistory
  };

  // Only send mode if explicitly set (otherwise router auto-detects)
  if (promptMode) {
    body.mode = promptMode;
  }

  // Note: Images are analyzed by Gemini and included as text in the message
  // We don't send raw images to the AI Router (local LLM can't handle them)

  // Create abort controller for this request
  currentAbortController = new AbortController();

  // Start the fun thinking animation
  startThinking();

  const response = await fetch(`${apiUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: currentAbortController.signal
  });

  if (!response.ok) {
    stopStatus();
    currentAbortController = null;
    throw new Error(`Server error: ${response.status}`);
  }

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

async function sendNonStreamingMessage(message, apiUrl, images = [], rawMessage = '') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const modeColors = { code: c.cyan, plan: c.cyan, ask: c.magenta };
  let i = 0;
  const spinner = setInterval(() => {
    process.stdout.write(`\r${modeColors[interactionMode]}  ${frames[i]} ${c.dim}Ripley is thinking...${c.reset}`);
    i = (i + 1) % frames.length;
  }, 80);

  try {
    const body = {
      message,
      rawMessage, // User's actual input for mode detection
      mode: interactionMode === 'ask' ? 'base' : null, // Let router auto-detect unless ask mode
      conversationHistory
    };

    // Note: Images are analyzed by Gemini and included as text in the message
    // We don't send raw images to the AI Router (local LLM can't handle them)

    const response = await fetch(`${apiUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    clearInterval(spinner);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();

    const { renderMarkdown } = require('./lib/markdownRenderer');
    console.log(`\n${c.cyan}Ripley →${c.reset} `);
    console.log(renderMarkdown(data.reply));
    console.log();

    await processAIResponse(data.reply, message);

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

  // Trim history if too long
  const historyLimit = config.get('historyLimit') || 50;
  if (conversationHistory.length > historyLimit) {
    conversationHistory = conversationHistory.slice(-historyLimit);
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

  // Handle up/down for history, Shift+Tab for mode cycling, Alt+V for clipboard paste
  process.stdin.on('keypress', async (char, key) => {
    if (!key) return;

    if (key.name === 'up') {
      const prev = historyManager.up(rl.line);
      rl.write(null, { ctrl: true, name: 'u' }); // Clear line
      rl.write(prev);
    } else if (key.name === 'down') {
      const next = historyManager.down(rl.line);
      rl.write(null, { ctrl: true, name: 'u' }); // Clear line
      rl.write(next);
    } else if (key.name === 'tab' && key.shift) {
      // Shift+Tab: Cycle through modes (code -> plan -> ask -> code)
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

      // Move to new line and show mode change
      process.stdout.write('\n');
      console.log(`${modeColors[interactionMode]}  ${modeIcons[interactionMode]} Mode: ${interactionMode.toUpperCase()}${c.reset} ${c.dim}- ${modeDescriptions[interactionMode]}${c.reset}`);
      rl.prompt(true);
    } else if (key.name === 'v' && key.meta) {
      // Alt+V: Paste screenshot from clipboard
      process.stdout.write('\n');
      console.log(`${c.cyan}  📋 Pasting from clipboard...${c.reset}`);

      const result = await imageHandler.pasteFromClipboard();
      if (result.success) {
        const sizeKB = Math.round(result.data.size / 1024);
        console.log(`${c.green}  ✓ Screenshot added (${sizeKB}KB)${c.reset}`);

        // Auto-analyze with Gemini if available
        if (visionAnalyzer.isEnabled()) {
          console.log(`${c.cyan}  🔍 Analyzing with Gemini...${c.reset}`);
          const analysis = await visionAnalyzer.analyzeImage(result.data, '');
          if (analysis) {
            console.log(`${c.green}  ✓ Image analyzed - ready for your question${c.reset}`);
            // Store analysis for next message
            result.data.analysis = analysis;
          }
        }
        console.log(`${c.dim}  Type your question about the screenshot${c.reset}`);
      } else {
        console.log(`${c.red}  ✗ ${result.error}${c.reset}`);
      }
      console.log();
      rl.prompt(true);
    } else if (key.name === 'escape') {
      // Escape: Cancel current request
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        console.log(`\n\n${c.yellow}  ⚠ Request cancelled${c.reset}\n`);
        rl.prompt(true);
      }
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
      console.log(`${c.dim}  Edit .ripley/instructions.md to customize AI behavior${c.reset}`);
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
  const getPromptPrefix = () => {
    const modeIndicators = {
      code: `${c.green}⚡${c.reset}`,
      plan: `${c.cyan}📋${c.reset}`,
      ask: `${c.magenta}💬${c.reset}`
    };
    return `${modeIndicators[interactionMode]} ${c.orange}You → ${c.reset}`;
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
          console.log(`\n${c.dim}  Unknown command. Type /help for available commands.${c.reset}\n`);
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
