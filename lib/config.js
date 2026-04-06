/**
 * Configuration management for Banana Code
 */

const fs = require('fs');
const path = require('path');
const { ensureDirSync, atomicWriteFileSync, atomicWriteJsonSync } = require('./fsUtils');

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
    this.bananaDir = path.join(projectDir, '.banana');
    this.configPath = path.join(this.bananaDir, 'config.json');
    this.instructionsPath = path.join(this.bananaDir, 'instructions.md');
    this.historyDir = path.join(this.bananaDir, 'history');
    this.runSnapshotPath = path.join(this.bananaDir, 'last-run.json');
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }

  ensureDir() {
    ensureDirSync(this.bananaDir);
    ensureDirSync(this.historyDir);
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

    // Env overrides (support legacy RIPLEY_ prefix with deprecation)
    const envUrl = process.env.BANANA_LM_STUDIO_URL || process.env.RIPLEY_LM_STUDIO_URL;
    if (envUrl) {
      this.config.lmStudioUrl = envUrl;
    }
  }

  save() {
    this.ensureDir();
    atomicWriteJsonSync(this.configPath, this.config);
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
  // Checks BANANA.md at project root first, then .banana/instructions.md as fallback
  getInstructions() {
    // Primary: BANANA.md at project root (like CLAUDE.md pattern)
    const bananaMdPath = path.join(this.projectDir, 'BANANA.md');
    try {
      if (fs.existsSync(bananaMdPath)) {
        return { content: fs.readFileSync(bananaMdPath, 'utf-8'), source: 'BANANA.md' };
      }
    } catch {
      // Fall through
    }
    // Fallback: .banana/instructions.md
    try {
      if (fs.existsSync(this.instructionsPath)) {
        return { content: fs.readFileSync(this.instructionsPath, 'utf-8'), source: '.banana/instructions.md' };
      }
    } catch {
      // No instructions
    }
    // Legacy fallback: RIPLEY.md at project root
    const ripleyMdPath = path.join(this.projectDir, 'RIPLEY.md');
    try {
      if (fs.existsSync(ripleyMdPath)) {
        return { content: fs.readFileSync(ripleyMdPath, 'utf-8'), source: 'RIPLEY.md' };
      }
    } catch {
      // No legacy instructions
    }
    return null;
  }

  createDefaultInstructions() {
    const bananaMdPath = path.join(this.projectDir, 'BANANA.md');
    const template = `# BANANA.md

This file provides project-specific instructions to Banana Code.
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
    atomicWriteFileSync(bananaMdPath, template);
    return template;
  }

  // Conversation history persistence
  saveConversation(name, history) {
    this.ensureDir();
    const filename = `${name.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;
    const filepath = path.join(this.historyDir, filename);
    atomicWriteJsonSync(filepath, {
      name,
      savedAt: new Date().toISOString(),
      history
    });
    return filename;
  }

  saveRunSnapshot(snapshot) {
    this.ensureDir();
    atomicWriteJsonSync(this.runSnapshotPath, {
      savedAt: new Date().toISOString(),
      completed: false,
      ...snapshot
    });
  }

  completeRunSnapshot(extra = {}) {
    this.ensureDir();
    if (!fs.existsSync(this.runSnapshotPath)) return;
    try {
      const existing = JSON.parse(fs.readFileSync(this.runSnapshotPath, 'utf-8'));
      atomicWriteJsonSync(this.runSnapshotPath, {
        ...existing,
        ...extra,
        completed: true,
        completedAt: new Date().toISOString()
      });
    } catch {
      atomicWriteJsonSync(this.runSnapshotPath, {
        completed: true,
        completedAt: new Date().toISOString(),
        ...extra
      });
    }
  }

  getRunSnapshot() {
    try {
      if (!fs.existsSync(this.runSnapshotPath)) return null;
      return JSON.parse(fs.readFileSync(this.runSnapshotPath, 'utf-8'));
    } catch {
      return null;
    }
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
    return path.join(this.bananaDir, 'hooks.json');
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
    atomicWriteJsonSync(this.getHooksPath(), hookConfig);
  }
}

// ─── Global Config (~/.banana/) ──────────────────────────────────────────────

const GLOBAL_BANANA_DIR = path.join(require('os').homedir(), '.banana');

class GlobalConfig {
  constructor() {
    this.bananaDir = GLOBAL_BANANA_DIR;
    this.configPath = path.join(this.bananaDir, 'config.json');
    this.instructionsPath = path.join(this.bananaDir, 'BANANA.md');
    this.commandsDir = path.join(this.bananaDir, 'commands');
    this.config = {};
    this.load();
  }

  ensureDir() {
    for (const dir of [this.bananaDir, this.commandsDir, path.join(this.bananaDir, 'logs')]) {
      ensureDirSync(dir);
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
    atomicWriteJsonSync(this.configPath, this.config);
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
    this.save();
  }

  /**
   * Get global instructions from ~/.banana/BANANA.md
   */
  getInstructions() {
    try {
      if (fs.existsSync(this.instructionsPath)) {
        return { content: fs.readFileSync(this.instructionsPath, 'utf-8'), source: '~/.banana/BANANA.md' };
      }
    } catch {
      // No global instructions
    }
    return null;
  }
}

module.exports = { Config, GlobalConfig, GLOBAL_BANANA_DIR };
