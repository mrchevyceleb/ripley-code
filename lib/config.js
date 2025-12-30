/**
 * Configuration management for Ripley Code
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  apiUrl: 'http://localhost:3000',
  compactMode: false,
  maxTokens: 32000,
  tokenWarningThreshold: 0.8, // Warn at 80% of max
  streamingEnabled: true,
  autoSaveHistory: true,
  historyLimit: 50,
  geminiApiKey: null, // For vision analysis (Alt+V screenshots)
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

    // Also check for env overrides
    if (process.env.RIPLEY_API_URL) {
      this.config.apiUrl = process.env.RIPLEY_API_URL;
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
  getInstructions() {
    try {
      if (fs.existsSync(this.instructionsPath)) {
        return fs.readFileSync(this.instructionsPath, 'utf-8');
      }
    } catch {
      // No instructions
    }
    return null;
  }

  createDefaultInstructions() {
    this.ensureDir();
    const template = `# Project Instructions for Ripley

These instructions are always included in the AI context.

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
    fs.writeFileSync(this.instructionsPath, template);
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
}

module.exports = Config;
