/**
 * MCP Client for Ripley Code
 * Calls an MCP server via HTTP.
 * Used both for curated tools and the call_mcp escape hatch.
 */

const DEFAULT_MCP_URL = '';

/**
 * Parse SSE text into individual data payloads.
 * Handles multi-event streams, finds the JSON-RPC result (has `id` + `result`),
 * ignoring notifications (have `method` but no matching `id`).
 */
function parseSSE(sseText, requestId) {
  const events = [];
  for (const line of sseText.split('\n')) {
    if (line.startsWith('data: ')) {
      const payload = line.slice(6).trim();
      if (payload) events.push(payload);
    }
  }

  // Find the JSON-RPC result event (has id + result or id + error)
  for (const evt of events) {
    try {
      const parsed = JSON.parse(evt);
      // Match by id if provided, otherwise look for any result/error response
      if (requestId && parsed.id === requestId) return evt;
      if (parsed.result !== undefined || parsed.error !== undefined) return evt;
    } catch { /* skip malformed events */ }
  }

  // Fallback: return last event (original behavior)
  return events.length > 0 ? events[events.length - 1] : sseText;
}

class McpClient {
  constructor(options = {}) {
    this.url = options.url || process.env.MCP_SERVER_URL || DEFAULT_MCP_URL;
    this.sessionId = null;
    this.initialized = false;
    this.timeout = options.timeout || 30000;
    this.toolTimeout = options.toolTimeout || 60000;
    this.serverInfo = null; // Populated on initialize
  }

  /**
   * Update the server URL (e.g., from config)
   */
  setUrl(url) {
    if (url && url !== this.url) {
      this.url = url;
      this.sessionId = null;
      this.initialized = false;
      this.serverInfo = null;
    }
  }

  /**
   * Initialize MCP session (get sessionId)
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'ripley', version: '4.0.0' }
          }
        }),
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!res.ok) return false;

      const sessionId = res.headers.get('mcp-session-id') || res.headers.get('x-session-id');
      if (sessionId) this.sessionId = sessionId;

      // Parse server info from initialize response
      const contentType = res.headers.get('content-type') || '';
      let text = await res.text();
      if (contentType.includes('text/event-stream')) {
        text = parseSSE(text, 1);
      }
      try {
        const data = JSON.parse(text);
        if (data.result?.serverInfo) {
          this.serverInfo = data.result.serverInfo;
        }
      } catch { /* ignore parse errors */ }

      // MCP protocol requires sending notifications/initialized before any other requests.
      // Without this, the server keeps the session in a pending state and rejects tool calls.
      await this._sendInitializedNotification();

      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send the required notifications/initialized notification to complete the MCP handshake.
   */
  async _sendInitializedNotification() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    try {
      await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        }),
        signal: AbortSignal.timeout(this.timeout)
      });
    } catch {
      // Best-effort; some servers don't require it
    }
  }

  /**
   * List available tools from the MCP server
   */
  async listTools(canRetry = true) {
    if (!this.initialized) {
      const ok = await this.initialize();
      if (!ok) throw new Error('MCP server unreachable');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const requestId = Date.now();
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
        params: {}
      }),
      signal: AbortSignal.timeout(this.toolTimeout)
    });

    // 404 = stale/expired session. Re-initialize and retry once.
    if (res.status === 404 && canRetry) {
      this.initialized = false;
      this.sessionId = null;
      this.serverInfo = null;
      return this.listTools(false);
    }

    if (!res.ok) {
      throw new Error(`MCP error ${res.status}: ${await res.text()}`);
    }

    const contentType = res.headers.get('content-type') || '';
    let text = await res.text();
    if (contentType.includes('text/event-stream')) {
      text = parseSSE(text, requestId);
    }

    const data = JSON.parse(text);
    if (data.error) throw new Error(data.error.message || 'Failed to list tools');
    return data.result?.tools || [];
  }

  /**
   * Call any MCP tool by name with args
   */
  async callTool(toolName, args = {}) {
    return this._callToolWithRetry(toolName, args, true);
  }

  async _callToolWithRetry(toolName, args, canRetry) {
    if (!this.initialized) {
      const ok = await this.initialize();
      if (!ok) throw new Error('MCP server unreachable');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const requestId = Date.now();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.toolTimeout)
    });

    // 404 = stale/expired session. Re-initialize and retry once.
    if (res.status === 404 && canRetry) {
      this.initialized = false;
      this.sessionId = null;
      this.serverInfo = null;
      return this._callToolWithRetry(toolName, args, false);
    }

    if (!res.ok) {
      throw new Error(`MCP error ${res.status}: ${await res.text()}`);
    }

    // Handle SSE or JSON response
    const contentType = res.headers.get('content-type') || '';
    let text = await res.text();

    if (contentType.includes('text/event-stream')) {
      text = parseSSE(text, requestId);
    }

    try {
      const data = JSON.parse(text);
      if (data.error) throw new Error(data.error.message || 'MCP tool error');
      const result = data.result;
      // Extract text content from MCP content array
      if (result?.content) {
        return result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
      }
      return JSON.stringify(result);
    } catch (e) {
      if (e.message.includes('MCP')) throw e;
      return text;
    }
  }

  /**
   * Health check - try initialize, which validates the full MCP handshake
   */
  async isConnected() {
    try {
      if (this.initialized) return true;
      return await this.initialize();
    } catch {
      return false;
    }
  }

  /**
   * Get connection status info
   */
  getStatus() {
    return {
      url: this.url,
      connected: this.initialized,
      sessionId: this.sessionId,
      serverName: this.serverInfo?.name || null,
      serverVersion: this.serverInfo?.version || null
    };
  }
}

module.exports = McpClient;
