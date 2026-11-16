import { randomUUID } from 'node:crypto';
import type { UserRole, UserStatus } from '@benzin/shared';
import type {
  AuditEntry,
  DeviceRecord,
  ProviderSetting,
  RefreshTokenRecord,
  SettingsRecord,
  User,
} from '../../../domain/entities.js';
import type {
  AuditQuery,
  AuditRepository,
  DeviceInput,
  DeviceRepository,
  NewRefreshToken,
  NewUser,
  OtpChallenge,
  OtpRepository,
  ProviderSettingsRepository,
  RefreshTokenRepository,
  SettingsRepository,
  UserRepository,
  UserSearchQuery,
} from '../../../ports.js';
import { Conditions, query, queryOne, scalar, type Db } from './pg-common.js';

const USER_COLUMNS = `id, phone, display_name, role, status, suspended_until, created_at,
  response_answered, response_received, response_rate_permille, response_refreshed_at,
  unanswered_streak, delisted_until`;

type UserRow = {
  id: string;
  phone: string;
  display_name: string | null;
  role: UserRole;
  status: UserStatus;
  suspended_until: Date | null;
  created_at: Date;
  response_answered: number;
  response_received: number;
  response_rate_permille: number | null;
  response_refreshed_at: Date | null;
  unanswered_streak: number;
  delisted_until: Date | null;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  phone: row.phone,
  displayName: row.display_name,
  role: row.role,
  status: row.status,
  suspendedUntil: row.suspended_until,
  createdAt: row.created_at,
  responseAnswered: Number(row.response_answered ?? 0),
  responseReceived: Number(row.response_received ?? 0),
  responseRatePermille: row.response_rate_permille === null ? null : Number(row.response_rate_permille),
  responseRefreshedAt: row.response_refreshed_at,
  unansweredStreak: Number(row.unanswered_streak ?? 0),
  delistedUntil: row.delisted_until,
});

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<User | null> {
    const row = await queryOne<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return row ? toUser(row) : null;
  }

  async findByIds(ids: readonly string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    return rows.map(toUser);
  }

  /** G-10: owners paused out of the market right now. */
  async listDelisted(now: Date, limit: number): Promise<User[]> {
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users
        WHERE deleted_at IS NULL AND delisted_until IS NOT NULL AND delisted_until > $1
        ORDER BY delisted_until LIMIT $2`,
      [now, limit],
    );
    return rows.map(toUser);
  }

  async listDelistDue(now: Date, limit: number): Promise<User[]> {
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users
        WHERE deleted_at IS NULL AND delisted_until IS NOT NULL AND delisted_until <= $1
        ORDER BY delisted_until LIMIT $2`,
      [now, limit],
    );
    return rows.map(toUser);
  }

  async listResponseStale(before: Date, limit: number): Promise<User[]> {
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users
        WHERE deleted_at IS NULL
          AND (response_refreshed_at IS NULL OR response_refreshed_at <= $1)
        ORDER BY response_refreshed_at NULLS FIRST LIMIT $2`,
      [before, limit],
    );
    return rows.map(toUser);
  }

  async listSuspendedDue(now: Date, limit: number): Promise<User[]> {
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users
        WHERE status = 'SUSPENDED' AND suspended_until IS NOT NULL AND suspended_until <= $1
        ORDER BY suspended_until LIMIT $2`,
      [now, limit],
    );
    return rows.map(toUser);
  }

  async findByPhone(phone: string): Promise<User | null> {
    const row = await queryOne<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users WHERE phone = $1 AND deleted_at IS NULL`,
      [phone],
    );
    return row ? toUser(row) : null;
  }

  async create(input: NewUser): Promise<User> {
    const row = await queryOne<UserRow>(
      this.db,
      `INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING ${USER_COLUMNS}`,
      [input.phone, input.role ?? 'USER'],
    );
    if (!row) throw new Error('user insert returned no row');
    return toUser(row);
  }

  async save(user: User): Promise<User> {
    const row = await queryOne<UserRow>(
      this.db,
      `UPDATE users SET display_name = $2, role = $3, status = $4, suspended_until = $5,
         response_answered = $6, response_received = $7, response_rate_permille = $8,
         response_refreshed_at = $9, unanswered_streak = $10, delisted_until = $11,
         updated_at = now()
        WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [
        user.id,
        user.displayName,
        user.role,
        user.status,
        user.suspendedUntil,
        user.responseAnswered,
        user.responseReceived,
        user.responseRatePermille,
        user.responseRefreshedAt,
        user.unansweredStreak,
        user.delistedUntil,
      ],
    );
    if (!row) throw new Error(`user ${user.id} not found`);
    return toUser(row);
  }

  async list(limit: number): Promise<User[]> {
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toUser);
  }

  async search(input: UserSearchQuery): Promise<{ items: User[]; total: number }> {
    const conditions = new Conditions();
    if (input.text) {
      conditions.add((p) => `(phone ILIKE ${p} OR display_name ILIKE ${p})`, `%${input.text}%`);
    }
    conditions.addIf(input.role !== null, (p) => `role = ${p}`, input.role);
    conditions.addIf(input.status !== null, (p) => `status = ${p}`, input.status);
    const where = `${conditions.sql}${conditions.sql ? ' AND ' : 'WHERE '}deleted_at IS NULL`;
    const limit = conditions.pagination(input.limit, input.offset);
    const rows = await query<UserRow>(
      this.db,
      `SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY created_at DESC ${limit}`,
      conditions.values,
    );
    const total = await scalar(
      this.db,
      `SELECT count(*)::int AS value FROM users ${where}`,
      conditions.values.slice(0, -2),
    );
    return { items: rows.map(toUser), total };
  }

  async countByStatus(): Promise<Record<UserStatus, number>> {
    const rows = await query<{ key: string; total: string }>(
      this.db,
      `SELECT status::text AS key, count(*)::int AS total FROM users WHERE deleted_at IS NULL GROUP BY status`,
    );
    const result: Record<UserStatus, number> = { ACTIVE: 0, SUSPENDED: 0, BANNED: 0 };
    for (const row of rows) result[row.key as UserStatus] = Number(row.total);
    return result;
  }
}

