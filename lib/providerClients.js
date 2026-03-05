function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const chunks = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === 'string') {
      chunks.push(item);
      continue;
    }
    if (typeof item.text === 'string') chunks.push(item.text);
    if (typeof item.content === 'string') chunks.push(item.content);
  }
  return chunks.join('\n').trim();
}

function parseJsonMaybe(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildSseResponseFromText(text) {
  const encoder = new TextEncoder();
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text || '' } }] })}\n\n`,
    'data: [DONE]\n\n'
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const line of payload) controller.enqueue(encoder.encode(line));
      controller.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

class OpenAICompatibleClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = options.apiKey || null;
    this.bearerToken = options.bearerToken || null;
    this.extraHeaders = { ...(options.extraHeaders || {}) };
    this.label = options.label || 'Provider';
  }

  _headers() {
    const headers = {
      'Content-Type': 'application/json',
      ...this.extraHeaders
    };
    const authToken = this.bearerToken || this.apiKey;
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return headers;
  }

  async _request(path, body, signal) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${this.label} error (${response.status}): ${text || response.statusText}`);
    }
    return await response.json();
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 10000,
      stream: false
    };
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.repeatPenalty !== undefined) body.repeat_penalty = options.repeatPenalty;
    if (options.tools) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }
    return await this._request('/v1/chat/completions', body, options.signal);
  }

  async chatStream(messages, options = {}) {
    const body = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 10000,
      stream: true
    };
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.repeatPenalty !== undefined) body.repeat_penalty = options.repeatPenalty;
    if (options.tools) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: options.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${this.label} error (${response.status}): ${text || response.statusText}`);
    }
    return response;
  }

  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this._headers()
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  async isConnected(options = {}) {
    const throwOnError = options.throwOnError === true;
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this._headers()
      });
      if (response.ok) return true;
      if (!throwOnError) return false;
      const text = await response.text().catch(() => '');
      const reason = (text || response.statusText || 'Request failed').slice(0, 300);
      throw new Error(`${this.label} connection check failed (${response.status}): ${reason}`);
    } catch (err) {
      if (throwOnError) throw err;
      return false;
    }
  }
}

function openAiToolsToAnthropic(tools = []) {
  const list = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (!fn?.name) continue;
    list.push({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} }
    });
  }
  return list;
}

function parseDataUrlImage(imageUrl) {
  if (typeof imageUrl !== 'string') return null;
  const trimmed = imageUrl.trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mediaType: match[1],
    data: match[2]
  };
}

function openAiUserContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return extractText(content);

  const blocks = [];
  for (const chunk of content) {
    if (!chunk) continue;

    if (typeof chunk === 'string') {
      const text = chunk.trim();
      if (text) blocks.push({ type: 'text', text });
      continue;
    }

    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      const text = chunk.text.trim();
      if (text) blocks.push({ type: 'text', text });
      continue;
    }

    if (typeof chunk.text === 'string' && chunk.type !== 'image_url') {
      const text = chunk.text.trim();
      if (text) blocks.push({ type: 'text', text });
      continue;
    }

    if (chunk.type === 'image_url') {
      const imageUrl = typeof chunk.image_url === 'string'
        ? chunk.image_url
        : chunk.image_url?.url;
      if (!imageUrl) continue;

      const parsed = parseDataUrlImage(imageUrl);
      if (parsed) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mediaType,
            data: parsed.data
          }
        });
        continue;
      }

      if (/^https?:\/\//i.test(imageUrl)) {
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: imageUrl
          }
        });
      }
    }
  }

  if (blocks.length === 0) {
    const text = extractText(content);
    return text || '';
  }
  return blocks;
}

function openAiMessagesToAnthropic(messages) {
  const systemParts = [];
  const out = [];
  for (const message of messages || []) {
    if (!message || !message.role) continue;

    if (message.role === 'system') {
      const sys = extractText(message.content);
      if (sys) systemParts.push(sys);
      continue;
    }

    if (message.role === 'user') {
      out.push({
        role: 'user',
        content: openAiUserContentToAnthropic(message.content)
      });
      continue;
    }

    if (message.role === 'assistant') {
      const content = [];
      const text = extractText(message.content);
      if (text) content.push({ type: 'text', text });

      for (const call of message.tool_calls || []) {
        content.push({
          type: 'tool_use',
          id: call.id || `tool_${Date.now()}`,
          name: call.function?.name || 'unknown_tool',
          input: parseJsonMaybe(call.function?.arguments, {})
        });
      }

      if (content.length > 0) out.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id || `tool_${Date.now()}`,
            content: typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content || {})
          }
        ]
      });
    }
  }

  return {
    system: systemParts.join('\n\n').trim(),
    messages: out
  };
}

function anthropicToOpenAi(data) {
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') {
      text += block.text || '';
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        type: 'function',
        id: block.id || `tool_${toolCalls.length + 1}`,
        function: {
          name: block.name || 'unknown_tool',
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  const message = {
    role: 'assistant',
    content: text || null
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = data.usage || {};
  const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);
  const cacheCreationTokens = Number(
    usage.cache_creation_input_tokens
    || usage.cache_creation?.ephemeral_5m_input_tokens
    || usage.cache_creation?.ephemeral_1h_input_tokens
    || 0
  );
  const promptTokens = Number(usage.input_tokens || 0) + cacheReadTokens + cacheCreationTokens;
  const completionTokens = Number(usage.output_tokens || 0);

  return {
    id: data.id,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : (data.stop_reason || 'stop'),
        message
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens
    }
  };
}

function normalizeAnthropicCacheControl(value) {
  if (value === undefined) return undefined;
  if (value === null || value === false) return null;
  if (value === true) return { type: 'ephemeral' };

  if (typeof value === 'string') {
    const raw = value.trim();
    const lower = raw.toLowerCase();
    if (!raw || lower === 'off' || lower === 'none' || lower === 'false' || lower === '0') {
      return null;
    }
    if (lower === 'ephemeral' || lower === 'on' || lower === 'true' || lower === '5m') {
      return { type: 'ephemeral' };
    }
    if (lower === '1h') {
      return { type: 'ephemeral', ttl: '1h' };
    }
    return { type: 'ephemeral', ttl: raw };
  }

  if (typeof value === 'object') {
    const out = { ...value };
    if (!out.type) out.type = 'ephemeral';
    return out;
  }

  return null;
}

class AnthropicClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.version = options.version || '2023-06-01';

    // Automatic prompt caching (Anthropic supports top-level cache_control).
    // Defaults to ephemeral 5m unless explicitly disabled.
    const envCacheControl = process.env.ANTHROPIC_CACHE_CONTROL;
    const optionCacheControl = options.defaultCacheControl;
    const normalized = normalizeAnthropicCacheControl(
      optionCacheControl !== undefined
        ? optionCacheControl
        : (envCacheControl !== undefined ? envCacheControl : true)
    );
    const envTtl = process.env.ANTHROPIC_CACHE_TTL;
    if (normalized && envTtl && !normalized.ttl) {
      normalized.ttl = envTtl;
    }
    this.defaultCacheControl = normalized;
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.version
    };
  }

  async chat(messages, options = {}) {
    const translated = openAiMessagesToAnthropic(messages);
    const body = {
      model: options.model,
      messages: translated.messages,
      max_tokens: options.maxTokens ?? 8192
    };
    if (translated.system) body.system = translated.system;
    const hasTemperature = options.temperature !== undefined && options.temperature !== null;
    const hasTopP = options.topP !== undefined && options.topP !== null;
    // Anthropic Sonnet/Opus 4.6 rejects requests that specify both sampling params.
    // Prefer temperature for compatibility with existing Ripley model defaults.
    if (hasTemperature) {
      body.temperature = options.temperature;
    } else if (hasTopP) {
      body.top_p = options.topP;
    }
    if (options.tools) body.tools = openAiToolsToAnthropic(options.tools);

    const requestedCacheControl = normalizeAnthropicCacheControl(
      options.cacheControl !== undefined
        ? options.cacheControl
        : this.defaultCacheControl
    );
    if (requestedCacheControl) {
      body.cache_control = { ...requestedCacheControl };
    }
    const sendRequest = async (payload) => fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload),
      signal: options.signal
    });

    let response = await sendRequest(body);
    if (!response.ok && body.cache_control) {
      const text = await response.text().catch(() => '');
      const cacheControlRejected = response.status === 400
        && /cache_control|ttl|ephemeral|unknown field|extra inputs/i.test(text);
      if (cacheControlRejected) {
        const retryBody = { ...body };
        delete retryBody.cache_control;
        response = await sendRequest(retryBody);
      } else {
        throw new Error(`Anthropic error (${response.status}): ${text || response.statusText}`);
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic error (${response.status}): ${text || response.statusText}`);
    }

    const data = await response.json();
    return anthropicToOpenAi(data);
  }

  async chatStream(messages, options = {}) {
    const data = await this.chat(messages, options);
    const text = data.choices?.[0]?.message?.content || '';
    return buildSseResponseFromText(text);
  }

  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this._headers()
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  async isConnected(options = {}) {
    const throwOnError = options.throwOnError === true;
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this._headers()
      });
      if (response.ok) return true;
      if (!throwOnError) return false;
      const text = await response.text().catch(() => '');
      const reason = (text || response.statusText || 'Request failed').slice(0, 300);
      throw new Error(`Anthropic connection check failed (${response.status}): ${reason}`);
    } catch (err) {
      if (throwOnError) throw err;
      return false;
    }
  }
}

