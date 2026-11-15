import { useEffect, useState } from 'react';
import {
  IRAN_PROVINCES,
  ORDER_SIDE_FA,
  countiesOf,
  formatLitres,
  formatRate,
  formatToman,
  placeLabelFa,
  toPersianDigits,
  type OrderSide,
} from '@benzin/shared';
import type { ApiClient } from '../lib/api.js';
import { errorMessage } from '../lib/api.js';
import type { MarketStats, MetaConfig, OrderList, OrderView, ZoneView } from '../lib/types.js';
import type { MarketFilters, SortKey } from '../lib/market.js';
import { TIER_LABEL_FA, toSearchQuery } from '../lib/market.js';
import { buildQuery, navigate } from '../lib/router.js';
import { t, tf } from '../lib/i18n.js';
import { OrderCard } from '../components/OrderCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { Notice, PageTitle, Skeleton } from './parts.js';

export interface MarketPageProps {
  api: ApiClient;
  config: MetaConfig | null;
  zones: ZoneView[];
  filters: MarketFilters;
  onFilters: (next: MarketFilters) => void;
}

const errorMap = {
  NETWORK: t('errors.NETWORK'),
  UNKNOWN: t('errors.UNKNOWN'),
  UNAUTHORIZED: t('errors.UNAUTHORIZED'),
  ZONE_NOT_SUPPORTED: t('errors.ZONE_NOT_SUPPORTED'),
  VALIDATION_ERROR: t('errors.VALIDATION_ERROR'),
};

const SIDES: readonly OrderSide[] = ['BUY', 'SELL'];
const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'newest', label: t('market.sortNewest') },
  { key: 'price', label: t('market.sortPrice') },
  { key: 'distance', label: t('market.sortDistance') },
];

/** Green for a buy request, red for a sell offer — the palette the owner asked for. */
const SIDE_CLASS: Record<OrderSide, { on: string; off: string }> = {
  BUY: { on: 'bg-brand text-brandInk', off: 'bg-surface text-brand' },
  SELL: { on: 'bg-danger text-white', off: 'bg-surface text-danger' },
};

// formatToman/formatLitres already carry their unit, so these stay unit-free wrappers.
const toman = (value: number | null): string => (value === null ? '—' : formatToman(value));

const litres = (value: number): string => formatLitres(value);

/**
 * Market list (E9-05/E9-06). The place is chosen with a province → county cascade, the
 * filters live in the URL, and a stat block answers the two questions a user actually has:
 * «سهمیه در این شهر چند است؟» and «در کل کشور چطور؟».
 */
