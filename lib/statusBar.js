/**
 * statusBar.js - Pinned status bar at the bottom of the terminal
 *
 * Uses a scroll region to constrain content above the bar, plus cursor
 * save/restore to paint a 3-row bar (rule + content + pad) in the
 * reserved bottom rows, with a blank spacer row above it so the input
 * prompt is not visually cramped. The bar is rendered on demand (updates, prompt,
 * resize) to avoid cursor races while typing.
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BG_DARK = '\x1b[48;5;236m';
const FG_LIGHT = '\x1b[38;5;252m';
const BORDER_COLOR = '\x1b[38;5;240m';
const SEP = `${DIM} \u2502 ${RESET}`;

const BAR_HEIGHT = 4;
const GAP_ROWS = 1;
class StatusBar {
  constructor() {
    this._installed = false;
    this._lastRendered = '';
    this._timerStart = null;
    this._responseTime = null;
    this._inputHint = '';  // Dim text shown in gap row during active work
    this._fields = {
      modelName: '?',
      modelId: '',
      mode: 'work',
      contextPct: 0,
      contextTokens: 0,
      contextLimit: 0,
      mcpConnected: false,
      sessionIn: 0,
      sessionOut: 0,
    };
  }

  /** Install: set scroll region, start repaint interval, listen for resize */
  install() {
    if (!process.stdout.isTTY) return;
    if (this._installed) {
      this._lastRendered = '';
      this._applyScrollRegion();
      this._renderBar();
      return;
    }
    this._installed = true;
    this._applyScrollRegion();
    this._renderBar();
    this._resizeHandler = () => {
      this._lastRendered = '';
      this._applyScrollRegion();
      this._renderBar();
      this._paintGapRow();
    };
    process.stdout.on('resize', this._resizeHandler);
  }

  /** Uninstall: stop repaint, reset scroll region, clear bar */
  uninstall() {
    if (!process.stdout.isTTY) return;
    this._installed = false;
    if (this._resizeHandler) {
      process.stdout.removeListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    // Reset scroll region to full terminal
    process.stdout.write('\x1b[r');
    // Clear the reserved rows (gap + bar)
    const rows = process.stdout.rows || 24;
    const reserved = BAR_HEIGHT + GAP_ROWS;
    const clearStart = Math.max(1, rows - reserved + 1);
    for (let r = clearStart; r <= rows; r++) {
      process.stdout.write(`\x1b[${r};1H\x1b[2K`);
    }
  }

  /** Reinstall after console.clear() */
  reinstall() {
    if (!process.stdout.isTTY) return;
    this._installed = true;
    this._lastRendered = '';
    this._applyScrollRegion();
    this._renderBar();
  }

  /** Partial field update + re-render */
  update(fields) {
    Object.assign(this._fields, fields);
    if (this._installed) this._renderBar();
  }

  /** Start wall-clock response timer */
  startTiming() {
    this._timerStart = Date.now();
    this._responseTime = null;
  }

  /** Stop timer and re-render */
  stopTiming() {
    if (this._timerStart) {
      this._responseTime = ((Date.now() - this._timerStart) / 1000).toFixed(1);
      this._timerStart = null;
      if (this._installed) this._renderBar();
    }
  }

  /** Show or clear the input hint in the gap row above the bar */
  setInputHint(text) {
    this._inputHint = text || '';
    if (this._installed) this._paintGapRow();
  }

  /** Force a render (called from showPrompt) */
  render() {
    if (this._installed) {
      this._lastRendered = '';
      this._renderBar();
      this._paintGapRow();
    }
  }

  /** Constrain scrollable area to rows above the bar.
   *  Uses cursor save/restore so the cursor stays wherever it was before. */
  _applyScrollRegion() {
    const rows = process.stdout.rows || 24;
    const reserved = BAR_HEIGHT + GAP_ROWS;
    const scrollEnd = Math.max(1, rows - reserved);
    // Save cursor, set scroll region, restore cursor.
    // This prevents the scroll region reset from moving the cursor.
    process.stdout.write(`\x1b[s\x1b[1;${scrollEnd}r\x1b[u`);
  }

  /** Force-repaint the bar. Safe to call frequently (e.g. after every
   *  clearLine/cursorTo in spinner code). Does NOT reapply the scroll
   *  region since clearLine/cursorTo don't reset it. */
  refresh() {
    if (!process.stdout.isTTY || !this._installed) return;
    this._lastRendered = '';
    this._renderBar();
  }

  /** Paint the status bar rows at the bottom of the terminal */
  _renderBar() {
    if (!process.stdout.isTTY || !this._installed) return;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const f = this._fields;

    // Build content segments
    const segments = [];

    const modelDisplay = f.modelId
      ? `${f.modelName} (${f.modelId})`
      : f.modelName;
    segments.push(modelDisplay);

    // Mode indicator
    const modeColors = { work: GREEN, plan: '\x1b[36m', ask: '\x1b[35m' };
    const modeColor = modeColors[f.mode] || GREEN;
    segments.push(`${modeColor}${(f.mode || 'work').toUpperCase()}${RESET}${BG_DARK}${FG_LIGHT}`);

    const ctxColor = f.contextPct >= 80 ? RED : f.contextPct >= 50 ? YELLOW : GREEN;
    const ctxTokensStr = this._formatTokens(f.contextTokens);
    const ctxLimitStr = this._formatTokens(f.contextLimit);
    const ctxDisplay = f.contextLimit
      ? `ctx: ${ctxColor}${f.contextPct}%${RESET}${BG_DARK}${FG_LIGHT} (${ctxTokensStr}/${ctxLimitStr})`
      : `ctx: ${ctxColor}${f.contextPct}%${RESET}${BG_DARK}${FG_LIGHT}`;
    segments.push(ctxDisplay);

    const mcpDot = f.mcpConnected
      ? `${GREEN}\u25CF${RESET}${BG_DARK}${FG_LIGHT}`
      : `${RED}\u25CF${RESET}${BG_DARK}${FG_LIGHT}`;
    segments.push(`MCP: ${mcpDot}`);

    const inStr = this._formatTokens(f.sessionIn);
    const outStr = this._formatTokens(f.sessionOut);
    segments.push(`in:${inStr} out:${outStr}`);

    if (this._responseTime) {
      segments.push(`${this._responseTime}s`);
    }

    // Progressive collapse for narrow terminals
    let bar = this._joinSegments(segments);
    let barVisualLen = this._visualLen(bar);

    if (barVisualLen > cols - 4 && this._responseTime) {
      segments.pop();
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }
    if (barVisualLen > cols - 4 && f.modelId) {
      segments[0] = f.modelName;
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }
    if (barVisualLen > cols - 4) {
      // Remove MCP segment (index 3: model, mode, ctx, MCP, in/out)
      const mcpIdx = segments.findIndex(s => s.startsWith('MCP:'));
      if (mcpIdx !== -1) segments.splice(mcpIdx, 1);
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }

    // Build the 4 rows: rule, top pad, content, bottom pad
    const rule = `${BORDER_COLOR}${'\u2500'.repeat(cols)}${RESET}`;
    const contentPad = Math.max(0, cols - barVisualLen - 1);
    const content = `${BG_DARK}${FG_LIGHT} ${bar}${' '.repeat(contentPad)}${RESET}`;
    const padRow = `${BG_DARK}${' '.repeat(cols)}${RESET}`;

    const fullBar = rule + padRow + content + padRow;
    if (fullBar === this._lastRendered) return;
    this._lastRendered = fullBar;

    const barStartRow = rows - BAR_HEIGHT + 1;

    // Save cursor, draw bar rows, restore cursor.
    let paint = '\x1b[s';
    paint +=
      `\x1b[${barStartRow};1H\x1b[2K` + rule +            // row 1: rule
      `\x1b[${barStartRow + 1};1H\x1b[2K` + padRow +      // row 2: top pad
      `\x1b[${barStartRow + 2};1H\x1b[2K` + content +     // row 3: content
      `\x1b[${barStartRow + 3};1H\x1b[2K` + padRow +      // row 4: bottom pad
      '\x1b[u';
    process.stdout.write(paint);
  }

  /** Paint the gap row above the bar with the input hint (or blank) */
  _paintGapRow() {
    if (!process.stdout.isTTY || !this._installed) return;
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const gapRow = rows - BAR_HEIGHT - GAP_ROWS + 1;
    if (gapRow < 1) return;

    let rowContent;
    if (this._inputHint) {
      const hint = this._inputHint.length > cols - 2
        ? this._inputHint.slice(0, cols - 2)
        : this._inputHint;
      rowContent = `${DIM} ${hint}${RESET}`;
    } else {
      rowContent = '';
    }
    process.stdout.write(`\x1b[s\x1b[${gapRow};1H\x1b[2K${rowContent}\x1b[u`);
  }

  _joinSegments(segments) {
    return segments.join(`${RESET}${BG_DARK}${FG_LIGHT}${SEP}${BG_DARK}${FG_LIGHT}`);
  }

  _formatTokens(n) {
    if (!n || n === 0) return '0';
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + 'K';
  }

  _visualLen(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
  }
}

module.exports = StatusBar;
