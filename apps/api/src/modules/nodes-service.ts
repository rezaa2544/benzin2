import type { Clock } from '../domain/entities.js';
import type {
  NodeHeartbeatRecord,
  NodeJob,
  NodeJobs,
  NodeResources,
  NodeTraffic,
  Repositories,
} from '../ports.js';
import { createHostTelemetry, type HostTelemetry } from './host-telemetry.js';

/**
 * Node registry and failover (task G-28).
 *
 * The product runs fine on one machine, but the owner asked for a second box of his own to stand
 * by as a helper: it must report live CPU and what work it did, and it must stay *idle* while the
 * primary is healthy. Both halves of that live here:
 *
 *  - every node writes a heartbeat (resources + traffic counters + jobs it ran) into
 *    `node_heartbeats`, so the panel can show any node, not only the one serving the request;
 *  - a helper asks `failover()` on a short poll and only starts its expiry sweeps when the
 *    primary has not been seen for `staleSeconds`.
 *
 * The counters are per process and in memory on purpose: they answer "what is this node doing
 * right now", and a restart legitimately resets them.
 */

export type NodeRole = 'primary' | 'helper';
export type NodeState = 'active' | 'standby' | 'offline';

export interface NodesServiceOptions {
  nodeId: string;
  name: string;
  role: NodeRole;
  version: string;
  region?: string | null;
  /** A node that has not reported for this long is offline, and the helper may take over. */
  staleSeconds?: number;
  telemetry?: HostTelemetry;
}

export interface NodeHeartbeatInput {
  nodeId: string;
  name?: string;
  role?: NodeRole;
  version?: string | null;
  region?: string | null;
  resources?: Partial<NodeResources> | null;
  traffic?: Partial<NodeTraffic> | null;
  jobs?: Partial<Omit<NodeJobs, 'recent'>> & { recent?: NodeJob[] } | null;
  uptimeSeconds?: number;
  active?: boolean;
}

export interface NodeView extends NodeHeartbeatRecord {
  state: NodeState;
  stateFa: string;
  heartbeatAgeSeconds: number;
  self: boolean;
  /** Sweeping right now versus parked and waiting for the primary to disappear. */
  duties: 'primary' | 'taking-over' | 'standby' | 'offline';
  dutiesFa: string;
}

export interface NodesOverview {
  generatedAt: string;
  staleAfterSeconds: number;
  selfNodeId: string;
  /** Which node is doing the sweeps right now. */
  activeNodeId: string | null;
  primary: { nodeId: string; healthy: boolean; lastSeenAt: string | null } | null;
  failover: { shouldTakeOver: boolean; reason: string; reasonFa: string };
  nodes: NodeView[];
}

const STATE_FA: Record<NodeState, string> = {
  active: 'فعال',
  standby: 'آماده‌به‌کار',
  offline: 'آفلاین',
};

const DUTIES_FA: Record<NodeView['duties'], string> = {
  primary: 'سرور اصلی — کارها را انجام می‌دهد',
  'taking-over': 'جای سرور اصلی را گرفته',
  standby: 'بی‌کار و آماده — منتظر قطع سرور اصلی',
  offline: 'بدون گزارش',
};

const FAILOVER_REASON_FA: Record<string, string> = {
  'primary-healthy': 'سرور اصلی سالم است؛ گرهٔ کمکی وارد کار نمی‌شود',
  'primary-stale': 'سرور اصلی از کار افتاده؛ گرهٔ کمکی کارها را برمی‌دارد',
  'primary-missing': 'هیچ سرور اصلی‌ای ثبت نشده؛ گرهٔ کمکی کارها را برمی‌دارد',
};

const emptyTraffic = (): NodeTraffic => ({
  requests: 0,
  errors: 0,
  requestsPerMin: 0,
  avgLatencyMs: 0,
  lastRequestAt: null,
});

const emptyJobs = (): NodeJobs => ({ total: 0, last30Min: 0, lastJobAt: null, recent: [] });

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const WINDOW_MS = 60_000;
const MAX_WINDOW_SAMPLES = 2_000;
const MAX_RECENT_JOBS = 12;

