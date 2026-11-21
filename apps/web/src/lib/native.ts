/**
 * G-16 — the thin seam between the PWA and the Android shell.
 *
 * The same bundle runs in three places: a browser, the installed PWA, and the Capacitor WebView.
 * Only the last one has a native bridge on `window.Capacitor`, and it needs three things the
 * browser cannot give it: an absolute API origin (the WebView origin is `https://localhost`), an
 * FCM token, and a geolocation call that asks for the Android permission at the right moment.
 *
 * Everything here is dependency-free and duck-typed: the bridge is probed at call time, so a
 * browser bundle never imports a Capacitor package and never pays for one. Every function takes
 * an optional `scope` so the behaviour is testable without a WebView.
 */

export type AppPlatform = 'android' | 'ios' | 'web';

/** The subset of `window.Capacitor` this app actually touches. */
export interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

interface PluginCall {
  Plugins?: Record<string, unknown>;
}

const pluginOf = (scope: unknown, name: string): Record<string, unknown> | null => {
  const bridge = (scope as { Capacitor?: CapacitorBridge } | undefined)?.Capacitor;
  const plugin = bridge?.Plugins?.[name];
  return plugin && typeof plugin === 'object' ? (plugin as Record<string, unknown>) : null;
};

export const capacitorBridge = (scope: unknown = globalThis): CapacitorBridge | null => {
  const candidate = (scope as { Capacitor?: unknown }).Capacitor;
  return candidate && typeof candidate === 'object' ? (candidate as CapacitorBridge) : null;
};

/** True only inside the Capacitor WebView — never for an installed PWA. */
export function isNativeApp(scope: unknown = globalThis): boolean {
  return capacitorBridge(scope)?.isNativePlatform?.() === true;
}

export function appPlatform(scope: unknown = globalThis): AppPlatform | null {
  const platform = capacitorBridge(scope)?.getPlatform?.();
  return platform === 'android' || platform === 'ios' || platform === 'web' ? platform : null;
}

/**
 * The WebView cannot use relative URLs, so a native build must know the deployed origin.
 * Trailing slashes are trimmed because `ApiClient` concatenates `base + path` directly.
 */
export function apiBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

/** A stable per-install id for the device row; generated once and kept in localStorage. */
export function deviceId(store: Storage | null | undefined, factory: () => string): string {
  const key = 'benzin.deviceId';
  if (!store) return factory();
  const existing = store.getItem(key);
  // The server accepts 8–128 characters of [A-Za-z0-9._:-]; anything else is regenerated.
  if (existing && /^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
  const created = factory();
  try {
    store.setItem(key, created);
  } catch {
    // Private mode with a full quota: the id still works for this session.
  }
  return created;
}

/** `crypto.randomUUID()` where it exists, an 8-hex-byte fallback where it does not. */
export function newDeviceId(): string {
  const uuid = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof uuid === 'function') return `android-${uuid.call(globalThis.crypto)}`;
  const bytes = new Uint8Array(8);
  (
    globalThis.crypto as { getRandomValues?: (array: Uint8Array) => Uint8Array } | undefined
  )?.getRandomValues?.(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `android-${hex || Date.now().toString(16)}`;
}

/**
 * Geolocation through the native plugin, shaped exactly like `navigator.geolocation` so
 * `currentPosition()` in `geo.ts` can take either one. Android-only permission prompts are
 * handled by the plugin; the browser path keeps working untouched.
 */
export function nativeGeolocation(
  scope: unknown = globalThis,
): Pick<Geolocation, 'getCurrentPosition'> | null {
  const plugin = pluginOf(scope, 'Geolocation');
  if (!plugin || typeof plugin['getCurrentPosition'] !== 'function') return null;
  return {
    getCurrentPosition: (success, failure, options) => {
      const call = plugin['getCurrentPosition'] as (options: unknown) => Promise<{
        coords?: { latitude?: number; longitude?: number; accuracy?: number };
      }>;
      const run = async (): Promise<void> => {
        try {
          const granted = plugin['requestPermissions'] as
            (() => Promise<{ location?: string }>) | undefined;
          if (granted) {
            const permission = await granted();
            if (permission?.location && permission.location !== 'granted') {
              failure?.({ code: 1, message: 'denied' } as GeolocationPositionError);
              return;
            }
          }
          const position = await call({
            enableHighAccuracy: options?.enableHighAccuracy ?? false,
            timeout: options?.timeout ?? 8_000,
            maximumAge: options?.maximumAge ?? 60_000,
          });
          const coords = position?.coords ?? {};
          success({
            coords: {
              latitude: coords.latitude ?? 0,
              longitude: coords.longitude ?? 0,
              accuracy: coords.accuracy ?? 0,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
              toJSON: () => ({}),
            },
            timestamp: Date.now(),
            toJSON: () => ({}),
          } as GeolocationPosition);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unavailable';
          failure?.({
            code: /denied|permission/i.test(message) ? 1 : 2,
            message,
          } as GeolocationPositionError);
        }
      };
      void run();
    },
  };
}

export type PushOutcome = 'registered' | 'denied' | 'unsupported' | 'failed';

export interface PushDeps {
  /** POST the token to the API (kept as a callback so this module stays transport-free). */
  register: (pushToken: string) => Promise<unknown>;
  scope?: unknown;
  platform?: AppPlatform;
}

/**
 * Ask for notification permission, register with FCM and hand the token to the API.
 *
 * The token arrives through a `registration` *event listener*, not a return value, and it can
 * arrive again later (FCM rotates tokens), so the listener stays attached for the session and
 * every new token is re-registered. Nothing here runs in a browser: `isNativeApp()` gates it.
 */
export async function syncPushToken(deps: PushDeps): Promise<PushOutcome> {
  const scope = deps.scope ?? globalThis;
  if (!isNativeApp(scope)) return 'unsupported';
  const plugin = pluginOf(scope, 'PushNotifications');
  if (!plugin) return 'unsupported';

  try {
    const request = plugin['requestPermissions'] as
      (() => Promise<{ receive?: string }>) | undefined;
    if (request) {
      const permission = await request();
      if (permission?.receive && permission.receive !== 'granted') return 'denied';
    }

    const attach = plugin['addListener'] as
      ((event: string, handler: (payload: { value?: string }) => void) => unknown) | undefined;
    attach?.('registration', (payload) => {
      const token = payload?.value;
      // A rotated token is as good as the first one; failures are the caller's to log.
      if (token) void deps.register(token).catch(() => undefined);
    });

    const register = plugin['register'] as (() => Promise<void>) | undefined;
    await register?.();
    return 'registered';
  } catch {
    return 'failed';
  }
}

/** The device row the API stores; `platform` and `appVersion` are cosmetic but useful in support. */
export interface DeviceRegistration {
  deviceId: string;
  platform: AppPlatform;
  pushToken?: string;
  appVersion?: string;
}

export const isPluginBridge = (scope: unknown): scope is PluginCall =>
  pluginOf(scope, 'PushNotifications') !== null;
