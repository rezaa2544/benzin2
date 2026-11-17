import {
  AppError,
  formatJalaliDate,
  formatToman,
  toPersianDigits,
  type CreatePaymentCardInput,
  type CreatePlanInput,
  type GatewayCallbackInput,
  type PaymentStatus,
  type PurchaseSubscriptionInput,
  type UpdatePlanInput,
} from '@benzin/shared';
import type { Clock, Payment, Plan, Subscription, User } from '../domain/entities.js';
import { randomUUID } from 'node:crypto';
import type { NotificationEmitter, PaymentProvider, Repositories } from '../ports.js';
import type { SettingsService } from './settings-service.js';

export interface PlanView {
  id: string;
  code: string;
  nameFa: string;
  priceToman: number;
  priceLabelFa: string;
  durationDays: number;
  maxActiveOrders: number;
}

export interface SubscriptionView {
  id: string;
  planId: string;
  planCode: string;
  planNameFa: string;
  status: Subscription['status'];
  startsAt: string;
  endsAt: string;
  daysRemaining: number | null;
}

export interface PaymentView {
  id: string;
  provider: Payment['provider'];
  status: Payment['status'];
  amountToman: number;
  uniqueAmountToman: number | null;
  amountLabelFa: string;
  reference: string | null;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface PaymentStartView extends PaymentView {
  /** Gateway redirect (GATEWAY) or null for card-to-card. */
  redirectUrl: string | null;
  /** Card the payer must transfer to (card-to-card only, already masked upstream). */
  destination: { cardNumber: string; holderName: string; bankName: string | null } | null;
  /** Persian instruction line the client renders verbatim. */
  instructionFa: string;
}

export interface PaymentCardView {
  id: string;
  /** Never the full number: 6037 •••• •••• 7890 (E7-07). */
  maskedNumber: string;
  last4: string;
  holderName: string;
  bankName: string | null;
  isActive: boolean;
  dailyLimit: number | null;
}

export interface ReconciliationReport {
  expiredPayments: number;
  healedPayments: number;
  expiredSubscriptions: number;
  /** G-12: gateway invoices the reconciler asked the bank about again. */
  retriedVerifications: number;
  verifiedPayments: number;
}

/**
 * G-12 — the income report the panel shows. Every number is also pre-formatted in Persian digits,
 * because the labels and the separators must not be the client's job.
 */
export interface RevenueReport {
  from: string;
  to: string;
  totalToman: number;
  totalTomanLabelFa: string;
  paidCount: number;
  pendingCount: number;
  failedCount: number;
  byProvider: { provider: Payment['provider']; labelFa: string; paidCount: number; paidToman: number; paidTomanLabelFa: string }[];
  byDay: { day: string; paidCount: number; paidToman: number; paidTomanLabelFa: string }[];
}

const toPlanView = (plan: Plan): PlanView => ({
  id: plan.id,
  code: plan.code,
  nameFa: plan.nameFa,
  priceToman: plan.priceToman,
  // G-15: a zero-priced plan reads «رایگان» instead of «۰ تومان».
  priceLabelFa: plan.priceToman === 0 ? 'رایگان' : formatToman(plan.priceToman),
  durationDays: plan.durationDays,
  maxActiveOrders: plan.maxActiveOrders,
});

const toPaymentView = (payment: Payment): PaymentView => ({
  id: payment.id,
  provider: payment.provider,
  status: payment.status,
  amountToman: payment.amountToman,
  uniqueAmountToman: payment.uniqueAmountToman,
  amountLabelFa: formatToman(payment.uniqueAmountToman ?? payment.amountToman),
  reference: payment.reference,
  paidAt: payment.paidAt?.toISOString() ?? null,
  expiresAt: payment.expiresAt.toISOString(),
  createdAt: payment.createdAt.toISOString(),
});

/** Masks a card number for every API response and log line. */
export const maskCardNumber = (cardNumber: string): string => {
  const digits = cardNumber.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return toPersianDigits(`•••• •••• •••• ${last4}`);
};

const toCardView = (card: {
  id: string;
  cardNumber: string;
  holderName: string;
  bankName: string | null;
  isActive: boolean;
  dailyLimit: number | null;
}): PaymentCardView => ({
  id: card.id,
  maskedNumber: maskCardNumber(card.cardNumber),
  last4: card.cardNumber.replace(/\D/g, '').slice(-4),
  holderName: card.holderName,
  bankName: card.bankName,
  isActive: card.isActive,
  dailyLimit: card.dailyLimit,
});

/**
 * Plans, subscriptions and payments (tasks E7-01, E7-02, E7-06).
 *
 * Money is integer Toman everywhere. A purchase creates a PENDING subscription plus a
 * PENDING payment; the subscription only becomes ACTIVE when a provider (or an operator)
 * proves the money arrived, and `reconcile()` is the safety net for the cases in between.
 */
export class PaymentService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'plans' | 'subscriptions' | 'payments' | 'paymentCards' | 'audit'
    >,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly providers: { gateway: PaymentProvider; cardToCard: PaymentProvider },
    private readonly notifier: NotificationEmitter,
  ) {}

  private providerFor(kind: Payment['provider']): PaymentProvider {
    return kind === 'GATEWAY' ? this.providers.gateway : this.providers.cardToCard;
  }

  async listPlans(): Promise<{ items: PlanView[] }> {
    const plans = await this.repos.plans.listActive();
    return { items: plans.map(toPlanView) };
  }

  /* ------------------------------------------------------------ plan catalogue (G-15) */

  /** Staff view: inactive plans included, so a plan can be switched back on. */
  async listAllPlans(): Promise<{ items: PlanView[] }> {
    const plans = await this.repos.plans.listAll();
    return { items: plans.map(toPlanView) };
  }

  /**
   * Creates a plan. The seeded free plan proves the invariant the brief asks for: the catalogue
   * must always contain at least one free, active plan, otherwise a new user cannot trade at all.
   */
  async createPlan(actor: User, input: CreatePlanInput): Promise<PlanView> {
    const existing = await this.repos.plans.findByCode(input.code);
    if (existing)
      throw AppError.conflict('PLAN_CODE_TAKEN', 'A plan with this code already exists');
    const plan = await this.repos.plans.upsert({
      id: randomUUID(),
      code: input.code,
      nameFa: input.nameFa,
      durationDays: input.durationDays,
      priceToman: input.priceToman,
      maxActiveOrders: input.maxActiveOrders ?? 0,
      isActive: input.isActive ?? true,
    });
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'plan.created',
      entity: 'plan',
      entityId: plan.id,
      metadata: { code: plan.code, priceToman: plan.priceToman },
    });
    return toPlanView(plan);
  }

  /**
   * Edits a plan. Every price change is forward-only by construction: a subscription stores its
   * own `planId` and the money it was charged lives on the payment row, so nothing is rewritten.
   */
  async updatePlan(actor: User, id: string, patch: UpdatePlanInput): Promise<PlanView> {
    const plan = await this.repos.plans.findById(id);
    if (!plan) throw AppError.notFound('PLAN_NOT_FOUND', 'Plan not found');
    if (patch.isActive === false && plan.priceToman === 0) {
      throw AppError.conflict('FREE_PLAN_REQUIRED', 'The free plan must stay active');
    }
    const updated = await this.repos.plans.update(id, patch);
    if (!updated) throw AppError.notFound('PLAN_NOT_FOUND', 'Plan not found');
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'plan.updated',
      entity: 'plan',
      entityId: id,
      metadata: { ...patch },
    });
    return toPlanView(updated);
  }

  /** Soft delete: sold plans stay readable for the subscriptions that point at them. */
  async retirePlan(actor: User, id: string): Promise<PlanView> {
    const plan = await this.repos.plans.findById(id);
    if (!plan) throw AppError.notFound('PLAN_NOT_FOUND', 'Plan not found');
    if (plan.priceToman === 0) {
      throw AppError.conflict('FREE_PLAN_REQUIRED', 'The free plan must stay active');
    }
    const updated = await this.repos.plans.setActive(id, false);
    if (!updated) throw AppError.notFound('PLAN_NOT_FOUND', 'Plan not found');
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'plan.retired',
      entity: 'plan',
      entityId: id,
      metadata: { code: plan.code },
    });
    return toPlanView(updated);
  }

  async currentSubscription(user: User): Promise<{ subscription: SubscriptionView | null }> {
    const now = this.clock.now();
    const subscription = await this.repos.subscriptions.findActiveByUser(user.id, now);
    if (!subscription) return { subscription: null };
    return { subscription: await this.toSubscriptionView(subscription) };
  }

  private async toSubscriptionView(subscription: Subscription): Promise<SubscriptionView> {
    const plan = await this.repos.plans.findById(subscription.planId);
    const remainingMs = subscription.endsAt.getTime() - this.clock.now().getTime();
    return {
      id: subscription.id,
      planId: subscription.planId,
      planCode: plan?.code ?? '',
      planNameFa: plan?.nameFa ?? '',
      status: subscription.status,
      startsAt: subscription.startsAt.toISOString(),
      endsAt: subscription.endsAt.toISOString(),
      daysRemaining: remainingMs > 0 ? Math.ceil(remainingMs / 86_400_000) : 0,
    };
  }

  /** Creates the subscription + payment and asks the chosen provider how to pay. */
  async startPurchase(user: User, input: PurchaseSubscriptionInput): Promise<PaymentStartView> {
    const plan = await this.repos.plans.findByCode(input.planCode);
    if (!plan || !plan.isActive) {
      throw AppError.notFound('PLAN_NOT_FOUND', 'Plan is not available');
    }
    const config = await this.settings.get();
    const now = this.clock.now();
    const ttlMinutes =
      input.method === 'GATEWAY'
        ? config['payment.gateway_ttl_minutes']
        : config['payment.card_to_card_ttl_minutes'];

    const subscription = await this.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      startsAt: now,
      endsAt: new Date(now.getTime() + plan.durationDays * 86_400_000),
    });

    const payment = await this.createPaymentWithUniqueAmount({
      userId: user.id,
      subscriptionId: subscription.id,
      provider: input.method,
      amountToman: plan.priceToman,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
      suffixMax: config['payment.unique_suffix_max'],
      method: input.method,
    });

    const provider = this.providerFor(input.method);
    const init = await provider.init({
      paymentId: payment.id,
      amountToman: plan.priceToman,
      uniqueAmountToman: payment.uniqueAmountToman,
      descriptionFa: `خرید ${plan.nameFa}`,
    });
    if (init.authority) {
      await this.repos.payments.transition(payment.id, 'PENDING', 'PENDING', {
        authority: init.authority,
      });
      if (input.method === 'GATEWAY') {
        // G-12: the callback lands in the buyer's browser and can be lost, so the worker asks the
        // gateway itself a couple of minutes later. Attempt 0 costs nothing when the browser works.
        await this.repos.payments.recordVerifyAttempt(payment.id, {
          attempts: 0,
          nextAt: new Date(now.getTime() + 2 * 60_000),
          error: null,
        });
      }
    }

    await this.repos.audit.append({
      actorId: user.id,
      action: 'payment.created',
      entity: 'payment',
      entityId: payment.id,
      metadata: {
        method: input.method,
        planCode: plan.code,
        amountToman: plan.priceToman,
        uniqueAmountToman: payment.uniqueAmountToman,
      },
    });

    const settled = (await this.repos.payments.findById(payment.id)) ?? payment;
    return {
      ...toPaymentView(settled),
      redirectUrl: init.redirectUrl,
      destination: init.destination,
      instructionFa:
        input.method === 'GATEWAY'
          ? 'برای پرداخت آنلاین به درگاه منتقل می‌شوید.'
          : `مبلغ ${formatToman(settled.uniqueAmountToman ?? settled.amountToman)} را به کارت بالا واریز کنید؛ مبلغ یکتا برای تأیید خودکار لازم است.`,
    };
  }

  /**
   * Card-to-card needs an amount nobody else is currently paying, otherwise an operator
   * cannot tell the transfers apart. Collisions retry with a fresh suffix.
   */
  private async createPaymentWithUniqueAmount(input: {
    userId: string;
    subscriptionId: string;
    provider: Payment['provider'];
    amountToman: number;
    expiresAt: Date;
    suffixMax: number;
    method: PurchaseSubscriptionInput['method'];
  }): Promise<Payment> {
    const now = this.clock.now();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const uniqueAmountToman =
        input.method === 'CARD_TO_CARD'
          ? input.amountToman + 1 + Math.floor(Math.random() * input.suffixMax)
          : null;
      const payment = await this.repos.payments.create(
        {
          userId: input.userId,
          subscriptionId: input.subscriptionId,
          provider: input.provider,
          amountToman: input.amountToman,
          uniqueAmountToman,
          expiresAt: input.expiresAt,
        },
        now,
      );
      if (payment) return payment;
    }
    throw AppError.conflict('CONFLICT', 'Could not allocate a unique amount, try again');
  }

  async getPayment(user: User, id: string): Promise<PaymentView> {
    const payment = await this.repos.payments.findById(id);
    if (!payment || (payment.userId !== user.id && user.role === 'USER')) {
      throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    return toPaymentView(payment);
  }

  async listMine(user: User, limit = 20): Promise<{ items: PaymentView[] }> {
    const payments = await this.repos.payments.listByUser(user.id, limit);
    return { items: payments.map(toPaymentView) };
  }

  /** Gateway callback: verify with the provider, then settle (task E7-03). */
  async handleGatewayCallback(
    user: User,
    paymentId: string,
    input: GatewayCallbackInput,
  ): Promise<{ payment: PaymentView; subscription: SubscriptionView | null }> {
    const payment = await this.loadPayable(user, paymentId, 'GATEWAY');
    const provider = this.providerFor('GATEWAY');
    const result = await provider.verify({
      paymentId: payment.id,
      amountToman: payment.amountToman,
      authority: input.authority ?? payment.authority,
      reference: input.reference ?? null,
    });

    if (!result.ok) {
      await this.repos.payments.transition(payment.id, 'PENDING', 'FAILED', {
        reference: result.reason,
      });
      await this.repos.audit.append({
        actorId: user.id,
        action: 'payment.failed',
        entity: 'payment',
        entityId: payment.id,
        metadata: { reason: result.reason },
      });
      throw new AppError('PAYMENT_VERIFICATION_FAILED', 409, 'Payment was not confirmed', {
        reason: result.reason,
      });
    }

    return this.settle(payment, result.reference, user.id);
  }

  /**
   * G-12 — the gateway sends the buyer's *browser* back to us, so this path has no session and no
   * JSON body: Zarinpal appends `?Authority=…&Status=OK|NOK` to the callback URL we registered.
   *
   * Three things can go wrong and none of them may cost the buyer their money:
   * - `Status=NOK` — the buyer cancelled; that is a clean FAILED, not an error.
   * - verify throws (network, gateway 5xx) or answers "not verified yet" — the invoice stays
   *   PENDING and is queued for the worker, which asks again up to `GATEWAY_VERIFY_ATTEMPTS` times.
   * - the callback never arrives at all — the same queue picks it up from the reconciler, because
   *   `startPurchase` scheduled the first check when it created the gateway invoice.
   */
  async handleGatewayReturn(input: {
    authority: string;
    status: string | null;
  }): Promise<{ outcome: 'PAID' | 'FAILED' | 'PENDING' | 'UNKNOWN'; paymentId: string | null }> {
    const payment = await this.repos.payments.findByAuthority(input.authority);
    if (!payment) return { outcome: 'UNKNOWN', paymentId: null };

    // Replaying the same callback (the buyer refreshes the return page) must be a no-op.
    if (payment.status === 'PAID') return { outcome: 'PAID', paymentId: payment.id };
    if (payment.status !== 'PENDING') {
      return { outcome: 'FAILED', paymentId: payment.id };
    }

    if ((input.status ?? '').toUpperCase() === 'NOK') {
      const failed = await this.repos.payments.transition(payment.id, 'PENDING', 'FAILED', {
        reference: 'GATEWAY_CANCELLED',
      });
      if (failed) {
        await this.repos.audit.append({
          actorId: null,
          action: 'payment.failed',
          entity: 'payment',
          entityId: payment.id,
          metadata: { reason: 'GATEWAY_CANCELLED', authority: input.authority },
        });
        await this.notifier.emit({
          userId: payment.userId,
          kind: 'PAYMENT_FAILED',
          params: { amount: formatToman(payment.amountToman) },
          payload: { paymentId: payment.id, reason: 'GATEWAY_CANCELLED' },
        });
      }
      return { outcome: 'FAILED', paymentId: payment.id };
    }

    const attempt = await this.attemptVerify(payment, payment.userId);
    return { outcome: attempt.outcome, paymentId: payment.id };
  }

  /**
   * One verification attempt plus the bookkeeping around it. Shared by the browser callback, the
   * worker and the panel's "reconcile" button so all three behave identically.
   */
  private async attemptVerify(
    payment: Payment,
    actorId: string | null,
  ): Promise<{ outcome: 'PAID' | 'FAILED' | 'PENDING' }> {
    const provider = this.providerFor(payment.provider);
    let result: { ok: boolean; reference: string | null; reason: string | null };
    try {
      result = await provider.verify({
        paymentId: payment.id,
        amountToman: payment.amountToman,
        authority: payment.authority,
        reference: null,
      });
    } catch (error) {
      // A thrown error is a transport problem, never a verdict: retry, then hand it to a human.
      return this.scheduleRetry(payment, error instanceof Error ? error.message : 'verify failed');
    }

    if (result.ok) {
      try {
        await this.settle(payment, result.reference, actorId);
      } catch (error) {
        // Lost the race with another path that settled it: the callback is still a success.
        if (
          error instanceof AppError &&
          (error.code === 'PAYMENT_ALREADY_SETTLED' || error.code === 'INVALID_STATE_TRANSITION')
        ) {
          return { outcome: 'PAID' };
        }
        throw error;
      }
      await this.repos.payments.recordVerifyAttempt(payment.id, {
        attempts: payment.verifyAttempts + 1,
        nextAt: null,
        error: null,
        clear: true,
      });
      return { outcome: 'PAID' };
    }

    const reason = result.reason ?? 'VERIFY_REJECTED';
    // `GATEWAY_CODE_*` means the gateway answered; a missing authority means we never had a usable
    // invoice. Both are verdicts, not blips, so they fail straight away instead of burning retries.
    const retryable = reason === 'VERIFY_REJECTED' || reason === 'NETWORK';
    if (!retryable) {
      await this.failPayment(payment, reason, actorId);
      return { outcome: 'FAILED' };
    }
    return this.scheduleRetry(payment, reason);
  }

  /** Queues the next attempt, or escalates to a human once the budget is spent. */
  private async scheduleRetry(
    payment: Payment,
    error: string,
  ): Promise<{ outcome: 'PENDING' }> {
    const config = await this.settings.get();
    const maxAttempts = config['payment.verify_max_attempts'];
    const attempts = payment.verifyAttempts + 1;

    if (attempts >= maxAttempts) {
      // The money may well be in the bank, so this is never auto-failed: a person checks the
      // gateway panel and confirms or rejects it (G-11 already built the review queue).
      await this.repos.payments.recordVerifyAttempt(payment.id, {
        attempts,
        nextAt: null,
        error,
        clear: true,
      });
      const moved = await this.repos.payments.transition(payment.id, 'PENDING', 'NEEDS_REVIEW');
      if (moved) {
        await this.repos.audit.append({
          actorId: null,
          action: 'payment.verify_exhausted',
          entity: 'payment',
          entityId: payment.id,
          metadata: { attempts, error, authority: payment.authority },
        });
        await this.notifier.emit({
          userId: payment.userId,
          kind: 'PAYMENT_NEEDS_REVIEW',
          params: {
            amount: formatToman(payment.amountToman),
            tracking: payment.reference ?? payment.authority ?? '—',
          },
          payload: { paymentId: payment.id, reason: 'VERIFY_EXHAUSTED' },
        });
      }
      return { outcome: 'PENDING' };
    }

    const delayMinutes = config['payment.verify_retry_minutes'] * attempts;
    await this.repos.payments.recordVerifyAttempt(payment.id, {
      attempts,
      nextAt: new Date(this.clock.now().getTime() + delayMinutes * 60_000),
      error,
    });
    return { outcome: 'PENDING' };
  }

  private async failPayment(payment: Payment, reason: string, actorId: string | null): Promise<void> {
    const failed = await this.repos.payments.transition(payment.id, 'PENDING', 'FAILED', {
      reference: reason,
    });
    if (!failed) return;
    await this.repos.audit.append({
      actorId,
      action: 'payment.failed',
      entity: 'payment',
      entityId: payment.id,
      metadata: { reason },
    });
  }

  /**
   * G-12 worker step: re-verify the invoices whose last attempt failed for a reason that may pass.
   * Idempotent — it re-reads each payment before acting and `settle` is compare-and-set.
   */
  async retryGatewayVerifications(limit = 50): Promise<{ retried: number; paid: number }> {
    const due = await this.repos.payments.listDueVerify(this.clock.now(), limit);
    let paid = 0;
    for (const payment of due) {
      const fresh = await this.repos.payments.findById(payment.id);
      if (!fresh || fresh.status !== 'PENDING') continue;
      const result = await this.attemptVerify(fresh, null);
      if (result.outcome === 'PAID') paid += 1;
    }
    return { retried: due.length, paid };
  }

  /** G-12 revenue report: what actually came in, by provider and by Tehran day. */
  async revenue(from: Date, to: Date): Promise<RevenueReport> {
    const report = await this.repos.payments.revenue(from, to);
    const labelFa: Record<Payment['provider'], string> = {
      GATEWAY: 'درگاه بانکی',
      CARD_TO_CARD: 'کارت‌به‌کارت',
    };
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalToman: report.totalPaidToman,
      totalTomanLabelFa: formatToman(report.totalPaidToman),
      paidCount: report.totalPaidCount,
      pendingCount: report.pendingCount,
      failedCount: report.failedCount,
      byProvider: report.byProvider.map((row) => ({
        provider: row.provider,
        labelFa: labelFa[row.provider] ?? row.provider,
        paidCount: row.paidCount,
        paidToman: row.paidToman,
        paidTomanLabelFa: formatToman(row.paidToman),
      })),
      byDay: report.byDay.map((row) => ({
        day: row.day,
        paidCount: row.paidCount,
        paidToman: row.paidToman,
        paidTomanLabelFa: formatToman(row.paidToman),
      })),
    };
  }

  private async loadPayable(
    user: User,
    paymentId: string,
    method: Payment['provider'],
  ): Promise<Payment> {
    const payment = await this.repos.payments.findById(paymentId);
    if (!payment || payment.userId !== user.id) {
      throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    if (payment.provider !== method) {
      throw new AppError('PAYMENT_NOT_PAYABLE', 409, 'Payment belongs to another method');
    }
    if (payment.status !== 'PENDING') {
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment is already settled', {
        status: payment.status,
      });
    }
    if (payment.expiresAt.getTime() <= this.clock.now().getTime()) {
      await this.repos.payments.transition(payment.id, 'PENDING', 'EXPIRED');
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment window elapsed');
    }
    return payment;
  }

  /** Marks the payment PAID, activates the subscription and notifies the buyer. */
  private async settle(
    payment: Payment,
    reference: string | null,
    actorId: string | null,
    nextStatus: Payment['status'] = 'PAID',
    /** G-11: an approval can start from NEEDS_REVIEW; everything else starts from PENDING. */
    expected: Payment['status'] = 'PENDING',
  ): Promise<{ payment: PaymentView; subscription: SubscriptionView | null }> {
    const now = this.clock.now();
    const updated = await this.repos.payments.transition(payment.id, expected, nextStatus, {
      paidAt: now,
      reference,
    });
    if (!updated) {
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment changed while settling');
    }

    let subscription: SubscriptionView | null = null;
    if (updated.subscriptionId) {
      const pending = await this.repos.subscriptions.findById(updated.subscriptionId);
      const plan = pending ? await this.repos.plans.findById(pending.planId) : null;
      if (pending && plan) {
        const activated = await this.repos.subscriptions.activate(
          pending.id,
          now,
          new Date(now.getTime() + plan.durationDays * 86_400_000),
        );
        if (activated) {
          subscription = await this.toSubscriptionView(activated);
          await this.notifier.emit({
            userId: updated.userId,
            kind: 'PAYMENT_APPROVED',
            params: {
              amount: updated.amountToman,
              plan: plan.nameFa,
              endsAt: formatJalaliDate(activated.endsAt),
            },
            payload: { paymentId: updated.id, subscriptionId: activated.id },
          });
        }
      }
    }

    await this.repos.audit.append({
      actorId,
      action: 'payment.paid',
      entity: 'payment',
      entityId: updated.id,
      metadata: { reference, provider: updated.provider, amountToman: updated.amountToman },
    });

    return { payment: toPaymentView(updated), subscription };
  }

  /**
   * G-11: the deposit webhook settles through the very same path an operator approval takes, so a
   * matched transfer and a hand-approved one can never diverge in what they activate.
   */
  async settleDeposit(payment: Payment, reference: string): Promise<void> {
    await this.settle(payment, reference, null);
  }

  /** Operator confirmation for a card-to-card transfer (task E7-07). */
  async confirmPayment(
    actor: User,
    paymentId: string,
    reference: string | null,
  ): Promise<{ payment: PaymentView; subscription: SubscriptionView | null }> {
    const payment = await this.repos.payments.findById(paymentId);
    if (!payment) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    // G-11: a review-mode proof parks the invoice in NEEDS_REVIEW; approving it settles from there.
    // Both states are «waiting for a human», and both settle exactly once via the compare-and-set.
    if (payment.status !== 'PENDING' && payment.status !== 'NEEDS_REVIEW') {
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment is already settled');
    }
    return this.settle(
      payment,
      reference ?? payment.reference ?? `MANUAL-${payment.id.slice(0, 8)}`,
      actor.id,
      'PAID',
      payment.status,
    );
  }

  async rejectPayment(actor: User, paymentId: string, reason: string): Promise<PaymentView> {
    const payment = await this.repos.payments.findById(paymentId);
    if (!payment) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    // G-11: rejecting a review-mode proof starts from NEEDS_REVIEW.
    const expected = payment.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'PENDING';
    if (payment.status !== 'PENDING' && payment.status !== 'NEEDS_REVIEW') {
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment is already settled');
    }
    const updated = await this.repos.payments.transition(payment.id, expected, 'FAILED', {
      reference: reason,
    });
    if (!updated) {
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment is already settled');
    }
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'payment.rejected',
      entity: 'payment',
      entityId: payment.id,
      metadata: { reason },
    });
    await this.notifier.emit({
      userId: payment.userId,
      kind: 'PAYMENT_FAILED',
      params: { amount: payment.amountToman },
      payload: { paymentId: payment.id, reason },
    });
    return toPaymentView(updated);
  }

  // ------------------------------------------------------- admin (E7-07)

  async listPaymentCards(): Promise<{ items: PaymentCardView[] }> {
    const cards = await this.repos.paymentCards.list(false);
    return { items: cards.map(toCardView) };
  }

  async addPaymentCard(actor: User, input: CreatePaymentCardInput): Promise<PaymentCardView> {
    const card = await this.repos.paymentCards.create(
      {
        cardNumber: input.cardNumber,
        holderName: input.holderName,
        bankName: input.bankName ?? null,
        dailyLimit: input.dailyLimit ?? null,
      },
      this.clock.now(),
    );
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'payment_card.created',
      entity: 'payment_card',
      entityId: card.id,
      metadata: { last4: card.cardNumber.slice(-4), bankName: card.bankName },
    });
    return toCardView(card);
  }

  async deactivatePaymentCard(actor: User, id: string): Promise<PaymentCardView> {
    const card = await this.repos.paymentCards.deactivate(id);
    if (!card) throw AppError.notFound('NOT_FOUND', 'Card not found');
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'payment_card.deactivated',
      entity: 'payment_card',
      entityId: card.id,
      metadata: { last4: card.cardNumber.slice(-4) },
    });
    return toCardView(card);
  }

  async listAllPayments(options: {
    status: PaymentStatus | null;
    limit: number;
  }): Promise<{ items: PaymentView[] }> {
    const payments = await this.repos.payments.listAll(options);
    return { items: payments.map(toPaymentView) };
  }

  /**
   * E7-06: the nightly safety net. Expired intents die, paid-but-inactive subscriptions
   * are activated, and finished subscriptions are closed — all idempotent.
   */
  async reconcile(limit = 200): Promise<ReconciliationReport> {
    // G-12 first: an invoice the bank has already been asked about must not be expired out from
    // under a buyer whose money did leave the account.
    const retry = await this.retryGatewayVerifications(Math.min(limit, 50));
    const now = this.clock.now();
    let expiredPayments = 0;
    for (const payment of await this.repos.payments.listPendingExpired(now, limit)) {
      const updated = await this.repos.payments.transition(payment.id, 'PENDING', 'EXPIRED');
      if (updated) expiredPayments += 1;
    }

    let healedPayments = 0;
    const paid = await this.repos.payments.listAll({ status: 'PAID', limit });
    for (const payment of paid) {
      if (!payment.subscriptionId) continue;
      const subscription = await this.repos.subscriptions.findById(payment.subscriptionId);
      if (!subscription || subscription.status !== 'PENDING') continue;
      const plan = await this.repos.plans.findById(subscription.planId);
      if (!plan) continue;
      const activated = await this.repos.subscriptions.activate(
        subscription.id,
        payment.paidAt ?? now,
        new Date((payment.paidAt ?? now).getTime() + plan.durationDays * 86_400_000),
      );
      if (!activated) continue;
      healedPayments += 1;
      await this.repos.audit.append({
        actorId: null,
        action: 'payment.reconciled',
        entity: 'payment',
        entityId: payment.id,
        metadata: { subscriptionId: subscription.id },
      });
    }

    let expiredSubscriptions = 0;
    for (const subscription of await this.repos.subscriptions.listDueExpiry(now, limit)) {
      const expired = await this.repos.subscriptions.expire(subscription.id);
      if (!expired) continue;
      expiredSubscriptions += 1;
      const plan = await this.repos.plans.findById(subscription.planId);
      await this.notifier.emit({
        userId: subscription.userId,
        kind: 'SUBSCRIPTION_EXPIRED',
        params: { plan: plan?.nameFa ?? '' },
        payload: { subscriptionId: subscription.id },
      });
    }

    return {
      expiredPayments,
      healedPayments,
      expiredSubscriptions,
      retriedVerifications: retry.retried,
      verifiedPayments: retry.paid,
    };
  }
}
