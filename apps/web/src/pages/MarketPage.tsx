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
import type {
  MarketStats,
  MetaConfig,
  OrderList,
  OrderView,
  TradeMedian,
  ZoneView,
} from '../lib/types.js';
import type { MarketFilters, SortKey } from '../lib/market.js';
import { STANDARD_LOTS, TIER_LABEL_FA, toSearchQuery } from '../lib/market.js';
import { buildQuery, navigate } from '../lib/router.js';
import { t, tf } from '../lib/i18n.js';
import {
  RADIUS_OPTIONS_KM,
  clearOrigin,
  currentPosition,
  estimateEtaMinutes,
  readOrigin,
  saveOrigin,
  type LatLng,
} from '../lib/geo.js';
import { MapPicker } from '../components/MapPicker.js';
import { OrderCard } from '../components/OrderCard.js';
import { RebookBanner } from '../components/RebookBanner.js';
import { EmptyState } from '../components/EmptyState.js';
import { ListError, Notice, PageTitle, Skeleton } from './parts.js';

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
export function MarketPage({
  api,
  config,
  zones,
  filters,
  onFilters,
}: MarketPageProps): JSX.Element {
  const [items, setItems] = useState<OrderView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G-21: the thrown value rides along so «تلاش دوباره» can also quote a tracking code.
  const [errorCause, setErrorCause] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const reload = (): void => setTick((value) => value + 1);
  const [stats, setStats] = useState<MarketStats | null>(null);
  // G-08: «میانگین بازار» — the median of closed trades, which is the number a seller anchors on.
  const [median, setMedian] = useState<TradeMedian | null>(null);
  // G-05: when an exact lot is missing the API answers with close lots plus the Persian copy.
  const [nearest, setNearest] = useState<{ litres: number; items: OrderView[] } | null>(null);
  const [lotMessage, setLotMessage] = useState<string | null>(null);

  // G-07: the traveler point lives on the device, so a reload keeps the distance figures.
  const [origin, setOrigin] = useState<LatLng | null>(() => readOrigin());
  const [travelerNote, setTravelerNote] = useState<string | null>(null);
  const [pickPoint, setPickPoint] = useState(false);

  const counties = countiesOf(filters.province);
  const placeName = placeLabelFa(filters) || t('market.allIran');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = toSearchQuery(filters, { origin });
    Promise.all([
      api.get<OrderList>('/v1/orders', query),
      api
        .get<MarketStats>('/v1/stats/market', {
          province: filters.province || undefined,
          county: filters.county || undefined,
          side: filters.side,
        })
        .catch(() => null),
      api
        .get<TradeMedian>('/v1/stats/market/median', {
          province: filters.province || undefined,
          county: filters.county || undefined,
        })
        .catch(() => null),
    ])
      .then(([list, marketStats, tradeMedian]) => {
        if (cancelled) return;
        setItems(list.items);
        setCursor(list.nextCursor);
        setStats(marketStats);
        setMedian(tradeMedian);
        setNearest(list.nearest ?? null);
        setLotMessage(list.message ?? null);
        setErrorCause(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause, errorMap));
        setErrorCause(cause);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    filters.province,
    filters.county,
    filters.side,
    filters.sort,
    filters.litres,
    filters.litresMode,
    filters.minLitres,
    filters.radiusKm,
    origin,
    api,
    tick,
  ]);

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
      const list = await api.get<OrderList>(
        '/v1/orders',
        toSearchQuery(filters, { cursor, origin }),
      );
      setItems((current) => [...current, ...list.items]);
      setCursor(list.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause, errorMap));
    } finally {
      setLoadingMore(false);
    }
  };

  /** Turning the switch on asks the browser once; a refusal drops the user on the map. */
  const toggleTraveler = async (): Promise<void> => {
    if (origin) {
      clearOrigin();
      setOrigin(null);
      setPickPoint(false);
      setTravelerNote(null);
      apply({ radiusKm: '' });
      return;
    }
    const result = await currentPosition();
    if (result.point) {
      saveOrigin(result.point);
      setOrigin(result.point);
      setTravelerNote(null);
      apply({ sort: 'distance' });
      return;
    }
    setTravelerNote(t('market.travelerDenied'));
    setPickPoint(true);
  };

  const chooseOrigin = (point: LatLng | null): void => {
    if (!point) {
      clearOrigin();
      setOrigin(null);
      setPickPoint(false);
      apply({ radiusKm: '' });
      return;
    }
    saveOrigin(point);
    setOrigin(point);
    setPickPoint(false);
    setTravelerNote(null);
    if (filters.sort === 'newest') apply({ sort: 'distance' });
  };

  /** The card shows the API's ETA, and falls back to the same formula when it is absent. */
  const etaOf = (view: OrderView): number | undefined =>
    view.distance
      ? (view.distance.etaMinutes ?? estimateEtaMinutes(view.distance.distanceKm))
      : undefined;

  const nationalDelta =
    stats?.averageTotalRateToman != null && stats.nationalAverageTotalRateToman != null
      ? stats.averageTotalRateToman - stats.nationalAverageTotalRateToman
      : null;

  return (
    <div>
      <PageTitle title={t('market.title')} lead={t('market.lead')} />

      {/* G-04: a buyer whose reservation just expired can rebook the same order in one tap. */}
      <RebookBanner api={api} onReserved={(id) => navigate(`/trade/${id}`)} />

      {/* G-05: standard lots first, an exact lot or a between-range behind one toggle. */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label mb-0">{t('market.lot')}</span>
          <div className="flex gap-1">
            {(['exact', 'range'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`chip ${filters.litresMode === mode ? 'chip-active' : ''}`}
                onClick={() => apply({ litresMode: mode })}
              >
                {mode === 'exact' ? t('market.lotModeExact') : t('market.lotModeRange')}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={`chip ${!filters.litres && !filters.minLitres ? 'chip-active' : ''}`}
            onClick={() => apply({ litres: '', minLitres: '' })}
          >
            {t('market.lotAny')}
          </button>
          {STANDARD_LOTS.map((lot) => (
            <button
              key={lot}
              type="button"
              className={`chip tnum ${filters.litres === String(lot) ? 'chip-active' : ''}`}
              onClick={() => apply({ litres: String(lot) })}
            >
              {toPersianDigits(lot)}
            </button>
          ))}
        </div>
        {filters.litresMode === 'range' ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="market-lot-from">
                {t('market.lotFrom')}
              </label>
              <input
                id="market-lot-from"
                className="input text-sm tnum"
                inputMode="numeric"
                value={filters.minLitres}
                onChange={(event) =>
                  apply({ minLitres: event.target.value.replace(/[^0-9]/g, '') })
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="market-lot-to">
                {t('market.lotTo')}
              </label>
              <input
                id="market-lot-to"
                className="input text-sm tnum"
                inputMode="numeric"
                value={filters.litres}
                onChange={(event) => apply({ litres: event.target.value.replace(/[^0-9]/g, '') })}
              />
            </div>
          </div>
        ) : null}
      </div>

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
          className="input max-w-32 text-sm"
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

      {/* G-07: search from a point — distance, ETA and an optional radius. */}
      <div className="card mb-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-sm font-bold">{t('market.traveler')}</span>
            <p className="mt-0.5 text-xs text-muted">{t('market.travelerLead')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={origin !== null}
            aria-label={t('market.traveler')}
            onClick={() => void toggleTraveler()}
            className={`min-h-tap rounded-full px-3 text-xs font-medium ${
              origin ? 'bg-brand text-brandInk' : 'bg-surface2 text-muted'
            }`}
          >
            {origin ? t('market.travelerOn') : t('market.travelerOff')}
          </button>
        </div>

        {travelerNote ? <p className="mt-2 text-xs text-danger">{travelerNote}</p> : null}

        {origin ? (
          <>
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="label mb-0">{t('market.radius')}</span>
                <span className="text-xs text-muted tnum" dir="ltr">
                  {filters.radiusKm
                    ? tf('market.radiusOption', { km: filters.radiusKm })
                    : t('market.radiusAny')}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={`chip ${!filters.radiusKm ? 'chip-active' : ''}`}
                  onClick={() => apply({ radiusKm: '' })}
                >
                  {t('market.radiusAny')}
                </button>
                {RADIUS_OPTIONS_KM.map((km) => (
                  <button
                    key={km}
                    type="button"
                    className={`chip tnum ${filters.radiusKm === String(km) ? 'chip-active' : ''}`}
                    onClick={() => apply({ radiusKm: String(km), sort: 'distance' })}
                  >
                    {tf('market.radiusOption', { km: toPersianDigits(km) })}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">{t('market.originHint')}</p>
            </div>
            <button
              type="button"
              className="chip mt-2"
              onClick={() => setPickPoint((open) => !open)}
            >
              {t('map.title')}
            </button>
          </>
        ) : null}

        {pickPoint ? (
          <div className="mt-2">
            <MapPicker
              boundary={zones[0]?.boundary ?? null}
              value={origin}
              onChange={chooseOrigin}
              allowCurrent
              compact
            />
          </div>
        ) : null}
      </div>

      {median ? (
        <div className="card mb-3 flex flex-wrap items-center justify-between gap-2 p-3">
          <div>
            <p className="text-sm font-bold">{t('market.medianTitle')}</p>
            <p className="mt-0.5 text-xs text-muted">{t('market.medianLead')}</p>
          </div>
          <div className="text-end">
            {median.sufficient && median.medianRateToman !== null ? (
              <>
                <p className="money text-base tnum">{formatToman(median.medianRateToman)}</p>
                <p className="text-xs text-muted tnum">
                  {t('market.medianPerLitre')}
                  <span aria-hidden="true"> · </span>
                  {tf('market.medianSample', { count: toPersianDigits(median.trades) })}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-muted">{t('market.medianInsufficient')}</p>
                <p className="text-xs text-muted tnum">
                  {tf('market.medianNeeded', {
                    count: toPersianDigits(median.requiredTrades),
                  })}
                </p>
              </>
            )}
          </div>
        </div>
      ) : null}

      {stats ? (
        <div className="card mb-3 p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold">{placeName}</span>
            <span className="text-xs text-muted tnum">
              {tf('market.sample', {
                count: toPersianDigits(stats.sampleSize),
                days: toPersianDigits(stats.windowDays),
              })}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-sm bg-surface2 p-2">
              <div className="text-xs text-muted">{t('market.statAvg')}</div>
              <div className="money text-sm tnum">{toman(stats.averageTotalRateToman)}</div>
            </div>
            <div className="rounded-sm bg-surface2 p-2">
              <div className="text-xs text-muted">{t('market.statMax')}</div>
              <div className="money text-sm tnum">{toman(stats.maxTotalRateToman)}</div>
            </div>
            <div className="rounded-sm bg-surface2 p-2">
              <div className="text-xs text-muted">{t('market.statMin')}</div>
              <div className="money text-sm tnum">{toman(stats.minTotalRateToman)}</div>
            </div>
          </div>
          {stats.side === 'SELL' && stats.byTier.some((row) => row.sampleSize > 0) ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted tnum">
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
            <p className="mt-2 text-xs text-muted">{t('market.perLitreNote')}</p>
          ) : null}
          <p className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted tnum">
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

      {error ? <ListError message={error} error={errorCause} onRetry={reload} /> : null}
      {loading ? <Skeleton rows={3} /> : null}

      {lotMessage ? <Notice tone="info">{lotMessage}</Notice> : null}

      {!loading && items.length === 0 && !error && !lotMessage ? (
        <EmptyState title={t('market.empty')} body={t('market.emptyBody')} icon="search" />
      ) : null}

      {nearest && nearest.items.length > 0 ? (
        <div className="mb-3">
          <p className="mb-1.5 text-xs text-muted">{t('market.lotNearest')}</p>
          <div className="flex flex-col gap-3">
            {nearest.items.map((order) => (
              <OrderCard
                key={`near-${order.id}`}
                side={order.side}
                status={order.status}
                litres={order.litres}
                rateToman={order.rateToman}
                pumpFeeToman={order.pumpFeeToman}
                buyerTotalToman={order.buyerTotalToman}
                placeName={placeLabelFa(order) || order.stationName || placeName}
                distanceKm={order.distance?.distanceKm}
                etaMinutes={etaOf(order)}
                expiresAt={order.expiresAt}
                ownerResponseLabel={order.owner?.labelFa}
                ownerResponseRate={order.owner?.ratePercent ?? null}
                onOpen={() => navigate(`/market/${order.id}`)}
              />
            ))}
          </div>
        </div>
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
            etaMinutes={etaOf(order)}
            expiresAt={order.expiresAt}
            ownerResponseLabel={order.owner?.labelFa}
            ownerResponseRate={order.owner?.ratePercent ?? null}
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
