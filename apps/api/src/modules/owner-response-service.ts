import type { Clock, User } from '../domain/entities.js';
import type { NotificationEmitter, Repositories } from '../ports.js';

/** G-10 acceptance: the rate is a 30-day window. */
export const RESPONSE_WINDOW_DAYS = 30;
/** G-10 acceptance: three unanswered requests in a row pause the listings. */
export const RESPONSE_MISS_LIMIT = 3;
/** G-10 acceptance: the pause lasts 24 hours and lifts itself. */
export const RESPONSE_PAUSE_HOURS = 24;

/** What the app shows on a seller: a badge, not a score. */
export interface ResponseView {
  ownerId: string;
  /** 0..100, or null while the seller never received a request. */
  ratePercent: number | null;
  answered: number;
  received: number;
  /** Persian copy for the badge, built here so the web layer never invents numbers. */
  labelFa: string;
  unansweredStreak: number;
  /** ISO timestamp while the listings are paused, otherwise null. */
  delistedUntil: string | null;
}

/** Shared by the service, the listing badge and the admin row: 0..100 with one decimal. */
export const ratePercentOf = (user: {
  responseAnswered: number;
  responseReceived: number;
}): number | null =>
  user.responseReceived === 0
    ? null
    : Math.round((user.responseAnswered * 1000) / user.responseReceived) / 10;

const toPercent = (answered: number, received: number): number | null =>
  received === 0 ? null : Math.round((answered * 1000) / received) / 10;

/** «۹۲٪ پاسخ‌دهی» / «تازه‌کار» — the wording the listing card uses (G-10). */
export const responseLabelFa = (received: number, ratePercent: number | null): string => {
  if (ratePercent === null) return 'تازه‌کار';
  // A seller with one answered request out of one is not «۱۰۰٪ پاسخ‌دهی» in a useful sense; the
  // label stays honest about the sample size for the first few requests.
  if (received < 3) return 'کم‌سابقه';
  return `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(ratePercent)}٪ پاسخ‌دهی`;
};

const toResponseView = (user: User): ResponseView => {
  const ratePercent = toPercent(user.responseAnswered, user.responseReceived);
  return {
    ownerId: user.id,
    ratePercent,
    answered: user.responseAnswered,
    received: user.responseReceived,
    labelFa: responseLabelFa(user.responseReceived, ratePercent),
    unansweredStreak: user.unansweredStreak,
    delistedUntil:
      user.delistedUntil && user.delistedUntil.getTime() > 0
        ? user.delistedUntil.toISOString()
        : null,
  };
};

/**
 * G-10 — the seller's answer rate.
 *
 * Design rule from the acceptance criteria: **no negative score.** Nothing in here touches the
 * reputation ledger; the only consequence of silence is that the seller's own listings take a
 * 24-hour break from the market, and even that lifts by itself.
 *
 * The counters are a projection of the reservations (one query per owner), refreshed when the
 * owner answers, when a request of theirs dies, and by a daily scheduler sweep so a window that
 * simply ages out does not stay stale.
 */
export class OwnerResponseService {
  constructor(
    private readonly repos: Pick<Repositories, 'users' | 'reservations' | 'audit'>,
    private readonly clock: Clock,
    private readonly notifier: NotificationEmitter,
  ) {}

  /** Recomputes the 30-day window for one owner and stores it on the account. */
  async refresh(userId: string): Promise<ResponseView | null> {
    const user = await this.repos.users.findById(userId);
    if (!user) return null;
    const since = new Date(this.clock.now().getTime() - RESPONSE_WINDOW_DAYS * 24 * 3_600_000);
    const { received, answered } = await this.repos.reservations.countForOwnerWindow(userId, since);
    user.responseReceived = received;
    user.responseAnswered = answered;
    user.responseRatePermille = received === 0 ? null : Math.round((answered * 1000) / received);
    user.responseRefreshedAt = this.clock.now();
    const saved = await this.repos.users.save(user);
    return toResponseView(saved);
  }

  /** Called when the owner accepted or rejected a request — the streak resets. */
  async recordAnswer(ownerId: string): Promise<ResponseView | null> {
    const user = await this.repos.users.findById(ownerId);
    if (!user) return null;
    if (user.unansweredStreak !== 0) {
      user.unansweredStreak = 0;
      await this.repos.users.save(user);
    }
    return this.refresh(ownerId);
  }

