# subrouter-web

A local chat app that talks to a personal subrouter (OpenAI/Anthropic-compatible API proxy). Node.js server with zero npm dependencies for the backend, vanilla JS/HTML frontend, plus a minimal MCP client for tool calling.

## Structure
- `server.js` — the whole backend (proxying, streaming, MCP tool loop, approvals)
- `mcp-client.js` — minimal stdio JSON-RPC MCP client
- `config.json` — **contains a real API key, must never be committed**
- `config.example.json` — safe placeholder version of config.json, this one *should* be committed
- `public/` — frontend (index.html, manifest.json, icon.svg, sw.js)

## Task: push this to GitHub

1. Check if this folder is already a git repo (`git status`). If not, `git init`.
2. Create/update `.gitignore` in the project root to include at minimum:
   ```
   config.json
   node_modules/
   ```
   Do not gitignore `config.example.json` — that one is meant to be public.
3. Stage and commit everything: `git add .` then `git commit -m "initial commit"`.
4. Create the GitHub repo and push:
   - If the `gh` CLI is installed and authenticated (`gh auth status`), the simplest path is:
     `gh repo create subrouter-web --private --source=. --remote=origin --push`
   - If `gh` isn't available, ask me (the user) for a repo URL first — don't guess one or create a repo through any other means. Once I give you the URL: `git remote add origin <url>`, `git branch -M main`, `git push -u origin main`.
5. After pushing, tell me the repo URL and confirm `config.json` (the one with my real key) is NOT visible in the pushed repo — double check by looking at the file list on GitHub or via `git ls-files` locally before/after.

## Notes
- Never print or commit the contents of `config.json`.
- The repo can be private or public — private is the safer default unless I say otherwise.
