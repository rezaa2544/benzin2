/** Copies the built SPAs (apps/web/dist, apps/admin/dist) into desktop/runtime so the installer stays self-contained. */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const targets = [
  { from: path.join(repoRoot, 'apps', 'web', 'dist'), to: path.resolve(__dirname, '..', 'runtime', 'web') },
  { from: path.join(repoRoot, 'apps', 'admin', 'dist'), to: path.resolve(__dirname, '..', 'runtime', 'admin') },
];

for (const { from, to } of targets) {
  if (!fs.existsSync(from)) {
    console.error(`build not found: ${from}\nrun "pnpm -r build" first`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied ${fs.readdirSync(to).length} entries into ${path.relative(repoRoot, to)}`);
}
