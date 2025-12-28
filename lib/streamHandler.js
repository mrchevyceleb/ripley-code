/**
 * Streaming response handler for Ripley Code
 *
 * Filters out <file_operation>, <run_command>, and <think> blocks during streaming
 * so users only see the explanation text. The full response (with XML)
 * is still captured for parsing after streaming completes.
 */

class StreamHandler {
  constructor(options = {}) {
    this.onToken = options.onToken || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.buffer = '';
    this.fullResponse = '';

    // For filtering XML blocks during display
    this.displayBuffer = '';
    this.insideXmlBlock = false;
    this.xmlBlockType = null; // 'file_operation', 'run_command', or 'think'
  }

  /**
   * Process content for display, filtering out XML blocks
   * Returns only the text that should be shown to the user
   */
  filterForDisplay(content) {
    this.displayBuffer += content;

    // Look for opening tags (case insensitive, allow whitespace)
    // Includes think/thinking for reasoning models like Qwen3
    const openTagRegex = /<\s*(file_operation|run_command|think|thinking)\s*>/i;
    const closeFileOp = /<\s*\/\s*file_operation\s*>/i;
    const closeRunCmd = /<\s*\/\s*run_command\s*>/i;
    const closeThink = /<\s*\/\s*think(?:ing)?\s*>/i;

    let output = '';

    while (this.displayBuffer.length > 0) {
      if (this.insideXmlBlock) {
        // Look for closing tag based on block type
        let closeRegex;
        if (this.xmlBlockType === 'file_operation') {
          closeRegex = closeFileOp;
        } else if (this.xmlBlockType === 'run_command') {
          closeRegex = closeRunCmd;
        } else {
          // think or thinking
          closeRegex = closeThink;
        }
        const closeMatch = this.displayBuffer.match(closeRegex);

        if (closeMatch) {
          // Found closing tag, skip everything up to and including it
          const closeEnd = closeMatch.index + closeMatch[0].length;
          this.displayBuffer = this.displayBuffer.slice(closeEnd);
          this.insideXmlBlock = false;
          this.xmlBlockType = null;
        } else {
          // Still inside block, keep buffering (don't output anything)
          break;
        }
      } else {
        // Look for opening tag
        const openMatch = this.displayBuffer.match(openTagRegex);

        if (openMatch) {
          // Output everything before the tag
          output += this.displayBuffer.slice(0, openMatch.index);
          // Skip past the opening tag
          this.displayBuffer = this.displayBuffer.slice(openMatch.index + openMatch[0].length);
          this.insideXmlBlock = true;
          // Normalize 'thinking' to 'think'
          const blockType = openMatch[1].toLowerCase();
          this.xmlBlockType = blockType === 'thinking' ? 'think' : blockType;
        } else {
          // No complete opening tag found
          // Check if buffer ends with a partial tag (< followed by partial text)
          const partialMatch = this.displayBuffer.match(/<[^>]{0,20}$/);

          if (partialMatch) {
            // Output everything before the potential partial tag
            output += this.displayBuffer.slice(0, partialMatch.index);
            this.displayBuffer = this.displayBuffer.slice(partialMatch.index);
            break;
          } else {
            // Safe to output everything
            output += this.displayBuffer;
            this.displayBuffer = '';
          }
        }
      }
    }

    return output;
  }

  async handleStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        this.buffer += chunk;

        // Process SSE data
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';

              if (content) {
                this.fullResponse += content;
                // Filter out XML blocks for display
                const displayContent = this.filterForDisplay(content);
                if (displayContent) {
                  this.onToken(displayContent);
                }
              }
            } catch {
              // Not valid JSON, might be partial
            }
          }
        }
      }

      // Process any remaining buffer
      if (this.buffer) {
        const lines = this.buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                this.fullResponse += content;
                // Filter out XML blocks for display
                const displayContent = this.filterForDisplay(content);
                if (displayContent) {
                  this.onToken(displayContent);
                }
              }
            } catch {
              // Ignore
            }
          }
        }
      }

      this.onComplete(this.fullResponse);
      return this.fullResponse;

    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  getFullResponse() {
    return this.fullResponse;
  }
}

// Non-streaming fallback with simulated streaming effect
async function simulateStreaming(text, onToken, delay = 5) {
  const words = text.split(/(\s+)/);
  for (const word of words) {
    onToken(word);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

module.exports = { StreamHandler, simulateStreaming };
