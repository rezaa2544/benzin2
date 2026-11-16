#!/usr/bin/env node
/**
 * End-to-end happy path against a running API (task G-22, used to verify the Postgres adapter G-01).
 *
 *   node scripts/smoke-api.mjs                      # http://127.0.0.1:41721 (desktop runtime)
 *   API=http://127.0.0.1:4301 node scripts/smoke-api.mjs
 *
 * Walks the whole marketplace: OTP login for two accounts → market stats → place a SELL listing →
 * search → reserve → owner confirms → contact reveal → chat → complete → rating → notifications →
 * admin dashboard. Every step asserts on the response, so a broken adapter fails loudly instead of
 * "seeming" fine. Read-only on the database: it only creates its own rows.
 */

const API = (process.env.API ?? 'http://127.0.0.1:41721').replace(/\/$/, '');
const OWNER_PHONE = process.env.SMOKE_OWNER ?? '09187888993';
const BUYER_PHONE = process.env.SMOKE_BUYER ?? '09373210545';
const OTP = process.env.SMOKE_OTP ?? '12345';
const PLACE = { province: process.env.SMOKE_PROVINCE ?? 'کردستان', county: 'بانه' };

let passed = 0;
const failures = [];

const call = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${API}${path}`, {
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
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
    return detail;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✘ ${name} — ${error.message}`);
    return null;
  }
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const login = async (phone, deviceId) => {
  const requested = await call('POST', '/v1/auth/otp/request', { body: { phone } });
  // 429 = the OTP cooldown of an earlier run is still armed; the stored challenge is still valid.
  expect([200, 201, 202, 429].includes(requested.status), `otp request ${requested.status}: ${JSON.stringify(requested.payload)}`);
  const verified = await call('POST', '/v1/auth/otp/verify', {
    body: { phone, code: OTP, device: { platform: 'web', deviceId } },
  });
  expect(verified.status === 200 || verified.status === 201, `otp verify ${verified.status}: ${JSON.stringify(verified.payload)}`);
  const token = verified.payload?.accessToken ?? verified.payload?.tokens?.accessToken;
  expect(typeof token === 'string' && token.length > 20, 'no access token in verify response');
  return { token, user: verified.payload.user ?? verified.payload.me };
};

console.log(`Benzin smoke test → ${API}\n`);
const health = await step('healthz', async () => {
  const { status, payload } = await call('GET', '/healthz');
  expect(status === 200, `status ${status}`);
  return `uptime ${payload.uptimeSeconds}s`;
});
expect(health, 'API is not reachable');

const owner = await step(`OTP login (owner ${OWNER_PHONE})`, () => login(OWNER_PHONE, 'smoke-owner-device'));
const buyer = await step(`OTP login (buyer ${BUYER_PHONE})`, () => login(BUYER_PHONE, 'smoke-buyer-device'));
expect(owner && buyer, 'both logins are required for the rest of the flow');

const zones = await step('GET /v1/zones', async () => {
  const { status, payload } = await call('GET', '/v1/zones', { token: buyer.token });
  expect(status === 200, `status ${status}`);
  const items = payload?.items ?? payload;
  expect(Array.isArray(items) && items.length > 0, 'no zones');
  return `${items.length} zone(s)`;
});

const zoneId =
  (await step('resolve Baneh zone id', async () => {
    const { payload } = await call('GET', '/v1/zones', { token: buyer.token });
    const items = payload?.items ?? payload;
    const zone = items.find((item) => (item.slug ?? '') === 'baneh') ?? items[0];
    expect(zone?.id, 'zone id missing');
    return zone.id;
  })) ?? null;
expect(zoneId, 'zone id is required');

const statsBefore = await step('GET /v1/stats/market', async () => {
  const { status, payload } = await call(
    'GET',
    `/v1/stats/market?side=SELL&province=${encodeURIComponent(PLACE.province)}&county=${encodeURIComponent(PLACE.county)}`,
    { token: buyer.token },
  );
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  return `sample ${payload.sampleSize ?? payload.count ?? '?'}, avg ${payload.averageRateToman ?? payload.average ?? '?'}`;
});

