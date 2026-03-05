const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(os.homedir(), '.ripley', 'providers.json');

const PROVIDERS = ['anthropic', 'openai', 'openrouter'];

const DEFAULT_PROVIDER_MODELS = {
  anthropic: {
    'claude-opus-4.6': {
      name: 'Claude Opus 4.6',
      id: 'claude-opus-4-6',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    },
    'claude-sonnet-4.6': {
      name: 'Claude Sonnet 4.6',
      id: 'claude-sonnet-4-6',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    }
  },
  openai: {
    'codex-5.3-medium': {
      name: 'Codex 5.3 Medium',
      id: 'gpt-5.3-codex',
      reasoningEffort: 'medium',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    },
    'codex-5.3-high': {
      name: 'Codex 5.3 High',
      id: 'gpt-5.3-codex',
      reasoningEffort: 'high',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    }
  },
  openrouter: {
    'claude-opus-4.6': {
      name: 'Claude Opus 4.6 (OpenRouter)',
      id: 'anthropic/claude-opus-4-6',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    },
    'claude-sonnet-4.6': {
      name: 'Claude Sonnet 4.6 (OpenRouter)',
      id: 'anthropic/claude-sonnet-4-6',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    },
    'codex-5.3-medium': {
      name: 'Codex 5.3 Medium (OpenRouter)',
      id: 'openai/gpt-5.3-codex',
      reasoningEffort: 'medium',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    },
    'codex-5.3-high': {
      name: 'Codex 5.3 High (OpenRouter)',
      id: 'openai/gpt-5.3-codex',
      reasoningEffort: 'high',
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    }
  }
};

function defaultProviderRecord(provider) {
  return {
    connected: false,
    auth: {},
    models: JSON.parse(JSON.stringify(DEFAULT_PROVIDER_MODELS[provider] || {})),
    updatedAt: null
  };
}

function createDefaultData() {
  return {
    version: 1,
    providers: {
      anthropic: defaultProviderRecord('anthropic'),
      openai: defaultProviderRecord('openai'),
      openrouter: defaultProviderRecord('openrouter')
    }
  };
}

function canonicalizeProviderModelId(provider, modelId) {
  if (!modelId || typeof modelId !== 'string') return modelId;
  const raw = modelId.trim();
  const lower = raw.toLowerCase();
  if (provider === 'anthropic') {
    if (lower === 'claude-sonnet-4.7' || lower === 'claude-sonnet-4-7') {
      return 'claude-sonnet-4-6';
    }
  }
  if (provider === 'openai') {
    if (lower === 'codex-5.3-medium' || lower === 'codex-5.3-high'
      || lower === 'openai/codex-5.3-medium' || lower === 'openai/codex-5.3-high') {
      return 'gpt-5.3-codex';
    }
  }
  if (provider === 'openrouter') {
    if (lower === 'claude-sonnet-4.7' || lower === 'claude-sonnet-4-7'
      || lower === 'anthropic/claude-sonnet-4.7' || lower === 'anthropic/claude-sonnet-4-7') {
      return 'anthropic/claude-sonnet-4-6';
    }
    if (lower === 'codex-5.3-medium' || lower === 'codex-5.3-high'
      || lower === 'openai/codex-5.3-medium' || lower === 'openai/codex-5.3-high') {
      return 'openai/gpt-5.3-codex';
    }
  }
  return raw;
}

class ProviderStore {
  constructor(filePath = DEFAULT_PATH) {
    this.filePath = filePath;
    this.data = createDefaultData();
    this.load();
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _touch(provider) {
    if (!this.data.providers[provider]) {
      this.data.providers[provider] = defaultProviderRecord(provider);
    }
    this.data.providers[provider].updatedAt = new Date().toISOString();
  }

  load() {
    let migrated = false;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.data = createDefaultData();
      if (raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object') {
        for (const provider of PROVIDERS) {
          const incoming = raw.providers[provider] || {};
          this.data.providers[provider] = {
            ...defaultProviderRecord(provider),
            ...incoming,
            auth: { ...(incoming.auth || {}) },
            models: {
              ...defaultProviderRecord(provider).models,
              ...(incoming.models || {})
            }
          };
          if (this._migrateLegacyModelIds(provider)) {
            migrated = true;
          }
        }
      }
    } catch {
      this.data = createDefaultData();
    }
    if (migrated) this.save();
  }

