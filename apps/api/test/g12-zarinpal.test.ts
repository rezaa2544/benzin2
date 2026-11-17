import { describe, expect, it } from 'vitest';
import { auth, createTestContext, freshPhone, login, mintAccessToken, ManualClock } from './helpers.js';
import { ZarinpalGatewayProvider } from '../src/modules/payment-providers.js';
import { assertGatewaySafety, loadConfig } from '../src/config.js';
import type { PaymentProvider } from '../src/ports.js';

/**
 * G-12 — Zarinpal production flow and transaction reconciliation.
 *
 * The acceptance criteria: a complete request/verify cycle, an HTTPS callback on the real domain,
 * three verify retries by the worker, a revenue report, and the merchant key staying in the
 * server's `.env` only. Everything here runs against a fake bank that speaks the real Zarinpal
 * wire format, so the code that ships is the code that was tested.
 */

const SECRET_ENV = { JWT_SECRET: 'test-jwt-secret-value-for-tests' };

/** A bank the test controls: it can approve, reject, throw, or be down for a while. */
class FakeGateway implements PaymentProvider {
  readonly kind = 'GATEWAY' as const;
  mode: 'ok' | 'throw' | 'reject' = 'ok';
  readonly verified: string[] = [];
  private counter = 0;

  async init(input: { paymentId: string }): Promise<{
    redirectUrl: string | null;
    authority: string | null;
    destination: null;
    uniqueAmountToman: null;
  }> {
    this.counter += 1;
    const authority = `A0000000000000000000000000000000${this.counter}`.slice(-36);
    return {
      redirectUrl: `https://payment.zarinpal.com/pg/StartPay/${authority}`,
      authority,
      destination: null,
      uniqueAmountToman: null,
    };
  }

  async verify(input: { authority: string | null }): Promise<{
    ok: boolean;
    reference: string | null;
    reason: string | null;
  }> {
    if (input.authority) this.verified.push(input.authority);
    if (this.mode === 'throw') throw new Error('socket hang up');
    if (this.mode === 'reject') return { ok: false, reference: null, reason: 'GATEWAY_CODE_-51' };
    return { ok: true, reference: 'REF-1001', reason: null };
  }
}

const staffToken = async (
  ctx: Awaited<ReturnType<typeof createTestContext>>,
): Promise<{ token: string; user: { id: string; role: 'ADMIN' | 'OWNER' } }> => {
  const user = await ctx.repos.users.create({ phone: freshPhone(), role: 'ADMIN' });
  return { token: mintAccessToken(user), user: { id: user.id, role: 'ADMIN' } };
};

const startGatewayInvoice = async (
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  token: string,
): Promise<{ id: string; amountToman: number }> => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: auth(token),
    payload: { planCode: 'monthly', method: 'GATEWAY' },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; amountToman: number };
};

const callback = async (ctx: Awaited<ReturnType<typeof createTestContext>>, query: string) =>
  ctx.app.inject({ method: 'GET', url: `/v1/payments/gateway/callback?${query}` });

