import type { ReactNode } from 'react';
import { t } from '../lib/i18n.js';
import { errorTracking } from '../lib/api.js';

export type NoticeTone = 'info' | 'error' | 'success' | 'warning';

const TONE: Record<NoticeTone, string> = {
  info: 'border-brand/30 bg-brandSoft text-ink',
  success: 'border-success/30 bg-success/10 text-ink',
  error: 'border-danger/30 bg-dangerSoft text-ink',
  warning: 'border-warning/30 bg-accentSoft text-ink',
};

/** Inline banner used by every screen instead of a raw alert box. */
export function Notice({
  tone = 'info',
  children,
  action,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-3 flex items-center justify-between gap-2 rounded-sm border px-3 py-2 text-sm ${TONE[tone]}`}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}

/**
 * G-21 — the error state of every list, in one place.
 *
 * The spec asks for three things on failure: what happened, a way out («تلاش دوباره») and a
 * tracking code. The third one is the one that always got skipped, and it is the only part that
 * helps after the user closes the app.
 */
export function ListError({
  message,
  error,
  onRetry,
}: {
  message: string;
  /** The thrown value, used only for its tracking code. */
  error?: unknown;
  onRetry?: () => void;
}): JSX.Element {
  const tracking = errorTracking(error);
  return (
    <div role="alert" className="card border border-danger/30 bg-dangerSoft">
      <p className="text-sm font-bold text-ink">{message}</p>
      <p className="mt-1 text-xs text-muted">
        {t('state.errorHint')}{' '}
        <span dir="ltr" className="font-mono">
          {tracking}
        </span>
      </p>
      {onRetry ? (
        <button type="button" className="btn mt-3 min-h-tap px-3 text-sm" onClick={onRetry}>
          {t('state.retry')}
        </button>
      ) : null}
    </div>
  );
}

/** Skeleton block so loading never shows a blank screen. */
export function Skeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="card animate-pulse">
          <div className="mb-2 h-3 w-1/3 rounded-pill bg-surface2" />
          <div className="h-3 w-2/3 rounded-pill bg-surface2" />
        </div>
      ))}
    </div>
  );
}

/** Section heading with an optional trailing action. */
export function PageTitle({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-4 flex items-start justify-between gap-2">
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        {lead ? <p className="mt-1 text-sm text-muted">{lead}</p> : null}
      </div>
      {action}
    </div>
  );
}
