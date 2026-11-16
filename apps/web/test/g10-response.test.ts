import { describe, expect, it } from 'vitest';
import { tf } from '../src/lib/i18n.js';
import fa from '../src/i18n/fa.json';

/**
 * G-10 in the customer app — the copy around the answer rate.
 *
 * The number itself is computed once on the API (`apps/api/test/g10-response-rate.test.ts`); what
 * can break silently here is the Persian wording and the promise the copy makes: silence costs a
 * seller their visibility for a day, never points.
 */
describe('answer-rate copy (G-10)', () => {
  it('has every string the card, the profile and the market need', () => {
    for (const key of [
      'responseTitle',
      'responseLead',
      'responseRate',
      'responseEmpty',
      'responseCounts',
      'responseStreak',
      'responsePaused',
      'responseNoPenalty',
    ] as const) {
      expect(fa.profile[key], `profile.${key}`).toBeTruthy();
    }
    expect(fa.market.ownerRate).toBe('پاسخ‌دهی');
    expect(fa.errors.NOT_DELISTED).toBeTruthy();
  });

  it('fills the rate template with the digits the API sent', () => {
    const line = tf('profile.responseRate', { rate: '۹۲٫۵' });
    expect(line).toContain('۹۲٫۵');
    expect(line).toContain('٪');
  });

  it('says in plain Persian that silence is not a score', () => {
    expect(fa.profile.responseNoPenalty).toContain('امتیاز');
    expect(fa.profile.responsePaused).toContain('{until}');
    // The lead must not promise a punishment either — the acceptance criteria forbid one.
    expect(fa.profile.responseLead).toContain('امتیاز منفی نیست');
  });
});
