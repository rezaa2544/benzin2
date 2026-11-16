import type { ApiClient } from '../lib/api.js';
import { fmtDateTime, fmtNumber, fmtToman } from '../lib/format.js';
import { useResource } from '../lib/useResource.js';
import type { TradeMedian } from '../lib/types.js';
import { DataTable, Notice, StatCard } from '../components/ui.js';
import fa from '../i18n/fa.json';

/**
 * G-08 — «میانگین بازار» in the panel.
 *
 * The home screen shows one number for the visitor's own place; the panel has to answer the
 * operational question instead: *which* regions have enough closed trades to quote a price, and
 * which are still below the threshold. So the same endpoint is rendered as a national headline
 * plus a region table, with the count of trades next to every median.
 */
export function MarketMedianPage({ api }: { api: ApiClient }): JSX.Element {
  const { data, error, loading, reload } = useResource<TradeMedian>(
    () => api.get<TradeMedian>('/v1/stats/market/median'),
    [],
  );

  if (loading && !data) return <Notice>{fa.app.loading}</Notice>;
  if (error) {
    return (
      <div className="space-y-3">
        <Notice tone="error">
          {fa.errors[error.code as keyof typeof fa.errors] ?? error.message}
        </Notice>
        <button type="button" className="btn" onClick={reload}>
          {fa.app.retry}
        </button>
      </div>
    );
  }
  if (!data) return <Notice>{fa.app.empty}</Notice>;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">{fa.market.title}</h1>
          <p className="text-xs text-muted">{fa.market.lead}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="tnum">{fmtDateTime(data.generatedAt)}</span>
          <button type="button" className="btn px-2 py-1" onClick={reload}>
            {fa.app.refresh}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={fa.market.national}
          value={
            data.sufficient && data.medianRateToman !== null
              ? fmtToman(data.medianRateToman)
              : fa.market.insufficient
          }
          hint={data.messageFa}
        />
        <StatCard
          label={fa.market.trades}
          value={fmtNumber(data.trades)}
          hint={`${fa.market.thresholdHint.replace('{count}', fmtNumber(data.requiredTrades))}`}
        />
        <StatCard
          label={fa.market.regions}
          value={fmtNumber(data.byRegion.length)}
          hint={fa.market.regionsHint}
        />
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-bold">{fa.market.regions}</h2>
        <DataTable
          rows={data.byRegion}
          empty={fa.market.noData}
          columns={[
            { key: 'region', header: fa.market.region, render: (row) => row.labelFa },
            {
              key: 'trades',
              header: fa.market.trades,
              className: 'tnum',
              render: (row) => fmtNumber(row.trades),
            },
            {
              key: 'median',
              header: fa.market.median,
              className: 'tnum',
              render: (row) =>
                row.sufficient && row.medianRateToman !== null ? (
                  <span className="font-bold">{fmtToman(row.medianRateToman)}</span>
                ) : (
                  <span className="text-muted">{fa.market.insufficient}</span>
                ),
            },
          ]}
        />
        <p className="mt-2 text-[11px] text-muted">
          {fa.market.thresholdHint.replace('{count}', fmtNumber(data.requiredTrades))}
        </p>
      </div>
    </section>
  );
}
