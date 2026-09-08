# subrouter-web

A local chat client for a personal **subrouter**.

A *subrouter* here means any OpenAI-compatible API proxy — a service that speaks the standard `/v1/chat/completions` and `/v1/models` API and forwards your requests to one or more model providers under a single key. If you have a `base_url` and an `sk-...` token that work with the OpenAI client libraries, this app can talk to it.

You run one small Node server on your own machine and open a browser tab (or install it as an app). Conversations stay in your browser, your API key stays in a file on your disk, and the only thing that leaves your machine is the messages themselves, sent to the router you configured. It can also give the model real tools — file access, web search, a browser — via [MCP](#mcp-tools-giving-the-model-hands).

The backend is a single Node file with **zero npm dependencies**: no `package.json`, no `npm install`, no build step. The entire frontend is one HTML file.

---

## Quick start

You need **Node.js 18 or newer** (`node --version`) and nothing else.

```bash
git clone https://github.com/FearedFusionX/subrouter-web-chat.git
cd subrouter-web-chat
cp config.example.json config.json      # then edit it: your base_url and api_key
node server.js
```

Open <http://localhost:8787> and pick a model from the dropdown at the bottom right.

Stop the server with `Ctrl+C`. To start it again later, `node server.js` from the project folder is the whole ritual — there is nothing to install, build or update. See [Setup](#setup) for the details.

---

## How it fits together

```
┌──────────────────────┐            ┌───────────────────────┐   HTTPS   ┌─────────────────────┐
│ Browser              │ HTTP + SSE │ server.js             │ ────────► │ Your subrouter      │
│ public/index.html    │ ◄────────► │ 127.0.0.1:8787        │           │ (base_url — any     │
│ chats & settings in  │            │ key in config.json    │           │ OpenAI-compatible   │
│ localStorage         │            │ runs the tool loop    │           │ API)                │
└──────────────────────┘            └──────────┬────────────┘           └─────────────────────┘
                                               │ stdio (JSON-RPC)
                                               ▼
                                    MCP servers — local child processes
                                    (filesystem, web search, GitHub, …)
```

Why is there a local server at all, instead of the page calling the API directly?

1. **The key never enters the browser.** It lives in `config.json` next to `server.js`; the server adds the `Authorization` header on the way out. The UI only ever sees a masked version (`sk-sub-…abcd`).
2. **Tools need a process.** MCP servers are local programs the model can call — a web page can't spawn processes, but the local server can.
3. **No CORS headaches.** The browser only ever talks to `localhost`.

### What happens when you send a message

- **No MCP tools connected** — the server pipes your request byte-for-byte to `<base_url>/chat/completions` and streams the response straight back. You get true token-by-token streaming.
- **MCP tools connected** — the server takes over and runs an agentic loop: it sends your conversation to the router along with the tool catalog; if the model replies with tool calls, each one is (by default) held for your approval, executed against the matching MCP server, and its result appended to the conversation; then the model is asked again. This repeats until the model answers in plain text, up to 8 rounds (then it stops with a "too many tool calls" notice).

  One practical consequence: **with tools connected, the reply arrives all at once** at the end of the loop instead of streaming word by word. That's expected, not a bug. Tool calls themselves stream into the chat live as expandable cards.

---

## Setup

**1. You need Node.js 18 or newer.** Check with `node --version`; if that fails or prints something older, install it from [nodejs.org](https://nodejs.org). There is nothing to install beyond that — no `npm install`, because there are no dependencies.

**2. Get the code.**

```bash
git clone https://github.com/FearedFusionX/subrouter-web-chat.git
cd subrouter-web-chat
```

Downloading the ZIP from GitHub and unpacking it works just as well; nothing here needs git at runtime.

**3. Create `config.json`** in the project root by copying the example:

```bash
cp config.example.json config.json
```

(In PowerShell, `cp` is an alias for `Copy-Item`, so the same line works.)

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
| `base_url` | Your proxy's OpenAI-compatible endpoint. Include the `/v1`. Must be `https://` — plain `http://` endpoints are not supported. |
| `api_key` | Your token. Stays on this machine — see [Where your data lives](#where-your-data-lives). |
| `mcpServers` | Optional. Tool servers to make available; easier to add from the UI, see [MCP tools](#mcp-tools-giving-the-model-hands). |

The example file ships with a sample `filesystem` MCP server pointing at a placeholder path — either fix that path or cut `mcpServers` down to `{}`, as above, and add servers later from the UI.

`config.json` is gitignored and must stay that way — it holds a real credential. `config.example.json` is the safe placeholder that *is* committed. The server re-reads the file on every request, so hand-edits take effect without a restart.

**4. Start it:**

```bash
node server.js
```

It prints the URL and stays in the foreground; `Ctrl+C` stops it. Starting it again is the same command — there is no build, no install and nothing to update.

Then open <http://localhost:8787>. `PORT` is the only environment variable:

```bash
PORT=9000 node server.js          # macOS / Linux / Git Bash
```

```powershell
$env:PORT = 9000; node server.js  # PowerShell
```

The server binds to `127.0.0.1` only, so it is not reachable from other machines on your network.

**5. Pick a model** from the dropdown at the bottom right. If the list is empty, open **Settings → API → Test connection** — it will tell you whether the endpoint and token are working.

### Install it as an app

There is a web manifest and a service worker, so any Chromium browser will offer to install it — look for the install icon in the address bar. It then opens in its own window, and the app shell loads even when the server is briefly down (API calls still need the server, of course).

---

## Using it

### Composing while a reply is streaming

You don't have to wait for the model to finish. As soon as a reply starts, buttons appear above the composer:

| Action | What happens |
|---|---|
| **Add to prompt** (`Enter`) | Your text joins the current exchange. It goes out the moment the reply lands, marked as a follow-on thought ("By the way: …") rather than a new question. Several additions merge into one. |
| **Queue as follow-up** | Same timing, but sent as its own separate message. This is the one that can carry attachments — and messages with attachments queue automatically. |
| **Interrupt** (`Esc`) | Stops the reply and keeps whatever already streamed. |

Anything waiting shows in a strip above the composer, where you can drop individual items or clear the lot. While something is queued you also get **Interrupt & send**, which cuts the current reply short and sends immediately — the truncated reply stays in history as-is, and your queued message goes out against it.

`Esc` interrupts whether or not the composer is focused.

### Attachments

Drag files onto the window or use **+**. Images are sent to the model as images; anything else is read as text and inlined into your message as a fenced code block (so binary files other than images won't be useful). Whether image input works at all depends on the model you picked.

### Conversations

Double-click a conversation in the sidebar to rename it. New chats title themselves after the first reply — the model is asked for a short title in a tiny extra request. Renaming a chat yourself turns auto-titling off for that chat, permanently.

The list groups by age (Today, Yesterday, Previous 7 days…) and shows a relative time on each entry. Both can be turned off in **Settings → Appearance**.

`Ctrl+B` collapses the sidebar. `Enter` sends and `Shift+Enter` inserts a newline; flip "Enter sends" off in Settings to swap that for `Ctrl+Enter` sends.

### Memory and Skills

**Settings → General → Memory** is text injected as a system prompt on every message in every chat. Good for standing instructions: *"Keep answers short. I'm on Windows and PowerShell."*

**Settings → Skills** are the same idea, but individually toggleable — named snippets you switch on and off. Enabled skills are appended to the system prompt alongside Memory. Use them for instructions you want sometimes but not always.

### Thinking effort

Next to the model picker is a thinking-level dropdown (off → minimal → low → … → ultra). It is sent to the router as `reasoning_effort`; whether it does anything depends on the model and router. Model and effort are remembered per conversation.

---

## MCP tools — giving the model hands

**MCP (Model Context Protocol)** is an open standard for connecting AI models to tools. An *MCP server* is just a small local program — this app launches it as a child process and talks to it over stdin/stdout. Each server announces a list of tools ("read_file", "search_web", …) with typed parameters; those get advertised to the model, and when the model decides to use one, the app executes it and feeds the result back.

**Settings → MCP** is where you manage them. Presets are built in for Filesystem, Memory, Brave Search, GitHub, SQLite and Puppeteer (browser control) — picking one just prefills the command; edit the arguments (the filesystem preset ships with a placeholder path you must change), then add and **connect**. The `npx`-based presets need Node on your `PATH` and download the server package on first run. Server definitions persist in `config.json`, but connections live in memory — after restarting `server.js`, reconnect from the UI.

Connected servers expose their tools to the model, and calls appear in the chat as expandable cards showing arguments and results.

> **Connecting a server gives the model real access to whatever that server exposes** — the filesystem preset means real reads and writes to the path you point it at. Know what a server does before connecting it.
>
> By default every tool call pauses and asks you first: **Deny / Allow / Always (this chat) / Always (all chats)**. Denying isn't fatal — the model is told the call was refused and can carry on without it. **Clear all "always allow" rules** on the same page revokes every standing approval, and the master toggle turns approval prompts off entirely if you'd rather live dangerously.

Two limits worth knowing: an individual tool call times out after 30 seconds, and a single reply can use at most 8 tool-calling rounds before the loop stops itself.

---

## Appearance

**Settings → Appearance** goes deep:

- **Themes** — 17 built-in palettes plus a **Custom** slot you author yourself across eight colour roles; light or dark mode is inferred from the background you choose, and *Copy current theme* seeds it from whatever is active.
- **Accent spread** — how far the accent colour bleeds past buttons into panels, borders and muted text, with an optional harmonize toggle that derives the secondary and code colours from it. Five accent-tinted background gradients, too (plus off).
- **Fonts** — separate interface, heading and code faces with an independent code size. Web fonts are fetched from Google Fonts on demand; offline, each falls back to a local face.
- **Motion** — a master animation toggle and a speed. With animations off, the thinking dots and tool spinner keep moving so you can still tell when something is running. First run follows your OS reduced-motion setting.
- **Layout** — message width, corner radius, sidebar width, text size, bubbles vs left-aligned, compact spacing, avatars.

Appearance changes preview live but generally only persist when you hit **Save**.

---

## Where your data lives

| What | Where | Leaves your machine? |
|---|---|---|
| API key, base URL, MCP server list | `config.json` on disk | Only to your own router |
| Conversations, settings, avatars | Browser `localStorage` | No |
| Message content | Sent to `base_url` | Yes — that is the point |

Conversations live in the browser profile you use, per origin. A different browser — or clearing site data — means a different history. **Settings → Data → Export** writes conversations, settings and avatars to one JSON file and is the only backup; Import overwrites what's in the browser, so export first if you care about what's there.

The server never logs message content, and the API key is never sent to the browser or printed anywhere.

---

## Project layout

| File | What it does |
|---|---|
| `server.js` | The whole backend: static files, proxying, SSE streaming, the MCP tool loop, approvals |
| `mcp-client.js` | Minimal stdio JSON-RPC MCP client (initialize / tools list / tools call) |
| `config.json` | Your real credentials — **gitignored, never commit** |
| `config.example.json` | The safe placeholder |
| `public/index.html` | The entire frontend — markup, styles and script in one file |
| `public/sw.js`, `manifest.json`, `icon.svg` | PWA plumbing |

### HTTP API

Everything the frontend does goes through these routes on `localhost` — no auth, which is why the server refuses to listen beyond `127.0.0.1`.

| Route | Purpose |
|---|---|
| `GET /api/models` | Model list from the router |
| `GET/POST /api/config` | Read/update base URL and token (the key is only ever returned masked) |
| `POST /api/chat` | Chat completion; streams SSE, runs the MCP tool loop when tools are connected |
| `GET/POST /api/mcp/servers` | List and add tool-server definitions |
| `POST /api/mcp/connect` · `/disconnect` | Spawn or kill a tool server |
| `POST /api/mcp/approve` | Answer a pending tool-call approval |

---

## Troubleshooting

**Model list is empty.** Settings → API → Test connection. It reports the actual HTTP error, which is usually a wrong `base_url` (missing `/v1`, or `http://` instead of `https://`) or a bad token.

**`EADDRINUSE` on start.** Port 8787 is already taken, often by an instance you already have running. Use that one, or start on another port — `PORT=9000 node server.js`, or `$env:PORT = 9000; node server.js` in PowerShell.

**An MCP server won't connect.** Its command has to be runnable from this machine — the `npx` presets need Node on your `PATH` and download the package on first run, so the first connect can be slow. MCP servers' own error output is not shown anywhere, so if a server keeps failing, try running its command by hand in a terminal to see what it prints.

**Replies stopped streaming word-by-word.** You have an MCP server connected — with tools in play the answer arrives in one piece after the tool loop finishes. Disconnect the servers to get token streaming back.

**A reply hangs forever on a tool call.** There's probably an approval prompt waiting in the chat — the loop blocks until you answer it.

**Settings didn't stick.** Appearance changes preview live but only persist on **Save**.

**Fonts look wrong offline.** Web fonts come from Google Fonts on demand. With no connection you get the local fallback, which is expected.

**The UI looks stale after pulling an update.** The service worker caches the app shell; it refreshes when `public/sw.js`'s cache version changes. A hard reload (or unregistering the service worker in devtools) forces it.
