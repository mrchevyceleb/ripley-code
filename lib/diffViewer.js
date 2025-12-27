/**
 * Diff Viewer - Show colorful diffs for file changes
 */

const { diffLines, createPatch } = require('diff');

// ANSI colors (fallback if chalk not available)
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[38;5;120m',
  red: '\x1b[38;5;210m',
  cyan: '\x1b[38;5;51m',
  yellow: '\x1b[38;5;226m',
  orange: '\x1b[38;5;208m',
  gray: '\x1b[38;5;245m',
  white: '\x1b[38;5;255m',
  bgGreen: '\x1b[48;5;22m',
  bgRed: '\x1b[48;5;52m'
};

/**
 * Format a line number with padding
 */
function formatLineNum(num, width = 4) {
  return String(num).padStart(width, ' ');
}

/**
 * Generate a unified diff view
 */
function generateDiff(oldContent, newContent, filePath) {
  const patch = createPatch(filePath, oldContent || '', newContent, 'old', 'new');
  return patch;
}

/**
 * Create a pretty diff display for terminal
 */
function prettyDiff(oldContent, newContent, filePath, maxLines = 50) {
  const differences = diffLines(oldContent || '', newContent);
  const lines = [];
  let lineCount = 0;
  let hasChanges = false;

  // Header
  lines.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset} ${colors.white}${filePath}${colors.reset}`);
  lines.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);

  let oldLineNum = 1;
  let newLineNum = 1;

  for (const part of differences) {
    const partLines = part.value.split('\n');
    // Remove empty last line from split
    if (partLines[partLines.length - 1] === '') {
      partLines.pop();
    }

    for (const line of partLines) {
      if (lineCount >= maxLines) {
        lines.push(`${colors.gray}  ... ${differences.length - lineCount} more changes ...${colors.reset}`);
        break;
      }

      if (part.added) {
        hasChanges = true;
        lines.push(`${colors.green}+ ${formatLineNum(newLineNum)}${colors.reset} ${colors.bgGreen}${line}${colors.reset}`);
        newLineNum++;
      } else if (part.removed) {
        hasChanges = true;
        lines.push(`${colors.red}- ${formatLineNum(oldLineNum)}${colors.reset} ${colors.bgRed}${line}${colors.reset}`);
        oldLineNum++;
      } else {
        // Context line (unchanged) - show less of these
        if (lineCount < 5 || lineCount > differences.length - 5) {
          lines.push(`${colors.gray}  ${formatLineNum(oldLineNum)}${colors.reset} ${line}`);
        } else if (lines[lines.length - 1] !== '...') {
          lines.push(`${colors.gray}  ...${colors.reset}`);
        }
        oldLineNum++;
        newLineNum++;
      }

      lineCount++;
    }

    if (lineCount >= maxLines) break;
  }

  if (!hasChanges) {
    lines.push(`${colors.gray}  (no changes)${colors.reset}`);
  }

  lines.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);

  return lines.join('\n');
}

/**
 * Show a new file creation preview
 */
function showNewFile(content, filePath, maxLines = 30) {
  const lines = content.split('\n');
  const output = [];

  output.push(`${colors.green}CREATE${colors.reset} ${colors.white}${filePath}${colors.reset}`);
  output.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);

  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    output.push(`${colors.green}+ ${formatLineNum(i + 1)}${colors.reset} ${lines[i]}`);
  }

  if (lines.length > maxLines) {
    output.push(`${colors.gray}  ... ${lines.length - maxLines} more lines ...${colors.reset}`);
  }

  output.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);
  output.push(`${colors.dim}${lines.length} lines${colors.reset}`);

  return output.join('\n');
}

/**
 * Show a file deletion preview
 */
function showDeleteFile(content, filePath, maxLines = 15) {
  const lines = content ? content.split('\n') : [];
  const output = [];

  output.push(`${colors.red}DELETE${colors.reset} ${colors.white}${filePath}${colors.reset}`);
  output.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);

  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    output.push(`${colors.red}- ${formatLineNum(i + 1)}${colors.reset} ${colors.dim}${lines[i]}${colors.reset}`);
  }

  if (lines.length > maxLines) {
    output.push(`${colors.gray}  ... ${lines.length - maxLines} more lines ...${colors.reset}`);
  }

  output.push(`${colors.cyan}${'─'.repeat(60)}${colors.reset}`);

  return output.join('\n');
}

/**
 * Show an edit preview
 */
function showEdit(oldContent, newContent, filePath) {
  return prettyDiff(oldContent, newContent, filePath);
}

/**
 * Get change summary (for compact display)
 */
function getChangeSummary(oldContent, newContent) {
  const differences = diffLines(oldContent || '', newContent);
  let added = 0;
  let removed = 0;

  for (const part of differences) {
    const lineCount = part.value.split('\n').length - 1;
    if (part.added) added += lineCount;
    if (part.removed) removed += lineCount;
  }

  return { added, removed };
}

/**
 * Format operation for display
 */
function formatOperation(operation, existingContent = null) {
  const { action, path, content } = operation;

  switch (action) {
    case 'create':
      return showNewFile(content, path);

    case 'delete':
      return showDeleteFile(existingContent, path);

    case 'edit':
      if (existingContent === null) {
        // No existing content, treat as create
        return showNewFile(content, path);
      }
      return showEdit(existingContent, content, path);

    default:
      return `Unknown action: ${action}`;
  }
}

module.exports = {
  generateDiff,
  prettyDiff,
  showNewFile,
  showDeleteFile,
  showEdit,
  getChangeSummary,
  formatOperation,
  colors
};
