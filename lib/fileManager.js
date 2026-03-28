/**
 * File Manager - Read/write files with backup support
 */

const fs = require('fs');
const path = require('path');

// File extensions to always skip
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lock', '.bin', '.dat'
];

// Max file size to read (100KB)
const MAX_FILE_SIZE = 100 * 1024;

class FileManager {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.backupDir = path.join(projectDir, '.banana', 'backups');
  }

  /**
   * Ensure backup directory exists
   */
  ensureBackupDir() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Check if file should be skipped (binary, too large, etc.)
   */
  shouldSkipFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.includes(ext)) {
      return { skip: true, reason: 'binary file' };
    }

    try {
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_FILE_SIZE) {
        return { skip: true, reason: `file too large (${Math.round(stats.size / 1024)}KB)` };
      }
    } catch {
      return { skip: true, reason: 'cannot read file stats' };
    }

    return { skip: false };
  }

  /**
   * Read a file's contents
   */
  readFile(filePath) {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectDir, filePath);

    const skipCheck = this.shouldSkipFile(fullPath);
    if (skipCheck.skip) {
      return { success: false, error: skipCheck.reason };
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { success: true, content, path: fullPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Write content to a file (with backup)
   */
  writeFile(filePath, content) {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectDir, filePath);

    try {
      // Create backup if file exists
      if (fs.existsSync(fullPath)) {
        this.ensureBackupDir();
        const timestamp = Date.now();
        const relativePath = path.relative(this.projectDir, fullPath);
        const backupName = `${relativePath.replace(/[/\\]/g, '_')}.${timestamp}.bak`;
        const backupPath = path.join(this.backupDir, backupName);

        fs.copyFileSync(fullPath, backupPath);
      }

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write the file
      fs.writeFileSync(fullPath, content, 'utf-8');

      return { success: true, path: fullPath, isNew: !fs.existsSync(fullPath) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a file (with backup)
   */
  deleteFile(filePath) {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectDir, filePath);

    try {
      if (!fs.existsSync(fullPath)) {
        return { success: false, error: 'File does not exist' };
      }

      // Create backup before deleting
      this.ensureBackupDir();
      const timestamp = Date.now();
      const relativePath = path.relative(this.projectDir, fullPath);
      const backupName = `${relativePath.replace(/[/\\]/g, '_')}.${timestamp}.deleted.bak`;
      const backupPath = path.join(this.backupDir, backupName);

      fs.copyFileSync(fullPath, backupPath);
      fs.unlinkSync(fullPath);

      return { success: true, path: fullPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get list of backups
   */
  getBackups() {
    if (!fs.existsSync(this.backupDir)) {
      return [];
    }

    try {
      const files = fs.readdirSync(this.backupDir);
      return files
        .map(file => {
          const stats = fs.statSync(path.join(this.backupDir, file));
          return {
            name: file,
            path: path.join(this.backupDir, file),
            timestamp: stats.mtime
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  /**
   * Restore most recent backup for a file
   */
  restoreLatest(filePath) {
    const relativePath = path.relative(this.projectDir,
      path.isAbsolute(filePath) ? filePath : path.join(this.projectDir, filePath)
    );
    const searchPrefix = relativePath.replace(/[/\\]/g, '_') + '.';

    const backups = this.getBackups().filter(b => b.name.startsWith(searchPrefix));

    if (backups.length === 0) {
      return { success: false, error: 'No backups found for this file' };
    }

    const latestBackup = backups[0];

    try {
      const content = fs.readFileSync(latestBackup.path, 'utf-8');
      const targetPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.projectDir, filePath);

      fs.writeFileSync(targetPath, content, 'utf-8');

      return { success: true, restored: latestBackup.name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a path exists
   */
  exists(filePath) {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectDir, filePath);
    return fs.existsSync(fullPath);
  }

  /**
   * Check if path is a directory
   */
  isDirectory(filePath) {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectDir, filePath);
    try {
      return fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  }
}

module.exports = FileManager;
