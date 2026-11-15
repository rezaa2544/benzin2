/**
 * Benzin 2 - desktop shell with content updates.
 *
 * The shell (Electron) changes rarely; the API bundle, the customer SPA and the admin SPA live in
 * a "content" package. On launch the shell asks GitHub for the newest content version and, if it
 * differs from the installed one, downloads a ~3 MB tar.gz instead of the ~82 MB installer.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const API_PORT = 41721;
const APP_PORT = 41720;
const ADMIN_PORT = 41722;
const API_HOST = '127.0.0.1';
// Stable URL: re-uploaded (clobbered) on every content build, so it always points at the newest.
const CONTENT_BASE = 'https://github.com/rezaa2544/benzin2/releases/download/content-latest';

const bundledRuntime = app.isPackaged
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(__dirname, 'runtime');
const contentRoot = path.join(app.getPath('userData'), 'content');

let runtimeDir = bundledRuntime;
let runtimeSource = 'bundled';
let installedVersion = '0.0.0';

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

const log = (...args) => process.stdout.write(`[shell] ${args.join(' ')}\n`);

/* ------------------------------------------------------------------ content resolution */

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim();
  } catch {
    return null;
  }
}

function resolveRuntime() {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(contentRoot, 'current.json'), 'utf8'));
    const dir = path.join(contentRoot, pointer.version);
    if (fs.existsSync(path.join(dir, 'api.mjs')) && fs.existsSync(path.join(dir, 'web', 'index.html'))) {
      runtimeDir = dir;
      installedVersion = readVersion(dir) || pointer.version;
      runtimeSource = 'downloaded';
      log(`content runtime ${installedVersion}`);
      return;
    }
  } catch {
    /* no downloaded content yet */
  }
  runtimeDir = bundledRuntime;
  installedVersion = readVersion(bundledRuntime) || 'bundled';
  runtimeSource = 'bundled';
  log(`bundled runtime ${installedVersion}`);
}

/* ------------------------------------------------------------------ tar.gz helpers */

