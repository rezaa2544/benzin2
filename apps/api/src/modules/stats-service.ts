import { TIER_RATE_TOMAN, type OrderSide, type Tier } from '@benzin/shared';
import { mean, median, percentile } from '../domain/stats.js';
import type { Clock, Order } from '../domain/entities.js';
import type { Repositories } from '../ports.js';
import type { SettingsService } from './settings-service.js';

/**
 * The numbers the home screen shows for one place: what a litre really costs a buyer
 * (quoted price + the seller's pump fee), the spread around it, how many litres are on
 * offer versus requested, and the nationwide average the user compares their city with.
 */
export interface MarketStats {
  province: string | null;
  county: string | null;
  side: OrderSide;
  /** null = every pump-fee tier, which is the default for buyers. */
  tier: Tier | null;
  windowDays: number;
  /** Orders of this side in the window after removing suspicious prices. */
  sampleSize: number;
  excludedSuspicious: number;
  /** Quoted rate only — what the seller asks for the quota itself. */
  averageRateToman: number | null;
  medianRateToman: number | null;
  p25RateToman: number | null;
  p75RateToman: number | null;
  minRateToman: number | null;
  maxRateToman: number | null;
  /** Quoted rate + pump fee: the per-litre figure a buyer actually pays. */
  averageTotalRateToman: number | null;
  minTotalRateToman: number | null;
  maxTotalRateToman: number | null;
  averageLitres: number | null;
  /**
   * The same average split by pump fee. A 10000-toman pump listing and a 1500-toman one are
   * different products, so the single blended average alone would mislead.
   */
  byTier: TierBreakdown[];
  /** Liquidity of the place, both sides, every tier. */
  buyLitres: number;
  sellLitres: number;
  buyCount: number;
  sellCount: number;
  /** Same metric as `averageTotalRateToman` but over the whole country. */
  nationalAverageTotalRateToman: number | null;
  nationalSampleSize: number;
  /** How many counties had trade in the window — the sample behind the national average. */
  nationalCountyCount: number;
  /** Blended figure over every order of the window, suspicious ones included (E3-06). */
  overallAverageRateToman: number | null;
  overallSampleSize: number;
  generatedAt: string;
}

export interface TierBreakdown {
  tier: Tier;
  sampleSize: number;
  averageTotalRateToman: number | null;
  minTotalRateToman: number | null;
  maxTotalRateToman: number | null;
}

export interface MarketStatsInput {
  side: OrderSide;
  tier?: Tier | null;
  province?: string | null;
  county?: string | null;
  zoneId?: string | null;
}

/** Hard cap so a busy place cannot turn one stats call into a table scan. */
const MAX_SAMPLE = 5_000;

/** A sell listing carries its pump fee; a buy request never does. */
const effectiveRate = (order: Order): number =>
  order.rateToman + (order.side === 'SELL' ? TIER_RATE_TOMAN[order.tier] : 0);

/**
 * Market rates for one place. Prices that sit far below the official rate of their own tier
 * are treated as mistyped listings: they are counted and reported, but they never move the
 * average a buyer sees. The window comes from settings, not from the request.
 */
export class StatsService {
  constructor(
    private readonly repos: Pick<Repositories, 'orders'>,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async market(input: MarketStatsInput): Promise<MarketStats> {
    const config = await this.settings.get();
    const windowDays = config['stats.window_days'];
    // A listing that asks less than this share of the local median is a typo, not a bargain.
    const bandPercent = config['pricing.low_price_warning_percent'];
    const now = this.clock.now();
    const since = new Date(now.getTime() - windowDays * 86_400_000);

    const province = input.province ?? null;
    const county = input.county ?? null;
    const tier = input.tier ?? null;

    // A legacy caller that only knows its zone gets the zone scope for the place figures.
    const place =
      province === null && county === null && input.zoneId
        ? await this.repos.orders.listSince(input.zoneId, since, MAX_SAMPLE)
        : await this.repos.orders.listByPlace({ province, county, since, limit: MAX_SAMPLE });
    const national = await this.repos.orders.listByPlace({
      province: null,
      county: null,
      since,
      limit: MAX_SAMPLE,
    });

    /**
     * The spread is measured against the local median rather than the official tier rate:
     * since the pump fee became the seller's own input, a low quoted price is no longer a
     * red flag by itself, while a price a fraction of its neighbours still is.
     */
    const withoutOutliers = (orders: Order[]): Order[] => {
      const reference = median(orders.map((order) => order.rateToman));
      if (reference === null) return orders;
      const floor = (reference * bandPercent) / 100;
      return orders.filter((order) => order.rateToman >= floor);
    };
    const ofSide = place.filter(
      (order) => order.side === input.side && (tier === null || order.tier === tier),
    );
    const usable = withoutOutliers(ofSide);
    const rates = usable.map((order) => order.rateToman);
    const totals = usable.map(effectiveRate);
    const nationalTotals = withoutOutliers(
      national.filter(
        (order) => order.side === input.side && (tier === null || order.tier === tier),
      ),
    ).map(effectiveRate);

    const sellOrders = place.filter((order) => order.side === 'SELL');
    const buyOrders = place.filter((order) => order.side === 'BUY');
    const sumLitres = (orders: Order[]): number =>
      orders.reduce((total, order) => total + order.litres, 0);

    return {
      province,
      county,
      side: input.side,
      tier,
      windowDays,
      sampleSize: rates.length,
      excludedSuspicious: ofSide.length - rates.length,
      averageRateToman: mean(rates),
      medianRateToman: median(rates),
      p25RateToman: percentile(rates, 25),
      p75RateToman: percentile(rates, 75),
      minRateToman: rates.length > 0 ? Math.min(...rates) : null,
      maxRateToman: rates.length > 0 ? Math.max(...rates) : null,
      averageTotalRateToman: mean(totals),
      minTotalRateToman: totals.length > 0 ? Math.min(...totals) : null,
      maxTotalRateToman: totals.length > 0 ? Math.max(...totals) : null,
      averageLitres: mean(usable.map((order) => order.litres)),
      byTier: (['T1500', 'T3000', 'T10000'] as const).map((each) => {
        const ofTier = usable.filter((order) => order.tier === each);
        const tierTotals = ofTier.map(effectiveRate);
        return {
          tier: each,
          sampleSize: ofTier.length,
          averageTotalRateToman: mean(tierTotals),
          minTotalRateToman: tierTotals.length > 0 ? Math.min(...tierTotals) : null,
          maxTotalRateToman: tierTotals.length > 0 ? Math.max(...tierTotals) : null,
        };
      }),
      buyLitres: sumLitres(buyOrders),
      sellLitres: sumLitres(sellOrders),
      buyCount: buyOrders.length,
      sellCount: sellOrders.length,
      // Without a place the national row would just repeat the block above, so keep it null.
      nationalAverageTotalRateToman:
        province === null && county === null ? null : mean(nationalTotals),
      nationalSampleSize: province === null && county === null ? 0 : nationalTotals.length,
      nationalCountyCount:
        province === null && county === null
          ? 0
          : new Set(national.map((order) => `${order.province}/${order.county}`)).size,
      overallAverageRateToman: mean(place.map((order) => order.rateToman)),
      overallSampleSize: place.length,
      generatedAt: now.toISOString(),
    };
  }
}
