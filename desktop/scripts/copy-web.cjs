/** Copies the built SPA (apps/web/dist) into desktop/runtime/web so the installer stays self-contained. */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const source = path.join(repoRoot, 'apps', 'web', 'dist');
const target = path.resolve(__dirname, '..', 'runtime', 'web');

if (!fs.existsSync(source)) {
  console.error(`web build not found: ${source}\nrun "pnpm --filter @benzin/web build" first`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });

const count = fs.readdirSync(target).length;
console.log(`copied ${count} entries into runtime/web`);
