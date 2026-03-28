/**
 * Tab completion for Banana Code
 */

const fs = require('fs');
const path = require('path');

class Completer {
  constructor(projectDir, contextBuilder) {
    this.projectDir = projectDir;
    this.contextBuilder = contextBuilder;

    // All built-in slash commands from handleCommand() switch
    this.builtinCommands = [
      '/help', '/?', '/update', '/version', '/v',
      '/files', '/ls', '/read', '/add', '/unread', '/remove',
      '/tree', '/find', '/grep', '/search',
      '/image',
      '/git', '/status', '/diff', '/log',
      '/clear', '/clearhistory',
      '/save', '/load', '/sessions',
      '/context', '/tokens',
      '/think', '/steer', '/steering',
      '/ctx', '/compact', '/stream',
      '/watch', '/yolo', '/agent',
      '/hooks',
      '/work', '/code', '/plan', '/implement', '/ask', '/mode',
      '/prompt', '/model', '/models', '/connect', '/mcp',
      '/config', '/set', '/instructions',
      '/run', '/exec', '/$',
      '/undo', '/backups', '/restore',
      '/exit', '/quit', '/q',
      '/commands'
    ];

    // Load custom commands from all locations, deduplicated
    this.commands = [...new Set([
      ...this.builtinCommands,
      ...this._loadGlobalCommandNames(),
      ...this._loadProjectCommandNames()
    ])];

    this.configKeys = [
      'compactMode', 'streamingEnabled', 'maxTokens',
      'tokenWarningThreshold', 'autoSaveHistory', 'geminiApiKey', 'steeringEnabled'
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
      return [this.commands, '/'];
    }

    // If just the command, complete command names
    if (parts.length === 1) {
      const matches = this.commands.filter(c => c.startsWith(cmd));
      return [matches, cmd];
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

      case '/connect':
        if (parts.length === 2) {
          const options = ['anthropic', 'openai', 'openrouter', 'status', 'list', 'disconnect', 'use'];
          const matches = options.filter(o => o.startsWith(arg.toLowerCase()));
          return [matches.map(m => `${cmd} ${m}`), line];
        }
        if (parts.length === 3 && ['disconnect', 'use'].includes(parts[1].toLowerCase())) {
          const providers = ['local', 'anthropic', 'openai', 'openrouter'];
          const providerArg = parts[2].toLowerCase();
          const matches = providers.filter(p => p.startsWith(providerArg));
          return [matches.map(m => `${cmd} ${parts[1]} ${m}`), line];
        }
        break;

      case '/model':
      case '/models':
        if (parts.length === 2) {
          const options = ['search'];
          const matches = options.filter(o => o.startsWith(arg.toLowerCase()));
          return [matches.map(m => `${cmd} ${m}`), line];
        }
        break;

      case '/think':
        if (parts.length === 2) {
          const options = ['off', 'low', 'medium', 'high'];
          const matches = options.filter(o => o.startsWith(arg.toLowerCase()));
          return [matches.map(m => `${cmd} ${m}`), line];
        }
        break;

      case '/steer':
      case '/steering':
        if (parts.length === 2) {
          const options = ['status', 'show', 'clear', 'on', 'off'];
          const matches = options.filter(o => o.startsWith(arg.toLowerCase()));
          return [matches.map(m => `${cmd} ${m}`), line];
        }
        break;

      case '/hooks':
        if (parts.length === 2) {
          const options = ['list', 'add', 'remove', 'toggle', 'test'];
          const matches = options.filter(o => o.startsWith(arg.toLowerCase()));
          return [matches.map(m => `${cmd} ${m}`), line];
        }
        break;

      case '/load':
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
      const historyDir = path.join(this.projectDir, '.banana', 'history');
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

  _loadGlobalCommandNames() {
    const names = [];
    const dirs = [
      path.join(require('os').homedir(), '.banana', 'commands'),
      path.join(require('os').homedir(), '.ripley', 'commands') // legacy
    ];
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.md')) {
            const cmd = '/' + f.replace('.md', '').toLowerCase();
            if (!names.includes(cmd)) names.push(cmd);
          }
        }
      } catch {}
    }
    return names;
  }

  _loadProjectCommandNames() {
    try {
      const commandsDir = path.join(this.projectDir, '.banana', 'commands');
      if (!fs.existsSync(commandsDir)) return [];
      return fs.readdirSync(commandsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => '/' + f.replace('.md', '').toLowerCase())
        .filter(cmd => !this.builtinCommands.includes(cmd)); // avoid duplicates
    } catch {
      return [];
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
