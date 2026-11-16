import type {
  DeliveryMethod,
  OrderSide,
  OrderStatus,
  ReservationStatus,
  Tier,
  UserRole,
} from '@benzin/shared';

export interface PublicUser {
  id: string;
  phone: string;
  displayName: string | null;
  role: UserRole;
  createdAt?: string;
}

export interface ZoneView {
  id: string;
  slug: string;
  nameFa: string;
  city: string;
  province: string;
  boundary: Array<[number, number]>;
}

/** G-07 wire shape of `GET /v1/orders?lat=…&lng=…` — metres stay on the server. */
export interface RouteEstimate {
  distanceKm: number;
  durationMinutes: number;
  etaMinutes: number;
  approximate: boolean;
  source: 'provider' | 'straight-line';
}

export interface OrderView {
  id: string;
  ownerId: string;
  side: OrderSide;
  tier: Tier;
  litres: number;
  rateToman: number;
  officialRateToman: number;
  totalToman: number;
  buyerSavingToman: number;
  status: OrderStatus;
  /** Province (استان) and county (شهرستان) of the listing; null on legacy rows. */
  province: string | null;
  county: string | null;
  /** Per-litre pump fee the seller declared; 0 for buy requests. */
  pumpFeeToman: number;
  /** rateToman + pumpFeeToman — the all-in price of one litre. */
  buyerRateToman: number;
  buyerTotalToman: number;
  stationName: string | null;
  note: string | null;
  location: { lat: number; lng: number } | null;
  deliveryMethod: DeliveryMethod;
  expiresAt: string;
  createdAt: string;
  distance?: RouteEstimate;
  /**
   * G-10 — the seller's answer-rate badge, as the API computed it. `ratePercent === null` while
   * they never received a request; the copy (`labelFa`) is written on the server so the app never
   * rounds a number itself.
   */
  owner?: {
    id: string;
    ratePercent: number | null;
    labelFa: string;
    answered: number;
    received: number;
  };
}

/**
 * G-10 — `GET /v1/me/response`. Everything is pre-computed by the API, including the Persian
 * label, so the percentage on screen is the same number the market sorted by.
 */
export interface ResponseSummary {
  ownerId: string;
  ratePercent: number | null;
  answered: number;
  received: number;
  labelFa: string;
  unansweredStreak: number;
  delistedUntil: string | null;
}

export interface OrderList {
  items: OrderView[];
  nextCursor: string | null;
  /** G-05: closest lots when an exact lot has no listing. */
  nearest?: { litres: number; items: OrderView[] } | null;
  /** Persian copy for the empty-lot case, rendered as-is. */
  message?: string | null;
}

export interface ReservationView {
  id: string;
  orderId: string;
  takerId: string;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  /** How many deadline pushes the buyer used (G-04 allows one by default). */
  extensionCount?: number;
}

export interface MarketStats {
  province: string | null;
  county: string | null;
  side: OrderSide;
  tier: Tier | null;
  windowDays: number;
  sampleSize: number;
  excludedSuspicious: number;
  /** Quoted rate only — what the seller asks for the quota. */
  averageRateToman: number | null;
  medianRateToman: number | null;
  p25RateToman: number | null;
  p75RateToman: number | null;
  minRateToman: number | null;
  maxRateToman: number | null;
  /** Quoted rate + pump fee: what a buyer really pays per litre. */
  averageTotalRateToman: number | null;
  minTotalRateToman: number | null;
  maxTotalRateToman: number | null;
  averageLitres: number | null;
  /** The place average split by pump fee. */
  byTier: Array<{
    tier: Tier;
    sampleSize: number;
    averageTotalRateToman: number | null;
    minTotalRateToman: number | null;
    maxTotalRateToman: number | null;
  }>;
  buyLitres: number;
  sellLitres: number;
  buyCount: number;
  sellCount: number;
  nationalAverageTotalRateToman: number | null;
  nationalSampleSize: number;
  nationalCountyCount: number;
  overallAverageRateToman: number | null;
  overallSampleSize: number;
  generatedAt: string;
}

export interface MetaConfig {
  /** API build version; the desktop shell reports the newer content version separately. */
  version?: string;
  otpTtlSeconds: number;
  otpLength: number;
  reservationTtlMinutes: number;
  ownerDecisionTtlMinutes: number;
  minLitres: number;
  maxLitres: number;
  maxActiveReservations: number;
  maxMessageLength: number;
  quickReplies: string[];
  /** G-11: `auto` matches the deposit amount, `review` waits for an operator. */
  cardMode?: 'auto' | 'review';
}

export interface NotificationView {
  id: string;
  kind: string;
  channel: 'IN_APP' | 'SMS' | 'PUSH';
  titleFa: string;
  bodyFa: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationView[];
  unreadCount: number;
}

export interface OtpRequestResult {
  expiresAt: string;
  cooldownSeconds: number;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
  isNewUser: boolean;
  user: PublicUser;
}

export interface PlanView {
  id: string;
  code: string;
  nameFa: string;
  priceToman: number;
  priceLabelFa: string;
  durationDays: number;
  maxActiveOrders: number;
}

export type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

export interface SubscriptionView {
  id: string;
  planId: string;
  planCode: string;
  planNameFa: string;
  status: SubscriptionStatus;
  startsAt: string;
  endsAt: string;
  daysRemaining: number;
}

export interface PaymentView {
  id: string;
  amountToman: number;
  status: string;
  method: 'CARD_TO_CARD' | 'GATEWAY';
  expiresAt: string;
  createdAt: string;
  /** G-11: price + random suffix — the number the buyer must transfer, and the matcher key. */
  uniqueAmountToman?: number | null;
}

export interface PaymentStartView extends PaymentView {
  redirectUrl: string | null;
  destination: { cardNumber: string; holderName: string; bankName: string | null } | null;
  instructionFa: string;
}

export interface ConversationView {
  id: string;
  orderId: string;
  createdAt: string;
  closedAt: string | null;
  writable: boolean;
  contactAllowed: boolean;
  peer: { id: string; displayName: string | null };
  unreadCount: number;
  lastMessage: { body: string; kind: string; senderId: string; createdAt: string } | null;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  kind: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  contactMasked?: boolean;
}

export interface RatingView {
  id: string;
  reservationId: string;
  raterId: string;
  subjectId: string;
  stars: number;
  comment: string | null;
  createdAt: string;
}

export interface ReputationEventView {
  id: string;
  kind: string;
  labelFa: string;
  delta: number;
  orderId: string | null;
  createdAt: string;
}

export interface ReputationSummary {
  userId: string;
  score: number;
  level: string;
  levelFa: string;
  completedTrades: number;
  cancelledTrades: number;
  disputes: number;
  ratingCount: number;
  averageStars: number | null;
  suspendedUntil: string | null;
  recentEvents: ReputationEventView[];
}

export interface DeviceView {
  id: string;
  platform: string;
  deviceId: string;
  appVersion: string | null;
  lastSeenAt: string;
}

/**
 * 72-hour trade median (task G-08). `sufficient: false` means the place closed fewer than
 * `requiredTrades` deals, so the API sends `medianRateToman: null` and the copy «دادهٔ کافی نیست».
 */
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

/** `GET /v1/reservations/:id/delivery-code` — the buyer's four-digit hand-over code (G-09). */
export interface DeliveryCode {
  reservationId: string;
  orderId: string;
  code: string;
  expiresAt: string;
  attemptsRemaining: number;
  lockedUntil: string | null;
}
