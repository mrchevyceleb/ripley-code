/**
 * Model Registry for Ripley Code v4
 * Handles local models from models.json + connected remote provider models.
 */

const fs = require('fs');

class ModelRegistry {
  constructor(registryPath, lmStudio, providerStore = null) {
    this.registryPath = registryPath;
    this.lmStudio = lmStudio;
    this.providerStore = providerStore;
    this.localRegistry = { default: 'gpt-oss', models: {} };
    this.registry = { default: 'gpt-oss', models: {} };
    this.currentModel = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.registryPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
        this.localRegistry = {
          default: parsed.default || 'gpt-oss',
          models: parsed.models || {}
        };
      }
    } catch {
      this.localRegistry = { default: 'gpt-oss', models: {} };
    }

    this._normalizeLocalModels();
    this.refreshRemoteModels();
  }

  save() {
    fs.writeFileSync(this.registryPath, JSON.stringify(this.localRegistry, null, 2));
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
          contextLimit: remoteModel.contextLimit || 200000,
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
   * Auto-discover local model IDs from LM Studio and update local registry
   */
  async discover() {
    if (!this.lmStudio) return { matched: 0, total: 0 };

    const lmModels = await this.lmStudio.listModels();
    if (lmModels.length === 0) return { matched: 0, total: 0 };

    let matched = 0;
    for (const [key, model] of Object.entries(this.localRegistry.models)) {
      if ((model.provider || 'local') !== 'local') continue;

      const keywords = this._getMatchKeywords(key, model.name);
      for (const lmModel of lmModels) {
        const lmId = (lmModel.id || '').toLowerCase();
        if (keywords.some(kw => lmId.includes(kw))) {
          model.id = lmModel.id;
          matched++;
          break;
        }
      }
    }

    if (matched > 0) {
      this.save();
      this.refreshRemoteModels();
    }

    return { matched, total: lmModels.length };
  }

  /**
   * Generate match keywords from local model key and name
   */
  _getMatchKeywords(key, name) {
    const keywords = [];
    const keyMap = {
      'gpt-oss': ['gpt-oss', 'gpt_oss'],
      'qwen35': ['qwen3.5-35b', 'qwen3.5-35'],
      'nemotron': ['nemotron'],
      'coder': ['qwen3-coder-30b', 'qwen3-coder-30'],
      'glm': ['glm-4.7', 'glm-4-flash', 'glm4'],
      'max': ['qwen3-coder-next', 'coder-next'],
      'mistral': ['mistral-small']
    };
    if (keyMap[key]) keywords.push(...keyMap[key]);

    if (typeof name === 'string' && name.trim()) {
      const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      keywords.push(...parts.slice(0, 3));
    }

    return [...new Set(keywords)];
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
}

module.exports = ModelRegistry;
