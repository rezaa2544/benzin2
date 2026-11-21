import { describe, expect, it } from 'vitest';
import {
  DELIVERY_CODE_ATTEMPTS,
  DELIVERY_CODE_LOCK_MS,
} from '../src/modules/reservations-service.js';
import { ManualClock, createTestContext, login, type TestContext } from './helpers.js';

/**
 * G-09 — the four-digit hand-over code.
 *
 * Acceptance (docs/benzin2/06-TASKS.md): the code is minted when the trade is matched, only the
 * buyer can see it, the seller closes the trade by typing it, and three wrong codes arm a
 * ten-minute lock (plus an audit entry). These tests drive the real HTTP routes, because the whole
 * feature is about who may call what.
 */

const OWNER = '09121110001';
const BUYER = '09121110002';
const OUTSIDER = '09121110003';
const ZONE_ID = '2b1f8f6e-9f1a-4c1b-9d0e-7a1c2b3d4e5f';

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface Session {
  ctx: TestContext;
  clock: ManualClock;
  owner: { token: string; userId: string };
  buyer: { token: string; userId: string };
  outsider: { token: string; userId: string };
}

async function setup(): Promise<Session> {
  const clock = new ManualClock();
  const ctx = await createTestContext(clock);
  return {
    ctx,
    clock,
    owner: await login(ctx, OWNER),
    buyer: await login(ctx, BUYER),
    outsider: await login(ctx, OUTSIDER),
  };
}

/** Owner lists 20 litres, buyer reserves, owner accepts — i.e. the reservation reaches CONFIRMED. */
async function matchedTrade(session: Session): Promise<{ orderId: string; reservationId: string }> {
  const { ctx, owner, buyer } = session;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: auth(owner.token),
    payload: {
      side: 'SELL',
      tier: 'T1500',
      litres: 20,
      rateToman: 1400,
      zoneId: ZONE_ID,
      province: 'کردستان',
      county: 'بانه',
      stationName: 'جایگاه بانه',
    },
  });
  expect(created.statusCode).toBe(201);
  const orderId = (created.json() as { id: string }).id;

  const reserved = await ctx.app.inject({
    method: 'POST',
    url: `/v1/orders/${orderId}/reservations`,
    headers: auth(buyer.token),
    payload: {},
  });
  expect(reserved.statusCode).toBe(201);
  const reservationId = (reserved.json() as { id: string }).id;

  const confirmed = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reservations/${reservationId}/confirm`,
    headers: auth(owner.token),
    payload: {},
  });
  expect(confirmed.statusCode).toBe(200);
  return { orderId, reservationId };
}

/** Reads the code and returns just the string, which is what every test actually needs. */
const codeOf = async (ctx: TestContext, token: string, reservationId: string): Promise<string> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/v1/reservations/${reservationId}/delivery-code`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { code: string }).code;
};

const readCode = async (
  ctx: TestContext,
  token: string,
  reservationId: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/v1/reservations/${reservationId}/delivery-code`,
    headers: auth(token),
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
};

const complete = async (
  ctx: TestContext,
  token: string,
  reservationId: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reservations/${reservationId}/complete`,
    headers: auth(token),
    ...(payload === undefined ? {} : { payload }),
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
};

