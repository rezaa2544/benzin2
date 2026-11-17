import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@benzin/shared';
import {
  auth,
  createTestContext,
  login,
  ManualClock,
  orderPayload,
  type TestContext,
} from './helpers.js';

let phoneSeq = 0;

/** G-26: hands a user an active subscription for the named plan. */
const givePlan = async (ctx: TestContext, userId: string, code: string): Promise<void> => {
  const plan = await ctx.repos.plans.findByCode(code);
  if (!plan) throw new Error(`plan ${code} missing`);
  const subscription = await ctx.repos.subscriptions.create({
    userId,
    planId: plan.id,
    startsAt: new Date(),
    endsAt: new Date(Date.now() + plan.durationDays * 86_400_000),
  });
  await ctx.repos.subscriptions.activate(
    subscription.id,
    subscription.startsAt,
    subscription.endsAt,
  );
};

/** A brand new seller per test: the open-order cap is per user, not per test context. */
const newOwner = async (ctx: TestContext): Promise<string> =>
  (await login(ctx, `0912${String(6_000_000 + phoneSeq++).padStart(7, '0')}`)).token;

const createOrder = async (ctx: TestContext, token: string): Promise<string> => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: auth(token),
    payload: orderPayload(),
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  return (response.json() as { id: string }).id;
};

