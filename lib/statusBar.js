/**
 * statusBar.js - Pinned status bar at the bottom of the terminal
 *
 * Uses a scroll region to constrain content above the bar, plus cursor
 * save/restore to paint a 3-row bar (rule + content + pad) in the
 * reserved bottom rows. A repaint interval ensures the bar stays visible.
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

const BAR_HEIGHT = 3;
const REPAINT_MS = 250;

class StatusBar {
  constructor() {
    this._installed = false;
    this._lastRendered = '';
    this._repaintTimer = null;
    this._timerStart = null;
    this._responseTime = null;
    this._fields = {
      modelName: '?',
      modelId: '',
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
    this._installed = true;
    this._applyScrollRegion();
    this._renderBar();
    // Continuous repaint to keep bar painted
    this._repaintTimer = setInterval(() => {
      this._lastRendered = '';
      this._renderBar();
    }, REPAINT_MS);
    this._resizeHandler = () => {
      this._lastRendered = '';
      this._applyScrollRegion();
      this._renderBar();
    };
    process.stdout.on('resize', this._resizeHandler);
  }

  /** Uninstall: stop repaint, reset scroll region, clear bar */
  uninstall() {
    if (!process.stdout.isTTY) return;
    this._installed = false;
    if (this._repaintTimer) {
      clearInterval(this._repaintTimer);
      this._repaintTimer = null;
    }
    if (this._resizeHandler) {
      process.stdout.removeListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    // Reset scroll region to full terminal
    process.stdout.write('\x1b[r');
    // Clear the bottom rows
    const rows = process.stdout.rows || 24;
    for (let r = rows - BAR_HEIGHT + 1; r <= rows; r++) {
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

  /** Force a render (called from showPrompt) */
  render() {
    if (this._installed) {
      this._lastRendered = '';
      this._renderBar();
    }
  }

  /** Constrain scrollable area to rows above the bar */
  _applyScrollRegion() {
    const rows = process.stdout.rows || 24;
    const scrollEnd = rows - BAR_HEIGHT;
    process.stdout.write(`\x1b[1;${scrollEnd}r`);
    // Move cursor into scrollable area (don't clear - content may already be there)
    process.stdout.write(`\x1b[${scrollEnd};1H`);
  }

  /** Paint the 3-row bar at the bottom of the terminal */
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
      segments.splice(2, 1);
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }

    // Build the 3 rows
    const rule = `${BORDER_COLOR}${'\u2500'.repeat(cols)}${RESET}`;
    const contentPad = Math.max(0, cols - barVisualLen - 1);
    const content = `${BG_DARK}${FG_LIGHT} ${bar}${' '.repeat(contentPad)}${RESET}`;
    const padRow = `${BG_DARK}${' '.repeat(cols)}${RESET}`;

    const fullBar = rule + content + padRow;
    if (fullBar === this._lastRendered) return;
    this._lastRendered = fullBar;

    const barStartRow = rows - BAR_HEIGHT + 1;

    // Save cursor, draw 3 rows, restore cursor
    process.stdout.write(
      '\x1b[s' +                                       // save cursor (SCO)
      `\x1b[${barStartRow};1H\x1b[2K` + rule +        // row 1: rule
      `\x1b[${barStartRow + 1};1H\x1b[2K` + content + // row 2: content
      `\x1b[${barStartRow + 2};1H\x1b[2K` + padRow +  // row 3: pad
      '\x1b[u'                                          // restore cursor (SCO)
    );
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
