#!/usr/bin/env node
/**
 * Helper-node agent (task G-28).
 *
 * Runs on the second machine — the owner's own PC — and does two things, in this order:
 *
 *  1. tells the API what that box is doing: CPU, RAM, disk and, when it takes over, the jobs it
 *     ran. The admin panel's «گره‌های زنده» screen shows it live;
 *  2. stays *idle* while the primary is healthy. `GET /v1/nodes/failover` decides: only when no
 *     primary has reported for `NODE_STALE_SECONDS` does the agent mark itself active and, if
 *     `HELPER_TAKEOVER_CMD` is set, start that command (a second API instance, for example) so the
 *     box actually serves. When the primary comes back the command is stopped again.
 *
 * Usage:
 *   API_URL=http://127.0.0.1:41721 NODE_TOKEN=... node scripts/helper-node.mjs
 *
 * Everything is optional except API_URL and NODE_TOKEN; without them the panel simply has nothing
 * to show, so the agent exits with a readable message instead of failing silently.
 */

import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:41721').replace(/\/$/, '');
const NODE_TOKEN = process.env.NODE_TOKEN ?? '';
const NODE_ID =
  process.env.NODE_ID ??
  `pc-${(os.hostname() || 'local').toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`;
const NODE_NAME = process.env.NODE_NAME ?? `سیستم ${os.hostname() || 'کمکی'}`;
const INTERVAL_MS = Number(process.env.NODE_INTERVAL_MS ?? 5_000);
const TAKEOVER_CMD = process.env.HELPER_TAKEOVER_CMD ?? '';
const RUN_ONCE = process.argv.includes('--once');

if (!NODE_TOKEN) {
  console.error('NODE_TOKEN لازم است: همان مقداری که در سرور تنظیم شده (x-node-token).');
  process.exit(2);
}

const startedAt = Date.now();
const jobs = [];
let totalJobs = 0;
let child = null;
let takingOver = false;

const recordJob = (kind, count = 1) => {
  const at = new Date().toISOString();
  totalJobs += count;
  jobs.unshift({ kind, count, at });
  jobs.length = Math.min(jobs.length, 12);
  console.log(`[job] ${kind} x${count}`);
};

// --- host metrics -------------------------------------------------------------------------
const cpuSample = () => {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { idle, total };
};

let previous = cpuSample();
// Give the sampler a moment before the first reading: a zero-width window always reads 100 %.
const PRIME_MS = 300;

const samples = async () => {
  const current = cpuSample();
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  previous = current;

  let diskFreeGb = 0;
  let diskTotalGb = 0;
  try {
    const stats = await statfs(process.cwd());
    diskTotalGb = Number(((stats.bsize * stats.blocks) / 1024 ** 3).toFixed(2));
    diskFreeGb = Number(((stats.bsize * stats.bavail) / 1024 ** 3).toFixed(2));
  } catch {
    // A machine without statfs support still reports CPU and RAM.
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    cpuPct: totalDelta > 0 ? Number((((1 - idleDelta / totalDelta) * 100) || 0).toFixed(1)) : 0,
    cores: os.cpus().length,
    memUsedPct: totalMem > 0 ? Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1)) : 0,
    memRssMb: Number((process.memoryUsage().rss / 1024 ** 2).toFixed(1)),
    diskFreeGb,
    diskTotalGb,
    loadAvg: Number((os.loadavg()[0] ?? 0).toFixed(2)),
    eventLoopLagMs: null,
  };
};

// --- takeover -----------------------------------------------------------------------------
const startTakeover = () => {
  takingOver = true;
  if (!TAKEOVER_CMD) {
    console.log('[failover] سرور اصلی پاسخ نمی‌دهد؛ این گره فعال شد (فرمانی برای اجرا تنظیم نشده).');
    recordJob('helper-standby-active');
    return;
  }
  if (child) return;
  console.log(`[failover] سرور اصلی پاسخ نمی‌دهد؛ اجرای ${TAKEOVER_CMD}`);
  child = spawn(TAKEOVER_CMD, { shell: true, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[failover] فرمان گرهٔ کمکی با کد ${code} تمام شد`);
    child = null;
  });
  recordJob('helper-takeover-start');
};

const stopTakeover = () => {
  takingOver = false;
  if (!child) return;
  console.log('[failover] سرور اصلی برگشت؛ گرهٔ کمکی متوقف شد');
  child.kill();
  child = null;
  recordJob('helper-takeover-stop');
};

const headers = { 'content-type': 'application/json', 'x-node-token': NODE_TOKEN };

const askFailover = async () => {
  const response = await fetch(`${API_URL}/v1/nodes/failover?nodeId=${encodeURIComponent(NODE_ID)}`, {
    headers: { 'x-node-token': NODE_TOKEN },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`failover ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
};

/** `resources` is sampled by the caller: sampling twice would measure a zero-width window. */
const beat = async (resources) => {
  const decision = await askFailover();
  if (decision.shouldTakeOver) startTakeover();
  else stopTakeover();

  const body = {
    nodeId: NODE_ID,
    name: NODE_NAME,
    role: 'helper',
    version: process.env.NODE_VERSION_LABEL ?? 'helper-agent',
    region: process.env.NODE_REGION ?? null,
    resources,
    traffic: { requests: 0, errors: 0, requestsPerMin: 0, avgLatencyMs: 0, lastRequestAt: null },
    jobs: {
      total: totalJobs,
      last30Min: totalJobs,
      lastJobAt: jobs[0]?.at ?? null,
      recent: jobs,
    },
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    active: takingOver,
  };

  const response = await fetch(`${API_URL}/v1/nodes/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`heartbeat ${response.status}: ${text.slice(0, 200)}`);
  return { decision, accepted: JSON.parse(text || '{}') };
};

const report = (resources, decision) => {
  const bar = (pct) => {
    const filled = Math.round(Math.min(100, Math.max(0, pct)) / 5);
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
  };
  console.log(
    [
      `[${NODE_ID}] cpu ${resources.cpuPct.toFixed(1).padStart(5)}% ${bar(resources.cpuPct)}`,
      `ram ${resources.memUsedPct.toFixed(0)}%`,
      `disk free ${resources.diskFreeGb}GB`,
      `| ${takingOver ? 'ACTIVE (taking over)' : 'standby'}`,
      `| ${decision.reason}`,
    ].join(' '),
  );
};

const main = async () => {
  console.log(`گرهٔ کمکی «${NODE_NAME}» → ${API_URL} (شناسه ${NODE_ID})`);
  await new Promise((resolve) => setTimeout(resolve, PRIME_MS));
  const loop = async () => {
    try {
      const resources = await samples();
      const { decision } = await beat(resources);
      report(resources, decision);
    } catch (error) {
      console.error('[g-28] heartbeat failed:', error instanceof Error ? error.message : error);
    }
  };
  await loop();
  if (RUN_ONCE) return;
  setInterval(() => void loop(), INTERVAL_MS);
};

process.on('SIGINT', () => {
  if (child) child.kill();
  process.exit(0);
});

await main();
