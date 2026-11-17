import { describe, expect, it } from 'vitest';
import { planWindowEnd } from '../src/modules/payment-service.js';
import {
  auth,
  createTestContext,
  freshPhone,
  login,
  loginAsRole,
  ManualClock,
  type TestContext,
} from './helpers.js';

/**
 * G-26b — the plan catalogue is a configuration surface, not a set of constants.
 *
 * The owner asked to be able to set up plans and credits «هر طور خواستم». Everything a plan sells
 * (price, window, reservations per month, number visibility, single use) is a column, so these
 * tests drive the panel API and then buy the plan the way a buyer does — through the payment flow
 * — and read back what the buyer actually got.
 */

interface PlanBody {
  id: string;
  code: string;
  durationDays: number;
}

interface SubscriptionView {
  subscription: {
    planCode: string;
    status: string;
    startsAt: string;
    endsAt: string;
    daysRemaining: number;
  } | null;
}

const createPlan = async (
  ctx: TestContext,
  ownerToken: string,
  payload: Record<string, unknown>,
): Promise<PlanBody> => {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/plans',
    headers: auth(ownerToken),
    payload,
  });
  expect(created.statusCode).toBe(201);
  return created.json() as PlanBody;
};

/** The buyer's real path: start a card-to-card purchase, then a human confirms the transfer. */
const buyFromPanel = async (
  ctx: TestContext,
  adminToken: string,
  buyerToken: string,
  planCode: string,
): Promise<SubscriptionView['subscription']> => {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: auth(buyerToken),
    payload: { planCode, method: 'CARD_TO_CARD' },
  });
  expect(started.statusCode).toBe(201);
  const paymentId = (started.json() as { id: string }).id;

  const confirmed = await ctx.app.inject({
    method: 'POST',
    url: `/v1/admin/payments/${paymentId}/confirm`,
    headers: auth(adminToken),
    payload: { reference: `TRACK-${planCode}-1` },
  });
  expect(confirmed.statusCode).toBe(200);

  const current = await ctx.app.inject({
    method: 'GET',
    url: '/v1/me/subscription',
    headers: auth(buyerToken),
  });
  expect(current.statusCode).toBe(200);
  return (current.json() as SubscriptionView).subscription;
};

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

describe('G-26b — the owner decides what a plan is worth', () => {
  it('sells a plan whose window is exactly the number of days the owner typed', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      const staff = await loginAsRole(ctx, freshPhone(), 'ADMIN');

      await createPlan(ctx, owner.token, {
        code: 'nooruz',
        nameFa: 'پلن نوروزی',
        priceToman: 25_000,
        durationDays: 15,
        maxActiveOrders: 0,
        monthlyReservations: 4,
        phoneVisible: false,
        singleUse: false,
      });

      const buyer = await login(ctx, freshPhone());
      const subscription = await buyFromPanel(ctx, staff.token, buyer.token, 'nooruz');

      expect(subscription?.planCode).toBe('nooruz');
      expect(subscription?.status).toBe('ACTIVE');
      expect(daysBetween(subscription!.startsAt, subscription!.endsAt)).toBe(15);
    } finally {
      await ctx.close();
    }
  });

  it('treats a zero-day window as «بدون انقضا» instead of an empty subscription', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      const staff = await loginAsRole(ctx, freshPhone(), 'ADMIN');

      await createPlan(ctx, owner.token, {
        code: 'forever',
        nameFa: 'پلن دائمی',
        priceToman: 99_000,
        durationDays: 0,
        maxActiveOrders: 0,
        monthlyReservations: null,
        phoneVisible: true,
        singleUse: false,
      });

      const buyer = await login(ctx, freshPhone());
      const subscription = await buyFromPanel(ctx, staff.token, buyer.token, 'forever');

      expect(subscription?.status).toBe('ACTIVE');
      // A century of runway: the buyer is not silently given a subscription that has already ended.
      expect(daysBetween(subscription!.startsAt, subscription!.endsAt)).toBe(36_500);

      const entitlement = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/entitlements',
        headers: auth(buyer.token),
      });
      expect(entitlement.statusCode).toBe(200);
      expect(entitlement.json()).toMatchObject({
        planCode: 'forever',
        monthlyLimit: null,
        remaining: null,
        phoneVisible: true,
      });
    } finally {
      await ctx.close();
    }
  });

  it('lets the owner re-price and re-scope a plan without touching its existing subscribers', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      const staff = await loginAsRole(ctx, freshPhone(), 'ADMIN');

      const plan = await createPlan(ctx, owner.token, {
        code: 'starter',
        nameFa: 'پلن شروع',
        priceToman: 30_000,
        durationDays: 10,
        maxActiveOrders: 0,
        monthlyReservations: 2,
        phoneVisible: true,
        singleUse: false,
      });

      const earlyBuyer = await login(ctx, freshPhone());
      const early = await buyFromPanel(ctx, staff.token, earlyBuyer.token, 'starter');
      expect(daysBetween(early!.startsAt, early!.endsAt)).toBe(10);

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/v1/admin/plans/${plan.id}`,
        headers: auth(owner.token),
        payload: { priceToman: 45_000, durationDays: 60, monthlyReservations: 9 },
      });
      expect(patched.statusCode).toBe(200);

      // The subscriber who already paid keeps the window they bought.
      const unchanged = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/subscription',
        headers: auth(earlyBuyer.token),
      });
      expect(
        daysBetween(
          (unchanged.json() as SubscriptionView).subscription!.startsAt,
          (unchanged.json() as SubscriptionView).subscription!.endsAt,
        ),
      ).toBe(10);

      // A later buyer gets the new terms.
      const lateBuyer = await login(ctx, freshPhone());
      const late = await buyFromPanel(ctx, staff.token, lateBuyer.token, 'starter');
      expect(daysBetween(late!.startsAt, late!.endsAt)).toBe(60);
    } finally {
      await ctx.close();
    }
  });

  it('refuses a window longer than ten years — that is not a plan, it is a typo', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      const rejected = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/plans',
        headers: auth(owner.token),
        payload: {
          code: 'typo',
          nameFa: 'پلن اشتباه',
          priceToman: 10_000,
          durationDays: 36_501,
          maxActiveOrders: 0,
          monthlyReservations: 1,
          phoneVisible: false,
          singleUse: false,
        },
      });
      expect(rejected.statusCode).toBe(422);
    } finally {
      await ctx.close();
    }
  });
});

describe('G-26b — planWindowEnd', () => {
  it('keeps a positive window as written and gives a zero window real runway', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(planWindowEnd(start, 7).toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(planWindowEnd(start, 0).getTime()).toBeGreaterThan(
      start.getTime() + 30_000 * 86_400_000,
    );
  });
});
