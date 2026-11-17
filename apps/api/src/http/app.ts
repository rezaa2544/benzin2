import os from 'node:os';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  AppError,
  adminAuditQuerySchema,
  adminOrderQuerySchema,
  adminResolveDisputeSchema,
  adminSubscriptionQuerySchema,
  adminUpdateUserSchema,
  adminUserQuerySchema,
  cancelReservationSchema,
  chatMessagesQuerySchema,
  confirmPaymentSchema,
  createPaymentCardSchema,
  completeReservationSchema,
  createOrderSchema,
  isAppError,
  marketStatsSchema,
  tradeMedianQuerySchema,
  nodeHeartbeatSchema,
  notificationQuerySchema,
  createPlanSchema,
  createInfraResourceSchema,
  updateInfraResourceSchema,
  smsTestSchema,
  orderSearchSchema,
  updatePlanSchema,
  paymentListSchema,
  providerSettingSchema,
  providerTestSchema,
  purchaseSubscriptionSchema,
  rejectPaymentSchema,
  originQuerySchema,
  paginationSchema,
  refreshTokenSchema,
  ratingSchema,
  requestOtpSchema,
  gatewayCallbackSchema,
  cardDepositSchema,
  cardProofSchema,
  attachDepositSchema,
  depositListSchema,
  sendMessageSchema,
  updateOrderSchema,
  updateProfileSchema,
  verifyOtpSchema,
  zoneLocateSchema,
  zoneUpsertSchema,
  fieldErrors,
} from '@benzin/shared';
import type { Config } from '../config.js';
import type { Clock, User } from '../domain/entities.js';
import type {
  ChatEventPublisher,
  PaymentProvider,
  Repositories,
  RouteProvider,
  SmsSender,
} from '../ports.js';
import { NOOP_CHAT_EVENTS } from '../ports.js';
import { AdminService } from '../modules/admin-service.js';
import { AuthService } from '../modules/auth-service.js';
import { ChatService } from '../modules/chat-service.js';
import { DistanceService } from '../modules/distance-service.js';
import { LocationService, toZoneView } from '../modules/location-service.js';
import { NotificationService } from '../modules/notification-service.js';
import { OrderService } from '../modules/orders-service.js';
import {
  CardToCardProvider,
  SandboxGatewayProvider,
  ZarinpalGatewayProvider,
} from '../modules/payment-providers.js';
import { PaymentService } from '../modules/payment-service.js';
import { CardDepositService, verifyDepositSignature } from '../modules/card-deposit-service.js';
import { EntitlementService } from '../modules/entitlements-service.js';
import { InfraService } from '../modules/infra-service.js';
import { SmsService } from '../modules/sms-service.js';
import type { FetchLike } from '../infra/sms/index.js';
import { OwnerResponseService } from '../modules/owner-response-service.js';
import { ReputationService } from '../modules/reputation-service.js';
import { ReservationService } from '../modules/reservations-service.js';
import { SettingsService } from '../modules/settings-service.js';
import { ProfileService } from '../modules/profile-service.js';
import { StatsService, TradeMedianService } from '../modules/stats-service.js';
import { NodesService } from '../modules/nodes-service.js';
import { createScheduler, type Scheduler } from '../scheduler.js';
import { createProcessSweepLock, type SweepLock } from '../modules/sweep-lock.js';
import { attachChatSocket, type ChatSocketHandle } from './chat-socket.js';
import { authenticate, currentUser, parseInput, type AppServices } from './context.js';
import { requireRole } from './roles.js';

export interface BuildAppOptions {
  config: Config;
  repos: Repositories;
  sms: SmsSender;
  clock: Clock;
  /** Optional real router (OSRM/Mapbox). Absent or failing → straight-line fallback. */
  routeProvider?: RouteProvider | null;
  /**
   * Guard that makes the expiry sweep single-flight across processes (task G-02). Postgres
   * deployments pass the advisory-lock implementation; dev/tests use the in-process one.
   */
  sweepLock?: SweepLock;
  /**
   * Overrides for the node registry (task G-28). Tests shorten the stale window and pin the node
   * id; the desktop bundle relies on the defaults derived from the config.
   */
  node?: { nodeId?: string; name?: string; role?: 'primary' | 'helper'; region?: string | null };
  /**
   * G-12: a test (or a deployment with its own bank adapter) can hand over the payment providers
   * instead of the ones built from config. Nothing else about the service changes.
   */
  providers?: { gateway?: PaymentProvider; cardToCard?: PaymentProvider };
  /**
   * G-14: a fake HTTP layer for the SMS providers, so a test can watch the chain fail over and read
   * the provider's response without touching the network.
   */
  smsFetch?: FetchLike;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
  /** Background sweeps; `start()` is called by the entrypoint so tests stay in control. */
  scheduler: Scheduler;
  /** Realtime chat channel (E5-01); closed together with the HTTP server. */
  chatSocket: ChatSocketHandle;
}

