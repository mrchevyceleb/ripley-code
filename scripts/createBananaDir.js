#!/usr/bin/env node
// This script ensures the user's Banana config directory and subdirectories exist.
// It also migrates from ~/.ripley/ if upgrading from Ripley Code.
const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
if (!home) {
  console.error('Could not determine HOME directory.');
  process.exit(1);
}

const bananaDir = path.join(home, '.banana');
const ripleyDir = path.join(home, '.ripley');
const dirs = [
  bananaDir,
  path.join(bananaDir, 'commands'),
  path.join(bananaDir, 'logs')
];

// Migrate from ~/.ripley/ to ~/.banana/ if upgrading
if (fs.existsSync(ripleyDir) && !fs.existsSync(bananaDir)) {
  try {
    // Copy the entire .ripley directory to .banana
    fs.cpSync(ripleyDir, bananaDir, { recursive: true });

    // Rename RIPLEY.md -> BANANA.md if present
    const oldMd = path.join(bananaDir, 'RIPLEY.md');
    const newMd = path.join(bananaDir, 'BANANA.md');
    if (fs.existsSync(oldMd) && !fs.existsSync(newMd)) {
      fs.renameSync(oldMd, newMd);
    }

    console.log(`Migrated ${ripleyDir} -> ${bananaDir}`);
  } catch (err) {
    console.error(`Migration failed: ${err.message}. Creating fresh directory.`);
  }
}

for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log(`Created or verified ${bananaDir}`);
