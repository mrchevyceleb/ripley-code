/**
 * MCP Client for Ripley Code
 * Calls the assistant-mcp server on Railway directly via HTTP.
 * Used both for curated tools and the call_mcp escape hatch.
 */

const MCP_URL = process.env.MCP_SERVER_URL || 'https://matt-assistant-production.up.railway.app/mcp';

class McpClient {
  constructor(options = {}) {
    this.url = options.url || MCP_URL;
    this.sessionId = null;
    this.initialized = false;
    this.timeout = options.timeout || 30000;
  }

  /**
   * Initialize MCP session (get sessionId)
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      const sessionId = res.headers.get('mcp-session-id') || res.headers.get('x-session-id');
      if (sessionId) this.sessionId = sessionId;

      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Call any MCP tool by name with args
   */
  async callTool(toolName, args = {}) {
    if (!this.initialized) {
      const ok = await this.initialize();
      if (!ok) throw new Error('MCP server unreachable');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!res.ok) {
      throw new Error(`MCP error ${res.status}: ${await res.text()}`);
    }

    // Handle SSE or JSON response
    const contentType = res.headers.get('content-type') || '';
    let text = await res.text();

    if (contentType.includes('text/event-stream')) {
      // Parse SSE - extract last result event
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('data: ')) {
          text = lines[i].slice(6);
          break;
        }
      }
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
   * Health check
   */
  async isConnected() {
    try {
      const healthUrl = this.url.replace(/\/mcp$/, '/health');
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

module.exports = McpClient;
