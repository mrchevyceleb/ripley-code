/**
 * LM Studio API Client for Ripley Code v4
 * Direct connection to LM Studio - no middleware needed.
 */

const DEFAULT_URL = 'http://localhost:1234';

class LmStudio {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_URL;
    this.completionsUrl = `${this.baseUrl}/v1/chat/completions`;
    this.modelsUrl = `${this.baseUrl}/v1/models`;
  }

  /**
   * Non-streaming chat completion
   */
  async chat(messages, options = {}) {
    const body = {
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 10000,
      stream: false
    };
    if (options.model) body.model = options.model;
    if (options.tools) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }
    if (options.thinking === true) {
      body.thinking = { type: 'enabled', budget_tokens: 1024 };
    } else if (options.thinking === false) {
      body.thinking = { type: 'disabled' };
    }

    const response = await fetch(this.completionsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LM Studio error (${response.status}): ${error}`);
    }

    const data = await response.json();
    return data;
  }

  /**
   * Streaming chat completion - returns the raw Response for SSE processing
   */
  async chatStream(messages, options = {}) {
    const body = {
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 10000,
      stream: true
    };
    if (options.model) body.model = options.model;
    if (options.thinking === true) {
      body.thinking = { type: 'enabled', budget_tokens: 1024 };
    } else if (options.thinking === false) {
      body.thinking = { type: 'disabled' };
    }

    const fetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
    if (options.signal) fetchOptions.signal = options.signal;

    const response = await fetch(this.completionsUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LM Studio error (${response.status}): ${error}`);
    }

    return response;
  }

  /**
   * List available models from LM Studio
   */
  async listModels() {
    try {
      const response = await fetch(this.modelsUrl);
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  /**
   * Get the currently loaded model
   */
  async getLoadedModel() {
    const models = await this.listModels();
    return models.length > 0 ? models[0] : null;
  }

  /**
   * Health check - can we reach LM Studio?
   */
  async isConnected() {
    try {
      const response = await fetch(this.modelsUrl, {
        signal: AbortSignal.timeout(3000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

module.exports = LmStudio;
