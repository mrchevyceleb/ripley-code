/**
 * statusBar.js - Persistent bottom-row status bar using ANSI scroll region
 *
 * Sets scroll region to [1, rows-1] so normal output scrolls above the
 * reserved bottom row. Status bar renders on the last row via direct
 * cursor positioning.
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BG_DARK = '\x1b[48;5;236m';
const FG_LIGHT = '\x1b[38;5;252m';
const SEP = `${DIM} │ ${RESET}`;

class StatusBar {
  constructor() {
    this._installed = false;
    this._lastRendered = '';
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

  /** Check if we can render (TTY only) */
  get _canRender() {
    return process.stdout.isTTY && this._installed;
  }

  /** Install the status bar: set scroll region, render initial bar */
  install() {
    if (!process.stdout.isTTY) return;
    this._installed = true;
    this._applyScrollRegion();
    this.render();

    // Re-apply on terminal resize
    this._resizeHandler = () => this.handleResize();
    process.stdout.on('resize', this._resizeHandler);
  }

  /** Uninstall: reset scroll region, clear bottom row */
  uninstall() {
    if (!process.stdout.isTTY) return;
    this._installed = false;

    if (this._resizeHandler) {
      process.stdout.removeListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    // Reset scroll region to full terminal
    process.stdout.write('\x1b[r');
    // Move to bottom and clear
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
  }

  /** Reinstall after console.clear() */
  reinstall() {
    if (!process.stdout.isTTY) return;
    this._lastRendered = '';
    this._applyScrollRegion();
    this.render();
  }

  /** Partial field update + re-render */
  update(fields) {
    Object.assign(this._fields, fields);
    this.render();
  }

  /** Start wall-clock response timer */
  startTiming() {
    this._timerStart = Date.now();
    this._responseTime = null;
  }

  /** Stop timer and update display */
  stopTiming() {
    if (this._timerStart) {
      this._responseTime = ((Date.now() - this._timerStart) / 1000).toFixed(1);
      this._timerStart = null;
      this.render();
    }
  }

  /** Handle terminal resize */
  handleResize() {
    if (!this._installed) return;
    this._lastRendered = '';
    this._applyScrollRegion();
    this.render();
  }

  /** Apply ANSI scroll region: rows 1 to (rows-1) */
  _applyScrollRegion() {
    const rows = process.stdout.rows || 24;
    // Set scroll region to exclude bottom row
    process.stdout.write(`\x1b[1;${rows - 1}r`);
    // Move cursor back into scrollable area
    process.stdout.write(`\x1b[${rows - 1};1H`);
  }

  /** Render the status bar on the reserved bottom row */
  render() {
    if (!this._canRender) return;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const f = this._fields;

    // Build segments
    const segments = [];

    // Model name + ID
    const modelDisplay = f.modelId
      ? `${f.modelName} (${f.modelId})`
      : f.modelName;
    segments.push(modelDisplay);

    // Context percentage with color coding
    const ctxColor = f.contextPct >= 80 ? RED : f.contextPct >= 50 ? YELLOW : GREEN;
    const ctxTokensStr = this._formatTokens(f.contextTokens);
    const ctxLimitStr = this._formatTokens(f.contextLimit);
    const ctxDisplay = f.contextLimit
      ? `ctx: ${ctxColor}${f.contextPct}%${RESET}${BG_DARK}${FG_LIGHT} (${ctxTokensStr}/${ctxLimitStr})`
      : `ctx: ${ctxColor}${f.contextPct}%${RESET}${BG_DARK}${FG_LIGHT}`;
    segments.push(ctxDisplay);

    // MCP status
    const mcpDot = f.mcpConnected
      ? `${GREEN}●${RESET}${BG_DARK}${FG_LIGHT}`
      : `${RED}●${RESET}${BG_DARK}${FG_LIGHT}`;
    segments.push(`MCP: ${mcpDot}`);

    // Token counts
    const inStr = this._formatTokens(f.sessionIn);
    const outStr = this._formatTokens(f.sessionOut);
    segments.push(`in:${inStr} out:${outStr}`);

    // Response time (if available)
    if (this._responseTime) {
      segments.push(`${this._responseTime}s`);
    }

    // Progressive collapse for narrow terminals
    let bar = this._joinSegments(segments);
    let barVisualLen = this._visualLen(bar);

    // Hide response time first
    if (barVisualLen > cols - 4 && this._responseTime) {
      segments.pop();
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }
    // Hide model ID next
    if (barVisualLen > cols - 4 && f.modelId) {
      segments[0] = f.modelName;
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }
    // Hide MCP last
    if (barVisualLen > cols - 4) {
      segments.splice(2, 1);
      bar = this._joinSegments(segments);
      barVisualLen = this._visualLen(bar);
    }

    // Pad to full width (leading space is part of the bar, so subtract 1 from available padding)
    const padding = Math.max(0, cols - barVisualLen - 1);
    const fullBar = `${BG_DARK}${FG_LIGHT} ${bar}${' '.repeat(padding)}${RESET}`;

    // Deduplicate renders
    if (fullBar === this._lastRendered) return;
    this._lastRendered = fullBar;

    // Save cursor → move to bottom row → clear → write → restore cursor
    process.stdout.write(
      `\x1b7` +                    // save cursor
      `\x1b[${rows};1H` +         // move to last row
      `\x1b[2K` +                 // clear line
      fullBar +                    // write bar
      `\x1b8`                      // restore cursor
    );
  }

  /** Join segments with separator */
  _joinSegments(segments) {
    return segments.join(`${RESET}${BG_DARK}${FG_LIGHT}${SEP}${BG_DARK}${FG_LIGHT}`);
  }

  /** Format token count: 1234 → "1.2K", 12345 → "12.3K" */
  _formatTokens(n) {
    if (!n || n === 0) return '0';
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + 'K';
  }

  /** Calculate visual width (strip ANSI) */
  _visualLen(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
  }
}

module.exports = StatusBar;
