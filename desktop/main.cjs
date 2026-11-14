/**
 * Benzin 2 - desktop shell.
 *
 * Two windows, one API. The bundled API runs as a child process on loopback; each window gets
 * its own static server that proxies /v1, /healthz and websocket upgrades to it, so both SPAs
 * keep using relative URLs exactly as they do behind Caddy in production.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const API_PORT = 41721;
const APP_PORT = 41720;
const ADMIN_PORT = 41722;
const API_HOST = '127.0.0.1';

const runtimeDir = app.isPackaged
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(__dirname, 'runtime');
const webDir = path.join(runtimeDir, 'web');
const adminDir = path.join(runtimeDir, 'admin');
const apiEntry = path.join(runtimeDir, 'api.mjs');

let apiProcess = null;
let appWindow = null;
let adminWindow = null;
const servers = [];

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
  if (!fs.existsSync(apiEntry)) throw new Error(`API bundle missing: ${apiEntry}`);
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'development',
      API_PORT: String(API_PORT),
      API_HOST,
      LOG_LEVEL: 'warn',
      // Browsers on both windows talk to the same loopback API.
      CORS_ORIGINS: [
        `http://${API_HOST}:${APP_PORT}`,
        `http://localhost:${APP_PORT}`,
        `http://${API_HOST}:${ADMIN_PORT}`,
        `http://localhost:${ADMIN_PORT}`,
      ].join(','),
      SMS_PROVIDERS: 'console',
      PAYMENT_GATEWAY: 'sandbox',
      // No SMS account yet: every OTP becomes this code (development only, see README).
      DEV_FIXED_OTP: process.env.BENZIN_DEV_OTP || '12345',
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

function serveStatic(root, req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const candidate = path.join(root, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  const inside = candidate.startsWith(root);
  const filePath =
    inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(root, 'index.html');
  if (!fs.existsSync(filePath)) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>bundle missing</h1>');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(res);
}

function startStaticServer(root, port) {
  const proxyV1 = proxyTo(API_PORT);
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p.startsWith('/v1/') || p === '/healthz' || p === '/health') return proxyV1(req, res);
    return serveStatic(root, req, res);
  });

  server.on('upgrade', (req, socket, head) => {
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

  servers.push(server);
  return new Promise((resolve) => server.listen(port, API_HOST, resolve));
}

function openApp() {
  if (appWindow) {
    appWindow.focus();
    return;
  }
  appWindow = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 380,
    minHeight: 640,
    backgroundColor: '#0f172a',
    title: 'بنزین ۲',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  appWindow.loadURL(`http://${API_HOST}:${APP_PORT}/`);
  appWindow.on('closed', () => {
    appWindow = null;
  });
}

function openAdmin() {
  if (adminWindow) {
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1220',
    title: 'بنزین ۲ — پنل مدیریت',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  adminWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  adminWindow.loadURL(`http://${API_HOST}:${ADMIN_PORT}/`);
  adminWindow.on('closed', () => {
    adminWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: 'نمایش',
      submenu: [
        { label: 'اپ مشتری', accelerator: 'CmdOrCtrl+1', click: () => openApp() },
        { label: 'پنل مدیریت', accelerator: 'CmdOrCtrl+2', click: () => openAdmin() },
        { type: 'separator' },
        { role: 'reload', label: 'بارگذاری مجدد' },
        { role: 'toggleDevTools', label: 'ابزار توسعه' },
        { role: 'resetZoom', label: 'اندازهٔ پیش‌فرض' },
        { role: 'zoomIn', label: 'بزرگ‌تر' },
        { role: 'zoomOut', label: 'کوچک‌تر' },
        { type: 'separator' },
        { role: 'quit', label: 'خروج' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    startApi();
    await waitForPort(API_PORT);
    await startStaticServer(webDir, APP_PORT);
    await startStaticServer(adminDir, ADMIN_PORT);
    buildMenu();
    openApp();
  } catch (error) {
    dialog.showErrorBox('بنزین ۲ اجرا نشد', String(error && error.message ? error.message : error));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  for (const server of servers) {
    try {
      server.close();
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
