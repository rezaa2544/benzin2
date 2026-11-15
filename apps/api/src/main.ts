import { buildApp } from './http/app.js';
import { loadConfig } from './config.js';
import { createMemoryRepositories } from './infra/memory/index.js';
import { createSmsSender } from './infra/sms/index.js';
import { systemClock } from './domain/entities.js';
import { applySeed } from './infra/db/seed.js';
import { applyDemoOrders } from './infra/db/demo-orders.js';

const config = loadConfig();

if (config.NODE_ENV === 'production') {
  // Fail fast instead of silently running on volatile storage.
  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is required in production; in-memory repositories are dev-only.');
    process.exit(1);
  }
  console.error(
    'The Postgres repository adapter is not wired yet (task E2). Refusing to start with in-memory data.',
  );
  process.exit(1);
}

const repos = createMemoryRepositories();
// Provider chain from D3: SMS.ir first, Kavenegar as failover; `console` without keys.
const sms = createSmsSender(config);
// Development/tests only: make the app usable immediately (Baneh zone, plans, settings).
await applySeed(repos);

// Local/desktop builds: known accounts so the whole flow can be walked without an SMS provider.
// 09187888993 owns the admin panel; 09373210545 is an ordinary customer.
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

// Local/desktop builds also get a handful of demo listings so the market screen, the
// place statistics and the green/red split are visible on a fresh launch.
if (process.env.SEED_DEMO_ORDERS !== '0') {
  await applyDemoOrders(repos, systemClock);
}

const { app } = await buildApp({
  config,
  repos,
  sms,
  clock: systemClock,
});

app.log.warn('Running with in-memory repositories — data is lost on restart (development only)');

await app.listen({ port: config.API_PORT, host: config.API_HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
