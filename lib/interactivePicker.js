/**
 * Interactive arrow-key picker for Ripley Code
 *
 * Renders a navigable list in the terminal. Arrow keys move highlight,
 * Enter selects, Escape cancels. Temporarily takes over stdin.
 */

const readline = require('readline');

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;
const MOVE_UP = (n) => n > 0 ? `${ESC}[${n}A` : '';
const MOVE_COL0 = `${ESC}[0G`;

// 256-color codes matching diffViewer.js palette
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[38;5;120m`;
const YELLOW = `${ESC}[38;5;226m`;
const CYAN = `${ESC}[38;5;51m`;
const GRAY = `${ESC}[38;5;245m`;
const INVERSE = `${ESC}[7m`;

/**
 * Show an interactive picker menu.
 *
 * @param {Array} items - Array of { key, label, description, active, tags }
 * @param {Object} options
 * @param {string} options.title - Header text
 * @param {number} options.selected - Initial selected index (default: active item or 0)
 * @returns {Promise<Object|null>} - Selected item, or null if cancelled
 */
function pick(items, options = {}) {
  return new Promise((resolve) => {
    if (!items || items.length === 0) {
      resolve(null);
      return;
    }

    let selected = options.selected ?? items.findIndex(i => i.active);
    if (selected < 0) selected = 0;

    const out = process.stdout;
    const title = options.title || 'Select:';
    const showVisionIndicator = options.showVisionIndicator === true;
    const footerText = showVisionIndicator
      ? `${DIM}  ↑↓ navigate  Enter select  Esc cancel  V=vision${RESET}`
      : `${DIM}  ↑↓ navigate  Enter select  Esc cancel${RESET}`;

    // Pad key names to align descriptions
    const maxKeyLen = Math.max(...items.map(i => (i.key || '').length));

    function formatItem(item, index) {
      const isSel = index === selected;
      const isActive = item.active;
      const marker = isActive ? `${GREEN}●${RESET}` : `${GRAY}○${RESET}`;
      const pointer = isSel ? `${CYAN}▸${RESET} ` : '  ';
      const hasVision = Array.isArray(item.tags) && item.tags.includes('vision');
      const vision = showVisionIndicator
        ? (hasVision ? `${CYAN}V${RESET}` : `${DIM}.${RESET}`)
        : '';
      const key = (item.key || '').padEnd(maxKeyLen);
      const tags = item.tags?.length ? ` ${DIM}[${item.tags.join(', ')}]${RESET}` : '';
      const desc = item.description ? ` ${DIM}- ${item.description}${RESET}` : '';
      const label = item.label || item.name || item.key;

      if (isSel) {
        const lead = showVisionIndicator ? `${pointer}${marker} ${vision} ` : `${pointer}${marker} `;
        return `${lead}${INVERSE} ${YELLOW}${key}${RESET}${INVERSE}  ${label} ${RESET}${tags}`;
      }
      const lead = showVisionIndicator ? `${pointer}${marker} ${vision} ` : `${pointer}${marker} `;
      return `${lead}${YELLOW}${key}${RESET}  ${DIM}${label}${RESET}${tags}`;
    }

    // Total lines we render (title + items + footer)
    const totalLines = 1 + items.length + 1;

    function render() {
      let buf = HIDE_CURSOR;
      buf += `\n${CYAN}  ${title}${RESET}\n`;
      for (let i = 0; i < items.length; i++) {
        buf += `  ${formatItem(items[i], i)}\n`;
      }
      buf += `${footerText}\n`;
      out.write(buf);
    }

    function redraw() {
      let buf = MOVE_UP(totalLines) + MOVE_COL0;
      for (let i = 0; i < totalLines; i++) {
        buf += CLEAR_LINE + '\n';
      }
      buf += MOVE_UP(totalLines) + MOVE_COL0;
      buf += `${CYAN}  ${title}${RESET}\n`;
      for (let i = 0; i < items.length; i++) {
        buf += `  ${formatItem(items[i], i)}\n`;
      }
      buf += `${footerText}\n`;
      out.write(buf);
    }

    function cleanup() {
      process.stdin.removeListener('keypress', onKey);
      out.write(SHOW_CURSOR);
    }

    function onKey(str, key) {
      if (!key) return;

      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length;
        redraw();
      } else if (key.name === 'down') {
        selected = (selected + 1) % items.length;
        redraw();
      } else if (key.name === 'return') {
        cleanup();
        resolve(items[selected]);
      } else if (key.name === 'escape') {
        cleanup();
        resolve(null);
      }
    }

    // Ensure keypress events are flowing
    if (!process.stdin.listenerCount('keypress')) {
      readline.emitKeypressEvents(process.stdin);
    }

    render();
    process.stdin.on('keypress', onKey);
  });
}

module.exports = { pick };
