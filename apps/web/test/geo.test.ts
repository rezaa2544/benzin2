import { describe, expect, it } from 'vitest';
import {
  RADIUS_OPTIONS_KM,
  boundsOfRing,
  centerOf,
  clearOrigin,
  currentPosition,
  estimateEtaMinutes,
  fractionOfPoint,
  haversineKm,
  isValidPoint,
  pointAtFraction,
  readOrigin,
  saveOrigin,
} from '../src/lib/geo.js';

/** The seeded Baneh outline, in `[lng, lat]` order like the API sends it. */
const RING: Array<[number, number]> = [
  [45.87, 35.99],
  [45.9, 35.99],
  [45.9, 36.01],
  [45.87, 36.01],
  [45.87, 35.99],
];

/** Minimal in-memory Storage so the origin helpers can be tested without a browser. */
const fakeStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
};

describe('map geometry (G-07)', () => {
  it('derives the bounds of a city ring', () => {
    expect(boundsOfRing(RING)).toEqual({
      minLat: 35.99,
      minLng: 45.87,
      maxLat: 36.01,
      maxLng: 45.9,
    });
    expect(boundsOfRing([])).toBeNull();
    expect(boundsOfRing(null)).toBeNull();
  });

  it('maps screen fractions to coordinates and back', () => {
    const bounds = boundsOfRing(RING)!;
    const centre = pointAtFraction(bounds, 0.5, 0.5);
    expect(centre.lat).toBeCloseTo(36, 6);
    expect(centre.lng).toBeCloseTo(45.885, 6);

    // Y grows downward, so the top of the box is the northern edge.
    expect(pointAtFraction(bounds, 0, 0).lat).toBeCloseTo(36.01, 6);
    expect(pointAtFraction(bounds, 1, 1).lng).toBeCloseTo(45.9, 6);

    const point = pointAtFraction(bounds, 0.25, 0.75);
    const back = fractionOfPoint(bounds, point);
    expect(back.x).toBeCloseTo(0.25, 6);
    expect(back.y).toBeCloseTo(0.75, 6);
  });

  it('clamps taps that land outside the box', () => {
    const bounds = boundsOfRing(RING)!;
    expect(pointAtFraction(bounds, -1, 2)).toEqual(pointAtFraction(bounds, 0, 1));
    expect(fractionOfPoint(bounds, { lat: 10, lng: 10 })).toEqual({ x: 0, y: 1 });
  });

  it('centres the crosshair on the city', () => {
    const bounds = boundsOfRing(RING)!;
    expect(centerOf(bounds)).toEqual({ lat: 36, lng: 45.885 });
    expect(RADIUS_OPTIONS_KM).toEqual([1, 3, 5, 10, 25]);
  });

  it('estimates a driving ETA from the distance', () => {
    // 5 km straight line → 6.75 km of road → 12.6 min → 13 minutes.
    expect(estimateEtaMinutes(5)).toBe(13);
    expect(estimateEtaMinutes(0)).toBe(0);
    expect(estimateEtaMinutes(-3)).toBe(0);
    expect(estimateEtaMinutes(0.1)).toBe(1);
  });

  it('agrees with the API haversine on a known pair', () => {
    const km = haversineKm({ lat: 35.99, lng: 45.87 }, { lat: 35.99, lng: 45.9 });
    expect(km).toBeGreaterThan(2.6);
    expect(km).toBeLessThan(2.8);
  });

  it('validates a point before it is stored', () => {
    expect(isValidPoint({ lat: 35, lng: 45 })).toBe(true);
    expect(isValidPoint({ lat: 91, lng: 45 })).toBe(false);
    expect(isValidPoint({ lat: '35', lng: 45 })).toBe(false);
    expect(isValidPoint(null)).toBe(false);
  });
});

describe('traveler point storage (G-07)', () => {
  it('remembers the point across screens', () => {
    const store = fakeStorage();
    expect(readOrigin(store)).toBeNull();
    saveOrigin({ lat: 35.9983, lng: 45.8851 }, store);
    expect(readOrigin(store)).toEqual({ lat: 35.9983, lng: 45.8851 });
    clearOrigin(store);
    expect(readOrigin(store)).toBeNull();
  });

  it('ignores a corrupt or out-of-range stored value', () => {
    const store = fakeStorage();
    store.setItem('benzin2.travelerOrigin', '{not json');
    expect(readOrigin(store)).toBeNull();
    store.setItem('benzin2.travelerOrigin', JSON.stringify({ lat: 200, lng: 0 }));
    expect(readOrigin(store)).toBeNull();
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    expect(readOrigin(broken)).toBeNull();
    expect(() => saveOrigin({ lat: 1, lng: 2 }, broken)).not.toThrow();
    expect(() => clearOrigin(broken)).not.toThrow();
  });
});

describe('browser geolocation (G-07)', () => {
  const geo = (
    behaviour: 'ok' | 'denied' | 'unavailable',
  ): Pick<Geolocation, 'getCurrentPosition'> =>
    ({
      getCurrentPosition: (success, error) => {
        if (behaviour === 'ok') {
          success({ coords: { latitude: 35.99, longitude: 45.88 } } as GeolocationPosition);
          return;
        }
        error?.({ code: behaviour === 'denied' ? 1 : 2 } as GeolocationPositionError);
      },
    }) as Pick<Geolocation, 'getCurrentPosition'>;

  it('returns the browser point', async () => {
    await expect(currentPosition(geo('ok'))).resolves.toEqual({
      point: { lat: 35.99, lng: 45.88 },
      failure: null,
    });
  });

  it('turns a refusal into a hint instead of an error', async () => {
    await expect(currentPosition(geo('denied'))).resolves.toEqual({
      point: null,
      failure: 'denied',
    });
    await expect(currentPosition(geo('unavailable'))).resolves.toEqual({
      point: null,
      failure: 'unavailable',
    });
  });

  it('reports a browser without geolocation', async () => {
    await expect(currentPosition(null)).resolves.toEqual({ point: null, failure: 'unsupported' });
  });
});
