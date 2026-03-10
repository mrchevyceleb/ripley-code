#!/usr/bin/env node
// This script ensures the user's Ripley config directory and subdirectories exist.
const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
if (!home) {
  console.error('Could not determine HOME directory.');
  process.exit(1);
}

const ripleyDir = path.join(home, '.ripley');
const dirs = [
  ripleyDir,
  path.join(ripleyDir, 'commands'),
  path.join(ripleyDir, 'logs')
];

for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log(`Created or verified ${ripleyDir}`);
