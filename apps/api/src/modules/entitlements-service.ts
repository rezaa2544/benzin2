import { AppError } from '@benzin/shared';
import type { Clock, Plan, Subscription, User } from '../domain/entities.js';
import type { Repositories } from '../ports.js';
import type { SettingsService } from './settings-service.js';

/**
 * G-26 — what a buyer has paid for, in one place.
 *
 * The product sells exactly three things (see `00-PRODUCT.md`): browsing, *seeing a number*, and
 * *starting a reservation*. Sellers never pay. Rather than sprinkling `if (subscription)` checks
 * through the reservation and contact code, every one of those questions is answered here, from
 * the `plans` table, so the owner can change limits and prices in the panel without a deploy.
 *
 * The model:
 *  - a user with no active subscription still gets the free plan's monthly allowance (three
 *    reservations by default) but never sees a number;
 *  - a paid plan buys unlimited reservations plus the right to see the number;
 *  - the credit plan buys exactly one reservation and is spent by it.
 */
export interface BuyerEntitlementView {
  /** Which plan currently governs this buyer: their active plan, or the free fallback. */
  planCode: string;
  planNameFa: string;
  source: 'SUBSCRIPTION' | 'FREE';
  /** A real, paid subscription covers `now`. */
  active: boolean;
  endsAt: string | null;
  /** The right to see the counterparty's number at all. */
  phoneVisible: boolean;
  /** Per calendar month (Tehran); `null` means unlimited. */
  monthlyLimit: number | null;
  usedThisMonth: number;
  /** How many reservations are left; `null` means unlimited. */
  remaining: number | null;
  singleUse: boolean;
  /** True when the plan requires a purchase before the next reservation. */
  needsPurchase: boolean;
}

export interface EntitlementConsumption {
  /** The subscription that paid for this reservation, if any (a credit plan is consumed). */
  subscriptionId: string | null;
  singleUse: boolean;
}

const FREE_PLAN_CODE = 'free';

export class EntitlementService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'plans' | 'subscriptions' | 'reservations' | 'audit'
    >,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /**
   * The Tehran calendar month, because the allowance is a human promise («۳ رزرو در ماه»), not a
   * rolling 30-day window nobody can check.
   */
  private monthStart(now: Date): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(now)
      .split('-');
    // Tehran is UTC+03:30 all year (no DST since 2022), so the first instant of the month is
    // 20:30 UTC on the last day of the previous month.
    const utcMidnight = Date.parse(`${parts[0]}-${parts[1]}-01T00:00:00+03:30`);
    return new Date(utcMidnight);
  }

  /** The plan that governs a buyer right now, plus the subscription backing it (if any). */
  async resolve(
    userId: string,
  ): Promise<{ plan: Plan; subscription: Subscription | null; fallback: boolean }> {
    const now = this.clock.now();
    const subscription = await this.repos.subscriptions.findActiveByUser(userId, now);
    if (subscription) {
      const plan = await this.repos.plans.findById(subscription.planId);
      if (plan) return { plan, subscription, fallback: false };
    }
    const free = await this.repos.plans.findByCode(FREE_PLAN_CODE);
    if (!free) {
      throw new AppError('FREE_PLAN_MISSING', 500, 'The free plan is missing from the catalogue');
    }
    return { plan: free, subscription: null, fallback: true };
  }

  async forUser(userId: string): Promise<BuyerEntitlementView> {
    const config = await this.settings.get();
    const { plan, subscription, fallback } = await this.resolve(userId);
    const used = await this.repos.reservations.countByTakerSince(
      userId,
      this.monthStart(this.clock.now()),
    );

    // An owner who switches `subscription.required_for_orders` on is saying "no free rides":
    // the fallback plan then grants nothing.
    const requiresPaid = config['subscription.required_for_orders'];
    const monthlyLimit = fallback && requiresPaid ? 0 : plan.monthlyReservations;
    const remaining = monthlyLimit === null ? null : Math.max(0, monthlyLimit - used);

    return {
      planCode: plan.code,
      planNameFa: plan.nameFa,
      source: fallback ? 'FREE' : 'SUBSCRIPTION',
      active: !fallback,
      endsAt: subscription ? subscription.endsAt.toISOString() : null,
      phoneVisible: !fallback && plan.phoneVisible,
      monthlyLimit,
      usedThisMonth: used,
      remaining,
      singleUse: plan.singleUse,
      needsPurchase: remaining !== null && remaining <= 0,
    };
  }

  /**
   * The gate in front of `POST /v1/reservations`. Throws a specific, actionable error so the app
   * can send the buyer to the plans page instead of showing a shrug.
   */
  async requireForReservation(user: User): Promise<EntitlementConsumption & BuyerEntitlementView> {
    const entitlement = await this.forUser(user.id);
    if (entitlement.remaining !== null && entitlement.remaining <= 0) {
      const paidPlans = (await this.repos.plans.listActive()).filter(
        (plan) => plan.priceToman > 0 && !plan.singleUse,
      );
      throw new AppError(
        'RESERVATION_QUOTA_EXHAUSTED',
        429,
        entitlement.monthlyLimit === 0
          ? 'An active subscription is required to reserve'
          : 'This month’s reservations are used up',
        {
          planCode: entitlement.planCode,
          monthlyLimit: entitlement.monthlyLimit,
          usedThisMonth: entitlement.usedThisMonth,
          cheapestPlanToman: paidPlans.length > 0 ? paidPlans[0]!.priceToman : null,
        },
      );
    }
    const { subscription } = await this.resolve(user.id);
    return {
      ...entitlement,
      subscriptionId: subscription?.id ?? null,
      singleUse: entitlement.singleUse && subscription !== null,
    };
  }

  /**
   * Called after the reservation row exists. A credit plan is spent here — consuming before the
   * reservation is created would charge the buyer for a race they lost.
   */
  async recordUse(user: User, consumption: EntitlementConsumption): Promise<void> {
    if (!consumption.singleUse || !consumption.subscriptionId) return;
    const now = this.clock.now();
    await this.repos.subscriptions.consume(consumption.subscriptionId, now);
    await this.repos.audit.append({
      actorId: user.id,
      action: 'subscription.consumed',
      entity: 'subscription',
      entityId: consumption.subscriptionId,
      metadata: { reason: 'SINGLE_USE_RESERVATION' },
    });
  }

  /** G-19: may this user see a counterparty's number at all? */
  async phoneVisibleFor(userId: string): Promise<boolean> {
    const entitlement = await this.forUser(userId);
    return entitlement.phoneVisible;
  }
}
