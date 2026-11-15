import type { Clock } from './domain/entities.js';
import type { OrderService } from './modules/orders-service.js';
import type { PaymentService } from './modules/payment-service.js';
import type { ReputationService } from './modules/reputation-service.js';
import type { ReservationService } from './modules/reservations-service.js';
import { createProcessSweepLock, type SweepLock } from './modules/sweep-lock.js';

export interface TickResult {
  expiredReservations: number;
  expiredOrders: number;
  autoCompletedTrades: number;
  liftedSuspensions: number;
  reconciledPayments: number;
}

export interface Scheduler {
  /** `null` when another instance holds the sweep lock (task G-02) — this tick did nothing. */
  tick(): Promise<TickResult | null>;
  start(intervalMs?: number): () => void;
  /** Last successful tick, exposed by the admin status screen. */
  lastTick(): { at: Date; result: TickResult } | null;
}

export const SWEEP_LOCK_NAME = 'expiry';

/**
 * Expiry sweeps: reservations, orders, auto-completion, trust suspensions, payment reconciliation.
 *
 * Runs in the API process (single-server deployment, task G-18) but guarded by a database advisory
 * lock so a second instance — a rolling restart, a second replica, or a manual `tick()` from the
 * admin panel — cannot sweep concurrently. Row selection uses `FOR UPDATE SKIP LOCKED` and every
 * transition is a compare-and-set, so a tick that does slip through still cannot double-apply.
 */
export function createScheduler(
  reservations: ReservationService,
  orders: OrderService,
  reputation: ReputationService,
  payments: PaymentService,
  _clock: Clock,
  lock: SweepLock = createProcessSweepLock(),
): Scheduler {
  let last: { at: Date; result: TickResult } | null = null;

  const sweep = async (): Promise<TickResult> => {
    // Billing reconciliation is the safety net for missed callbacks (E7-06).
    const reconciled = await payments.reconcile();
    const result: TickResult = {
      expiredReservations: await reservations.expireDueReservations(),
      expiredOrders: await orders.expireDueOrders(),
      autoCompletedTrades: await reservations.autoCompleteDueTrades(),
      // Trust suspensions are time-boxed; releasing them must not need an admin (E6-01).
      liftedSuspensions: await reputation.liftDueSuspensions(),
      reconciledPayments:
        reconciled.expiredPayments + reconciled.healedPayments + reconciled.expiredSubscriptions,
    };
    last = { at: _clock.now(), result };
    return result;
  };

  const tick = async (): Promise<TickResult | null> => lock.withLock(SWEEP_LOCK_NAME, sweep);

  return {
    tick,
    start(intervalMs = 30_000) {
      const handle = setInterval(() => {
        void tick().catch((error) => console.error('[scheduler] tick failed', error));
      }, intervalMs);
      handle.unref();
      // Run once right away: after a restart the backlog of expired holds should not wait a minute.
      void tick().catch((error) => console.error('[scheduler] initial tick failed', error));
      return () => clearInterval(handle);
    },
    lastTick: () => last,
  };
}
