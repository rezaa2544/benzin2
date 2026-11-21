#!/usr/bin/env node
/**
 * G-18 — the parts of "ready to deploy" that can be checked by a machine.
 *
 *   node scripts/check-deploy.mjs
 *
 * A deployment either satisfies a short list of promises or it is a coin flip at 2 a.m.:
 * every service restarts itself, every service's logs are capped, only the edge publishes a port,
 * the secrets have no defaults, TLS and security headers are configured, and the backup script
 * both dumps *and* verifies its dump. This script asserts those on the files in `infra/`, so a
 * future edit that quietly drops `restart: unless-stopped` fails here instead of on the server.
 *
 * Runs offline: no Docker daemon, no network. `docker compose config` is still the authority on
 * whether the file *parses*; this is the part Docker cannot tell you.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✔ ${name}${typeof detail === 'string' ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✘ ${name} — ${error.message}`);
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const compose = read('infra/docker-compose.prod.yml');
const caddy = read('infra/Caddyfile.prod');
const backup = read('infra/backup.sh');
const restore = read('infra/restore-test.sh');

/** Tiny YAML reader: the compose file uses no anchors inside values, only the ones we add. */
const services = (() => {
  const out = new Map();
  let current = null;
  let inServices = false;
  for (const line of compose.split('\n')) {
    if (line === 'services:') {
      inServices = true;
      continue;
    }
    // Any column-zero key after `services:` closes the block (`volumes:`, `networks:`, …).
    if (/^[a-z]/.test(line)) {
      inServices = false;
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (service) {
      current = service[1];
      out.set(current, []);
      continue;
    }
    if (current) out.get(current).push(line);
  }
  // `x-*` blocks are helpers, not services.
  for (const key of [...out.keys()]) if (key.startsWith('x-')) out.delete(key);
  return out;
})();

const body = (name) => (services.get(name) ?? []).join('\n');

console.log('Production deployment — infra/docker-compose.prod.yml + Caddyfile.prod + backup.sh\n');

check('the stack has the eight services a single-server deployment needs', () => {
  const required = ['postgres', 'redis', 'api', 'web', 'admin', 'caddy', 'backup', 'uptime-kuma'];
  const missing = required.filter((name) => !services.has(name));
  expect(missing.length === 0, `missing: ${missing.join(', ')}`);
  return required.join(' · ');
});

// One-shot jobs exit by design; everything long-running has to come back by itself.
const ONE_SHOT = new Set(['migrate']);
check('every long-running service restarts itself', () => {
  const offenders = [...services.keys()]
    .filter((name) => !ONE_SHOT.has(name))
    .filter((name) => !/restart:\s*\*restart|restart:\s*unless-stopped/.test(body(name)));
  expect(offenders.length === 0, `no restart policy: ${offenders.join(', ')}`);
  expect(/restart:\s*'no'/.test(body('migrate')), 'the migrate job must not restart forever');
  return `${services.size - ONE_SHOT.size} services · unless-stopped · migrate one-shot`;
});

check('migrations run before the API starts', () => {
  expect(body('migrate').includes('cli.js'), 'no migrate command');
  expect(
    /migrate:\s*\n\s*condition:\s*service_completed_successfully/.test(body('api')),
    'the API does not wait for the migration job',
  );
  expect(
    read('infra/Dockerfile.api').includes('COPY infra/migrations'),
    'the image has no migrations',
  );
  return 'service_completed_successfully';
});

check('every service caps its logs', () => {
  const offenders = [...services.keys()].filter(
    (name) => !/logging:\s*\*logging|max-size:/.test(body(name)),
  );
  expect(offenders.length === 0, `no log cap: ${offenders.join(', ')}`);
  expect(/max-size:\s*'20m'/.test(compose), 'the shared log cap moved; update this check');
  expect(/max-file:\s*'5'/.test(compose), 'max-file missing');
  return '20 MB × 5 per service';
});

check('only the edge publishes ports', () => {
  const publishers = [...services.keys()].filter((name) => /^\s{4}ports:/m.test(body(name)));
  expect(
    publishers.length === 1 && publishers[0] === 'caddy',
    `published by ${publishers.join(', ') || 'nobody'} (postgres must never be public)`,
  );
  return 'caddy :80/:443 only';
});

check('stateful services have a healthcheck', () => {
  const required = ['postgres', 'redis', 'api', 'web', 'admin', 'backup'];
  const missing = required.filter((name) => !/healthcheck:/.test(body(name)));
  expect(missing.length === 0, `no healthcheck: ${missing.join(', ')}`);
  return required.join(' · ');
});

check('secrets have no defaults', () => {
  for (const key of [
    'JWT_SECRET',
    'OTP_PEPPER',
    'POSTGRES_PASSWORD',
    'PUBLIC_ORIGIN',
    'PUBLIC_HOST',
    'ACME_EMAIL',
  ]) {
    expect(compose.includes(`\${${key}:?`), `${key} would silently boot with an empty value`);
  }
  return '6 required variables';
});

check('the API runs in production with the real callback URL', () => {
  expect(/NODE_ENV:\s*production/.test(compose), 'the API is not in production mode');
  expect(
    /PAYMENT_CALLBACK_URL:\s*\$\{PUBLIC_ORIGIN\}\/v1\/payments\/gateway\/callback/.test(compose),
    'the gateway callback is not the public HTTPS URL (the API refuses to boot without it)',
  );
  expect(
    /DATABASE_URL:\s*postgres:\/\//.test(compose),
    'DATABASE_URL is missing — the API would use memory',
  );
  return 'NODE_ENV=production · https callback';
});

check('Caddy terminates TLS with a real certificate and redirects http', () => {
  expect(/\{\$PUBLIC_HOST\}/.test(caddy), 'the site block is not bound to the domain');
  expect(/email \{\$ACME_EMAIL\}/.test(caddy), 'no ACME contact address');
  expect(!/auto_https off/.test(caddy), 'auto_https is off — no certificate would ever be issued');
  return 'ACME + http→https';
});

check('Caddy sends the security headers and gzip', () => {
  for (const header of [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
  ]) {
    expect(caddy.includes(header), `${header} missing`);
  }
  expect(/encode zstd gzip/.test(caddy), 'compression missing');
  return '4 headers + compression';
});

check('the panel and the monitor are on the same origin', () => {
  expect(/handle \/admin\/\*/.test(caddy), 'the panel is not proxied');
  // Kuma earns its own name (the image ignores the base-path variables) but `/status/` still
  // works, because it redirects there.
  expect(/path_regexp status \^\/status/.test(caddy), 'the /status/ shortcut is gone');
  expect(/status\.\{\$PUBLIC_HOST\}/.test(caddy), 'the monitor has no site of its own');
  expect(/reverse_proxy uptime-kuma:3001/.test(caddy), 'the monitor is not proxied anywhere');
  expect(/reverse_proxy api:3000/.test(caddy), 'the API is not proxied');
  expect(
    /handle \/v1\/\*/.test(caddy) || /@api path \/v1\/\*/.test(caddy),
    'the API paths are not routed',
  );
  return '/ · /admin/ · /v1/* · /status/';
});

check('the backup dumps, verifies the dump, then prunes', () => {
  expect(/pg_dump --format=custom/.test(backup), 'no pg_dump in custom format');
  expect(/pg_restore --list/.test(backup), 'the dump is never verified before it is promoted');
  expect(/mtime "\+\$\{KEEP_DAYS\}"/.test(backup), 'no retention window');
  expect(/rclone copy/.test(backup), 'no offsite copy');
  return 'custom format · pg_restore --list · 14 days · rclone';
});

check('the restore drill restores into a scratch database, never the live one', () => {
  expect(/restore_drill_/.test(restore), 'the drill does not use a throwaway database name');
  expect(/DROP DATABASE IF EXISTS/.test(restore), 'the scratch database is never cleaned up');
  expect(/--exit-on-error/.test(restore), 'pg_restore would skip failed statements');
  expect(
    /FROM users/.test(restore) && /FROM orders/.test(restore),
    'the drill does not count the rows',
  );
  // The list must name real tables: the first drill died on `audit_log` (the table is
  // `audit_logs`), which is exactly the rot a static check catches before a real restore does.
  for (const table of ['users', 'orders', 'reservations', 'payments', 'plans', 'audit_logs']) {
    expect(new RegExp(`FROM ${table}\\b`).test(restore), `the drill counts a missing table: ${table}`);
  }
  return 'scratch DB · --exit-on-error · row counts';
});

check('both scripts parse as POSIX shell', () => {
  for (const script of [join(root, 'infra/backup.sh'), join(root, 'infra/restore-test.sh')]) {
    expect(existsSync(script), `${script} is missing`);
    execFileSync('sh', ['-n', script], { stdio: 'pipe' });
  }
  return 'sh -n clean';
});

check('the volume that holds backups is declared, not a host path', () => {
  expect(/^volumes:/m.test(compose), 'no volumes block');
  for (const volume of ['pgdata', 'backups', 'kumadata', 'caddydata']) {
    expect(new RegExp(`^ {2}${volume}:`, 'm').test(compose), `volume ${volume} is not declared`);
  }
  return 'pgdata · backups · kumadata · caddydata';
});

check('the build context is not the whole repository', () => {
  const ignore = read('.dockerignore');
  for (const pattern of ['node_modules/', '**/dist/', 'desktop/runtime/', '.git/']) {
    expect(ignore.includes(pattern), `.dockerignore does not exclude ${pattern}`);
  }
  const example = statSync(join(root, 'infra/.env.prod.example'));
  expect(example.size > 200, 'the .env example is empty');
  return '.dockerignore + .env.prod.example';
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} checks passed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('the deployment files keep every promise the runbook makes');
