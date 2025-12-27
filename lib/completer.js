/**
 * Tab completion for Ripley Code
 */

const fs = require('fs');
const path = require('path');

class Completer {
  constructor(projectDir, contextBuilder) {
    this.projectDir = projectDir;
    this.contextBuilder = contextBuilder;

    this.commands = [
      '/help', '/files', '/read', '/unread', '/tree', '/find', '/grep',
      '/git', '/diff', '/log', '/status',
      '/clear', '/clearhistory', '/context', '/compact',
      '/run', '/undo', '/restore', '/backups',
      '/save', '/load', '/sessions', '/delete',
      '/config', '/set', '/instructions',
      '/watch', '/stream', '/yolo',
      '/tokens', '/image',
      '/exit', '/quit'
    ];

    this.configKeys = [
      'compactMode', 'streamingEnabled', 'maxTokens',
      'tokenWarningThreshold', 'autoSaveHistory'
    ];
  }

  complete(line) {
    const trimmed = line.trim();

    // Command completion
    if (trimmed.startsWith('/')) {
      return this.completeCommand(trimmed);
    }

    // @ file mention completion
    if (trimmed.includes('@')) {
      return this.completeFileMention(trimmed);
    }

    // Default: no completions
    return [[], line];
  }

  completeCommand(line) {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    // If just "/" show all commands
    if (cmd === '/') {
      return [this.commands, line];
    }

    // If just the command, complete command names
    if (parts.length === 1) {
      const matches = this.commands.filter(c => c.startsWith(cmd));
      return [matches, line];
    }

    // Command-specific completions
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case '/read':
      case '/unread':
      case '/restore':
        return this.completeFilePath(arg, cmd + ' ');

      case '/set':
        if (parts.length === 2) {
          const matches = this.configKeys.filter(k =>
            k.toLowerCase().startsWith(arg.toLowerCase())
          );
          return [matches.map(m => `${cmd} ${m}`), line];
        }
        break;

      case '/load':
      case '/delete':
        return this.completeSessionName(arg, cmd + ' ');

      case '/find':
      case '/grep':
        // No completion for search patterns
        break;

      case '/run':
        return this.completeShellCommand(arg, cmd + ' ');
    }

    return [[], line];
  }

  completeFilePath(partial, prefix = '') {
    try {
      const searchDir = partial.includes('/')
        ? path.dirname(partial)
        : '.';

      const searchBase = partial.includes('/')
        ? path.basename(partial)
        : partial;

      const fullSearchDir = path.join(this.projectDir, searchDir);

      if (!fs.existsSync(fullSearchDir)) {
        return [[], prefix + partial];
      }

      const entries = fs.readdirSync(fullSearchDir, { withFileTypes: true });

      const matches = entries
        .filter(e => {
          // Skip hidden and common ignores
          if (e.name.startsWith('.')) return false;
          if (e.name === 'node_modules') return false;
          return e.name.toLowerCase().startsWith(searchBase.toLowerCase());
        })
        .map(e => {
          const relativePath = searchDir === '.'
            ? e.name
            : path.join(searchDir, e.name).replace(/\\/g, '/');
          return prefix + relativePath + (e.isDirectory() ? '/' : '');
        })
        .slice(0, 20); // Limit suggestions

      return [matches, prefix + partial];
    } catch {
      return [[], prefix + partial];
    }
  }

  completeFileMention(line) {
    // Find the @ mention being typed
    const atIndex = line.lastIndexOf('@');
    if (atIndex === -1) return [[], line];

    const beforeAt = line.slice(0, atIndex);
    const afterAt = line.slice(atIndex + 1);

    // Get file completions
    const [completions] = this.completeFilePath(afterAt);

    // Format as @ mentions
    const matches = completions.map(c => beforeAt + '@' + c);

    return [matches, line];
  }

  completeSessionName(partial, prefix = '') {
    try {
      const historyDir = path.join(this.projectDir, '.ripley', 'history');
      if (!fs.existsSync(historyDir)) return [[], prefix + partial];

      const files = fs.readdirSync(historyDir)
        .filter(f => f.endsWith('.json'))
        .filter(f => f.toLowerCase().includes(partial.toLowerCase()))
        .slice(0, 10);

      return [files.map(f => prefix + f), prefix + partial];
    } catch {
      return [[], prefix + partial];
    }
  }

  completeShellCommand(partial, prefix = '') {
    // Common commands
    const commonCommands = [
      'npm install', 'npm run', 'npm test', 'npm start', 'npm run dev', 'npm run build',
      'pnpm install', 'pnpm run', 'pnpm test', 'pnpm dev', 'pnpm build',
      'yarn install', 'yarn', 'yarn test', 'yarn dev', 'yarn build',
      'git status', 'git add', 'git commit', 'git push', 'git pull', 'git log',
      'ls', 'dir', 'cd', 'mkdir', 'rm', 'cat', 'echo',
      'node', 'npx', 'tsx', 'ts-node'
    ];

    const matches = commonCommands
      .filter(c => c.toLowerCase().startsWith(partial.toLowerCase()))
      .map(c => prefix + c);

    return [matches, prefix + partial];
  }
}

module.exports = Completer;
