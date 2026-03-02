/**
 * Prompt Manager for Ripley Code v4
 * Loads system prompts from the prompts/ directory.
 * Drop any .md file into prompts/ and it becomes available via /prompt <name>.
 */

const fs = require('fs');
const path = require('path');

class PromptManager {
  constructor(promptsDir) {
    this.promptsDir = promptsDir;
    this.prompts = {};
    this.load();
  }

  load() {
    this.prompts = {};
    try {
      const files = fs.readdirSync(this.promptsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const name = path.basename(file, '.md');
        this.prompts[name] = fs.readFileSync(path.join(this.promptsDir, file), 'utf-8');
      }
    } catch {
      // No prompts directory or can't read - that's ok
    }
  }

  /**
   * Get a prompt by name. Falls back to 'base' if not found.
   */
  get(name) {
    return this.prompts[name] || this.prompts['base'] || '';
  }

  /**
   * List available prompt names
   */
  list() {
    return Object.keys(this.prompts);
  }

  /**
   * Check if a prompt exists
   */
  has(name) {
    return name in this.prompts;
  }

  /**
   * Reload prompts from disk (useful if user drops a new .md file in)
   */
  reload() {
    this.load();
  }
}

module.exports = PromptManager;
