/**
 * Streaming response handler for Ripley Code
 *
 * Filters out <file_operation>, <run_command>, and <think> blocks during streaming
 * so users only see the explanation text. The full response (with XML)
 * is still captured for parsing after streaming completes.
 *
 * Also handles "orphan" </think> tags where the model outputs reasoning
 * WITHOUT an opening <think> tag (common with Qwen models).
 */

// Strip model control tokens like <|start|>, <|channel|>, <|constrain|>, <|end|>, etc.
// These leak from models like GPT-OSS, Llama, and others.
const CONTROL_TOKEN_RE = /<\|[^|]*\|>/g;
function stripControlTokens(text) {
  const cleaned = text.replace(CONTROL_TOKEN_RE, '');
  // If the line was entirely control tokens + whitespace, return empty
  return cleaned.replace(/^\s+$/, '');
}

class StreamHandler {
  constructor(options = {}) {
    this.onToken = options.onToken || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onBlockProgress = options.onBlockProgress || null; // (type, charsSoFar) - called while inside suppressed XML blocks
    this.buffer = '';
    this.fullResponse = '';

    // For filtering XML blocks during display
    this.displayBuffer = '';
    this.insideXmlBlock = false;
    this.xmlBlockType = null; // 'file_operation', 'run_command', or 'think'

    // For detecting orphan </think> tags (model reasoning without opening tag)
    // Buffer output until we confirm there's no orphan </think> coming
    this.orphanBuffer = '';
    this.orphanCheckComplete = false; // Once true, stop buffering for orphan check
  }

  /**
   * Process content for display, filtering out XML blocks
   * Returns only the text that should be shown to the user
   *
   * Handles two cases:
   * 1. Normal XML blocks: <think>...</think>, <file_operation>...</file_operation>, etc.
   * 2. Orphan closing tags: Model outputs reasoning without <think> tag, only </think> at end
   */
  filterForDisplay(content) {
    this.displayBuffer += content;

    // Regex patterns
    const openTagRegex = /<\s*(file_operation|run_command|think|thinking)\s*>[\r\n]*/i;
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
          closeRegex = closeThink;
        }
        const closeMatch = this.displayBuffer.match(closeRegex);

