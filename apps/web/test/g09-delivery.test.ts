import { describe, expect, it } from 'vitest';
import { toPersianDigits } from '@benzin/shared';
import { matchRoute, resolveRedirect } from '../src/lib/router.js';
import fa from '../src/i18n/fa.json';

/**
 * G-09 in the customer app — the copy and the two routing rules the feature depends on.
 *
 * The code itself is minted, hidden and checked on the API (`apps/api/test/g09-delivery-code.test.ts`);
 * what can silently break on this side is the Persian text, and the login guard that the browser
 * check walked into while testing this screen.
 */

describe('delivery code screen (G-09)', () => {
  it('has every Persian string the seller and the buyer see', () => {
    for (const key of [
      'deliveryCodeTitle',
      'deliveryCodeLead',
      'deliveryCodeLocked',
      'deliveryCodeAttempts',
      'deliveryCodeAsk',
    ] as const) {
      expect(fa.trade[key], `trade.${key}`).toBeTruthy();
    }
    for (const key of [
      'DELIVERY_CODE_REQUIRED',
      'DELIVERY_CODE_INVALID',
      'DELIVERY_CODE_LOCKED',
      'DELIVERY_CODE_BUYER_ONLY',
    ] as const) {
      expect(fa.errors[key], `errors.${key}`).toBeTruthy();
    }
    expect(fa.trade.deliveryCodeTitle).toBe('کد تحویل');
  });

  it('shows the code large and in Persian digits', () => {
    expect(toPersianDigits('4063')).toBe('۴۰۶۳');
  });

  it('never sends a signed-out visitor to a login path inside a login path', () => {
    // The nested shape an older guard produced: /login?next=/login?next=/… — the user logged in
    // and landed back on the login screen, which is what broke the first G-09 browser run.
    const nested = matchRoute('/login?next=%2Flogin%3Fnext%3D%252Ftrade%252Fabc');
    expect(nested?.name).toBe('login');
    expect(resolveRedirect(nested)).toBe('/market');

    // A real deep link still survives the round trip.
    const trade = matchRoute('/trade/abc');
    expect(resolveRedirect(trade)).toBe('/trade/abc');
  });
});
