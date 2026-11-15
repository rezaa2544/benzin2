import type { OrderSide, OrderStatus, ReservationStatus, Tier } from '@benzin/shared';
import { ACTIVE_RESERVATION_STATUSES, TIER_RATE_TOMAN } from '@benzin/shared';
import type { Order, Reservation } from '../../../domain/entities.js';
import type {
  NewOrder,
  NewReservation,
  OrderRepository,
  OrderSearchQuery,
  ReservationRepository,
} from '../../../ports.js';
import { Conditions, num, query, queryOne, scalar, type Db } from './pg-common.js';

/**
 * Orders and reservations on Postgres (task G-01), with the two database guarantees the rest of
 * the platform leans on:
 *
 *  * `reservations_one_active_per_order` (partial unique index) — `createExclusive` turns a
 *    concurrent second reservation into `ON CONFLICT DO NOTHING`, so two buyers can never hold the
 *    same lot (task G-03).
 *  * `orders_location_gist` + `ST_Distance` — the search sorts and filters by real distance
 *    instead of a straight-line estimate in the API process (task G-06).
 *
 * The sweeps (expired orders, stale reservations) select with `FOR UPDATE SKIP LOCKED` so two
 * scheduler ticks can never fight over the same row (task G-02).
 */

type OrderRow = {
  id: string;
  owner_id: string;
  side: OrderSide;
  tier: Tier;
  litres: string | number;
  rate_toman: number;
  zone_id: string;
  province: string | null;
  county: string | null;
  station_name: string | null;
  note: string | null;
  delivery_method: 'FUEL_CARD';
  status: OrderStatus;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  lat: number | null;
  lng: number | null;
};

const ORDER_FIELDS = `o.id, o.owner_id, o.side, o.tier, o.litres, o.rate_toman, o.zone_id, o.province,
         o.county, o.station_name, o.note, o.delivery_method, o.status, o.expires_at, o.created_at, o.updated_at,
         ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng`;

const ORDER_SELECT = `SELECT ${ORDER_FIELDS} FROM orders o`;

