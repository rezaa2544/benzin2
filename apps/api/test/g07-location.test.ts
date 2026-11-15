import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestContext, login, orderPayload, type TestContext } from './helpers.js';

/**
 * G-07 — location: the city outline the picker draws, distance and ETA on the card, the
 * radius filter, and the promise that the exact point never leaves the server.
 */

/** The seeded Baneh polygon centre and two listings around it. */
const ORIGIN = { lat: 35.9983, lng: 45.8851 };
const NEAR = { lat: 35.9985, lng: 45.8853 };
const FAR = { lat: 36.03, lng: 45.9 };

interface SearchItem {
  id: string;
  location: { lat: number; lng: number; approximate: boolean; precisionMeters: number } | null;
  distance?: {
    distanceKm: number;
    durationMinutes: number;
    etaMinutes: number;
    approximate: boolean;
  };
}

describe('location G-07', () => {
  let ctx: TestContext;
  let viewer: string;
  let nearId: string;
  let farId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    ({ token: viewer } = await login(ctx, '09125550001'));

    const nearSeller = await login(ctx, '09125550002');
    const near = await ctx.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(nearSeller.token),
      payload: orderPayload({ location: NEAR, rateToman: 2_700 }),
    });
    expect(near.statusCode).toBe(201);
    nearId = (near.json() as { id: string }).id;

    const farSeller = await login(ctx, '09125550003');
    const far = await ctx.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(farSeller.token),
      payload: orderPayload({ location: FAR, rateToman: 2_800 }),
    });
    expect(far.statusCode).toBe(201);
    farId = (far.json() as { id: string }).id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  const search = async (query: string) => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/orders?side=SELL&tier=T3000&${query}`,
      headers: auth(viewer),
    });
    return response;
  };

  const ids = async (query: string): Promise<string[]> => {
    const response = await search(query);
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: SearchItem[] }).items.map((item) => item.id);
  };

  it('publishes the city outline so the app can draw a map', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: auth(viewer),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { slug: string; boundary: Array<[number, number]> }[];
    };
    const baneh = body.items.find((zone) => zone.slug === 'baneh');
    expect(baneh).toBeDefined();
    expect(baneh!.boundary.length).toBeGreaterThanOrEqual(3);
    // GeoJSON order: longitude first, latitude second.
    expect(baneh!.boundary[0]![0]).toBeGreaterThan(40);
    expect(baneh!.boundary[0]![1]).toBeLessThan(40);
  });

  it('answers with distance and ETA, never with the exact point', async () => {
    const response = await search(`sort=distance&lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: SearchItem[] }).items;
    const near = items.find((item) => item.id === nearId)!;
    expect(near.distance).toBeDefined();
    expect(near.distance!.distanceKm).toBeGreaterThanOrEqual(0);
    expect(near.distance!.durationMinutes).toBeGreaterThanOrEqual(1);
    expect(near.distance!.etaMinutes).toBeGreaterThanOrEqual(1);
    // The stored point is snapped to a privacy grid before it is returned.
    expect(near.location!.approximate).toBe(true);
    expect(near.location!.lat).not.toBe(NEAR.lat);
    expect(near.location!.lng).not.toBe(NEAR.lng);
    expect(near.location!.precisionMeters).toBeGreaterThanOrEqual(500);
  });

  it('keeps only the listings inside the radius', async () => {
    const withOrigin = `lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&sort=distance`;
    const tight = await ids(`${withOrigin}&radiusKm=1`);
    expect(tight).toContain(nearId);
    expect(tight).not.toContain(farId);

    const wide = await ids(`${withOrigin}&radiusKm=25`);
    expect(wide).toContain(nearId);
    expect(wide).toContain(farId);
  });

  it('refuses a radius without a point instead of silently ignoring it', async () => {
    const response = await search('radiusKm=5');
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('radiusKm');
  });

  it('rejects a point outside the covered cities', async () => {
    const seller = await login(ctx, '09125550004');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(seller.token),
      payload: orderPayload({ location: { lat: 35.6997, lng: 51.338 } }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('ZONE_NOT_SUPPORTED');
  });
});
