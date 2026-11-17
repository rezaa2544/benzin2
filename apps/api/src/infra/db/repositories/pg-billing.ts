import { randomUUID } from 'node:crypto';
import type { PaymentMethod, PaymentStatus, SubscriptionStatus } from '@benzin/shared';
import type { Payment, PaymentCard, Plan, Subscription } from '../../../domain/entities.js';
import type {
  CardDeposit,
  CardDepositRepository,
  NewPayment,
  NewSubscription,
  PaymentCardRepository,
  PaymentRepository,
  PlanRepository,
  SubscriptionRepository,
} from '../../../ports.js';
import { Conditions, num, query, queryOne, scalar, type Db } from './pg-common.js';

/** Plans, subscriptions, payments and destination cards on Postgres (task G-01, G-15). */

type PlanRow = {
  id: string;
  code: string;
  name_fa: string;
  duration_days: number;
  price_toman: number;
  max_active_orders: number;
  is_active: boolean;
};

const toPlan = (row: PlanRow): Plan => ({
  id: row.id,
  code: row.code,
  nameFa: row.name_fa,
  durationDays: Number(row.duration_days),
  priceToman: Number(row.price_toman),
  maxActiveOrders: Number(row.max_active_orders),
  isActive: row.is_active,
});

const PLAN_COLUMNS = `id, code, name_fa, duration_days, price_toman, max_active_orders, is_active`;

export class PgPlanRepository implements PlanRepository {
  constructor(private readonly db: Db) {}

  async listActive(): Promise<Plan[]> {
    const rows = await query<PlanRow>(
      this.db,
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE is_active = true ORDER BY price_toman`,
    );
    return rows.map(toPlan);
  }

  async listAll(): Promise<Plan[]> {
    const rows = await query<PlanRow>(
      this.db,
      `SELECT ${PLAN_COLUMNS} FROM plans ORDER BY is_active DESC, price_toman`,
    );
    return rows.map(toPlan);
  }

  async findById(id: string): Promise<Plan | null> {
    const row = await queryOne<PlanRow>(
      this.db,
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`,
      [id],
    );
    return row ? toPlan(row) : null;
  }

  async setActive(id: string, isActive: boolean): Promise<Plan | null> {
    const row = await queryOne<PlanRow>(
      this.db,
      `UPDATE plans SET is_active = $2 WHERE id = $1 RETURNING ${PLAN_COLUMNS}`,
      [id, isActive],
    );
    return row ? toPlan(row) : null;
  }