  /**
   * Called when a request died without the owner answering. Three in a row pause the listings
   * for a day; the pause is recorded in the audit log so support can see it and undo it.
   */
  async recordMiss(ownerId: string): Promise<{ view: ResponseView | null; paused: boolean }> {
    const user = await this.repos.users.findById(ownerId);
    if (!user) return { view: null, paused: false };
    const now = this.clock.now();
    user.unansweredStreak += 1;
    let paused = false;
    if (user.unansweredStreak >= RESPONSE_MISS_LIMIT) {
      const alreadyPaused =
        user.delistedUntil !== null && user.delistedUntil.getTime() > now.getTime();
      if (!alreadyPaused) {
        user.delistedUntil = new Date(now.getTime() + RESPONSE_PAUSE_HOURS * 3_600_000);
        paused = true;
        await this.repos.audit.append({
          actorId: null,
          action: 'owner.delisted',
          entity: 'user',
          entityId: ownerId,
          metadata: {
            unansweredStreak: user.unansweredStreak,
            until: user.delistedUntil.toISOString(),
            hours: RESPONSE_PAUSE_HOURS,
          },
        });
      }
    }
    await this.repos.users.save(user);
    // A missed request changes the window in the same breath as the streak — recompute now so the
    // seller's own card never shows yesterday's numbers.
    const view = await this.refresh(ownerId);
    if (paused) {
      await this.notifier.emit({
        userId: ownerId,
        kind: 'LISTINGS_PAUSED',
        params: { hours: RESPONSE_PAUSE_HOURS },
        payload: { delistedUntil: user.delistedUntil?.toISOString() ?? null },
      });
    }
    return { view, paused };
  }

  /** Badge for the listing card, batched: one call per market page, not one per card. */
  async badges(ownerIds: readonly string[]): Promise<Map<string, ResponseView>> {
    const unique = [...new Set(ownerIds)];
    const users = await this.repos.users.findByIds(unique);
    return new Map(users.map((user) => [user.id, toResponseView(user)]));
  }

  /** The signed-in seller's own card (profile screen). */
  async me(userId: string): Promise<ResponseView> {
    const user = await this.repos.users.findById(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    return toResponseView(user);
  }

  /** Scheduler sweep: a paused owner comes back on their own when the day is over. */
  async liftDuePauses(limit = 100): Promise<number> {
    const now = this.clock.now();
    const due = await this.repos.users.listDelistDue(now, limit);
    let lifted = 0;
    for (const user of due) {
      user.delistedUntil = null;
      user.unansweredStreak = 0;
      await this.repos.users.save(user);
      await this.repos.audit.append({
        actorId: null,
        action: 'owner.relisted',
        entity: 'user',
        entityId: user.id,
        metadata: { automatic: true },
      });
      await this.notifier.emit({
        userId: user.id,
        kind: 'LISTINGS_RESUMED',
        params: {},
        payload: {},
      });
      lifted += 1;
    }
    return lifted;
  }

  /**
   * Scheduler sweep: a 30-day window ages even when nothing happens, so the stored rate is
   * refreshed at most `limit` owners per tick for anyone whose numbers are a day old.
   */
  async refreshStale(limit = 25): Promise<number> {
    const before = new Date(this.clock.now().getTime() - 24 * 3_600_000);
    const stale = await this.repos.users.listResponseStale(before, limit);
    for (const user of stale) {
      await this.refresh(user.id);
    }
    return stale.length;
  }

  /** Admin action: put a paused owner back in the market early. */
  async relist(actorId: string, userId: string): Promise<ResponseView> {
    const user = await this.repos.users.findById(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    user.delistedUntil = null;
    user.unansweredStreak = 0;
    const saved = await this.repos.users.save(user);
    await this.repos.audit.append({
      actorId,
      action: 'owner.relisted',
      entity: 'user',
      entityId: userId,
      metadata: { automatic: false },
    });
    await this.notifier.emit({
      userId,
      kind: 'LISTINGS_RESUMED',
      params: {},
      payload: { manual: true },
    });
    return toResponseView(saved);
  }

  /** «توقف نمایش» count for the admin dashboard strip. */
  async pausedCount(): Promise<number> {
    const paused = await this.repos.users.listDelisted(this.clock.now(), 500);
    return paused.filter(
      (user) =>
        user.delistedUntil !== null && user.delistedUntil.getTime() > this.clock.now().getTime(),
    ).length;
  }
}
