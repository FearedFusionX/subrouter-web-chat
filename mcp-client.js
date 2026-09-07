// subrouter-web/mcp-client.js
// Minimal MCP client over stdio (JSON-RPC 2.0), no external dependencies.
// Only implements what's needed for tool listing + calling.

const { spawn } = require('child_process');

class MCPClient {
  constructor(name, command, args = [], env = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.connected = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.command, this.args, {
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32'
        });
      } catch (err) {
        reject(err);
        return;
      }

      this.proc.stdout.on('data', (chunk) => this._onData(chunk));
      this.proc.stderr.on('data', () => {}); // MCP servers often log to stderr — ignored here
      this.proc.on('error', reject);
      this.proc.on('exit', () => { this.connected = false; });

      this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'subrouter-web', version: '1.0.0' }
      })
        .then(() => {
          this._notify('notifications/initialized', {});
          return this._request('tools/list', {});
        })
        .then((result) => {
          this.tools = result.tools || [];
          this.connected = true;
          resolve(this.tools);
        })
        .catch(reject);
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'mcp error'));
        else resolve(msg.result);
      }
      // notifications from the server are ignored in this minimal client
    }
  }

  _request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('mcp request timed out: ' + method));
        }
      }, 30000);
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args) {
    return this._request('tools/call', { name, arguments: args || {} });
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch (e) {} }
    this.connected = false;
  }
}

module.exports = { MCPClient };
