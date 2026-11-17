#!/usr/bin/env node
/**
 * G-22 — the whole journey, end to end, against a real API.
 *
 *   node scripts/smoke-happy-path.mjs                            # installed app (41721)
 *   API=http://127.0.0.1:4301 node scripts/smoke-happy-path.mjs   # dev server
 *
 * The acceptance line for this task is blunt: *if this script is green, the product is ready to be
 * run.* So it does not reuse the smoke accounts and it does not skip the money: it signs up a **new
 * buyer** and a **new seller**, lists fuel, pays for a subscription through the card-to-card
 * **review** path (the buyer submits a tracking number, an operator approves it in the panel — the
 * only path that works without a bank feed), then trades to completion and reads the audit trail.
 *
 * Beyond the two fresh accounts it needs:
 *   • an operator, to switch the card mode to `review`, approve the transfer and read the audit log
 *     (`SMOKE_OPERATOR`, defaults to the owner account the dev seed creates) — switched back at the
 *     end, even though that happens only if the run reaches the last step;
 *   • the pinned dev OTP (`SMOKE_OTP`, default 12345; the API needs `DEV_FIXED_OTP` set).
 *
 * Everything it creates belongs to phones nobody else uses (`0901…`/`0902…` + a per-run suffix), so
 * it can be run again and again on the same database without cleaning up after itself.
 */

const API = (process.env.API ?? 'http://127.0.0.1:41721').replace(/\/$/, '');
const OPERATOR_PHONE = process.env.SMOKE_OPERATOR ?? '09187888993';
const OTP = process.env.SMOKE_OTP ?? '12345';
const PLACE = {
  province: process.env.SMOKE_PROVINCE ?? 'کردستان',
  county: process.env.SMOKE_COUNTY ?? 'بانه',
};

/** Fresh phones per run: 0901/0902 + 7 digits, so two concurrent runs cannot collide either. */
const suffix = `${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 900 + 100)}`;
const BUYER_PHONE = `0901${suffix}`;
const SELLER_PHONE = `0902${suffix}`;
const TRACKING = `HAPPY-${suffix}`;

let passed = 0;
const failures = [];

const call = async (method, path, { token, body } = {}) => {
  // `globalThis.fetch` rather than a bare `fetch`: the flat ESLint config does not declare the
  // global, and the sibling smoke script already trips that rule.
  const response = await globalThis.fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
};

