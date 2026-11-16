import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Repositories } from '../../../ports.js';
import * as schema from '../schema.js';
import {
  PgAuditRepository,
  PgDeviceRepository,
  PgOtpRepository,
  PgProviderSettingsRepository,
  PgRefreshTokenRepository,
  PgSettingsRepository,
  PgUserRepository,
} from './pg-identity.js';
import { PgOrderRepository, PgReservationRepository } from './pg-orders.js';
import {
  PgCardDepositRepository,
  PgPaymentCardRepository,
  PgPaymentRepository,
  PgPlanRepository,
  PgSubscriptionRepository,
} from './pg-billing.js';
import {
  PgConversationRepository,
  PgMessageRepository,
  PgNotificationRepository,
  PgReputationRepository,
} from './pg-social.js';
import { PgZoneRepository } from './zones.js';
import { PgNodeRepository } from './pg-nodes.js';

/**
 * The Postgres adapter (task G-01): one `Pool` per process, one repository per port.
 *
 * This is the switch that makes the platform production-ready — until now `DATABASE_URL` only
 * *selected* Postgres for the migration CLI while the API refused to boot without it and then ran
 * on the in-memory adapter. Now the same repositories the services were tested against are backed
 * by the tables in `infra/migrations`.
 */

export interface PostgresHandle {
  pool: Pool;
  repositories: Repositories;
  close(): Promise<void>;
}

export function createPostgresRepositories(databaseUrl: string): PostgresHandle {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // A stuck query must fail the request, not hold a connection for ever.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000),
    idle_in_transaction_session_timeout: 15_000,
  });
  const db = drizzle(pool, { schema });

  const repositories: Repositories = {
    users: new PgUserRepository(pool),
    conversations: new PgConversationRepository(pool),
    reputation: new PgReputationRepository(pool),
    plans: new PgPlanRepository(pool),
    subscriptions: new PgSubscriptionRepository(pool),
    payments: new PgPaymentRepository(pool),
    paymentCards: new PgPaymentCardRepository(pool),
    cardDeposits: new PgCardDepositRepository(pool),
    providerSettings: new PgProviderSettingsRepository(pool),
    messages: new PgMessageRepository(pool),
    notifications: new PgNotificationRepository(pool),
    otps: new PgOtpRepository(pool),
    refreshTokens: new PgRefreshTokenRepository(pool),
    devices: new PgDeviceRepository(pool),
    orders: new PgOrderRepository(pool),
    reservations: new PgReservationRepository(pool),
    settings: new PgSettingsRepository(pool),
    zones: new PgZoneRepository(db),
    audit: new PgAuditRepository(pool),
    nodes: new PgNodeRepository(pool),
  };

  return {
    pool,
    repositories,
    close: async () => {
      await pool.end();
    },
  };
}

export type { PostgresHandle as PostgresAdapter };
