/**
 * Benzin 2 - desktop shell.
 *
 * One window, one origin. The bundled API runs as a child process on loopback and the SPA is
 * served by a tiny static server that proxies /v1 and /healthz to it, so the browser code keeps
 * using relative URLs exactly as it does behind Caddy in production.
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const API_PORT = 41721;
const WEB_PORT = 41720;
const API_HOST = '127.0.0.1';

const runtimeDir = app.isPackaged
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(__dirname, 'runtime');
const webDir = path.join(runtimeDir, 'web');
const apiEntry = path.join(runtimeDir, 'api.mjs');

let apiProcess = null;
let webServer = null;
let mainWindow = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function log(...args) {
  process.stdout.write(`[shell] ${args.join(' ')}\n`);
}

function waitForPort(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: API_HOST });
      socket.setTimeout(1200);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 250);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

function startApi() {
  if (!fs.existsSync(apiEntry)) {
    throw new Error(`API bundle missing: ${apiEntry}`);
  }
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'development',
      API_PORT: String(API_PORT),
      API_HOST,
      LOG_LEVEL: 'warn',
      CORS_ORIGINS: `http://${API_HOST}:${WEB_PORT},http://localhost:${WEB_PORT}`,
      SMS_PROVIDERS: 'console',
      PAYMENT_GATEWAY: 'sandbox',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiProcess.stdout.on('data', (chunk) => process.stdout.write(`[api] ${chunk}`));
  apiProcess.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));
  apiProcess.on('exit', (code) => log(`api exited with ${code}`));
}

function proxyTo(targetPort) {
  return (req, res) => {
    const upstream = http.request(
      {
        host: API_HOST,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${API_HOST}:${targetPort}` },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'UPSTREAM', message: 'API is not reachable' }));
    });
    req.pipe(upstream);
  };
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const candidate = path.join(webDir, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  const insideWeb = candidate.startsWith(webDir);
  let filePath = insideWeb && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(webDir, 'index.html');
  if (!fs.existsSync(filePath)) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>web bundle missing</h1>');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(res);
}

function startWebServer() {
  const proxyV1 = proxyTo(API_PORT);
  webServer = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p.startsWith('/v1/') || p === '/healthz' || p === '/health') return proxyV1(req, res);
    return serveStatic(req, res);
  });

  webServer.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(API_PORT, API_HOST, () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => webServer.listen(WEB_PORT, API_HOST, resolve));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 380,
    minHeight: 640,
    backgroundColor: '#0f172a',
    title: 'بنزین ۲',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log(`load failed ${code} ${desc}`);
    setTimeout(() => mainWindow && mainWindow.loadURL(`http://${API_HOST}:${WEB_PORT}/`), 800);
  });
  mainWindow.loadURL(`http://${API_HOST}:${WEB_PORT}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.disableHardwareAcceleration && process.env.BENZIN_SAFE_GPU === '1' && app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    startApi();
    await waitForPort(API_PORT);
    await startWebServer();
    createWindow();
  } catch (error) {
    dialog.showErrorBox('بنزین ۲ اجرا نشد', String(error && error.message ? error.message : error));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (webServer) {
    try {
      webServer.close();
    } catch {
      /* ignore */
    }
  }
  if (apiProcess && !apiProcess.killed) {
    try {
      apiProcess.kill();
    } catch {
      /* ignore */
    }
  }
});
