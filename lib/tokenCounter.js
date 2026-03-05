/**
 * Token counting and cost estimation for Ripley Code
 */

class TokenCounter {
  constructor(config) {
    this.config = config;
    this.sessionTokens = {
      input: 0,
      output: 0
    };

    // Rough cost estimates per 1M tokens (adjust based on your model)
    this.costs = {
      local: { input: 0, output: 0 }, // Free for local models
      'gpt-4': { input: 30, output: 60 },
      'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
      'claude-3-opus': { input: 15, output: 75 },
      'claude-3-sonnet': { input: 3, output: 15 }
    };
  }

  // Estimate tokens from text (rough approximation)
  // More accurate would be to use tiktoken, but this works for estimates
  estimateTokens(text) {
    if (!text) return 0;

    // Average English: ~4 chars per token
    // Code tends to be more tokenized: ~3.5 chars per token
    const charCount = text.length;

    // Detect if it's mostly code
    const codeIndicators = ['{', '}', '(', ')', ';', '=>', 'function', 'const', 'import'];
    const isCode = codeIndicators.some(indicator => text.includes(indicator));

    const charsPerToken = isCode ? 3.5 : 4;
    return Math.ceil(charCount / charsPerToken);
  }

  // Track tokens for a request/response
  trackUsage(inputText, outputText) {
    const inputTokens = this.estimateTokens(inputText);
    const outputTokens = this.estimateTokens(outputText);

    this.sessionTokens.input += inputTokens;
    this.sessionTokens.output += outputTokens;

    return { inputTokens, outputTokens };
  }

  // Track exact API-reported usage when available
  addUsage(inputTokens = 0, outputTokens = 0) {
    const inTokens = Math.max(0, Number(inputTokens) || 0);
    const outTokens = Math.max(0, Number(outputTokens) || 0);
    this.sessionTokens.input += inTokens;
    this.sessionTokens.output += outTokens;
    return { inputTokens: inTokens, outputTokens: outTokens };
  }

  // Get session totals
  getSessionUsage() {
    return {
      input: this.sessionTokens.input,
      output: this.sessionTokens.output,
      total: this.sessionTokens.input + this.sessionTokens.output
    };
  }

  // Reset session tracking
  resetSession() {
    this.sessionTokens = { input: 0, output: 0 };
  }

  // Estimate cost (for non-local models)
  estimateCost(model = 'local') {
    const rates = this.costs[model] || this.costs.local;
    const inputCost = (this.sessionTokens.input / 1000000) * rates.input;
    const outputCost = (this.sessionTokens.output / 1000000) * rates.output;

    return {
      input: inputCost,
      output: outputCost,
      total: inputCost + outputCost,
      formatted: `$${(inputCost + outputCost).toFixed(4)}`
    };
  }

  // Check if we're approaching token limit
  checkLimit(additionalTokens = 0) {
    const maxTokens = this.config.get('maxTokens') || 32000;
    const threshold = this.config.get('tokenWarningThreshold') || 0.8;
    const current = this.sessionTokens.input + this.sessionTokens.output + additionalTokens;

    const percentage = current / maxTokens;

    return {
      current,
      max: maxTokens,
      percentage,
      isWarning: percentage >= threshold,
      isExceeded: percentage >= 1,
      remaining: maxTokens - current
    };
  }

  // Format token count for display
  formatCount(count) {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(2)}M`;
    } else if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  }

  // Get a nice summary string
  getSummary() {
    const usage = this.getSessionUsage();
    const limit = this.checkLimit();

    let summary = `Tokens: ${this.formatCount(usage.total)} `;
    summary += `(${this.formatCount(usage.input)} in / ${this.formatCount(usage.output)} out)`;

    if (limit.isWarning) {
      summary += ` ⚠️ ${Math.round(limit.percentage * 100)}% of limit`;
    }

    return summary;
  }
}

module.exports = TokenCounter;
