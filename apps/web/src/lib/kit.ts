import { ORDER_STATUS_FA, toPersianDigits, type OrderStatus } from '@benzin/shared';

/**
 * G-21 — the logic behind the base components, kept out of the `.tsx` files so it can be tested
 * without a DOM. Every rule here comes from `03-UX-SPEC.md`: status colours are paired with words,
 * numbers are Persian and tabular, and a countdown never shows a negative time.
 */

export type StatusTone = 'neutral' | 'brand' | 'warn' | 'danger' | 'info';

const STATUS_TONE: Record<string, StatusTone> = {
  OPEN: 'brand',
  AWAITING_OWNER_DECISION: 'warn',
  RESERVED: 'warn',
  ACTIVE: 'info',
  IN_PROGRESS: 'info',
  COMPLETED: 'neutral',
  CANCELLED: 'danger',
  EXPIRED: 'neutral',
  FAILED: 'danger',
  PAID: 'brand',
  PENDING: 'warn',
};

/**
 * The colour a status gets. Unknown statuses are grey on purpose: guessing «green» for a status
 * nobody has mapped is how a screen ends up lying about someone's money.
 */
export function badgeTone(status: string): StatusTone {
  return STATUS_TONE[status.toUpperCase()] ?? 'neutral';
}

/** A status always reads as a Persian phrase next to the colour. */
export function statusLabel(status: string): string {
  return ORDER_STATUS_FA[status as OrderStatus] ?? status;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** Counts and litres are whole numbers with Persian digits and a thousands separator. */
export function clampCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return toPersianDigits(safe.toLocaleString('en-US'));
}

/** `nextStep` clamps to the range instead of wrapping, so «+» at the ceiling does nothing. */
export function nextStep(
  value: number,
  delta: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const next = Math.round(value + delta);
  return Math.min(max, Math.max(min, next));
}

/** Whole minutes and seconds left, floored at zero. */
export function splitClock(remainingMs: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/** `۱۲:۴۵` — always two digits in the seconds, so the width never jumps. */
export function countdownLabel(minutes: number, seconds: number): string {
  const mm = toPersianDigits(String(Math.max(0, minutes)).padStart(2, '0'));
  const ss = toPersianDigits(String(Math.max(0, seconds)).padStart(2, '0'));
  return `${mm}:${ss}`;
}
