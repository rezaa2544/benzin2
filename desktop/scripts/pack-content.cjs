/**
 * Builds the downloadable content package: runtime/{api.mjs,web,admin} + version.txt
 * into desktop/dist-content/content.tar.gz and writes content.json next to it.
 * The app only ever downloads this (~3 MB) after the initial install.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(desktopRoot, 'runtime');
const outDir = path.join(desktopRoot, 'dist-content');

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: desktopRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}

function collect(dir, prefix = '') {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) entries.push(...collect(full, rel));
    else entries.push({ rel, full });
  }
  return entries;
}

function tarHeader(name, size, mode, mtime) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const version = `${pkg.version}-${gitSha()}`;

  if (!fs.existsSync(path.join(runtimeDir, 'api.mjs'))) {
    console.error('runtime/api.mjs missing - run "npm run prepack:app" first');
    process.exit(1);
  }

  fs.writeFileSync(path.join(runtimeDir, 'version.txt'), `${version}\n`, 'utf8');
  const files = collect(runtimeDir).sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const now = Date.now();
  const chunks = [];
  for (const file of files) {
    const data = fs.readFileSync(file.full);
    chunks.push(tarHeader(file.rel, data.length, 0o644, now), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(chunks);
  const gz = zlib.gzipSync(tar, { level: 9 });

  fs.mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, 'content.tar.gz');
  fs.writeFileSync(archivePath, gz);

  const manifest = {
    version,
    file: 'content.tar.gz',
    size: gz.length,
    sha256: crypto.createHash('sha256').update(gz).digest('hex'),
    files: files.length,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'content.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(
    `content ${version}: ${files.length} files, ${(gz.length / 1024 / 1024).toFixed(2)} MB -> ${archivePath}`,
  );
}

main();
