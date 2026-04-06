const { sanitizeToolCalls } = require('../lib/agenticRunner');

function makeToolCall(id, name, args) {
  return {
    id: String(id),
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run() {
  const noisyBatch = [
    makeToolCall(1, 'search_code', { pattern: 'supabase' }),
    makeToolCall(2, 'search_code', { pattern: 'login|auth' }),
    makeToolCall(3, 'read_file', { path: 'package.json' }),
    makeToolCall(4, 'list_files', { path: '.' }),
    makeToolCall(5, 'list_files', { path: 'src' }),
    makeToolCall(6, 'list_files', { path: 'lib' }),
    makeToolCall(7, 'list_files', { path: 'components' }),
    makeToolCall(8, 'list_files', { path: 'utils' }),
    makeToolCall(9, 'list_files', { path: 'services' }),
    makeToolCall(10, 'list_files', { path: 'api' }),
    makeToolCall(11, 'list_files', { path: 'hooks' }),
    makeToolCall(12, 'list_files', { path: 'store' }),
    makeToolCall(13, 'list_files', { path: 'types' }),
    makeToolCall(14, 'list_files', { path: '.' }),
    makeToolCall(15, 'list_files', { path: '.' }),
    makeToolCall(16, 'listFLes', { path: '.' })
  ];

  const sanitized = sanitizeToolCalls(noisyBatch);
  const keptNames = sanitized.toolCalls.map(toolCall => toolCall.function.name);
  const keptListFiles = sanitized.toolCalls.filter(toolCall => toolCall.function.name === 'list_files');

  assert(sanitized.summary.duplicate === 2, `expected 2 duplicate drops, got ${sanitized.summary.duplicate}`);
  assert(sanitized.summary.perToolOverflow === 4, `expected 4 same-tool overflow drops, got ${sanitized.summary.perToolOverflow}`);
  assert(sanitized.summary.invalid === 0, `expected 0 invalid drops, got ${sanitized.summary.invalid}`);
  assert(keptListFiles.length === 6, `expected 6 list_files calls kept, got ${keptListFiles.length}`);
  assert(keptNames.includes('listFLes'), 'expected unknown tool names to be preserved for downstream handling');

  console.log('tool batch sanitizer regression passed');
  console.log(JSON.stringify({
    kept: sanitized.toolCalls.length,
    dropped: sanitized.dropped.length,
    summary: sanitized.summary,
    keptNames
  }, null, 2));
}

run();
