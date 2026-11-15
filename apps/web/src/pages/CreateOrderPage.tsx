import { useEffect, useState } from 'react';
import {
  DEFAULT_PLACE,
  IRAN_PROVINCES,
  ORDER_SIDE_FA,
  TIER_RATE_TOMAN,
  countiesOf,
  formatRate,
  formatToman,
  toPersianDigits,
  type OrderSide,
  type Tier,
} from '@benzin/shared';
import { errorMessage } from '../lib/api.js';
import type { ApiClient } from '../lib/api.js';
import type { MetaConfig, OrderView, ZoneView } from '../lib/types.js';
import { TIER_LABEL_FA } from '../lib/market.js';
import {
  EMPTY_ORDER_FORM,
  parseNumber,
  validateOrderForm,
  type OrderFormValues,
} from '../lib/order-form.js';
import { navigate } from '../lib/router.js';
import { t } from '../lib/i18n.js';
import { FormField } from '../components/FormField.js';
import { MapPicker } from '../components/MapPicker.js';
import type { LatLng } from '../lib/geo.js';
import { Notice, PageTitle } from './parts.js';

export interface CreateOrderPageProps {
  api: ApiClient;
  config: MetaConfig | null;
  zones: ZoneView[];
  onCreated?: (order: OrderView) => void;
}

const SIDES: readonly OrderSide[] = ['SELL', 'BUY'];
const TIERS: readonly Tier[] = ['T1500', 'T3000', 'T10000'];

/** Buy is green and sell is red here as well, so the picker reads like the market badges. */
const SIDE_CLASS: Record<OrderSide, { on: string; off: string }> = {
  BUY: { on: 'bg-brand text-brandInk border-brand', off: 'border-line text-brand' },
  SELL: { on: 'bg-danger text-white border-danger', off: 'border-line text-danger' },
};

const errorMap = {
  NETWORK: t('errors.NETWORK'),
  UNKNOWN: t('errors.UNKNOWN'),
  ORDER_LIMIT_REACHED: t('errors.ORDER_LIMIT_REACHED'),
  ZONE_NOT_SUPPORTED: t('errors.ZONE_NOT_SUPPORTED'),
  TRADE_CYCLE_BLOCKED: t('errors.TRADE_CYCLE_BLOCKED'),
  SUBSCRIPTION_REQUIRED: t('errors.SUBSCRIPTION_REQUIRED'),
  VALIDATION_ERROR: t('errors.VALIDATION_ERROR'),
};

/**
 * New listing form (E9-07). The place is a province → county cascade, and the pump fee is
 * asked for on sell listings only: it is the seller's own input and the buyer simply pays it
 * on top of the quoted litre price. A live summary shows that final per-litre figure so the
 * seller sees exactly what the buyer will read.
 */
