/**
 * Markdown to Terminal renderer for Banana Code
 *
 * Renders Markdown syntax to ANSI-styled terminal output.
 * Works with streaming by buffering incomplete patterns.
 */

// ANSI escape codes
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Colors
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  banana: '\x1b[38;5;220m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  // Backgrounds
  bgGray: '\x1b[48;5;236m',
  bgDarkGray: '\x1b[48;5;234m',
};

// OSC 8 hyperlink helpers (Ctrl+Click in modern terminals)
const oscLink = (url, text) => `\x1b]8;;${url}\x07${ansi.underline}${ansi.blue}${text}${ansi.reset}\x1b]8;;\x07`;
const oscFileLink = (filePath, text) => {
  // Convert to file:// URI for local file Ctrl+Click
  const normalized = filePath.replace(/\\/g, '/');
  const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
  return `\x1b]8;;${fileUrl}\x07${ansi.underline}${ansi.cyan}${text}${ansi.reset}\x1b]8;;\x07`;
};

// Patterns for detecting URLs and file paths
const URL_RE = /https?:\/\/[^\s)\]>]+/;
const FILE_PATH_RE = /(?:[A-Z]:\\|\.\/|\.\.\/|\/)[^\s:*?"<>|)]+\.[a-zA-Z0-9]+/;

class MarkdownRenderer {
  constructor() {
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeBlockLang = '';
    this.inInlineCode = false;
    this.lineStart = true;
    this.tableRows = [];
  }

  /**
   * Process streaming text and return rendered output
   * Buffers incomplete Markdown patterns
   */
  render(text) {
    this.buffer += text;
    let output = '';
    let processed = 0;

    while (processed < this.buffer.length) {
      const remaining = this.buffer.slice(processed);

      // Handle code blocks (```)
      if (remaining.startsWith('```')) {
        // Look for end of opening line or closing ```
        if (this.inCodeBlock) {
          // Closing code block
          output += ansi.reset;
          output += `\n${ansi.dim}└${'─'.repeat(39)}${ansi.reset}\n`;
          this.inCodeBlock = false;
          this.codeBlockLang = '';
          processed += 3;
          // Skip newline after closing ```
          if (this.buffer[processed] === '\n') processed++;
          this.lineStart = true;
          continue;
        } else {
          // Opening code block - find the language and newline
          const newlineIdx = remaining.indexOf('\n');
          if (newlineIdx === -1) {
            // Wait for more input
            break;
          }
          this.codeBlockLang = remaining.slice(3, newlineIdx).trim();
          this.inCodeBlock = true;
          output += `${ansi.dim}┌─${this.codeBlockLang ? ` ${this.codeBlockLang} ` : ''}${'─'.repeat(Math.max(0, 36 - (this.codeBlockLang?.length || 0)))}${ansi.reset}\n`;
          output += ansi.cyan;
          processed += newlineIdx + 1;
          this.lineStart = true;
          continue;
        }
      }

      // Inside code block - output directly with styling
      if (this.inCodeBlock) {
        const char = this.buffer[processed];
        if (char === '\n') {
          output += ansi.reset + '\n' + ansi.cyan;
          this.lineStart = true;
        } else {
          if (this.lineStart) {
            output += ansi.dim + '│ ' + ansi.reset + ansi.cyan;
            this.lineStart = false;
          }
          output += char;
        }
        processed++;
        continue;
      }

      // Check for potential incomplete patterns at end of buffer
      if (processed === this.buffer.length - 1 || processed === this.buffer.length - 2) {
        // Could be start of ``` or ** or __ or `
        const endChars = remaining;
        if (endChars === '`' || endChars === '``' ||
            endChars === '*' || endChars === '**' ||
            endChars === '_' || endChars === '__' ||
            endChars === '#') {
          // Wait for more input
          break;
        }
      }

      // Inline code (`)
      if (remaining[0] === '`' && !remaining.startsWith('```')) {
        const endIdx = remaining.indexOf('`', 1);
        const newlineIdx = remaining.indexOf('\n', 1);
        // Inline code should not span across newlines. If a newline appears
        // before a closing backtick, treat this as a literal backtick.
        if (newlineIdx !== -1 && (endIdx === -1 || newlineIdx < endIdx)) {
          output += '`';
          processed++;
          this.lineStart = false;
          continue;
        }
        if (endIdx === -1) {
          // Don't stall rendering forever on a stray/unbalanced backtick.
          if (remaining.length > 120) {
            output += '`';
            processed++;
            this.lineStart = false;
            continue;
          }
          // Wait for closing backtick
          break;
        }
        const code = remaining.slice(1, endIdx);
        output += `${ansi.banana}${code}${ansi.reset}`;
        processed += endIdx + 1;
        this.lineStart = false;
        continue;
      }

      // Markdown links [text](url)
      if (remaining[0] === '[') {
        const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          const linkText = linkMatch[1];
          const linkUrl = linkMatch[2];
          if (linkUrl.startsWith('http://') || linkUrl.startsWith('https://')) {
            output += oscLink(linkUrl, linkText);
          } else {
            // Assume file path
            output += oscFileLink(linkUrl, linkText);
          }
          processed += linkMatch[0].length;
          this.lineStart = false;
          continue;
        }
      }

      // Bare URLs (https://... or http://...)
      if ((remaining.startsWith('https://') || remaining.startsWith('http://')) && !this.inCodeBlock) {
        const urlMatch = remaining.match(URL_RE);
        if (urlMatch) {
          const url = urlMatch[0];
          output += oscLink(url, url);
          processed += url.length;
          this.lineStart = false;
          continue;
        }
      }

      // File paths (C:\..., ./..., ../..., /...) outside code blocks
      if (!this.inCodeBlock) {
        const fileMatch = remaining.match(FILE_PATH_RE);
        if (fileMatch && fileMatch.index === 0) {
          const filePath = fileMatch[0];
          output += oscFileLink(filePath, filePath);
          processed += filePath.length;
          this.lineStart = false;
          continue;
        }
      }

      // Bold (**text** or __text__)
      if (remaining.startsWith('**') || remaining.startsWith('__')) {
        const marker = remaining.slice(0, 2);
        const endIdx = remaining.indexOf(marker, 2);
        if (endIdx === -1) {
          // Wait for closing marker
          break;
        }
        const boldText = remaining.slice(2, endIdx);
        output += `${ansi.bold}${ansi.banana}${boldText}${ansi.reset}`;
        processed += endIdx + 2;
        this.lineStart = false;
        continue;
      }

      // Italic (*text* or _text_) - but not ** or __
      if ((remaining[0] === '*' || remaining[0] === '_') &&
          remaining[1] !== '*' && remaining[1] !== '_' && remaining[1] !== ' ') {
        const marker = remaining[0];
        const endIdx = remaining.indexOf(marker, 1);
        if (endIdx === -1 || endIdx === 1) {
          // Not italic, just output the character
          output += remaining[0];
          processed++;
          this.lineStart = false;
          continue;
        }
        const italicText = remaining.slice(1, endIdx);
        output += `${ansi.italic}${italicText}${ansi.reset}`;
        processed += endIdx + 1;
        this.lineStart = false;
        continue;
      }

      // Headers at line start (# ## ### etc.)
      if (this.lineStart && remaining[0] === '#') {
        // Wait for complete line before parsing header
        if (!remaining.includes('\n') && remaining.length < 100) {
          break;
        }
        const match = remaining.match(/^(#{1,6})\s+(.*)\n/);
        if (match) {
          const level = match[1].length;
          const headerText = match[2];
          const colors = [ansi.banana, ansi.banana, ansi.yellow, ansi.magenta, ansi.blue, ansi.white];
          output += `${ansi.bold}${colors[level - 1] || ansi.white}${headerText}${ansi.reset}\n\n`;
          processed += match[0].length;
          this.lineStart = true;
          continue;
        }
      }

      // Bullet points at line start
      if (this.lineStart && (remaining.startsWith('- ') || remaining.startsWith('* ') || remaining.startsWith('• '))) {
        output += `${ansi.cyan}•${ansi.reset} `;
        processed += 2;
        this.lineStart = false;
        continue;
      }

      // Numbered lists at line start
      if (this.lineStart) {
        const numMatch = remaining.match(/^(\d+)\.\s/);
        if (numMatch) {
          output += `${ansi.cyan}${numMatch[1]}.${ansi.reset} `;
          processed += numMatch[0].length;
          this.lineStart = false;
          continue;
        }
      }

      // Horizontal rules (---, ***, ___)
      if (this.lineStart && remaining.length >= 3) {
        const hrMatch = remaining.match(/^([-*_])\1{2,}\s*\n/);
        if (hrMatch) {
          output += `${ansi.dim}${'─'.repeat(44)}${ansi.reset}\n`;
          processed += hrMatch[0].length;
          this.lineStart = true;
          continue;
        }
        // Buffer if potential HR but no newline yet
        if (/^([-*_])\1{2,}\s*$/.test(remaining)) {
          break;
        }
      }

      // Table rows (|...|)
      if (this.lineStart && remaining[0] === '|') {
        const newlineIdx = remaining.indexOf('\n');
        if (newlineIdx === -1) {
          // Wait for complete line
          break;
        }
        const line = remaining.slice(0, newlineIdx);
        if (line.endsWith('|')) {
          this.tableRows.push(line);
          processed += newlineIdx + 1;
          this.lineStart = true;
          continue;
        }
      }

      // If we had buffered table rows but the current line isn't a table row, flush them
      if (this.tableRows.length > 0) {
        output += this._renderTable(this.tableRows);
        this.tableRows = [];
      }

      // Regular character
      const char = this.buffer[processed];
      output += char;
      processed++;
      if (char === '\n') {
        this.lineStart = true;
        // Check for paragraph break (double newline) - add extra spacing
        if (this.buffer[processed] === '\n') {
          output += '\n'; // Extra line for paragraph spacing
          processed++;
        }
      } else {
        this.lineStart = false;
      }
    }

    // Keep unprocessed buffer for next call
    this.buffer = this.buffer.slice(processed);
    return output;
  }

  /**
   * Render buffered table rows into aligned columns
   */
  _renderTable(rows) {
    if (rows.length === 0) return '';

    // Parse rows into cells
    const parsed = [];
    const separatorIndices = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].split('|').slice(1, -1).map(c => c.trim());
      // Detect separator rows (|---|---|)
      if (cells.every(c => /^[-:]+$/.test(c))) {
        separatorIndices.push(i);
      } else {
        parsed.push(cells);
      }
    }

    if (parsed.length === 0) return '';

    // Calculate column widths (capped at 30)
    const colCount = Math.max(...parsed.map(r => r.length));
    const widths = [];
    for (let col = 0; col < colCount; col++) {
      let max = 0;
      for (const row of parsed) {
        const cell = row[col] || '';
        max = Math.max(max, cell.length);
      }
      widths.push(Math.min(max, 30));
    }

    let output = '';
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i];
      const isHeader = (i === 0 && separatorIndices.includes(1));
      let line = '  ';
      for (let col = 0; col < colCount; col++) {
        let cell = (row[col] || '').slice(0, 30);
        cell = cell.padEnd(widths[col]);
        if (col > 0) line += '  ';
        if (isHeader) {
          line += `${ansi.bold}${ansi.banana}${cell}${ansi.reset}`;
        } else {
          line += cell;
        }
      }
      output += line + '\n';

      // Add separator line after header
      if (isHeader) {
        let sep = '  ';
        for (let col = 0; col < colCount; col++) {
          if (col > 0) sep += '  ';
          sep += `${ansi.dim}${'─'.repeat(widths[col])}${ansi.reset}`;
        }
        output += sep + '\n';
      }
    }
    return output;
  }

  /**
   * Flush remaining buffer (call at end of stream)
   */
  flush() {
    let output = '';

    // Flush any buffered table
    if (this.tableRows.length > 0) {
      output += this._renderTable(this.tableRows);
      this.tableRows = [];
    }

    output += this.buffer;

    // Close any open code block
    if (this.inCodeBlock) {
      output += ansi.reset;
    }

    this.buffer = '';
    this.inCodeBlock = false;
    this.lineStart = true;
    return output;
  }
}

/**
 * Render a complete Markdown string (non-streaming)
 */
function renderMarkdown(text) {
  const renderer = new MarkdownRenderer();
  return renderer.render(text) + renderer.flush();
}

module.exports = { MarkdownRenderer, renderMarkdown };