export class PgOtpRepository implements OtpRepository {
  constructor(private readonly db: Db) {}

  async findLatest(phone: string): Promise<OtpChallenge | null> {
    const row = await queryOne<{
      phone: string;
      code_hash: string;
      expires_at: Date;
      attempts: number;
      sent_at: Date;
      consumed_at: Date | null;
    }>(
      this.db,
      `SELECT phone, code_hash, expires_at, attempts, sent_at, consumed_at
         FROM otp_challenges WHERE phone = $1 ORDER BY sent_at DESC LIMIT 1`,
      [phone],
    );
    if (!row) return null;
    return {
      phone: row.phone,
      codeHash: row.code_hash,
      expiresAt: row.expires_at,
      attempts: Number(row.attempts),
      sentAt: row.sent_at,
      consumedAt: row.consumed_at,
    };
  }

  /**
   * The domain sends at most one live challenge per phone, so the newest row is reused instead of
   * inserting a row per attempt (matching the in-memory adapter, which the OTP flow was built on).
   */
  async save(challenge: OtpChallenge): Promise<void> {
    const updated = await queryOne<{ id: string }>(
      this.db,
      `UPDATE otp_challenges SET code_hash = $2, expires_at = $3, attempts = $4, sent_at = $5, consumed_at = $6
         WHERE id = (SELECT id FROM otp_challenges WHERE phone = $1 ORDER BY sent_at DESC LIMIT 1)
         RETURNING id`,
      [
        challenge.phone,
        challenge.codeHash,
        challenge.expiresAt,
        challenge.attempts,
        challenge.sentAt,
        challenge.consumedAt,
      ],
    );
    if (updated) return;
    await query(
      this.db,
      `INSERT INTO otp_challenges (phone, code_hash, expires_at, attempts, sent_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        challenge.phone,
        challenge.codeHash,
        challenge.expiresAt,
        challenge.attempts,
        challenge.sentAt,
        challenge.consumedAt,
      ],
    );
  }
}

type TokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  device_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  created_at: Date;
};

const TOKEN_COLUMNS = `id, user_id, token_hash, family_id, device_id, expires_at, revoked_at, replaced_by, created_at`;

const toToken = (row: TokenRow): RefreshTokenRecord => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  familyId: row.family_id,
  deviceId: row.device_id,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  replacedBy: row.replaced_by,
  createdAt: row.created_at,
});

export class PgRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewRefreshToken): Promise<RefreshTokenRecord> {
    const row = await queryOne<TokenRow>(
      this.db,
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, device_id, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${TOKEN_COLUMNS}`,
      [input.userId, input.tokenHash, input.familyId, input.deviceId, input.expiresAt],
    );
    if (!row) throw new Error('refresh token insert returned no row');
    return toToken(row);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await queryOne<TokenRow>(
      this.db,
      `SELECT ${TOKEN_COLUMNS} FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return row ? toToken(row) : null;
  }

  async revoke(id: string, replacedBy: string | null, at: Date): Promise<void> {
    await query(
      this.db,
      `UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3 WHERE id = $1 AND revoked_at IS NULL`,
      [id, at, replacedBy],
    );
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const rows = await query<{ id: string }>(
      this.db,
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL RETURNING id`,
      [familyId, at],
    );
    return rows.length;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const rows = await query<{ id: string }>(
      this.db,
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId, at],
    );
    return rows.length;
  }

  async countActive(userId: string): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId],
    );
  }
}

