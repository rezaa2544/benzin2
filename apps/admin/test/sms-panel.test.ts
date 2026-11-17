import { describe, expect, it } from 'vitest';
import { attemptTone, describeAttempt, orderChain } from '../src/lib/sms.js';
import type { SmsAttemptRow, SmsChainLink } from '../src/lib/types.js';

/**
 * G-14 — the SMS panel's ordering rules.
 *
 * The server orders the chain, but the panel re-orders defensively: an owner who raises sms.ir's
 * priority must see sms.ir at the top of the list it will actually be tried in.
 */

const link = (provider: string, priority: number): SmsChainLink => ({
  provider,
  priority,
  isActive: true,
  keySet: true,
  sender: '3000',
  template: null,
});

describe('SMS chain ordering (G-14)', () => {
  it('puts the highest priority first', () => {
    const ordered = orderChain([link('kavenegar', 1), link('smsir', 9)]);
    expect(ordered.map((entry) => entry.provider)).toEqual(['smsir', 'kavenegar']);
  });

  it('keeps the default chain last even if it claims a priority', () => {
    const ordered = orderChain([link('default', 99), link('smsir', 1)]);
    expect(ordered.map((entry) => entry.provider)).toEqual(['smsir', 'default']);
  });

  it('does not mutate the array it was given', () => {
    const chain = [link('kavenegar', 1), link('smsir', 9)];
    orderChain(chain);
    expect(chain.map((entry) => entry.provider)).toEqual(['kavenegar', 'smsir']);
  });
});

describe('SMS attempt reporting (G-14)', () => {
  it('never paints a rejected message green, even with an HTTP 200', () => {
    expect(attemptTone({ ok: false })).toBe('error');
    expect(attemptTone({ ok: true })).toBe('success');
  });

  it('repeats the provider answer verbatim, status included', () => {
    const attempt: SmsAttemptRow = {
      provider: 'smsir',
      ok: false,
      status: 200,
      error: 'rejected by provider',
      mode: 'text',
      raw: '{"status":0,"message":"line is disabled"}',
    };
    const line = describeAttempt(attempt);
    expect(line).toContain('smsir');
    expect(line).toContain('ناموفق');
    expect(line).toContain('(200)');
    expect(line).toContain('line is disabled');
  });
});
