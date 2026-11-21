import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_HINT_KEY,
  dismissInstallHint,
  isIos,
  isIosSafari,
  readInstallHintDismissed,
  shouldShowInstallHint,
} from '../src/lib/ios.js';

const at = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(at(path), 'utf8');

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const probe = (overrides: Partial<Parameters<typeof shouldShowInstallHint>[0]> = {}) => ({
  userAgent: IPHONE_SAFARI,
  standalone: false,
  hasInstallPrompt: false,
  dismissed: false,
  ...overrides,
});

describe('the iOS install card (G-17)', () => {
  it('recognises iOS, including an iPad that pretends to be a Mac', () => {
    expect(isIos(IPHONE_SAFARI)).toBe(true);
    expect(isIos(ANDROID_CHROME)).toBe(false);
    expect(isIos(IPAD_DESKTOP_UA)).toBe(false);
    // iPadOS 13+ sends the desktop UA; the touch points are the only difference.
    expect(isIos(IPAD_DESKTOP_UA, 5)).toBe(true);
  });

  it('tells Safari apart from the browsers on iOS that cannot install at all', () => {
    expect(isIosSafari(IPHONE_SAFARI)).toBe(true);
    // Chrome on iOS is WebKit, but «add to home screen» would open a Chrome-styled shortcut.
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
    expect(isIosSafari(ANDROID_CHROME)).toBe(false);
  });

  it('shows the card on an uninstalled iPhone and nowhere else', () => {
    expect(shouldShowInstallHint(probe())).toBe(true);
    expect(shouldShowInstallHint(probe({ standalone: true }))).toBe(false);
    expect(shouldShowInstallHint(probe({ dismissed: true }))).toBe(false);
    // Android has a real install prompt; the card would be noise.
    expect(shouldShowInstallHint(probe({ userAgent: ANDROID_CHROME }))).toBe(false);
    // A browser that fires beforeinstallprompt does not need to be told.
    expect(shouldShowInstallHint(probe({ hasInstallPrompt: true }))).toBe(false);
  });

  it('remembers a dismissal and survives a storage that throws', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;

    expect(readInstallHintDismissed(storage)).toBe(false);
    dismissInstallHint(storage);
    expect(store.get(INSTALL_HINT_KEY)).toBe('dismissed');
    expect(readInstallHintDismissed(storage)).toBe(true);

    const hostile = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    expect(readInstallHintDismissed(hostile)).toBe(false);
    expect(() => dismissInstallHint(hostile)).not.toThrow();
  });
});

describe('the iOS shell (G-17)', () => {
  it('asks for a translucent status bar and pads the notch', () => {
    const html = read('index.html');
    // `default` leaves a white bar over a dark app; translucent + safe-area is the native look.
    expect(html).toContain('apple-mobile-web-app-status-bar-style" content="black-translucent"');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('apple-mobile-web-app-capable" content="yes"');

    const tokens = read('src/styles/tokens.css');
    expect(tokens).toContain('--safe-top: env(safe-area-inset-top, 0px)');
    expect(tokens).toContain('--safe-bottom: env(safe-area-inset-bottom, 0px)');

    expect(read('src/components/AppShell.tsx')).toContain('var(--safe-top)');
  });

  it('keeps the session in a partition iOS respects and documents the re-login', () => {
    // The installed icon is a separate storage partition on iOS: the OTP is asked again once.
    // This is a product decision recorded in docs/PWA-TEST.md, not a bug to "fix" in code.
    const doc = readFileSync(
      fileURLToPath(new URL('../../../docs/PWA-TEST.md', import.meta.url)),
      'utf8',
    );
    expect(doc.toLowerCase()).toContain('separate storage');
  });

  it('never uses a 100vh layout that iOS would clip', () => {
    for (const file of ['src/components/AppShell.tsx', 'src/pages/LoginPage.tsx']) {
      const source = read(file);
      expect(source.includes('min-h-dvh'), `${file} should use dvh`);
      expect(/min-h-screen|100vh/.test(source), `${file} still relies on 100vh`).toBe(false);
    }
  });
});
