/**
 * Local preview server for the desktop content runtime (sandbox/demo only).
 * Serves the built customer app on :8080 and the admin panel on :8080/admin, and proxies
 * /v1/* and /healthz to the API on :41721 — the same split the Electron shell does.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'runtime');
const API = { host: '127.0.0.1', port: 41721 };
const PORT = Number(process.env.PREVIEW_PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function proxy(req, res) {
  const upstream = http.request(
    { host: API.host, port: API.port, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"API_DOWN"}}');
  });
  req.pipe(upstream);
}

function send(res, file, fallback) {
  fs.readFile(file, (error, data) => {
    if (error) {
      if (fallback) {
        fs.readFile(fallback, (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
          res.end(html);
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
    headers['cache-control'] = ext === '.html' ? 'no-store' : 'public, max-age=60';
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/v1/') || url.pathname === '/healthz') {
    proxy(req, res);
    return;
  }
  const admin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
  const base = admin ? path.join(ROOT, 'admin') : path.join(ROOT, 'web');
  const rel = admin ? url.pathname.replace(/^\/admin/, '') || '/' : url.pathname;
  const file = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (rel === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, path.join(base, 'index.html'));
    return;
  }
  send(res, file);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`preview on http://0.0.0.0:${PORT} (app / , admin /admin)`);
});
