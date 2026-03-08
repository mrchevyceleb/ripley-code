#!/usr/bin/env node
// This script ensures the user’s Ripley config directory exists.
const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
if (!home) {
  console.error('Could not determine HOME directory.');
  process.exit(1);
}
const dir = path.join(home, '.ripley', 'commands');
fs.mkdirSync(dir, { recursive: true });
console.log(`Created or verified ${dir}`);
