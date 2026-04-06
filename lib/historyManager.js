/**
 * Command history manager with readline integration
 */

const fs = require('fs');
const path = require('path');
const { ensureDirSync, atomicWriteFileSync } = require('./fsUtils');

class HistoryManager {
  constructor(bananaDir, maxHistory = 100) {
    this.historyFile = path.join(bananaDir, 'command_history.txt');
    this.maxHistory = maxHistory;
    this.history = [];
    this.historyIndex = -1;
    this.currentInput = '';
    this.load();
  }

  load() {
    try {
      let filePath = this.historyFile;
      // Migrate from .ripley/ history if .banana/ history doesn't exist
      if (!fs.existsSync(filePath)) {
        const legacyPath = filePath.replace(/\.banana/, '.ripley');
        if (legacyPath !== filePath && fs.existsSync(legacyPath)) {
          filePath = legacyPath;
        }
      }
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.history = content.split('\n').filter(line => line.trim());
        // Keep only recent history
        if (this.history.length > this.maxHistory) {
          this.history = this.history.slice(-this.maxHistory);
        }
        // If we read from legacy path, save to new path
        if (filePath !== this.historyFile) {
          this.save();
        }
      }
    } catch {
      this.history = [];
    }
  }

  save() {
    try {
      ensureDirSync(path.dirname(this.historyFile));
      atomicWriteFileSync(this.historyFile, this.history.join('\n'));
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
