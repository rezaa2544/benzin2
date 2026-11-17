import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError, type CreateInfraResourceInput, type UpdateInfraResourceInput } from '@benzin/shared';
import type { Clock, InfraKind, InfraResource, User } from '../domain/entities.js';
import type { Repositories } from '../ports.js';
import type { SettingsService } from './settings-service.js';

/**
 * G-13 — the infrastructure screen.
 *
 * Two different things live here on purpose, because during an incident they are the same
 * question: *is the platform healthy right now* (checks with a colour and a timestamp) and *what is
 * it made of* (the inventory the owner maintains: database, cache, SMS account, gateway, and the
 * addresses they live at).
 *
 * The checks are deliberately conservative: a memory-mode server, a scheduler that has not ticked,
 * a disabled SMS setting or a missing gateway all come back as WARN rather than pretending to be
 * green. A dashboard that is always green is worse than none.
 */

export type InfraStatus = 'OK' | 'WARN' | 'DOWN';

export interface InfraCheck {
  key: string;
  labelFa: string;
  status: InfraStatus;
  detailFa: string;
  /** When this check was evaluated — the panel shows it next to the colour. */
  checkedAt: string;
}

export interface InfraResourceView {
  id: string;
  name: string;
  kind: InfraKind;
  address: string;
  /** The panel learns *that* a credential exists, never the credential itself. */
  secretSet: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface InfraOverview {
  version: string;
  mode: 'postgres' | 'memory';
  nodeEnv: string;
  uptimeSeconds: number;
  serverTime: string;
  /** The newest migration file this build knows about; `applied` stays null without a DB probe. */
  migrations: { latest: string | null; count: number; detailFa: string };
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  counts: { users: number; openOrders: number; ordersToday: number; tradesToday: number };
  checks: InfraCheck[];
  resources: InfraResourceView[];
}

export interface InfraServiceOptions {
  version: string;
  mode: 'postgres' | 'memory';
  nodeEnv: string;
  /** How often the scheduler is expected to tick; the freshness check compares against it. */
  tickIntervalMs?: number;
  /** Last sweep, if the scheduler has run at least once. */
  lastTick?: () => { at: Date; result: unknown } | null;
  /** The public gateway is configured (merchant id present, callback set). */
  gatewayConfigured: boolean;
  startedAt?: number;
}

/**
 * Where the migration files live, from wherever this module happens to be running: the TypeScript
 * source (`src/modules`), the compiled output (`dist/modules`) or a bundled runtime. The first
 * candidate that exists wins; if none does, the board says so instead of inventing a version.
 */
const MIGRATIONS_DIR = (() => {
  const candidates = ['../../../../infra/migrations', '../../../infra/migrations'];
  for (const candidate of candidates) {
    try {
      const path = fileURLToPath(new URL(candidate, import.meta.url));
      if (existsSync(path)) return path;
    } catch {
      // Try the next layout.
    }
  }
  return null;
})();

export class InfraService {
  private readonly startedAt: number;

  constructor(
    private readonly repos: Pick<
      Repositories,
      'infraResources' | 'settings' | 'providerSettings' | 'zones' | 'users' | 'orders' | 'reservations' | 'audit'
    >,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly options: InfraServiceOptions,
  ) {
    this.startedAt = options.startedAt ?? Date.now();
  }

  private get tickIntervalMs(): number {
    return this.options.tickIntervalMs ?? 60_000;
  }

  /** Tehran midnight, because «امروز» on this dashboard means the owner's day, not UTC's. */
  private todayStart(): Date {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.clock.now());
    return new Date(Date.parse(`${date}T00:00:00+03:30`));
  }

  private migrationStatus(): InfraOverview['migrations'] {
    if (!MIGRATIONS_DIR) {
      return { latest: null, count: 0, detailFa: 'پوشهٔ مهاجرت در این بسته نیست' };
    }
    try {
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort();
      const latest = files.length > 0 ? (files[files.length - 1] ?? '').replace(/\.sql$/, '') : null;
      return {
        latest,
        count: files.length,
        detailFa: latest ? `${files.length} مهاجرت، آخرین: ${latest}` : 'هیچ مهاجرتی نیست',
      };
    } catch {
      return { latest: null, count: 0, detailFa: 'نسخهٔ مهاجرت خوانده نشد' };
    }
  }

