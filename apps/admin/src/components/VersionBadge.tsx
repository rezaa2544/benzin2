import { useEffect, useRef, useState } from 'react';
import fa from '../i18n/fa.json';

/**
 * Version + updater light for the admin window (mirror of the customer app chip).
 *
 * The desktop shell answers `/shell/status` on the same origin; in a browser the request fails and
 * the chip simply renders nothing. Green = newest build, amber = an update is being applied,
 * red = the release channel is unreachable or the install failed.
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

const TONE: Record<ShellStatus['status'], { dot: string; label: string }> = {
  idle: { dot: 'bg-muted', label: fa.shell.version.unknown },
  checking: { dot: 'bg-warning animate-pulse', label: fa.shell.version.updating },
  current: { dot: 'bg-success', label: fa.shell.version.upToDate },
  downloading: { dot: 'bg-warning animate-pulse', label: fa.shell.version.updating },
  installing: { dot: 'bg-warning animate-pulse', label: fa.shell.version.updating },
  restarting: { dot: 'bg-warning animate-pulse', label: fa.shell.version.updating },
  offline: { dot: 'bg-danger', label: fa.shell.version.problem },
  failed: { dot: 'bg-danger', label: fa.shell.version.problem },
};

export function VersionBadge(): JSX.Element | null {
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const read = async (): Promise<void> => {
      try {
        const response = await fetch('/shell/status', { headers: { accept: 'application/json' } });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !type.includes('application/json')) return;
        const status = (await response.json()) as ShellStatus;
        if (mounted.current) setShell(status);
      } catch {
        /* plain browser: nothing to report */
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 3000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!shell) return null;
  const tone = TONE[shell.status];

  return (
    <button
      type="button"
      dir="ltr"
      title={`${tone.label}${shell.latest && shell.updateAvailable ? ` — ${fa.shell.version.latest}: ${shell.latest}` : ''}`}
      onClick={() => void fetch('/shell/check', { method: 'POST' }).catch(() => undefined)}
      className="border-line bg-surface text-muted hover:text-ink flex h-6 items-center gap-1.5 rounded-full border px-2 font-mono text-[0.625rem] leading-none"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
      <span>{shell.version}</span>
    </button>
  );
}
