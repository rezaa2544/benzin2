import { describe, expect, it } from 'vitest';
import fa from '../src/i18n/fa.json';

/**
 * G-12 in the customer app — what the buyer reads after coming back from the bank.
 *
 * The gateway callback is a redirect into `/plans?payment=…`, so this copy is the only thing between
 * a successful payment and a person who thinks their money vanished. Each outcome needs a different
 * promise, and none of them may be vague about what to do next.
 */
const OUTCOMES = ['paid', 'failed', 'pending', 'unknown'] as const;
const KEYS = {
  paid: 'gatewayPaid',
  failed: 'gatewayFailed',
  pending: 'gatewayPending',
  unknown: 'gatewayUnknown',
} as const;

const copy = (outcome: (typeof OUTCOMES)[number]): string =>
  (fa.plans as Record<string, string>)[KEYS[outcome]] ?? '';

describe('gateway return copy (G-12)', () => {
  it('has an answer for every outcome the callback can produce', () => {
    for (const outcome of OUTCOMES) {
      expect(copy(outcome), outcome).toBeTruthy();
    }
  });

  it('tells a successful buyer the plan is already on', () => {
    expect(copy('paid')).toContain('فعال');
  });

  it('never leaves a failed buyer without a next step', () => {
    // The money may have left the account even when verification failed, so support is the answer.
    expect(copy('failed')).toContain('پشتیبانی');
    expect(copy('unknown')).toContain('پشتیبانی');
  });

  it('asks a pending buyer to wait rather than pay twice', () => {
    expect(copy('pending')).toContain('بررسی');
    expect(copy('pending')).not.toContain('دوباره پرداخت');
  });
});