function openAiMessagesToResponses(messages) {
  const instructions = [];
  const input = [];

  const toResponsesMessageContent = (role, content) => {
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    const parts = [];

    const pushText = (text) => {
      if (typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed) return;
      parts.push({ type: textType, text: trimmed });
    };

    if (typeof content === 'string') {
      pushText(content);
      return parts;
    }

    if (!Array.isArray(content)) return parts;

    for (const chunk of content) {
      if (!chunk) continue;

      if (typeof chunk === 'string') {
        pushText(chunk);
        continue;
      }

      if (typeof chunk.text === 'string') {
        pushText(chunk.text);
      }

      if (role !== 'assistant') {
        if (chunk.type === 'image_url') {
          const imageUrl = typeof chunk.image_url === 'string'
            ? chunk.image_url
            : chunk.image_url?.url;
          if (typeof imageUrl === 'string' && imageUrl.trim()) {
            parts.push({ type: 'input_image', image_url: imageUrl });
          }
        } else if (chunk.type === 'input_image') {
          const imageUrl = typeof chunk.image_url === 'string'
            ? chunk.image_url
            : chunk.image_url?.url;
          if (typeof imageUrl === 'string' && imageUrl.trim()) {
            parts.push({ type: 'input_image', image_url: imageUrl });
          }
        }
      }
    }

    return parts;
  };

  for (const message of messages || []) {
    if (!message || !message.role) continue;
    if (message.role === 'system') {
      const sys = extractText(message.content);
      if (sys) instructions.push(sys);
      continue;
    }

    if (message.role === 'user' || message.role === 'assistant') {
      const parts = toResponsesMessageContent(message.role, message.content);
      if (parts.length > 0) {
        input.push({
          type: 'message',
          role: message.role,
          content: parts
        });
      }
      if (message.role === 'assistant') {
        for (const toolCall of message.tool_calls || []) {
          input.push({
            type: 'function_call',
            call_id: toolCall.id || `call_${Date.now()}`,
            name: toolCall.function?.name || 'unknown_tool',
            arguments: typeof toolCall.function?.arguments === 'string'
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function?.arguments || {})
          });
        }
      }
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id || `call_${Date.now()}`,
        output: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content || {})
      });
    }
  }

  return {
    instructions: instructions.join('\n\n').trim(),
    input
  };
}