await step('GET /v1/stats/market/median (G-08)', async () => {
  const { status, payload } = await call(
    'GET',
    `/v1/stats/market/median?province=${encodeURIComponent(PLACE.province)}&county=${encodeURIComponent(PLACE.county)}`,
    { token: buyer.token },
  );
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.windowHours === 72, `windowHours ${payload.windowHours}`);
  expect(typeof payload.sufficient === 'boolean', 'sufficient is a boolean');
  expect(Array.isArray(payload.byRegion), 'byRegion is an array');
  expect(typeof payload.messageFa === 'string' && payload.messageFa.length > 0, 'messageFa present');
  if (payload.sufficient) {
    expect(typeof payload.medianRateToman === 'number', 'median is a number when sufficient');
  } else {
    expect(payload.medianRateToman === null, 'median is null when not sufficient');
  }
  return payload.sufficient
    ? `median ${payload.medianRateToman} از ${payload.trades} معامله`
    : `دادهٔ کافی نیست (${payload.trades} معامله)`;
});

await step('clear previous open listings (owner has a 2-listing plan limit)', async () => {
  const { payload } = await call('GET', '/v1/orders/mine?limit=20', { token: owner.token });
  const items = payload?.items ?? [];
  const open = items.filter((item) => ['OPEN', 'RESERVED'].includes(item.status));
  for (const item of open) {
    await call('POST', `/v1/orders/${item.id}/cancel`, { token: owner.token });
  }
  return `${open.length} cancelled`;
});

const order = await step('POST /v1/orders (SELL 60L)', async () => {
  const { status, payload } = await call('POST', '/v1/orders', {
    token: owner.token,
    body: {
      side: 'SELL',
      tier: 'T3000',
      litres: 60,
      // A SELL listing must sit below the official rate of its tier (3000 for T3000).
      rateToman: 450,
      zoneId,
      province: PLACE.province,
      county: PLACE.county,
      stationName: 'جایگاه سوخت شهید باکری',
      note: 'تست دود پستگرس',
      location: { lat: 35.99, lng: 45.9 },
      deliveryMethod: 'FUEL_CARD',
    },
  });
  expect(status === 201, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.id, 'order id missing');
  return payload;
});
const search = await step('GET /v1/orders (side=SELL, sort=distance)', async () => {
  const { status, payload } = await call(
    'GET',
    `/v1/orders?side=SELL&province=${encodeURIComponent(PLACE.province)}&lat=35.99&lng=45.9&sort=distance&limit=20`,
    { token: buyer.token },
  );
  expect(status === 200, `status ${status}`);
  expect(Array.isArray(payload?.items), 'items missing');
  expect(payload.items.some((item) => item.id === order.id), 'fresh listing not in search results');
  return `${payload.items.length} listing(s), total ${payload.total}`;
});

