import { describe, expect, it } from 'vitest';
import { sanitizeImportedTrip } from '@/lib/dataBackup';
import {
  NATIVE_JOURNAL_INLINE_ROUTE_STORAGE,
  stampNativeJournalRouteSource,
  verifiedNativeJournalRouteSource,
  withoutClaimedRouteSource,
} from '@/lib/nativeRouteSource';

const route = (n = 60) => Array.from({ length: n }, (_, index) => ({
  lat: 43.65 + index * 0.0001, lng: -79.38,
  timestamp: new Date(Date.parse('2026-09-30T19:32:53.319Z') + index * 1000).toISOString(),
  speed_kmh: 40, accuracy: 6,
}));
const native = (points = route()) => ({
  id: 'native_trip_1790796773338_8c4dff25', status: 'completed',
  start_source: 'native_auto', imported_from_native: true,
  route_points: points,
});

describe('DPD-049 explicit native journal route source', () => {
  it('binds only an admitted completed native route, without copying its points', async () => {
    const trip = native();
    const marker = await stampNativeJournalRouteSource(trip);
    expect(marker.route_payload_storage).toBe(NATIVE_JOURNAL_INLINE_ROUTE_STORAGE);
    expect(marker.native_route_source).toMatchObject({
      version: 1, owner: 'native_completed_journal', trip_id: trip.id,
      point_count: trip.route_points.length,
    });
    expect(marker).not.toHaveProperty('route_points');
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker })).toBe(true);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker }, {
      nativeSourceVerifiedDigest: marker.native_route_source.sha256,
    })).toBe(true);
  });

  it('refuses untrusted inline records, copied claims and changed route bytes', async () => {
    const trip = native();
    const marker = await stampNativeJournalRouteSource(trip);
    expect(await verifiedNativeJournalRouteSource(trip)).toBe(false);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker, id: 'copied-id' })).toBe(false);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker,
      route_points: trip.route_points.map((point, index) => index === 4 ? { ...point, lat: 0 } : point),
    })).toBe(false);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker,
      route_points: trip.route_points.slice(1),
    })).toBe(false);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker,
      privacy_mode: 'summary_only',
    })).toBe(false);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker,
      route_data_expired_at: '2026-10-01T00:00:00.000Z',
    })).toBe(false);
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker,
      rsas_session_id: 'other-owner',
    })).toBe(false);
    expect(await stampNativeJournalRouteSource({ ...trip, status: 'active' })).toEqual({});
  });

  it('strips a claimed marker at native intake and during ordinary backup sanitization', async () => {
    const trip = native();
    const marker = await stampNativeJournalRouteSource(trip);
    const claimed = { ...trip, ...marker, rsas_session_id: 'forged' };
    expect(withoutClaimedRouteSource(claimed)).not.toHaveProperty('native_route_source');
    expect(withoutClaimedRouteSource(claimed)).not.toHaveProperty('route_payload_storage');
    expect(withoutClaimedRouteSource(claimed)).not.toHaveProperty('rsas_session_id');
    const backup = sanitizeImportedTrip(claimed);
    expect(backup.imported_from_native).toBe(true);
    expect(backup).not.toHaveProperty('native_route_source');
    expect(backup).not.toHaveProperty('route_payload_storage');
  });

  it('keeps a 5,000-point route inline once with a bounded descriptor', async () => {
    const trip = native(route(5000));
    const marker = await stampNativeJournalRouteSource(trip);
    expect(marker.native_route_source.point_count).toBe(5000);
    expect(marker.native_route_source.json_bytes).toBeGreaterThan(400_000);
    expect(marker.native_route_source.json_bytes).toBeLessThan(4 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(marker)).byteLength).toBeLessThan(320);
    expect(marker).not.toHaveProperty('route_points');
    expect(await verifiedNativeJournalRouteSource({ ...trip, ...marker })).toBe(true);
  });
});
