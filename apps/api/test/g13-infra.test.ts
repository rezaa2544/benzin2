import { describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  freshPhone,
  loginAsRole,
  orderPayload,
  ManualClock,
  type TestContext,
} from './helpers.js';

/**
 * G-13 — the infrastructure screen.
 *
 * The acceptance text asks for two things that look different but are used together during an
 * incident: a health board (API / data / scheduler / SMS / gateway, each with a colour and the time
 * it was checked) and an inventory the owner maintains (name, kind, address, credential,
 * active flag) with every write in the audit log.
 *
 * The rule worth guarding hardest is the secret: the panel must be able to say «تنظیم شده» without
 * ever receiving the credential back.
 */

interface CheckRow {
  key: string;
  labelFa: string;
  status: 'OK' | 'WARN' | 'DOWN';
  detailFa: string;
  checkedAt: string;
}

interface Overview {
  version: string;
  mode: string;
  migrations: { latest: string | null; count: number; detailFa: string };
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  counts: { users: number; openOrders: number; ordersToday: number; tradesToday: number };
  checks: CheckRow[];
  resources: {
    id: string;
    name: string;
    kind: string;
    address: string;
    secretSet: boolean;
    isActive: boolean;
  }[];
}

const overview = async (ctx: TestContext, token: string): Promise<Overview> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/infra',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Overview;
};

describe('G-13 — infrastructure board', () => {
  it('reports every subsystem the owner has to keep alive, each with a colour and a timestamp', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const admin = await loginAsRole(ctx, freshPhone(), 'ADMIN');
      const board = await overview(ctx, admin.token);

      const keys = board.checks.map((check) => check.key);
      expect(keys).toEqual(
        expect.arrayContaining(['api', 'database', 'scheduler', 'sms', 'gateway', 'zones']),
      );
      // A memory-mode test server must not claim its data is durable.
      const database = board.checks.find((check) => check.key === 'database');
      expect(database?.status).toBe('WARN');
      for (const check of board.checks) {
        expect(['OK', 'WARN', 'DOWN']).toContain(check.status);
        expect(check.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(check.detailFa.length).toBeGreaterThan(0);
      }
      expect(board.version.length).toBeGreaterThan(0);
      // The migration file list is part of the answer: «کدام نسخه روی سرور است؟» is a real question.
      expect(board.migrations.count).toBeGreaterThanOrEqual(13);
      expect(board.migrations.latest).toBe('0013_infra_resources');
    } finally {
      await ctx.close();
    }
  });

  it('counts today in Tehran, not UTC, and counts a started trade', async () => {
    const ctx = await createTestContext(new ManualClock(new Date('2026-05-01T20:45:00.000Z')));
    try {
      const admin = await loginAsRole(ctx, freshPhone(), 'ADMIN');
      const seller = await loginAsRole(ctx, freshPhone(), 'USER');
      const buyer = await loginAsRole(ctx, freshPhone(), 'USER');

      const before = await overview(ctx, admin.token);
      expect(before.counts.ordersToday).toBe(0);
      expect(before.counts.tradesToday).toBe(0);

      // 20:45 UTC is 00:15 the next day in Tehran: this order belongs to «today», the new day.
      const order = await ctx.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: auth(seller.token),
        payload: orderPayload(),
      });
      expect(order.statusCode).toBe(201);

      const reservation = await ctx.app.inject({
        method: 'POST',
        url: `/v1/orders/${(order.json() as { id: string }).id}/reservations`,
        headers: auth(buyer.token),
      });
      expect(reservation.statusCode).toBe(201);

      const after = await overview(ctx, admin.token);
      expect(after.counts.ordersToday).toBe(1);
      expect(after.counts.tradesToday).toBe(1);
      expect(after.counts.users).toBeGreaterThanOrEqual(3);
    } finally {
      await ctx.close();
    }
  });

  it('turns the scheduler red when the last sweep is old', async () => {
    const clock = new ManualClock(new Date('2026-05-01T10:00:00.000Z'));
    const ctx = await createTestContext(clock);
    try {
      const admin = await loginAsRole(ctx, freshPhone(), 'ADMIN');

      // Never ticked: yellow, with an explanation instead of a scary red on boot.
      const fresh = await overview(ctx, admin.token);
      expect(fresh.checks.find((check) => check.key === 'scheduler')?.status).toBe('WARN');

      await ctx.scheduler.tick();
      const ticking = await overview(ctx, admin.token);
      expect(ticking.checks.find((check) => check.key === 'scheduler')?.status).toBe('OK');

      // Ten missed intervals is not «a bit late», it is down.
      clock.advanceMinutes(60);
      const stale = await overview(ctx, admin.token);
      expect(stale.checks.find((check) => check.key === 'scheduler')?.status).toBe('DOWN');
    } finally {
      await ctx.close();
    }
  });
});

