#!/usr/bin/env node
/**
 * G-16 — build the SPA for the shell and copy it into the Android project.
 *
 *   BENZIN_API_ORIGIN=https://benzin.example.com node apps/mobile/scripts/sync.mjs
 *
 * Two things have to be true before `npx cap sync android` runs, and both are easy to forget:
 * the web bundle must be built with an absolute API origin (the WebView origin is
 * `https://localhost`), and it must be a *production* build so the service worker and the
 * manifest hashes match what the browser gets. This script refuses to continue when the origin
 * is missing instead of producing an app that silently calls the wrong place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(here, '..');
const repoRoot = join(mobileRoot, '..', '..');
const webRoot = join(repoRoot, 'apps', 'web');

const origin = (process.env.BENZIN_API_ORIGIN ?? '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
  console.error(
    'BENZIN_API_ORIGIN must be the deployed HTTPS origin, e.g.\n' +
      '  BENZIN_API_ORIGIN=https://benzin.example.com pnpm --filter @benzin/mobile sync',
  );
  process.exit(64);
}
if (/localhost|127\.0\.0\.1/.test(origin)) {
  console.error('Refusing to bake a localhost origin into a release build.');
  process.exit(64);
}

const isWindows = process.platform === 'win32';
const run = (command, args, cwd, env) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit', env, shell: isWindows });
};

console.log(`==> building the SPA against ${origin}`);
run('npx', ['--yes', 'pnpm@9.15.4', 'build'], webRoot, {
  ...process.env,
  VITE_API_BASE_URL: origin,
});

const indexHtml = join(webRoot, 'dist', 'index.html');
if (!existsSync(indexHtml)) {
  console.error('apps/web/dist/index.html is missing — the build did not produce a bundle.');
  process.exit(1);
}

const bundle = /index-[A-Za-z0-9_-]+\.js/.exec(readFileSync(indexHtml, 'utf8'))?.[0] ?? 'unknown';
console.log(`==> bundle ${bundle} -> android/app/src/main/assets/public`);

console.log('==> cap sync android');
run('npx', ['cap', 'sync', 'android'], mobileRoot, process.env);
console.log(`==> done — the shell now talks to ${origin} (${bundle})`);
