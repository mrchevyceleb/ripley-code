/**
 * Model Registry for Banana Code v4
 * Handles local models from models.json + connected remote provider models.
 */

const fs = require('fs');
const { atomicWriteJsonSync } = require('./fsUtils');

class ModelRegistry {
  constructor(registryPath, lmStudio, providerStore = null) {
    this.registryPath = registryPath;
    this.lmStudio = lmStudio;
    this.providerStore = providerStore;
    this.localRegistry = { default: 'silverback', models: {} };
    this.registry = { default: 'silverback', models: {} };
    this.currentModel = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.registryPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
        this.localRegistry = {
          default: parsed.default || 'silverback',
          models: parsed.models || {}
        };
      }
    } catch {
      this.localRegistry = { default: 'silverback', models: {} };
    }

    this._normalizeLocalModels();
    this.refreshRemoteModels();
  }

  save() {
    atomicWriteJsonSync(this.registryPath, this.localRegistry);
  }

  _normalizeLocalModels() {
    for (const model of Object.values(this.localRegistry.models)) {
      if (!model.provider) model.provider = 'local';
    }
  }

  refreshRemoteModels() {
    const mergedModels = {};

    for (const [key, model] of Object.entries(this.localRegistry.models)) {
      mergedModels[key] = { ...model, provider: model.provider || 'local' };
    }

    if (this.providerStore) {
      for (const remoteModel of this.providerStore.getConnectedRemoteModels()) {
        const key = remoteModel.key;
        mergedModels[key] = {
          name: remoteModel.name,
          id: remoteModel.id,
          providerModelId: remoteModel.id,
          provider: remoteModel.provider,
          reasoningEffort: remoteModel.reasoningEffort,
          contextLimit: remoteModel.contextLimit || 128000,
          supportsThinking: remoteModel.supportsThinking !== false,
          prompt: remoteModel.prompt || 'code-agent',
          inferenceSettings: {
            temperature: 0.5,
            topP: 0.9
          },
          tags: remoteModel.tags || ['remote', remoteModel.provider],
          tier: 'remote',
          description: `${remoteModel.name} via ${remoteModel.provider}`,
          remote: true
        };
      }
    }

    this.registry = {
      default: this.localRegistry.default,
      models: mergedModels
    };

    if (this.currentModel && !this.registry.models[this.currentModel]) {
      this.currentModel = this.registry.default;
    }
  }

  /**
   * Get all models
   */
  list() {
    return Object.entries(this.registry.models).map(([key, model]) => ({
      key,
      ...model,
      active: key === this.currentModel
    }));
  }

  /**
   * Get a model by key
   */
  get(name) {
    return this.registry.models[name] || null;
  }

  /**
   * Get current active model key
   */
  getCurrent() {
    if (this.currentModel && this.registry.models[this.currentModel]) {
      return this.currentModel;
    }
    return this.registry.default || Object.keys(this.registry.models)[0] || null;
  }

  /**
   * Get active provider key for current model
   */
  getCurrentProvider() {
    const model = this.getCurrentModel();
    return model?.provider || 'local';
  }

  /**
   * Get current model identifier
   */
  getCurrentId() {
    const model = this.getCurrentModel();
    if (!model) return undefined;
    return model.providerModelId || model.id;
  }

  /**
   * Get current model metadata
   */
  getCurrentModel() {
    const name = this.getCurrent();
    if (!name) return null;
    return { key: name, ...this.registry.models[name] };
  }

  /**
   * Set active model
   */
  setCurrent(name) {
    if (!this.registry.models[name]) {
      throw new Error(`Unknown model: "${name}". Use /model to see available models.`);
    }
    this.currentModel = name;
  }

  /**
   * Check if a model has a specific tag
   */
  hasTag(name, tag) {
    const model = this.registry.models[name];
    return model?.tags?.includes(tag) || false;
  }

  /**
   * Check if current model supports vision
   */
  currentSupportsVision() {
    const name = this.getCurrent();
    return name ? this.hasTag(name, 'vision') : false;
  }

  /**
   * Check if current model supports thinking mode
   */
  currentSupportsThinking() {
    const name = this.getCurrent();
    if (!name) return false;
    return this.registry.models[name]?.supportsThinking === true;
  }

  /**
   * Get context limit for current model
   */
  getContextLimit() {
    const name = this.getCurrent();
    if (!name) return 32768;
    return this.registry.models[name]?.contextLimit || 32768;
  }

  /**
   * Get preferred prompt name for current model
   */
  getPrompt() {
    const name = this.getCurrent();
    if (!name) return 'code-agent';
    return this.registry.models[name]?.prompt || 'code-agent';
  }

  /**
   * Get inference settings for current model
   */
  getInferenceSettings() {
    const name = this.getCurrent();
    if (!name) return { temperature: 0.6, topP: undefined, repeatPenalty: undefined };
    const settings = this.registry.models[name]?.inferenceSettings;
    return {
      temperature: settings?.temperature ?? 0.6,
      topP: settings?.topP ?? undefined,
      repeatPenalty: settings?.repeatPenalty ?? undefined
    };
  }

  /**
   * Check if current model requires reasoning preservation
   */
  requiresReasoningPreservation() {
    const name = this.getCurrent();
    if (!name) return false;
    return this.registry.models[name]?.preserveReasoning === true;
  }

  /**
   * Probe LM Studio and inject/update a dynamic "lmstudio" entry in the registry.
   * If LM Studio is not connected or has no model loaded, removes the entry.
   */
  async refreshLmStudio() {
    if (!this.lmStudio) return;

    const connected = await this.lmStudio.isConnected();
    if (!connected) {
      delete this.registry.models['lmstudio'];
      return;
    }

    const instances = await this.lmStudio.getLoadedInstances();
    const first = instances[0];

    if (first && first.key) {
      this.registry.models['lmstudio'] = {
        name: `LM Studio: ${first.displayName}`,
        id: first.key,
        provider: 'local',
        contextLimit: first.contextLength || 32768,
        maxOutputTokens: Math.min(first.contextLength || 32768, 32768),
        supportsThinking: false,
        prompt: 'code-agent',
        inferenceSettings: { temperature: 0.7, topP: 0.9 },
        tags: ['local', 'lm-studio'],
        tier: 'local',
        description: `${first.displayName} via LM Studio`,
        dynamic: true
      };
    } else {
      // Connected but no model loaded
      this.registry.models['lmstudio'] = {
        name: 'LM Studio (no model loaded)',
        id: '',
        provider: 'local',
        contextLimit: 32768,
        supportsThinking: false,
        prompt: 'code-agent',
        inferenceSettings: { temperature: 0.7, topP: 0.9 },
        tags: ['local', 'lm-studio'],
        tier: 'local',
        description: 'Load a model in LM Studio to use',
        dynamic: true
      };
    }
  }

  /**
   * Get default model key
   */
  getDefault() {
    if (this.registry.models[this.registry.default]) {
      return this.registry.default;
    }
    return Object.keys(this.registry.models)[0] || null;
  }

  /**
   * Resolve a "provider:alias" model key string to full model metadata.
   *
   * Supported formats:
   *   - "anthropic:claude-sonnet-4.6" -> looks up by key in merged registry
   *   - "local:current" -> resolves to the currently active local model
   *   - "nemotron" -> plain key lookup (no colon)
   *
   * @param {string} key - Model key to resolve
   * @returns {Object|null} - Full model metadata with key, provider, providerModelId, etc.
   */
  resolveModelKey(key) {
    if (!key || typeof key !== 'string') return null;
    const trimmed = key.trim();

    // Handle "local:current" special case
    if (trimmed.toLowerCase() === 'local:current') {
      return this.getCurrentModel();
    }

    // Check if it's a "provider:alias" format
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const provider = trimmed.slice(0, colonIdx).toLowerCase();
      const alias = trimmed.slice(colonIdx + 1);

      // Direct key lookup first (the merged key is "provider:alias")
      if (this.registry.models[trimmed]) {
        return { key: trimmed, ...this.registry.models[trimmed] };
      }

      // Try matching by provider + partial alias
      for (const [k, model] of Object.entries(this.registry.models)) {
        if ((model.provider || 'local') === provider) {
          if (k === trimmed || k === alias || k.includes(alias) ||
              (model.name && model.name.toLowerCase().includes(alias.toLowerCase()))) {
            return { key: k, ...model };
          }
        }
      }

      return null;
    }

    // Plain key lookup (no colon)
    if (this.registry.models[trimmed]) {
      return { key: trimmed, ...this.registry.models[trimmed] };
    }

    // Fuzzy match by name or partial key
    for (const [k, model] of Object.entries(this.registry.models)) {
      if (k.includes(trimmed) || (model.name && model.name.toLowerCase().includes(trimmed.toLowerCase()))) {
        return { key: k, ...model };
      }
    }

    return null;
  }
}

module.exports = ModelRegistry;
