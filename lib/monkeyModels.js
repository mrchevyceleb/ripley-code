/**
 * Monkey Models API Client for Banana Code CLI
 * Cloud provider wrapping OpenAICompatibleClient.
 *
 * Base URL: https://monkey-models-production.up.railway.app
 * Tiers: silverback, mandrill, gibbon, tamarin
 * Auth: Bearer token in Authorization header
 * Vision: image_url content blocks (server proxies to Gemini Flash)
 * The server handles personality injection, so no system prompts needed.
 */

const { OpenAICompatibleClient } = require('./providerClients');

const MONKEY_MODELS_URL = 'https://monkey-models-production.up.railway.app';
// Default token for Banana Code's own Monkey Models server.
// This is a shared service token (not a user secret). Users can override via env var.
const MONKEY_MODELS_DEFAULT_TOKEN = '086399eca157e4ad2fc0fecfb254da1118d226ac53371757267388b23bd10fa6';
const MONKEY_MODELS_TOKEN = process.env.BANANA_MONKEY_TOKEN || MONKEY_MODELS_DEFAULT_TOKEN;

const TIERS = ['silverback', 'mandrill', 'gibbon', 'tamarin'];

class MonkeyModelsClient extends OpenAICompatibleClient {
  constructor(options = {}) {
    super({
      label: 'Monkey Models',
      baseUrl: options.baseUrl || MONKEY_MODELS_URL,
      bearerToken: options.token || MONKEY_MODELS_TOKEN,
      ...options
    });
  }

  /**
   * Sanitizes error messages to prevent leaking upstream provider details (like OpenRouter).
   * @param {string} errorText The raw error text from the provider.
   * @returns {string} A sanitized error message.
   */
  _sanitizeError(errorText) {
    if (!errorText) return '';
    // If it looks like it contains OpenRouter or specific provider JSON/strings,
    // we want to strip that out and just provide a clean error.
    // The user's error shows: "OpenRouter 429: {\"error\":{\"message\":\"Provider returned error\"...}}"
    
    // Check if it's an error that contains JSON or common provider markers
    if (errorText.includes('OpenRouter') || errorText.includes('provider_name') || errorText.includes('is_byok')) {
      return 'Service is temporarily unavailable or rate-limited. Please try again shortly.';
    }
    
    return errorText;
  }

  /**
   * Overrides _request to sanitize error messages for Monkey Models.
   */
  async _request(path, body, signal) {
    try {
      return await super._request(path, body, signal);
    } catch (err) {
      if (err.message.startsWith('Monkey Models error')) {
        // Extract the part after the prefix
        const parts = err.message.split(': ');
        if (parts.length > 1) {
          const originalError = parts.slice(1).join(': ');
          const sanitized = this._sanitizeError(originalError);
          throw new Error(`Monkey Models error: ${sanitized}`);
        }
      }
      throw err;
    }
  }

  /**
   * GET /health - no auth required.
   * Returns parsed JSON on success, null on failure.
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Check connectivity via health endpoint first, then fall back to parent.
   */
  async isConnected(options = {}) {
    const health = await this.healthCheck();
    if (health) return true;
    return super.isConnected(options);
  }
}

module.exports = { MonkeyModelsClient, MONKEY_MODELS_URL, TIERS };
