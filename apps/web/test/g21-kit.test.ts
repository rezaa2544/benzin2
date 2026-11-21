import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  badgeTone,
  clampCount,
  countdownLabel,
  nextStep,
  splitClock,
  statusLabel,
} from '../src/lib/kit.js';
import { errorMessage, errorTracking, ApiError } from '../src/lib/api.js';
import fa from '../src/i18n/fa.json';

/**
 * G-21 — the UI unification rules that can be tested without a browser.
 *
 * Two kinds of assertions live here: the behaviour of the base components (a stepper that wraps
 * past its ceiling, a status that shows a colour nobody mapped) and the *discipline* the spec asks
 * for — every list has four states, no size outside the type scale, no colour outside the tokens.
 */
const ROOT = process.cwd();

describe('base component logic (G-21)', () => {
  it('clamps a stepper at both ends instead of wrapping', () => {
    expect(nextStep(0, -5, 0, 100)).toBe(0);
    expect(nextStep(100, 5, 0, 100)).toBe(100);
    expect(nextStep(40, 5, 0, 100)).toBe(45);
    expect(nextStep(99, 5, 0, 100)).toBe(100);
  });

  it('formats counts with Persian digits and no decimals', () => {
    expect(clampCount(1234)).toBe('۱,۲۳۴');
    expect(clampCount(-4)).toBe('۰');
    expect(clampCount(Number.NaN)).toBe('۰');
    expect(clampCount(40.4)).toBe('۴۰');
  });

  it('never shows a negative countdown, and pads to two digits', () => {
    expect(splitClock(-5000)).toEqual({ minutes: 0, seconds: 0 });
    expect(splitClock(125_000)).toEqual({ minutes: 2, seconds: 5 });
    expect(countdownLabel(2, 5)).toBe('۰۲:۰۵');
    expect(countdownLabel(59, 59)).toBe('۵۹:۵۹');
  });

  it('pairs every status with a word, not just a colour', () => {
    expect(badgeTone('OPEN')).toBe('brand');
    expect(badgeTone('CANCELLED')).toBe('danger');
    // An unknown status is grey on purpose — never green.
    expect(badgeTone('SOMETHING_NEW')).toBe('neutral');
    expect(statusLabel('COMPLETED')).toBeTruthy();
    expect(statusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('never lets an English server message reach a Persian screen', () => {
    // The market page used to print «Unexpected server error» verbatim when the code was unmapped.
    const map = { UNKNOWN: 'خطای نامشخص', NETWORK: 'شبکه در دسترس نیست' };
    const english = new ApiError('INTERNAL_ERROR', 'Unexpected server error', 500);
    expect(errorMessage(english, map)).toBe('خطای نامشخص');
    // A Persian server sentence is more specific than the generic line, so it survives.
    const persian = new ApiError('SOMETHING', 'این آگهی همین حالا رزرو شد.', 409);
    expect(errorMessage(persian, map)).toBe('این آگهی همین حالا رزرو شد.');
    // A mapped code always wins.
    expect(errorMessage(new ApiError('NETWORK', 'x', 0), map)).toBe('شبکه در دسترس نیست');
  });

  it('explains the two generic failures the user actually meets', () => {
    expect(fa.errors.INTERNAL_ERROR).toMatch(/[\u0600-\u06FF]/);
    expect(fa.errors.HTTP_ERROR).toMatch(/[\u0600-\u06FF]/);
  });

  it('gives every error a tracking code, even a local one', () => {
    const server = new ApiError('X', 'boom', 500, {}, 'ab-cdef0123456789');
    expect(errorTracking(server)).toBe('#ABCDEF01');
    // A network failure has no request id, but the user still needs something to quote.
    expect(errorTracking(new ApiError('NETWORK', 'offline', 0))).toBe('#LOCAL');
    expect(errorTracking('anything')).toBe('#LOCAL');
  });
});

describe('design discipline (G-21)', () => {
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir))
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => join(dir, name));

  it('keeps every font size on the type scale from the spec', () => {
    // 11px and 10px labels used to exist in five screens; the spec's smallest size is 12px.
    const offenders: string[] = [];
    for (const file of [...files('src/components'), ...files('src/pages')]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const match of source.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem|em)\]/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps component colours on tokens — no hex, no tailwind palette names', () => {
    const offenders: string[] = [];
    for (const file of [...files('src/components'), ...files('src/pages')]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (/#[0-9a-fA-F]{3,8}\b/.test(source)) offenders.push(`${file}: hex colour`);
      // `text-gray-500` / `bg-red-400` bypass the theme entirely.
      if (/\b(?:text|bg|border)-(?:gray|slate|zinc|red|green|blue|indigo)-\d{3}\b/.test(source)) {
        offenders.push(`${file}: palette colour`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every list screen the four states the spec requires', () => {
    // loading (skeleton), empty, error (with retry) and offline (the shell banner).
    const shell = readFileSync(join(ROOT, 'src/components/AppShell.tsx'), 'utf8');
    expect(shell).toContain("t('offline.banner')");

    const lists = [
      'src/pages/MarketPage.tsx',
      'src/pages/MyOrdersPage.tsx',
      'src/pages/NotificationsPage.tsx',
      'src/pages/ChatPage.tsx',
      'src/pages/PlansPage.tsx',
    ];
    for (const file of lists) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source, `${file} has no retryable error state`).toContain('ListError');
      expect(source, `${file} lost its skeleton`).toMatch(/Skeleton/);
      expect(source, `${file} lost its empty state`).toMatch(/EmptyState/);
    }

    // Screens that are not lists still owe the user a retry and a tracking code when they fail.
    for (const file of [
      'src/pages/ProfilePage.tsx',
      'src/pages/TradePage.tsx',
      'src/pages/OrderDetailPage.tsx',
    ]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source, `${file} has no retryable error state`).toContain('ListError');
    }
  });

  it('documents every base component from the spec in the style guide', () => {
    const guide = readFileSync(join(ROOT, 'src/pages/StyleGuidePage.tsx'), 'utf8');
    const expected = [
      'Button',
      'Card',
      'PriceTag',
      'QuantityChip',
      'StatusBadge',
      'Countdown',
      'BottomSheet',
      'TextField',
      'NumberStepper',
      'OtpInput',
      'SegmentedControl',
      'RangeSlider',
      'RadioCard',
      'EmptyState',
      'Skeleton',
      'Avatar',
      'OrderCard',
      'ChatBubble',
    ];
    for (const component of expected) {
      expect(guide, `style guide is missing ${component}`).toContain(`<${component}`);
    }
    // The page must be linkable from the guide itself and stay a public route.
    expect(guide).toContain('/style-guide');
  });

  it('has the four state labels the guide shows', () => {
    expect(fa.state.retry).toBe('تلاش دوباره');
    expect(fa.state.errorHint).toBeTruthy();
    expect(fa.offline.banner).toBeTruthy();
  });
});