const toOrder = (row: OrderRow): Order => ({
  id: row.id,
  ownerId: row.owner_id,
  side: row.side,
  tier: row.tier,
  litres: num(row.litres),
  rateToman: Number(row.rate_toman),
  zoneId: row.zone_id,
  province: row.province,
  county: row.county,
  stationName: row.station_name,
  note: row.note,
  lat: row.lat === null ? null : Number(row.lat),
  lng: row.lng === null ? null : Number(row.lng),
  deliveryMethod: row.delivery_method,
  status: row.status,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const ORDER_STATUSES: readonly OrderStatus[] = [
  'OPEN',
  'RESERVED',
  'CONFIRMED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'AWAITING_OWNER_DECISION',
  'DISPUTED',
];

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewOrder): Promise<Order> {
    const row = await queryOne<OrderRow>(
      this.db,
      `WITH inserted AS (
         INSERT INTO orders (owner_id, side, tier, litres, rate_toman, zone_id, province, county,
                             station_name, note, delivery_method, expires_at, location)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 CASE WHEN $13::float8 IS NULL OR $14::float8 IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_MakePoint($14::float8, $13::float8), 4326)::geography END)
         RETURNING *)
       SELECT i.id, i.owner_id, i.side, i.tier, i.litres, i.rate_toman, i.zone_id, i.province, i.county,
              i.station_name, i.note, i.delivery_method, i.status, i.expires_at, i.created_at, i.updated_at,
              ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng
         FROM inserted i`,
      [
        input.ownerId,
        input.side,
        input.tier,
        input.litres,
        input.rateToman,
        input.zoneId,
        input.province,
        input.county,
        input.stationName,
        input.note,
        input.deliveryMethod,
        input.expiresAt,
        input.lat,
        input.lng,
      ],
    );
    if (!row) throw new Error('order insert returned no row');
    return toOrder(row);
  }

  async findById(id: string): Promise<Order | null> {
    const row = await queryOne<OrderRow>(this.db, `${ORDER_SELECT} WHERE o.id = $1`, [id]);
    return row ? toOrder(row) : null;
  }

  async search(input: OrderSearchQuery): Promise<{ items: Order[]; total: number }> {
    const values: unknown[] = [];
    const parts: string[] = [`o.status = 'OPEN'`];
    const param = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    parts.push(`o.expires_at > ${param(input.now)}`);
    parts.push(`o.side = ${param(input.side)}`);
    if (input.zoneId !== null) parts.push(`o.zone_id = ${param(input.zoneId)}`);
    if (input.province !== null) parts.push(`o.province = ${param(input.province)}`);
    if (input.county !== null) parts.push(`o.county = ${param(input.county)}`);
    if (input.tier !== null) parts.push(`o.tier = ${param(input.tier)}`);
    if (input.litresExact !== null) parts.push(`o.litres = ${param(input.litresExact)}`);
    if (input.litresBetween !== null) {
      parts.push(`o.litres >= ${param(input.litresBetween.min)}`);
      parts.push(`o.litres <= ${param(input.litresBetween.max)}`);
    }

    // One distance expression per query, computed by the database from the GiST-indexed point.
    // A radius filter belongs to the WHERE clause (so the count query sees it too), while a plain
    // "sort by distance" only needs the expression in the select list — hence the two branches.
    let distance = 'NULL::double precision';
    if (input.origin && input.radiusKm !== null) {
      const lng = param(input.origin.lng);
      const lat = param(input.origin.lat);
      distance = `ST_Distance(o.location, ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography)`;
      parts.push(`${distance} <= ${param(input.radiusKm * 1000)}::double precision`);
    }
    const whereCount = values.length;
    const whereValues = values.slice(0, whereCount);
    const where = `WHERE ${parts.join(' AND ')}`;

    if (input.origin && input.radiusKm === null) {
      const lng = param(input.origin.lng);
      const lat = param(input.origin.lat);
      distance = `ST_Distance(o.location, ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography)`;
    }
    const limit = param(input.limit);
    const offset = param(input.offset);

    const rows = await query<OrderRow>(
      this.db,
      `SELECT ${ORDER_FIELDS}, ${distance} AS distance_m FROM orders o ${where} ORDER BY ${this.orderBy(
        input.sort,
      )} LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    const total = await scalar(
      this.db,
      `SELECT count(*)::int AS value FROM orders o ${where}`,
      whereValues,
    );
    return { items: rows.map(toOrder), total };
  }

  private orderBy(sort: OrderSearchQuery['sort']): string {
    // "price" is the all-in price of one litre (rate + pump fee), which is what a buyer compares.
    if (sort === 'price') return `${PRICE_PER_LITRE_SQL} ASC, o.created_at DESC`;
    if (sort === 'newest') return 'o.created_at DESC';
    return 'distance_m ASC NULLS LAST, o.created_at DESC';
  }

  async listByOwner(ownerId: string, limit: number): Promise<Order[]> {
    const rows = await query<OrderRow>(
      this.db,
      `${ORDER_SELECT} WHERE o.owner_id = $1 ORDER BY o.created_at DESC LIMIT $2`,
      [ownerId, limit],
    );
    return rows.map(toOrder);
  }

  async countOpenByOwner(ownerId: string, now: Date): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM orders
        WHERE owner_id = $1 AND status IN ('OPEN', 'RESERVED') AND expires_at > $2`,
      [ownerId, now],
    );
  }

  async transition(
    id: string,
    expected: OrderStatus,
    next: OrderStatus,
    patch?: Partial<Pick<Order, 'updatedAt'>>,
  ): Promise<Order | null> {
    const row = await queryOne<OrderRow>(
      this.db,
      `WITH updated AS (
         UPDATE orders SET status = $3, updated_at = $4 WHERE id = $1 AND status = $2 RETURNING *
       )
       SELECT u.id, u.owner_id, u.side, u.tier, u.litres, u.rate_toman, u.zone_id, u.province, u.county,
              u.station_name, u.note, u.delivery_method, u.status, u.expires_at, u.created_at, u.updated_at,
              ST_Y(u.location::geometry) AS lat, ST_X(u.location::geometry) AS lng
         FROM updated u`,
      [id, expected, next, patch?.updatedAt ?? new Date()],
    );
    return row ? toOrder(row) : null;
  }

  async listExpired(now: Date, limit: number): Promise<Order[]> {
    // SKIP LOCKED keeps two overlapping sweeps from blocking each other; the transition that
    // follows is a compare-and-set, so a row is still expired exactly once (task G-02).
    const rows = await query<OrderRow>(
      this.db,
      `SELECT * FROM (
         SELECT o.id, o.owner_id, o.side, o.tier, o.litres, o.rate_toman, o.zone_id, o.province, o.county,
                o.station_name, o.note, o.delivery_method, o.status, o.expires_at, o.created_at, o.updated_at,
                ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng
           FROM orders o
          WHERE o.status = 'OPEN' AND o.expires_at <= $1
          ORDER BY o.expires_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) due`,
      [now, limit],
    );
    return rows.map(toOrder);
  }

  async update(
    id: string,
    patch: Partial<Pick<Order, 'litres' | 'rateToman' | 'stationName' | 'note'>>,
    at: Date,
  ): Promise<Order | null> {
    const sets: string[] = ['updated_at = $2'];
    const values: unknown[] = [id, at];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.litres !== undefined) push('litres', patch.litres);
    if (patch.rateToman !== undefined) push('rate_toman', patch.rateToman);
    if (patch.stationName !== undefined) push('station_name', patch.stationName);
    if (patch.note !== undefined) push('note', patch.note);
    const row = await queryOne<OrderRow>(
      this.db,
      `WITH updated AS (UPDATE orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *)
       SELECT u.id, u.owner_id, u.side, u.tier, u.litres, u.rate_toman, u.zone_id, u.province, u.county,
              u.station_name, u.note, u.delivery_method, u.status, u.expires_at, u.created_at, u.updated_at,
              ST_Y(u.location::geometry) AS lat, ST_X(u.location::geometry) AS lng
         FROM updated u`,
      values,
    );
    return row ? toOrder(row) : null;
  }

  async listSince(zoneId: string, since: Date, limit: number): Promise<Order[]> {
    const rows = await query<OrderRow>(
      this.db,
      `${ORDER_SELECT} WHERE o.zone_id = $1 AND o.created_at >= $2 ORDER BY o.created_at DESC LIMIT $3`,
      [zoneId, since, limit],
    );
    return rows.map(toOrder);
  }

  async listByPlace(input: {
    province: string | null;
    county: string | null;
    since: Date;
    limit: number;
  }): Promise<Order[]> {
    // A county is only meaningful together with its province, matching the cascade in the UI.
    const county = input.province === null ? null : input.county;
    const rows = await query<OrderRow>(
      this.db,
      `${ORDER_SELECT}
        WHERE o.created_at >= $1
          AND ($2::text IS NULL OR o.province = $2)
          AND ($3::text IS NULL OR o.county = $3)
        ORDER BY o.created_at DESC LIMIT $4`,
      [input.since, input.province, county, input.limit],
    );
    return rows.map(toOrder);
  }

  async listAll(input: {
    status: OrderStatus | null;
    zoneId: string | null;
    side: OrderSide | null;
    text: string | null;
    limit: number;
    offset: number;
  }): Promise<{ items: Order[]; total: number }> {
    const conditions = new Conditions();
    conditions.addIf(input.status !== null, (p) => `o.status = ${p}`, input.status);
    conditions.addIf(input.zoneId !== null, (p) => `o.zone_id = ${p}`, input.zoneId);
    conditions.addIf(input.side !== null, (p) => `o.side = ${p}`, input.side);
    if (input.text) {
      conditions.add(
        (p) =>
          `(o.station_name ILIKE ${p} OR o.note ILIKE ${p} OR o.county ILIKE ${p} OR o.province ILIKE ${p})`,
        `%${input.text}%`,
      );
    }
    const where = conditions.sql;
    const limit = conditions.pagination(input.limit, input.offset);
    const rows = await query<OrderRow>(
      this.db,
      `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC ${limit}`,
      conditions.values,
    );
    const total = await scalar(
      this.db,
      `SELECT count(*)::int AS value FROM orders o ${where}`,
      conditions.values.slice(0, -2),
    );
    return { items: rows.map(toOrder), total };
  }

  async countByStatus(): Promise<Record<OrderStatus, number>> {
    const rows = await query<{ key: string; total: string }>(
      this.db,
      `SELECT status::text AS key, count(*)::int AS total FROM orders GROUP BY status`,
    );
    const result = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<
      OrderStatus,
      number
    >;
    for (const row of rows) result[row.key as OrderStatus] = Number(row.total);
    return result;
  }
}

