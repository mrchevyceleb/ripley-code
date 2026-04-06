const fs = require('fs');
const os = require('os');
const path = require('path');
const FileManager = require('../lib/fileManager');
const ContextBuilder = require('../lib/contextBuilder');
const { Config } = require('../lib/config');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rimrafSync(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ripley-reliability-'));
  try {
    fs.writeFileSync(path.join(tempRoot, '.gitignore'), 'dist/\n*.cache\n', 'utf-8');
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'tmp-project' }, null, 2), 'utf-8');

    const fileManager = new FileManager(tempRoot);
    const firstWrite = fileManager.writeFile('nested/example.txt', 'hello');
    const secondWrite = fileManager.writeFile('nested/example.txt', 'hello again');
    assert(firstWrite.success && firstWrite.isNew === true, 'expected first write to report isNew=true');
    assert(secondWrite.success && secondWrite.isNew === false, 'expected second write to report isNew=false');

    const contextBuilder = new ContextBuilder(fileManager, ['coverage/**']);
    contextBuilder.buildContext();
    const ignoreCountAfterFirst = contextBuilder.activeIgnores.length;
    contextBuilder.buildContext();
    const ignoreCountAfterSecond = contextBuilder.activeIgnores.length;
    assert(ignoreCountAfterFirst === ignoreCountAfterSecond, 'expected ignore patterns to remain stable across buildContext calls');

    const config = new Config(tempRoot);
    config.saveRunSnapshot({ userMessage: 'test request', activeModel: 'local:test' });
    const savedSnapshot = config.getRunSnapshot();
    assert(savedSnapshot && savedSnapshot.completed === false, 'expected incomplete run snapshot');
    config.completeRunSnapshot({ status: 'completed' });
    const completedSnapshot = config.getRunSnapshot();
    assert(completedSnapshot && completedSnapshot.completed === true, 'expected completed run snapshot');

    console.log('persistence/context regression passed');
    console.log(JSON.stringify({
      firstWrite,
      secondWrite,
      ignoreCountAfterFirst,
      ignoreCountAfterSecond,
      completedSnapshot
    }, null, 2));
  } finally {
    rimrafSync(tempRoot);
  }
}

run();
