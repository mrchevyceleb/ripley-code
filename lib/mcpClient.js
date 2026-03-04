/**
 * MCP Client for Ripley Code
 * Calls the assistant-mcp server on Railway directly via HTTP.
 * Used both for curated tools and the call_mcp escape hatch.
 */

const DEFAULT_MCP_URL = 'https://matt-assistant-production.up.railway.app/mcp';

class McpClient {
  constructor(options = {}) {
    this.url = options.url || process.env.MCP_SERVER_URL || DEFAULT_MCP_URL;
    this.sessionId = null;
    this.initialized = false;
    this.timeout = options.timeout || 30000;
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

      const sessionId = res.headers.get('mcp-session-id') || res.headers.get('x-session-id');
      if (sessionId) this.sessionId = sessionId;

      // Parse server info from initialize response
      const contentType = res.headers.get('content-type') || '';
      let text = await res.text();
      if (contentType.includes('text/event-stream')) {
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
        if (data.result?.serverInfo) {
          this.serverInfo = data.result.serverInfo;
        }
      } catch { /* ignore parse errors */ }

      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List available tools from the MCP server
   */
  async listTools() {
    if (!this.initialized) {
      const ok = await this.initialize();
      if (!ok) throw new Error('MCP server unreachable');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list',
        params: {}
      }),
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!res.ok) {
      throw new Error(`MCP error ${res.status}: ${await res.text()}`);
    }

    const contentType = res.headers.get('content-type') || '';
    let text = await res.text();
    if (contentType.includes('text/event-stream')) {
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('data: ')) {
          text = lines[i].slice(6);
          break;
        }
      }
    }

    const data = JSON.parse(text);
    if (data.error) throw new Error(data.error.message || 'Failed to list tools');
    return data.result?.tools || [];
  }

  /**
   * Call any MCP tool by name with args
   */
  async callTool(toolName, args = {}) {
    if (!this.initialized) {
      const ok = await this.initialize();
      if (!ok) throw new Error('MCP server unreachable');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
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
