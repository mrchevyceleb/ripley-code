/**
 * File watcher for Banana Code
 */

const fs = require('fs');
const path = require('path');

class Watcher {
  constructor(projectDir, contextBuilder, options = {}) {
    this.projectDir = projectDir;
    this.contextBuilder = contextBuilder;
    this.onChange = options.onChange || (() => {});
    this.onError = options.onError || (() => {});

    this.watchers = new Map();
    this.debounceTimers = new Map();
    this.debounceMs = options.debounceMs || 300;
    this.enabled = false;
  }

  start() {
    if (this.enabled) return;

    this.enabled = true;
    const loadedFiles = this.contextBuilder.getLoadedFiles();

    for (const file of loadedFiles) {
      this.watchFile(file);
    }
  }

  stop() {
    this.enabled = false;

    for (const [file, watcher] of this.watchers) {
      watcher.close();
    }

    this.watchers.clear();
    this.debounceTimers.clear();
  }

  watchFile(relativePath) {
    if (!this.enabled) return;
    if (this.watchers.has(relativePath)) return;

    const fullPath = path.join(this.projectDir, relativePath);

    try {
      const watcher = fs.watch(fullPath, (eventType, filename) => {
        this.handleChange(relativePath, eventType);
      });

      watcher.on('error', (error) => {
        this.onError(relativePath, error);
        this.unwatchFile(relativePath);
      });

      this.watchers.set(relativePath, watcher);
    } catch (error) {
      this.onError(relativePath, error);
    }
  }

  unwatchFile(relativePath) {
    const watcher = this.watchers.get(relativePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(relativePath);
    }

    const timer = this.debounceTimers.get(relativePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(relativePath);
    }
  }

  handleChange(relativePath, eventType) {
    // Debounce rapid changes
    const existingTimer = this.debounceTimers.get(relativePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(relativePath);
      this.processChange(relativePath, eventType);
    }, this.debounceMs);

    this.debounceTimers.set(relativePath, timer);
  }

  processChange(relativePath, eventType) {
    const fullPath = path.join(this.projectDir, relativePath);

    // Check if file still exists
    if (!fs.existsSync(fullPath)) {
      // File was deleted
      this.contextBuilder.unloadFile(relativePath);
      this.unwatchFile(relativePath);
      this.onChange(relativePath, 'deleted');
      return;
    }

    // Reload the file in context
    const result = this.contextBuilder.reloadFile(relativePath);

    if (result.success) {
      this.onChange(relativePath, 'modified');
    } else {
      this.onError(relativePath, new Error(result.error));
    }
  }

  // Add a new file to watch (when loaded into context)
  addFile(relativePath) {
    if (this.enabled) {
      this.watchFile(relativePath);
    }
  }

  // Remove a file from watching (when unloaded from context)
  removeFile(relativePath) {
    this.unwatchFile(relativePath);
  }

  // Get list of watched files
  getWatchedFiles() {
    return Array.from(this.watchers.keys());
  }

  isEnabled() {
    return this.enabled;
  }
}

module.exports = Watcher;