type DeviceRow = {
  id: string;
  user_id: string;
  device_id: string;
  platform: string;
  push_token: string | null;
  app_version: string | null;
  last_seen_at: Date;
  created_at: Date;
};

const DEVICE_COLUMNS = `id, user_id, device_id, platform, push_token, app_version, last_seen_at, created_at`;

const toDevice = (row: DeviceRow): DeviceRecord => ({
  id: row.id,
  userId: row.user_id,
  deviceId: row.device_id,
  platform: row.platform as DeviceRecord['platform'],
  pushToken: row.push_token,
  appVersion: row.app_version,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
});

export class PgDeviceRepository implements DeviceRepository {
  constructor(private readonly db: Db) {}

  async upsert(input: DeviceInput, at: Date): Promise<DeviceRecord> {
    const row = await queryOne<DeviceRow>(
      this.db,
      `INSERT INTO devices (user_id, device_id, platform, push_token, app_version, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, device_id) DO UPDATE
         SET platform = EXCLUDED.platform,
             push_token = COALESCE(EXCLUDED.push_token, devices.push_token),
             app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
             last_seen_at = EXCLUDED.last_seen_at
       RETURNING ${DEVICE_COLUMNS}`,
      [
        input.userId,
        input.deviceId,
        input.platform,
        input.pushToken ?? null,
        input.appVersion ?? null,
        at,
      ],
    );
    if (!row) throw new Error('device upsert returned no row');
    return toDevice(row);
  }

