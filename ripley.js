#!/usr/bin/env node

/**
 * Ripley Code - Your local AI coding agent
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');

const FileManager = require('./lib/fileManager');
const ContextBuilder = require('./lib/contextBuilder');
const CommandRunner = require('./lib/commandRunner');
const { parseResponse, hasActions } = require('./lib/parser');
const { formatOperation, colors: c } = require('./lib/diffViewer');

// =============================================================================
// CONFIGURATION
// =============================================================================

const API_URL = process.env.RIPLEY_API_URL || 'http://localhost:3000';
const VERSION = '2.1.0';

// =============================================================================
// GLOBALS
// =============================================================================

let projectDir = process.cwd();
let fileManager = null;
let contextBuilder = null;
let commandRunner = null;
let conversationHistory = [];
let rl = null;
let compactMode = false;

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
${c.orange}${c.bright}File Commands:${c.reset}
${c.yellow}  /files${c.reset}            List files in context
${c.yellow}  /read <path>${c.reset}      Add file to context (or use @filename in message)
${c.yellow}  /unread <path>${c.reset}    Remove file from context
${c.yellow}  /tree${c.reset}             Show project structure
${c.yellow}  /find <pattern>${c.reset}   Find files matching pattern (e.g., *.tsx, **/api/*)
${c.yellow}  /grep <text>${c.reset}      Search for text in all source files

${c.orange}${c.bright}Git Commands:${c.reset}
${c.yellow}  /git${c.reset}              Show git status
${c.yellow}  /diff${c.reset}             Show uncommitted changes
${c.yellow}  /log${c.reset}              Show recent commits

${c.orange}${c.bright}Session Commands:${c.reset}
${c.yellow}  /clear${c.reset}            Clear conversation & context
${c.yellow}  /clearhistory${c.reset}     Clear conversation only (keep files)
${c.yellow}  /context${c.reset}          Show context size & token estimate
${c.yellow}  /compact${c.reset}          Toggle compact mode (shorter AI responses)

${c.orange}${c.bright}System Commands:${c.reset}
${c.yellow}  /run <cmd>${c.reset}        Run a shell command
${c.yellow}  /undo${c.reset}             Show recent backups
${c.yellow}  /restore <path>${c.reset}   Restore last backup of a file
${c.yellow}  /help${c.reset}             Show this help
${c.yellow}  /exit${c.reset}             Exit Ripley

${c.orange}${c.bright}Tips:${c.reset}
${c.gray}  • Use ${c.cyan}@filename${c.gray} in your message to auto-load files
    Example: "Fix the bug in ${c.cyan}@src/api/auth.ts${c.gray}"

  • Glob patterns work: ${c.cyan}@src/components/*.tsx${c.gray}

  • Review diffs before applying (y/n prompt)

  • All changes backed up to .ripley/backups/
${c.reset}
`);
}

function showThinking() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  return setInterval(() => {
    process.stdout.write(`\r${c.cyan}  ${frames[i]} ${c.dim}Ripley is thinking...${c.reset}`);
    i = (i + 1) % frames.length;
  }, 80);
}

function stopThinking(spinner) {
  clearInterval(spinner);
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
}

// =============================================================================
// INITIALIZATION
// =============================================================================

function initProject() {
  fileManager = new FileManager(projectDir);
  contextBuilder = new ContextBuilder(fileManager);
  commandRunner = new CommandRunner(projectDir);

  // Get project summary
  const summary = contextBuilder.getSummary();

  console.log(`${c.green}  ✓${c.reset} Project: ${c.white}${path.basename(projectDir)}${c.reset}`);
  console.log(`${c.green}  ✓${c.reset} Files: ${summary.sourceFiles} source files in ${summary.totalDirs} directories`);

  // Load priority files
  contextBuilder.loadPriorityFiles();
  console.log(`${c.green}  ✓${c.reset} Context: ${contextBuilder.getLoadedFiles().length} files loaded`);
}

async function checkConnection() {
  try {
    const response = await fetch(`${API_URL}/api/health`);
    if (response.ok) {
      console.log(`${c.green}  ✓${c.reset} Connected to AI Router`);
      return true;
    }
  } catch {
    // Failed
  }
  console.log(`${c.red}  ✗${c.reset} Cannot connect to ${API_URL}`);
  console.log(`${c.dim}    Make sure the AI Router is running${c.reset}\n`);
  return false;
}

// =============================================================================
// @ MENTION HANDLING
// =============================================================================

function extractFileMentions(message) {
  // Match @path/to/file or @pattern with glob support
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
    // Check if it's a glob pattern
    if (mention.includes('*')) {
      const { glob } = require('glob');
      try {
        const files = await glob(mention, { cwd: projectDir, nodir: true });
        for (const file of files.slice(0, 10)) { // Limit to 10 files per glob
          const result = contextBuilder.loadFile(file);
          if (result.success && !result.alreadyLoaded) {
            loaded.push(file);
          }
        }
      } catch {
        // Invalid glob, try as literal path
      }
    } else {
      // Literal file path
      const result = contextBuilder.loadFile(mention);
      if (result.success && !result.alreadyLoaded) {
        loaded.push(mention);
      }
    }
  }

  return loaded;
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
      // Support glob patterns
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
        console.log(`\n${c.yellow}  Usage: /find <pattern>${c.reset}`);
        console.log(`${c.dim}  Examples: /find *.tsx   /find **/api/*   /find Button*${c.reset}\n`);
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
          if (matches.length > 30) {
            console.log(`${c.dim}    ... and ${matches.length - 30} more${c.reset}`);
          }
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
          if (results.length > 20) {
            console.log(`${c.dim}  ... and ${results.length - 20} more matches${c.reset}`);
          }
          console.log();
        }
      } catch (error) {
        console.log(`${c.red}  ✗ ${error.message}${c.reset}\n`);
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

          // Also show actual diff summary
          const diffResult = await commandRunner.git('diff');
          if (diffResult.success && diffResult.stdout) {
            const lines = diffResult.stdout.split('\n');
            const added = lines.filter(l => l.startsWith('+')).length;
            const removed = lines.filter(l => l.startsWith('-')).length;
            console.log(`\n${c.green}  +${added}${c.reset} ${c.red}-${removed}${c.reset} lines`);
          }
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
      console.log(`\n${c.green}  ✓ Cleared conversation and reset context${c.reset}\n`);
      return true;

    case '/clearhistory':
      conversationHistory = [];
      console.log(`\n${c.green}  ✓ Cleared conversation history (files kept)${c.reset}\n`);
      return true;

    case '/context':
      const ctx = contextBuilder.buildContext();
      const charCount = ctx.length;
      const tokenEstimate = Math.round(charCount / 4); // Rough estimate
      const loadedFiles = contextBuilder.getLoadedFiles();

      console.log(`\n${c.cyan}  Context Summary:${c.reset}`);
      console.log(`${c.dim}    Files loaded: ${loadedFiles.length}${c.reset}`);
      console.log(`${c.dim}    Characters: ${charCount.toLocaleString()}${c.reset}`);
      console.log(`${c.dim}    Est. tokens: ~${tokenEstimate.toLocaleString()}${c.reset}`);
      console.log(`${c.dim}    Compact mode: ${compactMode ? 'ON' : 'OFF'}${c.reset}`);
      console.log();
      return true;

    case '/compact':
      compactMode = !compactMode;
      console.log(`\n${c.green}  ✓ Compact mode: ${compactMode ? 'ON' : 'OFF'}${c.reset}\n`);
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
        console.log(`\n${c.yellow}  Usage: /restore <filepath>${c.reset}`);
        console.log(`${c.dim}  Restores the most recent backup of the specified file${c.reset}\n`);
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
      console.log(`\n${c.cyan}  👋 See you later!${c.reset}\n`);
      process.exit(0);

    default:
      return false;
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
          results.push({
            file,
            line: idx + 1,
            text: line
          });
        }
      });

      if (results.length >= 100) return results; // Limit results
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

// =============================================================================
// AI INTERACTION
// =============================================================================

async function sendMessage(message) {
  // First, handle @ mentions
  const loadedFromMentions = await loadMentionedFiles(message);
  if (loadedFromMentions.length > 0) {
    console.log(`${c.dim}  Loaded: ${loadedFromMentions.join(', ')}${c.reset}`);
  }

  const spinner = showThinking();

  try {
    // Build context
    const context = contextBuilder.buildContext();

    // Add compact mode instruction if enabled
    let systemNote = '';
    if (compactMode) {
      systemNote = '\n\n[USER PREFERENCE: Be concise. Shorter explanations, focus on code changes.]';
    }

    // Prepare the full message with context
    const fullMessage = `## Current Project Context\n\n${context}\n\n## User Request\n\n${message}${systemNote}`;

    const body = {
      message: fullMessage,
      mode: 'code',
      conversationHistory
    };

    const response = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    stopThinking(spinner);

    // Parse the response
    const parsed = parseResponse(data.reply);

    // Show mode indicator
    console.log(`\n${c.cyan}  ● code${c.reset} ${c.dim}(agent)${c.reset}\n`);

    // Show explanation
    if (parsed.explanation) {
      console.log(`${c.white}${parsed.explanation}${c.reset}\n`);
    }

    // Handle file operations
    if (parsed.fileOperations.length > 0) {
      await handleFileOperations(parsed.fileOperations);
    }

    // Handle commands
    if (parsed.commands.length > 0) {
      await handleCommands(parsed.commands);
    }

    // Update conversation history
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: data.reply });

    // Keep history manageable
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }

  } catch (error) {
    stopThinking(spinner);
    console.log(`\n${c.red}  ✗ Error: ${error.message}${c.reset}`);
    console.log(`${c.dim}    Make sure the AI Router is running at ${API_URL}${c.reset}\n`);
  }
}

async function handleFileOperations(operations) {
  console.log(`${c.orange}📝 Proposed Changes (${operations.length}):${c.reset}\n`);

  // Show all diffs first
  for (const op of operations) {
    const existingContent = fileManager.exists(op.path)
      ? fileManager.readFile(op.path).content
      : null;

    console.log(formatOperation(op, existingContent));
    console.log();
  }

  // Ask for confirmation
  const answer = await askQuestion(`${c.yellow}Apply these changes? (y/n): ${c.reset}`);

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    // Apply all operations
    for (const op of operations) {
      try {
        let result;
        switch (op.action) {
          case 'create':
          case 'edit':
            result = fileManager.writeFile(op.path, op.content);
            if (result.success) {
              console.log(`${c.green}  ✓ ${op.action === 'create' ? 'Created' : 'Updated'}: ${op.path}${c.reset}`);
              // Reload into context
              contextBuilder.loadFile(op.path);
            } else {
              console.log(`${c.red}  ✗ Failed: ${op.path} - ${result.error}${c.reset}`);
            }
            break;

          case 'delete':
            result = fileManager.deleteFile(op.path);
            if (result.success) {
              console.log(`${c.green}  ✓ Deleted: ${op.path}${c.reset}`);
              contextBuilder.unloadFile(op.path);
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
  } else {
    console.log(`${c.yellow}  Changes not applied${c.reset}\n`);
  }
}

async function handleCommands(commands) {
  console.log(`${c.orange}🔧 Suggested Commands:${c.reset}\n`);

  for (const cmd of commands) {
    console.log(`${c.dim}  $ ${cmd}${c.reset}`);
  }
  console.log();

  const answer = await askQuestion(`${c.yellow}Run these commands? (y/n): ${c.reset}`);

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    for (const cmd of commands) {
      console.log(`\n${c.cyan}  Running: ${cmd}${c.reset}\n`);

      if (commandRunner.isDangerous(cmd)) {
        const confirm = await askQuestion(`${c.red}  ⚠️  This looks dangerous. Are you sure? (yes to confirm): ${c.reset}`);
        if (confirm.toLowerCase() !== 'yes') {
          console.log(`${c.yellow}  Skipped${c.reset}`);
          continue;
        }
      }

      try {
        const result = await commandRunner.run(cmd, {
          onStdout: data => process.stdout.write(data),
          onStderr: data => process.stderr.write(data)
        });
        console.log(`\n${result.success ? c.green : c.red}  Exit code: ${result.code}${c.reset}`);
      } catch (error) {
        console.log(`\n${c.red}  Error: ${error.message}${c.reset}`);
      }
    }
    console.log();
  } else {
    console.log(`${c.yellow}  Commands not executed${c.reset}\n`);
  }
}

function askQuestion(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Ripley Code v${VERSION} - AI Coding Agent

Usage:
  ripley              Start interactive mode in current directory
  ripley init         Initialize .ripley config in project
  ripley <request>    One-shot mode: make a change and exit

Options:
  --help, -h          Show this help
  --version, -v       Show version

Examples:
  ripley
  ripley "Add a dark mode toggle to the header"
  ripley "Fix the bug in @src/api/auth.ts"
`);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`Ripley Code v${VERSION}`);
    process.exit(0);
  }

  // Handle init command
  if (args[0] === 'init') {
    const ripleyDir = path.join(projectDir, '.ripley');
    if (!fs.existsSync(ripleyDir)) {
      fs.mkdirSync(ripleyDir, { recursive: true });
      fs.writeFileSync(
        path.join(ripleyDir, 'config.json'),
        JSON.stringify({ version: VERSION, created: new Date().toISOString() }, null, 2)
      );
      console.log(`${c.green}✓ Initialized Ripley in ${projectDir}${c.reset}`);
    } else {
      console.log(`${c.yellow}Ripley already initialized${c.reset}`);
    }
    process.exit(0);
  }

  // Show banner and initialize
  showBanner();
  initProject();

  const connected = await checkConnection();
  if (!connected) {
    process.exit(1);
  }

  console.log(`\n${c.dim}  Type ${c.yellow}/help${c.reset}${c.dim} for commands • ${c.yellow}@file${c.reset}${c.dim} to add files • ${c.yellow}/exit${c.reset}${c.dim} to quit${c.reset}\n`);

  // Create readline interface
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Handle one-shot mode
  if (args.length > 0 && args[0] !== 'init') {
    const request = args.join(' ');
    await sendMessage(request);
    rl.close();
    process.exit(0);
  }

  // Interactive mode
  const prompt = () => {
    rl.question(`${c.orange}  You → ${c.reset}`, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
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
  console.log(`\n${c.cyan}  👋 See you later!${c.reset}\n`);
  process.exit(0);
});

main().catch(error => {
  console.error(`${c.red}Fatal error: ${error.message}${c.reset}`);
  process.exit(1);
});
