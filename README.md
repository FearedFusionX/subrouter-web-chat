# subrouter-web

A local chat client for a personal subrouter — any OpenAI-compatible API proxy. It runs on your own machine, keeps your conversations in your own browser, and talks to real MCP tool servers.

The backend is a single Node file with **zero npm dependencies**. There is no build step and no `package.json` to install.

---

## Setup

**1. You need Node.js 18 or newer.** Check with `node --version`.

**2. Create `config.json`** in the project root by copying the example:

```bash
cp config.example.json config.json
```

Then edit it:

```json
{
  "base_url": "https://router.example.com/v1",
  "api_key": "sk-sub-your-real-key-here",
  "mcpServers": {}
}
```

| Field | What it is |
|---|---|
| `base_url` | Your proxy's OpenAI-compatible endpoint. Include the `/v1`. |
| `api_key`  | Your token. Stays on this machine — see [Where your data lives](#where-your-data-lives). |
| `mcpServers` | Optional. Tool servers to make available; you can also add these from the UI. |

`config.json` is gitignored and must stay that way — it holds a real credential. `config.example.json` is the safe placeholder that *is* committed.

**3. Run it:**

```bash
node server.js
```

Then open <http://localhost:8787>. Set `PORT` to use a different port:

```bash
PORT=9000 node server.js
```

The server binds to `127.0.0.1` only, so it is not reachable from other machines on your network.

**4. Pick a model** from the dropdown at the bottom right. If the list is empty, open **Settings → API → Test connection** — it will tell you whether the endpoint and token are working.

### Install it as an app

There is a web manifest and a service worker, so any Chromium browser will offer to install it. Look for the install icon in the address bar. It then opens in its own window and keeps working across restarts.

---

## Using it

### Composing while a reply is streaming

Three things you can do without waiting for the model to finish. The buttons appear above the composer as soon as a reply starts.

| Action | What happens |
|---|---|
| **Add to prompt** (`Enter`) | Your text joins the current exchange. It goes out the moment the reply lands, marked as an addition so the model reads it as a follow-on thought rather than a new question. Several additions merge into one. |
| **Queue as follow-up** | Same timing, but sent as its own separate message. This is the one that can carry attachments. |
| **Interrupt** (`Esc`) | Stops the reply and keeps whatever already streamed. |

Anything waiting shows in a strip above the composer, where you can drop individual items or clear the lot. While something is queued you also get **Interrupt & send**, which cuts the current reply short and sends immediately.

`Esc` interrupts whether or not the composer is focused.

### Attachments

Drag files onto the window, paste an image, or use **+**. Images go to the model as images; text files are inlined into your message. Whether attachments work at all depends on the model you picked.

### Conversations

Double-click a conversation in the sidebar to rename it. New chats get named automatically after the first reply — the model is asked for a short title. Renaming one yourself turns that off for that chat, permanently.

The list groups by age (Today, Yesterday, Previous 7 days…) and shows a relative time on each entry. Both can be turned off in **Settings → Appearance → Conversations**.

`Ctrl+B` collapses the sidebar.

### Memory and Skills

**Settings → General → Memory** is text injected as a system prompt on every message in every chat. Good for standing instructions: *"Keep answers short. I'm on Windows and PowerShell."*

**Settings → Skills** are the same idea, but individually toggleable. Enabled skills are appended to the system prompt alongside Memory. Use them for instructions you want sometimes but not always.

### MCP tools

**Settings → MCP** connects to Model Context Protocol servers over stdio. Presets for filesystem, memory, search, GitHub, SQLite and Puppeteer are built in; anything else you can add by command and arguments.

Connected servers expose their tools to the model, and calls stream into the chat as expandable cards showing arguments and results.

> **Connecting a server gives the model real access to whatever that server exposes** — the filesystem preset means real reads and writes to the path you point it at. Know what a server does before connecting it.
>
> Approval is required before every tool call by default. You can approve once, for the chat, or always. **Clear all "always allow" rules** in the same page revokes every standing approval.

### Appearance

**Settings → Appearance** covers:

- **Themes** — 17 palettes, plus a **Custom** slot you author yourself across eight colour roles. Light or dark mode is inferred from the background you choose. *Copy current theme* seeds it from whatever is active.
- **Accent spread** — how far the accent bleeds past buttons into panels, borders and muted text. Optionally derives the secondary and code colours from it too.
- **Fonts** — separate interface, heading and code faces, with an independent code size. Web fonts are fetched on demand; offline, each falls back to a local face.
- **Motion** — a master animation toggle and a speed. With animations off, the thinking dots and tool spinner keep moving so you can still tell when something is running. First run follows your OS reduced-motion setting.
- **Layout** — message width, corner radius, sidebar width, text size, bubbles vs left-aligned, compact spacing, avatars.

### Backup

**Settings → Data → Export** writes your conversations, settings and avatars to one JSON file. Import overwrites what is in the browser, so export first if you care about what is there.

---

## Where your data lives

| What | Where | Leaves your machine? |
|---|---|---|
| API key, base URL, MCP server list | `config.json` on disk | Only to your own proxy |
| Conversations, settings, avatars | Browser `localStorage` | No |
| Message content | Sent to `base_url` | Yes — that is the point |

Conversations live in the browser profile you use, per origin. A different browser, or a cleared site data, means a different history — **Export** is the only backup.

The server never logs message content.

---

## Project layout

| File | What it does |
|---|---|
| `server.js` | The whole backend: static files, proxying, SSE streaming, the MCP tool loop, approvals |
| `mcp-client.js` | Minimal stdio JSON-RPC MCP client |
| `config.json` | Your real credentials — **gitignored, never commit** |
| `config.example.json` | The safe placeholder |
| `public/index.html` | The entire frontend — markup, styles and script in one file |
| `public/sw.js`, `manifest.json`, `icon.svg` | PWA plumbing |

### HTTP API

| Route | Purpose |
|---|---|
| `GET /api/models` | Model list from the proxy |
| `GET/POST /api/config` | Read/update base URL and token (the key is returned masked) |
| `POST /api/chat` | Chat completion; streams SSE, runs the MCP tool loop |
| `GET/POST /api/mcp/servers` | List and add tool servers |
| `POST /api/mcp/connect` · `/disconnect` | Server lifecycle |
| `POST /api/mcp/approve` | Answer a pending tool-call approval |

---

## Troubleshooting

**Model list is empty.** Settings → API → Test connection. It reports the actual HTTP error, which is usually a wrong `base_url` (missing `/v1`) or a bad token.

**`EADDRINUSE` on start.** Port 8787 is already taken, often by an instance you already have running. Use it, or start on another port with `PORT=9000 node server.js`.

**An MCP server won't connect.** Its command has to be runnable from this machine — the `npx` presets need Node on your `PATH` and will download the package on first run. Check the terminal running `server.js` for the server's own stderr.

**Settings didn't stick.** Appearance changes preview live but only persist on **Save**. Closing without saving keeps the preview until you reload.

**Fonts look wrong offline.** Web fonts come from Google Fonts on demand. With no connection you get the local fallback, which is expected.