  async update(id: string, patch: Partial<Omit<Plan, 'id' | 'code'>>): Promise<Plan | null> {
    // Fixed column list keeps the SQL static: only the fields present are written.
    const sets: string[] = [];
    const values: unknown[] = [id];
    const assign = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.nameFa !== undefined) assign('name_fa', patch.nameFa);
    if (patch.durationDays !== undefined) assign('duration_days', patch.durationDays);
    if (patch.priceToman !== undefined) assign('price_toman', patch.priceToman);
    if (patch.maxActiveOrders !== undefined) assign('max_active_orders', patch.maxActiveOrders);
    if (patch.isActive !== undefined) assign('is_active', patch.isActive);
    if (sets.length === 0) {
      const current = await queryOne<PlanRow>(
        this.db,
        `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`,
        [id],
      );
      return current ? toPlan(current) : null;
    }
    const row = await queryOne<PlanRow>(
      this.db,
      `UPDATE plans SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PLAN_COLUMNS}`,
      values,
    );
    return row ? toPlan(row) : null;
  }

  async findByCode(code: string): Promise<Plan | null> {
    const row = await queryOne<PlanRow>(
      this.db,
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE code = $1`,
      [code],
    );
    return row ? toPlan(row) : null;
  }

  /** Upsert by `code`: the panel edit of a plan must not fork a second row with the same code. */
  async upsert(plan: Plan): Promise<Plan> {
    const row = await queryOne<PlanRow>(
      this.db,
      `INSERT INTO plans (id, code, name_fa, duration_days, price_toman, max_active_orders, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO UPDATE
         SET name_fa = EXCLUDED.name_fa, duration_days = EXCLUDED.duration_days,
             price_toman = EXCLUDED.price_toman, max_active_orders = EXCLUDED.max_active_orders,
             is_active = EXCLUDED.is_active
       RETURNING ${PLAN_COLUMNS}`,
      [
        plan.id || randomUUID(),
        plan.code,
        plan.nameFa,
        plan.durationDays,
        plan.priceToman,
        plan.maxActiveOrders,
        plan.isActive,
      ],
    );
    if (!row) throw new Error('plan upsert returned no row');
    return toPlan(row);
  }
}

type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
};

const SUBSCRIPTION_COLUMNS = `id, user_id, plan_id, status, starts_at, ends_at, created_at`;

const toSubscription = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  userId: row.user_id,
  planId: row.plan_id,
  status: row.status,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  createdAt: row.created_at,
});

export class PgSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewSubscription): Promise<Subscription> {
    const row = await queryOne<SubscriptionRow>(
      this.db,
      `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, ends_at)
       VALUES ($1, $2, 'PENDING', $3, $4) RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [input.userId, input.planId, input.startsAt, input.endsAt],
    );
    if (!row) throw new Error('subscription insert returned no row');
    return toSubscription(row);
  }

  async findById(id: string): Promise<Subscription | null> {
    const row = await queryOne<SubscriptionRow>(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE id = $1`,
      [id],
    );
    return row ? toSubscription(row) : null;
  }

  async findActiveByUser(userId: string, now: Date): Promise<Subscription | null> {
    const row = await queryOne<SubscriptionRow>(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE user_id = $1 AND status = 'ACTIVE' AND starts_at <= $2 AND ends_at > $2
        ORDER BY ends_at DESC LIMIT 1`,
      [userId, now],
    );
    return row ? toSubscription(row) : null;
  }

  async activate(id: string, startsAt: Date, endsAt: Date): Promise<Subscription | null> {
    const row = await queryOne<SubscriptionRow>(
      this.db,
      `UPDATE subscriptions SET status = 'ACTIVE', starts_at = $2, ends_at = $3
        WHERE id = $1 RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [id, startsAt, endsAt],
    );
    return row ? toSubscription(row) : null;
  }

  async listDueExpiry(now: Date, limit: number): Promise<Subscription[]> {
    const rows = await query<SubscriptionRow>(
      this.db,
      `SELECT * FROM (
         SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
          WHERE status = 'ACTIVE' AND ends_at <= $1
          ORDER BY ends_at LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) due`,
      [now, limit],
    );
    return rows.map(toSubscription);
  }

  async expire(id: string): Promise<Subscription | null> {
    const row = await queryOne<SubscriptionRow>(
      this.db,
      `UPDATE subscriptions SET status = 'EXPIRED' WHERE id = $1 AND status = 'ACTIVE'
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [id],
    );
    return row ? toSubscription(row) : null;
  }

  async listByUser(userId: string, limit: number): Promise<Subscription[]> {
    const rows = await query<SubscriptionRow>(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toSubscription);
  }

  async listAll(input: {
    status: SubscriptionStatus | null;
    limit: number;
    offset: number;
  }): Promise<{ items: Subscription[]; total: number }> {
    const conditions = new Conditions();
    conditions.addIf(input.status !== null, (p) => `status = ${p}`, input.status);
    const limit = conditions.pagination(input.limit, input.offset);
    const rows = await query<SubscriptionRow>(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions ${conditions.sql} ORDER BY created_at DESC ${limit}`,
      conditions.values,
    );
    const total = await scalar(
      this.db,
      `SELECT count(*)::int AS value FROM subscriptions ${conditions.sql}`,
      conditions.values.slice(0, -2),
    );
    return { items: rows.map(toSubscription), total };
  }

  async countByStatus(): Promise<Record<SubscriptionStatus, number>> {
    const rows = await query<{ key: string; total: string }>(
      this.db,
      `SELECT status::text AS key, count(*)::int AS total FROM subscriptions GROUP BY status`,
    );
    const result: Record<SubscriptionStatus, number> = {
      ACTIVE: 0,
      EXPIRED: 0,
      CANCELLED: 0,
      PENDING: 0,
    };
    for (const row of rows) result[row.key as SubscriptionStatus] = Number(row.total);
    return result;
  }
}

type PaymentRow = {
  id: string;
  user_id: string;
  subscription_id: string | null;
  provider: PaymentMethod;
  status: PaymentStatus;
  amount_toman: number;
  authority: string | null;
  reference: string | null;
  unique_amount: number | null;
  raw_payload: Record<string, unknown>;
  paid_at: Date | null;
  expires_at: Date;
  created_at: Date;
  verify_attempts: number;
  next_verify_at: Date | null;
  last_verify_error: string | null;
};

const PAYMENT_COLUMNS = `id, user_id, subscription_id, provider, status, amount_toman, authority, reference,
         unique_amount, raw_payload, paid_at, expires_at, created_at,
         verify_attempts, next_verify_at, last_verify_error`;

const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  userId: row.user_id,
  subscriptionId: row.subscription_id,
  provider: row.provider,
  status: row.status,
  amountToman: Number(row.amount_toman),
  authority: row.authority,
  reference: row.reference,
  uniqueAmountToman: row.unique_amount === null ? null : Number(row.unique_amount),
  rawPayload: row.raw_payload,
  paidAt: row.paid_at,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  verifyAttempts: Number(row.verify_attempts ?? 0),
  nextVerifyAt: row.next_verify_at ?? null,
  lastVerifyError: row.last_verify_error ?? null,
});

export class PgPaymentRepository implements PaymentRepository {
  constructor(private readonly db: Db) {}

  /**
   * Card-to-card matching depends on `unique_amount` being unique among PENDING rows; the partial
   * index `payments_unique_amount_idx` enforces it, so a collision returns null (the service then
   * re-rolls the amount) instead of two payments claiming the same transfer.
   */
  async create(input: NewPayment, at: Date): Promise<Payment | null> {
    const row = await queryOne<PaymentRow>(
      this.db,
      `INSERT INTO payments (user_id, subscription_id, provider, status, amount_toman, unique_amount, expires_at, created_at)
       VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        input.userId,
        input.subscriptionId,
        input.provider,
        input.amountToman,
        input.uniqueAmountToman,
        input.expiresAt,
        at,
      ],
    );
    return row ? toPayment(row) : null;
  }

  async findById(id: string): Promise<Payment | null> {
    const row = await queryOne<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
      [id],
    );
    return row ? toPayment(row) : null;
  }

  async findByAuthority(authority: string): Promise<Payment | null> {
    const row = await queryOne<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE authority = $1 ORDER BY created_at DESC LIMIT 1`,
      [authority],
    );
    return row ? toPayment(row) : null;
  }

  async findPayableByAmount(
    provider: Payment['provider'],
    amountToman: number,
    now: Date,
  ): Promise<Payment[]> {
    const rows = await query<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments
        WHERE unique_amount = $1 AND provider = $2::payment_method
          AND status = 'PENDING' AND expires_at > $3
        ORDER BY created_at`,
      [amountToman, provider, now],
    );
    return rows.map(toPayment);
  }

  async findByUniqueAmount(amountToman: number): Promise<Payment | null> {
    const row = await queryOne<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE unique_amount = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
      [amountToman],
    );
    return row ? toPayment(row) : null;
  }

  async transition(
    id: string,
    expected: PaymentStatus,
    next: PaymentStatus,
    patch?: Partial<Pick<Payment, 'paidAt' | 'reference' | 'authority'>>,
  ): Promise<Payment | null> {
    const row = await queryOne<PaymentRow>(
      this.db,
      `UPDATE payments
          SET status = $3,
              paid_at = COALESCE($4, paid_at),
              reference = COALESCE($5, reference),
              authority = COALESCE($6, authority)
        WHERE id = $1 AND status = $2
        RETURNING ${PAYMENT_COLUMNS}`,
      [
        id,
        expected,
        next,
        patch?.paidAt ?? null,
        patch?.reference ?? null,
        patch?.authority ?? null,
      ],
    );
    return row ? toPayment(row) : null;
  }

  async listPendingExpired(now: Date, limit: number): Promise<Payment[]> {
    const rows = await query<PaymentRow>(
      this.db,
      `SELECT * FROM (
         SELECT ${PAYMENT_COLUMNS} FROM payments
          WHERE status = 'PENDING' AND expires_at <= $1
          ORDER BY expires_at LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) due`,
      [now, limit],
    );
    return rows.map(toPayment);
  }

  async listByUser(userId: string, limit: number): Promise<Payment[]> {
    const rows = await query<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toPayment);
  }

  async listAll(options: { status: PaymentStatus | null; limit: number }): Promise<Payment[]> {
    const rows = await query<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments
        WHERE ($1::payment_status IS NULL OR status = $1)
        ORDER BY created_at DESC LIMIT $2`,
      [options.status, options.limit],
    );
    return rows.map(toPayment);
  }

  async listDueVerify(now: Date, limit: number): Promise<Payment[]> {
    const rows = await query<PaymentRow>(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments
        WHERE status = 'PENDING' AND next_verify_at IS NOT NULL AND next_verify_at <= $1
        ORDER BY next_verify_at ASC
        LIMIT $2`,
      [now, limit],
    );
    return rows.map(toPayment);
  }

  async recordVerifyAttempt(
    id: string,
    input: { attempts: number; nextAt: Date | null; error: string | null; clear?: boolean },
  ): Promise<Payment | null> {
    const row = await queryOne<PaymentRow>(
      this.db,
      `UPDATE payments
          SET verify_attempts = $2,
              next_verify_at = $3,
              last_verify_error = $4
        WHERE id = $1
        RETURNING ${PAYMENT_COLUMNS}`,
      [id, input.attempts, input.clear ? null : input.nextAt, input.clear ? null : input.error],
    );
    return row ? toPayment(row) : null;
  }

  async revenue(from: Date, to: Date): Promise<{
    totalPaidToman: number;
    totalPaidCount: number;
    byProvider: { provider: PaymentMethod; paidToman: number; paidCount: number }[];
    byDay: { day: string; paidToman: number; paidCount: number }[];
    pendingCount: number;
    failedCount: number;
  }> {
    const [totals] = await query<{
      paid_toman: string | number | null;
      paid_count: string | number;
      pending_count: string | number;
      failed_count: string | number;
    }>(
      this.db,
      `SELECT COALESCE(SUM(amount_toman) FILTER (WHERE status = 'PAID'), 0) AS paid_toman,
              COUNT(*) FILTER (WHERE status = 'PAID')  AS paid_count,
              COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_count,
              COUNT(*) FILTER (WHERE status = 'FAILED')  AS failed_count
         FROM payments
        WHERE COALESCE(paid_at, created_at) BETWEEN $1 AND $2`,
      [from, to],
    ).then((rows) => (rows.length > 0 ? rows : [{ paid_toman: 0, paid_count: 0, pending_count: 0, failed_count: 0 }]));

    const providers = await query<{
      provider: PaymentMethod;
      paid_toman: string | number;
      paid_count: string | number;
    }>(
      this.db,
      `SELECT provider, SUM(amount_toman) AS paid_toman, COUNT(*) AS paid_count
         FROM payments
        WHERE status = 'PAID' AND COALESCE(paid_at, created_at) BETWEEN $1 AND $2
        GROUP BY provider
        ORDER BY paid_toman DESC`,
      [from, to],
    );

    // `Asia/Tehran` so a payment at 23:30 local time lands on that local day, not the UTC one.
    const days = await query<{ day: string; paid_toman: string | number; paid_count: string | number }>(
      this.db,
      `SELECT to_char((COALESCE(paid_at, created_at) AT TIME ZONE 'Asia/Tehran')::date, 'YYYY-MM-DD') AS day,
              SUM(amount_toman) AS paid_toman,
              COUNT(*) AS paid_count
         FROM payments
        WHERE status = 'PAID' AND COALESCE(paid_at, created_at) BETWEEN $1 AND $2
        GROUP BY 1
        ORDER BY 1 ASC`,
      [from, to],
    );

    return {
      totalPaidToman: Number(totals?.paid_toman ?? 0),
      totalPaidCount: Number(totals?.paid_count ?? 0),
      byProvider: providers.map((row) => ({
        provider: row.provider,
        paidToman: Number(row.paid_toman),
        paidCount: Number(row.paid_count),
      })),
      byDay: days.map((row) => ({
        day: row.day,
        paidToman: Number(row.paid_toman),
        paidCount: Number(row.paid_count),
      })),
      pendingCount: Number(totals?.pending_count ?? 0),
      failedCount: Number(totals?.failed_count ?? 0),
    };
  }

  async summary(since: Date): Promise<{
    paidCount: number;
    paidToman: number;
    pendingCount: number;
    failedCount: number;
    expiredCount: number;
  }> {
    const row = await queryOne<{
      paid_count: string;
      paid_toman: string | null;
      pending_count: string;
      failed_count: string;
      expired_count: string;
    }>(
      this.db,
      `SELECT count(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
              COALESCE(sum(amount_toman) FILTER (WHERE status = 'PAID'), 0) AS paid_toman,
              count(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
              count(*) FILTER (WHERE status IN ('FAILED', 'NEEDS_REVIEW'))::int AS failed_count,
              count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired_count
         FROM payments WHERE created_at >= $1`,
      [since],
    );
    return {
      paidCount: Number(row?.paid_count ?? 0),
      paidToman: Number(row?.paid_toman ?? 0),
      pendingCount: Number(row?.pending_count ?? 0),
      failedCount: Number(row?.failed_count ?? 0),
      expiredCount: Number(row?.expired_count ?? 0),
    };
  }
}

