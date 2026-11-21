import { nativeGeolocation } from './native.js';

/**
 * G-07 — every geographic helper the screens need, kept out of the components so the
 * maths is testable without a DOM.
 *
 * The product never trusts a browser point further than it has to: a listing stores the
 * exact point, but the API snaps it to a privacy grid before any response (`publicLocation`),
 * so everything here deals in approximate coordinates plus distance/ETA numbers.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** A rectangle in degrees. `minLat`/`minLng` are the south-west corner. */
export interface Bounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export type Ring = ReadonlyArray<readonly [number, number]>;

/** Straight-line → city driving correction; mirrors the API's `ROAD_FACTOR`. */
export const ROAD_FACTOR = 1.35;
/** Conservative in-city average speed, in km/h; mirrors the API fallback. */
export const AVERAGE_SPEED_KMH = 32;

/** The radius chips a buyer can tap once a search point exists. */
export const RADIUS_OPTIONS_KM: readonly number[] = [1, 3, 5, 10, 25];

export const isValidPoint = (value: unknown): value is LatLng => {
  if (!value || typeof value !== 'object') return false;
  const point = value as { lat?: unknown; lng?: unknown };
  return (
    typeof point.lat === 'number' &&
    typeof point.lng === 'number' &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
};

/** Bounds of a city ring (`[lng, lat]` pairs, GeoJSON order). Empty ring → null. */
export function boundsOfRing(ring: Ring | null | undefined): Bounds | null {
  if (!ring || ring.length === 0) return null;
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return { minLat, minLng, maxLat, maxLng };
}

/** Centre of the bounds — where the picker's crosshair starts. */
export function centerOf(bounds: Bounds): LatLng {
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lng: (bounds.minLng + bounds.maxLng) / 2,
  };
}

/**
 * Turns a 0…1 position inside the picker box into a coordinate. `x` grows eastward and
 * `y` grows *downward* (screen order), so latitude is inverted here — the same reason the
 * SVG ring is drawn with a flipped Y axis.
 */
export function pointAtFraction(bounds: Bounds, x: number, y: number): LatLng {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const fx = clamp(x);
  const fy = clamp(y);
  return {
    lat: bounds.maxLat - fy * (bounds.maxLat - bounds.minLat),
    lng: bounds.minLng + fx * (bounds.maxLng - bounds.minLng),
  };
}

/** Inverse of `pointAtFraction`, used to place the marker on the box. */
export function fractionOfPoint(bounds: Bounds, point: LatLng): { x: number; y: number } {
  const spanLng = bounds.maxLng - bounds.minLng || 1;
  const spanLat = bounds.maxLat - bounds.minLat || 1;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((point.lng - bounds.minLng) / spanLng),
    y: clamp((bounds.maxLat - point.lat) / spanLat),
  };
}

/** Same great-circle formula the API uses, in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6_371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Fallback ETA for a card when the API did not send one (offline cache, or a client that
 * only kept the distance). Driving distance is the straight line × the road factor.
 */
export function estimateEtaMinutes(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  const minutes = ((distanceKm * ROAD_FACTOR) / AVERAGE_SPEED_KMH) * 60;
  return Math.max(1, Math.round(minutes));
}

// ---------------------------------------------------------------- traveler point
/** Where the traveler is searching from. Kept in local storage across sessions. */
const ORIGIN_KEY = 'benzin2.travelerOrigin';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private mode in some browsers throws on access instead of returning null.
    return null;
  }
};

export function readOrigin(store: Storage | null = storage()): LatLng | null {
  try {
    const raw = store?.getItem(ORIGIN_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidPoint(parsed) ? { lat: parsed.lat, lng: parsed.lng } : null;
  } catch {
    return null;
  }
}

export function saveOrigin(point: LatLng, store: Storage | null = storage()): void {
  try {
    store?.setItem(ORIGIN_KEY, JSON.stringify({ lat: point.lat, lng: point.lng }));
  } catch {
    // A full quota must not break the search screen.
  }
}

export function clearOrigin(store: Storage | null = storage()): void {
  try {
    store?.removeItem(ORIGIN_KEY);
  } catch {
    // Same as above: forgetting the point is best-effort.
  }
}

export type GeoFailure = 'unsupported' | 'denied' | 'unavailable';

export interface GeoResult {
  point: LatLng | null;
  failure: GeoFailure | null;
}

/**
 * One-shot browser position. Never rejects: a denied permission is a normal answer on a
 * PWA, and the screen falls back to picking a point on the city map instead.
 */
export function currentPosition(
  geolocation:
    Pick<globalThis.Geolocation, 'getCurrentPosition'> | null | undefined = typeof navigator ===
  'undefined'
    ? null
    : (nativeGeolocation() ?? navigator.geolocation),
): Promise<GeoResult> {
  if (!geolocation) return Promise.resolve({ point: null, failure: 'unsupported' });
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) =>
        resolve({
          point: { lat: position.coords.latitude, lng: position.coords.longitude },
          failure: null,
        }),
      (error) =>
        resolve({
          point: null,
          failure: error?.code === 1 ? 'denied' : 'unavailable',
        }),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );
  });
}
