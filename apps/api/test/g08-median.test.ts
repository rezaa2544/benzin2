import { describe, expect, it } from 'vitest';
import { ManualClock, auth, createTestContext, login } from './helpers.js';
import type { TestContext } from './helpers.js';

/**
 * Task G-08 — «میانگین بازار»: the median price per litre of trades that actually closed in the
 * last 72 hours, per region, and «دادهٔ کافی نیست» below five trades.
 *
 * The point of the task is that asking prices are noisy: these tests therefore drive real trade
 * cycles (reserve → confirm → complete) and then check what the endpoint reports.
 */

const OWNER = '09121110021';
const TAKER = '09121110022';

interface TradeSpec {
  rateToman: number;
  county?: string;
  province?: string;
  litres?: number;
  /** Minutes before "now" the trade was completed. */
  ageMinutes?: number;
}

/**
 * Writes one *closed* trade straight into the repositories: a sell order plus a reservation that
 * ends in COMPLETED. The trade cycle itself is covered by `e4-trade-cycle.test.ts`; here only the
 * resulting rows matter, and going through the repository keeps the fixture short enough to read.
 */
async function trade(
  ctx: TestContext,
  clock: ManualClock,
  ownerId: string,
  takerId: string,
  spec: TradeSpec,
): Promise<void> {
  const createdAt = new Date(clock.now().getTime() - (spec.ageMinutes ?? 0) * 60_000);
  const order = await ctx.repos.orders.create({
    ownerId,
    side: 'SELL',
    tier: 'T1500',
    litres: spec.litres ?? 20,
    rateToman: spec.rateToman,
    zoneId: '2b1f8f6e-9f1a-4c1b-9d0e-7a1c2b3d4e5f',
    province: spec.province ?? 'کردستان',
    county: spec.county ?? 'بانه',
    stationName: null,
    note: null,
    lat: 35.9983,
    lng: 45.8851,
    expiresAt: new Date(clock.now().getTime() + 86_400_000),
  });
  const reservation = await ctx.repos.reservations.createExclusive({
    id: `res-${Math.random().toString(36).slice(2, 10)}`,
    orderId: order.id,
    takerId,
    expiresAt: new Date(clock.now().getTime() + 30 * 60_000),
  });
  if (!reservation) throw new Error('reservation was not created');
  await ctx.repos.reservations.transition(reservation.id, 'PENDING_OWNER', 'CONFIRMED', {
    decidedAt: createdAt,
  });
  await ctx.repos.reservations.transition(reservation.id, 'CONFIRMED', 'COMPLETED', {
    completedAt: createdAt,
  });
}

async function setup(): Promise<{
  ctx: TestContext;
  clock: ManualClock;
  ownerId: string;
  takerId: string;
  token: string;
}> {
  const clock = new ManualClock();
  const ctx = await createTestContext(clock);
  const owner = await login(ctx, OWNER);
  const taker = await login(ctx, TAKER);
  return { ctx, clock, ownerId: owner.userId, takerId: taker.userId, token: owner.token };
}

/** Percent-encoded place filter, so the Persian county names stay readable in the test body. */
const placeQuery = (province?: string, county?: string): string => {
  const params = new URLSearchParams();
  if (province) params.set('province', province);
  if (county) params.set('county', county);
  const query = params.toString();
  return query ? `?${query}` : '';
};

