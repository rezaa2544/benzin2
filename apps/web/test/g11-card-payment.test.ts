import { describe, expect, it } from 'vitest';
import fa from '../src/i18n/fa.json';

/**
 * G-11 in the customer app — the tracking-number box.
 *
 * The web side of card-to-card is small on purpose: the destination card and the instruction come
 * ready-made from the API, and the only decision the app makes is whether the buyer is asked for a
 * bank tracking number. That decision is `config.cardMode`, and getting it wrong either nags people
 * who do not need to do anything (`auto`) or leaves a reviewer with no proof to check (`review`).
 */
const reviewMode = (config: { cardMode?: 'auto' | 'review' } | null): boolean =>
  config?.cardMode === 'review';

describe('card-to-card review mode (G-11)', () => {
  it('asks for a tracking number only when the platform is in review mode', () => {
    expect(reviewMode({ cardMode: 'review' })).toBe(true);
    expect(reviewMode({ cardMode: 'auto' })).toBe(false);
    // An older API that does not send the flag must behave like `auto`: no empty box to confuse.
    expect(reviewMode({})).toBe(false);
    expect(reviewMode(null)).toBe(false);
  });

  it('has the whole review-mode vocabulary in Persian', () => {
    for (const key of [
      'proofTitle',
      'proofLead',
      'proofLabel',
      'proofSubmit',
      'proofQueued',
      'proofInvalid',
    ] as const) {
      expect(fa.plans[key], `plans.${key}`).toBeTruthy();
    }
    expect(fa.errors.CARD_REVIEW_DISABLED).toBeTruthy();
    expect(fa.plans.proofTitle).toContain('پیگیری');
  });

  it('promises the buyer a human, not an instant answer', () => {
    // The copy must not imply the plan is active the moment the number is sent.
    expect(fa.plans.proofQueued).toContain('تأیید');
    expect(fa.plans.proofLead).toContain('کارشناس');
  });
});
