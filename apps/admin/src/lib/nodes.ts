import type { NodeJob, NodeView } from './types.js';

/**
 * Presentation helpers for the live node screen (task G-28).
 *
 * Kept pure and separate from the component so the thresholds — when a CPU bar turns amber, how a
 * heartbeat age reads in Persian, how a sweep job is described — are testable without a DOM.
 */

/** Persian labels for the sweep counters the scheduler reports. */
export const JOB_LABELS_FA: Record<string, string> = {
  expiredReservations: 'رزرو منقضی',
  expiredOrders: 'سفارش منقضی',
  autoCompletedTrades: 'معاملهٔ تکمیل خودکار',
  liftedSuspensions: 'رفع تعلیق',
  reconciledPayments: 'تسویهٔ مغایرت پرداخت',
  'expiry-sweep': 'پاک‌سازی دوره‌ای',
};

export const jobKindFa = (kind: string): string => JOB_LABELS_FA[kind] ?? kind;

/** Green under 60 %, amber under 85 %, red above: the same scale for CPU, RAM and disk use. */
export const pctTone = (pct: number): 'ok' | 'warn' | 'bad' =>
  pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'ok';

export const pctBarClass = (pct: number): string => {
  const tone = pctTone(pct);
  if (tone === 'bad') return 'bg-danger';
  if (tone === 'warn') return 'bg-warning';
  return 'bg-success';
};

/** Bar widths are clamped: a sliver is still visible, and nothing overflows the track. */
export const barWidth = (pct: number): string => `${Math.min(100, Math.max(2, Math.round(pct)))}%`;

export const stateTone = (state: NodeView['state']): string => {
  if (state === 'active') return 'bg-success/10 text-success';
  if (state === 'standby') return 'bg-warning/10 text-warning';
  return 'bg-danger/10 text-danger';
};

/** "۱۲ ثانیه پیش" — a heartbeat age, in the same words a person would use. */
export const heartbeatAgeFa = (seconds: number): string => {
  if (seconds < 5) return 'همین حالا';
  if (seconds < 60) return `${toPersian(String(seconds))} ثانیه پیش`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${toPersian(String(minutes))} دقیقه پیش`;
  const hours = Math.floor(minutes / 60);
  return `${toPersian(String(hours))} ساعت پیش`;
};

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toPersian = (value: string): string =>
  value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);

export const fmtGb = (value: number): string => `${toPersian(value.toFixed(1))} گیگابایت`;
export const fmtPct = (value: number): string => `${toPersian(String(Math.round(value)))}٪`;
export const fmtCount = (value: number): string => toPersian(String(Math.round(value)));

/**
 * One line of the work report: what ran, how many rows it touched, and the breakdown that matters
 * ("۳ تغییر — سفارش منقضی ۱، رزرو منقضی ۲").
 */
export const describeJob = (job: NodeJob): string => {
  const parts = Object.entries(job.detail ?? {})
    .filter(([key, value]) => value > 0 && key !== job.kind)
    .map(([key, value]) => `${jobKindFa(key)} ${fmtCount(value)}`);
  const head = `${jobKindFa(job.kind)} — ${fmtCount(job.count)} تغییر`;
  return parts.length > 0 ? `${head} (${parts.join('، ')})` : head;
};

/**
 * The work report shows *work*: sweeps that changed nothing are dropped, because a healthy system
 * would otherwise fill the list with «۰ تغییر» lines and hide the one sweep that mattered. The
 * newest timestamp is still surfaced separately as "last pass ran at …".
 */
export const recentJobs = (jobs: NodeJob[], limit = 6): NodeJob[] =>
  jobs.filter((job) => job.count > 0).slice(0, limit);

/** True when the node has run sweeps but none of them changed a row. */
export const hasOnlyIdleSweeps = (jobs: NodeJob[]): boolean =>
  jobs.length > 0 && jobs.every((job) => job.count === 0);