        if (closeMatch) {
          // Found closing tag, skip everything up to and including it
          // Use displayBuffer length as the final count (displayBuffer has accumulated content since block open)
          if (this.onBlockProgress) this.onBlockProgress(this.xmlBlockType, this.displayBuffer.length, true);
          const closeEnd = closeMatch.index + closeMatch[0].length;
          this.displayBuffer = this.displayBuffer.slice(closeEnd);
          this.insideXmlBlock = false;
          this.xmlBlockType = null;
        } else {
          // Still inside block, keep buffering
          // displayBuffer contains all content since block opened, so use its length directly
          if (this.onBlockProgress) this.onBlockProgress(this.xmlBlockType, this.displayBuffer.length, false);
          break;
        }
      } else {
        // Not inside a block - check for orphan </think> first (before checking opening tags)
        if (!this.orphanCheckComplete) {
          // Check if we have an orphan </think> (closing tag without opening)
          const orphanCloseMatch = this.displayBuffer.match(closeThink);
          const openThinkMatch = this.displayBuffer.match(/<\s*(think|thinking)\s*>/i);

          if (orphanCloseMatch) {
            // Found </think> - check if there's an opening tag before it
            if (!openThinkMatch || openThinkMatch.index > orphanCloseMatch.index) {
              // Orphan! Discard everything up to and including </think>
              const closeEnd = orphanCloseMatch.index + orphanCloseMatch[0].length;
              let remaining = this.displayBuffer.slice(closeEnd);
              // Also strip any leading whitespace/newlines after </think>
              remaining = remaining.replace(/^[\s\r\n]+/, '');
              this.displayBuffer = remaining;
              this.orphanCheckComplete = true;
              // Also discard anything we had buffered
              this.orphanBuffer = '';
              continue; // Re-process remaining buffer
            }
          }

          // Check if buffer might still receive </think>
          // If we see content that looks like actual response (not reasoning), stop checking
          // Heuristic: If buffer is > 500 chars with no </think>, assume no orphan
          if (this.displayBuffer.length > 500) {
            this.orphanCheckComplete = true;
            // Flush orphan buffer
            output += this.orphanBuffer;
            this.orphanBuffer = '';
          }
        }

        // Look for opening tag
        const openMatch = this.displayBuffer.match(openTagRegex);

        if (openMatch) {
          // Found opening tag - mark orphan check complete if it's a think tag
          const blockType = openMatch[1].toLowerCase();
          if (blockType === 'think' || blockType === 'thinking') {
            this.orphanCheckComplete = true;
            output += this.orphanBuffer;
            this.orphanBuffer = '';
          }

          // Output everything before the tag
          const beforeTag = this.displayBuffer.slice(0, openMatch.index);
          if (this.orphanCheckComplete) {
            output += beforeTag;
          } else {
            this.orphanBuffer += beforeTag;
          }

          // Skip past the opening tag
          this.displayBuffer = this.displayBuffer.slice(openMatch.index + openMatch[0].length);
          this.insideXmlBlock = true;
          this.xmlBlockType = blockType === 'thinking' ? 'think' : blockType;
        } else {
          // No complete opening tag found
          // Check if buffer ends with a partial tag
          const partialMatch = this.displayBuffer.match(/<[^>]{0,20}$/);

          if (partialMatch) {
            // Output everything before the potential partial tag
            const beforePartial = this.displayBuffer.slice(0, partialMatch.index);
            if (this.orphanCheckComplete) {
              output += beforePartial;
            } else {
              this.orphanBuffer += beforePartial;
            }
            this.displayBuffer = this.displayBuffer.slice(partialMatch.index);
            break;
          } else {
            // Safe to output everything
            if (this.orphanCheckComplete) {
              output += this.displayBuffer;
            } else {
              this.orphanBuffer += this.displayBuffer;
            }
            this.displayBuffer = '';
          }
        }
      }
    }

    return stripControlTokens(output);
  }

  async handleStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const IDLE_TIMEOUT = 30000; // 30 seconds with no data = assume done (LM Studio needs time after prompt processing)

    try {
      while (true) {
        // Race between read and timeout
        const readPromise = reader.read();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('IDLE_TIMEOUT')), IDLE_TIMEOUT)
        );

        let done, value;
        try {
          const result = await Promise.race([readPromise, timeoutPromise]);
          done = result.done;
          value = result.value;
        } catch (e) {
          if (e.message === 'IDLE_TIMEOUT') {
            // No data for 5 seconds, assume stream is complete
            break;
          }
          throw e;
        }

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        this.buffer += chunk;

        // Process SSE data
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          let content = '';

          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              // Stream complete signal - exit the loop
              this.onComplete(this.fullResponse);
              return this.fullResponse;
            }

            try {
              const parsed = JSON.parse(data);
              // Try multiple possible response formats
              content = parsed.choices?.[0]?.delta?.content
                || parsed.choices?.[0]?.text
                || parsed.content
                || parsed.delta?.content
                || parsed.text
                || '';
            } catch {
              // Not valid JSON, treat as raw text
              content = data;
            }
          } else if (line.trim() && !line.startsWith(':')) {
            // Raw text line (not SSE comment)
            content = line;
          }

          if (content) {
            this.fullResponse += content;
            // Filter out XML blocks for display
            const displayContent = this.filterForDisplay(content);
            if (displayContent) {
              this.onToken(displayContent);
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
              // Try multiple possible response formats
              const content = parsed.choices?.[0]?.delta?.content
                || parsed.choices?.[0]?.text
                || parsed.content
                || parsed.delta?.content
                || parsed.text
                || '';
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