describe('four-digit delivery code (G-09)', () => {
  it('mints a four-digit code the moment the owner accepts', async () => {
    const session = await setup();
    const { ctx } = session;
    const { reservationId } = await matchedTrade(session);

    const code = await readCode(ctx, session.buyer.token, reservationId);
    expect(code.statusCode).toBe(200);
    expect(code.body.code).toMatch(/^\d{4}$/);
    expect(code.body.lockedUntil).toBeNull();
    expect(code.body.attemptsRemaining).toBe(DELIVERY_CODE_ATTEMPTS);

    // The code lives on the reservation and is part of the party view — but only as a flag.
    const view = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reservations/${reservationId}`,
      headers: auth(session.buyer.token),
    });
    expect(view.statusCode).toBe(200);
    const body = view.json() as Record<string, unknown>;
    expect(body.deliveryCodeIssued).toBe(true);
    expect(JSON.stringify(body)).not.toContain(code.body.code as string);
    await ctx.close();
  });

  it('hides the code from the seller and from strangers', async () => {
    const session = await setup();
    const { ctx } = session;
    const { reservationId } = await matchedTrade(session);

    const seller = await readCode(ctx, session.owner.token, reservationId);
    expect(seller.statusCode).toBe(403);
    expect((seller.body.error as { code: string }).code).toBe('DELIVERY_CODE_BUYER_ONLY');

    const stranger = await readCode(ctx, session.outsider.token, reservationId);
    expect(stranger.statusCode).toBe(403);
    await ctx.close();
  });

  it('closes the trade only with the right code, and audits the wrong ones', async () => {
    const session = await setup();
    const { ctx } = session;
    const { reservationId } = await matchedTrade(session);
    const code = await codeOf(ctx, session.buyer.token, reservationId);
    const wrong = code === '0000' ? '1111' : '0000';

    const rejected = await complete(ctx, session.owner.token, reservationId, { code: wrong });
    expect(rejected.statusCode).toBe(422);
    expect((rejected.body.error as { code: string }).code).toBe('DELIVERY_CODE_INVALID');
    expect(
      (rejected.body.error as { details: { attemptsRemaining: number } }).details.attemptsRemaining,
    ).toBe(2);

    // Still CONFIRMED: a wrong code must not move the reservation.
    const stillThere = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reservations/${reservationId}`,
      headers: auth(session.buyer.token),
    });
    expect((stillThere.json() as { status: string }).status).toBe('CONFIRMED');

    const rejectedAudits = (await ctx.repos.audit.list(50)).filter(
      (entry) => entry.action === 'delivery.code_rejected',
    );
    expect(rejectedAudits).toHaveLength(1);

    const done = await complete(ctx, session.owner.token, reservationId, { code });
    expect(done.statusCode).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    await ctx.close();
  });

  it('refuses to close without a code when the seller is the one closing', async () => {
    const session = await setup();
    const { ctx } = session;
    const { reservationId } = await matchedTrade(session);

    const bare = await complete(ctx, session.owner.token, reservationId);
    expect(bare.statusCode).toBe(422);
    expect((bare.body.error as { code: string }).code).toBe('DELIVERY_CODE_REQUIRED');
    await ctx.close();
  });

  it('locks for ten minutes after three wrong codes, then opens again', async () => {
    const session = await setup();
    const { ctx, clock } = session;
    const { reservationId } = await matchedTrade(session);
    const code = await codeOf(ctx, session.buyer.token, reservationId);
    const wrong = code === '0000' ? '1111' : '0000';

    for (let attempt = 1; attempt <= DELIVERY_CODE_ATTEMPTS; attempt += 1) {
      const response = await complete(ctx, session.owner.token, reservationId, { code: wrong });
      expect(response.statusCode).toBe(attempt < DELIVERY_CODE_ATTEMPTS ? 422 : 429);
    }

    // Locked: even the correct code is refused while the lock is armed.
    const locked = await complete(ctx, session.owner.token, reservationId, { code });
    expect(locked.statusCode).toBe(429);
    expect((locked.body.error as { code: string }).code).toBe('DELIVERY_CODE_LOCKED');
    const lockDetails = (locked.body.error as { details: { lockedUntil: string } }).details;
    expect(new Date(lockDetails.lockedUntil).getTime()).toBe(
      clock.now().getTime() + DELIVERY_CODE_LOCK_MS,
    );

    const lockAudits = (await ctx.repos.audit.list(50)).filter(
      (entry) => entry.action === 'delivery.code_locked',
    );
    expect(lockAudits).toHaveLength(1);

    // The buyer sees the lock, so the UI can count the minutes down instead of guessing.
    const buyerView = await readCode(ctx, session.buyer.token, reservationId);
    expect(buyerView.body.lockedUntil).toBe(lockDetails.lockedUntil);

    // Ten minutes later the trade can be closed with the right code again.
    clock.advanceMinutes(DELIVERY_CODE_LOCK_MS / 60_000 + 1);
    const afterLock = await complete(ctx, session.owner.token, reservationId, { code });
    expect(afterLock.statusCode).toBe(200);
    expect(afterLock.body.status).toBe('COMPLETED');
    await ctx.close();
  });

  it('accepts the code in Persian digits and rejects a malformed one', async () => {
    const session = await setup();
    const { ctx } = session;
    const { reservationId } = await matchedTrade(session);
    const code = await codeOf(ctx, session.buyer.token, reservationId);
    const persian = code.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);

    const malformed = await complete(ctx, session.owner.token, reservationId, { code: '12' });
    expect(malformed.statusCode).toBe(422);
    expect((malformed.body.error as { code: string }).code).toBe('VALIDATION_ERROR');

    const done = await complete(ctx, session.owner.token, reservationId, { code: persian });
    expect(done.statusCode).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    await ctx.close();
  });

  it('lets the buyer close their own trade without typing their own code', async () => {
    const session = await setup();
    const { ctx } = session;
    const { reservationId } = await matchedTrade(session);

    const done = await complete(ctx, session.buyer.token, reservationId);
    expect(done.statusCode).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    await ctx.close();
  });
});
