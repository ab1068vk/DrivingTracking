import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { cleanRoutePoints, haversineDistance } from '@/lib/tripEngine';
import {
  countTripsAffectedByPrivacyZone,
  corridorWaypointsFromRoute,
  createPrivacyCellHashes,
  deriveZoneStatsFromTrips,
  findOverlappingZones,
  getBoundaryTimestampFuzz,
  getPrivacyZoneDisplayCircle,
  getPrivacyZones,
  getZoneEffectiveness,
  getZoneStatsSnapshot,
  isPointInPrivacyZone,
  isInsidePrivacyZone,
  KINEMATIC_FIELDS,
  loadPrivacyZonesFromStorage,
  maskEventCoordinatesForPrivacy,
  maskEventsForPrivacy,
  maskRoutePointsForPrivacyExport,
  maskRoutePointsForPrivacy,
  maskTripForPrivacy,
  maskTripForPrivacyExport,
  mergePrivacyZones,
  NATIVE_PRIVACY_ZONES_KEY,
  NATIVE_PRIVACY_SYNC_STATUS_FAILED,
  PRIVACY_RADIUS_DEFAULT_M,
  PRIVACY_RADIUS_MAX_M,
  PRIVACY_RADIUS_MIN_M,
  PRIVACY_ZONES_SECURE_KEY,
  privacyBoundaryPoint,
  privacyZonesForRoute,
  purgeGpsWithinPrivacyZone,
  purgeTripGpsWithinPrivacyZone,
  redactRoutePointForPrivacyStorage,
  sanitizeKinematics,
  sweepExpiredPrivacyZones,
  syncZonesToNative,
  upsertPrivacyZone,
  ZONE_STATS_KEY,
} from '@/lib/privacyZones';
import { getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { secureSetPreference } from '@/lib/secureBridge';
import { SecureGpsBuffer } from '@/lib/SecureGpsBuffer';
import { localSettings } from '@/lib/trackingStore';

const privacyZoneMocks = vi.hoisted(() => ({
  appendPrivacyEvent: vi.fn(async () => ({})),
  listTrips: vi.fn(async () => []),
  updateTrip: vi.fn(async () => ({})),
  enqueueRescoreJob: vi.fn(async () => ({})),
}));

vi.mock('@/lib/hashChainLog', async (importOriginal) => ({
  ...await importOriginal(),
  appendPrivacyEvent: privacyZoneMocks.appendPrivacyEvent,
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    listAll: privacyZoneMocks.listTrips,
    update: privacyZoneMocks.updateTrip,
  },
}));

vi.mock('@/lib/rescoringQueue', () => ({
  enqueueRescoreJob: privacyZoneMocks.enqueueRescoreJob,
}));

vi.mock('@/lib/rescoringWorker', () => ({
  rescoreTripForQueue: vi.fn(),
}));

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

