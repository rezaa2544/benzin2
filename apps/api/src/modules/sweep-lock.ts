import type { Pool } from 'pg';

/**
 * Cross-instance guard for the background sweeps (task G-02).
 *
 * The expiry worker is safe to run twice because every action it takes is a compare-and-set, but
 * two API instances sweeping the same rows at the same second still burn the same work and race on
 * notifications. The database owns the answer: a session-level advisory lock means exactly one
 * process runs a tick at a time, and the losers skip this round instead of queueing up.
 *
 * Postgres also provides the row-level half of the guarantee through `FOR UPDATE SKIP LOCKED` in
 * the sweep queries themselves (orders, reservations, subscriptions, payments).
 */
export interface SweepLock {
  /**
   * Runs `fn` while holding `name`. Resolves `null` — without calling `fn` — when another process
   * holds the lock, which the scheduler treats as "nothing to do this tick".
   */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null>;
}

/** Single-process fallback (dev, tests, the desktop bundle). */
export function createProcessSweepLock(): SweepLock {
  const held = new Set<string>();
  return {
    async withLock(name, fn) {
      if (held.has(name)) return null;
      held.add(name);
      try {
        return await fn();
      } finally {
        held.delete(name);
      }
    },
  };
}

export interface AdvisoryLockOptions {
  /** Prefix so two products sharing one database never collide on the same advisory key. */
  namespace?: string;
  logger?: { warn: (message: string) => void };
}

/**
 * `pg_try_advisory_lock` on a dedicated connection. The lock is released in `finally`, and the
 * connection is always returned to the pool: a crashed tick can never leave the worker wedged.
 */
export function createPostgresSweepLock(pool: Pool, options: AdvisoryLockOptions = {}): SweepLock {
  const namespace = options.namespace ?? 'benzin2:sweep';
  return {
    async withLock(name, fn) {
      const client = await pool.connect();
      const key = `${namespace}:${name}`;
      try {
        const result = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
          [key],
        );
        if (!result.rows[0]?.locked) {
          options.logger?.warn(`sweep lock ${key} is held by another instance — skipping tick`);
          return null;
        }
        try {
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        }
      } finally {
        client.release();
      }
    },
  };
}