  private diskStatus(): InfraOverview['disk'] {
    try {
      const stats = statfsSync(process.cwd());
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedPercent =
        totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
      return { totalBytes, freeBytes, usedPercent };
    } catch {
      return null;
    }
  }

  private async checks(now: Date): Promise<InfraCheck[]> {
    const config = await this.settings.get();
    const providers = await this.repos.providerSettings.list();
    const zones = await this.repos.zones.listAll();
    const activeProviders = providers.filter((provider) => provider.isActive);
    const smsProvider = activeProviders.find((provider) => provider.kind === 'SMS');
    const gatewayProvider = activeProviders.find(
      (provider) => provider.kind === 'PAYMENT',
    );
    const checkedAt = now.toISOString();

    const last = this.options.lastTick?.() ?? null;
    const ageMs = last ? now.getTime() - last.at.getTime() : null;
    const scheduler: InfraCheck = (() => {
      if (ageMs === null) {
        return {
          key: 'scheduler',
          labelFa: 'زمان‌بند',
          status: 'WARN',
          detailFa: 'هنوز اجرا نشده (در اولین دقیقه پس از راه‌اندازی طبیعی است)',
          checkedAt,
        };
      }
      const status: InfraStatus =
        ageMs <= this.tickIntervalMs * 2
          ? 'OK'
          : ageMs <= this.tickIntervalMs * 10
            ? 'WARN'
            : 'DOWN';
      const seconds = Math.round(ageMs / 1000);
      return {
        key: 'scheduler',
        labelFa: 'زمان‌بند',
        status,
        detailFa: `آخرین اجرا ${seconds} ثانیه پیش`,
        checkedAt,
      };
    })();

    return [
      {
        key: 'api',
        labelFa: 'API',
        status: 'OK',
        detailFa: `بالا · ${Math.round((now.getTime() - this.startedAt) / 1000)} ثانیه از راه‌اندازی`,
        checkedAt,
      },
      {
        key: 'database',
        labelFa: 'داده',
        status: this.options.mode === 'postgres' ? 'OK' : 'WARN',
        detailFa:
          this.options.mode === 'postgres'
            ? 'PostgreSQL متصل'
            : 'حافظهٔ موقت — با هر ری‌استارت پاک می‌شود',
        checkedAt,
      },
      scheduler,
      {
        key: 'sms',
        labelFa: 'پنل پیامک',
        status: config['notification.sms_enabled'] && smsProvider ? 'OK' : 'WARN',
        detailFa: !config['notification.sms_enabled']
          ? 'پیامک در تنظیمات خاموش است'
          : smsProvider
            ? `فعال از طریق ${smsProvider.provider}`
            : 'ارائه‌دهندهٔ پیامک فعالی ثبت نشده',
        checkedAt,
      },
      {
        key: 'gateway',
        labelFa: 'درگاه پرداخت',
        status: this.options.gatewayConfigured ? 'OK' : 'WARN',
        detailFa: this.options.gatewayConfigured
          ? `تنظیم شده${gatewayProvider ? ` · ${gatewayProvider.provider}` : ''}`
          : 'مرچنت یا آدرس بازگشت تنظیم نشده',
        checkedAt,
      },
      {
        key: 'zones',
        labelFa: 'شهرها',
        status: zones.length > 0 ? 'OK' : 'WARN',
        detailFa: zones.length > 0 ? `${zones.length} شهر تعریف شده` : 'هیچ شهری تعریف نشده',
        checkedAt,
      },
    ];
  }