function openAiToolsToResponses(tools = []) {
  return tools
    .map((tool) => {
      const fn = tool?.function;
      if (!fn?.name) return null;
      return {
        type: 'function',
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} }
      };
    })
    .filter(Boolean);
}

function responsesToOpenAi(data) {
  let text = '';
  const toolCalls = [];
  for (const item of data.output || []) {
    if (item.type === 'message' && item.role === 'assistant') {
      for (const block of item.content || []) {
        if (block.type === 'output_text' || block.type === 'text') {
          text += block.text || '';
        }
      }
      continue;
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        type: 'function',
        id: item.call_id || item.id || `call_${toolCalls.length + 1}`,
        function: {
          name: item.name || 'unknown_tool',
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments || {})
        }
      });
    }
  }

  if (!text && typeof data.output_text === 'string') {
    text = data.output_text;
  }

  const message = {
    role: 'assistant',
    content: text || null
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: data.id,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        message
      }
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    }
  };
}

function normalizeOpenAICodexOptions(options = {}) {
  const normalized = { ...options };
  const rawModel = String(normalized.model || '').trim();
  const model = rawModel.replace(/^(openai[/:])+/i, '');
  const modelKey = model.toLowerCase();
  const aliasMap = {
    'codex-5.3-medium': { model: 'gpt-5.3-codex', reasoningEffort: 'medium' },
    'codex-5.3-high': { model: 'gpt-5.3-codex', reasoningEffort: 'high' }
  };
  const patch = aliasMap[modelKey];
  if (patch) {
    normalized.model = patch.model;
    if (!normalized.reasoningEffort) normalized.reasoningEffort = patch.reasoningEffort;
  } else if (rawModel && rawModel !== model) {
    normalized.model = model;
  }
  return normalized;
}

