import { describe, expect, it } from 'vitest';
import {
  barWidth,
  describeJob,
  fmtGb,
  fmtPct,
  hasOnlyIdleSweeps,
  heartbeatAgeFa,
  jobKindFa,
  pctBarClass,
  pctTone,
  recentJobs,
  stateTone,
} from '../src/lib/nodes.js';
import { buildHash, matchRoute } from '../src/lib/router.js';

/**
 * Task G-28 — the live node screen.
 *
 * The owner cares about two things: the CPU number must be readable at a glance, and the work
 * report must say what was actually done. These tests pin the formatting rules (Persian digits,
 * thresholds, clamping) and the route that carries the screen.
 */

describe('node screen formatting (G-28)', () => {
  it('turns the CPU scale amber then red', () => {
    expect(pctTone(12)).toBe('ok');
    expect(pctTone(60)).toBe('warn');
    expect(pctTone(96)).toBe('bad');
    expect(pctBarClass(12)).toBe('bg-success');
    expect(pctBarClass(70)).toBe('bg-warning');
    expect(pctBarClass(99)).toBe('bg-danger');
  });

  it('keeps bar widths inside the track and always visible', () => {
    expect(barWidth(0)).toBe('2%');
    expect(barWidth(48.6)).toBe('49%');
    expect(barWidth(140)).toBe('100%');
  });

  it('reads a heartbeat age the way a person would', () => {
    expect(heartbeatAgeFa(2)).toBe('همین حالا');
    expect(heartbeatAgeFa(35)).toBe('۳۵ ثانیه پیش');
    expect(heartbeatAgeFa(180)).toBe('۳ دقیقه پیش');
    expect(heartbeatAgeFa(7_200)).toBe('۲ ساعت پیش');
  });

  it('formats percentages and disk space in Persian digits', () => {
    expect(fmtPct(37.4)).toBe('۳۷٪');
    expect(fmtGb(120.44)).toBe('۱۲۰.۴ گیگابایت');
  });

  it('describes a sweep with its breakdown', () => {
    const line = describeJob({
      kind: 'expiry-sweep',
      count: 3,
      at: '2026-02-01T10:00:00.000Z',
      detail: { expiredOrders: 1, expiredReservations: 2, liftedSuspensions: 0 },
    });
    expect(line).toContain('پاک‌سازی دوره‌ای');
    expect(line).toContain('۳ تغییر');
    expect(line).toContain('سفارش منقضی ۱');
    expect(line).toContain('رزرو منقضی ۲');
    // Zero counts would make the line unreadable; they are dropped on purpose.
    expect(line).not.toContain('رفع تعلیق');
  });

  it('keeps the newest sweeps and labels unknown kinds verbatim', () => {
    const jobs = Array.from({ length: 9 }, (_, index) => ({
      kind: 'expiry-sweep',
      count: index,
      at: `2026-02-01T10:0${index}:00.000Z`,
    }));
    // Nine sweeps, but the zero-change one is noise: the report keeps the six that did work.
    expect(recentJobs(jobs)).toHaveLength(6);
    expect(recentJobs(jobs)[0]?.count).toBe(1);
    expect(hasOnlyIdleSweeps(jobs)).toBe(false);
    expect(hasOnlyIdleSweeps([{ kind: 'expiry-sweep', count: 0, at: '2026-02-01T10:00:00.000Z' }])).toBe(true);
    expect(jobKindFa('something-new')).toBe('something-new');
  });

  it('tones the three node states differently', () => {
    expect(stateTone('active')).toContain('success');
    expect(stateTone('standby')).toContain('warning');
    expect(stateTone('offline')).toContain('danger');
  });
});

describe('node screen routing (G-28)', () => {
  it('serves the live monitor at #/nodes', () => {
    expect(matchRoute('#/nodes')?.page).toBe('nodes');
    expect(buildHash('nodes')).toBe('#/nodes');
  });
});
