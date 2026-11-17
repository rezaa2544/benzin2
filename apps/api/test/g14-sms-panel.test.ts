import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/infra/sms/index.js';
import {
  auth,
  createTestContext,
  freshPhone,
  login,
  loginAsRole,
  ManualClock,
  offlineSmsFetch,
} from './helpers.js';

/**
 * G-14 — the SMS panel.
 *
 * The acceptance text: the chain (sms.ir → kavenegar → console) must fail over, the keys and
 * templates must come from the panel, and «ارسال آزمایشی» must show the service's real answer.
 *
 * These tests drive the panel API and watch what the sender does with a faked provider, because the
 * one thing an owner actually needs to trust is «اگر sms.ir بخوابد، پیامک می‌رسد یا نه؟».
 */

interface PanelStatus {
  enabled: boolean;
  source: 'PANEL' | 'ENV' | 'CONSOLE';
  otpMessage: string;
  chain: {
    provider: string;
    priority: number;
    isActive: boolean;
    keySet: boolean;
    sender: string | null;
    template: string | null;
  }[];
}

interface TestResult {
  delivered: boolean;
  attempts: {
    provider: string;
    ok: boolean;
    status: number | null;
    mode: string;
    raw: string | null;
  }[];
}

/** A provider that answers exactly as the real one does, and records what it was asked. */
const providerFetch = (
  answer: (url: string) => { ok: boolean; status: number; body: string },
): { fetchImpl: FetchLike; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const result = answer(url);
      return { ok: result.ok, status: result.status, text: async () => result.body };
    },
  };
};

const status = async (ctx: { app: Parameters<typeof auth> extends never ? never : any }, token: string) => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/v1/admin/sms',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as PanelStatus;
};

const saveProvider = async (
  ctx: any,
  token: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/v1/admin/providers',
    headers: auth(token),
    payload,
  });
  expect(response.statusCode).toBe(200);
};

