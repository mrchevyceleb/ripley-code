/**
 * Parser - Extract file operations from AI responses
 */

/**
 * Parse AI response for file operations
 *
 * Expected format:
 * <file_operation>
 * <action>create|edit|delete</action>
 * <path>relative/path/to/file.ts</path>
 * <content>
 * ... file content ...
 * </content>
 * </file_operation>
 *
 * Also handles common local model variations:
 * - <fileoperation> (no underscore)
 * - <file-operation> (hyphen)
 * - <parameter=action>create</parameter> (Nemotron-style)
 * - <parameter=path>...</parameter> (Nemotron-style)
 */
function parseFileOperations(response) {
  const operations = [];

  // First, strip markdown code fences that might wrap the XML blocks
  let cleanedResponse = response
    .replace(/```(?:xml|html|text)?\s*\n?(<(?:file[-_]?operation)>)/gi, '$1')
    .replace(/(<\/(?:file[-_]?operation)>)\s*\n?```/gi, '$1');

  // Match file_operation blocks - tolerate missing underscore, hyphen, etc.
  const operationRegex = /<file[-_]?operation>([\s\S]*?)<\/file[-_]?operation>/gi;
  let match;

  while ((match = operationRegex.exec(cleanedResponse)) !== null) {
    const block = match[1];

    // Extract action - standard format OR Nemotron <parameter=action> format
    const actionMatch = block.match(/<action>(create|edit|delete)<\/action>/i)
      || block.match(/<parameter\s*=\s*"?action"?\s*>\s*(create|edit|delete)\s*<\/parameter>/i);
    if (!actionMatch) continue;

    // Extract path - standard format OR Nemotron <parameter=path> format
    const pathMatch = block.match(/<path>([^<]+)<\/path>/)
      || block.match(/<parameter\s*=\s*"?path"?\s*>\s*([^<]+?)\s*<\/parameter>/i);
    if (!pathMatch) continue;

    // Extract content - standard format OR Nemotron <parameter=content> format
    const contentMatch = block.match(/<content>([\s\S]*?)<\/content>/)
      || block.match(/<parameter\s*=\s*"?content"?\s*>([\s\S]*?)<\/parameter>/i);

    operations.push({
      action: actionMatch[1].toLowerCase(),
      path: pathMatch[1].trim(),
      content: contentMatch ? contentMatch[1].trim() : null
    });
  }

  return operations;
}

/**
 * Parse AI response for shell commands
 *
 * Expected format:
 * <run_command>
 * npm install axios
 * </run_command>
 */
function parseCommands(response) {
  const commands = [];

  // Strip markdown code fences that might wrap the XML blocks
  let cleanedResponse = response
    .replace(/```(?:bash|shell|sh|text)?\s*\n?(<run[-_]?command>)/gi, '$1')
    .replace(/(<\/run[-_]?command>)\s*\n?```/gi, '$1');

  const commandRegex = /<run[-_]?command>([\s\S]*?)<\/run[-_]?command>/gi;
  let match;

  while ((match = commandRegex.exec(cleanedResponse)) !== null) {
    const command = match[1].trim();
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

/**
 * Extract the explanation text (everything not in special blocks)
 */
function extractExplanation(response) {
  let text = response;

  // Remove file operation blocks (including model variants)
  text = text.replace(/<file[-_]?operation>[\s\S]*?<\/file[-_]?operation>/gi, '');

  // Remove command blocks (including model variants)
  text = text.replace(/<run[-_]?command>[\s\S]*?<\/run[-_]?command>/gi, '');

  // Clean up excess whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

/**
 * Parse a complete AI response
 */
function parseResponse(response) {
  return {
    explanation: extractExplanation(response),
    fileOperations: parseFileOperations(response),
    commands: parseCommands(response)
  };
}

/**
 * Check if response contains any actionable items
 */
function hasActions(response) {
  const parsed = parseResponse(response);
  return parsed.fileOperations.length > 0 || parsed.commands.length > 0;
}

module.exports = {
  parseFileOperations,
  parseCommands,
  extractExplanation,
  parseResponse,
  hasActions
};
