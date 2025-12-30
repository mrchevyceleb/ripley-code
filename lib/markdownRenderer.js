/**
 * Markdown to Terminal renderer for Ripley Code
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
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  // Backgrounds
  bgGray: '\x1b[48;5;236m',
  bgDarkGray: '\x1b[48;5;234m',
};

class MarkdownRenderer {
  constructor() {
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeBlockLang = '';
    this.inInlineCode = false;
    this.lineStart = true;
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
          output += `${ansi.dim}┌─${this.codeBlockLang ? ` ${this.codeBlockLang} ` : ''}${'─'.repeat(Math.max(0, 40 - (this.codeBlockLang?.length || 0)))}${ansi.reset}\n`;
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
        if (endIdx === -1) {
          // Wait for closing backtick
          break;
        }
        const code = remaining.slice(1, endIdx);
        output += `${ansi.bgGray}${ansi.cyan} ${code} ${ansi.reset}`;
        processed += endIdx + 1;
        this.lineStart = false;
        continue;
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
        output += `${ansi.bold}${boldText}${ansi.reset}`;
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
        const match = remaining.match(/^(#{1,6})\s+(.*)(?:\n|$)/);
        if (match) {
          const level = match[1].length;
          const headerText = match[2];
          const colors = [ansi.cyan, ansi.green, ansi.yellow, ansi.magenta, ansi.blue, ansi.white];
          output += `${ansi.bold}${colors[level - 1] || ansi.white}${headerText}${ansi.reset}\n\n`;
          processed += match[0].length;
          this.lineStart = true;
          continue;
        }
        // Might be incomplete header, wait
        if (!remaining.includes('\n') && remaining.length < 100) {
          break;
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
   * Flush remaining buffer (call at end of stream)
   */
  flush() {
    let output = this.buffer;

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