describe('G-12 Zarinpal provider contract', () => {
  it('sends Rial and the registered callback, and accepts 100 and 101 as paid', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let verifyCode = 100;
    const provider = new ZarinpalGatewayProvider({
      merchantId: 'merchant-1234-5678',
      callbackUrl: 'https://app.benzin.ir/v1/payments/gateway/callback',
      fetchImpl: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        if (url.endsWith('request.json')) {
          return { ok: true, status: 200, json: async () => ({ data: { code: 100, authority: 'A00000000000000000000000000000001234' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: { code: verifyCode, ref_id: 987654 } }) };
      },
    });

    const started = await provider.init({ paymentId: 'p-1', amountToman: 49_000 });
    expect(sent[0]!.url).toBe('https://payment.zarinpal.com/pg/v4/payment/request.json');
    // The platform thinks in Toman; the bank thinks in Rial. The ×10 lives in exactly one place.
    expect(sent[0]!.body.amount).toBe(490_000);
    expect(sent[0]!.body.merchant_id).toBe('merchant-1234-5678');
    expect(sent[0]!.body.callback_url).toBe('https://app.benzin.ir/v1/payments/gateway/callback');
    expect(started.authority).toBe('A00000000000000000000000000000001234');
    expect(started.redirectUrl).toBe(
      'https://payment.zarinpal.com/pg/StartPay/A00000000000000000000000000000001234',
    );

    const first = await provider.verify({
      paymentId: 'p-1',
      amountToman: 49_000,
      authority: 'A00000000000000000000000000000001234',
      reference: null,
    });
    expect(first).toEqual({ ok: true, reference: '987654', reason: null });

    // 101 = this authority was already verified. Treating it as an error would double-charge people
    // who refresh the return page.
    verifyCode = 101;
    const again = await provider.verify({
      paymentId: 'p-1',
      amountToman: 49_000,
      authority: 'A00000000000000000000000000000001234',
      reference: null,
    });
    expect(again.ok).toBe(true);
  });

  it('turns a transport failure into a thrown error (the retry path) not a rejection', async () => {
    const provider = new ZarinpalGatewayProvider({
      merchantId: 'merchant-1234-5678',
      callbackUrl: 'https://app.benzin.ir/cb',
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    });
    await expect(
      provider.verify({ paymentId: 'p', amountToman: 1000, authority: 'A1', reference: null }),
    ).rejects.toThrow();
  });

  it('refuses to boot with the real gateway configured unsafely', () => {
    const base = { NODE_ENV: 'production', ...SECRET_ENV, PAYMENT_GATEWAY: 'zarinpal' } as const;

    // No merchant id: a repository full of code cannot pay anyone, so the server must not pretend.
    expect(() => loadConfig({ ...base, ZARINPAL_MERCHANT_ID: '' })).toThrow(/ZARINPAL_MERCHANT_ID/);

    // Zarinpal will not call back a plain-HTTP address; failing at boot beats failing at checkout.
    expect(() =>
      loadConfig({
        ...base,
        ZARINPAL_MERCHANT_ID: 'merchant-1234-5678',
        PAYMENT_CALLBACK_URL: 'http://localhost:4301/cb',
      }),
    ).toThrow(/https/i);

    const ok = loadConfig({
      ...base,
      ZARINPAL_MERCHANT_ID: 'merchant-1234-5678',
      PAYMENT_CALLBACK_URL: 'https://app.benzin.ir/v1/payments/gateway/callback',
      PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans',
    });
    expect(ok.PAYMENT_GATEWAY).toBe('zarinpal');
    // The sandbox gateway has no such requirements — development must stay one command away.
    expect(assertGatewaySafety(loadConfig({ NODE_ENV: 'development', ...SECRET_ENV })).PAYMENT_GATEWAY).toBe(
      'sandbox',
    );
  });
});