/** Host part of the default node id: stable across restarts, readable in the panel. */
const hostSlug = (): string =>
  (os.hostname() || 'local')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .slice(0, 40);

const toPublicUser = (user: User) => ({
  id: user.id,
  phone: user.phone,
  displayName: user.displayName,
  role: user.role,
  createdAt: user.createdAt.toISOString(),
  // G-19: the owner of the profile must be able to see the switch's state.
  phoneHidden: user.phoneHidden,
});

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const {
    config,
    repos,
    clock,
    routeProvider = null,
    sweepLock = createProcessSweepLock(),
  } = options;
  const settings = new SettingsService(repos);
  // G-14: the chain is panel-driven at runtime; `sms` (env/console) stays as the fallback link so a
  // deployment that has configured nothing keeps behaving exactly as before.
  const smsDelivery = new SmsService(repos, settings, clock, {
    fallback: options.sms,
    ...(options.smsFetch ? { fetchImpl: options.smsFetch } : {}),
    log: (line) => {
      if (config.LOG_LEVEL !== 'silent') console.info(line);
    },
  });
  const auth = new AuthService(
    repos,
    settings,
    smsDelivery,
    clock,
    {
      secret: config.JWT_SECRET,
      issuer: config.TOKEN_ISSUER,
      accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    },
    config.OTP_PEPPER,
  );
  const locations = new LocationService(repos.zones);
  const distance = new DistanceService(routeProvider);
  const notifications = new NotificationService(repos, settings, smsDelivery, clock);
  const gateway =
    options.providers?.gateway ??
    (config.PAYMENT_GATEWAY === 'zarinpal' && config.ZARINPAL_MERCHANT_ID
      ? new ZarinpalGatewayProvider({
          merchantId: config.ZARINPAL_MERCHANT_ID,
          callbackUrl: config.PAYMENT_CALLBACK_URL,
          baseUrl: config.ZARINPAL_BASE_URL,
        })
      : new SandboxGatewayProvider());
  // G-11: the destination card comes from settings (editable in the panel), not from a constant.
  const cardToCard = options.providers?.cardToCard ?? new CardToCardProvider(repos.paymentCards, async () => {
    const config = await settings.get();
    const [card] = await repos.paymentCards.list(true);
    return {
      cardNumber: config['payment.card_number'],
      holderName: config['payment.card_holder'],
      bankName: card?.bankName ?? null,
    };
  });
  const payments = new PaymentService(
    repos,
    settings,
    clock,
    { gateway, cardToCard },
    notifications,
  );
  // G-11: deposits arrive before matching, so the service owns the record → match → settle path.
  const cardDeposits = new CardDepositService(repos, settings, clock, notifications);
  // A matched deposit settles through the same path a manual approval takes (G-11).
  cardDeposits.attachSettlement((payment, reference) => payments.settleDeposit(payment, reference));
  const reputation = new ReputationService(repos, settings, clock, notifications);
  const profile = new ProfileService(repos, reputation);
  // G-10: the answer rate is a badge, not a penalty — it never writes to the reputation ledger.
  const ownerResponse = new OwnerResponseService(repos, clock, notifications);
  const orders = new OrderService(repos, settings, clock, distance, locations, notifications);
  // G-26: one authority over "what has this buyer paid for", consulted by the reservation gate and
  // by the phone rule below.
  const entitlements = new EntitlementService(repos, settings, clock);
  const reservations = new ReservationService(
    repos,
    settings,
    clock,
    notifications,
    reputation,
    ownerResponse,
    entitlements,
  );
  // The socket hub is attached to the Fastify server below; the service publishes
  // through this indirection so construction order stays acyclic.
  const events: ChatEventPublisher = { publish: (event) => hub.publisher.publish(event) };
  const hub: { publisher: ChatEventPublisher } = { publisher: NOOP_CHAT_EVENTS };
  const chat = new ChatService(repos, settings, clock, notifications, events);
  const stats = new StatsService(repos, settings, clock);
  // G-08: the number the home screen anchors on — median of *closed* trades, not asking prices.
  const tradeMedian = new TradeMedianService(repos, clock);
  // G-14: the admin service tests the *panel* chain, so a saved key is verified against the real
  // provider before anyone trusts it.
  const admin = new AdminService(
    repos,
    settings,
    clock,
    notifications,
    reputation,
    smsDelivery,
    {
      nodeEnv: config.NODE_ENV,
      mode: config.DATABASE_URL ? 'postgres' : 'memory',
      version: config.APP_VERSION,
    },
    // G-14: a saved key starts working on the next message, without a restart.
    () => smsDelivery.refresh(),
  );
  const nodes = new NodesService(repos, clock, {
    nodeId: options.node?.nodeId ?? config.NODE_ID ?? `${config.NODE_ROLE}-${hostSlug()}`,
    name: options.node?.name ?? config.NODE_NAME ?? `بنزین — ${config.NODE_ROLE === 'helper' ? 'کمکی' : 'اصلی'}`,
    role: options.node?.role ?? config.NODE_ROLE,
    version: config.APP_VERSION,
    region: options.node?.region ?? config.NODE_REGION ?? null,
    staleSeconds: config.NODE_STALE_SECONDS,
  });
  // The scheduler reports every sweep it runs, so the panel can show a real work report.
  const scheduler = createScheduler(reservations, orders, reputation, payments, clock, sweepLock, ownerResponse, {
    onTick: (result, at) => {
      const detail = { ...result } as Record<string, number>;
      const count = Object.values(detail).reduce((total, value) => total + value, 0);
      void at;
      nodes.recordJob('expiry-sweep', count, detail);
    },
  });
  // G-13 — the infrastructure board reads the same scheduler the sweeps use, so «زمان‌بند» on the
  // screen is the real last tick rather than a heartbeat invented for the dashboard.
  const infra = new InfraService(repos, settings, clock, {
    version: config.APP_VERSION,
    mode: config.DATABASE_URL ? 'postgres' : 'memory',
    nodeEnv: config.NODE_ENV,
    tickIntervalMs: config.SCHEDULER_INTERVAL_MS,
    lastTick: () => scheduler.lastTick(),
    gatewayConfigured: Boolean(config.ZARINPAL_MERCHANT_ID) && Boolean(config.PAYMENT_RETURN_URL),
  });

  const services: AppServices = {
    auth,
    chat,
    notifications,
    orders,
    payments,
    reputation,
    reservations,
    settings,
    profile,
    admin,
    stats,
    nodes,
    tradeMedian,
    ownerResponse,
    cardDeposits,
    entitlements,
    infra,
    sms: smsDelivery,
  };
  const requireAuth = authenticate(auth);

  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Node monitor (task G-28): every response feeds the traffic counters the panel shows. The
  // start time lives in a WeakMap so a request carries no extra property of its own.
  const requestStartedAt = new WeakMap<object, bigint>();
  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    nodes.recordRequest({
      statusCode: reply.statusCode,
      durationMs: startedAt ? Number(process.hrtime.bigint() - startedAt) / 1e6 : 0,
    });
  });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as { statusCode?: number; message?: string };
    if (isAppError(rawError)) {
      return reply.status(rawError.httpStatus).send({
        error: {
          code: rawError.code,
          message: rawError.message,
          details: rawError.details ?? null,
          requestId: request.id,
        },
      });
    }
    if (rawError instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: fieldErrors(rawError),
          requestId: request.id,
        },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: rawError }, 'unhandled error');
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
        message:
          statusCode >= 500 ? 'Unexpected server error' : (error.message ?? 'Request failed'),
        details: null,
        requestId: request.id,
      },
    });
  });

  const chatSocket = attachChatSocket(app, auth, chat);
  hub.publisher = chatSocket.publisher;
  app.addHook('onClose', async () => {
    await chatSocket.close();
  });

  app.get('/healthz', async () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));

  app.get('/v1/meta/config', async () => {
    const effective = await settings.get();
    return {
      // Running build: the desktop shell shows the content version on top of this, but a browser
      // or PWA install has no shell, so the chip falls back to the API build.
      version: config.APP_VERSION,
      otpTtlSeconds: effective['otp.ttl_seconds'],
      otpLength: effective['otp.length'],
      reservationTtlMinutes: effective['reservation.ttl_minutes'],
      ownerDecisionTtlMinutes: effective['owner.decision_ttl_minutes'],
      minLitres: effective['order.min_litres'],
      maxLitres: effective['order.max_litres'],
      maxActiveReservations: effective['reservation.max_active_per_user'],
      maxMessageLength: effective['chat.max_message_length'],
      quickReplies: effective['chat.quick_replies'],
      // G-11: the app shows the tracking-number box only in review mode. Never the card number —
      // that one arrives with the invoice, after the buyer chose a plan.
      cardMode: effective['payment.card_mode'],
    };
  });

  // ---------------------------------------------------------------- auth
  app.post('/v1/auth/otp/request', async (request, reply) => {
    const body = parseInput(requestOtpSchema, request.body);
    const result = await auth.requestOtp(body.phone);
    return reply.status(202).send({
      expiresAt: result.expiresAt.toISOString(),
      cooldownSeconds: result.cooldownSeconds,
    });
  });

  app.post('/v1/auth/otp/verify', async (request) => {
    const body = parseInput(verifyOtpSchema, request.body);
    const result = await auth.verifyOtp(body.phone, body.code, body.device);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      deviceId: result.deviceId,
      isNewUser: result.isNewUser,
      user: toPublicUser(result.user),
    };
  });

  /** Rotation: the old refresh token dies, the new one inherits the same family. */
  app.post('/v1/auth/refresh', async (request) => {
    const body = parseInput(refreshTokenSchema, request.body);
    const result = await auth.refresh(body.refreshToken);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user: toPublicUser(result.user),
    };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const body = parseInput(refreshTokenSchema, request.body);
    await auth.logout(body.refreshToken);
    return reply.status(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: requireAuth }, async (request, reply) => {
    const revoked = await auth.logoutAll(currentUser(request));
    return reply.status(200).send({ revoked });
  });

  app.get('/v1/me/devices', { preHandler: requireAuth }, async (request) => {
    const devices = await auth.listDevices(currentUser(request));
    return {
      items: devices.map((device) => ({
        id: device.id,
        platform: device.platform,
        deviceId: device.deviceId,
        appVersion: device.appVersion,
        lastSeenAt: device.lastSeenAt.toISOString(),
      })),
    };
  });

  app.get('/v1/me', { preHandler: requireAuth }, async (request) =>
    toPublicUser(currentUser(request)),
  );

  /** Profile edit (task E1-05): only the display name, validated by the shared schema. */
  app.patch('/v1/me', { preHandler: requireAuth }, async (request) => {
    const body = parseInput(updateProfileSchema, request.body);
    return toPublicUser(await profile.update(currentUser(request), body));
  });

  /** Public card for a counterpart: name, member-since and the trust level, never the phone. */
  app.get('/v1/users/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return profile.publicProfile(id);
  });

  // --------------------------------------------------------------- zones
  app.get('/v1/zones', { preHandler: requireAuth }, async () => {
    const zones = await repos.zones.listActive();
    return { items: zones.map(toZoneView) };
  });

  app.get('/v1/zones/locate', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(zoneLocateSchema, request.query);
    return locations.locate({ lat: query.lat, lng: query.lng });
  });

  // -------------------------------------------------------------- orders
  app.get('/v1/orders', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(orderSearchSchema, request.query);
    return orders.search(query);
  });

  app.post('/v1/orders', { preHandler: requireAuth }, async (request, reply) => {
    const body = parseInput(createOrderSchema, request.body);
    const created = await orders.create(currentUser(request), body);
    return reply.status(201).send(created);
  });

  app.get('/v1/orders/mine', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(paginationSchema, request.query);
    return { items: await orders.listMine(currentUser(request), query.limit) };
  });

  app.get('/v1/orders/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const origin = parseInput(originQuerySchema, request.query);
    return orders.getById(
      id,
      origin.lat !== undefined && origin.lng !== undefined
        ? { lat: origin.lat, lng: origin.lng }
        : null,
    );
  });

  app.patch('/v1/orders/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseInput(updateOrderSchema, request.body);
    return orders.update(currentUser(request), id, body);
  });

  app.post('/v1/orders/:id/cancel', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return orders.cancel(currentUser(request), id);
  });

  // ---------------------------------------------------------------- stats
  app.get('/v1/stats/market', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(marketStatsSchema, request.query);
    return stats.market(query);
  });

  // G-08: «میانگین بازار» — median price per litre of the trades closed in the last 72 hours,
  // optionally narrowed to a province/county. Under five trades the answer is «دادهٔ کافی نیست».
  app.get('/v1/stats/market/median', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(tradeMedianQuerySchema, request.query ?? {});
    return tradeMedian.median(query);
  });

  // -------------------------------------------------------- reservations
  app.post('/v1/orders/:id/reservations', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const created = await reservations.request(currentUser(request), id);
    return reply.status(201).send(created);
  });

  app.get('/v1/reservations/mine', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(paginationSchema, request.query);
    return { items: await reservations.listMine(currentUser(request), query.limit) };
  });

  // G-04: "the previous reservation was released — book the same order again?" prompt.
  app.get('/v1/reservations/rebook-hint', { preHandler: requireAuth }, async (request) => {
    const hint = await reservations.rebookHint(currentUser(request));
    return { hint };
  });

  app.post('/v1/reservations/:id/extend', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reservations.extend(currentUser(request), id);
  });

  app.get('/v1/reservations/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reservations.get(currentUser(request), id);
  });

  app.post('/v1/reservations/:id/confirm', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reservations.confirm(currentUser(request), id);
  });

  app.post('/v1/reservations/:id/reject', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reservations.reject(currentUser(request), id);
  });

  app.post('/v1/reservations/:id/complete', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    // G-09: the seller must send the buyer's four-digit code; an empty body is still fine for the
    // buyer closing their own trade, so the body is optional here.
    const body = request.body === undefined ? {} : parseInput(completeReservationSchema, request.body);
    return reservations.complete(currentUser(request), id, body.code);
  });

  /**
   * G-09 — the hand-over code, readable by the buyer only. The seller gets 403
   * `DELIVERY_CODE_BUYER_ONLY`, because the whole point is that they have to be told the code.
   */
  app.get('/v1/reservations/:id/delivery-code', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reservations.deliveryCode(currentUser(request), id);
  });

  app.get('/v1/reservations/:id/contact', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reservations.revealContact(currentUser(request), id);
  });

  app.post('/v1/reservations/:id/dispute', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: unknown };
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
    return reservations.dispute(currentUser(request), id, reason);
  });

  app.post('/v1/reservations/:id/cancel', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseInput(cancelReservationSchema, request.body ?? {});
    return reservations.cancel(currentUser(request), id, body.reason);
  });

  // ---------------------------------------------------------------- chat
  app.get('/v1/chat/conversations', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(paginationSchema, request.query);
    return chat.listMine(currentUser(request), query.limit);
  });

  app.get('/v1/chat/quick-replies', { preHandler: requireAuth }, async () => chat.quickReplies());

  app.get('/v1/orders/:id/conversation', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return chat.openForOrder(currentUser(request), id);
  });

  app.get('/v1/conversations/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return chat.get(currentUser(request), id);
  });

  app.get('/v1/conversations/:id/messages', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const query = parseInput(chatMessagesQuerySchema, request.query);
    return chat.messages(currentUser(request), id, query);
  });

  app.post(
    '/v1/conversations/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = parseInput(sendMessageSchema, request.body);
      const created = await chat.send(currentUser(request), id, body);
      return reply.status(201).send(created);
    },
  );

  app.post('/v1/conversations/:id/contact', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const created = await chat.shareContact(currentUser(request), id);
    return reply.status(201).send(created);
  });

  app.post('/v1/conversations/:id/read', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return chat.markRead(currentUser(request), id);
  });

  // -------------------------------------------------------------- billing
  app.get('/v1/plans', { preHandler: requireAuth }, async () => payments.listPlans());

  app.get('/v1/me/subscription', { preHandler: requireAuth }, async (request) =>
    payments.currentSubscription(currentUser(request)),
  );

  app.post('/v1/subscriptions', { preHandler: requireAuth }, async (request, reply) => {
    const body = parseInput(purchaseSubscriptionSchema, request.body);
    const started = await payments.startPurchase(currentUser(request), body);
    return reply.status(201).send(started);
  });

  /**
   * G-26 — what this buyer may do right now: which plan governs them, how many reservations are
   * left this month, and whether the plan includes seeing a number. The app reads it to decide
   * between «رزرو» and «ارتقای اشتراک», so the rule is never re-implemented on the client.
   */
  app.get('/v1/me/entitlements', { preHandler: requireAuth }, async (request) =>
    entitlements.forUser(currentUser(request).id),
  );

  app.get('/v1/payments/mine', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(paginationSchema, request.query);
    return payments.listMine(currentUser(request), query.limit);
  });

  app.get('/v1/payments/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return payments.getPayment(currentUser(request), id);
  });

  app.post('/v1/payments/:id/gateway/callback', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseInput(gatewayCallbackSchema, request.body ?? {});
    return payments.handleGatewayCallback(currentUser(request), id, body);
  });

  /**
   * G-12 — the real gateway callback.
   *
   * Zarinpal redirects the buyer's browser here with `?Authority=…&Status=OK|NOK`; there is no
   * session and no JSON body, and the browser expects a page, not an error envelope. So the handler
   * resolves the invoice → verifies with the bank → and answers with a 302 back into the app, where
   * the plans screen shows the outcome. Every failure mode is a redirect too: a buyer who reaches
   * this URL must always land somewhere they can understand.
   */
  app.get('/v1/payments/gateway/callback', async (request, reply) => {
    const query = (request.query ?? {}) as { Authority?: string; Status?: string };
    const authority = (query.Authority ?? '').trim();
    const returnUrl = config.PAYMENT_RETURN_URL;
    const withOutcome = (outcome: string, invoice: string | null): string => {
      const url = new URL(returnUrl);
      url.searchParams.set('payment', outcome);
      if (invoice) url.searchParams.set('invoice', invoice);
      return url.toString();
    };

    if (authority.length < 8) {
      return reply.redirect(withOutcome('unknown', null), 302);
    }
    let result: Awaited<ReturnType<typeof payments.handleGatewayReturn>>;
    try {
      result = await payments.handleGatewayReturn({ authority, status: query.Status ?? null });
    } catch {
      // A verification that blows up is not a failed payment: the worker still owns the retry.
      return reply.redirect(withOutcome('pending', null), 302);
    }
    const outcome =
      result.outcome === 'PAID'
        ? 'paid'
        : result.outcome === 'FAILED'
          ? 'failed'
          : result.outcome === 'UNKNOWN'
            ? 'unknown'
            : 'pending';
    return reply.redirect(withOutcome(outcome, result.paymentId), 302);
  });

  // ------------------------------------------------- card-to-card (G-11)
  /**
   * The deposit webhook.
   *
   * Unauthenticated by design — the bank's forwarder has no session — but every call must carry
   * `x-benzin-signature: sha256=<hmac of the raw body with CARD_WEBHOOK_SECRET>`. Without a secret
   * configured the route refuses everything: an open money endpoint is worse than a broken one.
   *
   * The answer is 200 even for an unmatched amount, because retries cannot fix it; the deposit is
   * recorded, `UNMATCHED`, and the panel picks it up. A replayed reference is answered 200 as well
   * (`duplicate: true`) so a transfer can never be activated twice.
   */
  app.post('/v1/payments/card/deposits', async (request, reply) => {
    const secret = config.CARD_WEBHOOK_SECRET;
    if (!secret) {
      throw new AppError(
        'CARD_WEBHOOK_DISABLED',
        503,
        'The deposit webhook is not configured on this server',
      );
    }
    const rawBody = request.body as string;
    const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(request.body ?? {});
    const signature = request.headers['x-benzin-signature'];
    if (
      !verifyDepositSignature(
        body,
        Array.isArray(signature) ? signature[0] : signature,
        secret,
      )
    ) {
      throw new AppError('CARD_WEBHOOK_UNAUTHORIZED', 401, 'Invalid webhook signature');
    }
    const parsed = parseInput(cardDepositSchema, JSON.parse(body || '{}'));
    const result = await cardDeposits.handleDeposit({
      amountToman: parsed.amountToman,
      reference: parsed.reference,
      paidAt: parsed.paidAt ? new Date(parsed.paidAt) : clock.now(),
      senderName: parsed.senderName ?? null,
    });
    return reply.status(200).send(result);
  });

  /** Review mode: the buyer sends the tracking number from their banking app. */
  app.post('/v1/payments/:id/card-proof', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseInput(cardProofSchema, request.body ?? {});
    return cardDeposits.submitProof(currentUser(request), id, body);
  });

  // ---------------------------------------------------------- reputation
  app.get('/v1/me/reputation', { preHandler: requireAuth }, async (request) =>
    reputation.summary(currentUser(request).id),
  );

  // G-10: the seller's own answer-rate card. Read-only — silence is shown, not punished.
  app.get('/v1/me/response', { preHandler: requireAuth }, async (request) =>
    ownerResponse.me(currentUser(request).id),
  );

  app.get('/v1/users/:id/reputation', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return reputation.publicProfile(id);
  });

  app.post('/v1/reservations/:id/rating', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseInput(ratingSchema, request.body);
    const rating = await reputation.rate(currentUser(request), id, body);
    return reply.status(201).send(rating);
  });

  // ------------------------------------------------------- notifications
  app.get('/v1/notifications', { preHandler: requireAuth }, async (request) => {
    const query = parseInput(notificationQuerySchema, request.query);
    return notifications.list(currentUser(request), query);
  });

  app.get('/v1/notifications/unread-count', { preHandler: requireAuth }, async (request) =>
    notifications.unreadCount(currentUser(request)),
  );

  app.post('/v1/notifications/read-all', { preHandler: requireAuth }, async (request) =>
    notifications.markAllRead(currentUser(request)),
  );

  app.post('/v1/notifications/:id/read', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return notifications.markRead(currentUser(request), id);
  });

  // ------------------------------------------------------------- admin
  app.get(
    '/v1/admin/settings',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async () => {
      return { settings: await settings.get() };
    },
  );

  app.patch(
    '/v1/admin/settings',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const user = currentUser(request);
      const patch = request.body as Record<string, unknown> | undefined;
      if (!patch || typeof patch !== 'object') throw AppError.validation('Body must be an object');
      return { updated: await settings.update(user.id, patch) };
    },
  );

  // G-15: the plan catalogue, editable from the panel.
  app.get(
    '/v1/admin/plans',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async () => payments.listAllPlans(),
  );

  app.post(
    '/v1/admin/plans',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request, reply) => {
      const body = parseInput(createPlanSchema, request.body);
      const plan = await payments.createPlan(currentUser(request), body);
      return reply.status(201).send(plan);
    },
  );

  app.patch(
    '/v1/admin/plans/:id',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseInput(updatePlanSchema, request.body);
      return payments.updatePlan(currentUser(request), id, body);
    },
  );

  app.delete(
    '/v1/admin/plans/:id',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      return payments.retirePlan(currentUser(request), id);
    },
  );

  app.get(
    '/v1/admin/payments',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const query = parseInput(paymentListSchema, request.query);
      return payments.listAllPayments({ status: query.status ?? null, limit: query.limit });
    },
  );

  app.post(
    '/v1/admin/payments/:id/confirm',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseInput(confirmPaymentSchema, request.body ?? {});
      return payments.confirmPayment(currentUser(request), id, body.reference ?? null);
    },
  );

  app.post(
    '/v1/admin/payments/:id/reject',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseInput(rejectPaymentSchema, request.body);
      return payments.rejectPayment(currentUser(request), id, body.reason);
    },
  );

  /** G-11: transfers nobody is waiting for — money on the books, needs a human. */
  app.get(
    '/v1/admin/card-deposits',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const query = parseInput(depositListSchema, request.query);
      return cardDeposits.listDeposits(query.status ?? null, query.limit, query.offset);
    },
  );

  app.post(
    '/v1/admin/card-deposits/:id/attach',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseInput(attachDepositSchema, request.body ?? {});
      return cardDeposits.attachDeposit(currentUser(request), id, body.paymentId);
    },
  );

  app.get(
    '/v1/admin/payment-cards',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async () => payments.listPaymentCards(),
  );

  app.post(
    '/v1/admin/payment-cards',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request, reply) => {
      const body = parseInput(createPaymentCardSchema, request.body);
      const card = await payments.addPaymentCard(currentUser(request), body);
      return reply.status(201).send(card);
    },
  );

  app.post(
    '/v1/admin/payment-cards/:id/deactivate',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      return payments.deactivatePaymentCard(currentUser(request), id);
    },
  );

  /**
   * G-12 — income report. Defaults to the last 30 days; the panel's revenue card reads it as is.
   */
  app.get('/v1/admin/revenue', { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] }, async (request) => {
    const query = (request.query ?? {}) as { from?: string; to?: string; days?: string };
    const days = query.days ? Number(query.days) : 30;
    // The window follows the application clock so a report and the sweeps always agree on "now".
    const to = query.to ? new Date(query.to) : clock.now();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - Math.min(Math.max(days, 1), 366) * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw AppError.validation('Invalid date range');
    }
    return payments.revenue(from, to);
  });

  app.post(
    '/v1/admin/reconciliation',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async () => payments.reconcile(),
  );

  app.get(
    '/v1/admin/audit',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const query = parseInput(adminAuditQuerySchema, request.query);
      return admin.auditLog(query);
    },
  );

  // ------------------------------------------------------- admin: users (E8-02)
  const staffOnly = [requireAuth, requireRole('ADMIN', 'OWNER')] as const;

  app.get('/v1/admin/users', { preHandler: [...staffOnly] }, async (request) => {
    const query = parseInput(adminUserQuerySchema, request.query);
    return admin.listUsers(query);
  });

  app.get('/v1/admin/users/:id', { preHandler: [...staffOnly] }, async (request) => {
    const { id } = request.params as { id: string };
    return admin.userDetail(id);
  });

  app.patch('/v1/admin/users/:id', { preHandler: [...staffOnly] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseInput(adminUpdateUserSchema, request.body ?? {});
    return admin.updateUser(currentUser(request), id, body);
  });

  // ------------------------------------------------- admin: listing pauses (G-10)
  /** Who is out of the market right now, why, and until when — the review queue for support. */
  app.get('/v1/admin/listing-pauses', { preHandler: [...staffOnly] }, async () =>
    admin.listingPauses(),
  );

  /** Early release: support puts a seller back in the market before the 24 hours are up. */
  app.post('/v1/admin/users/:id/relist', { preHandler: [...staffOnly] }, async (request) => {
    const { id } = request.params as { id: string };
    return admin.relist(currentUser(request), id);
  });

  // ------------------------------------------------------ admin: orders (E8-03)
  app.get('/v1/admin/orders', { preHandler: [...staffOnly] }, async (request) => {
    const query = parseInput(adminOrderQuerySchema, request.query);
    return admin.listOrders(query);
  });

  app.get('/v1/admin/orders/:id', { preHandler: [...staffOnly] }, async (request) => {
    const { id } = request.params as { id: string };
    return admin.orderDetail(id);
  });

  app.post('/v1/admin/orders/:id/resolve', { preHandler: [...staffOnly] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseInput(adminResolveDisputeSchema, request.body);
    return admin.resolveDispute(currentUser(request), id, body);
  });

  // ----------------------------------------------- admin: subscriptions (E8-04)
  app.get('/v1/admin/subscriptions', { preHandler: [...staffOnly] }, async (request) => {
    const query = parseInput(adminSubscriptionQuerySchema, request.query);
    return admin.listSubscriptions(query);
  });

  // --------------------------------------- admin: dashboard and status (E8-08)
  app.get('/v1/admin/dashboard', { preHandler: [...staffOnly] }, async () => admin.dashboard());

  // Sweep health (task G-02): when the last expiry pass ran and what it changed. A stalled
  // scheduler is the failure mode that silently leaves reservations holding lots.
  app.get('/v1/admin/scheduler', { preHandler: [...staffOnly] }, async () => {
    const last = scheduler.lastTick();
    return {
      intervalMs: config.SCHEDULER_INTERVAL_MS,
      lastTickAt: last ? last.at.toISOString() : null,
      lastResult: last ? last.result : null,
      lock: config.DATABASE_URL ? 'postgres-advisory' : 'in-process',
    };
  });

  app.post('/v1/admin/scheduler/tick', { preHandler: [...staffOnly] }, async () => {
    const result = await scheduler.tick();
    return { ran: result !== null, result };
  });
  // ------------------------------------------------------- infrastructure (task G-13)
  // The health board and the inventory are one screen: during an incident the owner needs the
  // colour of the check *and* the address of the thing behind it.
  app.get('/v1/admin/infra', { preHandler: [...staffOnly] }, async () => infra.overview());

  app.post(
    '/v1/admin/infra',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request, reply) => {
      const body = parseInput(createInfraResourceSchema, request.body);
      const created = await infra.create(currentUser(request), body);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/v1/admin/infra/:id',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseInput(updateInfraResourceSchema, request.body);
      return infra.update(currentUser(request), id, body);
    },
  );

  app.delete(
    '/v1/admin/infra/:id',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OWNER')] },
    async (request) => {
      const { id } = request.params as { id: string };
      return infra.remove(currentUser(request), id);
    },
  );

  app.get('/v1/admin/status', { preHandler: [...staffOnly] }, async () => admin.systemStatus());

  // ------------------------------------------------------ node monitor (task G-28)
  // The panel's live screen: every node that ever reported, its resources, its traffic and the
  // jobs it ran, plus the failover verdict ("is the helper needed right now?").
  app.get('/v1/admin/nodes', { preHandler: [...staffOnly] }, async () => nodes.overview());

  // Agent endpoints. They carry a shared secret instead of a user token: the caller is a machine
  // (the owner's standby PC), not a person, and it must keep working with nobody logged in.
  const nodeTokenGuard = async (request: FastifyRequest): Promise<void> => {
    if (!config.NODE_TOKEN) {
      throw new AppError(
        'NODE_AGENT_DISABLED',
        503,
        'NODE_TOKEN تنظیم نشده؛ پذیرش گرهٔ خارجی خاموش است',
      );
    }
    if (request.headers['x-node-token'] !== config.NODE_TOKEN) {
      throw new AppError('NODE_TOKEN_INVALID', 401, 'توکن گره نامعتبر است');
    }
  };

  app.get('/v1/nodes/failover', { preHandler: [nodeTokenGuard] }, async (request) => {
    const query = request.query as { nodeId?: string } | undefined;
    const decision = await nodes.failover();
    return {
      nodeId: query?.nodeId ?? null,
      staleAfterSeconds: config.NODE_STALE_SECONDS,
      serverTime: clock.now().toISOString(),
      ...decision,
    };
  });

  app.post('/v1/nodes/heartbeat', { preHandler: [nodeTokenGuard] }, async (request) => {
    const body = parseInput(nodeHeartbeatSchema, request.body ?? {});
    return nodes.ingest(body);
  });

  // ------------------------------------------------ admin: providers (E8-06)
  app.get('/v1/admin/providers', { preHandler: [...staffOnly] }, async () => admin.listProviders());

  app.put('/v1/admin/providers', { preHandler: [...staffOnly] }, async (request) => {
    const body = parseInput(providerSettingSchema, request.body);
    return admin.saveProvider(currentUser(request), body);
  });

  app.post(
    '/v1/admin/providers/:kind/:provider/test',
    { preHandler: [...staffOnly] },
    async (request) => {
      const { kind, provider } = request.params as { kind: string; provider: string };
      const body = parseInput(providerTestSchema, request.body ?? {});
      if (kind !== 'SMS' && kind !== 'PAYMENT' && kind !== 'MAP') {
        throw AppError.notFound('PROVIDER_NOT_FOUND', 'Unknown provider kind');
      }
      return admin.testProvider(currentUser(request), kind, provider, body.phone);
    },
  );


  // ------------------------------------------------------------ SMS panel (task G-14)
  // The chain the platform will actually walk, what it holds, and a button that proves it works.
  app.get('/v1/admin/sms', { preHandler: [...staffOnly] }, async () => services.sms.status());

  app.post(
    '/v1/admin/sms/test',
    { preHandler: [...staffOnly] },
    async (request) => {
      const body = parseInput(smsTestSchema, request.body ?? {});
      return services.sms.testSend(currentUser(request), body.phone, body.provider);
    },
  );

  // ---------------------------------------------------- admin: cities (E8-07)
  app.get('/v1/admin/zones', { preHandler: [...staffOnly] }, async () => admin.listZones());

  app.put('/v1/admin/zones', { preHandler: [...staffOnly] }, async (request) => {
    const body = parseInput(zoneUpsertSchema, request.body);
    return admin.saveZone(currentUser(request), { ...body, boundary: [...body.boundary] });
  });

  return { app, services, chatSocket, scheduler };
}
