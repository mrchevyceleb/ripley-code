/**
 * Model Registry for Ripley Code v4
 * Manages named model profiles and switching between them.
 */

const fs = require('fs');
const path = require('path');

class ModelRegistry {
  constructor(registryPath, lmStudio) {
    this.registryPath = registryPath;
    this.lmStudio = lmStudio;
    this.registry = { default: 'nemotron', models: {} };
    this.currentModel = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.registryPath)) {
        this.registry = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      }
    } catch {
      // Use empty registry
    }
  }

  save() {
    fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2));
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
   * Get a model by friendly name
   */
  get(name) {
    return this.registry.models[name] || null;
  }

  /**
   * Get the current active model name
   */
  getCurrent() {
    return this.currentModel || this.registry.default || null;
  }

  /**
   * Get the current model's LM Studio ID
   */
  getCurrentId() {
    const name = this.getCurrent();
    if (!name) return undefined;
    const model = this.registry.models[name];
    return model?.id || undefined;
  }

  /**
   * Get the current model's metadata
   */
  getCurrentModel() {
    const name = this.getCurrent();
    if (!name) return null;
    return { key: name, ...this.registry.models[name] };
  }

  /**
   * Set the active model
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
   * Check if current model supports the thinking API parameter
   */
  currentSupportsThinking() {
    const name = this.getCurrent();
    if (!name) return false;
    return this.registry.models[name]?.supportsThinking === true;
  }

  /**
   * Get the context limit for the current model (in tokens)
   */
  getContextLimit() {
    const name = this.getCurrent();
    if (!name) return 32768;
    return this.registry.models[name]?.contextLimit || 32768;
  }

  /**
   * Auto-discover model IDs from LM Studio and update registry
   */
  async discover() {
    if (!this.lmStudio) return { matched: 0, total: 0 };

    const lmModels = await this.lmStudio.listModels();
    if (lmModels.length === 0) return { matched: 0, total: 0 };

    let matched = 0;
    for (const [key, model] of Object.entries(this.registry.models)) {
      // Try to match by keywords in the LM Studio model ID
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

    if (matched > 0) this.save();
    return { matched, total: lmModels.length };
  }

  /**
   * Generate match keywords from model key and name
   */
  _getMatchKeywords(key, name) {
    const keywords = [];
    // Key-based patterns
    const keyMap = {
      'gpt-oss': ['gpt-oss', 'gpt_oss'],
      'qwen35': ['qwen3.5-35b', 'qwen3.5-35'],
      'nemotron': ['nemotron'],
      'coder': ['qwen3-coder-30b', 'qwen3-coder-30'],
      'glm': ['glm-4.7', 'glm-4-flash', 'glm4'],
      'max': ['qwen3-coder-next', 'coder-next'],
      'nemotron': ['nemotron'],
      'mistral': ['mistral-small']
    };
    if (keyMap[key]) keywords.push(...keyMap[key]);
    return keywords;
  }

  /**
   * Get the default model name
   */
  getDefault() {
    return this.registry.default;
  }
}

module.exports = ModelRegistry;
