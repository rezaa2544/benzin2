import { randomBytes } from 'node:crypto';
import {
  AppError,
  CANCEL_REASON_FA,
  nextOrderStatus,
  nextReservationStatus,
  type CancelReason,
  type Settings,
} from '@benzin/shared';
import type { Clock, Order, Reservation, User } from '../domain/entities.js';
import {
  NOOP_NOTIFIER,
  NOOP_OWNER_RESPONSE,
  NOOP_REPUTATION,
  type NotificationEmitter,
  type OwnerResponseTracker,
  type ReputationRecorder,
  type Repositories,
} from '../ports.js';
import { KeyedLock } from './keyed-lock.js';
import type { SettingsService } from './settings-service.js';

export interface ReservationView {
  id: string;
  orderId: string;
  takerId: string;
  status: Reservation['status'];
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  extensionCount: number;
  /** True once the four-digit hand-over code exists (G-09) — the code itself is never in here. */
  deliveryCodeIssued: boolean;
  /** Wrong codes typed so far, capped at the limit so the client cannot use it as an oracle. */
  deliveryAttempts: number;
  /** ISO timestamp of the ten-minute lock, or null when the seller may still try. */
  deliveryLockedUntil: string | null;
}

/** G-09 acceptance: three wrong codes arm a ten-minute lock. */
export const DELIVERY_CODE_LENGTH = 4;
export const DELIVERY_CODE_ATTEMPTS = 3;
export const DELIVERY_CODE_LOCK_MS = 10 * 60_000;

export const toReservationView = (reservation: Reservation): ReservationView => ({
  id: reservation.id,
  orderId: reservation.orderId,
  takerId: reservation.takerId,
  status: reservation.status,
  createdAt: reservation.createdAt.toISOString(),
  expiresAt: reservation.expiresAt.toISOString(),
  decidedAt: reservation.decidedAt?.toISOString() ?? null,
  completedAt: reservation.completedAt?.toISOString() ?? null,
  cancelReason: reservation.cancelReason,
  extensionCount: reservation.extensionCount,
  deliveryCodeIssued: reservation.deliveryCode !== null,
  deliveryAttempts: Math.min(reservation.deliveryAttempts, DELIVERY_CODE_ATTEMPTS),
  deliveryLockedUntil: reservation.deliveryLockedUntil?.toISOString() ?? null,
});

export class ReservationService {
  /** One taker must not reserve twice at the same instant (E1-07). */
  private readonly takerLock = new KeyedLock();

  constructor(
    private readonly repos: Pick<
      Repositories,
      'orders' | 'reservations' | 'audit' | 'users' | 'subscriptions'
    >,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly notifier: NotificationEmitter = NOOP_NOTIFIER,
    private readonly reputation: ReputationRecorder = NOOP_REPUTATION,
    /** G-10: silence is measured here; the service decides what it costs (a listing pause). */
    private readonly ownerResponse: OwnerResponseTracker = NOOP_OWNER_RESPONSE,
  ) {}

  /** Sends one Persian notification; a notifier failure must never fail the trade. */
  private async notify(
    userId: string,
    kind: Parameters<NotificationEmitter['emit']>[0]['kind'],
    params: Record<string, string | number>,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.notifier.emit({ userId, kind, params, payload });
  }

  private async load(id: string): Promise<{ reservation: Reservation; order: Order }> {
    const reservation = await this.repos.reservations.findById(id);
    if (!reservation) throw AppError.notFound('RESERVATION_NOT_FOUND', 'Reservation not found');
    const order = await this.repos.orders.findById(reservation.orderId);
    if (!order) throw AppError.notFound('ORDER_NOT_AVAILABLE', 'Order not found');
    return { reservation, order };
  }

