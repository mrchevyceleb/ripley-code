/**
 * Command Runner - Execute shell commands safely
 */

const { spawn } = require('child_process');
const path = require('path');

// Commands that are always blocked
const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'del /s /q c:',
  'format c:', 'mkfs', ':(){:|:&};:'
];

// Commands that require confirmation
const DANGEROUS_PATTERNS = [
  /^rm\s+-rf/i,
  /^del\s+\/s/i,
  /^rmdir\s+\/s/i,
  /drop\s+database/i,
  /drop\s+table/i,
  /truncate\s+table/i
];

class CommandRunner {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.isWindows = process.platform === 'win32';
  }

  /**
   * Check if a command is blocked
   */
  isBlocked(command) {
    const lowerCmd = command.toLowerCase().trim();

    // Check absolute blocks
    for (const blocked of BLOCKED_COMMANDS) {
      if (lowerCmd.includes(blocked)) {
        return { blocked: true, reason: 'This command is blocked for safety' };
      }
    }

    return { blocked: false };
  }

  /**
   * Check if a command needs extra confirmation
   */
  isDangerous(command) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Run a command and return a promise with the result
   */
  run(command, options = {}) {
    return new Promise((resolve, reject) => {
      const blockCheck = this.isBlocked(command);
      if (blockCheck.blocked) {
        reject(new Error(blockCheck.reason));
        return;
      }

      const shell = this.isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArg = this.isWindows ? '/c' : '-c';

      const child = spawn(shell, [shellArg, command], {
        cwd: options.cwd || this.projectDir,
        env: { ...process.env, ...options.env },
        stdio: options.stream ? 'inherit' : 'pipe'
      });

      let stdout = '';
      let stderr = '';

      if (!options.stream) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
          if (options.onStdout) options.onStdout(data.toString());
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
          if (options.onStderr) options.onStderr(data.toString());
        });
      }

      child.on('close', (code) => {
        resolve({
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          success: code === 0
        });
      });

      child.on('error', (error) => {
        reject(error);
      });

      // Handle timeout
      if (options.timeout) {
        setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Command timed out after ${options.timeout}ms`));
        }, options.timeout);
      }
    });
  }

  /**
   * Run a command with streaming output
   */
  runWithStream(command, options = {}) {
    return this.run(command, { ...options, stream: true });
  }

  /**
   * Run npm/pnpm/yarn command
   */
  async runPackageManager(args, options = {}) {
    // Detect package manager
    const fs = require('fs');

    let pm = 'npm';
    if (fs.existsSync(path.join(this.projectDir, 'pnpm-lock.yaml'))) {
      pm = 'pnpm';
    } else if (fs.existsSync(path.join(this.projectDir, 'yarn.lock'))) {
      pm = 'yarn';
    } else if (fs.existsSync(path.join(this.projectDir, 'bun.lockb'))) {
      pm = 'bun';
    }

    return this.run(`${pm} ${args}`, options);
  }

  /**
   * Install dependencies
   */
  async install(packages = [], options = {}) {
    if (packages.length === 0) {
      return this.runPackageManager('install', options);
    }
    return this.runPackageManager(`install ${packages.join(' ')}`, options);
  }

  /**
   * Run a dev server
   */
  async runDev(options = {}) {
    return this.runPackageManager('run dev', { ...options, stream: true });
  }

  /**
   * Run build
   */
  async build(options = {}) {
    return this.runPackageManager('run build', options);
  }

  /**
   * Run tests
   */
  async test(options = {}) {
    return this.runPackageManager('test', options);
  }

  /**
   * Git operations
   */
  async git(args, options = {}) {
    return this.run(`git ${args}`, options);
  }

  /**
   * Get current git status
   */
  async gitStatus() {
    try {
      const result = await this.git('status --porcelain');
      if (!result.success) {
        return { isRepo: false, changes: [] };
      }

      const changes = result.stdout
        .split('\n')
        .filter(line => line.trim())
        .map(line => ({
          status: line.substring(0, 2).trim(),
          file: line.substring(3)
        }));

      return { isRepo: true, changes };
    } catch {
      return { isRepo: false, changes: [] };
    }
  }
}

module.exports = CommandRunner;
