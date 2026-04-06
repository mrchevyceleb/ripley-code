const {
  OpenAICompatibleClient,
  AnthropicClient,
  OpenAICodexClient
} = require('./providerClients');
const {
  OPENAI_AUTH_ISSUER,
  OPENAI_CODEX_CLIENT_ID,
  requestDeviceCode,
  completeDeviceCodeLogin,
  refreshOpenAIToken,
  buildTokenRecord,
  isTokenExpired
} = require('./oauthOpenAI');

const PROVIDER_LABELS = {
  local: 'LM Studio',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  monkey: 'Monkey Models',
  'claude-code': 'Claude Code'
};

class ProviderManager {
  constructor(options = {}) {
    this.lmStudio = options.lmStudio;
    this.store = options.store;
  }

  getProviderLabel(provider) {
    return PROVIDER_LABELS[provider] || provider;
  }

  async beginOpenAIDeviceLogin() {
    return await requestDeviceCode({
      issuer: OPENAI_AUTH_ISSUER,
      clientId: OPENAI_CODEX_CLIENT_ID
    });
  }

  async completeOpenAIDeviceLogin(deviceCode) {
    const tokens = await completeDeviceCodeLogin(deviceCode, {
      timeoutMs: 15 * 60 * 1000
    });
    this.store.connectOpenAI(tokens);
    return tokens;
  }

  async _getOpenAIToken() {
    const auth = this.store.getAuth('openai');
    if (auth.accessToken && !isTokenExpired(auth.expiresAt)) {
      return auth.accessToken;
    }

    if (!auth.refreshToken) {
      if (auth.accessToken) return auth.accessToken;
      throw new Error('OpenAI is not connected. Run /connect and choose OpenAI.');
    }

    const refreshed = await refreshOpenAIToken({
      refreshToken: auth.refreshToken
    });
    const tokenRecord = buildTokenRecord(refreshed);
    this.store.connectOpenAI({
      accessToken: tokenRecord.accessToken || auth.accessToken,
      refreshToken: tokenRecord.refreshToken || auth.refreshToken,
      idToken: tokenRecord.idToken || auth.idToken,
      expiresAt: tokenRecord.expiresAt || auth.expiresAt
    });
    return this.store.getAuth('openai').accessToken;
  }

  async getClientForProvider(provider) {
    if (provider === 'local') return this.lmStudio;

    if (provider === 'anthropic') {
      const stored = this.store.getAuth('anthropic').apiKey;
      const apiKey = stored || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('Anthropic API key not found. Run /connect and choose Anthropic.');
      }
      return new AnthropicClient({
        apiKey,
        baseUrl: 'https://api.anthropic.com'
      });
    }

    if (provider === 'monkey') {
      const { MonkeyModelsClient } = require('./monkeyModels');
      const token = process.env.BANANA_MONKEY_TOKEN || this.store?.getAuth?.('monkey')?.apiKey;
      return new MonkeyModelsClient({ token: token || undefined });
    }

    if (provider === 'openrouter') {
      const stored = this.store.getAuth('openrouter').apiKey;
      const apiKey = stored || process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error('OpenRouter API key not found. Run /connect and choose OpenRouter.');
      }
      return new OpenAICompatibleClient({
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api',
        apiKey,
        extraHeaders: {
          'HTTP-Referer': 'https://github.com/mrchevyceleb/banana-code',
          'X-Title': 'Banana Code'
        }
      });
    }

    if (provider === 'openai') {
      const accessToken = await this._getOpenAIToken();
      return new OpenAICodexClient({
        accessToken
      });
    }

    if (provider === 'claude-code') {
      const { ClaudeCodeClient } = require('./claudeCodeProvider');
      return new ClaudeCodeClient();
    }

    throw new Error(`Unknown provider: ${provider}`);
  }

  async getClientForModel(model) {
    const provider = model?.provider || 'local';
    return await this.getClientForProvider(provider);
  }
}

module.exports = {
  ProviderManager,
  PROVIDER_LABELS
};
