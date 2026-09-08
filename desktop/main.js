// subrouter-desktop/main.js
// Electron shell around the existing zero-dependency server.js.
//
// What it does, in order:
//   1. takes the single-instance lock
//   2. makes sure a config.json exists in userData (never touches the repo one)
//   3. picks a port — the same one every launch, so localStorage keeps working
//   4. starts server.js in a utilityProcess (Electron's bundled Node, no system Node needed)
//   5. waits for /api/health to answer with *our* instance id before showing a window
//   6. on quit, asks the backend to stop, then force-kills the process tree

const { app, BrowserWindow, dialog, session, shell, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;          // not 8787, so a hand-run `node server.js` can coexist
const PORT_SCAN_LIMIT = 40;
const HEALTH_TIMEOUT_MS = 20000;
const INSTANCE_ID = crypto.randomUUID();

// Written on first run only. Deliberately inert: no key, no MCP servers.
// The repo's own config.json is never read, copied or referenced.
const INITIAL_CONFIG = {
  base_url: 'https://router.eva.pink/v1',
  api_key: '',
  mcpServers: {}
};

const isPackaged = app.isPackaged;
const backendRoot = isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(__dirname, '..');
const serverEntry = path.join(backendRoot, 'server.js');

let backend = null;
let backendPid = null;
let mainWindow = null;
let appOrigin = null;
let quitting = false;

// --- paths -----------------------------------------------------------------

function configPath() {
  const override = process.env.SUBROUTER_CONFIG_PATH;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(app.getPath('userData'), 'config.json');
}

function statePath() {
  return path.join(app.getPath('userData'), 'desktop-state.json');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
  catch (e) { return {}; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (e) { /* a stale port is not worth crashing over */ }
}

function ensureConfig() {
  const target = configPath();
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(INITIAL_CONFIG, null, 2));
  return target;
}

// --- port ------------------------------------------------------------------

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

// Same port every time when we can get it — the frontend keeps its chats in
// localStorage, which is keyed by origin, so a moving port would look like
// history loss. Only a genuine conflict shifts us, and the new port is
// remembered from then on.
async function resolvePort() {
  const forced = Number(process.env.SUBROUTER_DESKTOP_PORT);
  if (Number.isInteger(forced) && forced > 0 && forced < 65536) return forced;

  const state = readState();
  const preferred = Number.isInteger(state.port) ? state.port : DEFAULT_PORT;

  const candidates = [preferred];
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SCAN_LIMIT; p++) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const port of candidates) {
    if (await portIsFree(port)) {
      if (state.port !== port) writeState({ ...state, port });
      return port;
    }
  }
  throw new Error(
    `No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_SCAN_LIMIT - 1}.`
  );
}

// --- backend ---------------------------------------------------------------

function startBackend(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    SUBROUTER_CONFIG_PATH: configPath(),
    SUBROUTER_INSTANCE_ID: INSTANCE_ID,
    // utilityProcess sets this; server.js is a plain Node script either way.
    NODE_ENV: process.env.NODE_ENV || 'production'
  };

  backend = utilityProcess.fork(serverEntry, [], {
    cwd: backendRoot,
    env,
    stdio: 'pipe',
    serviceName: 'subrouter-backend'
  });
  backendPid = backend.pid || null;

  const log = (stream, buf) => {
    const text = String(buf).trimEnd();
    if (text) console.log(`[backend:${stream}] ${text}`);
  };
  backend.stdout?.on('data', (b) => log('out', b));
  backend.stderr?.on('data', (b) => log('err', b));

  backend.on('spawn', () => { backendPid = backend.pid || backendPid; });
  backend.on('exit', (code) => {
    backend = null;
    if (quitting) return;
    dialog.showErrorBox(
      'Subrouter backend stopped',
      `The local server exited (code ${code}). The app will close.`
    );
    app.exit(1);
  });
}

function healthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path: '/api/health', timeout: 1500 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 4096) body += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json && json.app === 'subrouter-web' && json.instance === INSTANCE_ID);
          } catch (e) { resolve(false); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Only ever proceeds against a server that echoes our own instance id, so we
// can never end up driving somebody else's process that happens to hold the port.
async function waitForBackend(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!backend) throw new Error('The local server exited during startup.');
    if (await healthOnce(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The local server did not answer on ${HOST}:${port} within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

// server.js kills its MCP children on the 'shutdown' message; the tree kill is
// the belt-and-braces pass for anything a shell-spawned MCP server left behind.
function stopBackend(done) {
  const child = backend;
  const pid = backendPid;
  if (!child && !pid) { done(); return; }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (pid && process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        }).unref();
      } catch (e) { /* already gone */ }
    }
    done();
  };

  if (child) {
    child.once('exit', () => setTimeout(finish, 50));
    try { child.postMessage('shutdown'); } catch (e) { /* fall through to kill */ }
    setTimeout(() => { try { child.kill(); } catch (e) {} }, 1200);
    setTimeout(finish, 2000);
  } else {
    finish();
  }
}

// --- window & security -----------------------------------------------------

function isAppUrl(target) {
  if (!appOrigin) return false;
  try { return new URL(target).origin === appOrigin; }
  catch (e) { return false; }
}

function openExternally(target) {
  let parsed;
  try { parsed = new URL(target); } catch (e) { return; }
  if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
    shell.openExternal(parsed.href);
  }
}

function hardenContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 480,
    minHeight: 480,
    backgroundColor: '#141312',
    autoHideMenuBar: true,
    show: false,
    title: 'Subrouter',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(appOrigin + '/');
}

function fatal(message) {
  dialog.showErrorBox('Subrouter could not start', message);
  app.exit(1);
}

// --- lifecycle -------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => hardenContents(contents));

  app.whenReady().then(async () => {
    // The renderer is a local page; it needs no device permissions at all.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === 'clipboard-sanitized-write'
    );

    try {
      ensureConfig();
      const port = await resolvePort();
      appOrigin = `http://${HOST}:${port}`;
      startBackend(port);
      await waitForBackend(port);
      createWindow();
    } catch (err) {
      fatal(err && err.message ? err.message : String(err));
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (!backend && !backendPid) return;
    event.preventDefault();
    stopBackend(() => app.exit(0));
  });
}
