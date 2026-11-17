import { randomUUID } from 'node:crypto';
import type { Payment, PaymentCard, Plan, Subscription } from '../../domain/entities.js';
import type {
  CardDeposit,
  CardDepositRepository,
  NewPayment,
  NewSubscription,
  PaymentCardRepository,
  PaymentRepository,
  PlanRepository,
  SubscriptionRepository,
} from '../../ports.js';

const clone = <T>(value: T): T => structuredClone(value);

/** In-memory plan catalogue; seeded from `SEED_PLANS` on boot (task E7-01). */
export class MemoryPlanRepository implements PlanRepository {
  private readonly byId = new Map<string, Plan>();

  async listActive(): Promise<Plan[]> {
    return [...this.byId.values()]
      .filter((plan) => plan.isActive)
      .sort((a, b) => a.priceToman - b.priceToman)
      .map(clone);
  }

  async listAll(): Promise<Plan[]> {
    return [...this.byId.values()].sort((a, b) => a.priceToman - b.priceToman).map(clone);
  }

  async findById(id: string): Promise<Plan | null> {
    const plan = this.byId.get(id);
    return plan ? clone(plan) : null;
  }

  async setActive(id: string, isActive: boolean): Promise<Plan | null> {
    const plan = this.byId.get(id);
    if (!plan) return null;
    const updated: Plan = { ...plan, isActive };
    this.byId.set(id, clone(updated));
    return clone(updated);
  }

  async update(id: string, patch: Partial<Omit<Plan, 'id' | 'code'>>): Promise<Plan | null> {
    const plan = this.byId.get(id);
    if (!plan) return null;
    const updated: Plan = { ...plan, ...patch };
    this.byId.set(id, clone(updated));
    return clone(updated);
  }

  async findByCode(code: string): Promise<Plan | null> {
    const plan = [...this.byId.values()].find((candidate) => candidate.code === code);
    return plan ? clone(plan) : null;
  }

  async upsert(plan: Plan): Promise<Plan> {
    this.byId.set(plan.id, clone(plan));
    return clone(plan);
  }
}

export class MemorySubscriptionRepository implements SubscriptionRepository {
  private readonly byId = new Map<string, Subscription>();

  async create(input: NewSubscription): Promise<Subscription> {
    const subscription: Subscription = {
      id: randomUUID(),
      userId: input.userId,
      planId: input.planId,
      status: 'PENDING',
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdAt: input.startsAt,
      consumedAt: null,
    };
    this.byId.set(subscription.id, clone(subscription));
    return clone(subscription);
  }

  async findById(id: string): Promise<Subscription | null> {
    const subscription = this.byId.get(id);
    return subscription ? clone(subscription) : null;
  }

  async findActiveByUser(userId: string, now: Date): Promise<Subscription | null> {
    const candidates = [...this.byId.values()]
      .filter(
        (subscription) =>
          subscription.userId === userId &&
          subscription.status === 'ACTIVE' &&
          // A spent credit plan must never extend an entitlement again (G-26).
          subscription.consumedAt === null &&
          subscription.endsAt.getTime() > now.getTime(),
      )
      .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
    return candidates[0] ? clone(candidates[0]) : null;
  }

  async activate(id: string, startsAt: Date, endsAt: Date): Promise<Subscription | null> {
    const subscription = this.byId.get(id);
    if (!subscription || subscription.status !== 'PENDING') return null;
    subscription.status = 'ACTIVE';
    subscription.startsAt = startsAt;
    subscription.endsAt = endsAt;
    return clone(subscription);
  }

  async consume(id: string, at: Date): Promise<Subscription | null> {
    const subscription = this.byId.get(id);
    if (!subscription) return null;
    subscription.consumedAt = at;
    this.byId.set(id, clone(subscription));
    return clone(subscription);
  }

  async listDueExpiry(now: Date, limit: number): Promise<Subscription[]> {
    return [...this.byId.values()]
      .filter(
        (subscription) =>
          subscription.status === 'ACTIVE' && subscription.endsAt.getTime() <= now.getTime(),
      )
      .slice(0, limit)
      .map(clone);
  }