function normalizeOpenAICodexClientVersion(value) {
  const fallback = '4.0.0';
  const raw = String(value || '').trim();
  if (!raw) return fallback;

  // Backend expects a semantic version triplet (e.g. 4.0.0).
  const exactTriplet = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (exactTriplet) return `${exactTriplet[1]}.${exactTriplet[2]}.${exactTriplet[3]}`;

  const embeddedTriplet = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (embeddedTriplet) return `${embeddedTriplet[1]}.${embeddedTriplet[2]}.${embeddedTriplet[3]}`;

  return fallback;
}

function extractOutputTextFromResponseItem(item) {
  if (!item || typeof item !== 'object') return '';
  const content = Array.isArray(item.content) ? item.content : [];
  let text = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

function buildOpenAICodexStreamError(payload) {
  const error = payload?.response?.error || payload?.error || {};
  const detail = error.message
    || error.detail
    || (typeof payload === 'string' ? payload : JSON.stringify(payload));
  return new Error(`OpenAI Codex stream failed: ${detail}`);
}

async function consumeOpenAICodexSse(response, handlers = {}) {
  if (!response?.body) {
    throw new Error('OpenAI Codex stream returned an empty response body');
  }

  const onTextDelta = typeof handlers.onTextDelta === 'function' ? handlers.onTextDelta : null;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  let sawOutputTextDelta = false;
  let text = '';
  let responseId = null;
  let usage = null;
  const toolCallsById = new Map();
  const toolCallOrder = [];

  const applyPayload = (payload, fallbackEventName = '') => {
    if (!payload || typeof payload !== 'object') return;
    const eventType = typeof payload.type === 'string' ? payload.type : fallbackEventName;
    if (!eventType) return;

    if (eventType === 'response.output_text.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (!delta) return;
      sawOutputTextDelta = true;
      text += delta;
      if (onTextDelta) onTextDelta(delta);
      return;
    }

    if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
      const item = payload.item;
      if (!item || typeof item !== 'object') return;

      if (item.type === 'function_call') {
        const callId = String(item.call_id || item.id || `call_${toolCallsById.size + 1}`);
        const existing = toolCallsById.get(callId);
        let args = item.arguments;
        if (args === undefined || args === null) args = '{}';
        if (typeof args !== 'string') args = JSON.stringify(args);
        const toolCall = {
          type: 'function',
          id: callId,
          function: {
            name: item.name || existing?.function?.name || 'unknown_tool',
            arguments: args
          }
        };
        if (!existing) toolCallOrder.push(callId);
        toolCallsById.set(callId, toolCall);
        return;
      }

      if (item.type === 'message' && !sawOutputTextDelta) {
        const itemText = extractOutputTextFromResponseItem(item);
        if (itemText) {
          text += itemText;
        }
      }
      return;
    }

    if (eventType === 'response.completed') {
      const responseData = payload.response || {};
      if (responseData.id) responseId = responseData.id;
      if (responseData.usage && typeof responseData.usage === 'object') {
        usage = responseData.usage;
      }
      return;
    }

    if (eventType === 'response.failed') {
      throw buildOpenAICodexStreamError(payload);
    }
  };

  const flushEvent = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const dataText = dataLines.join('\n').trim();
    dataLines = [];
    const fallbackEventName = eventName;
    eventName = '';
    if (!dataText || dataText === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      return;
    }
    applyPayload(payload, fallbackEventName);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineBreakIdx = buffer.indexOf('\n');
    while (lineBreakIdx >= 0) {
      let line = buffer.slice(0, lineBreakIdx);
      buffer = buffer.slice(lineBreakIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        flushEvent();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }

      lineBreakIdx = buffer.indexOf('\n');
    }
  }

  if (buffer.trim().length > 0) {
    if (buffer.startsWith('data:')) {
      dataLines.push(buffer.slice(5).trimStart());
    }
  }
  flushEvent();

  const toolCalls = toolCallOrder
    .map((id) => toolCallsById.get(id))
    .filter(Boolean);

  return {
    responseId,
    text,
    usage,
    toolCalls
  };
}

class OpenAICodexClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
    this.accessToken = options.accessToken;
    this.clientVersion = normalizeOpenAICodexClientVersion(
      options.clientVersion || process.env.OPENAI_CODEX_CLIENT_VERSION || '4.0.0'
    );
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`
    };
  }

  _url(pathname) {
    const base = `${this.baseUrl}${pathname}`;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}client_version=${encodeURIComponent(this.clientVersion)}`;
  }

  async chat(messages, options = {}) {
    const resolvedOptions = normalizeOpenAICodexOptions(options);
    const translated = openAiMessagesToResponses(messages);
    const body = {
      model: resolvedOptions.model,
      input: translated.input,
      stream: true,
      store: false,
      parallel_tool_calls: true
    };
    if (translated.instructions) body.instructions = translated.instructions;
    if (resolvedOptions.tools) body.tools = openAiToolsToResponses(resolvedOptions.tools);
    if (resolvedOptions.reasoningEffort) {
      body.reasoning = { effort: resolvedOptions.reasoningEffort };
    }

    const response = await fetch(this._url('/responses'), {
      method: 'POST',
      headers: { ...this._headers(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: resolvedOptions.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI Codex error (${response.status}): ${text || response.statusText}`);
    }

    const parsed = await consumeOpenAICodexSse(response);
    const message = {
      role: 'assistant',
      content: parsed.text || null
    };
    if (parsed.toolCalls.length > 0) message.tool_calls = parsed.toolCalls;

    const promptTokens = parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens ?? 0;
    const completionTokens = parsed.usage?.output_tokens ?? parsed.usage?.completion_tokens ?? 0;
    const totalTokens = parsed.usage?.total_tokens ?? (promptTokens + completionTokens);

    return {
      id: parsed.responseId || null,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop',
          message
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens
      }
    };
  }

  async chatStream(messages, options = {}) {
    const data = await this.chat(messages, options);
    const text = data.choices?.[0]?.message?.content || '';
    return buildSseResponseFromText(text);
  }

  async listModels() {
    try {
      const response = await fetch(this._url('/models'), {
        headers: this._headers()
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  async isConnected(options = {}) {
    const throwOnError = options.throwOnError === true;
    try {
      const response = await fetch(this._url('/models'), {
        headers: this._headers()
      });
      if (response.ok) return true;
      if (response.status === 404) return true;
      if (response.status === 401 || response.status === 403) {
        if (!throwOnError) return false;
        const text = await response.text().catch(() => '');
        const reason = (text || response.statusText || 'Request failed').slice(0, 300);
        throw new Error(`OpenAI Codex connection check failed (${response.status}): ${reason}`);
      }
      if (throwOnError) {
        const text = await response.text().catch(() => '');
        const reason = (text || response.statusText || 'Request failed').slice(0, 300);
        throw new Error(`OpenAI Codex connection check returned ${response.status}: ${reason}`);
      }
      return true;
    } catch (err) {
      if (throwOnError) throw err;
      return false;
    }
  }
}

module.exports = {
  OpenAICompatibleClient,
  AnthropicClient,
  OpenAICodexClient,
  extractText
};
