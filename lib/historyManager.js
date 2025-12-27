/**
 * Command history manager with readline integration
 */

const fs = require('fs');
const path = require('path');

class HistoryManager {
  constructor(ripleyDir, maxHistory = 100) {
    this.historyFile = path.join(ripleyDir, 'command_history.txt');
    this.maxHistory = maxHistory;
    this.history = [];
    this.historyIndex = -1;
    this.currentInput = '';
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const content = fs.readFileSync(this.historyFile, 'utf-8');
        this.history = content.split('\n').filter(line => line.trim());
        // Keep only recent history
        if (this.history.length > this.maxHistory) {
          this.history = this.history.slice(-this.maxHistory);
        }
      }
    } catch {
      this.history = [];
    }
  }

  save() {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.historyFile, this.history.join('\n'));
    } catch {
      // Ignore save errors
    }
  }

  add(command) {
    if (!command.trim()) return;

    // Don't add duplicates of the last command
    if (this.history.length > 0 && this.history[this.history.length - 1] === command) {
      return;
    }

    this.history.push(command);

    // Trim history if too long
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    this.resetIndex();
    this.save();
  }

  resetIndex() {
    this.historyIndex = this.history.length;
    this.currentInput = '';
  }

  up(currentLine) {
    if (this.historyIndex === this.history.length) {
      this.currentInput = currentLine;
    }

    if (this.historyIndex > 0) {
      this.historyIndex--;
      return this.history[this.historyIndex];
    }

    return this.history[0] || currentLine;
  }

  down(currentLine) {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      return this.history[this.historyIndex];
    } else if (this.historyIndex === this.history.length - 1) {
      this.historyIndex = this.history.length;
      return this.currentInput;
    }

    return currentLine;
  }

  search(prefix) {
    const matches = this.history.filter(cmd =>
      cmd.toLowerCase().startsWith(prefix.toLowerCase())
    );
    return matches;
  }

  getRecent(count = 10) {
    return this.history.slice(-count);
  }

  clear() {
    this.history = [];
    this.resetIndex();
    this.save();
  }
}

module.exports = HistoryManager;
