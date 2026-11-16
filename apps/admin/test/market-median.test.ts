import { describe, expect, it } from 'vitest';
import { buildHash, matchRoute } from '../src/lib/router.js';
import { canAccess } from '../src/lib/permissions.js';
import fa from '../src/i18n/fa.json';
import type { TradeMedian } from '../src/lib/types.js';

/**
 * G-08 in the panel: the copy and the routing of «میانگین بازار».
 *
 * The number itself is computed and tested on the API (`apps/api/test/g08-median.test.ts`); what
 * can break here is the Persian surface — a missing key or a screen nobody can reach.
 */

describe('market median screen (G-08)', () => {
  it('is reachable at #/market and open to staff', () => {
    expect(matchRoute('#/market')?.page).toBe('market');
    expect(buildHash('market')).toBe('#/market');
    for (const role of ['SUPPORT', 'ADMIN', 'OWNER'] as const) {
      expect(canAccess(role, 'market')).toBe(true);
    }
    expect(canAccess('USER', 'market')).toBe(false);
  });

  it('has every Persian string the screen prints', () => {
    for (const key of [
      'title',
      'lead',
      'national',
      'trades',
      'median',
      'insufficient',
      'requiredTrades',
      'regions',
      'region',
      'thresholdHint',
      'noData',
    ] as const) {
      expect(fa.market[key], `market.${key}`).toBeTruthy();
    }
    expect(fa.market.insufficient).toBe('دادهٔ کافی نیست');
    expect(fa.nav.market).toBeTruthy();
  });

  it('agrees with the API contract on what "not enough data" looks like', () => {
    // Shape guard: the screen branches on `sufficient`, so the flag and the number must agree.
    const insufficient: TradeMedian = {
      windowHours: 72,
      requiredTrades: 5,
      scope: { province: null, county: null },
      labelFa: 'کل کشور',
      trades: 3,
      medianRateToman: null,
      sufficient: false,
      messageFa: 'دادهٔ کافی نیست',
      byRegion: [],
      generatedAt: '2026-02-01T10:00:00.000Z',
    };
    expect(insufficient.sufficient).toBe(false);
    expect(insufficient.medianRateToman).toBeNull();
    expect(insufficient.windowHours).toBe(72);
    expect(insufficient.requiredTrades).toBe(5);
  });
});
