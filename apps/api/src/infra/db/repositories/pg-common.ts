import type { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Shared plumbing for the Postgres repositories (task G-01).
 *
 * Every repository talks plain SQL instead of going through the Drizzle query builder: the
 * migrations are hand-reviewed SQL anyway, and a handful of the queries below (SKIP LOCKED
 * sweeps, `ON CONFLICT DO NOTHING` on partial indexes, `ST_Distance` ordering) are clearer as
 * text. Drizzle keeps owning the schema (`infra/migrations`) and the zone repository.
 */

export type Db = Pool | PoolClient;

export async function query<T extends QueryResultRow>(
  db: Db,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, values as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  db: Db,
  text: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  const result = await db.query<T>(text, values as unknown[]);
  return result.rows[0] ?? null;
}

export async function scalar(
  db: Db,
  text: string,
  values: readonly unknown[] = [],
): Promise<number> {
  const result = await db.query<{ value: string | number | null }>(text, values as unknown[]);
  return Number(result.rows[0]?.value ?? 0);
}

/** Runs `fn` inside a transaction; any throw rolls the whole unit of work back. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** `numeric` columns arrive as strings on purpose — the domain wants numbers. */
export const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * Adds `AND ...` fragments while feeding the parameter list in order.
 * Keeps the dynamic searches (order search, admin listings) free of string concatenation.
 */
export class Conditions {
  readonly values: unknown[] = [];
  private readonly parts: string[] = [];

  add(fragment: (placeholder: string) => string, value: unknown): this {
    this.values.push(value);
    this.parts.push(fragment(`$${this.values.length}`));
    return this;
  }

  addIf(condition: boolean, fragment: (placeholder: string) => string, value: unknown): this {
    if (condition) this.add(fragment, value);
    return this;
  }

  get sql(): string {
    return this.parts.length === 0 ? '' : `WHERE ${this.parts.join(' AND ')}`;
  }

  /** `LIMIT $n OFFSET $n+1` as the trailing pair of the same parameter list. */
  pagination(limit: number, offset: number): string {
    this.values.push(limit, offset);
    return `LIMIT $${this.values.length - 1} OFFSET $${this.values.length}`;
  }
}

/** Fills a `Record<Status, number>` so dashboards never see `undefined` tiles. */
export function fillCounts<K extends string>(
  keys: readonly K[],
  rows: { key: string; total: string | number }[],
): Record<K, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const row of rows) {
    if ((keys as readonly string[]).includes(row.key)) result[row.key as K] = Number(row.total);
  }
  return result;
}
