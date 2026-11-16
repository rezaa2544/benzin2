import { describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  freshPhone,
  login,
  ManualClock,
  mintAccessToken,
  orderPayload,
  type TestContext,
} from './helpers.js';
import {
  RESPONSE_MISS_LIMIT,
  RESPONSE_PAUSE_HOURS,
  responseLabelFa,
} from '../src/modules/owner-response-service.js';

/**
 * G-10 — seller answer rate.
 *
 * The acceptance criteria are short and sharp: `answered / received` over 30 days, a badge on the
 * listing card, price-then-rate sorting, three silent requests in a row put the listings on a
 * 24-hour break, and **no negative score** for anyone. The last one is asserted directly: the
 * reputation ledger must be identical before and after a seller ignores three requests.
 *
 * One listing carries most of these tests: a rejected or expired request puts it straight back in
 * the market, which keeps every scenario inside the seller's two-open-listing cap.
 */

interface OrderBody {
  id: string;
  rateToman: number;
  owner: {
    id: string;
    ratePercent: number | null;
    labelFa: string;
    answered: number;
    received: number;
  };
}

interface SearchBody {
  items: OrderBody[];
}

interface ResponseBody {
  ratePercent: number | null;
  answered: number;
  received: number;
  labelFa: string;
  unansweredStreak: number;
  delistedUntil: string | null;
}

const createOrder = async (
  ctx: TestContext,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<OrderBody> => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: auth(token),
    payload: orderPayload(overrides),
  });
  expect(response.statusCode).toBe(201);
  return response.json() as OrderBody;
};

const reserve = async (ctx: TestContext, token: string, orderId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/v1/orders/${orderId}/reservations`,
    headers: auth(token),
  });

const search = async (ctx: TestContext, token: string, sort = 'price'): Promise<SearchBody> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/v1/orders?side=SELL&sort=${sort}`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SearchBody;
};

/** «Received» for one seller is what the reservations put on their desk — read through the API. */
const ownResponse = async (ctx: TestContext, token: string): Promise<ResponseBody> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/v1/me/response',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ResponseBody;
};

