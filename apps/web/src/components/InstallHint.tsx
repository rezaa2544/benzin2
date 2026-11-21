/**
 * G-17 — the «add to home screen» card, shown only where it can work.
 *
 * iOS has no install prompt, so an iPhone user who never taps Share never gets an icon, and an
 * app that is not installed cannot receive Web Push on iOS at all. This one card is the whole
 * onboarding for that. It is dismissible, remembered, and invisible everywhere else.
 *
 * The decision lives in `lib/ios.ts` (pure, tested); this file only draws it.
 */

import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { dismissInstallHint, readInstallHintDismissed, shouldShowInstallHint } from '../lib/ios.js';

export function InstallHint(): JSX.Element | null {
  const [visible, setVisible] = useState(() => {
    if (typeof window === 'undefined') return false;
    return shouldShowInstallHint(
      {
        userAgent: window.navigator.userAgent,
        standalone:
          // Safari-only flag, plus the standard display-mode query.
          Boolean((window.navigator as unknown as { standalone?: boolean }).standalone) ||
          window.matchMedia('(display-mode: standalone)').matches,
        hasInstallPrompt: 'onbeforeinstallprompt' in window,
        dismissed: readInstallHintDismissed(window.localStorage),
      },
      window.navigator.maxTouchPoints ?? 0,
    );
  });

  if (!visible) return null;

  const close = (): void => {
    dismissInstallHint(window.localStorage);
    setVisible(false);
  };

  return (
    <div
      role="status"
      className="card mb-3 flex items-start gap-3 border-brand/40 bg-surface2 p-3 text-sm"
      data-testid="ios-install-hint"
    >
      <span aria-hidden="true" className="text-lg leading-none">
        ⬆️
      </span>
      <div className="flex-1">
        <p className="font-bold">{t('pwa.installTitle')}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{t('pwa.installBody')}</p>
      </div>
      <button type="button" className="btn btn-ghost min-h-tap px-2 text-xs" onClick={close}>
        {t('pwa.installDismiss')}
      </button>
    </div>
  );
}
