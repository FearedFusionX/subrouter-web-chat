// subrouter-web/server.js
// Zero npm dependencies — only Node built-ins + local mcp-client.js
// Run with: node server.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { MCPClient } = require('./mcp-client');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8787;

const mcpClients = new Map(); // name -> MCPClient
const pendingApprovals = new Map(); // id -> resolve(approved: boolean)
let approvalCounter = 0;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// One-shot JSON request to the router (used for models + the tool-calling loop)
function routerRequest(targetPath, method, bodyObj) {
  const cfg = loadConfig();
  const base = new URL(cfg.base_url.replace(/\/$/, '') + targetPath);
  const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: base.hostname,
      path: base.pathname + base.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + cfg.api_key,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {})
      }
    }, (upstream) => {
      let data = '';
      upstream.on('data', (c) => (data += c));
      upstream.on('end', () => {
        try { resolve({ status: upstream.statusCode, json: JSON.parse(data) }); }
        catch (e) { resolve({ status: upstream.statusCode, json: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Streamed passthrough (used when no MCP tools are active — the fast path)
function proxyToRouterStream(targetPath, method, body, res) {
  const cfg = loadConfig();
  const base = new URL(cfg.base_url.replace(/\/$/, '') + targetPath);
  const payload = body ? Buffer.from(body) : null;
  const req = https.request({
    hostname: base.hostname,
    path: base.pathname + base.search,
    method,
    headers: {
      'Authorization': 'Bearer ' + cfg.api_key,
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': payload.length } : {})
    }
  }, (upstream) => {
    res.writeHead(upstream.statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    upstream.pipe(res);
  });
  req.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy_failed', message: err.message }));
  });
  if (payload) req.write(payload);
  req.end();
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendSseText(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function mcpToolsForRequest() {
  const tools = [];
  for (const [name, client] of mcpClients) {
    if (!client.connected) continue;
    for (const t of client.tools) {
      tools.push({
        type: 'function',
        function: {
          name: `${name}__${t.name}`,
          description: t.description || '',
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      });
    }
  }
  return tools;
}

// The agentic loop: ask the model, execute any tool calls via MCP, feed results back, repeat.
// onEvent(evt) is called with progress events as they happen. If requireApproval is true,
// each tool call pauses and waits for a matching POST /api/mcp/approve before running.
async function runToolLoop(model, messages, onEvent, reasoningEffort, requireApproval) {
  const tools = mcpToolsForRequest();
  let msgs = messages.slice();
  for (let i = 0; i < 8; i++) {
    const { json } = await routerRequest('/chat/completions', 'POST', {
      model,
      messages: msgs,
      tools: tools.length ? tools : undefined,
      ...(reasoningEffort && reasoningEffort !== 'off' ? { reasoning_effort: reasoningEffort } : {})
    });
    const choice = json?.choices?.[0];
    if (!choice) throw new Error('bad response from router: ' + JSON.stringify(json).slice(0, 300));
    const message = choice.message;
    const calls = message.tool_calls || [];
    if (calls.length === 0) return message.content || '';

    msgs.push(message);
    for (const call of calls) {
      const [serverName, toolName] = call.function.name.split('__');
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}

      if (requireApproval) {
        const approvalId = 'appr_' + (++approvalCounter) + '_' + Date.now();
        const approved = await new Promise((resolve) => {
          pendingApprovals.set(approvalId, resolve);
          if (onEvent) onEvent({ type: 'tool_approval_request', id: approvalId, server: serverName, tool: toolName, args });
        });
        if (!approved) {
          const deniedText = JSON.stringify({ error: 'Tool call denied by user' });
          if (onEvent) onEvent({ type: 'tool_result', server: serverName, tool: toolName, args, result: deniedText, denied: true });
          msgs.push({ role: 'tool', tool_call_id: call.id, content: deniedText });
          continue;
        }
      }

      if (onEvent) onEvent({ type: 'tool_call', server: serverName, tool: toolName, args });
      const client = mcpClients.get(serverName);
      let resultText;
      try {
        if (!client || !client.connected) throw new Error('mcp server not connected: ' + serverName);
        const result = await client.callTool(toolName, args);
        resultText = JSON.stringify(result);
      } catch (err) {
        resultText = JSON.stringify({ error: err.message });
      }
      if (onEvent) onEvent({ type: 'tool_result', server: serverName, tool: toolName, result: resultText });
      msgs.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }
  return '(stopped after too many tool calls — something may be looping)';
}

function serveStatic(reqPath, res) {
  let filePath = path.join(PUBLIC_DIR, reqPath === '/' ? 'index.html' : reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html'
      : ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.json' ? 'application/json'
      : ext === '.svg' ? 'image/svg+xml'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/models' && req.method === 'GET') {
    routerRequest('/models', 'GET', null)
      .then(({ status, json, raw }) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(json ? JSON.stringify(json) : raw);
      })
      .catch((err) => sendJson(res, 502, { error: err.message }));
    return;
  }

  if (url.pathname === '/api/mcp/servers' && req.method === 'GET') {
    const cfg = loadConfig();
    const list = Object.entries(cfg.mcpServers || {}).map(([name, def]) => {
      const client = mcpClients.get(name);
      return {
        name,
        command: def.command,
        args: def.args || [],
        connected: !!client?.connected,
        toolCount: client?.tools?.length || 0,
        tools: client?.tools?.map((t) => t.name) || []
      };
    });
    sendJson(res, 200, { servers: list });
    return;
  }

  if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name, command, args } = JSON.parse(body);
        const cfg = loadConfig();
        cfg.mcpServers = cfg.mcpServers || {};
        cfg.mcpServers[name] = { command, args: args || [] };
        saveConfig(cfg);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/mcp/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { name } = JSON.parse(body);
        const cfg = loadConfig();
        const def = (cfg.mcpServers || {})[name];
        if (!def) throw new Error('unknown server: ' + name);
        const client = new MCPClient(name, def.command, def.args || [], def.env || {});
        await client.start();
        mcpClients.set(name, client);
        sendJson(res, 200, { ok: true, tools: client.tools.map((t) => t.name) });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/mcp/disconnect' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const client = mcpClients.get(name);
        if (client) { client.stop(); mcpClients.delete(name); }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/mcp/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { id, approved } = JSON.parse(body);
        const resolve = pendingApprovals.get(id);
        if (resolve) { resolve(!!approved); pendingApprovals.delete(id); }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { sendJson(res, 400, { error: 'bad json' }); return; }

      const hasTools = [...mcpClients.values()].some((c) => c.connected && c.tools.length);
      if (!hasTools) {
        proxyToRouterStream('/chat/completions', 'POST', body, res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const writeEvent = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      try {
        const finalText = await runToolLoop(parsed.model, parsed.messages, writeEvent, parsed.reasoning_effort, parsed.requireApproval);
        writeEvent({ choices: [{ delta: { content: finalText } }] });
      } catch (err) {
        writeEvent({ choices: [{ delta: { content: '[error: ' + err.message + ']' } }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`subrouter-web running at http://localhost:${PORT}`);
  console.log('Edit config.json to change your base_url / api_key / mcpServers.');
});