  async overview(): Promise<InfraOverview> {
    const now = this.clock.now();
    const since = this.todayStart();
    const [checks, resources, userCounts, orderCounts, ordersToday, tradesToday] =
      await Promise.all([
        this.checks(now),
        this.repos.infraResources.list(),
        this.repos.users.countByStatus(),
        this.repos.orders.countByStatus(),
        this.repos.orders.countCreatedSince(since),
        this.repos.reservations.countCreatedSince(since),
      ]);

    return {
      version: this.options.version,
      mode: this.options.mode,
      nodeEnv: this.options.nodeEnv,
      uptimeSeconds: Math.round((now.getTime() - this.startedAt) / 1000),
      serverTime: now.toISOString(),
      migrations: this.migrationStatus(),
      disk: this.diskStatus(),
      counts: {
        users: userCounts.ACTIVE + userCounts.SUSPENDED + userCounts.BANNED,
        openOrders: orderCounts.OPEN + orderCounts.RESERVED,
        ordersToday,
        tradesToday,
      },
      checks,
      resources: resources.map((resource) => this.toView(resource)),
    };
  }

  // ------------------------------------------------------------------ CRUD

  private toView(resource: InfraResource): InfraResourceView {
    return {
      id: resource.id,
      name: resource.name,
      kind: resource.kind,
      address: resource.address,
      secretSet: Boolean(resource.secret && resource.secret.length > 0),
      isActive: resource.isActive,
      createdAt: resource.createdAt.toISOString(),
      updatedAt: resource.updatedAt.toISOString(),
      updatedBy: resource.updatedBy,
    };
  }

  async create(actor: User, input: CreateInfraResourceInput): Promise<InfraResourceView> {
    const clash = await this.repos.infraResources.findByName(input.name);
    if (clash) {
      throw new AppError('INFRA_NAME_TAKEN', 409, 'زیرساختی با این نام از قبل ثبت شده است');
    }
    const created = await this.repos.infraResources.create(
      {
        name: input.name,
        kind: input.kind,
        address: input.address,
        secret: input.secret ?? null,
        isActive: input.isActive,
        updatedBy: actor.id,
      },
      this.clock.now(),
    );
    await this.audit(actor, 'infra.created', created);
    return this.toView(created);
  }

  async update(actor: User, id: string, input: UpdateInfraResourceInput): Promise<InfraResourceView> {
    const existing = await this.repos.infraResources.findById(id);
    if (!existing) throw new AppError('INFRA_NOT_FOUND', 404, 'زیرساخت پیدا نشد');
    if (input.name && input.name !== existing.name) {
      const clash = await this.repos.infraResources.findByName(input.name);
      if (clash) {
        throw new AppError('INFRA_NAME_TAKEN', 409, 'زیرساختی با این نام از قبل ثبت شده است');
      }
    }
    const updated = await this.repos.infraResources.update(
      id,
      // An omitted secret keeps the stored one: the panel shows «تنظیم شده» and never the value,
      // so a form save must not silently wipe a credential it was never given.
      { ...input, secret: input.secret === undefined ? undefined : input.secret, updatedBy: actor.id },
      this.clock.now(),
    );
    if (!updated) throw new AppError('INFRA_NOT_FOUND', 404, 'زیرساخت پیدا نشد');
    await this.audit(actor, 'infra.updated', updated);
    return this.toView(updated);
  }

  async remove(actor: User, id: string): Promise<{ removed: true }> {
    const existing = await this.repos.infraResources.findById(id);
    if (!existing) throw new AppError('INFRA_NOT_FOUND', 404, 'زیرساخت پیدا نشد');
    await this.repos.infraResources.remove(id);
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'infra.deleted',
      entity: 'infra_resource',
      entityId: id,
      metadata: { name: existing.name, kind: existing.kind },
    });
    return { removed: true };
  }

  private async audit(actor: User, action: string, resource: InfraResource): Promise<void> {
    await this.repos.audit.append({
      actorId: actor.id,
      action,
      entity: 'infra_resource',
      entityId: resource.id,
      metadata: {
        name: resource.name,
        kind: resource.kind,
        isActive: resource.isActive,
        // Never the secret, only whether one is stored.
        secretSet: Boolean(resource.secret),
      },
    });
  }
}
