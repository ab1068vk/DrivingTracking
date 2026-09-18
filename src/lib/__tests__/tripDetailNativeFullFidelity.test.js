import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  pointCount: 12_000,
  commits: new Map(),
  tombstones: [],
}));

const pointAt = (index) => ({
  route_index: index,
  lat: 43.6 + index * 0.0001,
  lng: -79.4 + index * 0.0001,
  speed_kmh: index >= 4_000 && index <= 4_400 ? 0 : (index < 7_000 ? 42 : 92),
  timestamp: new Date(Date.parse('2026-08-18T10:00:00.000Z') + index * 1000).toISOString(),
});

vi.mock('@/lib/nativeTripArchive', () => ({
  async *iterateNativeTripJsonArray() {
    for (let index = 0; index < fixture.pointCount; index += 1) yield pointAt(index);
  },
  async createNativeTripCommitWriter(tripId) {
    const points = [];
    let finished = false;
    return {
      async text() {},
      async value(value) {
        if (value && typeof value === 'object' && Number.isInteger(value.route_index)) {
          points.push(value.route_index);
        }
      },
      async finish() {
        finished = true;
        fixture.commits.set(tripId, points);
        return { verified: true, payloadHash: `hash-${tripId}`, maximumBufferedBytes: 4096 };
      },
      async abort() {
        if (!finished) points.length = 0;
      },
    };
  },
  nativeTripArchive: {
    async tombstone(tripId) {
      fixture.tombstones.push(tripId);
      return { deleted: true };
    },
  },
}));

import {
  analyzeNativeTripFullFidelity,
  splitNativeTripAtStopsStreamed,
} from '@/lib/tripFullFidelity';
import { splitTripFromDetail, tripDetailExactResults } from '@/lib/tripDetailFullFidelity';

const nativeTrip = () => ({
  id: 'native-long-trip',
  revision: 7,
  status: 'completed',
  start_time: '2026-08-18T10:00:00.000Z',
  end_time: new Date(Date.parse('2026-08-18T10:00:00.000Z') + (fixture.pointCount - 1) * 1000).toISOString(),
  duration_seconds: fixture.pointCount - 1,
  route_overview_only: true,
  // The decimation deliberately omits the parked interval and the high-speed
  // second half. Passing this array to exact logic would produce wrong output.
  route_points: Array.from({ length: 900 }, (_, index) => ({
    ...pointAt(index * 3),
    speed_kmh: 42,
  })),
  native_phone_usage_access_granted: true,
  native_phone_usage_events: [{
    package_name: 'com.example.messages',
    start_ms: Date.parse('2026-08-18T10:01:40.000Z'),
    end_ms: Date.parse('2026-08-18T10:02:20.000Z'),
  }],
});

describe('TripDetail native full-fidelity composition', () => {
  beforeEach(() => {
    fixture.commits.clear();
    fixture.tombstones.length = 0;
  });

  it('derives exact stops, speed distance, and phone evidence from canonical chunks, not the overview', async () => {
    const trip = nativeTrip();
    const analysis = await analyzeNativeTripFullFidelity(trip);
    const exact = tripDetailExactResults(trip, analysis);

    expect(exact.source).toBe('canonical_stream');
    expect(exact.ready).toBe(true);
    expect(exact.pointCount).toBe(fixture.pointCount);
    expect(exact.stops).toHaveLength(1);
    expect(exact.stops[0].duration_seconds).toBeGreaterThanOrEqual(400);
    expect(exact.speedZoneSummary.some((zone) => zone.distanceKm > 0)).toBe(true);
    expect(exact.phoneUse.full_fidelity_route_points_scanned).toBe(fixture.pointCount);
    expect(exact.phoneUse.phone_use_window_count).toBeGreaterThan(0);
    expect(exact.phoneUse.maximum_resident_route_points).toBeLessThanOrEqual(1);
    expect(analysis.maximumBufferedPoints).toBeLessThanOrEqual(2048);
  });

  it('requires canonical analysis before the destructive native split seam', async () => {
    const service = {
      splitAtStopsStreamed: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    };
    await expect(splitTripFromDetail(nativeTrip(), null, service)).rejects.toThrow('FULL_FIDELITY_ROUTE_REQUIRED');
    expect(service.create).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });

  it('streams a long split, preserves every non-stop source point, and retries exactly once', async () => {
    const trip = nativeTrip();
    const analysis = await analyzeNativeTripFullFidelity(trip);
    expect(analysis.splitSegments).toHaveLength(2);

    await expect(splitNativeTripAtStopsStreamed(trip, {
      analysis,
      faultAfterChildren: 1,
    })).rejects.toThrow('TEST_SPLIT_INTERRUPTED');
    expect(fixture.tombstones).toHaveLength(0);
    expect(fixture.commits.size).toBe(1);

    const result = await splitNativeTripAtStopsStreamed(trip, { analysis });
    expect(result.sourceDeleted).toBe(true);
    expect(fixture.tombstones).toEqual([trip.id]);
    expect(fixture.commits.size).toBe(2);
    expect(result.maxWriterBufferBytes).toBeLessThanOrEqual(4096);

    const represented = new Set([...fixture.commits.values()].flat());
    const expected = new Set();
    for (const range of analysis.splitSegments) {
      for (let index = range.startIndex; index <= range.endIndex; index += 1) expected.add(index);
    }
    expect(represented.size).toBe(expected.size);
    for (const index of expected) expect(represented.has(index)).toBe(true);
  });
});