function untar(buffer, targetDir) {
  let offset = 0;
  const written = [];
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const type = String.fromCharCode(header[156]);
    offset += 512;
    if (name) {
      const safe = path.normalize(name).replace(/^([/\\])+/, '');
      const destination = path.join(targetDir, safe);
      if (!destination.startsWith(targetDir)) throw new Error(`unsafe tar entry: ${name}`);
      if (type === '5') {
        fs.mkdirSync(destination, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, buffer.subarray(offset, offset + size));
        written.push(safe);
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return written.length;
}

/* ------------------------------------------------------------------ update check */

async function fetchJson(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function downloadBuffer(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function checkForUpdates({ manual = false } = {}) {
  let remote;
  try {
    remote = await fetchJson(`${CONTENT_BASE}/content.json`);
  } catch (error) {
    if (manual) dialog.showMessageBox({ message: 'بررسی به‌روزرسانی ناموفق بود', detail: String(error.message) });
    return { status: 'offline' };
  }
  if (!remote || !remote.version) return { status: 'offline' };
  if (remote.version === installedVersion) {
    if (manual) {
      dialog.showMessageBox({
        message: 'برنامه به‌روز است',
        detail: `نسخهٔ محتوا: ${installedVersion}`,
      });
    }
    return { status: 'current', version: remote.version };
  }

  // BENZIN_AUTO_UPDATE=1 installs without prompting (used for smoke tests).
  const auto = process.env.BENZIN_AUTO_UPDATE === '1';
  if (!auto) {
    const answer = await dialog.showMessageBox({
      type: 'question',
      buttons: ['دریافت و ری‌استارت', 'بعداً'],
      defaultId: 0,
      cancelId: 1,
      message: 'به‌روزرسانی آماده است',
      detail: `نسخهٔ نصب‌شده: ${installedVersion}\nنسخهٔ جدید: ${remote.version}\nحجم دانلود: ${(
        remote.size / 1024 / 1024
      ).toFixed(1)} مگابایت (فقط بخش‌های تغییریافته)`,
    });
    if (answer.response !== 0) return { status: 'declined' };
  }

  const staging = path.join(contentRoot, `.staging-${Date.now()}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    const archive = await downloadBuffer(`${CONTENT_BASE}/${remote.file || 'content.tar.gz'}`);
    const digest = crypto.createHash('sha256').update(archive).digest('hex');
    if (remote.sha256 && digest !== remote.sha256) throw new Error('checksum mismatch');
    const count = untar(zlib.gunzipSync(archive), staging);
    const target = path.join(contentRoot, remote.version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    fs.writeFileSync(
      path.join(contentRoot, 'current.json'),
      JSON.stringify({ version: remote.version, files: count, installedAt: new Date().toISOString() }, null, 2),
    );
    log(`content ${remote.version} installed (${count} files)`);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    dialog.showMessageBox({ message: 'نصب به‌روزرسانی ناموفق بود', detail: String(error.message) });
    return { status: 'failed' };
  }

  if (auto) {
    log(`update installed: ${remote.version} (auto mode, no restart)`);
    return { status: 'installed', version: remote.version };
  }

  const restart = await dialog.showMessageBox({
    type: 'info',
    buttons: ['ری‌استارت', 'دستی'],
    defaultId: 0,
    message: 'به‌روزرسانی نصب شد',
    detail: 'برای اعمال، برنامه دوباره اجرا می‌شود.',
  });
  if (restart.response === 0) {
    app.relaunch();
    app.exit(0);
  }
  return { status: 'installed', version: remote.version };
}

/* ------------------------------------------------------------------ api + static servers */

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

function startApi(dir) {
  const entry = path.join(dir, 'api.mjs');
  if (!fs.existsSync(entry)) throw new Error(`API bundle missing: ${entry}`);
  apiProcess = spawn(process.execPath, [entry], {
    cwd: dir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'development',
      API_PORT: String(API_PORT),
      API_HOST,
      LOG_LEVEL: 'warn',
      CORS_ORIGINS: [
        `http://${API_HOST}:${APP_PORT}`,
        `http://localhost:${APP_PORT}`,
        `http://${API_HOST}:${ADMIN_PORT}`,
        `http://localhost:${ADMIN_PORT}`,
      ].join(','),
      SMS_PROVIDERS: 'console',
      PAYMENT_GATEWAY: 'sandbox',
      DEV_FIXED_OTP: process.env.BENZIN_DEV_OTP || '12345',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiProcess.stdout.on('data', (chunk) => process.stdout.write(`[api] ${chunk}`));
  apiProcess.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));
  apiProcess.on('exit', (code) => log(`api exited with ${code}`));
}

function stopApi() {
  if (apiProcess && !apiProcess.killed) {
    try {
      apiProcess.kill();
    } catch {
      /* ignore */
    }
  }
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

/* ------------------------------------------------------------------ windows + menu */

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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'نمایش',
        submenu: [
          { label: 'اپ مشتری', accelerator: 'CmdOrCtrl+1', click: () => openApp() },
          { label: 'پنل مدیریت', accelerator: 'CmdOrCtrl+2', click: () => openAdmin() },
          { type: 'separator' },
          {
            label: 'بررسی به‌روزرسانی',
            click: () => {
              void checkForUpdates({ manual: true });
            },
          },
          {
            label: `نسخهٔ محتوا: ${installedVersion}`,
            enabled: false,
          },
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
    ]),
  );
}

/* ------------------------------------------------------------------ boot */

app.whenReady().then(async () => {
  resolveRuntime();
  try {
    startApi(runtimeDir);
    await waitForPort(API_PORT);
  } catch (error) {
    // A broken content download must never brick the app: fall back to what shipped in the installer.
    if (runtimeDir !== bundledRuntime) {
      log(`content runtime failed (${error.message}); falling back to bundled`);
      stopApi();
      fs.rmSync(path.join(contentRoot, 'current.json'), { force: true });
      runtimeDir = bundledRuntime;
      installedVersion = readVersion(bundledRuntime) || 'bundled';
      startApi(runtimeDir);
      await waitForPort(API_PORT);
    } else {
      dialog.showErrorBox('بنزین ۲ اجرا نشد', String(error && error.message ? error.message : error));
      app.quit();
      return;
    }
  }

  await startStaticServer(path.join(runtimeDir, 'web'), APP_PORT);
  await startStaticServer(path.join(runtimeDir, 'admin'), ADMIN_PORT);
  buildMenu();
  openApp();
  setTimeout(() => {
    void checkForUpdates();
  }, 3000);
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
  stopApi();
});