  /**
   * Requests an order. Two guards make this safe under concurrency:
   * the order status compare-and-set, and the single-active-reservation constraint.
   */
  async request(taker: User, orderId: string): Promise<ReservationView> {
    const config = await this.settings.get();
    const now = this.clock.now();
    const order = await this.repos.orders.findById(orderId);
    if (!order) throw AppError.notFound('ORDER_NOT_AVAILABLE', 'Order not found');
    if (order.ownerId === taker.id) {
      throw AppError.forbidden('TRADE_CYCLE_BLOCKED', 'You cannot reserve your own order');
    }
    if (order.status !== 'OPEN' || order.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('ORDER_NOT_AVAILABLE', 409, 'Order is no longer available');
    }

    if (config['subscription.required_for_orders']) {
      const subscription = await this.repos.subscriptions.findActiveByUser(taker.id, now);
      if (!subscription) {
        throw new AppError('SUBSCRIPTION_REQUIRED', 403, 'An active subscription is required');
      }
    }

    return this.takerLock.run(`taker:${taker.id}`, async () => {
      const active = await this.repos.reservations.findActiveByTaker(taker.id);
      if (active.length >= config['reservation.max_active_per_user']) {
        throw new AppError(
          'RESERVATION_LIMIT_REACHED',
          429,
          'You already have an active reservation',
          {
            limit: config['reservation.max_active_per_user'],
          },
        );
      }

      const reserved = await this.repos.orders.transition(orderId, 'OPEN', 'RESERVED');
      if (!reserved) throw new AppError('ORDER_NOT_AVAILABLE', 409, 'Order is no longer available');

      const reservation = await this.repos.reservations.createExclusive({
        id: crypto.randomUUID(),
        orderId,
        takerId: taker.id,
        // G-04: the reservation itself lives `reservation.ttl_minutes` (30 by default). The owner's
        // decision window is a separate nudge that only drives `expireDueReservations`.
        expiresAt: new Date(now.getTime() + config['reservation.ttl_minutes'] * 60_000),
      });

      if (!reservation) {
        await this.repos.orders.transition(orderId, 'RESERVED', 'OPEN');
        throw new AppError('ORDER_NOT_AVAILABLE', 409, 'Order is no longer available');
      }

      await this.repos.audit.append({
        actorId: taker.id,
        action: 'reservation.requested',
        entity: 'reservation',
        entityId: reservation.id,
        metadata: { orderId },
      });
      await this.notify(
        order.ownerId,
        'RESERVATION_REQUESTED',
        { litres: order.litres, minutes: config['reservation.ttl_minutes'] },
        { orderId, reservationId: reservation.id },
      );
      return toReservationView(reservation);
    });
  }