describe('G-13 — infrastructure inventory', () => {
  it('creates, edits and deletes a row, keeping the secret on the server', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/infra',
        headers: auth(owner.token),
        payload: {
          name: 'پیامک کاوه‌نگار',
          kind: 'SMS',
          address: 'https://api.kavenegar.com/v1',
          secret: 'super-secret-api-key',
        },
      });
      expect(created.statusCode).toBe(201);
      const row = created.json() as { id: string; secretSet: boolean };
      expect(row.secretSet).toBe(true);
      // The rule: the credential never travels back to the panel.
      expect(JSON.stringify(created.body)).not.toContain('super-secret-api-key');

      const board = await overview(ctx, owner.token);
      expect(board.resources).toHaveLength(1);
      expect(board.resources[0]).toMatchObject({ name: 'پیامک کاوه‌نگار', kind: 'SMS', isActive: true });

      // Saving the form without touching the credential must not wipe it.
      const renamed = await ctx.app.inject({
        method: 'PATCH',
        url: `/v1/admin/infra/${row.id}`,
        headers: auth(owner.token),
        payload: { name: 'کاوه‌نگار اصلی', isActive: false },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ name: 'کاوه‌نگار اصلی', isActive: false, secretSet: true });

      const audit = await ctx.repos.audit.list(10);
      const actions = audit.map((entry) => entry.action);
      expect(actions).toContain('infra.created');
      expect(actions).toContain('infra.updated');

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/admin/infra/${row.id}`,
        headers: auth(owner.token),
      });
      expect(removed.statusCode).toBe(200);
      expect((await overview(ctx, owner.token)).resources).toHaveLength(0);
      expect((await ctx.repos.audit.list(10)).map((entry) => entry.action)).toContain(
        'infra.deleted',
      );
    } finally {
      await ctx.close();
    }
  });

  it('refuses two rows with the same name and a kind it does not recognise', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const admin = await loginAsRole(ctx, freshPhone(), 'ADMIN');
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/infra',
        headers: auth(admin.token),
        payload: { name: 'دیتابیس اصلی', kind: 'DATABASE', address: '10.0.0.5:5432' },
      });
      expect(first.statusCode).toBe(201);

      const duplicate = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/infra',
        headers: auth(admin.token),
        payload: { name: 'دیتابیس اصلی', kind: 'CACHE', address: '10.0.0.6:6379' },
      });
      expect(duplicate.statusCode).toBe(409);
      expect((duplicate.json() as { error: { code: string } }).error.code).toBe('INFRA_NAME_TAKEN');

      const bogusKind = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/infra',
        headers: auth(admin.token),
        payload: { name: 'چیز عجیب', kind: 'BLOCKCHAIN', address: 'x' },
      });
      expect(bogusKind.statusCode).toBe(422);
    } finally {
      await ctx.close();
    }
  });

  it('keeps the inventory to staff — a normal user cannot see or edit it', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const user = await loginAsRole(ctx, freshPhone(), 'USER');
      const board = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/infra',
        headers: auth(user.token),
      });
      expect(board.statusCode).toBe(403);

      const write = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/infra',
        headers: auth(user.token),
        payload: { name: 'تلاش غیرمجاز', kind: 'API', address: 'http://x' },
      });
      expect(write.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