type ReservationRow = {
  id: string;
  order_id: string;
  taker_id: string;
  status: ReservationStatus;
  cancel_reason: string | null;
  expires_at: Date;
  decided_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  extension_count: number;
};

/**
 * All-in price of one litre, mirroring `toOrderView`: a sell listing carries its tier's pump fee,
 * a buy request does not (G-05 sorts on this).
 */
const PRICE_PER_LITRE_SQL = `(o.rate_toman + CASE WHEN o.side = 'SELL' THEN (CASE o.tier::text ${Object.entries(
  TIER_RATE_TOMAN,
)
  .map(([tier, fee]) => `WHEN '${tier}' THEN ${fee}`)
  .join(' ')} ELSE 0 END) ELSE 0 END))`;

const RESERVATION_COLUMNS = `id, order_id, taker_id, status, cancel_reason, expires_at, decided_at, completed_at, created_at, extension_count`;

const toReservation = (row: ReservationRow): Reservation => ({
  id: row.id,
  orderId: row.order_id,
  takerId: row.taker_id,
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  decidedAt: row.decided_at,
  completedAt: row.completed_at,
  cancelReason: row.cancel_reason,
  extensionCount: row.extension_count ?? 0,
});

export class PgReservationRepository implements ReservationRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<Reservation | null> {
    const row = await queryOne<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = $1`,
      [id],
    );
    return row ? toReservation(row) : null;
  }

  async findActiveByOrder(orderId: string): Promise<Reservation | null> {
    const row = await queryOne<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM reservations
        WHERE order_id = $1 AND status = ANY($2::reservation_status[])
        ORDER BY created_at DESC LIMIT 1`,
      [orderId, [...ACTIVE_RESERVATION_STATUSES]],
    );
    return row ? toReservation(row) : null;
  }

  async findActiveByTaker(takerId: string): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM reservations
        WHERE taker_id = $1 AND status = ANY($2::reservation_status[]) ORDER BY created_at DESC`,
      [takerId, [...ACTIVE_RESERVATION_STATUSES]],
    );
    return rows.map(toReservation);
  }

  async countActiveByTaker(takerId: string): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM reservations WHERE taker_id = $1 AND status = ANY($2::reservation_status[])`,
      [takerId, [...ACTIVE_RESERVATION_STATUSES]],
    );
  }

  async listByTaker(takerId: string, limit: number): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE taker_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [takerId, limit],
    );
    return rows.map(toReservation);
  }

  /**
   * The concurrency answer for the whole marketplace: the partial unique index
   * `reservations_one_active_per_order` decides the winner, the loser gets `null` here instead of
   * a 500 (task G-03).
   */
  async createExclusive(input: NewReservation): Promise<Reservation | null> {
    const row = await queryOne<ReservationRow>(
      this.db,
      `INSERT INTO reservations (id, order_id, taker_id, status, expires_at)
       VALUES ($1, $2, $3, 'PENDING_OWNER', $4)
       ON CONFLICT DO NOTHING
       RETURNING ${RESERVATION_COLUMNS}`,
      [input.id, input.orderId, input.takerId, input.expiresAt],
    );
    return row ? toReservation(row) : null;
  }

  async transition(
    id: string,
    expected: ReservationStatus,
    next: ReservationStatus,
    patch?: Partial<Pick<Reservation, 'decidedAt' | 'completedAt' | 'cancelReason'>>,
  ): Promise<Reservation | null> {
    const row = await queryOne<ReservationRow>(
      this.db,
      `UPDATE reservations
          SET status = $3,
              decided_at = COALESCE($4, decided_at),
              completed_at = COALESCE($5, completed_at),
              cancel_reason = COALESCE($6, cancel_reason)
        WHERE id = $1 AND status = $2
        RETURNING ${RESERVATION_COLUMNS}`,
      [
        id,
        expected,
        next,
        patch?.decidedAt ?? null,
        patch?.completedAt ?? null,
        patch?.cancelReason ?? null,
      ],
    );
    return row ? toReservation(row) : null;
  }

  /** G-04: one deadline push per reservation, guarded by the value the caller read. */
  async extend(
    id: string,
    expectedExpiresAt: Date,
    newExpiresAt: Date,
  ): Promise<Reservation | null> {
    const row = await queryOne<ReservationRow>(
      this.db,
      `UPDATE reservations
          SET expires_at = $3, extension_count = extension_count + 1
        WHERE id = $1 AND status = 'PENDING_OWNER' AND expires_at = $2
        RETURNING ${RESERVATION_COLUMNS}`,
      [id, expectedExpiresAt, newExpiresAt],
    );
    return row ? toReservation(row) : null;
  }

  async listExpiredPending(now: Date, limit: number): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      this.db,
      `SELECT * FROM (
         SELECT ${RESERVATION_COLUMNS} FROM reservations
          WHERE status = 'PENDING_OWNER' AND expires_at <= $1
          ORDER BY expires_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) due`,
      [now, limit],
    );
    return rows.map(toReservation);
  }

  async listByOrder(orderId: string, limit: number): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE order_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [orderId, limit],
    );
    return rows.map(toReservation);
  }

  async listAll(limit: number): Promise<Reservation[]> {
    const rows = await query<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM reservations ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toReservation);
  }

  async countActive(): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM reservations WHERE status = ANY($1::reservation_status[])`,
      [[...ACTIVE_RESERVATION_STATUSES]],
    );
  }
}