export function CreateOrderPage({
  api,
  config,
  zones,
  onCreated,
}: CreateOrderPageProps): JSX.Element {
  const [values, setValues] = useState<OrderFormValues>(EMPTY_ORDER_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof OrderFormValues, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The zone arrives with the bootstrap fetch, so it cannot be frozen at mount (G-07).
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? '');
  useEffect(() => {
    if (!zoneId && zones[0]) setZoneId(zones[0].id);
  }, [zones, zoneId]);
  const [province, setProvince] = useState<string>(DEFAULT_PLACE.province);
  const [county, setCounty] = useState<string>(DEFAULT_PLACE.county);
  // G-07: an optional point on the city map. Without it the listing has no distance/ETA.
  const [point, setPoint] = useState<LatLng | null>(null);

  const counties = countiesOf(province);
  const isSell = values.side === 'SELL';

  const bounds = {
    minLitres: config?.minLitres ?? 10,
    maxLitres: config?.maxLitres ?? 200,
  };
  const update = (patch: Partial<OrderFormValues>): void =>
    setValues((current) => ({ ...current, ...patch }));

  /**
   * G-07: the picked point is the strongest statement about where the fuel is, so it also
   * decides the city. Asking the API keeps the zone check in one place: an unsupported
   * point clears the selection instead of being submitted and rejected later.
   */
  const choosePoint = async (next: LatLng | null): Promise<void> => {
    setPoint(next);
    if (!next) return;
    try {
      const located = await api.get<{
        supported: boolean;
        zone: { id: string; province: string; city: string } | null;
      }>('/v1/zones/locate', { lat: next.lat, lng: next.lng });
      if (located.supported && located.zone) {
        setZoneId(located.zone.id);
        setProvince(located.zone.province);
        setCounty(located.zone.city);
        setError(null);
        return;
      }
      setPoint(null);
      setError(t('errors.ZONE_NOT_SUPPORTED'));
    } catch (cause) {
      setPoint(null);
      setError(errorMessage(cause, errorMap));
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    const result = validateOrderForm(values, bounds, {
      required: t('form.errorRequired'),
      litresRange: t('form.errorRange'),
      rateAboveOfficial: t('form.errorRange'),
      noteTooLong: t('form.errorRange'),
    });
    setErrors(result.errors);
    if (!result.payload) return;
    if (!province || !county) {
      setError(t('create.placeRequired'));
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<OrderView>('/v1/orders', {
        ...result.payload,
        zoneId,
        province,
        county,
        location: point ?? undefined,
      });
      onCreated?.(created);
      navigate('/orders');
    } catch (cause) {
      setError(errorMessage(cause, errorMap));
    } finally {
      setBusy(false);
    }
  };

  const rateValue = parseNumber(values.rateToman);
  const litresValue = parseNumber(values.litres);
  const pumpFee = isSell ? TIER_RATE_TOMAN[values.tier] : 0;
  const perLitre = rateValue === null ? null : rateValue + pumpFee;
  const grandTotal = perLitre === null || litresValue === null ? null : perLitre * litresValue;

  return (
    <div>
      <PageTitle title={t('create.title')} lead={t('create.lead')} />
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="card">
        <div className="mb-4">
          <span className="label">{t('create.side')}</span>
          <div className="flex gap-2">
            {SIDES.map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={values.side === side}
                onClick={() => update({ side })}
                className={`btn flex-1 border ${SIDE_CLASS[side].off} ${
                  values.side === side ? SIDE_CLASS[side].on : ''
                }`}
              >
                {ORDER_SIDE_FA[side]}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="create-province">
              {t('market.province')}
            </label>
            <select
              id="create-province"
              className="input text-sm"
              value={province}
              onChange={(event) => {
                const next = event.target.value;
                setProvince(next);
                setCounty(countiesOf(next)[0] ?? '');
                // A point from the previous city would be rejected by the zone check.
                setPoint(null);
              }}
            >
              {IRAN_PROVINCES.map((item) => (
                <option key={item.id} value={item.nameFa}>
                  {item.nameFa}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="create-county">
              {t('market.county')}
            </label>
            <select
              id="create-county"
              className="input text-sm"
              value={county}
              onChange={(event) => {
                setCounty(event.target.value);
                setPoint(null);
              }}
            >
              {counties.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </div>

        <MapPicker
          boundary={zones[0]?.boundary ?? null}
          value={point}
          onChange={(next) => void choosePoint(next)}
          label={t('create.location')}
          hint={point ? t('map.privacy') : t('create.locationHint')}
        />

        {isSell ? (
          <div className="mb-4">
            <span className="label">{t('create.tier')}</span>
            <div className="flex flex-wrap gap-2">
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  aria-pressed={values.tier === tier}
                  onClick={() => update({ tier })}
                  className={`chip min-h-tap ${
                    values.tier === tier ? 'bg-dangerSoft text-danger' : ''
                  }`}
                >
                  {TIER_LABEL_FA[tier]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">
              {t('create.pumpFeeHint').replace('{rate}', formatRate(TIER_RATE_TOMAN[values.tier]))}
            </p>
          </div>
        ) : (
          <p className="mb-4 text-xs text-muted">{t('create.pumpFeeBuyerOnly')}</p>
        )}

        <FormField
          label={t('create.litres')}
          hint={t('create.litresHint')
            .replace('{min}', toPersianDigits(bounds.minLitres))
            .replace('{max}', toPersianDigits(bounds.maxLitres))}
          error={errors.litres}
          required
        >
          {(field) => (
            <input
              {...field}
              className="input tnum"
              inputMode="numeric"
              value={values.litres}
              onChange={(event) => update({ litres: event.target.value })}
            />
          )}
        </FormField>

        <FormField label={t('create.rate')} error={errors.rateToman} required>
          {(field) => (
            <input
              {...field}
              className="input tnum"
              inputMode="numeric"
              value={values.rateToman}
              onChange={(event) => update({ rateToman: event.target.value })}
            />
          )}
        </FormField>

        {perLitre !== null ? (
          <div className="mb-4 rounded-sm bg-surface2 p-2 text-xs tnum">
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('create.summaryPerLitre')}</span>
              <span className="font-bold">{`${formatToman(perLitre)} ${t('common.toman')}`}</span>
            </div>
            {grandTotal !== null ? (
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted">{t('create.summaryTotal')}</span>
                <span className="font-bold">{`${formatToman(Math.round(grandTotal))} ${t('common.toman')}`}</span>
              </div>
            ) : null}
            {isSell ? (
              <p className="mt-1 text-[11px] text-muted">
                {t('create.summaryBreakdown')
                  .replace('{rate}', formatRate(rateValue ?? 0))
                  .replace('{fee}', formatRate(pumpFee))}
              </p>
            ) : null}
          </div>
        ) : null}

        <FormField label={t('create.station')} error={errors.stationName}>
          {(field) => (
            <input
              {...field}
              className="input"
              maxLength={80}
              value={values.stationName}
              onChange={(event) => update({ stationName: event.target.value })}
            />
          )}
        </FormField>

        <FormField label={t('create.note')} error={errors.note}>
          {(field) => (
            <textarea
              {...field}
              className="input min-h-[5rem] py-2"
              maxLength={240}
              value={values.note}
              onChange={(event) => update({ note: event.target.value })}
            />
          )}
        </FormField>

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? t('create.submitting') : t('create.submit')}
        </button>
      </div>
    </div>
  );
}
