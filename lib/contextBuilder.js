/**
 * Context Builder - Build project context for AI
 */

const fs = require('fs');
const path = require('path');

// Directories to always ignore
const IGNORED_DIRS = [
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '.nyc_output', '.vercel', '.netlify', '.svelte-kit',
  '__pycache__', 'venv', '.venv', 'env', '.env',
  '.banana', '.ripley', '.idea', '.vscode'
];

// Files to always ignore
const IGNORED_FILES = [
  '.DS_Store', 'Thumbs.db', '.gitkeep',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
];

// Priority files to always include if they exist
const PRIORITY_FILES = [
  'package.json', 'tsconfig.json', 'README.md', 'README.txt',
  '.env.example', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  'vite.config.js', 'vite.config.ts', 'tailwind.config.js', 'tailwind.config.ts',
  'prisma/schema.prisma', 'drizzle.config.ts'
];

// Extensions for source files
const SOURCE_EXTENSIONS = [
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.json', '.yaml', '.yml', '.toml',
  '.md', '.mdx', '.sql', '.graphql', '.gql'
];

class ContextBuilder {
  constructor(fileManager, ignorePatterns = []) {
    this.fileManager = fileManager;
    this.projectDir = fileManager.projectDir;
    this.customIgnores = ignorePatterns;
    this.loadedFiles = new Map(); // path -> content
  }

  /**
   * Load .gitignore patterns
   */
  loadGitignore() {
    const gitignorePath = path.join(this.projectDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        return content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Check if path should be ignored
   */
  shouldIgnore(relativePath) {
    const basename = path.basename(relativePath);
    const parts = relativePath.split(path.sep);

    // Check ignored directories
    for (const dir of IGNORED_DIRS) {
      if (parts.includes(dir)) return true;
    }

    // Check ignored files
    if (IGNORED_FILES.includes(basename)) return true;

    // Check custom patterns (simple matching)
    for (const pattern of this.customIgnores) {
      if (pattern.endsWith('/') || pattern.endsWith('\\')) {
        // Directory pattern
        const dirName = pattern.slice(0, -1);
        if (parts.includes(dirName)) return true;
      } else if (pattern.startsWith('*.')) {
        // Extension pattern
        const ext = pattern.slice(1);
        if (relativePath.endsWith(ext)) return true;
      } else if (relativePath.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Recursively scan directory structure
   * @param {string} dir - Directory to scan
   * @param {number} depth - Current depth
   * @param {number} maxDepth - Maximum recursion depth
   * @param {number} maxFiles - Maximum total files to collect (prevents runaway scans)
   * @param {object} counter - Shared counter across recursive calls
   */
  scanDirectory(dir = this.projectDir, depth = 0, maxDepth = 6, maxFiles = 5000, counter = { count: 0 }) {
    if (depth > maxDepth) return [];
    if (counter.count >= maxFiles) return [];

    const results = [];
    const relativePath = path.relative(this.projectDir, dir) || '.';

    if (this.shouldIgnore(relativePath)) return [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (counter.count >= maxFiles) break;

        const fullPath = path.join(dir, entry.name);
        const entryRelPath = path.relative(this.projectDir, fullPath);

        if (this.shouldIgnore(entryRelPath)) continue;

        if (entry.isDirectory()) {
          results.push({
            type: 'dir',
            name: entry.name,
            path: entryRelPath,
            depth
          });
          results.push(...this.scanDirectory(fullPath, depth + 1, maxDepth, maxFiles, counter));
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const isSource = SOURCE_EXTENSIONS.includes(ext);
          results.push({
            type: 'file',
            name: entry.name,
            path: entryRelPath,
            isSource,
            depth
          });
          counter.count++;
        }
      }
    } catch {
      // Ignore permission errors
    }

    return results;
  }

  /**
   * Build a tree string from scan results
   */
  buildTreeString(items, maxItems = 100) {
    let tree = '';
    let count = 0;

    for (const item of items) {
      if (count >= maxItems) {
        tree += `\n... and ${items.length - count} more items`;
        break;
      }

      const indent = '  '.repeat(item.depth);
      const icon = item.type === 'dir' ? '📁' : '📄';
      tree += `${indent}${icon} ${item.name}\n`;
      count++;
    }

    return tree;
  }

  /**
   * Load priority files
   */
  loadPriorityFiles() {
    for (const file of PRIORITY_FILES) {
      const filePath = path.join(this.projectDir, file);
      if (fs.existsSync(filePath)) {
        const result = this.fileManager.readFile(filePath);
        if (result.success) {
          this.loadedFiles.set(file, result.content);
        }
      }
    }
  }

  /**
   * Load a specific file into context
   */
  loadFile(filePath) {
    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.projectDir, filePath)
      : filePath;

    if (this.loadedFiles.has(relativePath)) {
      return { success: true, alreadyLoaded: true };
    }

    const result = this.fileManager.readFile(filePath);
    if (result.success) {
      this.loadedFiles.set(relativePath, result.content);
      return { success: true, path: relativePath };
    }
    return result;
  }

  /**
   * Unload a file from context
   */
  unloadFile(filePath) {
    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.projectDir, filePath)
      : filePath;

    if (this.loadedFiles.has(relativePath)) {
      this.loadedFiles.delete(relativePath);
      return { success: true };
    }
    return { success: false, error: 'File not in context' };
  }

  /**
   * Reload a file in context (for watch mode)
   */
  reloadFile(filePath) {
    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.projectDir, filePath)
      : filePath;

    if (!this.loadedFiles.has(relativePath)) {
      return { success: false, error: 'File not in context' };
    }

    const result = this.fileManager.readFile(filePath);
    if (result.success) {
      this.loadedFiles.set(relativePath, result.content);
      return { success: true, path: relativePath };
    }
    return result;
  }

  /**
   * Get list of loaded files
   */
  getLoadedFiles() {
    return Array.from(this.loadedFiles.keys());
  }

  /**
   * Clear all loaded files
   */
  clearFiles() {
    this.loadedFiles.clear();
  }

  /**
   * Build the full context string for AI
   */
  buildContext() {
    // Load gitignore patterns
    this.customIgnores = [...this.customIgnores, ...this.loadGitignore()];

    // Load priority files first
    this.loadPriorityFiles();

    // Scan directory structure
    const structure = this.scanDirectory();
    const tree = this.buildTreeString(structure);

    // Build context string
    let context = '';

    // Project info
    const packageJson = this.loadedFiles.get('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        context += `## Project: ${pkg.name || 'Unknown'}\n`;
        if (pkg.description) context += `Description: ${pkg.description}\n`;
        context += '\n';
      } catch {
        // Invalid JSON, skip
      }
    }

    // Directory structure
    context += `## Project Structure\n\`\`\`\n${tree}\`\`\`\n\n`;

    // Loaded files
    context += `## Files in Context (${this.loadedFiles.size})\n\n`;

    for (const [filePath, content] of this.loadedFiles) {
      const ext = path.extname(filePath).slice(1) || 'txt';
      context += `### ${filePath}\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
    }

    return context;
  }

  /**
   * Get a summary of the context (for display)
   */
  getSummary() {
    const structure = this.scanDirectory();
    const files = structure.filter(i => i.type === 'file');
    const dirs = structure.filter(i => i.type === 'dir');
    const sourceFiles = files.filter(f => f.isSource);

    return {
      totalFiles: files.length,
      totalDirs: dirs.length,
      sourceFiles: sourceFiles.length,
      loadedFiles: this.loadedFiles.size,
      loadedFilesList: this.getLoadedFiles()
    };
  }
}

module.exports = ContextBuilder;
