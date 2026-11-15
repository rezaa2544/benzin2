import type { OrderSide, OrderStatus } from '@benzin/shared';
import { formatJalaliTime, toPersianDigits } from '@benzin/shared';
import { orderCardView } from '../lib/order-view.js';
import { t } from '../lib/i18n.js';
import { PriceTag } from './PriceTag.js';
import { TierBadge } from './TierBadge.js';
import { Icon } from './icons.js';

export interface OrderCardProps {
  side: OrderSide;
  status: OrderStatus;
  litres: number;
  rateToman: number;
  /** Per-litre pump fee of a sell listing; ignored for buy requests. */
  pumpFeeToman?: number;
  buyerTotalToman?: number;
  placeName?: string;
  zoneName?: string;
  ownerName?: string;
  distanceKm?: number;
  /** G-07 driving estimate from the caller's search point. */
  etaMinutes?: number;
  score?: number;
  expiresAt?: string | null;
  onOpen?: () => void;
}

/**
 * The market list item (E9-02). One accent border encodes side, the badge encodes state,
 * and the whole card is a single button so keyboard and screen-reader users get one stop.
 */
export function OrderCard({
  side,
  status,
  litres,
  rateToman,
  pumpFeeToman,
  buyerTotalToman,
  placeName,
  zoneName,
  ownerName,
  score,
  distanceKm,
  etaMinutes,
  expiresAt,
  onOpen,
}: OrderCardProps): JSX.Element {
  const view = orderCardView({ side, status, litres, rateToman, zoneName, ownerName, score });
  const accent = view.tone === 'brand' ? 'border-s-brand' : 'border-s-danger';
  const badge = view.tone === 'brand' ? 'bg-brandSoft text-brand' : 'bg-dangerSoft text-danger';
  const showPump = (pumpFeeToman ?? 0) > 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`card w-full border-s-4 ${accent} text-start transition duration-fast hover:bg-surface2`}
      aria-label={`${view.side} ${view.litres} ${view.status}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-sm px-2 py-0.5 text-xs font-medium ${badge}`}>
              {view.side}
            </span>
            <span className="chip">{view.status}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-bold tnum">{view.litres}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {placeName || view.zoneName ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="market" size={14} />
                {placeName ?? view.zoneName}
              </span>
            ) : null}
            {distanceKm !== undefined ? (
              <span className="inline-flex items-center gap-1 tnum">
                <Icon name="market" size={14} />
                {t('market.distance').replace('{km}', toPersianDigits(distanceKm.toFixed(1)))}
              </span>
            ) : null}
            {etaMinutes !== undefined ? (
              <span className="inline-flex items-center gap-1 tnum">
                <Icon name="timer" size={14} />
                {t('market.eta').replace('{min}', toPersianDigits(etaMinutes))}
              </span>
            ) : null}
            {ownerName ? <span>{ownerName}</span> : null}
            {score !== undefined ? <TierBadge score={score} /> : null}
            {expiresAt ? (
              <span className="inline-flex items-center gap-1 tnum">
                <Icon name="timer" size={14} />
                {formatJalaliTime(expiresAt)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <PriceTag
            rateToman={rateToman}
            litres={litres}
            totalToman={buyerTotalToman}
            pumpFeeToman={showPump ? pumpFeeToman : undefined}
          />
          <Icon name="chevron" size={16} className="text-muted" />
        </div>
      </div>
    </button>
  );
}
