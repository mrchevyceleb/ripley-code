/**
 * Inline ghost-text autocomplete for Ripley Code
 *
 * Fish-shell style: as you type, a dim suggestion appears after the cursor.
 * Tab or Right arrow accepts it.
 *
 * Rendering approach:
 * - Ghost text is written in dim AFTER the cursor, then cursor is moved back
 * - Clearing uses \x1b[K (erase from cursor to end of line) for a clean wipe
 * - No save/restore cursor (unreliable with readline's internal state)
 */

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const ERASE_TO_EOL = '\x1b[K';
const CURSOR_BACK = (n) => n > 0 ? `\x1b[${n}D` : '';

class InlineComplete {
  constructor() {
    this.currentGhost = '';  // The ghost text currently displayed
    this.commands = [];      // All known commands (sorted)
    this.justAccepted = false; // Flag: ghost was just accepted via Tab
  }

  /**
   * Update the list of known commands.
   * @param {string[]} commands - Array of command strings like ['/help', '/push', ...]
   */
  setCommands(commands) {
    this.commands = [...commands].sort();
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
    if (!line || !line.startsWith('/')) return null;

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

    // Ambiguous - show the shortest match's remainder as a hint
    const shortest = matches.reduce((a, b) => a.length <= b.length ? a : b);
    return shortest.slice(line.length);
  }

  /**
   * Render ghost text after the cursor position.
   * Writes dimmed text, then moves cursor back so readline's cursor stays put.
   *
   * @param {string} ghost - The ghost text to display
   */
  renderGhost(ghost) {
    if (!ghost) return;
    this.currentGhost = ghost;
    // Write dim ghost text, then move cursor back to original position
    process.stdout.write(`${DIM}${ghost}${RESET}${CURSOR_BACK(ghost.length)}`);
  }

  /**
   * Clear any currently displayed ghost text.
   * Uses "erase to end of line" which cleanly removes everything after the cursor.
   */
  clearGhost() {
    if (!this.currentGhost) return;
    process.stdout.write(ERASE_TO_EOL);
    this.currentGhost = '';
  }

  /**
   * Accept the current ghost text.
   * Clears the visual ghost, sets a flag so the readline completer knows to skip,
   * and returns the text to be inserted via rl.write().
   */
  accept() {
    const ghost = this.currentGhost;
    if (!ghost) return null;
    this.justAccepted = true;
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