type CardRow = {
  id: string;
  card_number: string;
  holder_name: string;
  bank_name: string | null;
  is_active: boolean;
  daily_limit: number | null;
  created_at: Date;
};

const CARD_COLUMNS = `id, card_number, holder_name, bank_name, is_active, daily_limit, created_at`;

const toCard = (row: CardRow): PaymentCard => ({
  id: row.id,
  cardNumber: row.card_number,
  holderName: row.holder_name,
  bankName: row.bank_name,
  isActive: row.is_active,
  dailyLimit: row.daily_limit === null ? null : Number(row.daily_limit),
  createdAt: row.created_at,
});

/**
 * G-11 — deposits on Postgres. `ON CONFLICT (reference) DO NOTHING` is the whole idempotency
 * story: the unique index decides, so two callbacks racing each other still create one row.
 */
type DepositRow = {
  id: string;
  reference: string;
  amount_toman: string | number;
  sender_name: string | null;
  paid_at: Date;
  received_at: Date;
  status: CardDeposit['status'];
  payment_id: string | null;
  note: string | null;
};

const DEPOSIT_COLUMNS = `id, reference, amount_toman, sender_name, paid_at, received_at, status,
         payment_id, note`;

const toDeposit = (row: DepositRow): CardDeposit => ({
  id: row.id,
  reference: row.reference,
  amountToman: num(row.amount_toman),
  senderName: row.sender_name,
  paidAt: row.paid_at,
  receivedAt: row.received_at,
  status: row.status,
  paymentId: row.payment_id,
  note: row.note,
});

