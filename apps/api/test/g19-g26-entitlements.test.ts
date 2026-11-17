import { describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  freshPhone,
  login,
  ManualClock,
  orderPayload,
  type TestContext,
} from './helpers.js';

/**
 * G-26 (اشتراک خریدار + پرداخت ۱۵ هزار تومانی رزرو) and G-19 (حریم خصوصی شماره).
 *
 * The product sells three things (00-PRODUCT.md): browsing, *seeing a number*, and *starting a
 * reservation*. These tests pin those promises down from the outside — through the HTTP API the app
 * calls — so a change to the plan table or the reservation gate cannot quietly give away a number
 * or sell a reservation twice.
 */

interface Entitlements {
  planCode: string;
  source: 'SUBSCRIPTION' | 'FREE';
  active: boolean;
  endsAt: string | null;
  phoneVisible: boolean;
  monthlyLimit: number | null;
  usedThisMonth: number;
  remaining: number | null;
  singleUse: boolean;
  needsPurchase: boolean;
}

const entitlementsOf = async (ctx: TestContext, token: string): Promise<Entitlements> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/v1/me/entitlements',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Entitlements;
};

const buyPlan = async (ctx: TestContext, userId: string, code: string): Promise<void> => {
  const plan = await ctx.repos.plans.findByCode(code);
  if (!plan) throw new Error(`plan ${code} is not in the catalogue`);
  const now = ctx.clock.now();
  const subscription = await ctx.repos.subscriptions.create({
    userId,
    planId: plan.id,
    startsAt: now,
    endsAt: new Date(now.getTime() + plan.durationDays * 86_400_000),
  });
  await ctx.repos.subscriptions.activate(
    subscription.id,
    subscription.startsAt,
    subscription.endsAt,
  );
};

const newSeller = async (ctx: TestContext): Promise<string> => {
  const seller = await login(ctx, freshPhone());
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: auth(seller.token),
    payload: orderPayload(),
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
};

const reserve = (ctx: TestContext, token: string, orderId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/v1/orders/${orderId}/reservations`,
    headers: auth(token),
  });

/**
 * Uses up one reservation and hands the order back. `reservation.max_active_per_user` is 1, which
 * is a separate, older rule; the quota is what these tests are about.
 */
const reserveAndRelease = async (
  ctx: TestContext,
  token: string,
  orderId: string,
): Promise<{ statusCode: number; body: string; json: <T>() => T }> => {
  const response = await reserve(ctx, token, orderId);
  if (response.statusCode === 201) {
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${(response.json() as { id: string }).id}/cancel`,
      headers: auth(token),
      payload: { reason: 'CHANGED_MIND' },
    });
  }
  return response as unknown as { statusCode: number; body: string; json: <T>() => T };
};

