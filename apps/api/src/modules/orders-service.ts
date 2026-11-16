import {
  AppError,
  TIER_RATE_TOMAN,
  toPersianDigits,
  type CreateOrderInput,
  type OrderSearchInput,
  type OrderStatus,
  type UpdateOrderInput,
} from '@benzin/shared';
import type { Clock, Order, User } from '../domain/entities.js';
import { publicLocation, type PublicLocation } from '../domain/geo.js';
import { buyerSavingToman, isAboveOfficialRate, orderTotalToman } from '../domain/pricing.js';
import type { NotificationEmitter, Repositories } from '../ports.js';
import { wireEstimate, type DistanceService, type RouteEstimateWire } from './distance-service.js';
import { DistanceService as Distance } from './distance-service.js';
import { LocationService } from './location-service.js';
import { KeyedLock } from './keyed-lock.js';
import { responseLabelFa } from './owner-response-service.js';
import type { SettingsService } from './settings-service.js';

export interface OrderView {
  id: string;
  ownerId: string;
  side: Order['side'];
  tier: Order['tier'];
  litres: number;
  rateToman: number;
  officialRateToman: number;
  totalToman: number;
  buyerSavingToman: number;
  status: OrderStatus;
  province: string | null;
  county: string | null;
  /** Per-litre pump fee the seller declared. Buyers pay it on top of `rateToman`. */
  pumpFeeToman: number;
  /** rateToman + pumpFeeToman — what one litre really costs the buyer. */
  buyerRateToman: number;
  /** litres × buyerRateToman. */
  buyerTotalToman: number;
  stationName: string | null;
  note: string | null;
  /** Never the exact point: snapped to the privacy grid (task E2-02). */
  location: PublicLocation | null;
  deliveryMethod: Order['deliveryMethod'];
  expiresAt: string;
  createdAt: string;
  /** Present only when the caller supplied an origin and the order has a point (G-07). */
  distance?: RouteEstimateWire;
  /**
   * G-10 — who is selling: the answer-rate badge the card shows. Never a score, never a penalty;
   * a seller with no history reads «تازه‌کار» and that is the whole story.
   */
  owner: {
    id: string;
    ratePercent: number | null;
    labelFa: string;
    answered: number;
    received: number;
  };
}

export function toOrderView(order: Order): OrderView {
  // The pump fee belongs to a sell listing: a buyer asking for litres never pays it.
  const pumpFeeToman = order.side === 'SELL' ? TIER_RATE_TOMAN[order.tier] : 0;
  return {
    id: order.id,
    ownerId: order.ownerId,
    side: order.side,
    tier: order.tier,
    litres: order.litres,
    rateToman: order.rateToman,
    officialRateToman: TIER_RATE_TOMAN[order.tier],
    totalToman: orderTotalToman(order.litres, order.rateToman),
    buyerSavingToman: buyerSavingToman(order.tier, order.litres, order.rateToman),
    status: order.status,
    province: order.province,
    county: order.county,
    pumpFeeToman,
    buyerRateToman: order.rateToman + pumpFeeToman,
    buyerTotalToman: orderTotalToman(order.litres, order.rateToman + pumpFeeToman),
    stationName: order.stationName,
    note: order.note,
    location: publicLocation(
      order.lat !== null && order.lng !== null ? { lat: order.lat, lng: order.lng } : null,
    ),
    deliveryMethod: order.deliveryMethod,
    expiresAt: order.expiresAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    // G-10: the real badge is filled in by `decorate`, which has the owner rows; this default keeps
    // `toOrderView` a pure function of the order for callers that do not need it.
    owner: {
      id: order.ownerId,
      ratePercent: null,
      labelFa: responseLabelFa(0, null),
      answered: 0,
      received: 0,
    },
  };
}

const encodeCursor = (offset: number): string => Buffer.from(String(offset)).toString('base64url');
const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,9}$/.test(decoded)) throw AppError.validation('Invalid cursor');
  return Number(decoded);
};