export class PgCardDepositRepository implements CardDepositRepository {
  constructor(private readonly db: Db) {}

  async record(
    input: Omit<CardDeposit, 'id' | 'receivedAt' | 'status' | 'paymentId'>,
  ): Promise<{ deposit: CardDeposit; created: boolean }> {
    const inserted = await queryOne<DepositRow>(
      this.db,
      `INSERT INTO card_deposits (reference, amount_toman, sender_name, paid_at, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (reference) DO NOTHING
       RETURNING ${DEPOSIT_COLUMNS}`,
      [input.reference, input.amountToman, input.senderName, input.paidAt, input.note],
    );
    if (inserted) return { deposit: toDeposit(inserted), created: true };
    const existing = await queryOne<DepositRow>(
      this.db,
      `SELECT ${DEPOSIT_COLUMNS} FROM card_deposits WHERE reference = $1`,
      [input.reference],
    );
    if (!existing) throw new Error('card deposit vanished while recording');
    return { deposit: toDeposit(existing), created: false };
  }

  async findById(id: string): Promise<CardDeposit | null> {
    const row = await queryOne<DepositRow>(
      this.db,
      `SELECT ${DEPOSIT_COLUMNS} FROM card_deposits WHERE id = $1`,
      [id],
    );
    return row ? toDeposit(row) : null;
  }

