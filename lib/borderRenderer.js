/**
 * borderRenderer.js - Colored left-border prefix strings for message types
 */

const RESET = '\x1b[0m';

const BORDERS = {
  user:     { char: '│', color: '\x1b[38;5;208m' },  // orange
  ai:       { char: '│', color: '\x1b[38;5;75m'  },  // blue/cyan
  thinking: { char: '│', color: '\x1b[38;5;240m' },  // dim gray
  tool:     { char: '│', color: '\x1b[38;5;245m' },  // gray
};

const PAD = '  ';

/**
 * Returns a colored border prefix string for the given speaker type.
 * e.g. "  \x1b[38;5;208m│\x1b[0m "
 */
function prefix(speaker) {
  const b = BORDERS[speaker];
  if (!b) return PAD;
  return `${PAD}${b.color}${b.char}${RESET} `;
}

/**
 * Strip ANSI escape codes from a string for visual width calculation.
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Get the visual (display) width of the prefix for a speaker type.
 */
function prefixWidth(speaker) {
  return stripAnsi(prefix(speaker)).length;
}

module.exports = { prefix, stripAnsi, prefixWidth, BORDERS, PAD };