const ownerRejects = async (ctx: TestContext, ownerToken: string, reservationId: string) => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reservations/${reservationId}/reject`,
    headers: auth(ownerToken),
  });
  expect(response.statusCode).toBe(200);
};

describe('G-10 seller answer rate', () => {
  it('starts as a newcomer badge on the listing card', async () => {
    const ctx = await createTestContext();
    try {
      const owner = await login(ctx, freshPhone());
      const order = await createOrder(ctx, owner.token);

      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/v1/orders/${order.id}`,
        headers: auth(owner.token),
      });
      const body = detail.json() as OrderBody;
      expect(body.owner.ratePercent).toBeNull();
      expect(body.owner.received).toBe(0);
      expect(body.owner.labelFa).toBe('تازه‌کار');

      // The same badge travels with the market list, not just the detail page.
      const listed = (await search(ctx, owner.token)).items.find((item) => item.id === order.id);
      expect(listed?.owner.labelFa).toBe('تازه‌کار');
    } finally {
      await ctx.close();
    }
  });

  it('counts answered over received and shows the rate once there is a sample', async () => {
    const ctx = await createTestContext();
    try {
      const owner = await login(ctx, freshPhone());
      const listing = await createOrder(ctx, owner.token, { litres: 20 });

      for (let index = 0; index < 3; index += 1) {
        const taker = await login(ctx, freshPhone());
        const created = await reserve(ctx, taker.token, listing.id);
        expect(created.statusCode).toBe(201);
        await ownerRejects(ctx, owner.token, (created.json() as { id: string }).id);
      }

      const mine = await ownResponse(ctx, owner.token);
      expect(mine.received).toBe(3);
      expect(mine.answered).toBe(3);
      expect(mine.ratePercent).toBe(100);
      expect(mine.labelFa).toBe('۱۰۰٪ پاسخ‌دهی');

      const detail = (await ctx.app.inject({
        method: 'GET',
        url: `/v1/orders/${listing.id}`,
        headers: auth(owner.token),
      })).json() as OrderBody;
      expect(detail.owner.ratePercent).toBe(100);
      expect(detail.owner.answered).toBe(3);
      expect(detail.owner.received).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  it('does not count a buyer who cancelled before the seller ever decided', async () => {
    const ctx = await createTestContext();
    try {
      const owner = await login(ctx, freshPhone());
      const listing = await createOrder(ctx, owner.token, { litres: 20 });
      const taker = await login(ctx, freshPhone());
      const created = (await reserve(ctx, taker.token, listing.id)).json() as { id: string };

      const cancelled = await ctx.app.inject({
        method: 'POST',
        url: `/v1/reservations/${created.id}/cancel`,
        headers: auth(taker.token),
        payload: { reason: 'CHANGED_MIND' },
      });
      expect(cancelled.statusCode).toBe(200);

      const mine = await ownResponse(ctx, owner.token);
      // The request never reached the seller's desk, so it is not their silence.
      expect(mine.received).toBe(0);
      expect(mine.ratePercent).toBeNull();
      expect(mine.unansweredStreak).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('sorts by price first and by answer rate on a tie', async () => {
    const ctx = await createTestContext();
    try {
      // The silent seller lists the cheapest lot; the responsive one lists the same price.
      const silent = await login(ctx, freshPhone());
      const responsive = await login(ctx, freshPhone());
      const cheap = await createOrder(ctx, silent.token, { rateToman: 2400, litres: 20 });
      const samePrice = await createOrder(ctx, responsive.token, { rateToman: 2400, litres: 25 });

      // One answered request is enough to beat a seller who never answered.
      const taker = await login(ctx, freshPhone());
      const answered = (await reserve(ctx, taker.token, samePrice.id)).json() as { id: string };
      await ownerRejects(ctx, responsive.token, answered.id);

      const result = await search(ctx, silent.token);
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain(cheap.id);
      expect(ids).toContain(samePrice.id);
      // Equal all-in price → the seller who answers comes first.
      expect(ids.indexOf(samePrice.id)).toBeLessThan(ids.indexOf(cheap.id));
      expect(result.items.find((item) => item.id === samePrice.id)?.owner.ratePercent).toBe(100);
      expect(result.items.find((item) => item.id === cheap.id)?.owner.ratePercent).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('pauses the listings for 24 hours after three silent requests, without touching the score', async () => {
    const clock = new ManualClock();
    const ctx = await createTestContext(clock);
    try {
      const phone = freshPhone();
      let owner = await login(ctx, phone);
      const listing = await createOrder(ctx, owner.token, { litres: 20 });

      const scoreBefore = (await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/reputation',
        headers: auth(owner.token),
      })).json() as { score: number; recentEvents: unknown[] };

      for (let index = 0; index < RESPONSE_MISS_LIMIT; index += 1) {
        const taker = await login(ctx, freshPhone());
        expect((await reserve(ctx, taker.token, listing.id)).statusCode).toBe(201);
        // Nobody answers; the decision window runs out and the scheduler sweeps. Pushing the clock
        // forward also expires the 15-minute access token, so the seller signs in again.
        clock.advanceMinutes(31);
        await ctx.services.reservations.expireDueReservations();
        owner = await login(ctx, phone);
      }

      const mine = await ownResponse(ctx, owner.token);
      expect(mine.unansweredStreak).toBe(RESPONSE_MISS_LIMIT);
      expect(mine.received).toBe(3);
      expect(mine.answered).toBe(0);
      expect(mine.ratePercent).toBe(0);
      expect(mine.delistedUntil).not.toBeNull();

      // The pause is real: the market no longer lists this seller's open orders.
      const market = await search(ctx, owner.token);
      expect(market.items.some((item) => item.id === listing.id)).toBe(false);
      // …but the listing is still theirs: «سفارش‌های من» keeps working through the pause.
      const own = await ctx.app.inject({
        method: 'GET',
        url: '/v1/orders/mine',
        headers: auth(owner.token),
      });
      const ownItems = (own.json() as { items: { id: string }[] }).items;
      expect(ownItems.some((item) => item.id === listing.id)).toBe(true);

      // …and it is not a punishment: the trust ledger gained nothing at all.
      const scoreAfter = (await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/reputation',
        headers: auth(owner.token),
      })).json() as { score: number; recentEvents: unknown[] };
      expect(scoreAfter.score).toBe(scoreBefore.score);
      expect(scoreAfter.recentEvents.length).toBe(scoreBefore.recentEvents.length);

      // A day later the pause lifts by itself.
      clock.advanceHours(RESPONSE_PAUSE_HOURS + 1);
      owner = await login(ctx, phone);
      expect(await ctx.services.ownerResponse.liftDuePauses()).toBe(1);
      const after = await ownResponse(ctx, owner.token);
      expect(after.delistedUntil).toBeNull();
      expect(after.unansweredStreak).toBe(0);
      // The old listing has run into its own expiry by now, so the seller posts a new one: it must
      // appear in the market straight away, which is the whole point of lifting the pause.
      const fresh = await createOrder(ctx, owner.token, { litres: 22 });
      const back = await search(ctx, owner.token);
      expect(back.items.some((item) => item.id === fresh.id)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('lets support review and release a pause, and refuses to release one that is not there', async () => {
    const clock = new ManualClock();
    const ctx = await createTestContext(clock);
    try {
      const phone = freshPhone();
      let owner = await login(ctx, phone);
      const listing = await createOrder(ctx, owner.token, { litres: 20 });
      const staff = await ctx.repos.users.create({ phone: freshPhone(), role: 'ADMIN' });
      const staffToken = mintAccessToken(staff);

      for (let index = 0; index < RESPONSE_MISS_LIMIT; index += 1) {
        const taker = await login(ctx, freshPhone());
        await reserve(ctx, taker.token, listing.id);
        clock.advanceMinutes(31);
        await ctx.services.reservations.expireDueReservations();
        owner = await login(ctx, phone);
      }

      const queue = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/listing-pauses',
        headers: auth(staffToken),
      });
      expect(queue.statusCode).toBe(200);
      const body = queue.json() as {
        items: { id: string; reasonFa: string; until: string; response: { answered: number } }[];
        total: number;
      };
      const row = body.items.find((item) => item.id === owner.userId);
      expect(row).toBeDefined();
      expect(row!.reasonFa).toContain('بی‌پاسخ');
      expect(row!.until).toBeTruthy();
      expect(row!.response.answered).toBe(0);
      expect(body.total).toBe(1);

      const released = await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/users/${owner.userId}/relist`,
        headers: auth(staffToken),
      });
      expect(released.statusCode).toBe(200);
      expect((released.json() as { delistedUntil: string | null }).delistedUntil).toBeNull();

      const again = await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/users/${owner.userId}/relist`,
        headers: auth(staffToken),
      });
      expect(again.statusCode).toBe(409);
      expect((again.json() as { error: { code: string } }).error.code).toBe('NOT_DELISTED');

      // The release is in the audit log like every other moderation act.
      const audit = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/audit?action=owner.relisted',
        headers: auth(staffToken),
      });
      expect(audit.statusCode).toBe(200);
      const entries = (audit.json() as { items: { entityId: string }[] }).items;
      expect(entries.some((entry) => entry.entityId === owner.userId)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('needs a staff account to see the pause queue', async () => {
    const ctx = await createTestContext();
    try {
      const user = await login(ctx, freshPhone());
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/listing-pauses',
        headers: auth(user.token),
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  it('writes the badge copy in Persian and stays honest about small samples', () => {
    expect(responseLabelFa(0, null)).toBe('تازه‌کار');
    expect(responseLabelFa(1, 100)).toBe('کم‌سابقه');
    expect(responseLabelFa(4, 75)).toBe('۷۵٪ پاسخ‌دهی');
  });
});
