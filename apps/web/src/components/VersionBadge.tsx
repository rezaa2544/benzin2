import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';

/**
 * Version + update chip in the top-left corner of the header.
 *
 * The desktop shell (`desktop/main.cjs`) answers `/shell/status` on the same origin, so the UI can
 * show the *content* version that is actually running and a light for the automatic updater:
 *
 *   green  → running the newest build in the release channel
 *   amber  → a newer build was found and is being downloaded / installed / restarted into
 *   red    → the channel could not be reached or the install failed
 *   gray   → not a desktop build (browser/PWA) or the shell has not checked yet
 *
 * Clicking the chip triggers an immediate check. In a plain browser the endpoint is missing, so the
 * chip falls back to the API version with a neutral light and stays silent.
 */

interface ShellStatus {
  version: string;
  status:
    | 'idle'
    | 'checking'
    | 'current'
    | 'downloading'
    | 'installing'
    | 'restarting'
    | 'offline'
    | 'failed';
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

type Tone = 'ok' | 'busy' | 'error' | 'idle';

const TONES: Record<ShellStatus['status'], Tone> = {
  idle: 'idle',
  checking: 'busy',
  current: 'ok',
  downloading: 'busy',
  installing: 'busy',
  restarting: 'busy',
  offline: 'error',
  failed: 'error',
};

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-success',
  busy: 'bg-warning animate-pulse',
  error: 'bg-danger',
  idle: 'bg-muted',
};

const TONE_LABEL: Record<Tone, string> = {
  ok: 'shell.version.upToDate',
  busy: 'shell.version.updating',
  error: 'shell.version.problem',
  idle: 'shell.version.unknown',
};

const POLL_MS = 3000;

export interface VersionBadgeProps {
  /** Pins the chip to the top-left corner of the viewport (screens without the app header). */
  fixed?: boolean;
}

export function VersionBadge({ fixed = false }: VersionBadgeProps = {}): JSX.Element | null {
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const read = async (): Promise<void> => {
      try {
        const response = await fetch('/shell/status', { headers: { accept: 'application/json' } });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !type.includes('application/json')) throw new Error('no shell');
        const status = (await response.json()) as ShellStatus;
        if (mounted.current) setShell(status);
      } catch {
        if (!mounted.current) return;
        // Browser / PWA: fall back to the API build version, no updater to report on.
        try {
          const response = await fetch('/v1/meta/config', {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) return;
          const config = (await response.json()) as { version?: string; appVersion?: string };
          const version = config.version ?? config.appVersion ?? null;
          if (mounted.current && version) setFallback(version);
        } catch {
          /* offline preview: stay quiet */
        }
      }
    };
    void read();
    const timer = window.setInterval(() => {
      void read();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  const version = shell?.version ?? fallback;
  if (!version) return null;

  const tone: Tone = shell ? TONES[shell.status] : 'idle';
  const tooltip = shell
    ? [
        t(TONE_LABEL[tone]),
        shell.latest && shell.updateAvailable
          ? `${t('shell.version.latest')}: ${shell.latest}`
          : null,
        shell.checkedAt
          ? `${t('shell.version.checkedAt')}: ${new Date(shell.checkedAt).toLocaleTimeString('fa-IR')}`
          : null,
        shell.error ?? null,
      ]
        .filter(Boolean)
        .join('\n')
    : t(TONE_LABEL.idle);

  const check = (): void => {
    if (!shell) return;
    void fetch('/shell/check', { method: 'POST' }).catch(() => undefined);
  };

  return (
    <button
      type="button"
      dir="ltr"
      onClick={check}
      title={tooltip}
      aria-label={`${t('shell.version.label')} ${version} — ${t(TONE_LABEL[tone])}`}
      className={`flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface/95 px-2 font-mono text-xs leading-none text-muted shadow-sm transition hover:text-ink ${
        fixed ? 'fixed left-2 top-2 z-nav' : ''
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[tone]}`} aria-hidden />
      <span>{version}</span>
    </button>
  );
}