  async markMatched(id: string, paymentId: string): Promise<CardDeposit | null> {
    const row = await queryOne<DepositRow>(
      this.db,
      `UPDATE card_deposits SET status = 'MATCHED', payment_id = $2
        WHERE id = $1 RETURNING ${DEPOSIT_COLUMNS}`,
      [id, paymentId],
    );
    return row ? toDeposit(row) : null;
  }

  async list(
    status: CardDeposit['status'] | null,
    limit: number,
    offset: number,
  ): Promise<{ items: CardDeposit[]; total: number }> {
    const rows = await query<DepositRow>(
      this.db,
      `SELECT ${DEPOSIT_COLUMNS} FROM card_deposits
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY received_at DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    const total = await scalar(
      this.db,
      `SELECT count(*)::int AS value FROM card_deposits WHERE ($1::text IS NULL OR status = $1)`,
      [status],
    );
    return { items: rows.map(toDeposit), total };
  }

  async countUnmatchedSince(since: Date): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM card_deposits
        WHERE status = 'UNMATCHED' AND received_at >= $1`,
      [since],
    );
  }
}

export class PgPaymentCardRepository implements PaymentCardRepository {
  constructor(private readonly db: Db) {}

  async list(activeOnly: boolean): Promise<PaymentCard[]> {
    const rows = await query<CardRow>(
      this.db,
      `SELECT ${CARD_COLUMNS} FROM payment_cards WHERE ($1::boolean = false OR is_active = true) ORDER BY created_at DESC`,
      [activeOnly],
    );
    return rows.map(toCard);
  }

  async findById(id: string): Promise<PaymentCard | null> {
    const row = await queryOne<CardRow>(
      this.db,
      `SELECT ${CARD_COLUMNS} FROM payment_cards WHERE id = $1`,
      [id],
    );
    return row ? toCard(row) : null;
  }

  async create(
    input: Omit<PaymentCard, 'id' | 'createdAt' | 'isActive'>,
    at: Date,
  ): Promise<PaymentCard> {
    const row = await queryOne<CardRow>(
      this.db,
      `INSERT INTO payment_cards (card_number, holder_name, bank_name, is_active, daily_limit, created_at)
       VALUES ($1, $2, $3, true, $4, $5) RETURNING ${CARD_COLUMNS}`,
      [input.cardNumber, input.holderName, input.bankName, input.dailyLimit, at],
    );
    if (!row) throw new Error('payment card insert returned no row');
    return toCard(row);
  }

  async deactivate(id: string): Promise<PaymentCard | null> {
    const row = await queryOne<CardRow>(
      this.db,
      `UPDATE payment_cards SET is_active = false WHERE id = $1 RETURNING ${CARD_COLUMNS}`,
      [id],
    );
    return row ? toCard(row) : null;
  }
}
