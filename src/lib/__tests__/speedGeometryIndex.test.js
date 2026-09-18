import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stored: null, p6: null }));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (_key, fallback) => state.stored || fallback),
  removeEncryptedJson: vi.fn(async () => {
    state.stored = null;
  }),
  setEncryptedJson: vi.fn(async (_key, value) => {
    state.stored = structuredClone(value);
  }),
}));

vi.mock('@/lib/p6TripDerivedState', () => ({
  queryP6GeometryPreviewPage: vi.fn(async () => state.p6 || ({
    // A domain that never claimed coverage: the frozen v1 compatibility path
    // is the legal disposition, so the double says so explicitly.
    available: false, state: 'REBUILD_REQUIRED', items: [], nextCursor: null,
    compatibilityAllowed: true,
  })),
}));

import {
  clearSpeedGeometryIndex,
  compactTripForSpeedGeometry,
  readSpeedGeometryIndex,
  rebuildSpeedGeometryIndex,
} from '@/lib/speedGeometryIndex';
import { buildCorrectionImpactPreview } from '@/lib/speedLimitIntelligence';

describe('speed geometry index', () => {
  beforeEach(() => {
    state.stored = null;
    state.p6 = null;
  });

  it('retires the legacy full-history builder as soon as D2 is independently verified', async () => {
    state.stored = { version: 1, trips: [{ id: 'legacy-must-not-serve', route_points: [] }] };
    state.p6 = {
      available: true,
      state: 'VERIFIED',
      items: [{ id: 'p6-head', route_points: [{ lat: 43.1, lng: -79.1 }, { lat: 43.2, lng: -79.2 }] }],
      nextCursor: 'D2_GEOMETRY:p6-head',
    };
    const loadBatch = vi.fn();

    await expect(readSpeedGeometryIndex()).resolves.toMatchObject({
      version: 2, p6Paged: true, indexedTripCount: 1,
      trips: [{ id: 'p6-head' }],
    });
    await expect(rebuildSpeedGeometryIndex({ loadBatch })).resolves.toMatchObject({
      version: 2, p6Paged: true,
    });
    expect(loadBatch).not.toHaveBeenCalled();
  });

  it('never hydrates the retired monolith after a VERIFIED D2 fails to serve', async () => {
    state.stored = { version: 1, trips: [{ id: 'legacy-must-not-serve', route_points: [] }] };
    // The owner revoked its own head and named the failure, so the retired
    // whole-geometry hydrate is not what the reader falls back to.
    state.p6 = {
      available: false, state: 'REBUILD_REQUIRED', reason: 'DERIVED_GEOMETRY_UNREADABLE',
      items: [], nextCursor: null, compatibilityAllowed: false,
    };
    const loadBatch = vi.fn();

    await expect(readSpeedGeometryIndex()).resolves.toMatchObject({
      version: 2, unavailable: true, trips: [], reason: 'DERIVED_GEOMETRY_UNREADABLE',
    });
    await expect(rebuildSpeedGeometryIndex({ loadBatch })).resolves.toMatchObject({
      version: 2, unavailable: true,
    });
    expect(loadBatch).not.toHaveBeenCalled();
  });

  it('keeps compact public geometry and drops private points', () => {
    const trip = compactTripForSpeedGeometry({
      id: 'trip-1',
      route_points: [
        { lat: 43.7, lng: -79.4, speed_limit_kmh: 50 },
        { lat: 43.71, lng: -79.39, masked_for_privacy: true },
        { lat: 43.72, lng: -79.38, speed_limit_kmh: 50 },
      ],
    });
    expect(trip.route_points).toHaveLength(2);
    expect(trip.route_points[0]).toMatchObject({ lat: 43.7, lng: -79.4, speed_limit_kmh: 50 });
  });

  it('retains observed speeds and time context needed for correction impact previews', () => {
    const trip = compactTripForSpeedGeometry({
      id: 'trip-impact',
      route_points: [
        {
          lat: 43.6500,
          lng: -79.3807,
          speed_kmh: 52,
          timestamp_ms: 1_750_000_000_000,
          utc_offset_minutes: -240,
          timezone_id: 'America/Toronto',
        },
        {
          lat: 43.6500,
          lng: -79.3804,
          speedKmh: 65,
          timestampMs: 1_750_000_001_000,
        },
      ],
    });
    const preview = buildCorrectionImpactPreview([trip], {
      limitKmh: 40,
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    }, 40);

    expect(trip.route_points[0]).toMatchObject({
      speed_kmh: 52,
      timestamp: 1_750_000_000_000,
      utc_offset_minutes: -240,
      timezone_id: 'America/Toronto',
    });
    expect(preview.pointsOverLimit).toBe(2);
    expect(preview.severePointCount).toBe(1);
  });

  it('indexes every batch and persists the compact result', async () => {
    const trips = Array.from({ length: 85 }, (_, index) => ({
      id: `trip-${index}`,
      route_points: [
        { lat: 43.7 + index * 0.00001, lng: -79.4 },
        { lat: 43.7001 + index * 0.00001, lng: -79.3999 },
      ],
    }));
    const loadBatch = vi.fn(async ({ offset, limit }) => ({
      trips: trips.slice(offset, offset + limit),
      totalAvailable: trips.length,
      nextOffset: Math.min(trips.length, offset + limit),
    }));

    const result = await rebuildSpeedGeometryIndex({ batchSize: 40, loadBatch });
    expect(result.indexedTripCount).toBe(85);
    expect(loadBatch).toHaveBeenCalledTimes(3);
    expect((await readSpeedGeometryIndex()).trips).toHaveLength(85);
  });

  it('clears derived geometry immediately after source data or privacy changes', async () => {
    await rebuildSpeedGeometryIndex({
      loadBatch: vi.fn(async () => ({
        trips: [{
          id: 'trip-private-change',
          route_points: [
            { lat: 43.7, lng: -79.4 },
            { lat: 43.7001, lng: -79.3999 },
          ],
        }],
        totalAvailable: 1,
        nextOffset: 1,
      })),
    });
    expect((await readSpeedGeometryIndex()).indexedTripCount).toBe(1);

    await clearSpeedGeometryIndex('privacy_zone_changed');

    expect(await readSpeedGeometryIndex()).toMatchObject({ indexedTripCount: 0, trips: [] });
  });

  it('cannot repersist a stale index build after it has been invalidated', async () => {
    let releaseBatch;
    const batchReady = new Promise((resolve) => {
      releaseBatch = resolve;
    });
    const building = rebuildSpeedGeometryIndex({
      loadBatch: vi.fn(async () => {
        await batchReady;
        return {
          trips: [{
            id: 'stale-trip',
            route_points: [
              { lat: 43.7, lng: -79.4 },
              { lat: 43.7001, lng: -79.3999 },
            ],
          }],
          totalAvailable: 1,
          nextOffset: 1,
        };
      }),
    });
    await clearSpeedGeometryIndex('privacy_zone_changed');
    releaseBatch();

    await expect(building).resolves.toMatchObject({ invalidated: true, indexedTripCount: 0 });
    expect(state.stored).toBeNull();
  });
});
