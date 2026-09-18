import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeTripStore } from '@/lib/trackingStore';
import { localTripRepository } from '@/lib/localTripRepository';
import {
  RSAS_OVERVIEW_BYTES,
  RSAS_OVERVIEW_POINTS,
  RSAS_RECENT_POINTS,
  RSAS_SEGMENT_BYTES,
  browserActiveTripSpool,
} from '@/lib/browserActiveTripSpool';

const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

describe('browser RSAS producer and canonical completion', () => {
  afterEach(async () => {
    activeTripStore.clear();
    await activeTripStore.flush();
    vi.unstubAllGlobals();
  });

  it('streams a 52+ MiB actual browser producer without route-sized live state', async () => {
    const values = new Map();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const pointPayload = 'x'.repeat(56 * 1024);
    const pointCount = 970;
    const tripId = `browser-large-${Date.now()}`;
    activeTripStore.set({
      id: tripId,
      start_time: '2026-08-21T12:00:00.000Z',
      status: 'active',
      route_points: [],
    });

    const quarterDurations = [0, 0, 0, 0];
    for (let index = 0; index < pointCount; index += 1) {
      const started = performance.now();
      activeTripStore.addPoint({
        index,
        lat: 43 + index / 1_000_000,
        lng: -79 - index / 1_000_000,
        speed_kmh: 42,
        timestamp: new Date(Date.UTC(2026, 7, 21, 12, 0, index)).toISOString(),
        producer_fixture_padding: pointPayload,
      });
      quarterDurations[Math.min(3, Math.floor(index * 4 / pointCount))] += performance.now() - started;
      const status = browserActiveTripSpool.status();
      expect(status.bufferBytes).toBeLessThanOrEqual(RSAS_SEGMENT_BYTES);
      expect(status.recentPoints).toBeLessThanOrEqual(RSAS_RECENT_POINTS);
      expect(status.overviewPoints).toBeLessThanOrEqual(RSAS_OVERVIEW_POINTS);
      expect(activeTripStore.get().route_points.length).toBeLessThanOrEqual(RSAS_RECENT_POINTS);
      expect(utf8Bytes(JSON.stringify(activeTripStore.get().route_preview))).toBeLessThanOrEqual(RSAS_OVERVIEW_BYTES);
    }

    const completed = await activeTripStore.completeBrowserCanonical({
      status: 'completed',
      end_time: '2026-08-22T12:00:00.000Z',
    });
    const storedMetadata = await localTripRepository.create(completed);
    await activeTripStore.flush();

    expect(completed.route_points).toEqual([]);
    expect(completed.route_points_raw_count).toBe(pointCount);
    expect(completed.route_payload_storage).toBe('browser_rsas_v1');
    expect(storedMetadata.route_points).toEqual([]);
    await expect(localTripRepository.getById(tripId)).resolves.toMatchObject({
      id: tripId,
      route_payload_storage: 'browser_rsas_v1',
      route_points: [],
      route_points_raw_count: pointCount,
    });
    expect(activeTripStore.get().route_points.length).toBe(0);
    expect(Math.max(...Array.from(values.values(), (value) => utf8Bytes(String(value))))).toBeLessThan(1024 * 1024);
    expect(quarterDurations[3]).toBeLessThan(quarterDurations[0] * 8 + 250);

    activeTripStore.clear();
    await activeTripStore.flush();
    const payloadStream = await localTripRepository.getPayloadStream(tripId);
    let replayed = 0;
    let payloadBytes = 0;
    for await (const point of payloadStream) {
      expect(point.index).toBe(replayed);
      expect(point.producer_fixture_padding.length).toBe(pointPayload.length);
      payloadBytes += utf8Bytes(JSON.stringify(point)) + 1;
      replayed += 1;
    }
    expect(replayed).toBe(pointCount);
    expect(payloadBytes).toBeGreaterThan(52 * 1024 * 1024);
  }, 120_000);

  it('recovers sealed work after renderer-memory loss and rejects a second producer', async () => {
    const values = new Map();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    activeTripStore.set({ id: 'browser-recovery', route_points: [] });
    for (let index = 0; index < 300; index += 1) {
      activeTripStore.addPoint({
        index,
        lat: 43 + index / 100_000,
        lng: -79,
        timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      });
    }
    const sessionId = activeTripStore.get().rsas_session_id;
    expect(() => browserActiveTripSpool.begin({ id: 'competing-trip' })).toThrow(/owns the active spool/i);
    await activeTripStore.flush();
    browserActiveTripSpool.resetMemory();
    const recovered = await browserActiveTripSpool.hydrate(sessionId);
    expect(recovered.route_point_count).toBe(256);
    expect(recovered.route_points.length).toBeLessThanOrEqual(RSAS_RECENT_POINTS);
  });
});
