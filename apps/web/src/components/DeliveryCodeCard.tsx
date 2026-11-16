import { useCallback, useState } from 'react';
import { formatJalaliDateTime, toPersianDigits } from '@benzin/shared';
import type { ApiClient } from '../lib/api.js';
import { errorMessage } from '../lib/api.js';
import type { DeliveryCode } from '../lib/types.js';
import { useNow, useResource } from '../lib/useResource.js';
import { t, tf } from '../lib/i18n.js';
import { Notice } from '../pages/parts.js';

/**
 * G-09 — the card the buyer holds up at the pump.
 *
 * Only the buyer mounts this (the seller would get 403 `DELIVERY_CODE_BUYER_ONLY` from the API, but
 * asking for it at all would be silly). The digits are deliberately huge and LTR so they can be
 * read across a noisy forecourt, and the lock state is shown as a live countdown instead of an
 * error the user has to interpret.
 */
export function DeliveryCodeCard({
  api,
  reservationId,
}: {
  api: ApiClient;
  reservationId: string;
}): JSX.Element {
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const load = useCallback(
    () => api.get<DeliveryCode>(`/v1/reservations/${reservationId}/delivery-code`),
    [api, reservationId],
  );
  const { data, error } = useResource(load, [api, reservationId]);

  if (error) {
    return <Notice tone="error">{errorMessage(error, {})}</Notice>;
  }
  if (!data) return <></>;

  const lockedMs = data.lockedUntil ? new Date(data.lockedUntil).getTime() - now : 0;
  const locked = lockedMs > 0;

  return (
    <div className="card mb-3" data-testid="delivery-code">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-bold">{t('trade.deliveryCodeTitle')}</p>
        <span className="text-[11px] text-muted tnum">
          {formatJalaliDateTime(data.expiresAt)}
        </span>
      </div>
      <p className="mb-2 text-[11px] text-muted">{t('trade.deliveryCodeLead')}</p>
      <button
        type="button"
        // Tapping copies nothing on desktop and is harmless on mobile: it is a large tap target
        // that reveals the digits for a screenshot at the pump.
        onClick={() => setCopied(true)}
        className="w-full rounded-md bg-surface-strong py-3"
        aria-label={t('trade.deliveryCodeTitle')}
      >
        <span dir="ltr" className="tnum text-3xl font-black tracking-[0.4em]">
          {toPersianDigits(data.code)}
        </span>
      </button>
      {locked ? (
        <p className="mt-2 text-xs text-danger tnum">
          {t('trade.deliveryCodeLocked')} · {toPersianDigits(Math.ceil(lockedMs / 60_000))}′
        </p>
      ) : copied || data.attemptsRemaining < 3 ? (
        <p className="mt-2 text-[11px] text-muted tnum">
          {tf('trade.deliveryCodeAttempts', { count: toPersianDigits(data.attemptsRemaining) })}
        </p>
      ) : null}
    </div>
  );
}