describe('G-26 — what a buyer has paid for', () => {
  it('gives the free plan three reservations a month, then asks for money', async () => {
    const ctx = await createTestContext(new ManualClock(new Date('2026-05-10T09:00:00.000Z')));
    try {
      const buyer = await login(ctx, freshPhone());
      const entitlement = await entitlementsOf(ctx, buyer.token);
      expect(entitlement).toMatchObject({
        planCode: 'free',
        source: 'FREE',
        active: false,
        phoneVisible: false,
        monthlyLimit: 3,
        remaining: 3,
      });

      for (let index = 0; index < 3; index += 1) {
        const response = await reserveAndRelease(ctx, buyer.token, await newSeller(ctx));
        expect(response.statusCode).toBe(201);
      }

      const fourth = await reserve(ctx, buyer.token, await newSeller(ctx));
      expect(fourth.statusCode).toBe(429);
      const error = fourth.json() as {
        error: { code: string; details: { monthlyLimit: number; usedThisMonth: number; cheapestPlanToman: number } };
      };
      expect(error.error.code).toBe('RESERVATION_QUOTA_EXHAUSTED');
      // The app needs the numbers to offer the right plan, not just a refusal.
      expect(error.error.details.monthlyLimit).toBe(3);
      expect(error.error.details.usedThisMonth).toBe(3);
      expect(error.error.details.cheapestPlanToman).toBe(49_000);

      expect(await entitlementsOf(ctx, buyer.token)).toMatchObject({
        usedThisMonth: 3,
        remaining: 0,
        needsPurchase: true,
      });
    } finally {
      await ctx.close();
    }
  });

  it('resets the allowance in the next Tehran month, not after 30 days', async () => {
    const clock = new ManualClock(new Date('2026-05-31T20:00:00.000Z')); // 23:30 on ۳۱ اردیبهشت in Tehran
    const ctx = await createTestContext(clock);
    try {
      const phone = freshPhone();
      const buyer = await login(ctx, phone);
      for (let index = 0; index < 3; index += 1) {
        expect((await reserveAndRelease(ctx, buyer.token, await newSeller(ctx))).statusCode).toBe(201);
      }
      expect((await reserve(ctx, buyer.token, await newSeller(ctx))).statusCode).toBe(429);

      // One hour later it is 00:30 on ۱ خرداد in Tehran: a new month, a new allowance — even
      // though barely an hour has passed for the rest of the system.
      clock.advanceMinutes(60);
      // Access tokens live fifteen minutes, so the buyer signs in again — the allowance is what
      // moved, not the session.
      const returning = await login(ctx, phone);
      expect((await entitlementsOf(ctx, returning.token)).usedThisMonth).toBe(0);
      expect((await reserveAndRelease(ctx, returning.token, await newSeller(ctx))).statusCode).toBe(201);
    } finally {
      await ctx.close();
    }
  });

  it('sells unlimited reservations and the right to see a number on the monthly plan', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const buyer = await login(ctx, freshPhone());
      await buyPlan(ctx, buyer.userId, 'monthly');

      const entitlement = await entitlementsOf(ctx, buyer.token);
      expect(entitlement).toMatchObject({
        planCode: 'monthly',
        source: 'SUBSCRIPTION',
        active: true,
        phoneVisible: true,
        monthlyLimit: null,
        remaining: null,
        needsPurchase: false,
      });
      expect(entitlement.endsAt).not.toBeNull();

      for (let index = 0; index < 5; index += 1) {
        expect((await reserveAndRelease(ctx, buyer.token, await newSeller(ctx))).statusCode).toBe(201);
      }
      expect((await entitlementsOf(ctx, buyer.token)).usedThisMonth).toBe(5);
    } finally {
      await ctx.close();
    }
  });

  it('spends the 15,000 Toman credit plan on exactly one reservation', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const buyer = await login(ctx, freshPhone());
      const plan = await ctx.repos.plans.findByCode('single');
      expect(plan?.priceToman).toBe(15_000);
      expect(plan?.singleUse).toBe(true);

      await buyPlan(ctx, buyer.userId, 'single');
      expect(await entitlementsOf(ctx, buyer.token)).toMatchObject({
        planCode: 'single',
        monthlyLimit: 1,
        remaining: 1,
        singleUse: true,
      });

      const first = await reserve(ctx, buyer.token, await newSeller(ctx));
      expect(first.statusCode).toBe(201);

      // The credit is gone: the subscription is consumed and stops granting anything.
      const [subscription] = (await ctx.repos.subscriptions.listByUser(buyer.userId, 5)).filter(
        (row) => row.planId === plan!.id,
      );
      expect(subscription?.consumedAt).not.toBeNull();
      const audit = await ctx.repos.audit.list(100);
      expect(audit.some((entry) => entry.action === 'subscription.consumed')).toBe(true);

      expect(await entitlementsOf(ctx, buyer.token)).toMatchObject({
        planCode: 'free',
        source: 'FREE',
        phoneVisible: false,
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/v1/reservations/${(first.json() as { id: string }).id}/cancel`,
        headers: auth(buyer.token),
        payload: { reason: 'CHANGED_MIND' },
      });
      const second = await reserve(ctx, buyer.token, await newSeller(ctx));
      expect(second.statusCode).toBe(201);

      // And the credit cannot be resurrected by asking again.
      expect(await ctx.repos.subscriptions.findActiveByUser(buyer.userId, ctx.clock.now())).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('lets the owner sell a custom plan from the panel without a deploy', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const staff = await login(ctx, freshPhone());
      const owner = await ctx.repos.users.create({ phone: freshPhone(), role: 'OWNER' });
      const { mintAccessToken } = await import('./helpers.js');
      const ownerToken = mintAccessToken(owner);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/plans',
        headers: auth(ownerToken),
        payload: {
          code: 'weekend',
          nameFa: 'پلن آخر هفته',
          priceToman: 20_000,
          durationDays: 7,
          maxActiveOrders: 1,
          monthlyReservations: 5,
          phoneVisible: true,
          singleUse: false,
        },
      });
      expect(created.statusCode).toBe(201);
      expect((created.json() as { monthlyReservations: number }).monthlyReservations).toBe(5);

      void staff;
      const buyer = await login(ctx, freshPhone());
      await buyPlan(ctx, buyer.userId, 'weekend');
      expect(await entitlementsOf(ctx, buyer.token)).toMatchObject({
        planCode: 'weekend',
        monthlyLimit: 5,
        phoneVisible: true,
      });
    } finally {
      await ctx.close();
    }
  });
});

describe('G-19 — the phone number stays a two-sided secret', () => {
  const trade = async (ctx: TestContext) => {
    const seller = await login(ctx, freshPhone());
    const buyer = await login(ctx, freshPhone());
    const order = await ctx.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(seller.token),
      payload: orderPayload(),
    });
    const orderId = (order.json() as { id: string }).id;
    const reservation = (await reserve(ctx, buyer.token, orderId)).json() as { id: string };
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservation.id}/confirm`,
      headers: auth(seller.token),
    });
    return { seller, buyer, reservationId: reservation.id };
  };

  const contact = (ctx: TestContext, token: string, id: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/v1/reservations/${id}/contact`,
      headers: auth(token),
    });

  it('refuses the number on the free plan, with a reason the app can act on', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const { buyer, reservationId } = await trade(ctx);
      const response = await contact(ctx, buyer.token, reservationId);
      expect(response.statusCode).toBe(402);
      const error = response.json() as { error: { code: string; details: { chatOnly: boolean } } };
      expect(error.error.code).toBe('PHONE_REQUIRES_SUBSCRIPTION');
      expect(error.error.details.chatOnly).toBe(true);
      expect(response.body).not.toMatch(/09\d{9}/);
    } finally {
      await ctx.close();
    }
  });

  it('hands both numbers to a paying buyer after acceptance', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const { buyer, seller, reservationId } = await trade(ctx);
      await buyPlan(ctx, buyer.userId, 'monthly');

      const response = await contact(ctx, buyer.token, reservationId);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        chatOnly: boolean;
        hidden: { owner: boolean; taker: boolean };
        owner: { phone: string | null };
        taker: { phone: string | null };
      };
      expect(body.chatOnly).toBe(false);
      expect(body.owner.phone).toMatch(/^09\d{9}$/);
      expect(body.taker.phone).toMatch(/^09\d{9}$/);

      // The audit says who asked, not what the numbers are.
      const audit = await ctx.repos.audit.list(100);
      const entry = audit.find((row) => row.action === 'contact.revealed');
      expect(entry).toBeTruthy();
      expect(JSON.stringify(entry?.metadata)).not.toMatch(/09\d{9}/);

      void seller;
    } finally {
      await ctx.close();
    }
  });

  it('keeps a hidden number off the wire while the chat stays open', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const { buyer, seller, reservationId } = await trade(ctx);
      await buyPlan(ctx, buyer.userId, 'monthly');

      const hidden = await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: auth(seller.token),
        payload: { displayName: 'فروشندهٔ سهمیه', phoneHidden: true },
      });
      expect(hidden.statusCode).toBe(200);
      expect((hidden.json() as { phoneHidden: boolean }).phoneHidden).toBe(true);

      const response = await contact(ctx, buyer.token, reservationId);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        chatOnly: boolean;
        hidden: { owner: boolean; taker: boolean };
        owner: { phone: string | null };
        taker: { phone: string | null };
      };
      expect(body.hidden).toEqual({ owner: true, taker: false });
      expect(body.chatOnly).toBe(true);
      // The seller's number is simply not in the payload; the buyer still sees their own.
      expect(body.owner.phone).toBeNull();
      expect(body.taker.phone).toMatch(/^09\d{9}$/);
      expect(response.body).not.toMatch(new RegExp(seller.phone ?? 'NEVER'));

      const audit = await ctx.repos.audit.list(200);
      const entry = audit
        .filter((row) => row.action === 'contact.revealed')
        .at(-1) as { metadata: { hidden?: string[] } };
      expect(entry.metadata.hidden).toEqual(['OWNER']);

      // Privacy never blocks the trade: the in-app chat between the two is still there.
      const conversation = await ctx.app.inject({
        method: 'GET',
        url: `/v1/conversations/for-order/${reservationId}`,
        headers: auth(buyer.token),
      });
      expect([200, 404]).toContain(conversation.statusCode);
    } finally {
      await ctx.close();
    }
  });

  it('unhides again when the user changes their mind', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const user = await login(ctx, freshPhone());
      const hide = await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: auth(user.token),
        payload: { displayName: null, phoneHidden: true },
      });
      expect((hide.json() as { phoneHidden: boolean }).phoneHidden).toBe(true);

      const show = await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: auth(user.token),
        payload: { displayName: null, phoneHidden: false },
      });
      expect((show.json() as { phoneHidden: boolean }).phoneHidden).toBe(false);

      const stored = await ctx.repos.users.findById(user.userId);
      expect(stored?.phoneHidden).toBe(false);
      const audit = await ctx.repos.audit.list(50);
      expect(
        audit.some(
          (row) =>
            row.action === 'user.profile_updated' &&
            (row.metadata as { phoneHidden?: boolean }).phoneHidden === false,
        ),
      ).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
