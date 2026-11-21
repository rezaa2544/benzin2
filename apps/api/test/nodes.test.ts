import { describe, expect, it } from 'vitest';
import { auth, createTestContext, login, ManualClock } from './helpers.js';

/**
 * Task G-28 — the node monitor.
 *
 * What the owner asked for in one sentence: "when my own machine stands by as a helper server I
 * want to see its CPU and what it did, live." These tests pin the three halves of that: the
 * heartbeat table the panel reads, the counters that make "what it did" real, and the failover
 * rule that keeps a helper idle while the primary is healthy.
 */

const OWNER = '09121110009';
const CUSTOMER = '09121110010';

const staffToken = async (ctx: Awaited<ReturnType<typeof createTestContext>>): Promise<string> => {
  const owner = await login(ctx, OWNER);
  const user = await ctx.repos.users.findById(owner.userId);
  if (user) {
    user.role = 'OWNER';
    await ctx.repos.users.save(user);
  }
  // Role is baked into the token, so log in again after the promotion.
  const promoted = await login(ctx, OWNER);
  return promoted.token;
};

describe('node monitor (G-28)', () => {
  it('reports this process with resources, traffic and jobs', async () => {
    const ctx = await createTestContext();
    const token = await staffToken(ctx);

    // Some traffic first, so the one-minute window is not empty.
    for (let index = 0; index < 3; index += 1) {
      await ctx.app.inject({ method: 'GET', url: '/v1/meta/config' });
    }
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/scheduler/tick',
      headers: auth(token),
      payload: {},
    });

    // Publish the heartbeat the entrypoint's timer would write, then read the panel's view.
    await ctx.services.nodes.publishSelf();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/nodes',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      selfNodeId: string;
      staleAfterSeconds: number;
      nodes: {
        nodeId: string;
        role: string;
        state: string;
        stateFa: string;
        self: boolean;
        resources: { cpuPct: number; cores: number; memUsedPct: number } | null;
        traffic: { requests: number; requestsPerMin: number; avgLatencyMs: number };
        jobs: { recent: { kind: string; count: number }[] };
      }[];
      failover: { shouldTakeOver: boolean };
    };

    expect(body.nodes).toHaveLength(1);
    const node = body.nodes[0]!;
    expect(node.nodeId).toBe(body.selfNodeId);
    expect(node.self).toBe(true);
    expect(node.role).toBe('primary');
    expect(node.state).toBe('active');
    expect(node.stateFa).toBe('فعال');
    expect(node.resources).not.toBeNull();
    expect(node.resources!.cpuPct).toBeGreaterThanOrEqual(0);
    expect(node.resources!.cpuPct).toBeLessThanOrEqual(100);
    expect(node.resources!.cores).toBeGreaterThanOrEqual(1);
    // Traffic counts this node served, and the sweep the panel triggered is a recorded job.
    expect(node.traffic.requests).toBeGreaterThan(0);
    expect(node.traffic.requestsPerMin).toBeGreaterThan(0);
    expect(node.jobs.recent[0]?.kind).toBe('expiry-sweep');
    // A single healthy primary means the helper is not needed.
    expect(body.failover.shouldTakeOver).toBe(false);
    await ctx.close();
  });

  it('counts sweep work so the panel can show a work report', async () => {
    const clock = new ManualClock();
    const ctx = await createTestContext(clock);
    const token = await staffToken(ctx);

    const owner = await ctx.repos.users.findByPhone(OWNER);
    await ctx.repos.orders.create({
      ownerId: owner!.id,
      side: 'SELL',
      tier: 'T3000',
      litres: 20,
      rateToman: 5000,
      zoneId: 'zone-baneh',
      province: 'کردستان',
      county: 'بانه',
      stationName: null,
      note: null,
      lat: 35.9983,
      lng: 45.8851,
      expiresAt: new Date(clock.now().getTime() - 60_000),
    });

    const tick = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/scheduler/tick',
      headers: auth(token),
      payload: {},
    });
    expect(tick.statusCode).toBe(200);
    const tickBody = tick.json() as { result: { expiredOrders: number } | null };
    expect(tickBody.result?.expiredOrders).toBe(1);

    const nodes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/nodes',
      headers: auth(token),
    });
    const job = (
      nodes.json() as {
        nodes: {
          jobs: { recent: { kind: string; count: number; detail: Record<string, number> }[] };
        }[];
      }
    ).nodes[0]!.jobs.recent[0]!;
    expect(job.kind).toBe('expiry-sweep');
    expect(job.detail.expiredOrders).toBe(1);
    // G-10 added two sweeps of its own (lapsed listing pauses, aged answer windows), so the total
    // is the sum of the report rather than a fixed 1 — the panel shows exactly that sum.
    expect(job.count).toBe(Object.values(job.detail).reduce((total, value) => total + value, 0));
    await ctx.close();
  });

  it('accepts a helper heartbeat only with the node token', async () => {
    const ctx = await createTestContext(systemClockOf(), {
      env: { NODE_TOKEN: 'test-node-token' },
      node: { nodeId: 'primary-1', name: 'سرور اصلی' },
    });
    const token = await staffToken(ctx);

    // The primary is alive and reporting; only then does the helper count as standby.
    await ctx.services.nodes.publishSelf();

    const payload = {
      nodeId: 'pc-reza',
      name: 'سیستم رضا',
      role: 'helper' as const,
      resources: {
        cpuPct: 12.5,
        cores: 8,
        memUsedPct: 44,
        memRssMb: 512,
        diskFreeGb: 120,
        diskTotalGb: 480,
        loadAvg: 0.6,
      },
      uptimeSeconds: 3600,
      active: false,
    };

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/v1/nodes/heartbeat',
      payload,
    });
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('NODE_TOKEN_INVALID');

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/v1/nodes/heartbeat',
      headers: { 'x-node-token': 'nope' },
      payload,
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/v1/nodes/heartbeat',
      headers: { 'x-node-token': 'test-node-token' },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    const helper = ok.json() as {
      nodeId: string;
      role: string;
      state: string;
      resources: { cpuPct: number };
    };
    expect(helper.nodeId).toBe('pc-reza');
    expect(helper.role).toBe('helper');
    expect(helper.state).toBe('standby');
    expect(helper.resources.cpuPct).toBe(12.5);

    const overview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/nodes',
      headers: auth(token),
    });
    const body = overview.json() as {
      nodes: { nodeId: string; duties: string; dutiesFa: string }[];
      failover: { shouldTakeOver: boolean; reason: string };
    };
    const help = body.nodes.find((node) => node.nodeId === 'pc-reza')!;
    expect(help.duties).toBe('standby');
    expect(help.dutiesFa).toContain('آماده');
    expect(body.failover.shouldTakeOver).toBe(false);
    await ctx.close();
  });

  it('refuses heartbeats when no node token is configured', async () => {
    const ctx = await createTestContext();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/nodes/heartbeat',
      headers: { 'x-node-token': 'anything' },
      payload: { nodeId: 'pc-reza' },
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NODE_AGENT_DISABLED');
    await ctx.close();
  });

  it('lets the helper take over once the primary goes quiet, and parks it again after', async () => {
    const clock = new ManualClock();
    const ctx = await createTestContext(clock, {
      env: { NODE_TOKEN: 'test-node-token', NODE_STALE_SECONDS: '60' },
      node: { nodeId: 'primary-1' },
    });
    const token = await staffToken(ctx);
    // The primary reports at t0.
    await ctx.services.nodes.publishSelf();

    const fresh = await ctx.app.inject({
      method: 'GET',
      url: '/v1/nodes/failover',
      headers: { 'x-node-token': 'test-node-token' },
    });
    expect(fresh.statusCode).toBe(200);
    expect((fresh.json() as { shouldTakeOver: boolean }).shouldTakeOver).toBe(false);

    // Two minutes with no heartbeat: the primary is stale, the helper should sweep.
    clock.advanceMinutes(2);
    const stale = await ctx.app.inject({
      method: 'GET',
      url: '/v1/nodes/failover',
      headers: { 'x-node-token': 'test-node-token' },
    });
    const staleBody = stale.json() as { shouldTakeOver: boolean; reason: string; reasonFa: string };
    expect(staleBody.shouldTakeOver).toBe(true);
    expect(staleBody.reason).toBe('primary-stale');
    expect(staleBody.reasonFa).toContain('گرهٔ کمکی');

    const overview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/nodes',
      headers: auth(token),
    });
    const body = overview.json() as {
      nodes: { nodeId: string; state: string; heartbeatAgeSeconds: number }[];
      failover: { shouldTakeOver: boolean };
      primary: { healthy: boolean } | null;
    };
    expect(body.nodes[0]!.state).toBe('offline');
    expect(body.nodes[0]!.heartbeatAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(body.primary).toBeNull();
    expect(body.failover.shouldTakeOver).toBe(true);

    // The primary comes back: the helper must park again.
    clock.advanceMinutes(-1);
    await ctx.services.nodes.publishSelf();
    const recovered = await ctx.app.inject({
      method: 'GET',
      url: '/v1/nodes/failover',
      headers: { 'x-node-token': 'test-node-token' },
    });
    expect((recovered.json() as { shouldTakeOver: boolean }).shouldTakeOver).toBe(false);
    await ctx.close();
  });

  it('keeps the panel screen for staff only', async () => {
    const ctx = await createTestContext();
    const customer = await login(ctx, CUSTOMER);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/nodes',
      headers: auth(customer.token),
    });
    expect(response.statusCode).toBe(403);
    await ctx.close();
  });
});

/** Small helper so the helper-node test can read the wall clock explicitly. */
function systemClockOf() {
  return {
    now: () => new Date(),
  };
}