  async get(user: User, id: string): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    if (reservation.takerId !== user.id && order.ownerId !== user.id && user.role === 'USER') {
      throw AppError.forbidden('NOT_RESERVATION_PARTY', 'Not a party to this reservation');
    }
    return toReservationView(reservation);
  }

  async confirm(actor: User, id: string): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    if (order.ownerId !== actor.id) {
      throw AppError.forbidden('NOT_ORDER_OWNER', 'Only the order owner can accept');
    }
    if (reservation.status !== 'PENDING_OWNER') {
      throw new AppError('ALREADY_DECIDED', 409, `Reservation is ${reservation.status}`);
    }
    const now = this.clock.now();
    if (reservation.expiresAt.getTime() <= now.getTime()) {
      await this.expireOne(reservation, order, this.currentDecisionTtl(await this.settings.get()));
      throw new AppError('RESERVATION_NOT_ACTIVE', 409, 'Reservation expired');
    }

    const next = nextReservationStatus(reservation.status, 'CONFIRM', 'OWNER');
    const confirmed = await this.repos.reservations.transition(id, reservation.status, next, {
      decidedAt: now,
    });
    if (!confirmed) throw AppError.conflict('CONFLICT', 'Reservation changed while accepting');
    // G-09: the match is the moment the code is born — the buyer gets it in the notification.
    const updated = await this.issueDeliveryCode(confirmed);

    const orderNext = nextOrderStatus(order.status, 'CONFIRM', 'OWNER');
    const updatedOrder = await this.repos.orders.transition(order.id, order.status, orderNext);
    if (!updatedOrder) throw AppError.conflict('CONFLICT', 'Order changed while accepting');

    // G-10: answering resets the silence streak. Failure here must never fail the trade.
    await this.ownerResponse.recordAnswer(order.ownerId);
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'reservation.confirmed',
      entity: 'reservation',
      entityId: id,
      metadata: { orderId: order.id },
    });
    await this.notify(
      reservation.takerId,
      'RESERVATION_CONFIRMED',
      { litres: order.litres },
      { orderId: order.id, reservationId: id },
    );
    return toReservationView(updated);
  }

  async reject(actor: User, id: string): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    if (order.ownerId !== actor.id) {
      throw AppError.forbidden('NOT_ORDER_OWNER', 'Only the order owner can reject');
    }
    const next = nextReservationStatus(reservation.status, 'REJECT', 'OWNER');
    const updated = await this.repos.reservations.transition(id, reservation.status, next, {
      decidedAt: this.clock.now(),
    });
    if (!updated) throw AppError.conflict('CONFLICT', 'Reservation changed while rejecting');
    await this.repos.orders.transition(order.id, 'RESERVED', 'OPEN');
    // A «no» is still an answer — only silence counts against the seller (G-10).
    await this.ownerResponse.recordAnswer(order.ownerId);
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'reservation.rejected',
      entity: 'reservation',
      entityId: id,
      metadata: {},
    });
    await this.notify(
      reservation.takerId,
      'RESERVATION_REJECTED',
      { litres: order.litres },
      { orderId: order.id, reservationId: id },
    );
    return toReservationView(updated);
  }

  async cancel(actor: User, id: string, reason: CancelReason): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    const isOwner = order.ownerId === actor.id;
    const isTaker = reservation.takerId === actor.id;
    if (!isOwner && !isTaker) throw AppError.forbidden('NOT_RESERVATION_PARTY', 'Not a party');

    const actorKind = isOwner ? 'OWNER' : 'TAKER';
    if (isOwner && reservation.status === 'PENDING_OWNER') {
      // Cancelling a pending request is the same domain event as rejecting it.
      return this.reject(actor, id);
    }
    const event = actorKind === 'OWNER' ? 'CANCEL_OWNER' : 'CANCEL_TAKER';
    const next = nextReservationStatus(reservation.status, event, actorKind);
    const updated = await this.repos.reservations.transition(id, reservation.status, next, {
      decidedAt: reservation.decidedAt ?? this.clock.now(),
      cancelReason: reason,
    });
    if (!updated) throw AppError.conflict('CONFLICT', 'Reservation changed while cancelling');
    await this.repos.orders.transition(order.id, order.status, 'OPEN');
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'reservation.cancelled',
      entity: 'reservation',
      entityId: id,
      metadata: { reason, by: actorKind },
    });
    await this.reputation.record({
      userId: actor.id,
      kind: isOwner ? 'OWNER_CANCELLED' : 'TAKER_CANCELLED',
      orderId: order.id,
      metadata: { reservationId: id, reason },
    });
    const peerId = isOwner ? reservation.takerId : order.ownerId;
    await this.notify(
      peerId,
      'RESERVATION_CANCELLED',
      {
        by: isOwner ? 'صاحب سفارش' : 'خریدار',
        litres: order.litres,
        reason: CANCEL_REASON_FA[reason],
      },
      { orderId: order.id, reservationId: id },
    );
    return toReservationView(updated);
  }

  /**
   * G-09 — mints the four-digit hand-over code.
   *
   * Random, but not from `Math.random`: the code is a small shared secret, so it comes from the
   * platform CSPRNG. A lead-zero code is fine (it is stored and compared as text).
   */
  private newDeliveryCode(): string {
    const bytes = randomBytes(4);
    const value = bytes.readUInt32BE(0) % 10 ** DELIVERY_CODE_LENGTH;
    return value.toString().padStart(DELIVERY_CODE_LENGTH, '0');
  }

  /** Idempotent: a reservation that already has a code keeps it (a re-accept cannot rotate it). */
  private async issueDeliveryCode(reservation: Reservation): Promise<Reservation> {
    if (reservation.deliveryCode) return reservation;
    const updated = await this.repos.reservations.updateDelivery(reservation.id, {
      deliveryCode: this.newDeliveryCode(),
      deliveryAttempts: 0,
      deliveryLockedUntil: null,
    });
    return updated ?? reservation;
  }

  /**
   * G-09 — the buyer's view of the code. Only the taker may read it: the seller is the one who has
   * to type it, so handing them the value would defeat the whole point.
   *
   * Reservations confirmed before this feature shipped have no code yet; one is minted on the first
   * read, which keeps old trades closeable without a backfill.
   */
  async deliveryCode(
    actor: User,
    id: string,
  ): Promise<{
    reservationId: string;
    orderId: string;
    code: string;
    expiresAt: string;
    attemptsRemaining: number;
    lockedUntil: string | null;
  }> {
    const { reservation, order } = await this.load(id);
    if (reservation.takerId !== actor.id) {
      throw AppError.forbidden(
        'DELIVERY_CODE_BUYER_ONLY',
        'Only the buyer can see the hand-over code',
      );
    }
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'COMPLETED') {
      throw new AppError('RESERVATION_NOT_ACTIVE', 409, 'The trade has not been matched yet', {
        status: reservation.status,
      });
    }
    const issued = await this.issueDeliveryCode(reservation);
    const now = this.clock.now();
    const locked = issued.deliveryLockedUntil;
    return {
      reservationId: issued.id,
      orderId: order.id,
      code: issued.deliveryCode ?? '',
      expiresAt: issued.expiresAt.toISOString(),
      attemptsRemaining: Math.max(
        0,
        DELIVERY_CODE_ATTEMPTS - (locked && locked.getTime() > now.getTime() ? 0 : issued.deliveryAttempts),
      ),
      lockedUntil: locked && locked.getTime() > now.getTime() ? locked.toISOString() : null,
    };
  }

  /**
   * G-09 — checks one typed code. A wrong code only bumps the counter (the reservation does not
   * move); the third wrong code arms the ten-minute lock. Every rejection is audited, because a
   * stream of failures on one trade is exactly what a fraud investigation needs to see.
   */
  private async verifyDeliveryCode(
    reservation: Reservation,
    actor: User,
    code: string | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    const locked = reservation.deliveryLockedUntil;
    if (locked && locked.getTime() > now.getTime()) {
      throw new AppError(
        'DELIVERY_CODE_LOCKED',
        429,
        'Too many wrong codes — try again later',
        { lockedUntil: locked.toISOString() },
      );
    }
    if (!code) {
      throw new AppError('DELIVERY_CODE_REQUIRED', 422, 'The hand-over code is required', {
        attemptsRemaining: DELIVERY_CODE_ATTEMPTS - reservation.deliveryAttempts,
      });
    }
    const expected = reservation.deliveryCode ?? (await this.issueDeliveryCode(reservation)).deliveryCode;
    if (code === expected) {
      if (reservation.deliveryAttempts > 0 || locked) {
        await this.repos.reservations.updateDelivery(reservation.id, {
          deliveryAttempts: 0,
          deliveryLockedUntil: null,
        });
      }
      return;
    }

    const attempts = reservation.deliveryAttempts + 1;
    const limitReached = attempts >= DELIVERY_CODE_ATTEMPTS;
    const lockedUntil = limitReached ? new Date(now.getTime() + DELIVERY_CODE_LOCK_MS) : null;
    await this.repos.reservations.updateDelivery(reservation.id, {
      deliveryAttempts: attempts,
      deliveryLockedUntil: lockedUntil,
    });
    await this.repos.audit.append({
      actorId: actor.id,
      action: limitReached ? 'delivery.code_locked' : 'delivery.code_rejected',
      entity: 'reservation',
      entityId: reservation.id,
      metadata: { attempts, lockedUntil: lockedUntil?.toISOString() ?? null },
    });
    throw new AppError(
      limitReached ? 'DELIVERY_CODE_LOCKED' : 'DELIVERY_CODE_INVALID',
      limitReached ? 429 : 422,
      limitReached ? 'Too many wrong codes — try again later' : 'Wrong hand-over code',
      {
        attemptsRemaining: Math.max(0, DELIVERY_CODE_ATTEMPTS - attempts),
        ...(lockedUntil ? { lockedUntil: lockedUntil.toISOString() } : {}),
      },
    );
  }

  async complete(actor: User, id: string, code?: string): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    if (reservation.takerId !== actor.id && order.ownerId !== actor.id) {
      throw AppError.forbidden('NOT_RESERVATION_PARTY', 'Not a party');
    }
    const actorKind = reservation.takerId === actor.id ? 'TAKER' : 'OWNER';
    // G-09: the seller closes the trade *with the buyer's code*. The buyer closing it themselves
    // needs no code — they are the one holding it.
    if (actorKind === 'OWNER' && reservation.status === 'CONFIRMED') {
      await this.verifyDeliveryCode(reservation, actor, code);
    }
    const next = nextReservationStatus(reservation.status, 'COMPLETE', actorKind);
    const now = this.clock.now();
    const updated = await this.repos.reservations.transition(id, reservation.status, next, {
      completedAt: now,
    });
    if (!updated) throw AppError.conflict('CONFLICT', 'Reservation changed while completing');
    await this.repos.orders.transition(order.id, 'CONFIRMED', 'COMPLETED');
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'reservation.completed',
      entity: 'reservation',
      entityId: id,
      metadata: { by: actorKind, codeVerified: actorKind === 'OWNER' },
    });
    for (const userId of [order.ownerId, reservation.takerId]) {
      await this.reputation.record({
        userId,
        kind: 'TRADE_COMPLETED',
        orderId: order.id,
        metadata: { reservationId: id },
      });
    }
    await this.notify(
      actorKind === 'TAKER' ? order.ownerId : reservation.takerId,
      'TRADE_COMPLETED',
      { litres: order.litres, rateToman: order.rateToman },
      { orderId: order.id, reservationId: id },
    );
    return toReservationView(updated);
  }

  /**
   * E4-05: phone numbers are a two-sided secret. They are released only after the owner
   * accepted the request, and only to the two parties — every release is audited.
   */
  async revealContact(
    actor: User,
    id: string,
  ): Promise<{
    reservationId: string;
    orderId: string;
    revealedAt: string;
    owner: { id: string; phone: string };
    taker: { id: string; phone: string };
  }> {
    const { reservation, order } = await this.load(id);
    const isOwner = order.ownerId === actor.id;
    const isTaker = reservation.takerId === actor.id;
    if (!isOwner && !isTaker) {
      throw AppError.forbidden('NOT_RESERVATION_PARTY', 'Not a party to this reservation');
    }
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'COMPLETED') {
      throw new AppError('CONFLICT', 409, 'Contact details stay hidden until the owner accepts', {
        status: reservation.status,
      });
    }
    const owner = await this.repos.users.findById(order.ownerId);
    const taker = await this.repos.users.findById(reservation.takerId);
    if (!owner || !taker) throw AppError.notFound('NOT_FOUND', 'Party disappeared');

    await this.repos.audit.append({
      actorId: actor.id,
      action: 'contact.revealed',
      entity: 'reservation',
      entityId: id,
      metadata: { orderId: order.id, by: isOwner ? 'OWNER' : 'TAKER' },
    });

    return {
      reservationId: id,
      orderId: order.id,
      revealedAt: this.clock.now().toISOString(),
      owner: { id: owner.id, phone: owner.phone },
      taker: { id: taker.id, phone: taker.phone },
    };
  }

  /**
   * E4-04: an unfinished trade can be escalated. The state machine owns the legal
   * transitions (`CONFIRMED → DISPUTED` on both the reservation and its order), so a
   * dispute can never skip the acceptance step.
   */
  async dispute(actor: User, id: string, reason: string | null): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    const isOwner = order.ownerId === actor.id;
    const isTaker = reservation.takerId === actor.id;
    const isStaff = actor.role !== 'USER';
    if (!isOwner && !isTaker && !isStaff) {
      throw AppError.forbidden('NOT_RESERVATION_PARTY', 'Not a party to this reservation');
    }
    const actorKind = isOwner ? 'OWNER' : isTaker ? 'TAKER' : 'ADMIN';
    const next = nextReservationStatus(reservation.status, 'DISPUTE', actorKind);
    const orderNext = nextOrderStatus(order.status, 'DISPUTE', actorKind);

    const updated = await this.repos.reservations.transition(id, reservation.status, next, {
      decidedAt: reservation.decidedAt ?? this.clock.now(),
      cancelReason: null,
    });
    if (!updated) throw AppError.conflict('CONFLICT', 'Reservation changed while disputing');
    const updatedOrder = await this.repos.orders.transition(order.id, order.status, orderNext);
    if (!updatedOrder) throw AppError.conflict('CONFLICT', 'Order changed while disputing');

    await this.repos.audit.append({
      actorId: actor.id,
      action: 'reservation.disputed',
      entity: 'reservation',
      entityId: id,
      metadata: { orderId: order.id, by: actorKind, reason },
    });
    for (const userId of [order.ownerId, reservation.takerId]) {
      await this.reputation.record({
        userId,
        kind: 'DISPUTE_OPENED',
        orderId: order.id,
        metadata: { reservationId: id, by: actorKind },
      });
    }
    const recipients =
      actorKind === 'ADMIN'
        ? [order.ownerId, reservation.takerId]
        : [actorKind === 'OWNER' ? reservation.takerId : order.ownerId];
    for (const recipient of recipients) {
      await this.notify(
        recipient,
        'DISPUTE_OPENED',
        { litres: order.litres },
        { orderId: order.id, reservationId: id, reason },
      );
    }
    return toReservationView(updated);
  }

  /**
   * G-04: the taker may move the deadline exactly once, by `reservation.extend_minutes`.
   * The compare-and-set on `expiresAt` makes a double tap cheap to reason about: the second call
   * loses the race and gets a 409 instead of a second extension.
   */
  async extend(actor: User, id: string): Promise<ReservationView> {
    const { reservation, order } = await this.load(id);
    if (reservation.takerId !== actor.id) {
      throw AppError.forbidden('NOT_RESERVATION_TAKER', 'Only the buyer can extend a reservation');
    }
    if (reservation.status !== 'PENDING_OWNER') {
      throw new AppError('ALREADY_DECIDED', 409, `Reservation is ${reservation.status}`);
    }
    const config = await this.settings.get();
    const now = this.clock.now();
    if (reservation.expiresAt.getTime() <= now.getTime()) {
      await this.expireOne(reservation, order, config['reservation.ttl_minutes']);
      throw new AppError('RESERVATION_NOT_ACTIVE', 409, 'Reservation expired');
    }
    if (reservation.extensionCount >= config['reservation.max_extensions']) {
      throw new AppError('EXTENSION_LIMIT_REACHED', 409, 'The reservation was already extended', {
        maxExtensions: config['reservation.max_extensions'],
      });
    }

    const minutes = config['reservation.extend_minutes'];
    const newExpiry = new Date(reservation.expiresAt.getTime() + minutes * 60_000);
    const updated = await this.repos.reservations.extend(id, reservation.expiresAt, newExpiry);
    if (!updated) throw AppError.conflict('CONFLICT', 'Reservation changed while extending');

    await this.repos.audit.append({
      actorId: actor.id,
      action: 'reservation.extended',
      entity: 'reservation',
      entityId: id,
      metadata: { orderId: order.id, minutes, expiresAt: newExpiry.toISOString() },
    });
    await this.notify(
      order.ownerId,
      'RESERVATION_EXTENDED',
      { litres: order.litres, minutes },
      { orderId: order.id, reservationId: id, expiresAt: newExpiry.toISOString() },
    );
    return toReservationView(updated);
  }

  /**
   * G-04: when a buyer comes back after their reservation was released, the app offers to book the
   * same order again instead of leaving them on a dead screen. Only the newest release within a day
   * whose order is still open qualifies.
   */
  async rebookHint(
    user: User,
  ): Promise<{
    orderId: string;
    reservationId: string;
    litres: number;
    releasedAt: string;
  } | null> {
    const since = this.clock.now().getTime() - 24 * 3_600_000;
    const recent = await this.repos.reservations.listByTaker(user.id, 10);
    for (const reservation of recent) {
      if (reservation.createdAt.getTime() < since) break;
      if (reservation.status !== 'EXPIRED') continue;
      const order = await this.repos.orders.findById(reservation.orderId);
      if (!order || order.status !== 'OPEN') continue;
      if (order.ownerId === user.id) continue;
      return {
        orderId: order.id,
        reservationId: reservation.id,
        litres: order.litres,
        releasedAt: reservation.expiresAt.toISOString(),
      };
    }
    return null;
  }

  async listMine(user: User, limit = 20): Promise<ReservationView[]> {
    const reservations = await this.repos.reservations.listByTaker(user.id, limit);
    return reservations.map(toReservationView);
  }

  private async expireOne(reservation: Reservation, order: Order, minutes: number): Promise<void> {
    const expired = await this.repos.reservations.transition(
      reservation.id,
      'PENDING_OWNER',
      'EXPIRED',
    );
    if (!expired) return;
    await this.repos.orders.transition(order.id, 'RESERVED', 'OPEN');
    // G-10: the request died unanswered. Three in a row pause the seller's listings for a day.
    await this.ownerResponse.recordMiss(order.ownerId);
    await this.notify(
      reservation.takerId,
      'RESERVATION_EXPIRED',
      { litres: order.litres, minutes },
      { orderId: order.id, reservationId: reservation.id },
    );
  }

  /**
   * E4-02/E4-04: confirmed trades that nobody closed auto-complete after
   * `trade.auto_complete_hours`, so a forgotten order cannot sit in limbo forever.
   */
  async autoCompleteDueTrades(limit = 200): Promise<number> {
    const config = await this.settings.get();
    const now = this.clock.now();
    const windowMs = config['trade.auto_complete_hours'] * 3_600_000;
    const candidates = await this.repos.reservations.listAll(limit);
    let count = 0;
    for (const reservation of candidates) {
      if (reservation.status !== 'CONFIRMED' || !reservation.decidedAt) continue;
      if (reservation.decidedAt.getTime() + windowMs > now.getTime()) continue;
      const completed = await this.repos.reservations.transition(
        reservation.id,
        'CONFIRMED',
        'AUTO_COMPLETED',
        { completedAt: now },
      );
      if (!completed) continue;
      await this.repos.orders.transition(reservation.orderId, 'CONFIRMED', 'COMPLETED');
      await this.repos.audit.append({
        actorId: null,
        action: 'reservation.auto_completed',
        entity: 'reservation',
        entityId: reservation.id,
        metadata: { orderId: reservation.orderId, hours: config['trade.auto_complete_hours'] },
      });
      const order = await this.repos.orders.findById(reservation.orderId);
      const litres = order?.litres ?? 0;
      for (const userId of [order?.ownerId, reservation.takerId]) {
        if (!userId) continue;
        await this.reputation.record({
          userId,
          kind: 'TRADE_AUTO_COMPLETED',
          orderId: reservation.orderId,
          metadata: { reservationId: reservation.id },
        });
        await this.notify(
          userId,
          'TRADE_AUTO_COMPLETED',
          { litres, hours: config['trade.auto_complete_hours'] },
          { orderId: reservation.orderId, reservationId: reservation.id },
        );
      }
      count += 1;
    }
    return count;
  }

  /** Releases orders whose owner-decision window elapsed. Called by the scheduler. */
  async expireDueReservations(limit = 200): Promise<number> {
    const due = await this.repos.reservations.listExpiredPending(this.clock.now(), limit);
    const minutes = this.currentDecisionTtl(await this.settings.get());
    let count = 0;
    for (const reservation of due) {
      const order = await this.repos.orders.findById(reservation.orderId);
      if (!order) continue;
      await this.expireOne(reservation, order, minutes);
      count += 1;
    }
    return count;
  }

  /** The window that actually runs out is the reservation window (G-04), not the owner nudge. */
  private currentDecisionTtl(config: Settings): number {
    return config['reservation.ttl_minutes'];
  }
}
