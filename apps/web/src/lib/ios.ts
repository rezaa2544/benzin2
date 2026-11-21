/**
 * G-17 — the two things iOS does differently from every other browser.
 *
 * 1. **There is no install prompt.** Chrome and Android fire `beforeinstallprompt`; Safari never
 *    has. On iOS the only way to an icon on the home screen is Share → «افزودن به صفحهٔ اصلی»,
 *    so the app has to *tell* the user, once, and remember that it did.
 * 2. **The status bar can be translucent.** With `viewport-fit=cover` and
 *    `apple-mobile-web-app-status-bar-style: black-translucent` the WebView runs under the notch,
 *    which looks native — but only if the layout pads itself by `env(safe-area-inset-top)`.
 *
 * Both are pure functions over a probe so they can be tested without an iPhone.
 */

export interface IosProbe {
  userAgent: string;
  /** `navigator.standalone` (Safari-only) or `display-mode: standalone`. */
  standalone: boolean;
  /** iOS has no such event; kept explicit so the check reads like the reason. */
  hasInstallPrompt: boolean;
  /** A dismissed hint stays dismissed — the same card twice is a nag. */
  dismissed: boolean;
}

const IOS_RE = /iPad|iPhone|iPod/;
/** iPadOS 13+ reports a Mac user agent; the touch points are the only tell. */
const IPADOS_RE = /Macintosh/;

export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  if (IOS_RE.test(userAgent)) return true;
  return IPADOS_RE.test(userAgent) && maxTouchPoints > 1;
}

/** True when the *browser* is Safari — Chrome/Firefox on iOS cannot add to the home screen. */
export function isIosSafari(userAgent: string): boolean {
  if (!isIos(userAgent)) return false;
  const other = /CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo/.test(userAgent);
  return !other && /Safari\//.test(userAgent);
}

/**
 * Show the «add to home screen» card only when it can actually help: an iOS browser that is not
 * already installed, has no native prompt, and has not been told before.
 */
export function shouldShowInstallHint(probe: IosProbe, maxTouchPoints = 0): boolean {
  if (probe.standalone) return false;
  if (probe.hasInstallPrompt) return false;
  if (probe.dismissed) return false;
  return isIosSafari(probe.userAgent) || isIos(probe.userAgent, maxTouchPoints);
}

export const INSTALL_HINT_KEY = 'benzin.iosInstallHint';

/** Best-effort persistence: private mode can throw on both read and write. */
export function readInstallHintDismissed(store: Storage | null | undefined): boolean {
  try {
    return store?.getItem(INSTALL_HINT_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissInstallHint(store: Storage | null | undefined): void {
  try {
    store?.setItem(INSTALL_HINT_KEY, 'dismissed');
  } catch {
    // Nothing to do: the card simply comes back next launch.
  }
}

/**
 * iOS keeps a *separate* storage partition for an installed icon, so the session that exists in
 * Safari does not exist in the app. This is why the first launch of the installed PWA always
 * asks for the OTP again — documented in docs/PWA-TEST.md step 4 so nobody files it as a bug.
 */
export const IOS_INSTALLED_IS_A_NEW_SESSION = true;