export class OrderService {
  /** Serialises the "how many open orders do I already have" check against the insert (E1-07). */
  private readonly ownerLock = new KeyedLock();

  constructor(
    private readonly repos: Pick<
      Repositories,
      'orders' | 'audit' | 'zones' | 'reservations' | 'subscriptions' | 'plans' | 'users'
    >,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly distance: DistanceService = new Distance(null),
    private readonly locations: LocationService = new LocationService(repos.zones),
    private readonly notifier: NotificationEmitter | null = null,
  ) {}

  async create(user: User, input: CreateOrderInput): Promise<OrderView> {
    const config = await this.settings.get();
    const now = this.clock.now();

    if (input.litres < config['order.min_litres'] || input.litres > config['order.max_litres']) {
      throw AppError.validation('Litres outside the allowed range', {
        min: config['order.min_litres'],
        max: config['order.max_litres'],
      });
    }
    if (isAboveOfficialRate(input.tier, input.rateToman)) {
      throw AppError.validation('Price cannot exceed the official rate for this tier', {
        officialRateToman: TIER_RATE_TOMAN[input.tier],
      });
    }
    // The zone is derived from the point, never trusted from the client (task E2-02).
    let zoneId = input.zoneId;
    if (input.location) {
      const resolved = await this.locations.requireZone(input.location);
      if (input.zoneId && input.zoneId !== resolved.id) {
        throw new AppError('ZONE_MISMATCH', 422, 'Location is outside the selected zone', {
          zoneId: input.zoneId,
          resolvedZoneId: resolved.id,
        });
      }
      zoneId = resolved.id;
    }
    const zone = await this.repos.zones.findById(zoneId);
    if (!zone || !zone.isActive) {
      throw new AppError('ZONE_NOT_SUPPORTED', 422, 'Zone is not served yet', { zoneId });
    }

    return this.ownerLock.run(`owner:${user.id}`, async () => {
      // E4-06: one trade cycle at a time — an active reservation blocks new listings.
      const activeTrades = await this.repos.reservations.findActiveByTaker(user.id);
      if (activeTrades.length > 0) {
        throw new AppError('TRADE_CYCLE_BLOCKED', 409, 'Finish your active trade first', {
          reservationId: activeTrades[0]!.id,
        });
      }

      // Plans widen the open-order allowance; the paid gate itself is off by default (A23).
      const subscription = await this.repos.subscriptions.findActiveByUser(user.id, now);
      if (!subscription && config['subscription.required_for_orders']) {
        throw new AppError('SUBSCRIPTION_REQUIRED', 403, 'An active subscription is required');
      }
      const plan = subscription ? await this.repos.plans.findById(subscription.planId) : null;
      const openLimit = Math.max(config['order.max_open_per_user'], plan?.maxActiveOrders ?? 0);
      const openOrders = await this.repos.orders.countOpenByOwner(user.id, now);
      if (openOrders >= openLimit) {
        throw new AppError('ORDER_LIMIT_REACHED', 429, 'Too many open orders', {
          limit: openLimit,
        });
      }

      const order = await this.repos.orders.create({
        ownerId: user.id,
        side: input.side,
        tier: input.tier,
        litres: input.litres,
        rateToman: input.rateToman,
        zoneId,
        province: input.province ?? null,
        county: input.county ?? null,
        stationName: input.stationName ?? null,
        note: input.note ?? null,
        lat: input.location?.lat ?? null,
        lng: input.location?.lng ?? null,
        deliveryMethod: input.deliveryMethod,
        expiresAt: new Date(now.getTime() + config['order.default_expiry_hours'] * 3_600_000),
      });

      await this.repos.audit.append({
        actorId: user.id,
        action: 'order.created',
        entity: 'order',
        entityId: order.id,
        metadata: {
          side: order.side,
          tier: order.tier,
          litres: order.litres,
          rateToman: order.rateToman,
          province: order.province,
          county: order.county,
        },
      });
      return toOrderView(order);
    });
  }