export class NodesService {
  private readonly telemetry: HostTelemetry;
  private readonly staleSeconds: number;
  private readonly startedAt = Date.now();
  /** Lifetime counters of this process; the panel also shows a one-minute rate. */
  private requests = 0;
  private errors = 0;
  private readonly window: { at: number; ms: number; error: boolean }[] = [];
  private jobTotal = 0;
  private readonly recentJobs: NodeJob[] = [];
  private active = false;

  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly options: NodesServiceOptions,
  ) {
    this.telemetry = options.telemetry ?? createHostTelemetry();
    this.staleSeconds = options.staleSeconds ?? 90;
    // The primary sweeps from boot, so it starts out active; a helper starts parked.
    this.active = options.role === 'primary';
  }

  get nodeId(): string {
    return this.options.nodeId;
  }

  get role(): NodeRole {
    return this.options.role;
  }

  /** A helper flips this on when it takes over, so the panel can say who is doing the work. */
  setActiveLocal(active: boolean): void {
    this.active = active;
  }

  isActiveLocal(): boolean {
    return this.active;
  }

  /** Called from the response hook; `durationMs` is the whole request, DB included. */
  recordRequest(input: { statusCode: number; durationMs: number }): void {
    const at = this.clock.now().getTime();
    const isError = input.statusCode >= 500;
    this.requests += 1;
    if (isError) this.errors += 1;
    this.window.push({ at, ms: input.durationMs, error: isError });
    if (this.window.length > MAX_WINDOW_SAMPLES) this.window.splice(0, this.window.length - MAX_WINDOW_SAMPLES);
  }

  /** Called by the scheduler after every sweep so the panel can show a work report. */
  recordJob(kind: string, count: number, detail?: Record<string, number>): void {
    const at = this.clock.now().toISOString();
    this.jobTotal += count;
    this.recentJobs.unshift({ kind, count, at, ...(detail ? { detail } : {}) });
    if (this.recentJobs.length > MAX_RECENT_JOBS) this.recentJobs.length = MAX_RECENT_JOBS;
  }

  private windowSnapshot(): { requestsPerMin: number; avgLatencyMs: number } {
    const now = this.clock.now().getTime();
    const fresh = this.window.filter((sample) => now - sample.at <= WINDOW_MS);
    if (fresh.length === 0) return { requestsPerMin: 0, avgLatencyMs: 0 };
    const sum = fresh.reduce((total, sample) => total + sample.ms, 0);
    return {
      // The window is one minute wide, so the count *is* the per-minute rate.
      requestsPerMin: fresh.length,
      avgLatencyMs: round(sum / fresh.length),
    };
  }

  private ownTraffic(): NodeTraffic {
    const { requestsPerMin, avgLatencyMs } = this.windowSnapshot();
    const lastSample = this.window[this.window.length - 1];
    return {
      requests: this.requests,
      errors: this.errors,
      requestsPerMin,
      avgLatencyMs,
      lastRequestAt: lastSample ? new Date(lastSample.at).toISOString() : null,
    };
  }

  private ownJobs(): NodeJobs {
    const now = this.clock.now().getTime();
    const last30 = this.recentJobs.filter((job) => now - Date.parse(job.at) <= 30 * 60_000);
    return {
      total: this.jobTotal,
      last30Min: last30.reduce((total, job) => total + job.count, 0),
      lastJobAt: this.recentJobs[0]?.at ?? null,
      recent: [...this.recentJobs],
    };
  }

  /** Snapshot of this process, as it is about to be written to the heartbeat table. */
  async selfRecord(): Promise<NodeHeartbeatRecord> {
    let resources: NodeResources | null = null;
    try {
      resources = await this.telemetry.resources();
    } catch {
      resources = null;
    }
    return {
      nodeId: this.options.nodeId,
      name: this.options.name,
      role: this.options.role,
      version: this.options.version,
      region: this.options.region ?? null,
      resources,
      traffic: this.ownTraffic(),
      jobs: this.ownJobs(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      active: this.active,
      lastSeenAt: this.clock.now(),
    };
  }

  /** Writes this process's heartbeat; the entrypoint calls it on a timer. */
  async publishSelf(): Promise<NodeHeartbeatRecord> {
    const record = await this.selfRecord();
    await this.repos.nodes.save(record);
    return record;
  }

  /** Heartbeat from an external agent (the owner's PC running `scripts/helper-node.mjs`). */
  async ingest(input: NodeHeartbeatInput): Promise<NodeView> {
    const now = this.clock.now();
    const record: NodeHeartbeatRecord = {
      nodeId: input.nodeId,
      name: input.name?.trim() || input.nodeId,
      role: input.role ?? 'helper',
      version: input.version ?? null,
      region: input.region ?? null,
      resources: input.resources
        ? {
            cpuPct: input.resources.cpuPct ?? 0,
            cores: input.resources.cores ?? 0,
            memUsedPct: input.resources.memUsedPct ?? 0,
            memRssMb: input.resources.memRssMb ?? 0,
            diskFreeGb: input.resources.diskFreeGb ?? 0,
            diskTotalGb: input.resources.diskTotalGb ?? 0,
            loadAvg: input.resources.loadAvg ?? 0,
            eventLoopLagMs: input.resources.eventLoopLagMs ?? null,
          }
        : null,
      traffic: { ...emptyTraffic(), ...(input.traffic ?? {}) },
      jobs: { ...emptyJobs(), ...(input.jobs ?? {}), recent: input.jobs?.recent ?? [] },
      uptimeSeconds: input.uptimeSeconds ?? 0,
      active: input.active ?? false,
      lastSeenAt: now,
    };
    await this.repos.nodes.save(record);
    return this.toView(record, now, false);
  }

  private toView(record: NodeHeartbeatRecord, now: Date, self: boolean): NodeView {
    const ageSeconds = Math.max(0, Math.round((now.getTime() - record.lastSeenAt.getTime()) / 1000));
    const state: NodeState =
      ageSeconds > this.staleSeconds ? 'offline' : record.active ? 'active' : 'standby';
    const duties: NodeView['duties'] =
      state === 'offline'
        ? 'offline'
        : record.role === 'primary'
          ? 'primary'
          : record.active
            ? 'taking-over'
            : 'standby';
    return {
      ...record,
      state,
      stateFa: STATE_FA[state],
      heartbeatAgeSeconds: ageSeconds,
      self,
      duties,
      dutiesFa: DUTIES_FA[duties],
    };
  }

  async listNodes(): Promise<NodeView[]> {
    const now = this.clock.now();
    const records = await this.repos.nodes.list();
    // A fresh boot has not written its first heartbeat yet, and a heartbeat interval of a few
    // seconds should never make the panel say "no nodes". The process answering the request is by
    // definition alive, so show it even before its first row lands.
    if (!records.some((record) => record.nodeId === this.options.nodeId)) {
      records.push(await this.selfRecord());
    }
    return records
      .map((record) => this.toView(record, now, record.nodeId === this.options.nodeId))
      .sort((a, b) => {
        // The serving node first, then whoever is live, then by name — a stable, readable list.
        if (a.self !== b.self) return a.self ? -1 : 1;
        if (a.state !== b.state) return a.state === 'offline' ? 1 : -1;
        return a.name.localeCompare(b.name, 'fa');
      });
  }

  /**
   * Should a helper take the sweeps over? True when no *primary* has reported inside the stale
   * window. Called by helper processes on a short poll.
   */
  async failover(): Promise<{ shouldTakeOver: boolean; reason: string; reasonFa: string }> {
    const now = this.clock.now();
    const records = await this.repos.nodes.list();
    const primaries = records.filter((record) => record.role === 'primary');
    if (primaries.length === 0) {
      return {
        shouldTakeOver: true,
        reason: 'primary-missing',
        reasonFa: FAILOVER_REASON_FA['primary-missing'] as string,
      };
    }
    const healthy = primaries.some(
      (record) => now.getTime() - record.lastSeenAt.getTime() <= this.staleSeconds * 1000,
    );
    const reason = healthy ? 'primary-healthy' : 'primary-stale';
    return {
      shouldTakeOver: !healthy,
      reason,
      reasonFa: FAILOVER_REASON_FA[reason] as string,
    };
  }

  /** Convenience for the helper loop: publish, then ask whether to start sweeping. */
  async shouldTakeOver(): Promise<boolean> {
    const decision = await this.failover();
    return decision.shouldTakeOver;
  }

  async overview(): Promise<NodesOverview> {
    const nodes = await this.listNodes();
    const decision = await this.failover();
    const primaryRecord = nodes.find((node) => node.role === 'primary' && node.state !== 'offline');
    const activeNode = nodes.find((node) => node.state === 'active');
    return {
      generatedAt: this.clock.now().toISOString(),
      staleAfterSeconds: this.staleSeconds,
      selfNodeId: this.options.nodeId,
      activeNodeId: activeNode?.nodeId ?? null,
      primary: primaryRecord
        ? {
            nodeId: primaryRecord.nodeId,
            healthy: primaryRecord.state !== 'offline',
            lastSeenAt: primaryRecord.lastSeenAt.toISOString(),
          }
        : null,
      failover: decision,
      nodes,
    };
  }
}
