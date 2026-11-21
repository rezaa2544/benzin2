import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@benzin/shared';
import type { Clock, Payment, User } from '../domain/entities.js';
import type { CardDeposit, NotificationEmitter, Repositories } from '../ports.js';
import type { SettingsService } from './settings-service.js';

/**
 * G-11 — card-to-card: auto matching and review mode.
 *
 * The two modes are the same product seen from two directions:
 *
 *  * `auto` — the bank's deposit feed calls `POST /v1/payments/card/deposits` with an HMAC-signed
 *    body; the amount carries a per-invoice suffix, so the exact amount *is* the key. A match
 *    settles the invoice and activates the plan without a human.
 *  * `review` — no feed (yet), so the buyer types the tracking number from their banking app and an
 *    operator approves it in the panel. The payment waits in `NEEDS_REVIEW`, which is visible in
 *    both the buyer's app and the panel queue.
 *
 * Two rules hold in both modes:
 *  1. A deposit is recorded *before* it is matched, so an unmatched transfer is a fact support can
 *     see rather than a 404 the bank retries forever.
 *  2. Nothing here activates a plan twice: the deposit reference is unique, and every status change
 *     is a compare-and-set.
 */

export interface CardDepositView {
  id: string;
  reference: string;
  amountToman: number;
  senderName: string | null;
  paidAt: string;
  receivedAt: string;
  status: CardDeposit['status'];
  paymentId: string | null;
}

const toDepositView = (deposit: CardDeposit): CardDepositView => ({
  id: deposit.id,
  reference: deposit.reference,
  amountToman: deposit.amountToman,
  senderName: deposit.senderName,
  paidAt: deposit.paidAt.toISOString(),
  receivedAt: deposit.receivedAt.toISOString(),
  status: deposit.status,
  paymentId: deposit.paymentId,
});

/** Constant-time comparison of the `sha256=<hex>` header the bank's forwarder sends. */
export function verifyDepositSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export interface DepositInput {
  amountToman: number;
  reference: string;
  paidAt: Date;
  senderName?: string | null;
}

/**
 * Why the last match attempt failed. `NO_INVOICE` means «nobody is waiting for this amount»;
 * `AMBIGUOUS` means two invoices somehow share it — the row then goes to a human instead of a
 * coin-flip.
 */
export type MatchOutcome = 'MATCHED' | 'NO_INVOICE' | 'AMBIGUOUS';

