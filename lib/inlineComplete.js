/**
 * Inline ghost-text autocomplete for Banana Code
 *
 * Fish-shell style: as you type, a dim suggestion appears after the cursor.
 * Tab or Right arrow accepts it.
 *
 * This class manages suggestion logic and ghost state.
 * Visual rendering is handled in banana.js via the keypress event loop:
 * - prependListener: \x1b[K clears ghost BEFORE readline processes keystroke
 * - setImmediate: renders new ghost in dim AFTER readline updates cursor
 */

const fs = require('fs');
const path = require('path');

class InlineComplete {
  constructor() {
    this.currentGhost = '';  // The ghost text currently displayed
    this.commands = [];      // All known commands (sorted)
    this.projectDir = null;  // For @ file path completion
    this.justAccepted = false; // Flag: next completer call should skip once
  }

  /**
   * Update the list of known commands.
   * @param {string[]} commands - Array of command strings like ['/help', '/push', ...]
   */
  setCommands(commands) {
    this.commands = [...(commands || [])].sort();
  }

  /**
   * Find the best single suggestion for the current line.
   * Returns the REMAINING text to complete (not the full command).
   * Returns null if no match or ambiguous.
   *
   * @param {string} line - Current input line
   * @returns {string|null} - Ghost text to display, or null
   */
  suggest(line) {
    if (!line) return null;

    // @ file path completion - find the last @ in the line
    const atIndex = line.lastIndexOf('@');
    if (atIndex >= 0) {
      const partial = line.slice(atIndex + 1);
      // Only suggest if there's something after @ (user started typing a path)
      if (partial.length > 0) {
        return this._suggestFilePath(partial);
      }
      return null;
    }

    // / command completion
    if (!line.startsWith('/')) return null;

    const lower = line.toLowerCase();
    const matches = this.commands.filter(c => c.toLowerCase().startsWith(lower));

    if (matches.length === 0) return null;

    // Exact match - nothing to suggest
    if (matches.some(c => c.toLowerCase() === lower)) return null;

    // Single match - return the remaining portion
    if (matches.length === 1) {
      return matches[0].slice(line.length);
    }

    // Multiple matches - find common prefix beyond what's typed
    const prefix = commonPrefix(matches.map(c => c.slice(line.length)));
    if (prefix.length > 0) return prefix;

    // Ambiguous with no common prefix - show nothing rather than guess
    return null;
  }

  /**
   * Suggest a file path completion for @ mentions.
   * Returns the remaining text to append, or null.
   */
  _suggestFilePath(partial) {
    if (!this.projectDir) return null;

    try {
      const searchDir = partial.includes('/')
        ? path.dirname(partial)
        : '.';
      const searchBase = partial.includes('/')
        ? path.basename(partial)
        : partial;
      const fullSearchDir = path.join(this.projectDir, searchDir);

      if (!fs.existsSync(fullSearchDir)) return null;

      const entries = fs.readdirSync(fullSearchDir, { withFileTypes: true });
      const matches = entries
        .filter(e => {
          if (e.name.startsWith('.')) return false;
          if (e.name === 'node_modules') return false;
          return e.name.toLowerCase().startsWith(searchBase.toLowerCase());
        })
        .map(e => {
          const rel = searchDir === '.'
            ? e.name
            : path.join(searchDir, e.name).replace(/\\/g, '/');
          return rel + (e.isDirectory() ? '/' : '');
        });

      if (matches.length === 0) return null;

      // Single match
      if (matches.length === 1) {
        return matches[0].slice(partial.length);
      }

      // Multiple matches - find common prefix
      const prefix = commonPrefix(matches.map(m => m.slice(partial.length)));
      if (prefix.length > 0) return prefix;

      // Ambiguous with no common prefix - show nothing rather than guess
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Store ghost text suggestion. Visual rendering is done by banana.js.
   * @param {string} ghost - The ghost text to store
   */
  renderGhost(ghost) {
    if (!ghost) return;
    this.currentGhost = ghost;
  }

  /**
   * Clear the ghost text state. Terminal cleanup is done by banana.js prependListener.
   */
  clearGhost() {
    this.currentGhost = '';
  }

  /**
   * Accept the current ghost text.
   * Clears the visual ghost and optionally marks the next completer call to skip.
   * Returns the text to be inserted via rl.write().
   */
  accept(markForCompleter = false) {
    const ghost = this.currentGhost;
    if (!ghost) return null;
    this.justAccepted = Boolean(markForCompleter);
    this.clearGhost();
    return ghost;
  }

  /**
   * Check if ghost text is currently showing.
   */
  hasGhost() {
    return this.currentGhost.length > 0;
  }

  /**
   * Check and reset the justAccepted flag.
   * Called by the readline completer to know if it should skip completion.
   */
  consumeAccepted() {
    if (this.justAccepted) {
      this.justAccepted = false;
      return true;
    }
    return false;
  }
}

/**
 * Find the longest common prefix of an array of strings.
 */
function commonPrefix(strings) {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return '';
    }
  }
  return prefix;
}

module.exports = InlineComplete;
