import { AppError } from '@benzin/shared';
import type { ZoneRecord } from '../domain/entities.js';
import { snapToGrid, type PublicLocation } from '../domain/geo.js';
import type { ZoneRepository } from '../ports.js';

export type { PublicLocation };

export interface ZoneView {
  id: string;
  slug: string;
  nameFa: string;
  city: string;
  province: string;
  /**
   * City outline as `[lng, lat]` pairs (G-07). It is a municipal boundary, not a user
   * point, so it is safe to publish: the client draws it under the map picker and the
   * API still rejects any point outside it.
   */
  boundary: Array<[number, number]>;
}

export const toZoneView = (zone: ZoneRecord): ZoneView => ({
  id: zone.id,
  slug: zone.slug,
  nameFa: zone.nameFa,
  city: zone.city,
  province: zone.province,
  boundary: zone.boundary.map(([lng, lat]) => [lng, lat] as [number, number]),
});

/**
 * Owns every decision about coordinates: which zone a point belongs to, and how a
 * point may be shown to clients. Nothing else in the codebase should format a
 * coordinate pair for a response, so this stays the single place to audit.
 */
export class LocationService {
  constructor(private readonly zones: ZoneRepository) {}

  /** The active zone containing the point, or null outside the coverage area. */
  async zoneForPoint(point: { lat: number; lng: number }): Promise<ZoneRecord | null> {
    return this.zones.findByPoint(point);
  }

  /** Like `zoneForPoint`, but throws the shared 422 error when out of coverage. */
  async requireZone(point: { lat: number; lng: number }): Promise<ZoneRecord> {
    const zone = await this.zoneForPoint(point);
    if (!zone) {
      throw new AppError('ZONE_NOT_SUPPORTED', 422, 'Point is outside the coverage area', {
        lat: snapToGrid(point).lat,
        lng: snapToGrid(point).lng,
      });
    }
    return zone;
  }

  async locate(point: { lat: number; lng: number }): Promise<{
    supported: boolean;
    zone: ZoneView | null;
  }> {
    const zone = await this.zoneForPoint(point);
    return { supported: zone !== null, zone: zone ? toZoneView(zone) : null };
  }
}
