import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  effectiveSort,
  filtersFromQuery,
  TIER_LABEL_FA,
  toSearchQuery,
} from '../src/lib/market.js';

describe('market filters (E9-05)', () => {
  it('falls back to the defaults for missing or invalid query values', () => {
    expect(filtersFromQuery({})).toEqual(DEFAULT_FILTERS);
    expect(filtersFromQuery({ side: 'NOPE', sort: 'random' })).toEqual(DEFAULT_FILTERS);
  });

  it('reads a full filter set from the URL', () => {
    expect(
      filtersFromQuery({ province: 'کردستان', county: 'بانه', side: 'SELL', sort: 'price' }),
    ).toEqual({
      province: 'کردستان',
      county: 'بانه',
      side: 'SELL',
      sort: 'price',
      // G-05 defaults: exact lot mode with no lot picked yet.
      litresMode: 'exact',
      litres: '',
      minLitres: '',
      radiusKm: '',
    });
  });

  it('only uses distance when there is an origin point', () => {
    expect(effectiveSort({ ...DEFAULT_FILTERS, sort: 'distance' }, false)).toBe('newest');
    expect(effectiveSort({ ...DEFAULT_FILTERS, sort: 'distance' }, true)).toBe('distance');
    expect(effectiveSort({ ...DEFAULT_FILTERS, sort: 'price' }, false)).toBe('price');
  });

  it('omits the origin from the API query when there is none', () => {
    const query = toSearchQuery({ ...DEFAULT_FILTERS, province: 'کردستان', county: 'بانه' });
    expect(query['province']).toBe('کردستان');
    expect(query['county']).toBe('بانه');
    expect(query['limit']).toBe(20);
    expect(query['lat']).toBeUndefined();
    expect(query['sort']).toBe('newest');
  });

  it('passes the cursor and origin through to the search', () => {
    const query = toSearchQuery(
      { ...DEFAULT_FILTERS, sort: 'distance' },
      { cursor: 'c1', origin: { lat: 35, lng: 46 }, limit: 5 },
    );
    expect(query).toMatchObject({ cursor: 'c1', lat: 35, lng: 46, limit: 5, sort: 'distance' });
  });

  it('reads a radius from the URL and only sends it with a point (G-07)', () => {
    const filters = filtersFromQuery({ radiusKm: '5' });
    expect(filters.radiusKm).toBe('5');
    expect(toSearchQuery(filters, { origin: { lat: 35.99, lng: 45.88 } })['radiusKm']).toBe(5);
    // No point means the radius is meaningless, so it never reaches the API.
    expect(toSearchQuery(filters)['radiusKm']).toBeUndefined();
    // An empty chip is «هر فاصله‌ای» and is dropped even when a point exists.
    expect(
      toSearchQuery(DEFAULT_FILTERS, { origin: { lat: 1, lng: 2 } })['radiusKm'],
    ).toBeUndefined();
  });

  it('labels every tier in Persian', () => {
    expect(Object.values(TIER_LABEL_FA).every((label) => /\S/.test(label))).toBe(true);
    expect(Object.keys(TIER_LABEL_FA)).toHaveLength(3);
  });
});
