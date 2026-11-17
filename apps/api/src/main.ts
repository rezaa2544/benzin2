import type { Repositories } from './ports.js';
import { buildApp } from './http/app.js';
import { loadConfig } from './config.js';
import { createMemoryRepositories } from './infra/memory/index.js';
import { createPostgresRepositories, type PostgresHandle } from './infra/db/repositories/index.js';
import { createPostgresSweepLock, createProcessSweepLock } from './modules/sweep-lock.js';
import { createSmsSender } from './infra/sms/index.js';
import { systemClock } from './domain/entities.js';
import { applySeed } from './infra/db/seed.js';
import { applyDemoOrders } from './infra/db/demo-orders.js';

const config = loadConfig();

if (config.NODE_ENV === 'production' && !config.DATABASE_URL) {
  console.error('DATABASE_URL is required in production; in-memory repositories are dev-only.');
  process.exit(1);
}

/**
 * Storage selection (task G-01).
 *
 * With `DATABASE_URL` the API runs on the Postgres adapter — the same ports the services are
 * tested against, now with real persistence, transactions and the partial unique indexes the
 * concurrency guarantees rely on. Without it (desktop bundle, `pnpm dev`, tests) it keeps using
 * in-memory repositories, which production refuses to boot on.
 */
const postgres: PostgresHandle | null = config.DATABASE_URL
  ? createPostgresRepositories(config.DATABASE_URL)
  : null;
const repos: Repositories = postgres ? postgres.repositories : createMemoryRepositories(systemClock);

// Provider chain from D3: SMS.ir first, Kavenegar as failover; `console` without keys.
const sms = createSmsSender(config);
// Idempotent baseline every deployment needs: Baneh zone, plans, default settings, providers.
await applySeed(repos);

// Local/desktop builds only: known accounts so the whole flow can be walked without an SMS
// provider. 09187888993 owns the admin panel; 09373210545 is an ordinary customer.
if (config.NODE_ENV !== 'production') {
  for (const demo of [
    { phone: '09187888993', role: 'OWNER' as const, displayName: 'Benzin Admin' },
    { phone: '09373210545', role: 'USER' as const, displayName: 'Test Buyer' },
  ]) {
    const existing = await repos.users.findByPhone(demo.phone);
    if (existing) {
      existing.role = demo.role;
      existing.displayName = demo.displayName;
      await repos.users.save(existing);
      continue;
    }
    const created = await repos.users.create({ phone: demo.phone, role: demo.role });
    created.displayName = demo.displayName;
    await repos.users.save(created);
  }

  // A handful of demo listings so the market screen, the place statistics and the green/red split
  // are visible on a fresh launch.
  if (process.env.SEED_DEMO_ORDERS !== '0') {
    await applyDemoOrders(repos, systemClock);
  }
}

const sweepLock = postgres
  ? createPostgresSweepLock(postgres.pool, { logger: { warn: (message) => console.warn(message) } })
  : createProcessSweepLock();

const { app, services, scheduler } = await buildApp({
  config,
  repos,
  sms,
  clock: systemClock,
  sweepLock,
});

/**
 * Node duty (task G-28).
 *
 * A `primary` sweeps from boot. A `helper` — the owner's second machine — deliberately does
 * nothing: it publishes its heartbeat (CPU, RAM, disk, traffic) and polls the registry. Only when
 * no primary has reported inside `NODE_STALE_SECONDS` does it start the expiry sweeps, and it
 * parks them again the moment the primary comes back. Sweeps stay single-flight either way: every
 * instance goes through the `expiry` advisory lock, so an overlap cannot double-apply.
 */
let stopScheduler: (() => void) | null = null;

const startSweeping = (why: string): void => {
  if (stopScheduler) return;
  stopScheduler = scheduler.start(config.SCHEDULER_INTERVAL_MS);
  services.nodes.setActiveLocal(true);
  app.log.warn(`[g-28] ${why}: this node is now running the expiry sweeps`);
};

const stopSweeping = (why: string): void => {
  if (!stopScheduler) return;
  stopScheduler();
  stopScheduler = null;
  services.nodes.setActiveLocal(false);
  app.log.warn(`[g-28] ${why}: this node is parked and will not sweep`);
};

const publishHeartbeat = (): void => {
  void services.nodes.publishSelf().catch((error: unknown) => {
    console.error('[g-28] heartbeat failed', error);
  });
};

if (config.NODE_ROLE === 'primary') {
  startSweeping('primary role');
  publishHeartbeat();
} else {
  // Standby loop: the only thing a helper does until it is needed.
  const supervise = async (): Promise<void> => {
    try {
      const decision = await services.nodes.failover();
      if (decision.shouldTakeOver) startSweeping(`primary unreachable (${decision.reason})`);
      else stopSweeping('primary is healthy');
    } catch (error) {
      console.error('[g-28] failover check failed', error);
    }
    publishHeartbeat();
  };
  void supervise();
  setInterval(() => void supervise(), config.NODE_FAILOVER_POLL_MS).unref();
}

const heartbeatTimer = setInterval(publishHeartbeat, config.NODE_HEARTBEAT_MS);
heartbeatTimer.unref();

app.log.warn(
  postgres
    ? 'Storage: Postgres adapter (task G-01)'
    : 'Running with in-memory repositories — data is lost on restart (development only)',
);

await app.listen({ port: config.API_PORT, host: config.API_HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(heartbeatTimer);
    stopScheduler?.();
    void app
      .close()
      .then(() => postgres?.close())
      .then(() => process.exit(0));
  });
}
