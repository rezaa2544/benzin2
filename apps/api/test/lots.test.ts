import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestContext, login, orderPayload, type TestContext } from './helpers.js';

/**
 * G-05 — standard lots and matching.
 *
 * The market must answer three different questions: "I want exactly 40 litres", "I want between
 * 20 and 40", and "40 is gone — what is close?". The third one is a server answer, not a client
 * guess, so the same copy reaches the app and the admin panel.
 */
describe('lot matching (G-05)', () => {
  let ctx: TestContext;

  const createOrder = async (token: string, payload: Record<string, unknown>): Promise<string> => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(token),
      payload: orderPayload(payload),
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json() as { id: string }).id;
  };

  const search = async (token: string, query: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/orders?${qs}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      items: { id: string; litres: number; buyerRateToman: number }[];
      nearest: { litres: number; items: { litres: number }[] } | null;
      message: string | null;
    };
  };

  let buyer: string;
  let phoneSeq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    buyer = (await login(ctx, '09125550002')).token;
    // A spread of lots so exact, range and nearest-fallback all have something to chew on. Each
    // lot needs its own seller: the open-order cap is two per user.
    for (const [litres, rateToman] of [
      [10, 2600],
      [20, 2500],
      [42, 2450],
      [60, 2700],
    ] as const) {
      const seller = (await login(ctx, `0912555100${phoneSeq++}`)).token;
      await createOrder(seller, { litres, rateToman });
    }
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('filters an exact lot', async () => {
    const result = await search(buyer, { side: 'SELL', litres: 20, litresMode: 'exact' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.litres).toBe(20);
    expect(result.message).toBeNull();
  });

  it('answers a missing lot with the closest lots inside ten percent', async () => {
    // 40 litres was never listed; 42 is inside +-10% and must come back as a suggestion.
    const result = await search(buyer, { side: 'SELL', litres: 40, litresMode: 'exact' });
    expect(result.items).toHaveLength(0);
    expect(result.nearest?.litres).toBe(40);
    expect(result.nearest?.items.map((item) => item.litres)).toEqual([42]);
    expect(result.message).toContain('۴۰ لیتر موجود نیست');
    expect(result.message).toContain('نزدیک‌ترین');
  });

  it('says so plainly when nothing is even close', async () => {
    const result = await search(buyer, { side: 'SELL', litres: 200, litresMode: 'exact' });
    expect(result.items).toHaveLength(0);
    expect(result.nearest).toBeNull();
    expect(result.message).toContain('۲۰۰ لیتر موجود نیست');
  });

  it('filters a between range inclusively', async () => {
    const result = await search(buyer, {
      side: 'SELL',
      litresMode: 'range',
      minLitres: 10,
      maxLitres: 42,
    });
    expect(result.items.map((item) => item.litres).sort((a, b) => a - b)).toEqual([10, 20, 42]);
  });

  it('always orders matches by the all-in price of one litre, ascending', async () => {
    const result = await search(buyer, {
      side: 'SELL',
      litresMode: 'range',
      minLitres: 1,
      maxLitres: 60,
      sort: 'price',
    });
    const prices = result.items.map((item) => item.buyerRateToman);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('rejects a range that runs backwards', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/orders?side=SELL&litresMode=range&minLitres=50&maxLitres=10',
      headers: auth(buyer),
    });
    expect(response.statusCode).toBe(422);
  });
});
