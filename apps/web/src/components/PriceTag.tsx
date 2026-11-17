import { formatRate, formatLitres, formatToman } from '@benzin/shared';
import { t } from '../lib/i18n.js';

export interface PriceTagProps {
  /** What the seller asks for one litre of quota. */
  rateToman: number;
  litres?: number;
  /** Pump fee per litre on top of `rateToman`; omitted for buy requests. */
  pumpFeeToman?: number;
  /** litres × (rate + pump fee). Defaults to litres × rate when no fee is given. */
  totalToman?: number;
  size?: 'sm' | 'md';
}

/**
 * Rate and (optionally) the order total. Both numbers use the shared formatters, so the
 * Persian separator and digits are identical everywhere money is shown. When the listing
 * carries a pump fee, the big number is the all-in per-litre price a buyer pays and the
 * seller's own quote is spelled out underneath, because that is the offer being compared.
 */
export function PriceTag({
  rateToman,
  litres,
  pumpFeeToman,
  totalToman,
  size = 'md',
}: PriceTagProps): JSX.Element {
  const big = size === 'md';
  const fee = pumpFeeToman ?? 0;
  const perLitre = rateToman + fee;
  const total = totalToman ?? (litres === undefined ? undefined : Math.round(litres * perLitre));
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`flex items-baseline gap-1 ${big ? 'text-lg' : 'text-sm'}`}>
        <span className="font-bold tnum">{formatRate(perLitre)}</span>
        <span className="text-xs text-muted">{t('common.perLitre')}</span>
      </div>
      {fee > 0 ? (
        <div className="text-xs text-muted tnum">
          {t('order.priceBreakdown')
            .replace('{rate}', formatRate(rateToman))
            .replace('{fee}', formatRate(fee))}
        </div>
      ) : null}
      {litres !== undefined && total !== undefined ? (
        <div className="flex items-center gap-1 text-xs text-muted">
          <span className="tnum">{formatLitres(litres)}</span>
          <span aria-hidden="true">·</span>
          <span className="tnum font-medium text-ink">{formatToman(total)}</span>
        </div>
      ) : null}
    </div>
  );
}
