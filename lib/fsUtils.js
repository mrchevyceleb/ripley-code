const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteFileSync(targetPath, content, encoding = 'utf-8') {
  const dir = path.dirname(targetPath);
  ensureDirSync(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  fs.writeFileSync(tempPath, content, encoding);
  fs.renameSync(tempPath, targetPath);
}

function atomicWriteJsonSync(targetPath, value) {
  atomicWriteFileSync(targetPath, JSON.stringify(value, null, 2));
}

module.exports = {
  ensureDirSync,
  atomicWriteFileSync,
  atomicWriteJsonSync
};
