/**
 * Prompt Manager for Banana Code
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
   *
   * For code-agent-* prompts, auto-assembles: base.md + code-agent.md + code-agent-{model}.md
   * This eliminates duplication - model files only need their unique quirks.
   *
   * Injects dynamic OS detection to replace the static ## OS block.
   */
  get(name) {
    let prompt;

    if (name.startsWith('code-agent-') && this.prompts[name]) {
      // Assemble: base + code-agent (shared tool instructions) + model-specific quirks
      const parts = [];
      if (this.prompts['base']) parts.push(this.prompts['base']);
      if (this.prompts['code-agent']) parts.push(this.prompts['code-agent']);
      parts.push(this.prompts[name]);
      prompt = parts.join('\n\n');
    } else if (name === 'code-agent' && this.prompts['code-agent']) {
      // code-agent alone: base + code-agent
      const parts = [];
      if (this.prompts['base']) parts.push(this.prompts['base']);
      parts.push(this.prompts['code-agent']);
      prompt = parts.join('\n\n');
    } else {
      prompt = this.prompts[name] || this.prompts['base'] || '';
    }

    // Dynamic OS detection
    const osLine = process.platform === 'win32'
      ? 'Windows. Use PowerShell/cmd syntax for shell commands. No bash, no `ls`, no `grep`. Use `dir`, `Get-ChildItem`, `findstr`, etc.'
      : process.platform === 'darwin'
        ? 'macOS. Use bash/zsh syntax for shell commands. No PowerShell, no `dir`, no `findstr`. Use `ls`, `find`, `grep`, etc.'
        : 'Linux. Use bash syntax for shell commands. No PowerShell, no `dir`, no `findstr`. Use `ls`, `find`, `grep`, etc.';
    prompt = prompt.replace(/^## OS\n\n.+$/gm, `## OS\n\n${osLine}`);
    prompt = prompt.replace(/^OS: Windows\..+$/gm, `OS: ${osLine}`);
    if (process.platform !== 'win32') {
      prompt = prompt.replace(/PowerShell syntax only/g, 'bash/zsh syntax');
      prompt = prompt.replace(/PowerShell syntax only, not bash/g, 'bash/zsh syntax');
      prompt = prompt.replace(/\(PowerShell syntax\)/g, '(bash/zsh syntax)');
    }
    return prompt;
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