  async search(query: OrderSearchInput): Promise<{
    items: OrderView[];
    nextCursor: string | null;
    /** G-05: when an exact lot has no listing, the closest lots inside +-10% come back here. */
    nearest: { litres: number; items: OrderView[] } | null;
    message: string | null;
  }> {
    const offset = decodeCursor(query.cursor);
    const origin =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : null;
    const exact = query.litresMode === 'exact' ? (query.litres ?? null) : null;
    const between =
      query.litresMode === 'range' &&
      (query.minLitres !== undefined || query.maxLitres !== undefined)
        ? { min: query.minLitres ?? 1, max: query.maxLitres ?? 1000 }
        : null;
    // G-10: the market hides owners taking their 24-hour break. The list is tiny by design.
    const paused = await this.repos.users.listDelisted(this.clock.now(), 500);
    const { items, total } = await this.repos.orders.search({
      province: query.province ?? null,
      county: query.county ?? null,
      zoneId: query.zoneId ?? null,
      side: query.side,
      tier: query.tier ?? null,
      now: this.clock.now(),
      excludeOwnerIds: paused.map((user) => user.id),
      responseSince: new Date(this.clock.now().getTime() - 30 * 24 * 3_600_000),
      limit: query.limit,
      offset,
      sort: query.sort,
      origin,
      radiusKm: query.radiusKm ?? null,
      litresExact: exact,
      litresBetween: between,
    });
    const nextOffset = offset + items.length;

    if (exact !== null && total === 0) {
      const margin = exact * 0.1;
      const near = await this.repos.orders.search({
        province: query.province ?? null,
        county: query.county ?? null,
        zoneId: query.zoneId ?? null,
        side: query.side,
        tier: query.tier ?? null,
        now: this.clock.now(),
        // The suggestion list is short on purpose: it answers "what is close to 40 litres?".
        limit: 5,
        offset: 0,
        sort: 'price',
        origin: null,
        radiusKm: null,
        litresExact: null,
        litresBetween: { min: Math.max(1, exact - margin), max: exact + margin },
        excludeOwnerIds: paused.map((user) => user.id),
      });
      return {
        items: [],
        nextCursor: null,
        nearest: near.items.length
          ? { litres: exact, items: await this.decorate(near.items, origin) }
          : null,
        message: near.items.length
          ? `${toPersianDigits(exact)} لیتر موجود نیست؛ نزدیک‌ترین لات‌ها را ببین.`
          : `${toPersianDigits(exact)} لیتر موجود نیست و لات نزدیکی هم ثبت نشده است.`,
      };
    }

    return {
      items: await this.decorate(items, origin),
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      nearest: null,
      message: null,
    };
  }

  /**
   * G-07: every listing answers with distance and ETA once the caller sent a point. The
   * exact stored coordinates are used for the maths here and never leave the process — the
   * response carries the snapped `location` from `toOrderView` and nothing else.
   */
  private async decorate(
    orders: readonly Order[],
    origin: { lat: number; lng: number } | null,
  ): Promise<OrderView[]> {
    // G-10: one lookup for the whole page — the badge must never cost a query per card.
    const owners = await this.repos.users.findByIds(orders.map((order) => order.ownerId));
    const byId = new Map(owners.map((owner) => [owner.id, owner]));
    return Promise.all(
      orders.map(async (order) => {
        const owner = byId.get(order.ownerId) ?? null;
        const ratePercent =
          owner === null || owner.responseReceived === 0
            ? null
            : Math.round((owner.responseAnswered * 1000) / owner.responseReceived) / 10;
        const view: OrderView = {
          ...toOrderView(order),
          owner: {
            id: order.ownerId,
            ratePercent,
            labelFa: responseLabelFa(owner?.responseReceived ?? 0, ratePercent),
            answered: owner?.responseAnswered ?? 0,
            received: owner?.responseReceived ?? 0,
          },
        };
        if (!origin || order.lat === null || order.lng === null) return view;
        return {
          ...view,
          distance: wireEstimate(
            await this.distance.estimate(origin, { lat: order.lat, lng: order.lng }),
          ),
        };
      }),
    );
  }

