/**
 * Tab completion for Ripley Code
 */

const fs = require('fs');
const path = require('path');

class Completer {
  constructor(projectDir, contextBuilder) {
    this.projectDir = projectDir;
    this.contextBuilder = contextBuilder;
-
-    this.builtinCommands = [
-      '/help', '/files', '/read', '/unread', '/tree', '/find', '/grep',
-      '/git', '/diff', '/log', '/status',
-      '/clear', '/clearhistory', '/context', '/compact',
-      '/run', '/undo', '/restore', '/backups',
-      '/save', '/load', '/sessions', '/delete',
-      '/config', '/set', '/instructions', '/mcp',
-      '/watch', '/stream', '/yolo', '/agent',
-      '/steer', '/hooks',
-      '/tokens', '/image', '/commands',
-      '/model', '/models', '/connect', '/prompt', '/think', '/implement',
-      '/plan', '/ask', '/mode', '/version',
-      '/exit', '/quit'
-    ];
-
-    // Load custom commands from ~/.ripley/Commands/
-    this.commands = [...this.builtinCommands, ...this._loadCustomCommandNames()];
+    // Dynamically load built‑in commands from the user’s ~/.ripley/commands folder
+    this.builtinCommands = this._loadBuiltinCommandNames();
+
+    // Load custom commands from ~/.ripley/Commands/
+    this.commands = [...this.builtinCommands, ...this._loadCustomCommandNames()];
 
     this.configKeys = [
       'compactMode', 'streamingEnabled', 'maxTokens',
       'tokenWarningThreshold', 'autoSaveHistory', 'geminiApiKey', 'steeringEnabled'
     ];
   }
@@
-  _loadCustomCommandNames() {
-    try {
-      const commandsDir = path.join(require('os').homedir(), '.ripley', 'Commands');
-      if (!fs.existsSync(commandsDir)) return [];
-      return fs.readdirSync(commandsDir)
-        .filter(f => f.endsWith('.md'))
-        .map(f => '/' + f.replace('.md', ''));
-    } catch {
-      return [];
-    }
-  }
+  _loadBuiltinCommandNames() {
+    try {
+      const commandsDir = path.join(require('os').homedir(), '.ripley', 'commands');
+      if (!fs.existsSync(commandsDir)) return [];
+      return fs.readdirSync(commandsDir)
+        .filter(f => f.endsWith('.md'))
+        .map(f => '/' + f.replace('.md', ''));
+    } catch {
+      return [];
+    }
+  }
+
+  _loadCustomCommandNames() {
+    try {
+      const commandsDir = path.join(require('os').homedir(), '.ripley', 'Commands');
+      if (!fs.existsSync(commandsDir)) return [];
+      return fs.readdirSync(commandsDir)
+        .filter(f => f.endsWith('.md'))
+        .map(f => '/' + f.replace('.md', ''));
+    } catch {
+      return [];
+    }
+  }
*** End Edit