  _migrateLegacyModelIds(provider) {
    const models = this.data.providers?.[provider]?.models;
    if (!models || typeof models !== 'object') return false;
    let changed = false;

    const sonnetLegacyAlias = 'claude-sonnet-4.7';
    const sonnetCurrentAlias = 'claude-sonnet-4.6';
    if ((provider === 'anthropic' || provider === 'openrouter') && models[sonnetLegacyAlias]) {
      const legacy = models[sonnetLegacyAlias];
      const current = models[sonnetCurrentAlias] || {};
      const currentDefaultName = provider === 'openrouter'
        ? 'Claude Sonnet 4.6 (OpenRouter)'
        : 'Claude Sonnet 4.6';
      const currentDefaultId = provider === 'openrouter'
        ? 'anthropic/claude-sonnet-4-6'
        : 'claude-sonnet-4-6';

      models[sonnetCurrentAlias] = {
        ...legacy,
        ...current,
        name: current.name || currentDefaultName,
        id: canonicalizeProviderModelId(provider, current.id || legacy.id || currentDefaultId)
      };
      delete models[sonnetLegacyAlias];
      changed = true;
    }

    const patchSetByProvider = {
      anthropic: {
        'claude-sonnet-4.6': {
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          legacyIds: ['claude-sonnet-4.6', 'claude-sonnet-4-6', 'claude-sonnet-4.7', 'claude-sonnet-4-7']
        }
      },
      openai: {
        'codex-5.3-medium': {
          id: 'gpt-5.3-codex',
          reasoningEffort: 'medium',
          legacyIds: ['codex-5.3-medium', 'openai/codex-5.3-medium']
        },
        'codex-5.3-high': {
          id: 'gpt-5.3-codex',
          reasoningEffort: 'high',
          legacyIds: ['codex-5.3-high', 'openai/codex-5.3-high']
        }
      },
      openrouter: {
        'claude-sonnet-4.6': {
          id: 'anthropic/claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6 (OpenRouter)',
          legacyIds: [
            'claude-sonnet-4.6',
            'claude-sonnet-4-6',
            'claude-sonnet-4.7',
            'claude-sonnet-4-7',
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-sonnet-4.7',
            'anthropic/claude-sonnet-4-7'
          ]
        },
        'codex-5.3-medium': {
          id: 'openai/gpt-5.3-codex',
          reasoningEffort: 'medium',
          legacyIds: ['codex-5.3-medium', 'openai/codex-5.3-medium']
        },
        'codex-5.3-high': {
          id: 'openai/gpt-5.3-codex',
          reasoningEffort: 'high',
          legacyIds: ['codex-5.3-high', 'openai/codex-5.3-high']
        }
      }
    };

    const patchSet = patchSetByProvider[provider];
    if (!patchSet) return changed;

    for (const [alias, patch] of Object.entries(patchSet)) {
      const model = models[alias];
      if (!model) continue;

      const currentId = typeof model.id === 'string' ? model.id.trim().toLowerCase() : '';
      const legacyIds = new Set((patch.legacyIds || []).map((id) => String(id).toLowerCase()));
      if (!currentId || legacyIds.has(currentId)) {
        model.id = patch.id;
        changed = true;
      }
      if (patch.reasoningEffort && !model.reasoningEffort) {
        model.reasoningEffort = patch.reasoningEffort;
        changed = true;
      }
      if (patch.name && (!model.name || /4\.7/.test(model.name))) {
        model.name = patch.name;
        changed = true;
      }
    }

    return changed;
  }

  save() {
    this._ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  listProviders() {
    return PROVIDERS.map((provider) => ({ provider, ...this.getProvider(provider) }));
  }

  getProvider(provider) {
    return this.data.providers[provider] || defaultProviderRecord(provider);
  }

  isConnected(provider) {
    return this.getProvider(provider).connected === true;
  }

  connectWithApiKey(provider, apiKey) {
    if (!['anthropic', 'openrouter'].includes(provider)) {
      throw new Error(`API key login is not supported for provider "${provider}"`);
    }
    this._touch(provider);
    this.data.providers[provider].connected = true;
    this.data.providers[provider].auth = { apiKey };
    this.save();
  }

  connectOpenAI(auth) {
    this._touch('openai');
    this.data.providers.openai.connected = true;
    this.data.providers.openai.auth = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      idToken: auth.idToken || null,
      expiresAt: auth.expiresAt || null
    };
    this.save();
  }

  disconnect(provider) {
    this.data.providers[provider] = defaultProviderRecord(provider);
    this._touch(provider);
    this.save();
  }

  getAuth(provider) {
    return { ...(this.getProvider(provider).auth || {}) };
  }

  setModelId(provider, alias, modelId, options = {}) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    const record = this.getProvider(provider);
    const current = record.models[alias] || {
      name: options.name || alias,
      id: modelId,
      contextLimit: 200000,
      supportsThinking: true,
      prompt: 'code-agent'
    };
    record.models[alias] = {
      ...current,
      ...options,
      id: canonicalizeProviderModelId(provider, modelId)
    };
    this.data.providers[provider] = record;
    this._touch(provider);
    this.save();
  }

  getModels(provider) {
    return { ...(this.getProvider(provider).models || {}) };
  }

  getConnectedRemoteModels() {
    const models = [];
    for (const provider of PROVIDERS) {
      const record = this.getProvider(provider);
      const envConnected = (provider === 'anthropic' && !!process.env.ANTHROPIC_API_KEY)
        || (provider === 'openrouter' && !!process.env.OPENROUTER_API_KEY);
      if (!record.connected && !envConnected) continue;

      for (const [alias, model] of Object.entries(record.models || {})) {
        const key = `${provider}:${alias}`;
        models.push({
          key,
          provider,
          alias,
          name: model.name || alias,
          id: model.id,
          reasoningEffort: model.reasoningEffort,
          contextLimit: model.contextLimit || 200000,
          supportsThinking: model.supportsThinking !== false,
          prompt: model.prompt || 'code-agent',
          tags: provider === 'openrouter'
            ? ['remote', provider, 'tool-calling']
            : ['remote', provider, 'tool-calling', 'vision']
        });
      }
    }
    return models;
  }
}

module.exports = {
  ProviderStore,
  PROVIDERS,
  DEFAULT_PROVIDER_MODELS
};