  async expire(id: string): Promise<Subscription | null> {
    const subscription = this.byId.get(id);
    if (!subscription || subscription.status !== 'ACTIVE') return null;
    subscription.status = 'EXPIRED';
    return clone(subscription);
  }

  async listByUser(userId: string, limit: number): Promise<Subscription[]> {
    return [...this.byId.values()]
      .filter((subscription) => subscription.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async listAll(query: {
    status: Subscription['status'] | null;
    limit: number;
    offset: number;
  }): Promise<{ items: Subscription[]; total: number }> {
    const matches = [...this.byId.values()]
      .filter((subscription) => query.status === null || subscription.status === query.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: matches.slice(query.offset, query.offset + query.limit).map(clone),
      total: matches.length,
    };
  }

  async countByStatus(): Promise<Record<Subscription['status'], number>> {
    const counts = { PENDING: 0, ACTIVE: 0, EXPIRED: 0, CANCELLED: 0 } as Record<
      Subscription['status'],
      number
    >;
    for (const subscription of this.byId.values()) counts[subscription.status] += 1;
    return counts;
  }
}

export class MemoryPaymentRepository implements PaymentRepository {
  private readonly byId = new Map<string, Payment>();

  private conflictsWithPending(amountToman: number): boolean {
    return [...this.byId.values()].some(
      (payment) => payment.status === 'PENDING' && payment.uniqueAmountToman === amountToman,
    );
  }

  async create(input: NewPayment, at: Date): Promise<Payment | null> {
    if (input.uniqueAmountToman !== null && this.conflictsWithPending(input.uniqueAmountToman)) {
      return null;
    }
    const payment: Payment = {
      id: randomUUID(),
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      provider: input.provider,
      status: 'PENDING',
      amountToman: input.amountToman,
      authority: null,
      reference: null,
      uniqueAmountToman: input.uniqueAmountToman,
      rawPayload: {},
      paidAt: null,
      expiresAt: input.expiresAt,
      createdAt: at,
      verifyAttempts: 0,
      nextVerifyAt: null,
      lastVerifyError: null,
    };
    this.byId.set(payment.id, clone(payment));
    return clone(payment);
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = this.byId.get(id);
    return payment ? clone(payment) : null;
  }

  async findByAuthority(authority: string): Promise<Payment | null> {
    const payment = [...this.byId.values()].find((candidate) => candidate.authority === authority);
    return payment ? clone(payment) : null;
  }

  async findPayableByAmount(
    provider: Payment['provider'],
    amountToman: number,
    now: Date,
  ): Promise<Payment[]> {
    return [...this.byId.values()]
      .filter(
        (payment) =>
          payment.provider === provider &&
          payment.status === 'PENDING' &&
          payment.uniqueAmountToman === amountToman &&
          payment.expiresAt.getTime() > now.getTime(),
      )
      .map(clone);
  }

  async findByUniqueAmount(amountToman: number): Promise<Payment | null> {
    const payment = [...this.byId.values()].find(
      (candidate) => candidate.uniqueAmountToman === amountToman,
    );
    return payment ? clone(payment) : null;
  }

  async transition(
    id: string,
    expected: Payment['status'],
    next: Payment['status'],
    patch: Partial<Pick<Payment, 'paidAt' | 'reference' | 'authority'>> = {},
  ): Promise<Payment | null> {
    const payment = this.byId.get(id);
    if (!payment || payment.status !== expected) return null;
    payment.status = next;
    // G-12: a settled (or dead) invoice no longer needs a verification retry.
    if (next !== 'PENDING') {
      payment.nextVerifyAt = null;
      payment.lastVerifyError = null;
    }
    if (patch.paidAt !== undefined) payment.paidAt = patch.paidAt;
    if (patch.reference !== undefined) payment.reference = patch.reference;
    if (patch.authority !== undefined) payment.authority = patch.authority;
    return clone(payment);
  }

  async listPendingExpired(now: Date, limit: number): Promise<Payment[]> {
    return [...this.byId.values()]
      .filter(
        (payment) => payment.status === 'PENDING' && payment.expiresAt.getTime() <= now.getTime(),
      )
      .slice(0, limit)
      .map(clone);
  }

  async listByUser(userId: string, limit: number): Promise<Payment[]> {
    return [...this.byId.values()]
      .filter((payment) => payment.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async listAll(options: {
    status: Payment['status'] | null;
    limit: number;
    offset?: number;
  }): Promise<Payment[]> {
    const start = options.offset ?? 0;
    return [...this.byId.values()]
      .filter((payment) => options.status === null || payment.status === options.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(start, start + options.limit)
      .map(clone);
  }

  async listDueVerify(now: Date, limit: number): Promise<Payment[]> {
    return [...this.byId.values()]
      .filter(
        (payment) =>
          payment.status === 'PENDING' &&
          payment.nextVerifyAt !== null &&
          payment.nextVerifyAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => (a.nextVerifyAt?.getTime() ?? 0) - (b.nextVerifyAt?.getTime() ?? 0))
      .slice(0, limit)
      .map(clone);
  }

  async recordVerifyAttempt(
    id: string,
    input: { attempts: number; nextAt: Date | null; error: string | null; clear?: boolean },
  ): Promise<Payment | null> {
    const payment = this.byId.get(id);
    if (!payment) return null;
    payment.verifyAttempts = input.attempts;
    payment.nextVerifyAt = input.clear ? null : input.nextAt;
    payment.lastVerifyError = input.clear ? null : input.error;
    return clone(payment);
  }

  async revenue(from: Date, to: Date): Promise<{
    totalPaidToman: number;
    totalPaidCount: number;
    byProvider: { provider: Payment['provider']; paidToman: number; paidCount: number }[];
    byDay: { day: string; paidToman: number; paidCount: number }[];
    pendingCount: number;
    failedCount: number;
  }> {
    const inWindow = [...this.byId.values()].filter((payment) => {
      const at = payment.paidAt ?? payment.createdAt;
      return at.getTime() >= from.getTime() && at.getTime() <= to.getTime();
    });
    const paid = inWindow.filter((payment) => payment.status === 'PAID');
    const perProvider = new Map<Payment['provider'], { paidToman: number; paidCount: number }>();
    const perDay = new Map<string, { paidToman: number; paidCount: number }>();
    for (const payment of paid) {
      const provider = perProvider.get(payment.provider) ?? { paidToman: 0, paidCount: 0 };
      provider.paidToman += payment.amountToman;
      provider.paidCount += 1;
      perProvider.set(payment.provider, provider);

      // The report is read in Tehran, so a payment at 23:30 local belongs to that local day.
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(
        payment.paidAt ?? payment.createdAt,
      );
      const bucket = perDay.get(day) ?? { paidToman: 0, paidCount: 0 };
      bucket.paidToman += payment.amountToman;
      bucket.paidCount += 1;
      perDay.set(day, bucket);
    }
    return {
      totalPaidToman: paid.reduce((sum, payment) => sum + payment.amountToman, 0),
      totalPaidCount: paid.length,
      byProvider: [...perProvider.entries()]
        .map(([provider, value]) => ({ provider, ...value }))
        .sort((a, b) => b.paidToman - a.paidToman),
      byDay: [...perDay.entries()]
        .map(([day, value]) => ({ day, ...value }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      pendingCount: inWindow.filter((payment) => payment.status === 'PENDING').length,
      failedCount: inWindow.filter((payment) => payment.status === 'FAILED').length,
    };
  }

  async summary(since: Date): Promise<{
    paidCount: number;
    paidToman: number;
    pendingCount: number;
    failedCount: number;
    expiredCount: number;
  }> {
    const summary = {
      paidCount: 0,
      paidToman: 0,
      pendingCount: 0,
      failedCount: 0,
      expiredCount: 0,
    };
    for (const payment of this.byId.values()) {
      if (payment.status === 'PENDING') summary.pendingCount += 1;
      if (payment.status === 'FAILED') summary.failedCount += 1;
      if (payment.status === 'EXPIRED') summary.expiredCount += 1;
      if (
        payment.status === 'PAID' &&
        (payment.paidAt ?? payment.createdAt).getTime() >= since.getTime()
      ) {
        summary.paidCount += 1;
        summary.paidToman += payment.amountToman;
      }
    }
    return summary;
  }
}

/**
 * G-11 — card-to-card deposits held in memory.
 *
 * `record` is the idempotency gate: the bank reference is the key, so a webhook replayed ten times
 * produces one deposit and therefore at most one activation.
 */
export class MemoryCardDepositRepository implements CardDepositRepository {
  private readonly byId = new Map<string, CardDeposit>();
  private readonly byReference = new Map<string, string>();

  async record(
    input: Omit<CardDeposit, 'id' | 'receivedAt' | 'status' | 'paymentId'>,
  ): Promise<{ deposit: CardDeposit; created: boolean }> {
    const existingId = this.byReference.get(input.reference);
    if (existingId) {
      const existing = this.byId.get(existingId)!;
      return { deposit: clone(existing), created: false };
    }
    const deposit: CardDeposit = {
      id: randomUUID(),
      reference: input.reference,
      amountToman: input.amountToman,
      senderName: input.senderName,
      paidAt: input.paidAt,
      receivedAt: new Date(),
      status: 'UNMATCHED',
      paymentId: null,
      note: input.note,
    };
    this.byId.set(deposit.id, clone(deposit));
    this.byReference.set(deposit.reference, deposit.id);
    return { deposit: clone(deposit), created: true };
  }

  async findById(id: string): Promise<CardDeposit | null> {
    const deposit = this.byId.get(id);
    return deposit ? clone(deposit) : null;
  }

  async markMatched(id: string, paymentId: string): Promise<CardDeposit | null> {
    const deposit = this.byId.get(id);
    if (!deposit) return null;
    deposit.status = 'MATCHED';
    deposit.paymentId = paymentId;
    return clone(deposit);
  }

  async list(
    status: CardDeposit['status'] | null,
    limit: number,
    offset: number,
  ): Promise<{ items: CardDeposit[]; total: number }> {
    const matches = [...this.byId.values()]
      .filter((deposit) => status === null || deposit.status === status)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    return {
      items: matches.slice(offset, offset + limit).map(clone),
      total: matches.length,
    };
  }

  async countUnmatchedSince(since: Date): Promise<number> {
    return [...this.byId.values()].filter(
      (deposit) =>
        deposit.status === 'UNMATCHED' && deposit.receivedAt.getTime() >= since.getTime(),
    ).length;
  }
}

export class MemoryPaymentCardRepository implements PaymentCardRepository {
  private readonly byId = new Map<string, PaymentCard>();

  async list(activeOnly: boolean): Promise<PaymentCard[]> {
    return [...this.byId.values()]
      .filter((card) => !activeOnly || card.isActive)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async findById(id: string): Promise<PaymentCard | null> {
    const card = this.byId.get(id);
    return card ? clone(card) : null;
  }

  async create(
    input: Omit<PaymentCard, 'id' | 'createdAt' | 'isActive'>,
    at: Date,
  ): Promise<PaymentCard> {
    const card: PaymentCard = {
      id: randomUUID(),
      cardNumber: input.cardNumber,
      holderName: input.holderName,
      bankName: input.bankName,
      isActive: true,
      dailyLimit: input.dailyLimit,
      createdAt: at,
    };
    this.byId.set(card.id, clone(card));
    return clone(card);
  }

  async deactivate(id: string): Promise<PaymentCard | null> {
    const card = this.byId.get(id);
    if (!card) return null;
    card.isActive = false;
    return clone(card);
  }
}