vi.mock('@/lib/secureBridge', () => ({
  secureCall: vi.fn(async () => ({ ciphertext: 'mock-ciphertext' })),
  secureSetPreference: vi.fn(async () => ({ stored: true })),
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
    vi.useRealTimers();
    vi.clearAllMocks();
    Capacitor.isNativePlatform.mockReturnValue(false);
    Capacitor.getPlatform.mockReturnValue('web');
    vi.unstubAllGlobals();
  });

  it('uses explicit privacy radius limits and the 180 m default when radius is missing', async () => {
    expect(PRIVACY_RADIUS_MIN_M).toBe(50);
    expect(PRIVACY_RADIUS_MAX_M).toBe(1000);
    expect(PRIVACY_RADIUS_DEFAULT_M).toBe(180);

    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        privacy_zones: [],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const updated = await upsertPrivacyZone({
      id: 'default',
      label: 'Default',
      lat: 43.65,
      lng: -79.38,
    }, JSON.parse(values.get('drivesense_settings')));

    expect(updated.privacy_zones[0].radius_m).toBe(PRIVACY_RADIUS_DEFAULT_M);
    expect(updated.privacy_zones[0].lat).toBeUndefined();
    expect(updated.privacy_zones[0].lng).toBeUndefined();

    const display = getPrivacyZoneDisplayCircle({ id: 'default', label: 'Default', lat: 43.65, lng: -79.38 });
    expect(display.source_radius_m).toBe(PRIVACY_RADIUS_DEFAULT_M);
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

  it('stores GPS coordinates in a zeroable typed buffer', () => {
    const buffer = new SecureGpsBuffer([{
      latitude: 43.65,
      longitude: -79.38,
      timestamp: '2026-01-01T12:00:00.000Z',
      speed: 12,
      heading: 90,
    }]);

    expect(buffer.length).toBe(1);
    expect(buffer.get(0)).toMatchObject({
      lat: 43.65,
      lng: -79.38,
      latitude: 43.65,
      longitude: -79.38,
      speed_kmh: 12,
      heading: 90,
    });

    buffer.zero();

    expect(buffer.get(0)).toBeNull();
  });

  it('interpolates the route crossing at the circle boundary', () => {
    const inside = { ...point(43.65, -79.38, 0, 10), heading: 25, bearing: 30, altitude: 100, accuracy: 4 };
    const outside = { ...point(43.6522, -79.38, 20, 40), heading: 45, bearing: 50, altitude: 110, accuracy: 6 };

    const boundary = privacyBoundaryPoint(inside, outside, zone);

    expect(boundary.lat).toBeGreaterThan(inside.lat);
    expect(boundary.lat).toBeLessThan(outside.lat);
    expect(boundary.privacy_boundary).toBe(true);
    expect(haversineDistance(boundary.lat, boundary.lng, zone.lat, zone.lng) * 1000).toBeCloseTo(100, 0);
    expect(new Date(boundary.timestamp).getTime()).toBeGreaterThan(new Date(inside.timestamp).getTime());
    expect(new Date(boundary.timestamp).getTime()).toBeLessThan(new Date(outside.timestamp).getTime());
    expect(boundary).toMatchObject({
      speed_kmh: null,
      heading: null,
      bearing: null,
      altitude: null,
      accuracy: null,
    });
  });

  it('nulls every supported kinematic field without changing unrelated data', () => {
    const raw = Object.fromEntries(KINEMATIC_FIELDS.map((field, index) => [field, index + 1]));
    const sanitized = sanitizeKinematics({ ...raw, timestamp: '2026-01-01T12:00:00.000Z', road_type: 'urban' });

    KINEMATIC_FIELDS.forEach((field) => expect(sanitized[field]).toBeNull());
    expect(sanitized).toMatchObject({
      timestamp: '2026-01-01T12:00:00.000Z',
      road_type: 'urban',
    });
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
      speed_kmh: null,
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

  it('nulls kinematics on previously masked points even when zone geometry is unavailable', () => {
    const legacyMasked = {
      lat: null,
      lng: null,
      speed_kmh: 55,
      heading: 90,
      accuracy: 5,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_zone_id: 'deleted-zone',
    };

    expect(maskRoutePointsForPrivacy([legacyMasked], { privacy_zones: [] })[0]).toMatchObject({
      speed_kmh: null,
      heading: null,
      accuracy: null,
      masked_for_privacy: true,
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
      privacy_zone_id: 'private_area',
      privacy_zone_label: 'Private area',
    });
    expect(exported.some((item) => item.privacy_boundary)).toBe(false);
    expect(JSON.stringify(exported)).not.toContain(String(exactBoundary.lat));
    expect(JSON.stringify(exported)).not.toContain('Home');
    expect(placeholder.radius_m).toBeUndefined();
    expect(placeholder.privacy_zone_radius_m).toBeUndefined();
  });

  it('genericizes already-masked privacy gaps during export', () => {
    const exported = maskRoutePointsForPrivacyExport([
      {
        lat: null,
        lng: null,
        masked_for_privacy: true,
        privacy_gap: true,
        privacy_zone_id: 'home',
        privacy_zone_label: 'Home',
        radius_m: 100,
        privacy_zone_radius_m: 100,
        speed_kmh: 44,
      },
    ], { privacy_zones: [] }, 'export-salt');

    expect(exported[0]).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_zone_id: 'private_area',
      privacy_zone_label: 'Private area',
      speed_kmh: null,
    });
    expect(JSON.stringify(exported)).not.toContain('Home');
    expect(JSON.stringify(exported)).not.toContain('radius_m');
  });

  it('fuzzes exported boundary timestamps with a stable per-export zone offset', () => {
    const route = [
      point(43.65, -79.38, 0),
      point(43.6522, -79.38, 20),
      point(43.6532, -79.38, 40),
      point(43.65, -79.38, 60),
    ];
    const settings = { privacy_zones: [zone] };

    const exactBoundary = maskRoutePointsForPrivacy(route, settings).find((item) => item.privacy_boundary);
    const exported = maskRoutePointsForPrivacyExport(route, settings, 'same-export');
    const repeated = maskRoutePointsForPrivacyExport(route, settings, 'same-export');
    const nextExport = maskRoutePointsForPrivacyExport(route, settings, 'next-export');
    const placeholder = exported.find((item) => item.privacy_export_placeholder);
    const repeatedPlaceholder = repeated.find((item) => item.privacy_export_placeholder);
    const nextPlaceholder = nextExport.find((item) => item.privacy_export_placeholder);
    const exactMs = new Date(exactBoundary.timestamp).getTime();
    const expectedFuzz = getBoundaryTimestampFuzz('home', 'same-export');

    expect(placeholder.timestamp).toBe(repeatedPlaceholder.timestamp);
    expect(new Date(placeholder.timestamp).getTime() - exactMs).toBe(expectedFuzz);
    expect(Math.abs(expectedFuzz)).toBeLessThanOrEqual(3 * 60 * 1000);
    expect(placeholder.timestamp).not.toBe(exactBoundary.timestamp);
    expect(nextPlaceholder.timestamp).not.toBe(placeholder.timestamp);
  });

  it('fuzzes exported trip summary times only when the endpoint is private', () => {
    const privateTrip = {
      id: 'private-endpoints',
      start_time: '2026-01-01T12:00:00.000Z',
      end_time: '2026-01-01T12:01:00.000Z',
      route_points: [
        point(43.65, -79.38, 0),
        point(43.6522, -79.38, 30),
        point(43.65, -79.38, 60),
      ],
      driving_events: [],
    };
    const publicTrip = {
      id: 'public-endpoints',
      start_time: '2026-01-01T12:00:00.000Z',
      end_time: '2026-01-01T12:01:00.000Z',
      route_points: [
        point(43.6522, -79.38, 0),
        point(43.6532, -79.38, 60),
      ],
      driving_events: [],
    };
    const settings = { privacy_zones: [zone] };
    const expectedFuzz = getBoundaryTimestampFuzz('home', 'same-export');

    const exportedPrivate = maskTripForPrivacyExport(privateTrip, settings, 'same-export');
    const repeatedPrivate = maskTripForPrivacyExport(privateTrip, settings, 'same-export');
    const nextPrivate = maskTripForPrivacyExport(privateTrip, settings, 'next-export');
    const exportedPublic = maskTripForPrivacyExport(publicTrip, settings, 'same-export');

    expect(exportedPrivate.start_time).toBe(repeatedPrivate.start_time);
    expect(new Date(exportedPrivate.start_time).getTime() - new Date(privateTrip.start_time).getTime()).toBe(expectedFuzz);
    expect(new Date(exportedPrivate.end_time).getTime() - new Date(privateTrip.end_time).getTime()).toBe(expectedFuzz);
    expect(Math.abs(expectedFuzz)).toBeLessThanOrEqual(3 * 60 * 1000);
    expect(exportedPrivate.start_time).not.toBe(privateTrip.start_time);
    expect(nextPrivate.start_time).not.toBe(exportedPrivate.start_time);
    expect(exportedPrivate).toMatchObject({
      privacy_time_shifted: true,
      privacy_time_shifted_fields: ['start_time', 'end_time'],
      privacy_time_shift_policy: 'bounded_private_zone_noise',
    });
    expect(maskTripForPrivacy(privateTrip, settings).start_time).toBe(privateTrip.start_time);
    expect(exportedPublic.start_time).toBe(publicTrip.start_time);
    expect(exportedPublic.end_time).toBe(publicTrip.end_time);
    expect(exportedPublic.privacy_time_shifted).toBeUndefined();
  });

  it('exports speed summaries from public points only', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const trip = {
      avg_speed_kmh: 70,
      avg_running_speed_kmh: 75,
      max_speed_kmh: 120,
      route_points: [
        { ...point(43.65, -79.38, 0, 120), heading: 45 },
        point(43.6522, -79.38, 20, 20),
        point(43.6532, -79.38, 40, 40.04),
      ],
      driving_events: [],
    };

    const exported = maskTripForPrivacyExport(trip, { privacy_zones: [zone] }, 'export-salt');

    expect(exported).toMatchObject({
      avg_speed_kmh: 30,
      avg_running_speed_kmh: 30,
      max_speed_kmh: 40,
    });
    expect(exported.route_points.find((item) => item.privacy_export_placeholder)).not.toHaveProperty('speed_kmh', 120);
  });

  it('keeps local distance exact and adds aggregate noise only to privacy-protected exports', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const trip = {
      distance_km: 10,
      route_points: [
        point(43.65, -79.38, 0),
        point(43.6522, -79.38, 30),
      ],
      driving_events: [],
    };
    const settings = { privacy_zones: [zone] };

    const localTrip = maskTripForPrivacy(trip, settings);
    const exportedTrip = maskTripForPrivacyExport(trip, settings, 'export-salt');

    expect(localTrip.distance_km).toBe(10);
    expect(localTrip.differential_privacy).toBeUndefined();
    expect(exportedTrip.distance_km).toBe(10.26);
    expect(exportedTrip.differential_privacy).toMatchObject({
      applied: true,
      scope: 'export',
    });
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
    // Checklist: "Delete a zone with purge enabled and confirm audit event plus trip rescore marker."
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
    expect(updateTrip.mock.calls[0][1].needs_rescore).toBe(true);
    await vi.waitFor(() => {
      expect(privacyZoneMocks.appendPrivacyEvent).toHaveBeenCalledWith(expect.objectContaining({
        op: 'PRIVATE_GPS_PURGED',
        details: expect.objectContaining({
          affected_trip_count: 1,
          purged_point_count: 1,
        }),
      }));
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

  it('derives zone activity from saved redacted trip records without render-time overcounting', () => {
    // Checklist: "Save or seed a trip crossing the zone and confirm protected GPS/event counts."
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T16:00:00.000Z'));
    const protectedAt = '2026-06-13T14:00:00.000Z';
    const trips = [{
      id: 'protected-trip',
      start_time: protectedAt,
      route_points: [
        { lat: null, lng: null, timestamp: protectedAt, masked_for_privacy: true, privacy_gap: true, privacy_zone_id: zone.id },
        { lat: 43.6532, lng: -79.38, timestamp: protectedAt },
      ],
      driving_events: [
        { type: 'harsh_brake', lat: null, lng: null, timestamp: protectedAt, masked_for_privacy: true, privacy_event_redacted: true, privacy_zone_id: zone.id },
      ],
    }];

    const [first] = deriveZoneStatsFromTrips(trips, { privacy_zones: [zone] });
    const [second] = deriveZoneStatsFromTrips(trips, { privacy_zones: [zone] });

    expect(first.today).toMatchObject({ hidden: 1, events: 1 });
    expect(first.week).toMatchObject({ hidden: 1, events: 1 });
    expect(first.lastActive).toBe(Date.parse(protectedAt));
    expect(second).toEqual(first);
  });

  it('derives zone activity from saved local route points inside privacy zones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T16:00:00.000Z'));
    const protectedAt = '2026-06-13T14:00:00.000Z';
    const trips = [{
      id: 'raw-zone-trip',
      start_time: protectedAt,
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: protectedAt },
        { lat: 43.6532, lng: -79.38, timestamp: protectedAt },
      ],
      driving_events: [
        { type: 'harsh_brake', lat: 43.65, lng: -79.38, timestamp: protectedAt },
      ],
    }];

    const [stats] = deriveZoneStatsFromTrips(trips, { privacy_zones: [zone] });

    expect(stats.today).toMatchObject({ hidden: 1, events: 1 });
    expect(stats.week).toMatchObject({ hidden: 1, events: 1 });
    expect(stats.allTime).toMatchObject({ hidden: 1, events: 1 });
    expect(stats.lastActive).toBe(Date.parse(protectedAt));
  });

  it('resets expired daily and weekly zone counters when the dashboard reads them', async () => {
    await getZoneStatsSnapshot({ privacy_zones: [zone] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T12:00:00.000Z'));
    await setEncryptedJson(ZONE_STATS_KEY, {
      home: {
        hiddenAllTime: 12,
        hiddenToday: 5,
        hiddenWeek: 9,
        eventsAllTime: 4,
        eventsToday: 2,
        eventsWeek: 3,
        addressesLeaked: 0,
        lastActive: Date.parse('2026-06-06T12:00:00.000Z'),
        dailyReset: Date.parse('2026-06-06T00:00:00.000Z'),
        weeklyReset: Date.parse('2026-06-01T00:00:00.000Z'),
      },
    });

    const [stats] = await getZoneStatsSnapshot({ privacy_zones: [zone] });
    const stored = await getEncryptedJson(ZONE_STATS_KEY, {});

    expect(stats.today).toMatchObject({ hidden: 0, events: 0 });
    expect(stats.week).toMatchObject({ hidden: 0, events: 0 });
    expect(stats.allTime).toMatchObject({ hidden: 12, events: 4 });
    expect(stored.home).toMatchObject({
      hiddenToday: 0,
      hiddenWeek: 0,
      eventsToday: 0,
      eventsWeek: 0,
    });
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
      privacy_cell_size_m: 50,
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

  it('keeps newly generated cell guards close to the configured privacy radius', () => {
    const generatedZone = {
      id: 'tight-home-cell',
      label: 'Home',
      radius_m: 100,
      privacy_cell_schema: 'global_grid_v1',
      privacy_cell_size_m: 50,
      privacy_cell_hashes: createPrivacyCellHashes(zone),
      masked_for_privacy: true,
    };
    const pointAbout170mNorth = point(43.65153, -79.38);

    expect(haversineDistance(
      pointAbout170mNorth.lat,
      pointAbout170mNorth.lng,
      zone.lat,
      zone.lng
    ) * 1000).toBeGreaterThan(160);
    expect(isInsidePrivacyZone(
      pointAbout170mNorth.lat,
      pointAbout170mNorth.lng,
      [generatedZone]
    )).toBe(false);
  });

  it('recovers display-only geometry for a cell-only zone from nearby map points', () => {
    const cellOnlyZone = {
      id: 'home-cell',
      label: 'Home',
      radius_m: 100,
      privacy_cell_schema: 'global_grid_v1',
      privacy_cell_size_m: 50,
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
    Capacitor.getPlatform.mockReturnValue('android');
    vi.stubGlobal('window', {});

    await syncZonesToNative([zone, { id: 'bad', label: 'Bad', lat: null, lng: -79.38, radius_m: 100 }]);

    expect(Preferences.set).not.toHaveBeenCalled();
    expect(secureSetPreference).toHaveBeenCalledTimes(1);
    const payload = secureSetPreference.mock.calls[0][0];
    expect(payload.key).toBe(NATIVE_PRIVACY_ZONES_KEY);
    expect(payload.context).toBe('native:privacy_zones_v1');
    expect(payload.encryptAtRest).toBe(true);
    expect(payload.value).not.toContain('43.65');
    expect(payload.value).not.toContain('-79.38');
    expect(payload.value).not.toContain('"lat"');
    expect(payload.value).not.toContain('"lng"');
    expect(JSON.parse(payload.value)[0].privacy_cell_size_m).toBe(50);
  });

  it('fails closed and pauses native tracking settings when native privacy sync fails', async () => {
    Capacitor.isNativePlatform.mockReturnValue(true);
    Capacitor.getPlatform.mockReturnValue('android');
    secureSetPreference.mockRejectedValueOnce(new Error('native preferences unavailable'));
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
    // Checklist: "Add a privacy zone and confirm it appears on Zones."
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

    const updated = await upsertPrivacyZone({ ...zone, exclude_from_osrm: false }, JSON.parse(values.get('drivesense_settings')));
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
    const [zoneForDashboard] = await getZoneStatsSnapshot(updated, []);
    expect(zoneForDashboard).toMatchObject({
      id: 'home',
      label: 'Home',
      radius_m: 100,
      today: { hidden: 0, events: 0 },
    });
  });

  it('matches points against each segment of a multi-segment corridor', () => {
    const corridor = {
      id: 'private-street',
      label: 'Private street',
      type: 'corridor',
      width_m: 80,
      radius_m: 80,
      sensitivity: 'standard',
      waypoints: [
        { lat: 43.65, lng: -79.39 },
        { lat: 43.65, lng: -79.38 },
        { lat: 43.66, lng: -79.38 },
      ],
    };

    expect(isPointInPrivacyZone({ lat: 43.6503, lng: -79.385 }, [corridor])?.id).toBe('private-street');
    expect(isPointInPrivacyZone({ lat: 43.655, lng: -79.3797 }, [corridor])?.id).toBe('private-street');
    expect(isPointInPrivacyZone({ lat: 43.655, lng: -79.376 }, [corridor])).toBeNull();
    expect(createPrivacyCellHashes(corridor).length).toBeGreaterThan(0);
  });

  it('downsamples a saved route to the corridor waypoint limit while preserving endpoints', () => {
    const route = Array.from({ length: 60 }, (_, index) => ({
      lat: 43.65 + index * 0.0001,
      lng: -79.38,
    }));
    const waypoints = corridorWaypointsFromRoute(route);

    expect(waypoints).toHaveLength(20);
    expect(waypoints[0]).toEqual(route[0]);
    expect(waypoints.at(-1)).toEqual(route.at(-1));
  });

  it('expires a temporary zone through the purge-on-delete flow', async () => {
    const now = Date.UTC(2026, 5, 22, 16);
    const expiredZone = {
      id: 'temporary',
      label: 'Temporary visit',
      lat: 43.65,
      lng: -79.38,
      radius_m: 120,
      expiresAt: new Date(now - 1000).toISOString(),
    };
    const trip = {
      id: 'temporary-trip',
      route_points: [point(43.65, -79.38)],
      driving_events: [],
    };
    privacyZoneMocks.listTrips.mockResolvedValue([trip]);

    await upsertPrivacyZone(expiredZone, localSettings.get());
    privacyZoneMocks.appendPrivacyEvent.mockClear();
    const result = await sweepExpiredPrivacyZones(now);

    expect(result).toMatchObject({
      expiredCount: 1,
      purgedTrips: 1,
      purgedPoints: 1,
    });
    expect(privacyZoneMocks.updateTrip).toHaveBeenCalledWith(
      'temporary-trip',
      expect.objectContaining({
        needs_rescore: true,
        route_points: [expect.objectContaining({ privacy_purged: true })],
      })
    );
    expect(privacyZoneMocks.appendPrivacyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'PRIVATE_GPS_PURGED', zoneId: 'temporary' })
    );
    expect(privacyZoneMocks.appendPrivacyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'ZONE_DELETED', zoneId: 'temporary' })
    );
    expect(getPrivacyZones(localSettings.get()).some((item) => item.id === 'temporary')).toBe(false);
  });

  it('purges existing raw GPS immediately when a high-sensitivity zone is saved', async () => {
    privacyZoneMocks.listTrips.mockResolvedValue([{
      id: 'high-trip',
      route_points: [point(43.651, -79.381)],
      driving_events: [],
    }]);

    await upsertPrivacyZone({
      id: 'high',
      label: 'High sensitivity',
      lat: 43.651,
      lng: -79.381,
      radius_m: 100,
      sensitivity: 'high',
    }, localSettings.get());

    expect(privacyZoneMocks.updateTrip).toHaveBeenCalledWith(
      'high-trip',
      expect.objectContaining({
        needs_rescore: true,
        route_points: [expect.objectContaining({ privacy_purged: true })],
      })
    );
  });

  it('suggests the smallest wider radius that catches raw near-misses', () => {
    const north = (meters) => ({
      lat: zone.lat + meters / 111320,
      lng: zone.lng,
    });
    const effectiveness = getZoneEffectiveness(zone, [{
      route_points: [
        north(90),
        north(120),
        north(175),
        north(205),
        { lat: null, lng: null, masked_for_privacy: true },
      ],
      driving_events: [
        north(150),
      ],
    }]);

    expect(effectiveness.nearMissCount).toBe(3);
    expect(effectiveness.suggestedRadiusM).toBe(175);
  });

  it('caps zone-effectiveness suggestions at the maximum privacy radius', () => {
    const wideZone = { ...zone, radius_m: 950 };
    const north = (meters) => ({
      lat: zone.lat + meters / 111320,
      lng: zone.lng,
    });

    expect(getZoneEffectiveness(wideZone, [{
      route_points: [north(1000.5), north(1010)],
    }])).toEqual({
      nearMissCount: 1,
      suggestedRadiusM: 1000,
    });
  });

  it('migrates legacy plaintext privacy zones into encrypted storage and scrubs settings', async () => {
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        privacy_zones: [{ ...zone, exclude_from_osrm: false }],
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
      privacy_cell_size_m: 50,
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
