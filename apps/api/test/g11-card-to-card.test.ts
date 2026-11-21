import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  freshPhone,
  login,
  mintAccessToken,
  type TestContext,
} from './helpers.js';
import { verifyDepositSignature } from '../src/modules/card-deposit-service.js';

/**
 * G-11 — card-to-card: auto matching and review mode.
 *
 * The acceptance criteria: a unique amount per invoice, card + holder from settings, an HMAC-signed
 * idempotent webhook, auto activation on a match, a review path with a tracking number and an admin
 * queue, and an unmatched transfer that is recorded and raised to the panel instead of vanishing.
 *
 * The three real deposits the task also asks for need a live bank feed; everything below runs the
 * same code path against a signed simulated deposit, so swapping in the real feed is configuration,
 * not a rewrite (see `docs/benzin2/12-CARD-TO-CARD.md`).
 */

const SECRET = 'test-card-webhook-secret-value';

interface PayView {
  id: string;
  status: string;
  amountToman: number;
  uniqueAmountToman: number | null;
  destination: { cardNumber: string; holderName: string } | null;
  instructionFa: string;
}

const purchase = async (
  ctx: TestContext,
  token: string,
  overrides: { planCode?: string; method?: 'CARD_TO_CARD' | 'GATEWAY' } = {},
): Promise<PayView> => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: auth(token),
    payload: {
      planCode: overrides.planCode ?? 'monthly',
      method: overrides.method ?? 'CARD_TO_CARD',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as PayView;
};

const sign = (body: string, secret = SECRET): string =>
  createHmac('sha256', secret).update(body).digest('hex');

const deposit = async (
  ctx: TestContext,
  payload: Record<string, unknown>,
  options: { secret?: string | null } = {},
) => {
  const body = JSON.stringify(payload);
  const secret = options.secret === undefined ? SECRET : options.secret;
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payments/card/deposits',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-benzin-signature': `sha256=${sign(body, secret)}` }),
    },
    payload: body,
  });
};

const staffToken = async (ctx: TestContext): Promise<string> => {
  const staff = await ctx.repos.users.create({ phone: freshPhone(), role: 'ADMIN' });
  return mintAccessToken(staff);
};