const step = async (name, fn) => {
  try {
    const detail = await fn();
    passed += 1;
    const shown = typeof detail === 'string' && detail.length > 0 ? ` — ${detail}` : '';
    console.log(`  ✔ ${name}${shown}`);
    return true;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✘ ${name} — ${error.message}`);
    return false;
  }
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const login = async (phone, deviceId) => {
  const requested = await call('POST', '/v1/auth/otp/request', { body: { phone } });
  // 429 = the cooldown of an earlier request is still armed; the stored challenge is still valid.
  expect(
    [200, 201, 202, 429].includes(requested.status),
    `otp request ${requested.status}: ${JSON.stringify(requested.payload)}`,
  );
  const verified = await call('POST', '/v1/auth/otp/verify', {
    body: { phone, code: OTP, device: { platform: 'web', deviceId } },
  });
  expect(
    verified.status === 200 || verified.status === 201,
    `otp verify ${verified.status}: ${JSON.stringify(verified.payload)} — is DEV_FIXED_OTP=${OTP}?`,
  );
  const token = verified.payload?.accessToken;
  expect(typeof token === 'string' && token.length > 20, 'no access token in the verify response');
  return { token, user: verified.payload.user, created: verified.payload.isNewUser === true };
};

console.log(`Benzin happy path → ${API}\n`);
console.log(`  buyer ${BUYER_PHONE} · seller ${SELLER_PHONE} · tracking ${TRACKING}\n`);

// --------------------------------------------------------------------------- 0. server is up
const reachable = await step('healthz', async () => {
  const { status, payload } = await call('GET', '/healthz');
  expect(status === 200, `status ${status}`);
  return `uptime ${payload.uptimeSeconds}s`;
});
if (!reachable) {
  console.log('\nthe API is not reachable — nothing else can be checked');
  process.exit(1);
}

// ------------------------------------------------------------------ 1. operator and the mode
let operator = null;
await step(`OTP login (operator ${OPERATOR_PHONE})`, async () => {
  operator = await login(OPERATOR_PHONE, 'happy-operator');
  expect(
    operator.user?.role === 'OWNER' || operator.user?.role === 'ADMIN',
    `role ${operator.user?.role}`,
  );
  return operator.user.role;
});

let previousMode = 'auto';
await step('the operator switches card transfers to review mode', async () => {
  const current = await call('GET', '/v1/admin/settings', { token: operator.token });
  expect(current.status === 200, `settings ${current.status}: ${JSON.stringify(current.payload)}`);
  previousMode = current.payload?.settings?.['payment.card_mode'] ?? 'auto';
  const patched = await call('PATCH', '/v1/admin/settings', {
    token: operator.token,
    body: { 'payment.card_mode': 'review' },
  });
  expect(patched.status === 200, `patch ${patched.status}: ${JSON.stringify(patched.payload)}`);
  // `updated` is a list of {key, value}; read the settings back so the write is proven, not assumed.
  const changed = (patched.payload?.updated ?? []).find((row) => row.key === 'payment.card_mode');
  expect(
    changed?.value === 'review',
    `the card mode did not change: ${JSON.stringify(patched.payload)}`,
  );
  const after = await call('GET', '/v1/admin/settings', { token: operator.token });
  expect(
    after.payload?.settings?.['payment.card_mode'] === 'review',
    'the card mode did not stick',
  );
  return `«${previousMode}» → review`;
});

// ------------------------------------------------------------------ 2. two brand-new accounts
let buyer = null;
await step(`signup buyer ${BUYER_PHONE}`, async () => {
  buyer = await login(BUYER_PHONE, `happy-buyer-${suffix}`);
  expect(buyer.created, 'the buyer was not created by the first login');
  return `پلن رایگان · ${buyer.user.id.slice(0, 8)}`;
});

let seller = null;
await step(`signup seller ${SELLER_PHONE}`, async () => {
  seller = await login(SELLER_PHONE, `happy-seller-${suffix}`);
  expect(seller.created, 'the seller was not created by the first login');
  return `پلن رایگان · ${seller.user.id.slice(0, 8)}`;
});

let zoneId = null;
await step('resolve the Baneh zone', async () => {
  const { status, payload } = await call('GET', '/v1/zones', { token: seller?.token });
  expect(status === 200, `status ${status}`);
  const items = payload?.items ?? payload;
  expect(Array.isArray(items) && items.length > 0, 'no zones');
  const zone = items.find((item) => (item.slug ?? '') === 'baneh') ?? items[0];
  expect(zone?.id, 'zone id missing');
  zoneId = zone.id;
  return `${zone.nameFa ?? zone.slug} (${items.length} ناحیه)`;
});

const ready = Boolean(operator && buyer && seller && zoneId);
if (!ready) {
  console.log('\nsetup failed — an operator, two accounts and a zone are all required');
  console.log(`\n${passed}/${passed + failures.length} passed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

// --------------------------------------------------------------- 3. the seller lists fuel
let order = null;
await step('seller: POST /v1/orders (SELL 60L)', async () => {
  const body = {
    side: 'SELL',
    tier: 'T3000',
    litres: 60,
    // A SELL listing must sit below the official rate of its tier (3000 for T3000).
    rateToman: 450,
    zoneId,
    province: PLACE.province,
    county: PLACE.county,
    stationName: 'جایگاه سوخت شهید باکری',
    note: 'مسیر کامل G-22',
    location: { lat: 35.99, lng: 45.9 },
    deliveryMethod: 'FUEL_CARD',
  };
  let result = await call('POST', '/v1/orders', { token: seller.token, body });
  if (result.status === 422 && result.payload?.error?.code === 'ZONE_MISMATCH') {
    // The point belongs to another zone than the one this database calls «baneh». The server is
    // right to refuse, so the listing goes up on the zone alone.
    const { location: _point, ...withoutPoint } = body;
    result = await call('POST', '/v1/orders', { token: seller.token, body: withoutPoint });
  }
  expect(result.status === 201, `status ${result.status}: ${JSON.stringify(result.payload)}`);
  expect(result.payload.id, 'order id missing');
  expect(result.payload.status === 'OPEN', `status ${result.payload.status}`);
  order = result.payload;
  return `#${order.id.slice(0, 8)} · ۶۰ لیتر · ${order.status}`;
});

await step('buyer: the listing appears in the market', async () => {
  expect(order, 'no listing was created');
  const { status, payload } = await call(
    'GET',
    `/v1/orders?side=SELL&province=${encodeURIComponent(PLACE.province)}&sort=newest&limit=50`,
    { token: buyer.token },
  );
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  const items = payload?.items ?? [];
  expect(
    items.some((item) => item.id === order.id),
    `the fresh listing is not in the market list (${items.length} rows)`,
  );
  const card = items.find((item) => item.id === order.id);
  expect(card.owner?.labelFa, 'the seller badge is missing');
  return `${items.length} آگهی · نشان «${card.owner.labelFa}»`;
});

// ------------------------------------- 4. the buyer pays for the subscription (review mode)
let pending = null;
await step('buyer: POST /v1/subscriptions (CARD_TO_CARD)', async () => {
  const { status, payload } = await call('POST', '/v1/subscriptions', {
    token: buyer.token,
    body: { planCode: 'monthly', method: 'CARD_TO_CARD' },
  });
  expect(status === 201 || status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.id, 'payment id missing');
  expect(payload.status === 'PENDING', `payment ${payload.status}`);
  expect(typeof payload.destination?.cardNumber === 'string', 'no destination card');
  expect(payload.uniqueAmountToman > payload.amountToman, 'the amount carries no unique suffix');
  expect(payload.instructionFa?.length > 0, 'no Persian instruction line');
  pending = payload;
  return `${payload.amountLabelFa} · یکتا ${payload.uniqueAmountToman.toLocaleString('fa-IR')}`;
});

await step('buyer: transfers the unique amount and submits the tracking number', async () => {
  expect(pending, 'no invoice to pay');
  const { status, payload } = await call('POST', `/v1/payments/${pending.id}/card-proof`, {
    token: buyer.token,
    body: { trackingNumber: TRACKING },
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.status === 'NEEDS_REVIEW', `status ${payload.status}`);
  expect(payload.queued === true, 'the payment did not queue for review');
  return `NEEDS_REVIEW · ${TRACKING}`;
});

await step('the transfer shows up in the operator queue', async () => {
  const { status, payload } = await call(
    'GET',
    '/v1/admin/payments?status=NEEDS_REVIEW&limit=100',
    {
      token: operator.token,
    },
  );
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  const items = payload?.items ?? [];
  expect(
    items.some((item) => item.id === pending.id),
    `the submitted transfer is not in the review queue (${items.length} rows)`,
  );
  return `${items.length} در صف`;
});

await step('operator: confirms the transfer', async () => {
  const { status, payload } = await call('POST', `/v1/admin/payments/${pending.id}/confirm`, {
    token: operator.token,
    body: { reference: TRACKING },
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.payment?.status === 'PAID', `payment ${payload.payment?.status}`);
  expect(payload.payment.reference === TRACKING, `reference ${payload.payment?.reference}`);
  // Settling is not just a flag: the pending subscription has to come to life in the same move.
  expect(payload.subscription, 'no subscription was activated');
  expect(payload.subscription.status === 'ACTIVE', `subscription ${payload.subscription.status}`);
  expect(payload.subscription.planCode === 'monthly', `plan ${payload.subscription.planCode}`);
  return `PAID · ${payload.subscription.planCode} ACTIVE · ${payload.subscription.daysRemaining} روز`;
});

await step('buyer: the plan is now in force', async () => {
  const entitlement = await call('GET', '/v1/me/entitlements', { token: buyer.token });
  expect(entitlement.status === 200, `status ${entitlement.status}`);
  const view = entitlement.payload;
  expect(view.planCode === 'monthly', `plan ${view.planCode}`);
  expect(
    view.source === 'SUBSCRIPTION' && view.active === true,
    'the paid plan is not the binding one',
  );
  expect(view.phoneVisible === true, 'a paid plan must include the number');
  expect(view.remaining === null, `remaining ${view.remaining} (this plan is unlimited)`);
  const current = await call('GET', '/v1/me/subscription', { token: buyer.token });
  expect(current.status === 200, `subscription ${current.status}`);
  const live = current.payload?.subscription;
  expect(live, 'GET /v1/me/subscription returns nothing after a paid invoice');
  expect(live.status === 'ACTIVE', `status ${live.status}`);
  expect(live.planCode === 'monthly', `plan ${live.planCode}`);
  expect(live.daysRemaining > 0, `daysRemaining ${live.daysRemaining}`);
  return `${view.planNameFa} · نامحدود · ${live.daysRemaining} روز`;
});

await step('the same invoice cannot be approved twice', async () => {
  const { status, payload } = await call('POST', `/v1/admin/payments/${pending.id}/confirm`, {
    token: operator.token,
    body: { reference: TRACKING },
  });
  expect(status === 409, `expected 409, got ${status}`);
  expect(payload?.error?.code === 'PAYMENT_ALREADY_SETTLED', `code ${payload?.error?.code}`);
  return '409 PAYMENT_ALREADY_SETTLED';
});

await step('the reconciler has nothing to repair after a clean run', async () => {
  // POST, not GET: this is the nightly job, and running it here is the honest check — an approval
  // that left the books consistent must produce a report with nothing healed.
  const { status, payload } = await call('POST', '/v1/admin/reconciliation', {
    token: operator.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  for (const key of [
    'expiredPayments',
    'healedPayments',
    'expiredSubscriptions',
    'retriedVerifications',
    'verifiedPayments',
  ]) {
    expect(typeof payload[key] === 'number', `${key} is not a number`);
  }
  expect(
    payload.healedPayments === 0,
    `the reconciler had to heal ${payload.healedPayments} payment(s)`,
  );
  return 'همهٔ شمارنده‌ها عدد · بدون ترمیم';
});

// ------------------------------------------------------------- 5. reservation → completed
let reservation = null;
await step('buyer: reserves the lot', async () => {
  expect(order, 'no listing to reserve');
  const { status, payload } = await call('POST', `/v1/orders/${order.id}/reservations`, {
    token: buyer.token,
  });
  expect(status === 201 || status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.id, 'reservation id missing');
  expect(payload.status === 'PENDING_OWNER', `status ${payload.status}`);
  reservation = payload;
  return `#${reservation.id.slice(0, 8)} · ${reservation.status}`;
});

await step('seller: accepts the reservation', async () => {
  const { status, payload } = await call('POST', `/v1/reservations/${reservation.id}/confirm`, {
    token: seller.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.status === 'CONFIRMED', `status ${payload.status}`);
  return payload.status;
});

await step('buyer: the paid plan hands out the number; the unpaid seller gets 402', async () => {
  const mine = await call('GET', `/v1/reservations/${reservation.id}/contact`, {
    token: buyer.token,
  });
  expect(mine.status === 200, `status ${mine.status}: ${JSON.stringify(mine.payload)}`);
  expect(mine.payload.hidden?.owner === false, 'the seller profile is unexpectedly private');
  expect(mine.payload.owner?.phone === SELLER_PHONE, 'the buyer did not receive the seller number');
  const reverse = await call('GET', `/v1/reservations/${reservation.id}/contact`, {
    token: seller.token,
  });
  expect(
    reverse.status === 402 && reverse.payload?.error?.code === 'PHONE_REQUIRES_SUBSCRIPTION',
    `the free-plan seller got ${reverse.status} instead of 402`,
  );
  return 'خریدار شماره را دید · فروشنده 402';
});

let deliveryCode = '';
await step('buyer: reads the four-digit hand-over code', async () => {
  const { status, payload } = await call(
    'GET',
    `/v1/reservations/${reservation.id}/delivery-code`,
    {
      token: buyer.token,
    },
  );
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(/^\d{4}$/.test(payload?.code ?? ''), `code ${payload?.code}`);
  const sellerView = await call('GET', `/v1/reservations/${reservation.id}/delivery-code`, {
    token: seller.token,
  });
  expect(sellerView.status === 403, `the seller must not see the code, got ${sellerView.status}`);
  deliveryCode = payload.code;
  return `کد ۴ رقمی · فروشنده 403`;
});

await step('seller: completes the trade with the code', async () => {
  const { status, payload } = await call('POST', `/v1/reservations/${reservation.id}/complete`, {
    token: seller.token,
    body: { code: deliveryCode },
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(['COMPLETED', 'AUTO_COMPLETED'].includes(payload.status), `status ${payload.status}`);
  return payload.status;
});

await step('both sides see the trade as finished', async () => {
  const detail = await call('GET', `/v1/orders/${order.id}`, { token: buyer.token });
  expect(detail.status === 200, `order ${detail.status}`);
  expect(detail.payload.status === 'COMPLETED', `order status ${detail.payload.status}`);
  const mine = await call('GET', '/v1/reservations/mine?limit=10', { token: buyer.token });
  expect(mine.status === 200, `mine ${mine.status}`);
  const row = (mine.payload?.items ?? []).find((item) => item.id === reservation.id);
  expect(row, 'the reservation is missing from the buyer list');
  expect(['COMPLETED', 'AUTO_COMPLETED'].includes(row.status), `reservation ${row.status}`);
  return 'order COMPLETED · reservation COMPLETED';
});

await step('buyer: rates the seller', async () => {
  const { status, payload } = await call('POST', `/v1/reservations/${reservation.id}/rating`, {
    token: buyer.token,
    body: { stars: 5, comment: 'معامله سر وقت' },
  });
  expect(status === 201 || status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.stars === 5, `stars ${payload.stars}`);
  const reputation = await call('GET', '/v1/me/reputation', { token: seller.token });
  expect(reputation.status === 200, `reputation ${reputation.status}`);
  return '۵ ستاره';
});

// ------------------------------------------------------------------- 6. the audit trail proves it
await step('the audit log tells the whole story', async () => {
  const { status, payload } = await call('GET', '/v1/admin/audit?limit=200', {
    token: operator.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  const entries = payload?.items ?? [];
  expect(entries.length > 0, 'the audit log is empty');
  const actions = new Set(entries.map((entry) => entry.action));
  const required = [
    'auth.registered',
    'order.created',
    'payment.created',
    'payment.proof_submitted',
    'payment.paid',
    'reservation.requested',
    'reservation.confirmed',
    'contact.revealed',
    'reservation.completed',
  ];
  const missing = required.filter((action) => !actions.has(action));
  expect(missing.length === 0, `missing audit actions: ${missing.join(', ')}`);

  // The approval must be attributable to the operator, not to the buyer who sent the money.
  const paid = entries.find(
    (entry) => entry.action === 'payment.paid' && entry.entityId === pending.id,
  );
  expect(paid, 'the settled payment has no audit row');
  expect(paid.actorId === operator.user.id, 'the approval is not attributed to the operator');
  return `${entries.length} ردیف · ${required.length} اقدام کلیدی`;
});

await step('the audit log can be narrowed to this trade', async () => {
  const { status, payload } = await call('GET', '/v1/admin/audit?entity=reservation&limit=200', {
    token: operator.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  const entries = payload?.items ?? [];
  expect(
    entries.some((entry) => entry.entityId === reservation.id),
    'the reservation has no audit rows',
  );
  const own = entries
    .filter((entry) => entry.entityId === reservation.id)
    .map((entry) => entry.action);
  return `${own.length} ردیف برای این معامله`;
});

// ------------------------------------------------------------------ 7. put the server back
await step('the operator restores the previous card mode', async () => {
  const { status, payload } = await call('PATCH', '/v1/admin/settings', {
    token: operator.token,
    body: { 'payment.card_mode': previousMode },
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  const after = await call('GET', '/v1/admin/settings', { token: operator.token });
  expect(
    after.payload?.settings?.['payment.card_mode'] === previousMode,
    'the mode was not restored',
  );
  return `«${previousMode}»`;
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(
  'the full journey works: signup → listing → paid subscription → reservation → code → completed → audited',
);
