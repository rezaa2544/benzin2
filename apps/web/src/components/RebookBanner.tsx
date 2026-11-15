import { useEffect, useState } from 'react';
import { toPersianDigits } from '@benzin/shared';
import type { ApiClient } from '../lib/api.js';
import { errorMessage } from '../lib/api.js';
import { t, tf } from '../lib/i18n.js';
import { Notice } from '../pages/parts.js';

/**
 * G-04: "your previous reservation was released — book the same order again or look at a new ad?"
 *
 * The API answers with the newest expired reservation whose order is still open, so the buyer is
 * never dropped on a dead screen after a timeout. `onReserved` lets the page jump to the trade view.
 */
export interface RebookHint {
  orderId: string;
  reservationId: string;
  litres: number;
  releasedAt: string;
}

export function RebookBanner({
  api,
  onReserved,
}: {
  api: ApiClient;
  onReserved: (reservationId: string) => void;
}): JSX.Element | null {
  const [hint, setHint] = useState<RebookHint | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ hint: RebookHint | null }>('/v1/reservations/rebook-hint')
      .then((result) => {
        if (alive) setHint(result.hint);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  if (!hint || dismissed) return null;

  const again = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>(`/v1/orders/${hint.orderId}/reservations`);
      setDismissed(true);
      onReserved(created.id);
    } catch (cause) {
      setError(errorMessage(cause, { UNKNOWN: t('errors.UNKNOWN'), NETWORK: t('errors.NETWORK') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <Notice tone="info">
        <p className="mb-2 font-bold">{t('rebook.title')}</p>
        <p className="mb-3 text-sm">
          {tf('rebook.body', { litres: toPersianDigits(hint.litres) })}
        </p>
        {error ? <p className="mb-2 text-xs text-danger">{error}</p> : null}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary px-3 py-1 text-xs"
            disabled={busy}
            onClick={() => void again()}
          >
            {t('rebook.again')}
          </button>
          <button
            type="button"
            className="btn btn-ghost px-3 py-1 text-xs"
            onClick={() => setDismissed(true)}
          >
            {t('rebook.new')}
          </button>
        </div>
      </Notice>
    </div>
  );
}