describe('G-14 — the chain comes from the panel', () => {
  it('orders the providers by priority and keeps the credential out of the response', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');

      // Without any panel row the deployment keeps its env chain.
      expect((await status(ctx, owner.token)).source).toBe('ENV');

      await saveProvider(ctx, owner.token, {
        provider: 'kavenegar',
        kind: 'SMS',
        isActive: true,
        config: { apiKey: 'kavenegar-secret', sender: '10004346', priority: 1 },
      });
      await saveProvider(ctx, owner.token, {
        provider: 'smsir',
        kind: 'SMS',
        isActive: true,
        config: { apiKey: 'smsir-secret', sender: '30007732', priority: 5, template: '12345' },
      });

      const panel = await status(ctx, owner.token);
      expect(panel.source).toBe('PANEL');
      // Highest priority first, and the default chain is always available as the last resort.
      expect(panel.chain.slice(0, 2).map((link) => link.provider)).toEqual(['smsir', 'kavenegar']);
      expect(panel.chain[panel.chain.length - 1]?.provider).toBe('default');
      expect(panel.chain[0]).toMatchObject({ keySet: true, sender: '30007732', template: '12345' });
      // The credential itself must never come back — only «a key is stored».
      expect(JSON.stringify(panel)).not.toContain('smsir-secret');
    } finally {
      await ctx.close();
    }
  });

  it('falls through to the next provider when the first one rejects the message', async () => {
    const fake = providerFetch((url) =>
      url.includes('sms.ir')
        ? { ok: true, status: 200, body: '{"status":0,"message":"line is disabled"}' }
        : { ok: true, status: 200, body: '{"return":{"status":200,"message":"ok"}}' },
    );
    const ctx = await createTestContext(new ManualClock(), { smsFetch: fake.fetchImpl });
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      await saveProvider(ctx, owner.token, {
        provider: 'smsir',
        kind: 'SMS',
        isActive: true,
        config: { apiKey: 'k1', sender: '30007732', priority: 9 },
      });
      await saveProvider(ctx, owner.token, {
        provider: 'kavenegar',
        kind: 'SMS',
        isActive: true,
        config: { apiKey: 'k2', sender: '10004346', priority: 1 },
      });

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/sms/test',
        headers: auth(owner.token),
        payload: { phone: '09121234567' },
      });
      expect(response.statusCode).toBe(200);
      const result = response.json() as TestResult;

      expect(result.delivered).toBe(true);
      expect(result.attempts.map((attempt) => attempt.provider)).toEqual(['smsir', 'kavenegar']);
      expect(result.attempts[1]?.ok).toBe(true);
      // The provider's own words travel back to the panel, verbatim.
      expect(result.attempts[1]?.raw).toContain('"status":200');
    } finally {
      await ctx.close();
    }
  });

  it('skips a disabled provider entirely', async () => {
    const fake = providerFetch(() => ({ ok: true, status: 200, body: '{"status":1}' }));
    const ctx = await createTestContext(new ManualClock(), { smsFetch: fake.fetchImpl });
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      await saveProvider(ctx, owner.token, {
        provider: 'smsir',
        kind: 'SMS',
        isActive: false,
        config: { apiKey: 'k1', sender: '30007732', priority: 9 },
      });

      const panel = await status(ctx, owner.token);
      // A disabled row is listed (so the owner sees it) but contributes no transport.
      expect(panel.chain[0]).toMatchObject({ provider: 'smsir', isActive: false });
      expect(panel.source).toBe('ENV');

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/sms/test',
        headers: auth(owner.token),
        payload: { phone: '09121234567', provider: 'smsir' },
      });
      const result = response.json() as { delivered: boolean; message: string };
      expect(result.delivered).toBe(false);
      expect(result.message).toContain('فعال نیست');
    } finally {
      await ctx.close();
    }
  });

  it('uses the OTP template from the panel for codes', async () => {
    const fake = providerFetch(() => ({ ok: true, status: 200, body: '{"status":1}' }));
    const ctx = await createTestContext(new ManualClock(), { smsFetch: fake.fetchImpl });
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      const update = await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/admin/settings',
        headers: auth(owner.token),
        payload: { 'notification.sms_otp_message': 'کد بنزین شما: {code}' },
      });
      expect(update.statusCode).toBe(200);

      const panel = await status(ctx, owner.token);
      expect(panel.otpMessage).toBe('کد بنزین شما: {code}');
    } finally {
      await ctx.close();
    }
  });

  it('refuses an OTP text without the {code} placeholder', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      const update = await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/admin/settings',
        headers: auth(owner.token),
        payload: { 'notification.sms_otp_message': 'کد شما آماده است' },
      });
      expect(update.statusCode).toBe(422);
      // A template without a code would deliver a message that looks sent and is useless.
      expect((await status(ctx, owner.token)).otpMessage).toContain('{code}');
    } finally {
      await ctx.close();
    }
  });

  it('reports the failure honestly when every provider is down', async () => {
    const ctx = await createTestContext(new ManualClock(), { smsFetch: offlineSmsFetch });
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      await saveProvider(ctx, owner.token, {
        provider: 'smsir',
        kind: 'SMS',
        isActive: true,
        config: { apiKey: 'k1', sender: '30007732', priority: 9 },
      });

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/sms/test',
        headers: auth(owner.token),
        payload: { phone: '09121234567', provider: 'smsir' },
      });
      const result = response.json() as TestResult;
      expect(result.delivered).toBe(false);
      expect(result.attempts[0]).toMatchObject({ provider: 'smsir', ok: false, status: 503 });
      // Even a rejection carries the service's answer, so the owner can read it themselves.
      expect(result.attempts[0]?.raw).toContain('offline');
    } finally {
      await ctx.close();
    }
  });

  it('takes a saved key into service without a restart, and audits the test', async () => {
    const fake = providerFetch(() => ({ ok: true, status: 200, body: '{"status":1}' }));
    const ctx = await createTestContext(new ManualClock(), { smsFetch: fake.fetchImpl });
    try {
      const owner = await loginAsRole(ctx, freshPhone(), 'OWNER');
      // First: nothing in the panel, so the chain is the env one.
      expect((await status(ctx, owner.token)).source).toBe('ENV');

      await saveProvider(ctx, owner.token, {
        provider: 'smsir',
        kind: 'SMS',
        isActive: true,
        config: { apiKey: 'k1', sender: '30007732', priority: 5 },
      });
      // No restart, no manual refresh: the next read already sees the new chain.
      expect((await status(ctx, owner.token)).source).toBe('PANEL');

      await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/sms/test',
        headers: auth(owner.token),
        payload: { phone: '09121234567' },
      });
      const audit = await ctx.repos.audit.list(10);
      expect(audit.map((entry) => entry.action)).toContain('sms.tested');
    } finally {
      await ctx.close();
    }
  });

  it('keeps the panel to staff', async () => {
    const ctx = await createTestContext(new ManualClock());
    try {
      const user = await login(ctx, freshPhone());
      const panel = await ctx.app.inject({
        method: 'GET',
        url: '/v1/admin/sms',
        headers: auth(user.token),
      });
      expect(panel.statusCode).toBe(403);

      const test = await ctx.app.inject({
        method: 'POST',
        url: '/v1/admin/sms/test',
        headers: auth(user.token),
        payload: { phone: '09121234567' },
      });
      expect(test.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
