/**
 * Streaming response handler for Ripley Code
 */

const { parseResponse } = require('./parser');

class StreamHandler {
  constructor(options = {}) {
    this.onToken = options.onToken || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.buffer = '';
    this.fullResponse = '';
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
                this.onToken(content);
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
                this.onToken(content);
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