export class CardDepositService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'payments' | 'paymentCards' | 'cardDeposits' | 'subscriptions' | 'plans' | 'users' | 'audit'
    >,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly notifier: NotificationEmitter,
    /** Set by `PaymentService` after construction: settles an invoice through the same path a
     *  manual approval takes, so a matched deposit and an approved one cannot diverge. */
    private settle: ((payment: Payment, reference: string) => Promise<void>) | null = null,
  ) {}

  attachSettlement(settle: (payment: Payment, reference: string) => Promise<void>): void {
    this.settle = settle;
  }

  /** The destination account the buyer is told to pay, straight from the settings (G-11). */
  async destination(): Promise<{
    cardNumber: string;
    holderName: string;
    bankName: string | null;
  }> {
    const config = await this.settings.get();
    const [card] = await this.repos.paymentCards.list(true);
    return {
      // Settings win: an operator can rotate the card from the panel without a deploy.
      cardNumber: config['payment.card_number'] ?? card?.cardNumber ?? '',
      holderName: config['payment.card_holder'] ?? card?.holderName ?? '',
      bankName: card?.bankName ?? null,
    };
  }

  /**
   * Handles one transfer from the bank.
   *
   * Idempotent by reference: a replayed callback records nothing new and settles nothing new, and
   * the caller still gets `200` so the bank stops retrying.
   */
  async handleDeposit(input: DepositInput): Promise<{
    deposit: CardDepositView;
    duplicate: boolean;
    outcome: MatchOutcome | 'ALREADY_SETTLED';
  }> {
    const recorded = await this.repos.cardDeposits.record({
      reference: input.reference,
      amountToman: input.amountToman,
      senderName: input.senderName ?? null,
      paidAt: input.paidAt,
      note: null,
    });
    const deposit = recorded.deposit;

    if (!recorded.created) {
      // A second delivery of the same transfer: report where it ended up, change nothing.
      return {
        deposit: toDepositView(deposit),
        duplicate: true,
        outcome: deposit.status === 'MATCHED' ? 'ALREADY_SETTLED' : 'NO_INVOICE',
      };
    }

    const match = await this.match(deposit);
    if (match.outcome === 'MATCHED') {
      return { deposit: toDepositView(match.deposit), duplicate: false, outcome: 'MATCHED' };
    }

    // Nobody is waiting for this amount: keep the money on the books and call the humans.
    await this.repos.audit.append({
      actorId: null,
      action: 'payment.deposit_unmatched',
      entity: 'card_deposit',
      entityId: deposit.id,
      metadata: { amountToman: deposit.amountToman, reference: deposit.reference },
    });
    for (const staff of await this.staff()) {
      await this.notifier.emit({
        userId: staff.id,
        kind: 'PAYMENT_DEPOSIT_UNMATCHED',
        params: { amount: deposit.amountToman, reference: deposit.reference },
        payload: { depositId: deposit.id },
      });
    }
    return {
      deposit: toDepositView((await this.repos.cardDeposits.findById(deposit.id)) ?? deposit),
      duplicate: false,
      outcome: match.outcome,
    };
  }

  /**
   * Finds the invoice this amount belongs to.
   *
   * The unique amount is the key, so this is an equality test, not a heuristic — and it only ever
   * looks at invoices that are still payable. `AMBIGUOUS` (two invoices with the same amount) is
   * treated like a miss on purpose: guessing would give a stranger's money to the wrong buyer.
   */
  private async match(
    deposit: CardDeposit,
  ): Promise<{ outcome: MatchOutcome; deposit: CardDeposit }> {
    const candidates = await this.repos.payments.findPayableByAmount(
      'CARD_TO_CARD',
      deposit.amountToman,
      this.clock.now(),
    );
    if (candidates.length === 0) return { outcome: 'NO_INVOICE', deposit };
    if (candidates.length > 1) {
      await this.repos.audit.append({
        actorId: null,
        action: 'payment.deposit_ambiguous',
        entity: 'card_deposit',
        entityId: deposit.id,
        metadata: { amountToman: deposit.amountToman, payments: candidates.map((p) => p.id) },
      });
      return { outcome: 'AMBIGUOUS', deposit };
    }
    const payment = candidates[0]!;
    if (!this.settle) throw new Error('card deposit service has no settlement hook');
    await this.settle(payment, deposit.reference);
    const matched = await this.repos.cardDeposits.markMatched(deposit.id, payment.id);
    return { outcome: 'MATCHED', deposit: matched ?? deposit };
  }

  /** Review mode: the buyer pastes the tracking number from their banking app. */
  async submitProof(
    user: User,
    paymentId: string,
    input: { trackingNumber: string },
  ): Promise<{ paymentId: string; status: string; queued: boolean }> {
    const config = await this.settings.get();
    const payment = await this.repos.payments.findById(paymentId);
    if (!payment || payment.userId !== user.id) {
      throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    if (payment.provider !== 'CARD_TO_CARD') {
      throw new AppError('PAYMENT_NOT_PAYABLE', 409, 'This invoice is not a card transfer');
    }
    if (payment.status === 'NEEDS_REVIEW') {
      return { paymentId, status: payment.status, queued: true };
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

    const queued = config['payment.card_mode'] === 'review';
    if (!queued) {
      // In auto mode the amount decides; a tracking number adds nothing and would only invite
      // people to skip the bank. Answer honestly instead of silently accepting it.
      throw new AppError(
        'CARD_REVIEW_DISABLED',
        409,
        'Card transfers are confirmed automatically in this mode',
      );
    }

    const updated = await this.repos.payments.transition(payment.id, 'PENDING', 'NEEDS_REVIEW', {
      reference: input.trackingNumber,
    });
    if (!updated) throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment changed');
    await this.repos.audit.append({
      actorId: user.id,
      action: 'payment.proof_submitted',
      entity: 'payment',
      entityId: payment.id,
      metadata: { trackingNumber: input.trackingNumber },
    });
    for (const staff of await this.staff()) {
      await this.notifier.emit({
        userId: staff.id,
        kind: 'PAYMENT_NEEDS_REVIEW',
        params: { amount: payment.amountToman, tracking: input.trackingNumber },
        payload: { paymentId: payment.id },
      });
    }
    return { paymentId, status: 'NEEDS_REVIEW', queued: true };
  }

  /** Admin: deposits of any status (the panel filters with `?status=`). */
  async listDeposits(
    status: CardDeposit['status'] | null,
    limit = 50,
    offset = 0,
  ): Promise<{ items: CardDepositView[]; total: number }> {
    const result = await this.repos.cardDeposits.list(status, limit, offset);
    return { items: result.items.map(toDepositView), total: result.total };
  }

  /** Admin: the unmatched queue, newest first. */
  async listUnmatched(
    limit = 50,
    offset = 0,
  ): Promise<{
    items: CardDepositView[];
    total: number;
  }> {
    const result = await this.repos.cardDeposits.list('UNMATCHED', limit, offset);
    return { items: result.items.map(toDepositView), total: result.total };
  }

  /** Admin: attach a stubborn deposit to an invoice by hand. */
  async attachDeposit(
    actor: User,
    depositId: string,
    paymentId: string,
  ): Promise<{ deposit: CardDepositView; paymentId: string }> {
    const deposit = await this.repos.cardDeposits.findById(depositId);
    if (!deposit) throw AppError.notFound('DEPOSIT_NOT_FOUND', 'Deposit not found');
    if (deposit.status === 'MATCHED') {
      throw new AppError('DEPOSIT_ALREADY_MATCHED', 409, 'Deposit is already matched', {
        paymentId: deposit.paymentId,
      });
    }
    const payment = await this.repos.payments.findById(paymentId);
    if (!payment) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    if (payment.status !== 'PENDING' && payment.status !== 'NEEDS_REVIEW') {
      throw new AppError('PAYMENT_ALREADY_SETTLED', 409, 'Payment is already settled', {
        status: payment.status,
      });
    }
    if (!this.settle) throw new Error('card deposit service has no settlement hook');
    await this.settle(payment, deposit.reference);
    const matched = await this.repos.cardDeposits.markMatched(deposit.id, payment.id);
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'payment.deposit_attached',
      entity: 'card_deposit',
      entityId: deposit.id,
      metadata: { paymentId: payment.id, amountToman: deposit.amountToman },
    });
    return { deposit: toDepositView(matched ?? deposit), paymentId: payment.id };
  }

  /** Dashboard tile: how much money is sitting unmatched right now. */
  async unmatchedSummary(): Promise<{ count: number; totalToman: number }> {
    const { items, total } = await this.listUnmatched(200, 0);
    return { count: total, totalToman: items.reduce((sum, item) => sum + item.amountToman, 0) };
  }

  /** Every ADMIN and OWNER — the people who can act on a stuck transfer. */
  private async staff(): Promise<User[]> {
    const admins = await this.repos.users.search({
      text: null,
      role: 'ADMIN',
      status: 'ACTIVE',
      limit: 20,
      offset: 0,
    });
    const owners = await this.repos.users.search({
      text: null,
      role: 'OWNER',
      status: 'ACTIVE',
      limit: 20,
      offset: 0,
    });
    return [...admins.items, ...owners.items];
  }
}