export function MarketPage({ api, config, filters, onFilters }: MarketPageProps): JSX.Element {
  const [items, setItems] = useState<OrderView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<MarketStats | null>(null);

  const counties = countiesOf(filters.province);
  const placeName = placeLabelFa(filters) || t('market.allIran');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = toSearchQuery(filters);
    Promise.all([
      api.get<OrderList>('/v1/orders', query),
      api
        .get<MarketStats>('/v1/stats/market', {
          province: filters.province || undefined,
          county: filters.county || undefined,
          side: filters.side,
        })
        .catch(() => null),
    ])
      .then(([list, marketStats]) => {
        if (cancelled) return;
        setItems(list.items);
        setCursor(list.nextCursor);
        setStats(marketStats);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause, errorMap));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.province, filters.county, filters.side, filters.sort]);

  const apply = (patch: Partial<MarketFilters>): void => {
    const next = { ...filters, ...patch };
    onFilters(next);
    navigate(`/market${buildQuery({ ...next })}`, { replace: true });
  };

  /** Switching province resets the county, otherwise the pair could never match. */
  const applyProvince = (province: string): void => apply({ province, county: '' });

  const loadMore = async (): Promise<void> => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const list = await api.get<OrderList>('/v1/orders', toSearchQuery(filters, { cursor }));
      setItems((current) => [...current, ...list.items]);
      setCursor(list.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause, errorMap));
    } finally {
      setLoadingMore(false);
    }
  };

  const nationalDelta =
    stats?.averageTotalRateToman != null && stats.nationalAverageTotalRateToman != null
      ? stats.averageTotalRateToman - stats.nationalAverageTotalRateToman
      : null;

  return (
    <div>
      <PageTitle title={t('market.title')} lead={t('market.lead')} />

      <div className="mb-3 grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="market-province">
            {t('market.province')}
          </label>
          <select
            id="market-province"
            className="input text-sm"
            value={filters.province}
            onChange={(event) => applyProvince(event.target.value)}
          >
            <option value="">{t('market.allIran')}</option>
            {IRAN_PROVINCES.map((province) => (
              <option key={province.id} value={province.nameFa}>
                {province.nameFa}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="market-county">
            {t('market.county')}
          </label>
          <select
            id="market-county"
            className="input text-sm disabled:opacity-60"
            value={filters.county}
            disabled={counties.length === 0}
            onChange={(event) => apply({ county: event.target.value })}
          >
            <option value="">{t('market.allCounties')}</option>
            {counties.map((county) => (
              <option key={county} value={county}>
                {county}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-1 overflow-hidden rounded-sm border border-line">
          {SIDES.map((side) => (
            <button
              key={side}
              type="button"
              aria-pressed={filters.side === side}
              onClick={() => apply({ side })}
              className={`min-h-tap flex-1 px-3 text-sm font-medium ${
                filters.side === side ? SIDE_CLASS[side].on : SIDE_CLASS[side].off
              }`}
            >
              {ORDER_SIDE_FA[side]}
            </button>
          ))}
        </div>
        <select
          aria-label={t('market.sort')}
          className="input max-w-[8rem] text-sm"
          value={filters.sort}
          onChange={(event) => apply({ sort: event.target.value as SortKey })}
        >
          {SORTS.map((sort) => (
            <option key={sort.key} value={sort.key}>
              {sort.label}
            </option>
          ))}
        </select>
      </div>

      {stats ? (
        <div className="card mb-3 p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold">{placeName}</span>
            <span className="text-[11px] text-muted tnum">
              {tf('market.sample', {
                count: toPersianDigits(stats.sampleSize),
                days: toPersianDigits(stats.windowDays),
              })}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-sm bg-surface2 p-2">
              <div className="text-[11px] text-muted">{t('market.statAvg')}</div>
              <div className="money text-sm tnum">{toman(stats.averageTotalRateToman)}</div>
            </div>
            <div className="rounded-sm bg-surface2 p-2">
              <div className="text-[11px] text-muted">{t('market.statMax')}</div>
              <div className="money text-sm tnum">{toman(stats.maxTotalRateToman)}</div>
            </div>
            <div className="rounded-sm bg-surface2 p-2">
              <div className="text-[11px] text-muted">{t('market.statMin')}</div>
              <div className="money text-sm tnum">{toman(stats.minTotalRateToman)}</div>
            </div>
          </div>
          {stats.side === 'SELL' && stats.byTier.some((row) => row.sampleSize > 0) ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted tnum">
              <span>{t('market.byTier')}</span>
              {stats.byTier
                .filter((row) => row.sampleSize > 0)
                .map((row) => (
                  <span key={row.tier} className="chip">
                    {`${TIER_LABEL_FA[row.tier]}: ${
                      row.averageTotalRateToman === null
                        ? '—'
                        : formatToman(row.averageTotalRateToman)
                    }`}
                  </span>
                ))}
            </p>
          ) : null}
          {stats.side === 'SELL' ? (
            <p className="mt-2 text-[11px] text-muted">{t('market.perLitreNote')}</p>
          ) : null}
          <p className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted tnum">
            <span>
              {tf('market.buyLitres', {
                litres: litres(stats.buyLitres),
                count: toPersianDigits(stats.buyCount),
              })}
              <span aria-hidden="true"> · </span>
              {tf('market.sellLitres', {
                litres: litres(stats.sellLitres),
                count: toPersianDigits(stats.sellCount),
              })}
            </span>
          </p>
        </div>
      ) : null}

      {stats && stats.nationalAverageTotalRateToman !== null ? (
        <div className="card mb-4 flex items-center justify-between gap-2 py-2">
          <span className="text-xs text-muted">
            {tf('market.national', {
              rate: toman(stats.nationalAverageTotalRateToman),
              counties: toPersianDigits(stats.nationalCountyCount),
            })}
          </span>
          {nationalDelta !== null ? (
            <span
              className={`text-xs font-medium tnum ${
                nationalDelta < 0 ? 'text-brand' : 'text-danger'
              }`}
            >
              {tf(nationalDelta < 0 ? 'market.cheaperThanNational' : 'market.pricierThanNational', {
                amount: formatRate(Math.abs(nationalDelta)),
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <Skeleton rows={3} /> : null}

      {!loading && items.length === 0 && !error ? (
        <EmptyState title={t('market.empty')} body={t('market.emptyBody')} icon="search" />
      ) : null}

      <div className="flex flex-col gap-3">
        {items.map((order) => (
          <OrderCard
            key={order.id}
            side={order.side}
            status={order.status}
            litres={order.litres}
            rateToman={order.rateToman}
            pumpFeeToman={order.pumpFeeToman}
            buyerTotalToman={order.buyerTotalToman}
            placeName={placeLabelFa(order) || order.stationName || placeName}
            distanceKm={order.distance?.distanceKm}
            expiresAt={order.expiresAt}
            onOpen={() => navigate(`/market/${order.id}`)}
          />
        ))}
      </div>

      {cursor ? (
        <button
          type="button"
          className="btn mt-4 w-full"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? t('market.loadingMore') : t('market.loadMore')}
        </button>
      ) : null}

      {config ? (
        <p className="mt-4 text-center text-xs text-muted">
          {tf('create.litresHint', {
            min: toPersianDigits(config.minLitres),
            max: toPersianDigits(config.maxLitres),
          })}
        </p>
      ) : null}
    </div>
  );
}
