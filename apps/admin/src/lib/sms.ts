import type { SmsAttemptRow, SmsChainLink } from './types.js';

/**
 * G-14: the SMS chain, as the panel must show it.
 *
 * Both functions are here rather than inline in the page because the *order* of the chain is the
 * whole feature: an owner who drags sms.ir below Kavenegar has to be able to trust that the screen
 * shows what the server will do, not what the rows happened to arrive in.
 */

/** Priority first (bigger runs earlier), and the default chain is always the last link. */
export function orderChain(chain: SmsChainLink[]): SmsChainLink[] {
  return [...chain].sort((a, b) => {
    if (a.provider === 'default') return 1;
    if (b.provider === 'default') return -1;
    return b.priority - a.priority;
  });
}

/** A failed attempt is never green, whatever its HTTP status says. */
export function attemptTone(attempt: Pick<SmsAttemptRow, 'ok'>): 'success' | 'error' {
  return attempt.ok ? 'success' : 'error';
}

/** The one line an owner reads: which provider answered, and with what. */
export function describeAttempt(attempt: SmsAttemptRow): string {
  const head = attempt.ok ? 'موفق' : 'ناموفق';
  const status = attempt.status === null ? '' : ` (${attempt.status})`;
  const body = attempt.raw ?? attempt.error ?? '';
  return `${attempt.provider}: ${head}${status}${body ? ` — ${body}` : ''}`;
}