  async getById(
    id: string,
    origin: { lat: number; lng: number } | null = null,
  ): Promise<OrderView> {
    const order = await this.repos.orders.findById(id);
    if (!order) throw AppError.notFound('ORDER_NOT_AVAILABLE', 'Order not found');
    const [view] = await this.decorate([order], origin);
    return view!;
  }

  async listMine(user: User, limit = 20): Promise<OrderView[]> {
    const orders = await this.repos.orders.listByOwner(user.id, limit);
    return orders.map(toOrderView);
  }

  async cancel(user: User, id: string): Promise<OrderView> {
    const order = await this.repos.orders.findById(id);
    if (!order) throw AppError.notFound('ORDER_NOT_AVAILABLE', 'Order not found');
    if (order.ownerId !== user.id)
      throw AppError.forbidden('NOT_ORDER_OWNER', 'Only the owner can cancel');
    if (order.status !== 'OPEN' && order.status !== 'RESERVED') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        409,
        `Cannot cancel an order that is ${order.status}`,
      );
    }
    const updated = await this.repos.orders.transition(id, order.status, 'CANCELLED');
    if (!updated) throw AppError.conflict('CONFLICT', 'Order changed while cancelling');
    await this.repos.audit.append({
      actorId: user.id,
      action: 'order.cancelled',
      entity: 'order',
      entityId: id,
      metadata: { from: order.status },
    });
    return toOrderView(updated);
  }

  /**
   * Edits an open order in place. Status never changes here, so the state machine stays
   * untouched; a reserved order must be cancelled first (task E3-04).
   */
  async update(user: User, id: string, input: UpdateOrderInput): Promise<OrderView> {
    const order = await this.repos.orders.findById(id);
    if (!order) throw AppError.notFound('ORDER_NOT_AVAILABLE', 'Order not found');
    if (order.ownerId !== user.id) {
      throw AppError.forbidden('NOT_ORDER_OWNER', 'Only the owner can edit an order');
    }
    if (order.status !== 'OPEN') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        409,
        `Cannot edit an order that is ${order.status}`,
      );
    }
    const config = await this.settings.get();
    const litres = input.litres ?? order.litres;
    const rateToman = input.rateToman ?? order.rateToman;
    if (litres < config['order.min_litres'] || litres > config['order.max_litres']) {
      throw AppError.validation('Litres outside the allowed range', {
        min: config['order.min_litres'],
        max: config['order.max_litres'],
      });
    }
    if (isAboveOfficialRate(order.tier, rateToman)) {
      throw AppError.validation('Price cannot exceed the official rate for this tier', {
        officialRateToman: TIER_RATE_TOMAN[order.tier],
      });
    }
    const updated = await this.repos.orders.update(
      id,
      {
        litres,
        rateToman,
        ...(input.stationName !== undefined ? { stationName: input.stationName } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      this.clock.now(),
    );
    if (!updated) throw AppError.notFound('ORDER_NOT_AVAILABLE', 'Order not found');
    await this.repos.audit.append({
      actorId: user.id,
      action: 'order.updated',
      entity: 'order',
      entityId: id,
      metadata: { litres, rateToman },
    });
    return toOrderView(updated);
  }

  /** Marks open orders past their expiry. Invoked by the scheduler every minute. */
  async expireDueOrders(limit = 200): Promise<number> {
    const now = this.clock.now();
    const due = await this.repos.orders.listExpired(now, limit);
    let expired = 0;
    for (const order of due) {
      const updated = await this.repos.orders.transition(order.id, 'OPEN', 'EXPIRED');
      if (!updated) continue;
      expired += 1;
      // The owner must hear that their listing left the market (task E5-03).
      await this.notifier?.emit({
        userId: order.ownerId,
        kind: 'ORDER_EXPIRED',
        params: { litres: order.litres },
        payload: { orderId: order.id },
      });
    }
    return expired;
  }
}
