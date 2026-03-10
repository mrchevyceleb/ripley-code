/**
 * Configuration management for Ripley Code
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  lmStudioUrl: 'http://localhost:1234',
  compactMode: false,
  maxTokens: 32000,
  tokenWarningThreshold: 0.8, // Warn at 80% of max
  streamingEnabled: true,
  autoSaveHistory: true,
  historyLimit: 50,
  steeringEnabled: true,
  agenticMode: true, // Enable AI tool calling (read files, search code)
  activeModel: null, // Persisted model selection (friendly name from models.json)
  activePrompt: 'base', // Active system prompt
  mcpUrl: null, // MCP server URL (overrides MCP_SERVER_URL env var)
  geminiApiKey: null, // For vision analysis fallback (Alt+V screenshots)
  ignorePatterns: [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '.next/**',
    'coverage/**',
    '*.lock',
    '*.log'
  ]
};

class Config {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.ripleyDir = path.join(projectDir, '.ripley');
    this.configPath = path.join(this.ripleyDir, 'config.json');
    this.instructionsPath = path.join(this.ripleyDir, 'instructions.md');
    this.historyDir = path.join(this.ripleyDir, 'history');
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }

  ensureDir() {
    if (!fs.existsSync(this.ripleyDir)) {
      fs.mkdirSync(this.ripleyDir, { recursive: true });
    }
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        this.config = { ...DEFAULT_CONFIG, ...saved };
      }
    } catch {
      // Use defaults
    }

    // Migrate old config: apiUrl -> lmStudioUrl
    if (this.config.apiUrl && !this.config.lmStudioUrl) {
      this.config.lmStudioUrl = DEFAULT_CONFIG.lmStudioUrl;
      delete this.config.apiUrl;
      this.save();
    }

    // Env overrides
    if (process.env.RIPLEY_LM_STUDIO_URL) {
      this.config.lmStudioUrl = process.env.RIPLEY_LM_STUDIO_URL;
    }
  }

  save() {
    this.ensureDir();
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
    this.save();
  }

  getAll() {
    return { ...this.config };
  }

  // Project-specific instructions
  // Checks RIPLEY.md at project root first, then .ripley/instructions.md as fallback
  getInstructions() {
    // Primary: RIPLEY.md at project root (like CLAUDE.md pattern)
    const ripleyMdPath = path.join(this.projectDir, 'RIPLEY.md');
    try {
      if (fs.existsSync(ripleyMdPath)) {
        return { content: fs.readFileSync(ripleyMdPath, 'utf-8'), source: 'RIPLEY.md' };
      }
    } catch {
      // Fall through
    }
    // Fallback: .ripley/instructions.md (legacy)
    try {
      if (fs.existsSync(this.instructionsPath)) {
        return { content: fs.readFileSync(this.instructionsPath, 'utf-8'), source: '.ripley/instructions.md' };
      }
    } catch {
      // No instructions
    }
    return null;
  }

  createDefaultInstructions() {
    const ripleyMdPath = path.join(this.projectDir, 'RIPLEY.md');
    const template = `# RIPLEY.md

This file provides project-specific instructions to Ripley Code.
It is automatically loaded into the AI context at the start of every conversation.

## Project Overview
<!-- Describe your project briefly -->

## Code Style
<!-- Describe your preferred code style -->
- We use TypeScript
- We prefer functional components with hooks
- We use Tailwind CSS for styling

## Important Notes
<!-- Any special instructions for the AI -->
- Always use pnpm instead of npm
- Follow the existing patterns in the codebase

## Off-Limits
<!-- Things the AI should NOT do -->
- Don't modify package-lock.json or pnpm-lock.yaml
- Don't change the build configuration without asking
`;
    fs.writeFileSync(ripleyMdPath, template);
    return template;
  }

  // Conversation history persistence
  saveConversation(name, history) {
    this.ensureDir();
    const filename = `${name.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;
    const filepath = path.join(this.historyDir, filename);
    fs.writeFileSync(filepath, JSON.stringify({
      name,
      savedAt: new Date().toISOString(),
      history
    }, null, 2));
    return filename;
  }

  listConversations() {
    this.ensureDir();
    try {
      const files = fs.readdirSync(this.historyDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(this.historyDir, f), 'utf-8'));
            return {
              filename: f,
              name: content.name,
              savedAt: content.savedAt,
              messageCount: content.history?.length || 0
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      return files;
    } catch {
      return [];
    }
  }

  loadConversation(filename) {
    const filepath = path.join(this.historyDir, filename);
    try {
      const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      return content.history || [];
    } catch {
      return null;
    }
  }

  deleteConversation(filename) {
    const filepath = path.join(this.historyDir, filename);
    try {
      fs.unlinkSync(filepath);
      return true;
    } catch {
      return false;
    }
  }

  // Hooks config
  getHooksPath() {
    return path.join(this.ripleyDir, 'hooks.json');
  }

  getHooks() {
    try {
      const hooksPath = this.getHooksPath();
      if (fs.existsSync(hooksPath)) {
        return JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      }
    } catch {
      // Invalid hooks.json
    }
    return {};
  }

  saveHooks(hookConfig) {
    this.ensureDir();
    fs.writeFileSync(this.getHooksPath(), JSON.stringify(hookConfig, null, 2));
  }
}

// ─── Global Config (~/.ripley/) ──────────────────────────────────────────────

const GLOBAL_RIPLEY_DIR = path.join(require('os').homedir(), '.ripley');

class GlobalConfig {
  constructor() {
    this.ripleyDir = GLOBAL_RIPLEY_DIR;
    this.configPath = path.join(this.ripleyDir, 'config.json');
    this.instructionsPath = path.join(this.ripleyDir, 'RIPLEY.md');
    this.commandsDir = path.join(this.ripleyDir, 'commands');
    this.config = {};
    this.load();
  }

  ensureDir() {
    for (const dir of [this.ripleyDir, this.commandsDir, path.join(this.ripleyDir, 'logs')]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }
    } catch {
      this.config = {};
    }
  }

  save() {
    this.ensureDir();
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
    this.save();
  }

  /**
   * Get global instructions from ~/.ripley/RIPLEY.md
   */
  getInstructions() {
    try {
      if (fs.existsSync(this.instructionsPath)) {
        return { content: fs.readFileSync(this.instructionsPath, 'utf-8'), source: '~/.ripley/RIPLEY.md' };
      }
    } catch {
      // No global instructions
    }
    return null;
  }
}

module.exports = { Config, GlobalConfig, GLOBAL_RIPLEY_DIR };