describe('G-11 card-to-card', () => {
  it('gives every invoice a unique amount and takes the destination from settings', async () => {
    const ctx = await createTestContext(undefined, {
      env: { CARD_WEBHOOK_SECRET: SECRET },
    });
    try {
      const first = await login(ctx, freshPhone());
      const second = await login(ctx, freshPhone());
      const a = await purchase(ctx, first.token);
      const b = await purchase(ctx, second.token);

      expect(a.uniqueAmountToman).not.toBeNull();
      expect(b.uniqueAmountToman).not.toBeNull();
      expect(a.uniqueAmountToman).not.toBe(b.uniqueAmountToman);
      expect(a.uniqueAmountToman!).toBeGreaterThan(a.amountToman);

      // Card + holder come from the panel-editable settings, not from a constant in the code.
      expect(a.destination?.cardNumber).toBe('6037991234567890');
      expect(a.destination?.holderName).toBe('شرکت بنزین');
      expect(a.instructionFa).toContain('مبلغ یکتا');

      await ctx.services.settings.update('test-admin', { 'payment.card_holder': 'شرکت نمونه' });
      const c = await purchase(ctx, (await login(ctx, freshPhone())).token);
      expect(c.destination?.holderName).toBe('شرکت نمونه');
    } finally {
      await ctx.close();
    }
  });

  it('refuses a webhook without a valid signature', async () => {
    const ctx = await createTestContext(undefined, { env: { CARD_WEBHOOK_SECRET: SECRET } });
    try {
      const unsigned = await deposit(
        ctx,
        { amountToman: 150_001, reference: 'REF-1' },
        { secret: null },
      );
      expect(unsigned.statusCode).toBe(401);

      const wrongKey = await deposit(
        ctx,
        { amountToman: 150_001, reference: 'REF-1' },
        { secret: 'not-the-secret-value' },
      );
      expect(wrongKey.statusCode).toBe(401);
      expect((wrongKey.json() as { error: { code: string } }).error.code).toBe(
        'CARD_WEBHOOK_UNAUTHORIZED',
      );

      // Nothing was recorded by the rejected calls.
      const admin = await staffToken(ctx);
      const deposits = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/card-deposits',
        headers: auth(admin),
      });
      expect((deposits.json() as { total: number }).total).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('matches the unique amount, activates the plan, and is idempotent on replay', async () => {
    const ctx = await createTestContext(undefined, { env: { CARD_WEBHOOK_SECRET: SECRET } });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await purchase(ctx, buyer.token);

      const first = await deposit(ctx, {
        amountToman: invoice.uniqueAmountToman,
        reference: 'BANK-9001',
        senderName: 'علی رضایی',
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as { outcome: string; duplicate: boolean };
      expect(firstBody.outcome).toBe('MATCHED');
      expect(firstBody.duplicate).toBe(false);

      const paid = await ctx.app.inject({
        method: 'GET',
        url: `/v1/payments/${invoice.id}`,
        headers: auth(buyer.token),
      });
      expect((paid.json() as { status: string }).status).toBe('PAID');

      const subscription = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/subscription',
        headers: auth(buyer.token),
      });
      expect(
        (subscription.json() as { subscription: { status: string } | null }).subscription?.status,
      ).toBe('ACTIVE');

      // Same reference again: 200 (so the bank stops retrying) but nothing happens twice.
      const replay = await deposit(ctx, {
        amountToman: invoice.uniqueAmountToman,
        reference: 'BANK-9001',
        senderName: 'علی رضایی',
      });
      expect(replay.statusCode).toBe(200);
      const replayBody = replay.json() as { duplicate: boolean; outcome: string };
      expect(replayBody.duplicate).toBe(true);
      expect(replayBody.outcome).toBe('ALREADY_SETTLED');

      const admin = await staffToken(ctx);
      const deposits = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/card-deposits?status=MATCHED',
        headers: auth(admin),
      });
      const body = deposits.json() as { items: { reference: string; paymentId: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.paymentId).toBe(invoice.id);
    } finally {
      await ctx.close();
    }
  });

  it('records an unmatched transfer, tells the staff, and never touches an invoice', async () => {
    const ctx = await createTestContext(undefined, { env: { CARD_WEBHOOK_SECRET: SECRET } });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await purchase(ctx, buyer.token);
      const admin = await ctx.repos.users.create({ phone: freshPhone(), role: 'ADMIN' });
      const adminToken = mintAccessToken(admin);

      const stray = await deposit(ctx, {
        amountToman: 100_000,
        reference: 'BANK-STRAY-1',
        senderName: 'ناشناس',
      });
      expect(stray.statusCode).toBe(200);
      const body = stray.json() as { outcome: string; deposit: { status: string } };
      expect(body.outcome).toBe('NO_INVOICE');
      expect(body.deposit.status).toBe('UNMATCHED');

      // The invoice is untouched: nobody paid *this* amount.
      const still = await ctx.app.inject({
        method: 'GET',
        url: `/v1/payments/${invoice.id}`,
        headers: auth(buyer.token),
      });
      expect((still.json() as { status: string }).status).toBe('PENDING');

      // The panel sees the money and the admin was notified.
      const queue = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/card-deposits?status=UNMATCHED',
        headers: auth(adminToken),
      });
      expect((queue.json() as { total: number }).total).toBe(1);
      const inbox = await ctx.app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: auth(adminToken),
      });
      const items = (inbox.json() as { items: { kind: string }[] }).items;
      expect(items.some((item) => item.kind === 'PAYMENT_DEPOSIT_UNMATCHED')).toBe(true);

      // Support can attach the stray money to an invoice by hand.
      const depositId = (queue.json() as { items: { id: string }[] }).items[0]!.id;
      const attached = await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/card-deposits/${depositId}/attach`,
        headers: auth(adminToken),
        payload: { paymentId: invoice.id },
      });
      expect(attached.statusCode).toBe(200);
      const after = await ctx.app.inject({
        method: 'GET',
        url: `/v1/payments/${invoice.id}`,
        headers: auth(buyer.token),
      });
      expect((after.json() as { status: string }).status).toBe('PAID');
    } finally {
      await ctx.close();
    }
  });

  it('runs review mode: proof → NEEDS_REVIEW → operator approves', async () => {
    const ctx = await createTestContext(undefined, { env: { CARD_WEBHOOK_SECRET: SECRET } });
    try {
      await ctx.services.settings.update('test-admin', { 'payment.card_mode': 'review' });
      const buyer = await login(ctx, freshPhone());
      const invoice = await purchase(ctx, buyer.token);
      const admin = await staffToken(ctx);

      const proof = await ctx.app.inject({
        method: 'POST',
        url: `/v1/payments/${invoice.id}/card-proof`,
        headers: auth(buyer.token),
        payload: { trackingNumber: '123456789012' },
      });
      expect(proof.statusCode).toBe(200);
      expect((proof.json() as { status: string }).status).toBe('NEEDS_REVIEW');

      // It is waiting for a human, so the panel queue shows it.
      const queue = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/payments?status=NEEDS_REVIEW',
        headers: auth(admin),
      });
      const queued = (queue.json() as { items: { id: string }[] }).items;
      expect(queued.some((item) => item.id === invoice.id)).toBe(true);

      const approved = await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/payments/${invoice.id}/confirm`,
        headers: auth(admin),
        payload: { reference: '123456789012' },
      });
      expect(approved.statusCode).toBe(200);
      expect((approved.json() as { payment: { status: string } }).payment.status).toBe('PAID');

      const subscription = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/subscription',
        headers: auth(buyer.token),
      });
      expect(
        (subscription.json() as { subscription: { status: string } | null }).subscription?.status,
      ).toBe('ACTIVE');
    } finally {
      await ctx.close();
    }
  });

  it('refuses a tracking number while the platform confirms transfers automatically', async () => {
    const ctx = await createTestContext(undefined, { env: { CARD_WEBHOOK_SECRET: SECRET } });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await purchase(ctx, buyer.token);
      const proof = await ctx.app.inject({
        method: 'POST',
        url: `/v1/payments/${invoice.id}/card-proof`,
        headers: auth(buyer.token),
        payload: { trackingNumber: '999888777666' },
      });
      expect(proof.statusCode).toBe(409);
      expect((proof.json() as { error: { code: string } }).error.code).toBe('CARD_REVIEW_DISABLED');
    } finally {
      await ctx.close();
    }
  });

  it('turns the webhook off when no secret is configured', async () => {
    const ctx = await createTestContext();
    try {
      const response = await deposit(ctx, { amountToman: 150_001, reference: 'REF-X' });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'CARD_WEBHOOK_DISABLED',
      );
    } finally {
      await ctx.close();
    }
  });

  it('compares signatures in constant time and rejects malformed ones', () => {
    const body = '{"amountToman":150001,"reference":"X"}';
    expect(verifyDepositSignature(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
    expect(verifyDepositSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyDepositSignature(body, 'sha256=deadbeef', SECRET)).toBe(false);
    expect(verifyDepositSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyDepositSignature(body, 'sha256=zzzz', SECRET)).toBe(false);
  });
});
