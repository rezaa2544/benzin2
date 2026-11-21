import type { UserRole, UserStatus } from '@benzin/shared';

/** Wire types for the admin endpoints (epic E8). Mirrors `apps/api/src/modules/admin-service.ts`. */

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface UserRow {
  id: string;
  phone: string;
  displayName: string | null;
  role: UserRole;
  roleFa: string;
  status: UserStatus;
  suspendedUntil: string | null;
  createdAt: string;
  /** G-10: answered/received over the last 30 days plus the badge the buyers see. */
  response: {
    answered: number;
    received: number;
    ratePercent: number | null;
    labelFa: string;
    unansweredStreak: number;
  };
  /** G-10: set while this seller's listings are hidden from the market. */
  delistedUntil: string | null;
}

/** G-10: one row of the listing-pause review queue. */
export interface ListingPause extends UserRow {
  until: string;
  reasonFa: string;
}

export interface UserDetail extends UserRow {
  reputation: { score: number; level: string; levelFa: string };
  counts: { orders: number; reservations: number; payments: number; subscriptions: number };
  subscription: { planCode: string | null; status: string; endsAt: string } | null;
}

export interface OrderRow {
  id: string;
  ownerId: string;
  ownerPhone: string | null;
  side: string;
  tier: string;
  litres: number;
  rateToman: number;
  totalToman: number;
  status: string;
  zoneId: string;
  stationName: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface OrderDetail extends OrderRow {
  note: string | null;
  reservations: {
    id: string;
    takerId: string;
    takerPhone: string | null;
    status: string;
    createdAt: string;
    decidedAt: string | null;
    completedAt: string | null;
    cancelReason: string | null;
  }[];
}

export interface PaymentRow {
  id: string;
  status: string;
  provider: string;
  amountToman: number;
  uniqueAmountToman: number | null;
  reference: string | null;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** G-12 — the income report the panel shows above the payment tables. */
export interface RevenueReport {
  from: string;
  to: string;
  totalToman: number;
  totalTomanLabelFa: string;
  paidCount: number;
  pendingCount: number;
  failedCount: number;
  byProvider: {
    provider: string;
    labelFa: string;
    paidCount: number;
    paidToman: number;
    paidTomanLabelFa: string;
  }[];
  byDay: { day: string; paidCount: number; paidToman: number; paidTomanLabelFa: string }[];
}

/** G-11 — one bank transfer sitting in the deposit table. */
export interface CardDepositRow {
  id: string;
  reference: string;
  amountToman: number;
  senderName: string | null;
  paidAt: string;
  receivedAt: string;
  status: 'MATCHED' | 'UNMATCHED' | 'IGNORED';
  paymentId: string | null;
}

export interface PaymentCardRow {
  id: string;
  maskedNumber: string;
  last4: string;
  holderName: string;
  bankName: string | null;
  isActive: boolean;
  dailyLimit: number | null;
}

/** G-15: one row of the plan catalogue (`/v1/admin/plans`). */
export interface PlanRow {
  id: string;
  code: string;
  nameFa: string;
  priceToman: number;
  priceLabelFa: string;
  durationDays: number;
  maxActiveOrders: number;
  /** G-26: what the plan sells — reservations per month (null = unlimited), numbers, single use. */
  monthlyReservations: number | null;
  phoneVisible: boolean;
  singleUse: boolean;
  isActive: boolean;
}

export interface SubscriptionRow {
  id: string;
  userId: string;
  phone: string | null;
  planCode: string | null;
  planNameFa: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Dashboard {
  users: { total: number; active: number; suspended: number; banned: number };
  orders: { byStatus: Record<string, number>; open: number; completed: number };
  reservations: { active: number };
  subscriptions: { active: number; pending: number };
  payments: {
    paidCount: number;
    paidToman: number;
    pendingCount: number;
    failedCount: number;
    expiredCount: number;
  };
  tiles: { labelFa: string; value: string; hintFa: string }[];
  recentAudit: AuditRow[];
  generatedAt: string;
}

export interface SystemStatus {
  mode: string;
  nodeEnv: string;
  version: string;
  uptimeSeconds: number;
  serverTime: string;
  checks: { name: string; ok: boolean; detailFa: string }[];
  providers: { kind: string; provider: string; isActive: boolean }[];
  settingsKeys: number;
}

export interface ProviderRow {
  id: string;
  provider: string;
  kind: 'SMS' | 'PAYMENT' | 'MAP';
  isActive: boolean;
  config: Record<string, unknown>;
}

/** G-14: the chain the platform will actually walk, and where it came from. */
export interface SmsChainLink {
  provider: string;
  priority: number;
  isActive: boolean;
  keySet: boolean;
  sender: string | null;
  template: string | null;
}

export interface SmsPanel {
  enabled: boolean;
  source: 'PANEL' | 'ENV' | 'CONSOLE';
  otpMessage: string;
  chain: SmsChainLink[];
  lastAttempts: SmsAttemptRow[];
}

/** What one provider answered — printed verbatim, because that is the acceptance criterion. */
export interface SmsAttemptRow {
  provider: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  mode: 'template' | 'text';
  raw: string | null;
}

export interface SmsTestResult {
  delivered: boolean;
  message: string;
  attempts: SmsAttemptRow[];
}

export interface ZoneRow {
  id: string;
  slug: string;
  nameFa: string;
  city: string;
  province: string;
  isActive: boolean;
  vertices: number;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; displayName: string | null; role: UserRole };
}

/**
 * Node monitor (task G-28). Mirrors `apps/api/src/modules/nodes-service.ts` — the owner's own
 * machine can stand by as a helper node, so the panel shows every node's resources, the traffic it
 * served and the sweeps it actually ran.
 */
export interface NodeResources {
  cpuPct: number;
  cores: number;
  memUsedPct: number;
  memRssMb: number;
  diskFreeGb: number;
  diskTotalGb: number;
  loadAvg: number;
  eventLoopLagMs: number | null;
}

export interface NodeTraffic {
  requests: number;
  errors: number;
  requestsPerMin: number;
  avgLatencyMs: number;
  lastRequestAt: string | null;
}

export interface NodeJob {
  kind: string;
  count: number;
  at: string;
  detail?: Record<string, number>;
}

export interface NodeJobs {
  total: number;
  last30Min: number;
  lastJobAt: string | null;
  recent: NodeJob[];
}

export interface NodeView {
  nodeId: string;
  name: string;
  role: 'primary' | 'helper';
  version: string | null;
  region: string | null;
  resources: NodeResources | null;
  traffic: NodeTraffic;
  jobs: NodeJobs;
  uptimeSeconds: number;
  active: boolean;
  lastSeenAt: string;
  state: 'active' | 'standby' | 'offline';
  stateFa: string;
  heartbeatAgeSeconds: number;
  self: boolean;
  duties: 'primary' | 'taking-over' | 'standby' | 'offline';
  dutiesFa: string;
}

export interface NodesOverview {
  generatedAt: string;
  staleAfterSeconds: number;
  selfNodeId: string;
  activeNodeId: string | null;
  primary: { nodeId: string; healthy: boolean; lastSeenAt: string | null } | null;
  failover: { shouldTakeOver: boolean; reason: string; reasonFa: string };
  nodes: NodeView[];
}

/** 72-hour trade median (task G-08) — the same payload the home screen uses, plus per-region rows. */
export interface TradeMedianRegion {
  province: string | null;
  county: string | null;
  labelFa: string;
  trades: number;
  medianRateToman: number | null;
  sufficient: boolean;
}

export interface TradeMedian {
  windowHours: number;
  requiredTrades: number;
  scope: { province: string | null; county: string | null };
  labelFa: string;
  trades: number;
  medianRateToman: number | null;
  sufficient: boolean;
  messageFa: string;
  byRegion: TradeMedianRegion[];
  generatedAt: string;
}

/** G-13 — the infrastructure board: checks with a colour, and the inventory behind them. */
export type InfraStatus = 'OK' | 'WARN' | 'DOWN';

export interface InfraCheckRow {
  key: string;
  labelFa: string;
  status: InfraStatus;
  detailFa: string;
  checkedAt: string;
}

export interface InfraResourceRow {
  id: string;
  name: string;
  kind: string;
  address: string;
  /** The credential itself never reaches the panel — only whether one is stored. */
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
  migrations: { latest: string | null; count: number; detailFa: string };
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  counts: { users: number; openOrders: number; ordersToday: number; tradesToday: number };
  checks: InfraCheckRow[];
  resources: InfraResourceRow[];
}
