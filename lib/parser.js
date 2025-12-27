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
 */
function parseFileOperations(response) {
  const operations = [];

  // First, strip markdown code fences that might wrap the XML blocks
  // This handles cases where the model outputs ```xml or ``` around the blocks
  let cleanedResponse = response
    .replace(/```(?:xml|html|text)?\s*\n?(<file_operation>)/gi, '$1')
    .replace(/(<\/file_operation>)\s*\n?```/gi, '$1');

  // Match file_operation blocks
  const operationRegex = /<file_operation>([\s\S]*?)<\/file_operation>/gi;
  let match;

  while ((match = operationRegex.exec(cleanedResponse)) !== null) {
    const block = match[1];

    // Extract action
    const actionMatch = block.match(/<action>(create|edit|delete)<\/action>/i);
    if (!actionMatch) continue;

    // Extract path
    const pathMatch = block.match(/<path>([^<]+)<\/path>/);
    if (!pathMatch) continue;

    // Extract content (optional for delete)
    const contentMatch = block.match(/<content>([\s\S]*?)<\/content>/);

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
    .replace(/```(?:bash|shell|sh|text)?\s*\n?(<run_command>)/gi, '$1')
    .replace(/(<\/run_command>)\s*\n?```/gi, '$1');

  const commandRegex = /<run_command>([\s\S]*?)<\/run_command>/gi;
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

  // Remove file operation blocks
  text = text.replace(/<file_operation>[\s\S]*?<\/file_operation>/gi, '');

  // Remove command blocks
  text = text.replace(/<run_command>[\s\S]*?<\/run_command>/gi, '');

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