describe('reservations', () => {
  let ctx: TestContext;
  let ownerToken: string;
  let takerToken: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    ownerToken = (await login(ctx, '09121000001')).token;
    const taker = await login(ctx, '09121000002');
    takerToken = taker.token;
    void ownerToken;
    // G-26: this shared buyer reserves in almost every test in this file, so they hold a plan with
    // no monthly cap. The allowance itself is exercised in its own file.
    await givePlan(ctx, taker.userId, 'monthly');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('walks the full happy path: request → accept → complete', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);

    const requested = await ctx.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/reservations`,
      headers: auth(takerToken),
    });
    expect(requested.statusCode).toBe(201);
    const reservation = requested.json() as { id: string; status: string };
    expect(reservation.status).toBe('PENDING_OWNER');

    const orderAfterReserve = await ctx.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: auth(ownerToken),
    });
    expect((orderAfterReserve.json() as { status: string }).status).toBe('RESERVED');

    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservation.id}/confirm`,
      headers: auth(ownerToken),
    });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { status: string }).status).toBe('CONFIRMED');

    const completed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservation.id}/complete`,
      headers: auth(takerToken),
    });
    expect(completed.statusCode).toBe(200);
    expect((completed.json() as { status: string }).status).toBe('COMPLETED');

    const order = await ctx.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: auth(ownerToken),
    });
    expect((order.json() as { status: string }).status).toBe('COMPLETED');
  });

  it('blocks self-reservation of your own order', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/reservations`,
      headers: auth(ownerToken),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('TRADE_CYCLE_BLOCKED');
  });

  it('releasing a rejected request re-opens the order', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);
    const requested = await ctx.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/reservations`,
      headers: auth(takerToken),
    });
    const reservationId = (requested.json() as { id: string }).id;

    const rejected = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/reject`,
      headers: auth(ownerToken),
    });
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as { status: string }).status).toBe('REJECTED');

    const order = await ctx.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: auth(ownerToken),
    });
    expect((order.json() as { status: string }).status).toBe('OPEN');
  });

  it('records who cancelled a confirmed trade', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);
    const requested = await ctx.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/reservations`,
      headers: auth(takerToken),
    });
    const reservationId = (requested.json() as { id: string }).id;
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/confirm`,
      headers: auth(ownerToken),
    });

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/cancel`,
      headers: auth(takerToken),
      payload: { reason: 'OWNER_UNRESPONSIVE' },
    });
    expect((cancelled.json() as { status: string; cancelReason: string }).status).toBe(
      'CANCELLED_BY_TAKER',
    );
    expect((cancelled.json() as { cancelReason: string }).cancelReason).toBe('OWNER_UNRESPONSIVE');
  });

  it('allows exactly one taker when fifty reserve the same order concurrently', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);
    const takers = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const phone = `0912${String(5000000 + index).padStart(7, '0')}`;
        const { token } = await login(ctx, phone);
        return token;
      }),
    );

    const results = await Promise.all(
      takers.map((token) =>
        ctx.app.inject({
          method: 'POST',
          url: `/v1/orders/${orderId}/reservations`,
          headers: auth(token),
        }),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const conflicts = results.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(49);

    const active = await ctx.repos.reservations.findActiveByOrder(orderId);
    expect(active).not.toBeNull();
  });

  it('expires a stale pending request and re-opens the order', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);
    const requested = await ctx.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/reservations`,
      headers: auth(takerToken),
    });
    const reservationId = (requested.json() as { id: string }).id;

    const farFuture = { now: () => new Date(Date.now() + 60 * 60 * 1000) };
    const { ReservationService } = await import('../src/modules/reservations-service.js');
    const { SettingsService } = await import('../src/modules/settings-service.js');
    const service = new ReservationService(ctx.repos, new SettingsService(ctx.repos), farFuture);
    expect(await service.expireDueReservations()).toBeGreaterThanOrEqual(1);

    const order = await ctx.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: auth(ownerToken),
    });
    expect((order.json() as { status: string }).status).toBe('OPEN');

    const late = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/confirm`,
      headers: auth(ownerToken),
    });
    expect(late.statusCode).toBe(409);
    expect((late.json() as { error: { code: string } }).error.code).toBe('ALREADY_DECIDED');
    expect(new AppError('CONFLICT', 409, 'x').httpStatus).toBe(409);
  });

  it('hides a reservation from unrelated users', async () => {
    const ownerToken = await newOwner(ctx);
    const orderId = await createOrder(ctx, ownerToken);
    const requested = await ctx.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/reservations`,
      headers: auth(takerToken),
    });
    const reservationId = (requested.json() as { id: string }).id;

    const outsider = (await login(ctx, '09121000009')).token;
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reservations/${reservationId}`,
      headers: auth(outsider),
    });
    expect(response.statusCode).toBe(403);
  });

  it('gives every new reservation the 30-minute window from settings (G-04)', async () => {
    const clock = new ManualClock();
    const scoped = await createTestContext(clock);
    try {
      const seller = (await login(scoped, '09121100001')).token;
      const buyer = (await login(scoped, '09121100002')).token;
      const orderId = await createOrder(scoped, seller);
      const requested = await scoped.app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/reservations`,
        headers: auth(buyer),
      });
      expect(requested.statusCode).toBe(201);
      const reservation = requested.json() as { expiresAt: string; extensionCount: number };
      expect(reservation.extensionCount).toBe(0);
      const minutes = (new Date(reservation.expiresAt).getTime() - clock.now().getTime()) / 60_000;
      expect(minutes).toBe(30);
    } finally {
      await scoped.close();
    }
  });

  it('allows exactly one 10-minute extension, then refuses with 409 (G-04)', async () => {
    const clock = new ManualClock();
    const scoped = await createTestContext(clock);
    try {
      const seller = (await login(scoped, '09121110001')).token;
      const buyer = (await login(scoped, '09121110002')).token;
      const orderId = await createOrder(scoped, seller);
      const requested = await scoped.app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/reservations`,
        headers: auth(buyer),
      });
      const reservation = requested.json() as { id: string; expiresAt: string };
      const before = new Date(reservation.expiresAt).getTime();

      const extended = await scoped.app.inject({
        method: 'POST',
        url: `/v1/reservations/${reservation.id}/extend`,
        headers: auth(buyer),
      });
      expect(extended.statusCode).toBe(200);
      const body = extended.json() as { expiresAt: string; extensionCount: number };
      expect(body.extensionCount).toBe(1);
      expect(new Date(body.expiresAt).getTime() - before).toBe(10 * 60_000);

      const again = await scoped.app.inject({
        method: 'POST',
        url: `/v1/reservations/${reservation.id}/extend`,
        headers: auth(buyer),
      });
      expect(again.statusCode).toBe(409);
      expect((again.json() as { error: { code: string } }).error.code).toBe(
        'EXTENSION_LIMIT_REACHED',
      );
    } finally {
      await scoped.close();
    }
  });

  it('refuses an extension from the owner and after the deadline (G-04)', async () => {
    const clock = new ManualClock();
    const scoped = await createTestContext(clock);
    try {
      const seller = (await login(scoped, '09121120001')).token;
      const buyer = (await login(scoped, '09121120002')).token;
      const orderId = await createOrder(scoped, seller);
      const requested = await scoped.app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/reservations`,
        headers: auth(buyer),
      });
      const reservationId = (requested.json() as { id: string }).id;

      const byOwner = await scoped.app.inject({
        method: 'POST',
        url: `/v1/reservations/${reservationId}/extend`,
        headers: auth(seller),
      });
      expect(byOwner.statusCode).toBe(403);
      expect((byOwner.json() as { error: { code: string } }).error.code).toBe(
        'NOT_RESERVATION_TAKER',
      );

      clock.advanceMinutes(31);
      // Access tokens expire in minutes, so the buyer signs in again before the late attempt.
      const lateBuyer = (await login(scoped, '09121120002')).token;
      const late = await scoped.app.inject({
        method: 'POST',
        url: `/v1/reservations/${reservationId}/extend`,
        headers: auth(lateBuyer),
      });
      expect(late.statusCode).toBe(409);
      expect((late.json() as { error: { code: string } }).error.code).toBe(
        'RESERVATION_NOT_ACTIVE',
      );
    } finally {
      await scoped.close();
    }
  });

  it('offers to book the same order again after an expiry (G-04)', async () => {
    const clock = new ManualClock();
    const scoped = await createTestContext(clock);
    try {
      const seller = (await login(scoped, '09121130001')).token;
      const buyer = (await login(scoped, '09121130002')).token;
      const orderId = await createOrder(scoped, seller);
      await scoped.app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/reservations`,
        headers: auth(buyer),
      });

      const empty = await scoped.app.inject({
        method: 'GET',
        url: '/v1/reservations/rebook-hint',
        headers: auth(buyer),
      });
      expect(empty.statusCode).toBe(200);
      expect((empty.json() as { hint: unknown }).hint).toBeNull();

      clock.advanceMinutes(31);
      await scoped.services.reservations.expireDueReservations();
      const again = (await login(scoped, '09121130002')).token;

      const hint = await scoped.app.inject({
        method: 'GET',
        url: '/v1/reservations/rebook-hint',
        headers: auth(again),
      });
      expect(hint.statusCode).toBe(200);
      const body = hint.json() as { hint: { orderId: string } | null };
      expect(body.hint?.orderId).toBe(orderId);

      // The order is bookable again exactly as the prompt promises.
      const rebooked = await scoped.app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/reservations`,
        headers: auth(again),
      });
      expect(rebooked.statusCode).toBe(201);
    } finally {
      await scoped.close();
    }
  });
});
