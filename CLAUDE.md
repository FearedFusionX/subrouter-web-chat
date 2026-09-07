# subrouter-web

A local chat app that talks to a personal subrouter (OpenAI-compatible API proxy). Node.js backend with zero npm dependencies, vanilla JS/HTML frontend in a single file, plus a minimal MCP client for tool calling.

## Structure

- `server.js` — the whole backend: static files, proxying, SSE streaming, the MCP tool loop, approvals
- `mcp-client.js` — minimal stdio JSON-RPC MCP client
- `config.json` — **contains a real API key; gitignored, must never be committed**
- `config.example.json` — safe placeholder version of config.json; this one *should* be committed
- `public/index.html` — the entire frontend (markup, styles, and script in one file)
- `public/sw.js`, `public/manifest.json`, `public/icon.svg` — PWA plumbing

## Running

```bash
node server.js          # http://localhost:8787
PORT=9000 node server.js
```

Requires Node 18+. No install step, no build step, no `package.json`.

## Constraints

- **Never print, log, or commit the contents of `config.json`** — it holds a real credential. Keep it in `.gitignore`.
- **Zero npm dependencies** on the backend is intentional. Don't add a `package.json` or pull in packages to solve something the standard library can handle.
- The frontend stays a single `public/index.html` — no bundler, no framework, no build step.
- The server must keep binding to `127.0.0.1` only.
- The server never logs message content.