  async listByUser(userId: string): Promise<DeviceRecord[]> {
    const rows = await query<DeviceRow>(
      this.db,
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map(toDevice);
  }
}

export class PgSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Db) {}

  async findAll(): Promise<SettingsRecord[]> {
    const rows = await query<{
      key: string;
      value: unknown;
      updated_at: Date;
      updated_by: string | null;
    }>(this.db, `SELECT key, value, updated_at, updated_by FROM settings ORDER BY key`);
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  async set(key: string, value: unknown, updatedBy: string | null): Promise<SettingsRecord> {
    const row = await queryOne<{
      key: string;
      value: unknown;
      updated_at: Date;
      updated_by: string | null;
    }>(
      this.db,
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value, updated_at, updated_by`,
      [key, JSON.stringify(value ?? null), updatedBy],
    );
    if (!row) throw new Error(`setting ${key} upsert returned no row`);
    return { key: row.key, value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
}

type ProviderRow = {
  id: string;
  provider: string;
  kind: ProviderSetting['kind'];
  config: Record<string, unknown>;
  is_active: boolean;
  updated_by: string | null;
  updated_at: Date;
};

const toProvider = (row: ProviderRow): ProviderSetting => ({
  id: row.id,
  provider: row.provider,
  kind: row.kind,
  config: row.config,
  isActive: row.is_active,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

export class PgProviderSettingsRepository implements ProviderSettingsRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<ProviderSetting[]> {
    const rows = await query<ProviderRow>(
      this.db,
      `SELECT id, provider, kind, config, is_active, updated_by, updated_at FROM provider_settings ORDER BY kind, provider`,
    );
    return rows.map(toProvider);
  }

  async findBy(kind: ProviderSetting['kind'], provider: string): Promise<ProviderSetting | null> {
    const row = await queryOne<ProviderRow>(
      this.db,
      `SELECT id, provider, kind, config, is_active, updated_by, updated_at FROM provider_settings
        WHERE kind = $1 AND provider = $2`,
      [kind, provider],
    );
    return row ? toProvider(row) : null;
  }

  async upsert(
    input: Omit<ProviderSetting, 'id' | 'updatedAt'> & { id?: string },
    at: Date,
  ): Promise<ProviderSetting> {
    const row = await queryOne<ProviderRow>(
      this.db,
      `INSERT INTO provider_settings (id, provider, kind, config, is_active, updated_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (kind, provider) DO UPDATE
         SET config = EXCLUDED.config, is_active = EXCLUDED.is_active,
             updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       RETURNING id, provider, kind, config, is_active, updated_by, updated_at`,
      [
        input.id ?? randomUUID(),
        input.provider,
        input.kind,
        JSON.stringify(input.config ?? {}),
        input.isActive,
        input.updatedBy,
        at,
      ],
    );
    if (!row) throw new Error('provider setting upsert returned no row');
    return toProvider(row);
  }
}

type AuditRow = {
  id: string;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

const toAudit = (row: AuditRow): AuditEntry => ({
  id: row.id,
  actorId: row.actor_id,
  action: row.action,
  entity: row.entity,
  entityId: row.entity_id,
  metadata: row.metadata,
  createdAt: row.created_at,
});

const AUDIT_COLUMNS = `id, actor_id, action, entity, entity_id, metadata, created_at`;

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly db: Db) {}

  async append(entry: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry> {
    const row = await queryOne<AuditRow>(
      this.db,
      `INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${AUDIT_COLUMNS}`,
      [
        entry.actorId,
        entry.action,
        entry.entity,
        entry.entityId,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
    if (!row) throw new Error('audit append returned no row');
    return toAudit(row);
  }

  async list(limit: number): Promise<AuditEntry[]> {
    const rows = await query<AuditRow>(
      this.db,
      `SELECT ${AUDIT_COLUMNS} FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toAudit);
  }

  async query(input: AuditQuery): Promise<{ items: AuditEntry[]; total: number }> {
    const conditions = new Conditions();
    conditions.addIf(input.action !== null, (p) => `action = ${p}`, input.action);
    conditions.addIf(input.actorId !== null, (p) => `actor_id = ${p}`, input.actorId);
    conditions.addIf(input.entity !== null, (p) => `entity = ${p}`, input.entity);
    const limit = conditions.pagination(input.limit, input.offset);
    const rows = await query<AuditRow>(
      this.db,
      `SELECT ${AUDIT_COLUMNS} FROM audit_logs ${conditions.sql} ORDER BY created_at DESC ${limit}`,
      conditions.values,
    );
    const total = await scalar(
      this.db,
      `SELECT count(*)::int AS value FROM audit_logs ${conditions.sql}`,
      conditions.values.slice(0, -2),
    );
    return { items: rows.map(toAudit), total };
  }
}
