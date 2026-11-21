import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestContext, login, type TestContext } from './helpers.js';

const json = <T>(response: { json: () => unknown }): T => response.json() as T;

const register = (ctx: TestContext, token: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/v1/me/devices', headers: auth(token), payload });

/**
 * G-16 — the push-token hand-off.
 *
 * The token only exists after the user has signed in, so it cannot ride along with the OTP
 * request. The app posts it; the server upserts one row per (user, deviceId). Every assertion
 * here is about what stops a stale or forged row from receiving somebody else's notifications.
 */
describe('device registration for push (G-16)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stores an FCM token for the signed-in user and lists it back', async () => {
    const { token } = await login(ctx, '09121230001');

    const response = await register(ctx, token, {
      platform: 'android',
      deviceId: 'android-4f8c1d9a7b2e',
      pushToken: 'fcm-token-abc123',
      appVersion: '1.0.0',
    });
    expect(response.statusCode).toBe(200);
    const device = json<{ id: string; pushRegistered: boolean }>(response);
    expect(device.pushRegistered).toBe(true);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/devices',
      headers: auth(token),
    });
    const items = json<{ items: Array<{ deviceId: string; platform: string }> }>(listed).items;
    expect(items.some((row) => row.deviceId === 'android-4f8c1d9a7b2e')).toBe(true);
  });

  it('updates the token in place instead of stacking rows when it rotates', async () => {
    const { token } = await login(ctx, '09121230002');
    const first = await register(ctx, token, {
      platform: 'android',
      deviceId: 'android-rotate-0001',
      pushToken: 'fcm-old',
    });
    const second = await register(ctx, token, {
      platform: 'android',
      deviceId: 'android-rotate-0001',
      pushToken: 'fcm-new',
    });

    expect(json<{ id: string }>(first).id).toBe(json<{ id: string }>(second).id);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/devices',
      headers: auth(token),
    });
    const matching = json<{ items: Array<{ deviceId: string }> }>(listed).items.filter(
      (row) => row.deviceId === 'android-rotate-0001',
    );
    expect(matching).toHaveLength(1);
  });

  it('keeps the stored token when the app registers without one', async () => {
    const { token } = await login(ctx, '09121230003');
    await register(ctx, token, {
      platform: 'android',
      deviceId: 'android-keep-00001',
      pushToken: 'fcm-keep-me',
    });
    // A heartbeat that has not got a token yet must not wipe the one that works.
    const second = await register(ctx, token, {
      platform: 'android',
      deviceId: 'android-keep-00001',
    });
    expect(json<{ pushRegistered: boolean }>(second).pushRegistered).toBe(true);
  });

  it('refuses a junk deviceId and an unknown platform', async () => {
    const { token } = await login(ctx, '09121230004');

    const short = await register(ctx, token, { platform: 'android', deviceId: 'x' });
    expect(short.statusCode).toBe(422);
    expect(json<{ error: { code: string } }>(short).error.code).toBe('VALIDATION_ERROR');

    const spaced = await register(ctx, token, {
      platform: 'android',
      deviceId: 'has spaces and /slashes/',
    });
    expect(spaced.statusCode).toBe(422);

    const platform = await register(ctx, token, {
      platform: 'windows-phone',
      deviceId: 'android-00000001',
    });
    expect(platform.statusCode).toBe(422);
    expect(json<{ error: { details: { field: string } } }>(platform).error.details.field).toBe(
      'platform',
    );
  });

  it('requires a session — an anonymous caller cannot attach a token to anybody', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/me/devices',
      payload: { platform: 'android', deviceId: 'android-anon-0001', pushToken: 'x' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('never shows one user the devices of another', async () => {
    const owner = await login(ctx, '09121230006');
    const stranger = await login(ctx, '09121230007');
    await register(ctx, owner.token, {
      platform: 'android',
      deviceId: 'android-private-01',
      pushToken: 'fcm-private',
    });

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/devices',
      headers: auth(stranger.token),
    });
    const items = json<{ items: Array<{ deviceId: string }> }>(listed).items;
    expect(items.some((row) => row.deviceId === 'android-private-01')).toBe(false);
  });
});
