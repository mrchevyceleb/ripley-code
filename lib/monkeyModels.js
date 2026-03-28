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
const MONKEY_MODELS_TOKEN = process.env.BANANA_MONKEY_TOKEN || '';

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
