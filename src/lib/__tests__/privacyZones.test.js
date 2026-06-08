import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { cleanRoutePoints, haversineDistance } from '@/lib/tripEngine';
import {
  countTripsAffectedByPrivacyZone,
  createPrivacyCellHashes,
  findOverlappingZones,
  getPrivacyZoneDisplayCircle,
  isPointInPrivacyZone,
  isInsidePrivacyZone,
  loadPrivacyZonesFromStorage,
  maskEventCoordinatesForPrivacy,
  maskEventsForPrivacy,
  maskRoutePointsForPrivacyExport,
  maskRoutePointsForPrivacy,
  mergePrivacyZones,
  NATIVE_PRIVACY_ZONES_KEY,
  NATIVE_PRIVACY_SYNC_STATUS_FAILED,
  PRIVACY_ZONES_SECURE_KEY,
  privacyBoundaryPoint,
  privacyZonesForRoute,
  purgeGpsWithinPrivacyZone,
  purgeTripGpsWithinPrivacyZone,
  redactRoutePointForPrivacyStorage,
  syncZonesToNative,
  upsertPrivacyZone,
} from '@/lib/privacyZones';
import { getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { localSettings } from '@/lib/trackingStore';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    set: vi.fn(async () => {}),
  },
}));

const zone = { id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 };
const point = (lat, lng, seconds = 0, speedKmh = 30) => ({
  lat,
  lng,
  speed_kmh: speedKmh,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

describe('privacyZones', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses stable offset geometry without exposing the stored center', () => {
    const display = getPrivacyZoneDisplayCircle(zone);
    const repeated = getPrivacyZoneDisplayCircle(zone);
    const offsetM = haversineDistance(display.lat, display.lng, zone.lat, zone.lng) * 1000;

    expect(display).toEqual(repeated);
    expect(display.lat).not.toBe(zone.lat);
    expect(display.lng).not.toBe(zone.lng);
    expect(offsetM).toBeCloseTo(35, 0);
    expect(display.radius_m).toBe(zone.radius_m + 35);
    expect(display.source_radius_m).toBe(zone.radius_m);
  });

  it('interpolates the route crossing at the circle boundary', () => {
    const inside = point(43.65, -79.38, 0, 10);
    const outside = point(43.6522, -79.38, 20, 40);

    const boundary = privacyBoundaryPoint(inside, outside, zone);

    expect(boundary.lat).toBeGreaterThan(inside.lat);
    expect(boundary.lat).toBeLessThan(outside.lat);
    expect(boundary.privacy_boundary).toBe(true);
    expect(haversineDistance(boundary.lat, boundary.lng, zone.lat, zone.lng) * 1000).toBeCloseTo(100, 0);
    expect(new Date(boundary.timestamp).getTime()).toBeGreaterThan(new Date(inside.timestamp).getTime());
    expect(new Date(boundary.timestamp).getTime()).toBeLessThan(new Date(outside.timestamp).getTime());
  });

  it('clips start and end privacy zones without exposing interior points', () => {
    const route = [
      point(43.65, -79.38, 0),
      point(43.6522, -79.38, 20),
      point(43.6532, -79.38, 40),
      point(43.65, -79.38, 60),
    ];

    const masked = maskRoutePointsForPrivacy(route, { privacy_zones: [zone] });

    expect(masked).toHaveLength(4);
    expect(masked[0].privacy_boundary).toBe(true);
    expect(masked[1]).toBe(route[1]);
    expect(masked[2]).toBe(route[2]);
    expect(masked[3].privacy_boundary).toBe(true);
    expect(masked.some((item) => item.lat === null || item.lng === null)).toBe(false);
    expect(masked.some((item) => item.lat === zone.lat && item.lng === zone.lng)).toBe(false);
  });

  it('redacts live route points before storage when they are inside a privacy zone', () => {
    const raw = {
      ...point(43.65, -79.38, 0, 12),
      latitude: 43.65,
      longitude: -79.38,
      original_lat: 43.65,
      original_lng: -79.38,
    };

    const stored = redactRoutePointForPrivacyStorage(raw, [zone]);

    expect(stored).toMatchObject({
      lat: null,
      lng: null,
      speed_kmh: 12,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_live_redacted: true,
      privacy_zone_id: 'home',
    });
    expect(JSON.stringify(stored)).not.toContain('43.65');
    expect(JSON.stringify(stored)).not.toContain('-79.38');
    expect(stored.latitude).toBeUndefined();
    expect(stored.longitude).toBeUndefined();
    expect(redactRoutePointForPrivacyStorage(point(43.6532, -79.38), [zone])).toEqual(point(43.6532, -79.38));
  });

  it('keeps privacy storage stubs when route points are cleaned', () => {
    const redacted = redactRoutePointForPrivacyStorage(point(43.65, -79.38, 10, 8), [zone]);
    const cleaned = cleanRoutePoints([
      point(43.6522, -79.38, 0, 20),
      redacted,
      point(43.6532, -79.38, 20, 20),
    ]);

    expect(cleaned).toHaveLength(3);
    expect(cleaned[1]).toMatchObject({
      lat: null,
      lng: null,
      privacy_live_redacted: true,
    });
  });

  it('replaces export privacy boundaries with opaque placeholders', () => {
    const route = [
      point(43.65, -79.38, 0),
      { ...point(43.6522, -79.38, 20), radius_m: 999, privacy_zone_radius_m: 100 },
    ];
    const settings = { privacy_zones: [zone] };
    const exact = maskRoutePointsForPrivacy(route, settings);
    const exported = maskRoutePointsForPrivacyExport(route, settings, 'export-salt');

    const exactBoundary = exact.find((item) => item.privacy_boundary);
    const placeholder = exported.find((item) => item.privacy_export_placeholder);

    expect(exactBoundary.lat).not.toBeNull();
    expect(placeholder).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
      privacy_zone_id: 'home',
    });
    expect(exported.some((item) => item.privacy_boundary)).toBe(false);
    expect(JSON.stringify(exported)).not.toContain(String(exactBoundary.lat));
    expect(placeholder.radius_m).toBeUndefined();
    expect(placeholder.privacy_zone_radius_m).toBeUndefined();
  });

  it('counts trips that would be exposed by privacy zone deletion', () => {
    const trips = [
      { id: 'inside-route', route_points: [point(43.65, -79.38, 0)] },
      { id: 'inside-event', route_points: [point(43.6532, -79.38, 0)], driving_events: [{ lat: 43.65, lng: -79.38 }] },
      { id: 'outside', route_points: [point(43.6532, -79.38, 0)] },
    ];

    expect(countTripsAffectedByPrivacyZone(trips, zone)).toBe(2);
  });

  it('purges raw GPS inside a deleted privacy zone and leaves a placeholder gap', () => {
    const trip = {
      id: 'purge-trip',
      route_points: [
        point(43.649, -79.38, 0),
        point(43.65, -79.38, 10),
        point(43.6502, -79.38, 20),
        point(43.6522, -79.38, 30),
      ],
      driving_events: [
        { type: 'harsh_brake', lat: 43.65, lng: -79.38 },
        { type: 'sharp_turn', lat: 43.6532, lng: -79.38 },
      ],
    };

    const result = purgeTripGpsWithinPrivacyZone(trip, zone);

    expect(result.changed).toBe(true);
    expect(result.purgedPoints).toBe(2);
    expect(result.purgedEvents).toBe(1);
    expect(result.trip.route_points).toHaveLength(3);
    expect(result.trip.route_points[1]).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_purged: true,
      privacy_zone_id: 'home',
    });
    expect(result.trip.driving_events).toEqual([trip.driving_events[1]]);
    expect(result.trip.needs_rescore).toBe(true);
  });

  it('updates each affected trip when purging a privacy zone', async () => {
    const updateTrip = vi.fn(async () => ({}));
    const trips = [
      { id: 'inside', route_points: [point(43.65, -79.38, 0)], driving_events: [] },
      { id: 'outside', route_points: [point(43.6532, -79.38, 0)], driving_events: [] },
    ];

    const result = await purgeGpsWithinPrivacyZone(trips, zone, updateTrip);

    expect(result).toMatchObject({ tripsAffected: 1, pointsPurged: 1, eventsPurged: 0 });
    expect(updateTrip).toHaveBeenCalledTimes(1);
    expect(updateTrip.mock.calls[0][0]).toBe('inside');
    expect(updateTrip.mock.calls[0][1].route_points[0]).toMatchObject({
      lat: null,
      lng: null,
      privacy_purged: true,
    });
  });

  it('omits events inside privacy zones but keeps public events', () => {
    const events = [
      { type: 'speeding', lat: 43.65, lng: -79.38 },
      { type: 'sharp_turn', lat: 43.6532, lng: -79.38 },
    ];

    const masked = maskEventsForPrivacy(events, { privacy_zones: [zone] });

    expect(masked).toEqual([events[1]]);
  });

  it('omits events inside the privacy-zone event guard', () => {
    const nearBoundary = { type: 'harsh_brake', lat: 43.65115, lng: -79.38 };
    const publicEvent = { type: 'sharp_turn', lat: 43.6532, lng: -79.38 };

    expect(haversineDistance(nearBoundary.lat, nearBoundary.lng, zone.lat, zone.lng) * 1000).toBeGreaterThan(zone.radius_m);
    expect(maskEventsForPrivacy([nearBoundary, publicEvent], { privacy_zones: [zone] })).toEqual([publicEvent]);
    expect(maskEventCoordinatesForPrivacy(nearBoundary, [zone])).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
    });
  });

  it('checks raw coordinates against privacy zones for local UI suppression', () => {
    expect(isInsidePrivacyZone(43.65, -79.38, [zone])).toBe(true);
    expect(isInsidePrivacyZone(43.6532, -79.38, [zone])).toBe(false);
  });

  it('matches cell-only privacy zones without storing exact coordinates', () => {
    const cellOnlyZone = {
      id: 'home-cell',
      label: 'Home',
      radius_m: 100,
      privacy_cell_schema: 'global_grid_v1',
      privacy_cell_size_m: 100,
      privacy_cell_hashes: createPrivacyCellHashes(zone),
      masked_for_privacy: true,
    };
    const route = [
      point(43.65, -79.38, 0),
      point(43.6532, -79.38, 20),
    ];

    expect(JSON.stringify(cellOnlyZone)).not.toContain('43.65');
    expect(JSON.stringify(cellOnlyZone)).not.toContain('-79.38');
    expect(isInsidePrivacyZone(43.65, -79.38, [cellOnlyZone])).toBe(true);
    expect(isInsidePrivacyZone(43.6532, -79.38, [cellOnlyZone])).toBe(false);

    const masked = maskRoutePointsForPrivacy(route, { privacy_zones: [cellOnlyZone] });
    expect(masked[0]).toMatchObject({
      lat: null,
      lng: null,
      privacy_gap: true,
      masked_for_privacy: true,
      privacy_zone_id: 'home-cell',
    });
    expect(masked.some((item) => item.privacy_boundary)).toBe(false);
    expect(masked.at(-1)).toBe(route[1]);
  });

  it('recovers display-only geometry for a cell-only zone from nearby map points', () => {
    const cellOnlyZone = {
      id: 'home-cell',
      label: 'Home',
      radius_m: 100,
      privacy_cell_schema: 'global_grid_v1',
      privacy_cell_size_m: 100,
      privacy_cell_hashes: createPrivacyCellHashes(zone),
      masked_for_privacy: true,
    };

    const display = getPrivacyZoneDisplayCircle(cellOnlyZone, undefined, [
      point(43.6522, -79.38, 20),
    ]);

    expect(display).toMatchObject({
      id: 'home-cell',
      source_radius_m: 100,
      radius_m: 135,
    });
    expect(display.lat).toBeCloseTo(zone.lat, 2);
    expect(display.lng).toBeCloseTo(zone.lng, 2);
  });

  it('chooses the zone where the point is deepest inside when zones overlap', () => {
    const shallow = { id: 'shallow', label: 'Shallow', lat: 43.65, lng: -79.38, radius_m: 100 };
    const deep = { id: 'deep', label: 'Deep', lat: 43.65, lng: -79.38, radius_m: 250 };

    expect(isPointInPrivacyZone(point(43.65, -79.38), [shallow, deep])).toBe(deep);
  });

  it('reports overlapping privacy-zone pairs', () => {
    const nearby = { id: 'nearby', label: 'Nearby', lat: 43.6505, lng: -79.38, radius_m: 100 };
    const far = { id: 'far', label: 'Far', lat: 43.653, lng: -79.38, radius_m: 100 };

    const overlaps = findOverlappingZones([zone, nearby, far]);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].a).toBe(zone);
    expect(overlaps[0].b).toBe(nearby);
    expect(overlaps[0].overlapMeters).toBeGreaterThan(100);
  });

  it('merges overlapping zones into one union zone without losing OSRM exclusion state', () => {
    const nearby = { id: 'nearby', label: 'Nearby', lat: 43.6505, lng: -79.38, radius_m: 100 };
    const merged = mergePrivacyZones(zone, nearby);

    expect(merged.id).not.toBe(zone.id);
    expect(merged.id).not.toBe(nearby.id);
    expect(merged.label).toContain('Home');
    expect(merged.label).toContain('Nearby');
    expect(merged.radius_m).toBeGreaterThan(zone.radius_m);
    expect(merged.exclude_from_osrm).toBe(true);
    expect(merged.privacy_cell_hashes.length).toBeGreaterThan(0);
    expect(JSON.stringify(merged.privacy_cell_hashes)).not.toContain('43.65');
    expect(JSON.stringify(merged.privacy_cell_hashes)).not.toContain('-79.38');
  });

  it('syncs sanitized privacy zones to native preferences', async () => {
    Capacitor.isNativePlatform.mockReturnValue(true);
    vi.stubGlobal('window', {});

    await syncZonesToNative([zone, { id: 'bad', label: 'Bad', lat: null, lng: -79.38, radius_m: 100 }]);

    expect(Preferences.set).toHaveBeenCalledTimes(1);
    const payload = Preferences.set.mock.calls[0][0];
    expect(payload.key).toBe(NATIVE_PRIVACY_ZONES_KEY);
    expect(payload.value).toContain('"encrypted":true');
    expect(payload.value).not.toContain('43.65');
    expect(payload.value).not.toContain('-79.38');
    expect(payload.value).not.toContain('"lat"');
    expect(payload.value).not.toContain('"lng"');
  });

  it('fails closed and pauses native tracking settings when native privacy sync fails', async () => {
    Capacitor.isNativePlatform.mockReturnValue(true);
    Preferences.set.mockRejectedValueOnce(new Error('native preferences unavailable'));
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        tracking_mode: 'background_auto',
        auto_tracking_enabled: true,
        background_tracking_enabled: true,
        privacy_zones: [],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    });

    const result = await syncZonesToNative([zone]);
    const settings = localSettings.get();

    expect(result.status).toBe(NATIVE_PRIVACY_SYNC_STATUS_FAILED);
    expect(settings).toMatchObject({
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      privacy_zones_native_sync_status: NATIVE_PRIVACY_SYNC_STATUS_FAILED,
      privacy_zones_native_sync_zone_count: 1,
    });
    expect(settings.privacy_zones_native_sync_failed_at).toBeTruthy();
  });

  it('returns only privacy zones touched by a route', () => {
    const work = { id: 'work', label: 'Work', lat: 43.72, lng: -79.42, radius_m: 100 };
    const route = [
      point(43.65, -79.38, 0),
      point(43.6522, -79.38, 20),
    ];

    expect(privacyZonesForRoute(route, { privacy_zones: [zone, work] })).toEqual([
      expect.objectContaining(zone),
    ]);
  });

  it('returns privacy zones referenced by already-masked route metadata', () => {
    const route = [
      { lat: null, lng: null, privacy_zone_id: zone.id, masked_for_privacy: true },
      point(43.6522, -79.38, 20),
    ];

    expect(privacyZonesForRoute(route, { privacy_zones: [zone] })).toEqual([
      expect.objectContaining(zone),
    ]);
  });

  it('invalidates OSRM consent when a privacy zone is added', async () => {
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        map_matching_enabled: true,
        osrm_map_matching_url: 'https://osrm.example',
        osrm_data_sharing_consented: true,
        osrm_data_sharing_consented_at: '2026-06-01T12:00:00.000Z',
        privacy_zones: [],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const updated = await upsertPrivacyZone(zone, JSON.parse(values.get('drivesense_settings')));
    const storedSettings = JSON.parse(values.get('drivesense_settings'));
    const encryptedZones = values.get(PRIVACY_ZONES_SECURE_KEY);

    expect(updated.osrm_data_sharing_consented).toBe(false);
    expect(updated.osrm_data_sharing_consented_at).toBe('');
    expect(updated.osrm_consent_invalidated_reason).toBe('privacy_zone_changed');
    expect(updated.osrm_consent_invalidated_zone_label).toBe('Home');
    expect(updated.map_matching_enabled).toBe(true);
    expect(storedSettings.privacy_zones[0]).toMatchObject({
      id: 'home',
      label: 'Home',
      radius_m: 100,
      exclude_from_osrm: true,
      masked_for_privacy: true,
    });
    expect(storedSettings.privacy_zones[0].privacy_cell_hashes).toBeUndefined();
    expect(JSON.stringify(storedSettings)).not.toContain('43.65');
    expect(JSON.stringify(storedSettings)).not.toContain('-79.38');
    expect(encryptedZones).toContain('"encrypted":true');
    expect(encryptedZones).not.toContain('43.65');
    expect(encryptedZones).not.toContain('-79.38');
    const storedZones = await getEncryptedJson(PRIVACY_ZONES_SECURE_KEY, []);
    expect(storedZones).toEqual([
      expect.objectContaining({
        id: 'home',
        radius_m: 100,
        privacy_cell_hashes: expect.any(Array),
      }),
    ]);
    expect(storedZones[0].lat).toBeUndefined();
    expect(storedZones[0].lng).toBeUndefined();
    expect(storedZones[0].display_lat).toBeUndefined();
    expect(storedZones[0].display_lng).toBeUndefined();
    expect(storedZones[0].display_radius_m).toBeUndefined();
  });

  it('migrates legacy plaintext privacy zones into encrypted storage and scrubs settings', async () => {
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        privacy_zones: [zone],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const loaded = await loadPrivacyZonesFromStorage(JSON.parse(values.get('drivesense_settings')));
    const storedSettings = JSON.parse(values.get('drivesense_settings'));
    const encryptedZones = values.get(PRIVACY_ZONES_SECURE_KEY);

    expect(loaded).toEqual([
      expect.objectContaining(zone),
    ]);
    expect(storedSettings.privacy_zones[0]).toMatchObject({
      id: 'home',
      label: 'Home',
      radius_m: 100,
      exclude_from_osrm: true,
      masked_for_privacy: true,
    });
    expect(storedSettings.privacy_zones[0].privacy_cell_hashes).toBeUndefined();
    expect(JSON.stringify(storedSettings)).not.toContain('43.65');
    expect(JSON.stringify(storedSettings)).not.toContain('-79.38');
    expect(encryptedZones).toContain('"encrypted":true');
    expect(encryptedZones).not.toContain('43.65');
    expect(encryptedZones).not.toContain('-79.38');
    const storedZones = await getEncryptedJson(PRIVACY_ZONES_SECURE_KEY, []);
    expect(storedZones).toEqual([
      expect.objectContaining({
        id: 'home',
        radius_m: 100,
        privacy_cell_hashes: expect.any(Array),
      }),
    ]);
    expect(storedZones[0].lat).toBeUndefined();
    expect(storedZones[0].lng).toBeUndefined();
    expect(storedZones[0].display_lat).toBeUndefined();
    expect(storedZones[0].display_lng).toBeUndefined();
    expect(storedZones[0].display_radius_m).toBeUndefined();
  });

  it('scrubs persisted display coordinates from the previous build during startup', async () => {
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        privacy_zones: [{
          id: 'home',
          label: 'Home',
          radius_m: 100,
          exclude_from_osrm: true,
          masked_for_privacy: true,
        }],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    await setEncryptedJson(PRIVACY_ZONES_SECURE_KEY, [{
      id: 'home',
      label: 'Home',
      radius_m: 100,
      exclude_from_osrm: true,
      privacy_cell_schema: 'global_grid_v1',
      privacy_cell_size_m: 100,
      privacy_cell_hashes: createPrivacyCellHashes(zone),
      masked_for_privacy: true,
      display_lat: 43.6502,
      display_lng: -79.3797,
      display_radius_m: 135,
    }]);

    await loadPrivacyZonesFromStorage(JSON.parse(values.get('drivesense_settings')));
    const storedZones = await getEncryptedJson(PRIVACY_ZONES_SECURE_KEY, []);

    expect(storedZones[0].privacy_cell_hashes.length).toBeGreaterThan(0);
    expect(storedZones[0].lat).toBeUndefined();
    expect(storedZones[0].lng).toBeUndefined();
    expect(storedZones[0].display_lat).toBeUndefined();
    expect(storedZones[0].display_lng).toBeUndefined();
    expect(storedZones[0].display_radius_m).toBeUndefined();
  });
});
