import type { InfraCheckRow, InfraStatus } from './types.js';

/**
 * G-13 — the one decision the infrastructure screen has to get right.
 *
 * A board is only useful if it is honest about the worst thing on it: one red check means the
 * platform is in trouble, whatever the other five say. The tone map lives here (not in the page) so
 * a test can pin it down without rendering anything.
 */
export const checkTone = (status: InfraStatus): string =>
  status === 'OK'
    ? 'bg-success/10 text-success'
    : status === 'WARN'
      ? 'bg-warning/10 text-warning'
      : 'bg-danger/10 text-danger';

const SEVERITY: Record<InfraStatus, number> = { OK: 0, WARN: 1, DOWN: 2 };

/** The worst status in the list — what the page title should be coloured by. */
export const worstStatus = (checks: Pick<InfraCheckRow, 'status'>[]): InfraStatus =>
  checks.reduce<InfraStatus>(
    (worst, check) => (SEVERITY[check.status] > SEVERITY[worst] ? check.status : worst),
    'OK',
  );

/** «۴ سبز · ۱ زرد · ۱ قرمز» — the sentence the owner reads before anything else. */
export const summarize = (checks: Pick<InfraCheckRow, 'status'>[]): Record<InfraStatus, number> => {
  const counts: Record<InfraStatus, number> = { OK: 0, WARN: 0, DOWN: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
};