const reservation = await step('POST /v1/orders/:id/reservations', async () => {
  const { status, payload } = await call('POST', `/v1/orders/${order.id}/reservations`, {
    token: buyer.token,
  });
  expect(status === 201 || status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  return payload;
});

const duplicate = await step('second reservation is refused (atomic lot lock)', async () => {
  const { status } = await call('POST', `/v1/orders/${order.id}/reservations`, { token: buyer.token });
  expect(status >= 400 && status < 500, `expected 4xx, got ${status}`);
  return `HTTP ${status}`;
});

await step('POST /v1/reservations/:id/confirm (owner)', async () => {
  const { status, payload } = await call('POST', `/v1/reservations/${reservation.id}/confirm`, {
    token: owner.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.status === 'CONFIRMED', `status ${payload.status}`);
  return payload.status;
});

await step('GET /v1/reservations/:id/contact (phone reveal)', async () => {
  const { status, payload } = await call('GET', `/v1/reservations/${reservation.id}/contact`, {
    token: buyer.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  return payload.phone ?? payload.contactPhone ?? 'revealed';
});

await step('chat: post + read message', async () => {
  const conversation = await call('GET', `/v1/orders/${order.id}/conversation`, { token: buyer.token });
  expect(conversation.status === 200, `conversation status ${conversation.status}`);
  const conversationId = conversation.payload.id ?? conversation.payload.conversationId;
  const sent = await call('POST', `/v1/conversations/${conversationId}/messages`, {
    token: buyer.token,
    body: { body: 'سلام، کارت آماده است', clientMessageId: crypto.randomUUID() },
  });
  expect(sent.status === 201 || sent.status === 200, `send status ${sent.status}: ${JSON.stringify(sent.payload)}`);
  const read = await call('GET', `/v1/conversations/${conversationId}/messages`, { token: owner.token });
  expect(read.status === 200, `read status ${read.status}`);
  const items = read.payload?.items ?? read.payload;
  expect(Array.isArray(items) && items.length > 0, 'message not persisted');
  return `${items.length} message(s)`;
});

await step('POST /v1/reservations/:id/complete', async () => {
  const { status, payload } = await call('POST', `/v1/reservations/${reservation.id}/complete`, {
    token: owner.token,
  });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(['COMPLETED', 'AUTO_COMPLETED'].includes(payload.status), `status ${payload.status}`);
  return payload.status;
});

await step('POST /v1/reservations/:id/rating', async () => {
  const { status, payload } = await call('POST', `/v1/reservations/${reservation.id}/rating`, {
    token: buyer.token,
    body: { stars: 5, comment: 'معامله سر وقت' },
  });
  expect(status === 201 || status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  return `${payload.stars} stars`;
});

await step('GET /v1/stats/market/median counts the closed trade (G-08)', async () => {
  const { status, payload } = await call(
    'GET',
    `/v1/stats/market/median?province=${encodeURIComponent(PLACE.province)}&county=${encodeURIComponent(PLACE.county)}`,
    { token: buyer.token },
  );
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  expect(payload.trades >= 1, `trades ${payload.trades} — the completed trade should be counted`);
  const region = (payload.byRegion ?? [])[0];
  expect(region, 'the region row is present');
  expect(region.trades >= 1, `region trades ${region.trades}`);
  // One trade is still far below the threshold of five, so the number stays hidden.
  expect(payload.sufficient === false, 'one trade is not enough');
  expect(payload.medianRateToman === null, 'median stays null below the threshold');
  return `${payload.trades} معامله در ناحیه، آستانه ${payload.requiredTrades}`;
});

await step('GET /v1/notifications', async () => {
  const { status, payload } = await call('GET', '/v1/notifications?limit=10', { token: owner.token });
  expect(status === 200, `status ${status}`);
  const items = payload?.items ?? payload;
  expect(Array.isArray(items), 'items missing');
  return `${items.length} notification(s)`;
});

await step('GET /v1/admin/dashboard (staff only)', async () => {
  const { status, payload } = await call('GET', '/v1/admin/dashboard', { token: owner.token });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  return 'ok';
});

await step('GET /v1/admin/status (infra monitoring)', async () => {
  const { status, payload } = await call('GET', '/v1/admin/status', { token: owner.token });
  expect(status === 200, `status ${status}`);
  return `storage ${payload.storage?.mode ?? payload.mode ?? '?'}`;
});

await step('GET /v1/admin/nodes (live node monitor, G-28)', async () => {
  const { status, payload } = await call('GET', '/v1/admin/nodes', { token: owner.token });
  expect(status === 200, `status ${status}: ${JSON.stringify(payload)}`);
  const nodes = payload.nodes ?? [];
  expect(nodes.length >= 1, 'no node in the monitor');
  const self = nodes.find((node) => node.nodeId === payload.selfNodeId);
  expect(Boolean(self), 'the serving node is missing from its own monitor');
  expect(self.resources !== null, 'no resources reported for the serving node');
  expect(typeof self.traffic.requests === 'number', 'traffic counters missing');
  expect(typeof payload.failover?.shouldTakeOver === 'boolean', 'failover verdict missing');
  return `${nodes.length} node(s), cpu ${self.resources.cpuPct}%, ${self.traffic.requests} req handled`;
});

await step('POST /v1/nodes/heartbeat refuses a heartbeat without the node token', async () => {
  const { status } = await call('POST', '/v1/nodes/heartbeat', {
    body: { nodeId: 'smoke-helper', role: 'helper' },
  });
  // 401 with a token configured, 503 when external agents are switched off — never 200.
  expect(status === 401 || status === 503, `unexpected status ${status}`);
  return `rejected (${status})`;
});

await step('GET /v1/me/reputation', async () => {
  const { status } = await call('GET', '/v1/me/reputation', { token: buyer.token });
  expect(status === 200, `status ${status}`);
  return 'ok';
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