describe('G-12 gateway callback', () => {
  it('verifies, activates the plan and redirects the browser back into the app', async () => {
    const gateway = new FakeGateway();
    const ctx = await createTestContext(undefined, {
      providers: { gateway },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await startGatewayInvoice(ctx, buyer.token);
      const stored = await ctx.repos.payments.findById(invoice.id);
      expect(stored?.authority).toBeTruthy();

      const response = await callback(ctx, `Authority=${stored!.authority}&Status=OK`);
      expect(response.statusCode).toBe(302);
      const location = response.headers.location as string;
      expect(location).toContain('https://app.benzin.ir/plans?');
      expect(location).toContain('payment=paid');
      expect(location).toContain(`invoice=${invoice.id}`);

      const paid = await ctx.repos.payments.findById(invoice.id);
      expect(paid?.status).toBe('PAID');
      expect(paid?.reference).toBe('REF-1001');
      expect(paid?.nextVerifyAt).toBeNull();

      const subscription = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me/subscription',
        headers: auth(buyer.token),
      });
      expect((subscription.json() as { subscription: { status: string } | null }).subscription?.status).toBe(
        'ACTIVE',
      );

      // The buyer refreshes the return page: same answer, no second activation.
      const replay = await callback(ctx, `Authority=${stored!.authority}&Status=OK`);
      expect(replay.headers.location).toContain('payment=paid');
      const afterReplay = await ctx.repos.payments.findById(invoice.id);
      expect(afterReplay?.status).toBe('PAID');
    } finally {
      await ctx.close();
    }
  });

  it('treats Status=NOK as a clean cancellation, not an error page', async () => {
    const gateway = new FakeGateway();
    const ctx = await createTestContext(undefined, {
      providers: { gateway },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await startGatewayInvoice(ctx, buyer.token);
      const stored = await ctx.repos.payments.findById(invoice.id);

      const response = await callback(ctx, `Authority=${stored!.authority}&Status=NOK`);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('payment=failed');
      const after = await ctx.repos.payments.findById(invoice.id);
      expect(after?.status).toBe('FAILED');
      expect(after?.reference).toBe('GATEWAY_CANCELLED');
      // Nothing was asked of the bank, so the retry queue stays empty.
      expect(after?.nextVerifyAt).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('answers an unknown authority with a redirect instead of a JSON error', async () => {
    const ctx = await createTestContext(undefined, {
      providers: { gateway: new FakeGateway() },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const response = await callback(ctx, 'Authority=A000000000000000000000000000000099&Status=OK');
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('payment=unknown');
      // A short/absent authority is the same dead end from the buyer's point of view.
      const empty = await callback(ctx, 'Status=OK');
      expect(empty.statusCode).toBe(302);
      expect(empty.headers.location).toContain('payment=unknown');
    } finally {
      await ctx.close();
    }
  });

  it('keeps the invoice alive when the bank is unreachable and the worker finishes the job', async () => {
    const clock = new ManualClock();
    const gateway = new FakeGateway();
    gateway.mode = 'throw';
    const ctx = await createTestContext(clock, {
      providers: { gateway },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await startGatewayInvoice(ctx, buyer.token);
      const stored = await ctx.repos.payments.findById(invoice.id);

      const response = await callback(ctx, `Authority=${stored!.authority}&Status=OK`);
      expect(response.headers.location).toContain('payment=pending');

      const pending = await ctx.repos.payments.findById(invoice.id);
      expect(pending?.status).toBe('PENDING');
      expect(pending?.verifyAttempts).toBe(1);
      expect(pending?.lastVerifyError).toContain('socket hang up');
      expect(pending?.nextVerifyAt).not.toBeNull();

      // Still down on the next tick: attempts accumulate, the invoice stays pending.
      clock.advanceMinutes(30);
      gateway.mode = 'throw';
      await ctx.services.payments.retryGatewayVerifications();
      const second = await ctx.repos.payments.findById(invoice.id);
      expect(second?.status).toBe('PENDING');
      expect(second?.verifyAttempts).toBe(2);

      // The bank comes back: the third attempt settles it without the buyer doing anything.
      clock.advanceMinutes(60);
      gateway.mode = 'ok';
      const result = await ctx.services.payments.retryGatewayVerifications();
      expect(result.paid).toBe(1);

      const settled = await ctx.repos.payments.findById(invoice.id);
      expect(settled?.status).toBe('PAID');
      expect(settled?.nextVerifyAt).toBeNull();
      expect(settled?.verifyAttempts).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  it('hands an unverifiable invoice to a human instead of expiring it', async () => {
    const clock = new ManualClock();
    const gateway = new FakeGateway();
    gateway.mode = 'throw';
    const ctx = await createTestContext(clock, {
      providers: { gateway },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await startGatewayInvoice(ctx, buyer.token);
      const stored = await ctx.repos.payments.findById(invoice.id);

      await callback(ctx, `Authority=${stored!.authority}&Status=OK`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clock.advanceMinutes(120);
        await ctx.services.payments.retryGatewayVerifications();
      }

      const escalated = await ctx.repos.payments.findById(invoice.id);
      expect(escalated?.status).toBe('NEEDS_REVIEW');
      expect(escalated?.nextVerifyAt).toBeNull();

      // Read the inbox straight from the repos: this test has moved the clock six hours forward,
      // so the access token minted at the start is (correctly) expired by now.
      const inbox = await ctx.repos.notifications.listByUser(buyer.userId, {
        limit: 20,
        unreadOnly: false,
      });
      expect(inbox.map((item) => item.kind)).toContain('PAYMENT_NEEDS_REVIEW');

      const audit = await ctx.repos.audit.list(50);
      expect(audit.some((entry) => entry.action === 'payment.verify_exhausted')).toBe(true);

      // The panel can still confirm it by hand once support sees the money in the bank.
      const staff = await staffToken(ctx);
      const confirmed = await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/payments/${invoice.id}/confirm`,
        headers: auth(staff.token),
        payload: { reference: 'MANUAL-REF-9' },
      });
      expect(confirmed.statusCode).toBe(200);
      expect((confirmed.json() as { payment: { status: string } }).payment.status).toBe('PAID');
    } finally {
      await ctx.close();
    }
  });

  it('fails immediately when the bank gives a verdict instead of a blip', async () => {
    const gateway = new FakeGateway();
    gateway.mode = 'reject';
    const ctx = await createTestContext(undefined, {
      providers: { gateway },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const buyer = await login(ctx, freshPhone());
      const invoice = await startGatewayInvoice(ctx, buyer.token);
      const stored = await ctx.repos.payments.findById(invoice.id);
      const response = await callback(ctx, `Authority=${stored!.authority}&Status=OK`);
      expect(response.headers.location).toContain('payment=failed');
      const after = await ctx.repos.payments.findById(invoice.id);
      expect(after?.status).toBe('FAILED');
      expect(after?.nextVerifyAt).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});

describe('G-12 revenue report', () => {
  it('reports settled money by provider and by Tehran day, and hides itself from users', async () => {
    const clock = new ManualClock(new Date('2026-03-10T20:00:00.000Z')); // 23:30 in Tehran
    const gateway = new FakeGateway();
    const ctx = await createTestContext(clock, {
      providers: { gateway },
      env: { PAYMENT_RETURN_URL: 'https://app.benzin.ir/plans' },
    });
    try {
      const buyer = await login(ctx, freshPhone());

      // One gateway payment, settled at 23:30 Tehran time — it must count as that local day.
      const gatewayInvoice = await startGatewayInvoice(ctx, buyer.token);
      const storedGateway = await ctx.repos.payments.findById(gatewayInvoice.id);
      await callback(ctx, `Authority=${storedGateway!.authority}&Status=OK`);

      // One card-to-card payment, approved by an operator.
      const cardInvoice = await ctx.app.inject({
        method: 'POST',
        url: '/v1/subscriptions',
        headers: auth(buyer.token),
        payload: { planCode: 'quarterly', method: 'CARD_TO_CARD' },
      });
      const card = cardInvoice.json() as { id: string; amountToman: number };
      const staff = await staffToken(ctx);
      await ctx.app.inject({
        method: 'POST',
        url: `/v1/admin/payments/${card.id}/confirm`,
        headers: auth(staff.token),
        payload: { reference: 'BANK-7' },
      });

      const report = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/revenue?days=30',
        headers: auth(staff.token),
      });
      expect(report.statusCode).toBe(200);
      const body = report.json() as {
        totalToman: number;
        paidCount: number;
        totalTomanLabelFa: string;
        byProvider: { provider: string; labelFa: string; paidToman: number }[];
        byDay: { day: string; paidToman: number }[];
      };

      expect(body.paidCount).toBe(2);
      expect(body.totalToman).toBe(gatewayInvoice.amountToman + card.amountToman);
      expect(body.byProvider.map((row) => row.provider).sort()).toEqual(['CARD_TO_CARD', 'GATEWAY']);
      expect(body.byProvider.find((row) => row.provider === 'GATEWAY')?.labelFa).toBe('درگاه بانکی');
      expect(body.byDay).toHaveLength(1);
      expect(body.byDay[0]!.day).toBe('2026-03-10');
      // Persian digits and separators are made server-side.
      expect(body.totalTomanLabelFa).toMatch(/[۰-۹]/);

      const asBuyer = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/revenue',
        headers: auth(buyer.token),
      });
      expect(asBuyer.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