const median = async (ctx: TestContext, token: string, query = ''): Promise<Record<string, unknown>> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/v1/stats/market/median${query}`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
};

describe('72-hour trade median (G-08)', () => {
  it('says «دادهٔ کافی نیست» while fewer than five trades have closed', async () => {
    const { ctx, clock, ownerId, takerId, token } = await setup();
    await trade(ctx, clock, ownerId, takerId, { rateToman: 5000 });
    await trade(ctx, clock, ownerId, takerId, { rateToman: 6000 });

    const body = await median(ctx, token, placeQuery('کردستان'));
    expect(body.trades).toBe(2);
    expect(body.sufficient).toBe(false);
    expect(body.medianRateToman).toBeNull();
    expect(String(body.messageFa)).toContain('دادهٔ کافی نیست');
    expect(body.requiredTrades).toBe(5);
    expect(body.windowHours).toBe(72);
    await ctx.close();
  });

  it('reports the median of closed trades once the sample is big enough', async () => {
    const { ctx, clock, ownerId, takerId, token } = await setup();
    // Five trades, deliberately asymmetric so the median (7000) differs from the mean (6600).
    for (const rate of [5000, 6000, 7000, 8000, 9000]) {
      await trade(ctx, clock, ownerId, takerId, { rateToman: rate });
    }

    const body = await median(ctx, token, placeQuery('کردستان'));
    expect(body.trades).toBe(5);
    expect(body.sufficient).toBe(true);
    expect(body.medianRateToman).toBe(7000);
    expect(String(body.messageFa)).toContain('معاملهٔ انجام‌شده');
    await ctx.close();
  });

  it('ignores asking prices and trades that never closed', async () => {
    const { ctx, clock, ownerId, takerId, token } = await setup();
    for (const rate of [4000, 4000, 4000, 4000, 4000]) {
      await trade(ctx, clock, ownerId, takerId, { rateToman: rate });
    }

    // A very expensive listing that nobody takes, plus a reservation that is confirmed but never
    // completed: neither is a price, so neither may move the median.
    const listing = await ctx.repos.orders.create({
      ownerId,
      side: 'SELL',
      tier: 'T1500',
      litres: 20,
      rateToman: 50_000,
      zoneId: '2b1f8f6e-9f1a-4c1b-9d0e-7a1c2b3d4e5f',
      province: 'کردستان',
      county: 'بانه',
      stationName: null,
      note: null,
      lat: 35.9983,
      lng: 45.8851,
      expiresAt: new Date(clock.now().getTime() + 86_400_000),
    });
    const openReservation = await ctx.repos.reservations.createExclusive({
      id: 'res-unfinished',
      orderId: listing.id,
      takerId,
      expiresAt: new Date(clock.now().getTime() + 30 * 60_000),
    });
    await ctx.repos.reservations.transition(openReservation!.id, 'PENDING_OWNER', 'CONFIRMED', {
      decidedAt: clock.now(),
    });

    const body = await median(ctx, token, placeQuery('کردستان'));
    expect(body.trades).toBe(5);
    expect(body.medianRateToman).toBe(4000);
    await ctx.close();
  });

  it('counts only the last 72 hours', async () => {
    const { ctx, clock, ownerId, takerId, token } = await setup();
    // Four old trades (80 hours ago) and one fresh one: not enough inside the window.
    for (const rate of [2000, 3000, 4000, 5000]) {
      await trade(ctx, clock, ownerId, takerId, { rateToman: rate, ageMinutes: 80 * 60 });
    }
    await trade(ctx, clock, ownerId, takerId, { rateToman: 7000 });

    const body = await median(ctx, token, placeQuery('کردستان'));
    expect(body.trades).toBe(1);
    expect(body.sufficient).toBe(false);
    expect(body.medianRateToman).toBeNull();
    await ctx.close();
  });

  it('splits the median per region and lists the busiest first', async () => {
    const { ctx, clock, ownerId, takerId, token } = await setup();
    for (const rate of [3000, 3000, 3000, 3000, 3000]) {
      await trade(ctx, clock, ownerId, takerId, { rateToman: rate, county: 'بانه' });
    }
    for (const rate of [8000, 9000]) {
      await trade(ctx, clock, ownerId, takerId, { rateToman: rate, county: 'سقز' });
    }

    const national = await median(ctx, token);
    const regions = national.byRegion as {
      county: string | null;
      trades: number;
      medianRateToman: number | null;
      sufficient: boolean;
      labelFa: string;
    }[];
    expect(regions.length).toBe(2);
    expect(regions[0]!.labelFa).toBe('بانه، کردستان');
    expect(regions[0]!.trades).toBe(5);
    expect(regions[0]!.sufficient).toBe(true);
    expect(regions[0]!.medianRateToman).toBe(3000);
    // سقز has two trades: shown, but explicitly not enough to be a median.
    expect(regions[1]!.county).toBe('سقز');
    expect(regions[1]!.sufficient).toBe(false);
    expect(regions[1]!.medianRateToman).toBeNull();

    const district = await median(ctx, token, placeQuery('کردستان', 'سقز'));
    expect(district.trades).toBe(2);
    expect(district.sufficient).toBe(false);
    await ctx.close();
  });

  it('requires a logged-in user', async () => {
    const ctx = await createTestContext();
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/stats/market/median' });
    expect(response.statusCode).toBe(401);
    await ctx.close();
  });
});
