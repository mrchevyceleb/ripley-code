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
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.repeatPenalty !== undefined) body.repeat_penalty = options.repeatPenalty;
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
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.repeatPenalty !== undefined) body.repeat_penalty = options.repeatPenalty;
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
   * Get all loaded model instances from LM Studio REST API.
   * Returns array of { key, instanceId, displayName }
   */
  async getLoadedInstances() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/models`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return [];
      const data = await response.json();
      const instances = [];
      for (const model of data.models || []) {
        for (const inst of model.loaded_instances || []) {
          instances.push({ key: model.key, instanceId: inst.id, displayName: model.display_name });
        }
      }
      return instances;
    } catch {
      return [];
    }
  }

  /**
   * Load a model into LM Studio.
   * @param {string} modelId - Model identifier (e.g., "qwen/qwen3-coder-30b")
   * @param {Object} options - Optional load config (context_length, flash_attention, etc.)
   * @returns {Object} - { instance_id, load_time_seconds, status }
   */
  async loadModel(modelId, options = {}) {
    const body = { model: modelId };
    if (options.contextLength) body.context_length = options.contextLength;
    if (options.flashAttention !== undefined) body.flash_attention = options.flashAttention;

    const response = await fetch(`${this.baseUrl}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to load model (${response.status}): ${error}`);
    }

    return await response.json();
  }

  /**
   * Unload a model from LM Studio.
   * @param {string} instanceId - The instance_id of the loaded model
   */
  async unloadModel(instanceId) {
    const response = await fetch(`${this.baseUrl}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to unload model (${response.status}): ${error}`);
    }

    return await response.json();
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
