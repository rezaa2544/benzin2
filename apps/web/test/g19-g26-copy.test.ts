import { describe, expect, it } from 'vitest';
import fa from '../src/i18n/fa.json';

/**
 * G-19 / G-26 in the customer app: the words that carry the two rules.
 *
 * A plan that sells «دیدن شماره» and a switch that hides it are only honest if the screen says so
 * before the buyer pays, and if a hidden number does not read like a failure.
 */
const copy = (section: 'plans' | 'profile' | 'trade', key: string): string =>
  (fa[section] as Record<string, string>)[key] ?? '';

describe('buyer subscription copy (G-26)', () => {
  it('names what every plan grants, including the ones that grant nothing extra', () => {
    expect(copy('plans', 'planReservations')).toContain('رزرو');
    expect(copy('plans', 'planPhone')).toContain('شماره');
    expect(copy('plans', 'planNoPhone')).toContain('مخفی');
    expect(copy('plans', 'planSingle')).toContain('رزرو');
  });

  it('shows the allowance in a way a person can check', () => {
    // «x از y رزرو این ماه باقی مانده» — two numbers and the month, no arithmetic required.
    expect(copy('plans', 'remainingOf')).toContain('این ماه');
    expect(copy('plans', 'remainingOf')).toContain('{remaining}');
    expect(copy('plans', 'remainingOf')).toContain('{limit}');
    expect(copy('plans', 'unlimited')).toBe('نامحدود');
  });
});

describe('phone privacy copy (G-19)', () => {
  it('says what the switch does and what still works', () => {
    expect(copy('profile', 'phoneHidden')).toContain('مخفی');
    expect(copy('profile', 'phoneHiddenHint')).toContain('چت');
  });

  it('never reads like a dead end for the trade', () => {
    expect(copy('trade', 'phoneHidden')).toContain('چت');
    expect(copy('trade', 'chatInstead')).toContain('چت');
    // «مخفی» است، نه «خطا».
    expect(copy('trade', 'phoneHidden')).not.toContain('خطا');
  });
});
