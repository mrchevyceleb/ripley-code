/**
 * Streaming response handler for Ripley Code
 *
 * Filters out <file_operation> and <run_command> blocks during streaming
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
    this.xmlBlockType = null; // 'file_operation' or 'run_command'
  }

  /**
   * Process content for display, filtering out XML blocks
   * Returns only the text that should be shown to the user
   */
  filterForDisplay(content) {
    let output = '';
    this.displayBuffer += content;

    while (this.displayBuffer.length > 0) {
      if (this.insideXmlBlock) {
        // Look for closing tag
        const closeTag = `</${this.xmlBlockType}>`;
        const closeIndex = this.displayBuffer.indexOf(closeTag);

        if (closeIndex !== -1) {
          // Found closing tag, skip everything up to and including it
          this.displayBuffer = this.displayBuffer.slice(closeIndex + closeTag.length);
          this.insideXmlBlock = false;
          this.xmlBlockType = null;
        } else {
          // Still inside block, keep buffering
          break;
        }
      } else {
        // Look for opening tags
        const fileOpIndex = this.displayBuffer.indexOf('<file_operation>');
        const runCmdIndex = this.displayBuffer.indexOf('<run_command>');

        // Find the earliest tag
        let tagIndex = -1;
        let tagType = null;
        let tagLength = 0;

        if (fileOpIndex !== -1 && (runCmdIndex === -1 || fileOpIndex < runCmdIndex)) {
          tagIndex = fileOpIndex;
          tagType = 'file_operation';
          tagLength = '<file_operation>'.length;
        } else if (runCmdIndex !== -1) {
          tagIndex = runCmdIndex;
          tagType = 'run_command';
          tagLength = '<run_command>'.length;
        }

        if (tagIndex !== -1) {
          // Output everything before the tag
          output += this.displayBuffer.slice(0, tagIndex);
          this.displayBuffer = this.displayBuffer.slice(tagIndex + tagLength);
          this.insideXmlBlock = true;
          this.xmlBlockType = tagType;
        } else {
          // No tags found, but might have partial tag at end
          // Check for partial opening tags
          const partialTags = ['<file_operation', '<run_command', '<file_', '<run_', '<f', '<r'];
          let partialIndex = -1;

          for (const partial of partialTags) {
            const idx = this.displayBuffer.lastIndexOf(partial);
            if (idx !== -1 && idx > this.displayBuffer.length - 20) {
              // Potential partial tag near end
              partialIndex = idx;
              break;
            }
          }

          if (partialIndex !== -1 && partialIndex > 0) {
            // Output up to the potential partial tag, keep the rest buffered
            output += this.displayBuffer.slice(0, partialIndex);
            this.displayBuffer = this.displayBuffer.slice(partialIndex);
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
