import { describe, expect, it, vi } from 'vitest';
import {
  apiBaseUrl,
  appPlatform,
  deviceId,
  isNativeApp,
  nativeGeolocation,
  newDeviceId,
  syncPushToken,
} from '../src/lib/native.js';

/** A fake `window` that only has a Capacitor bridge — exactly what the WebView provides. */
const bridge = (
  overrides: Record<string, unknown> = {},
  plugins: Record<string, unknown> = {},
) => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: plugins,
    ...overrides,
  },
});

describe('native bridge (G-16)', () => {
  it('is off in a browser and on in the WebView', () => {
    expect(isNativeApp({})).toBe(false);
    expect(isNativeApp({ Capacitor: {} })).toBe(false);
    expect(isNativeApp({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
    expect(isNativeApp(bridge())).toBe(true);
    expect(appPlatform(bridge())).toBe('android');
    expect(appPlatform({ Capacitor: { getPlatform: () => 'browser' } })).toBeNull();
  });

  it('gives the shell an absolute API origin and leaves the browser on relative URLs', () => {
    expect(apiBaseUrl(undefined)).toBeUndefined();
    expect(apiBaseUrl('')).toBeUndefined();
    expect(apiBaseUrl('   ')).toBeUndefined();
    expect(apiBaseUrl(' https://benzin.example.com/ ')).toBe('https://benzin.example.com');
    // A bare origin is what ApiClient concatenates `/v1/...` onto, so no trailing slash.
    expect(`${apiBaseUrl('https://benzin.example.com//')}/v1/me`).toBe(
      'https://benzin.example.com/v1/me',
    );
  });

  it('keeps one device id per install and replaces a corrupt one', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;

    const first = deviceId(storage, () => 'android-aaaaaaaaaaaa');
    expect(first).toBe('android-aaaaaaaaaaaa');
    expect(deviceId(storage, () => 'android-bbbbbbbbbbbb')).toBe(first);
    expect(store.get('benzin.deviceId')).toBe(first);

    store.set('benzin.deviceId', 'bad id with spaces');
    expect(deviceId(storage, () => 'android-cccccccccccc')).toBe('android-cccccccccccc');
  });

  it('generates an id the server will accept', () => {
    const generated = newDeviceId();
    expect(generated).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(newDeviceId()).not.toBe(generated);
  });

  it('registers a push token and re-registers when FCM rotates it', async () => {
    const listeners: Array<(payload: { value?: string }) => void> = [];
    const register = vi.fn(async () => undefined);
    const scope = bridge(
      {},
      {
        PushNotifications: {
          requestPermissions: async () => ({ receive: 'granted' }),
          register,
          addListener: (event: string, handler: (payload: { value?: string }) => void) => {
            if (event === 'registration') listeners.push(handler);
            return Promise.resolve({});
          },
        },
      },
    );
    const post = vi.fn(async () => ({ id: 'device-1', pushRegistered: true }));

    await expect(syncPushToken({ scope, register: post })).resolves.toBe('registered');
    expect(register).toHaveBeenCalledOnce();

    listeners[0]?.({ value: 'fcm-token-1' });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('fcm-token-1'));
    // A rotated token must reach the API too, or notifications die silently.
    listeners[0]?.({ value: 'fcm-token-2' });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('fcm-token-2'));
  });

  it('reports a denied permission instead of pretending it registered', async () => {
    const register = vi.fn(async () => ({ id: 'x', pushRegistered: false }));
    const scope = bridge(
      {},
      { PushNotifications: { requestPermissions: async () => ({ receive: 'denied' }) } },
    );
    await expect(syncPushToken({ scope, register })).resolves.toBe('denied');
    expect(register).not.toHaveBeenCalled();
  });

  it('is unsupported in a plain browser and survives a throwing plugin', async () => {
    const register = vi.fn(async () => ({ id: 'x', pushRegistered: false }));
    await expect(syncPushToken({ scope: {}, register })).resolves.toBe('unsupported');

    const scope = bridge(
      {},
      {
        PushNotifications: {
          requestPermissions: async () => {
            throw new Error('no google-services.json');
          },
        },
      },
    );
    await expect(syncPushToken({ scope, register })).resolves.toBe('failed');
  });

  it('asks for the Android permission before returning a native position', async () => {
    const points: Array<{ lat: number; lng: number }> = [];
    const failures: number[] = [];
    const scope = bridge(
      {},
      {
        Geolocation: {
          requestPermissions: async () => ({ location: 'granted' }),
          getCurrentPosition: async () => ({ coords: { latitude: 34.35, longitude: 47.11 } }),
        },
      },
    );

    const source = nativeGeolocation(scope);
    expect(source).not.toBeNull();
    source?.getCurrentPosition(
      (position) => points.push({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => failures.push(error.code),
    );
    await vi.waitFor(() => expect(points).toEqual([{ lat: 34.35, lng: 47.11 }]));
    expect(failures).toEqual([]);
  });

  it('turns a refused geolocation permission into code 1 (denied), like the browser does', async () => {
    const failures: number[] = [];
    const scope = bridge(
      {},
      {
        Geolocation: {
          requestPermissions: async () => ({ location: 'denied' }),
          getCurrentPosition: async () => ({ coords: { latitude: 0, longitude: 0 } }),
        },
      },
    );

    nativeGeolocation(scope)?.getCurrentPosition(
      () => undefined,
      (error) => failures.push(error.code),
    );
    await vi.waitFor(() => expect(failures).toEqual([1]));
  });

  it('has no native geolocation in a browser', () => {
    expect(nativeGeolocation({})).toBeNull();
  });
});
