import type { OrderSide, Tier } from '@benzin/shared';

export type SortKey = 'distance' | 'price' | 'newest';

/**
 * Market filters are the home page's own state: a place picked from the province/county
 * cascade, one side, one sort order. There is no tier filter — the pump fee is the seller's
 * input and a buyer simply reads it off each listing.
 */
export interface MarketFilters {
  /** Province name; empty means «همهٔ ایران». */
  province: string;
  /** County name of that province; empty means every county of it. */
  county: string;
  side: OrderSide;
  sort: SortKey;
  /** G-05 lot matching: a standard lot in «دقیق» mode, or the upper bound in «بازه» mode. */
  litresMode: 'exact' | 'range';
  /** Empty means «هر حجمی» — no lot filter at all. */
  litres: string;
  /** Lower bound of «بازه»; empty means from the smallest lot the platform allows. */
  minLitres: string;
  /**
   * G-07 radius in kilometres; empty means «هر فاصله‌ای». It only means anything once a
   * search point exists, which is why the chips stay hidden until the traveler switch is on.
   */
  radiusKm: string;
}

export const DEFAULT_FILTERS: MarketFilters = {
  province: '',
  county: '',
  side: 'BUY',
  sort: 'newest',
  litresMode: 'exact',
  litres: '',
  minLitres: '',
  radiusKm: '',
};

/** The standard lots the app offers as one-tap chips (G-05). */
export const STANDARD_LOTS: readonly number[] = [5, 10, 20, 30, 40, 50, 60];

const SORTS: readonly SortKey[] = ['distance', 'price', 'newest'];

/** Reads filters from the URL so a shared link opens the same search. */
export function filtersFromQuery(
  query: Record<string, string>,
  fallback: MarketFilters = DEFAULT_FILTERS,
): MarketFilters {
  const side = query['side'] === 'SELL' || query['side'] === 'BUY' ? query['side'] : fallback.side;
  const sort = SORTS.includes(query['sort'] as SortKey)
    ? (query['sort'] as SortKey)
    : fallback.sort;
  return {
    province: query['province'] ?? fallback.province,
    county: query['county'] ?? fallback.county,
    side,
    sort,
    litresMode: query['litresMode'] === 'range' ? 'range' : fallback.litresMode,
    litres: query['litres'] ?? fallback.litres,
    minLitres: query['minLitres'] ?? fallback.minLitres,
    radiusKm: query['radiusKm'] ?? fallback.radiusKm,
  };
}

/** Pump fee labels the seller picks from; the numbers come from TIER_RATE_TOMAN. */
export const TIER_LABEL_FA: Record<Tier, string> = {
  T1500: 'پمپ ۱٬۵۰۰',
  T3000: 'پمپ ۳٬۰۰۰',
  T10000: 'پمپ ۱۰٬۰۰۰',
};

/** `distance` needs a point; without one the API rejects the request, so we fall back. */
export function effectiveSort(filters: MarketFilters, hasOrigin: boolean): SortKey {
  return filters.sort === 'distance' && !hasOrigin ? 'newest' : filters.sort;
}

/** Market search is a getter for the API query: empty place fields are simply omitted. */
export function toSearchQuery(
  filters: MarketFilters,
  options: { cursor?: string; origin?: { lat: number; lng: number } | null; limit?: number } = {},
): Record<string, unknown> {
  const sort = effectiveSort(filters, Boolean(options.origin));
  return {
    province: filters.province || undefined,
    county: filters.county || undefined,
    side: filters.side,
    sort,
    limit: options.limit ?? 20,
    cursor: options.cursor,
    lat: options.origin?.lat,
    lng: options.origin?.lng,
    // G-05: an empty lot field means "no lot filter", and exact/range only matters once set.
    litresMode: filters.litres || filters.minLitres ? filters.litresMode : undefined,
    litres: filters.litresMode === 'exact' && filters.litres ? Number(filters.litres) : undefined,
    minLitres:
      filters.litresMode === 'range' && filters.minLitres ? Number(filters.minLitres) : undefined,
    maxLitres:
      filters.litresMode === 'range' && filters.litres ? Number(filters.litres) : undefined,
    // G-07: a radius is only sent with a point; the API rejects one without the other.
    radiusKm: options.origin && filters.radiusKm ? Number(filters.radiusKm) : undefined,
  };
}
