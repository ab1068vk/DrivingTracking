import { describe, expect, it } from 'vitest';
import {
  buildRouteRiskIndex,
  getSegmentsForTrip,
  loadRouteRiskIndex,
  ROUTE_RISK_CONSTANTS,
  saveRouteRiskIndex,
  segmentKey,
  speedRiskBonus,
} from '@/lib/routeRiskIndex';

const points = [
  { lat: 43.6532, lng: -79.3832, speed_kmh: 40, accuracy: 5, timestamp: '2026-01-01T12:00:00.000Z' },
  { lat: 43.6542, lng: -79.3832, speed_kmh: 40, accuracy: 5, timestamp: '2026-01-01T12:00:10.000Z' },
  { lat: 43.6552, lng: -79.3832, speed_kmh: 40, accuracy: 5, timestamp: '2026-01-01T12:00:20.000Z' },
];

const trip = (events = []) => ({
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  end_time: '2026-01-01T12:10:00.000Z',
  route_points: points,
  driving_events: events,
});

describe('routeRiskIndex', () => {
  it('segmentKey is commutative', () => {
    expect(segmentKey(1, 2, 3, 4)).toBe(segmentKey(3, 4, 1, 2));
  });

  it('empty trips return empty Map', () => {
    expect(buildRouteRiskIndex([]).size).toBe(0);
  });

  it('two trips on the same segment increase tripCount to 2', () => {
    const index = buildRouteRiskIndex([trip(), trip()]);
    expect([...index.values()][0].tripCount).toBe(2);
  });

  it('riskScore is 0 when no events are associated', () => {
    const index = buildRouteRiskIndex([trip()]);
    expect([...index.values()][0].riskScore).toBe(0);
  });

  it('keeps riskScore finite when all source trips report zero distance', () => {
    const index = buildRouteRiskIndex([
      { ...trip(), distance_km: 0 },
      { ...trip([{ type: 'harsh_brake', lat: 43.6537, lng: -79.3832 }]), distance_km: 0 },
    ]);

    expect([...index.values()].every((segment) => Number.isFinite(segment.riskScore))).toBe(true);
  });

  it('applies named provisional event and harsh-event route-risk weights', () => {
    expect(ROUTE_RISK_CONSTANTS).toMatchObject({
      ROUTE_RISK_EVENT_WEIGHT: 20,
      ROUTE_RISK_HARSH_WEIGHT: 40,
    });

    const generalIndex = buildRouteRiskIndex([
      trip([{ type: 'speeding', lat: 43.6537, lng: -79.3832 }]),
    ]);
    const harshIndex = buildRouteRiskIndex([
      trip([{ type: 'harsh_brake', lat: 43.6537, lng: -79.3832 }]),
    ]);

    expect([...generalIndex.values()][0].riskScore).toBe(20);
    expect([...harshIndex.values()][0].riskScore).toBe(60);
  });

  it('excludes low-confidence proxy events from repeated-event route layers', () => {
    const index = buildRouteRiskIndex([
      trip([
        { type: 'near_miss', lat: 43.6537, lng: -79.3832 },
        { type: 'close_proximity', lat: 43.6537, lng: -79.3832 },
      ]),
    ]);
    const firstSegment = [...index.values()][0];

    expect(firstSegment.totalEvents).toBe(0);
    expect(firstSegment.eventTypes).toEqual({});
    expect(firstSegment.riskScore).toBe(0);
  });

  it('does not persist segment midpoints inside the privacy-zone guard', () => {
    const index = buildRouteRiskIndex([trip()], [{
      id: 'home',
      lat: 43.6537,
      lng: -79.3832,
      radius_m: 40,
    }]);
    const midpoints = [...index.values()].map((item) => [item.lat, item.lng]);

    expect(midpoints).not.toContainEqual([43.6537, -79.3832]);
    expect(index.size).toBe(1);
  });

  it('skips privacy boundary segments even without current zone settings', () => {
    const maskedTrip = trip();
    maskedTrip.route_points = [
      { ...points[0], privacy_boundary: true, masked_for_privacy: true, privacy_zone_id: 'home' },
      { ...points[1], privacy_boundary: true, masked_for_privacy: true, privacy_zone_id: 'home' },
      points[2],
    ];

    expect(buildRouteRiskIndex([maskedTrip]).size).toBe(0);
  });

  it('graduates speed risk instead of using a binary highway-speed bonus', () => {
    expect(speedRiskBonus(99)).toBe(0);
    expect(speedRiskBonus(101)).toBeLessThan(speedRiskBonus(160));
    expect(speedRiskBonus(160)).toBe(15);
  });

  it('getSegmentsForTrip returns only segments with tripCount >= 2', () => {
    expect(getSegmentsForTrip(trip(), buildRouteRiskIndex([trip()]))).toHaveLength(0);
    expect(getSegmentsForTrip(trip(), buildRouteRiskIndex([trip(), trip()])).length).toBeGreaterThan(0);
  });

  it('saveRouteRiskIndex/loadRouteRiskIndex round-trips a small index', async () => {
    const index = buildRouteRiskIndex([trip([{ type: 'harsh_brake', lat: 43.6537, lng: -79.3832 }]), trip()]);
    await saveRouteRiskIndex(index);
    const loaded = await loadRouteRiskIndex();
    expect(loaded.size).toBe(index.size);
  });

  it('merges stored risk cells whose midpoints are within GPS-noise distance', async () => {
    await saveRouteRiskIndex(new Map([
      ['a', { lat: 43.6532, lng: -79.3832, tripCount: 1, totalEvents: 1, harshCount: 1, speedSum: 40, eventTypes: { harsh_brake: 1 }, riskScore: 50, riskLevel: 'moderate' }],
      ['b', { lat: 43.65327, lng: -79.3832, tripCount: 1, totalEvents: 0, harshCount: 0, speedSum: 40, eventTypes: {}, riskScore: 0, riskLevel: 'low' }],
    ]));
    const loaded = await loadRouteRiskIndex();
    expect(loaded.size).toBe(1);
    expect([...loaded.values()][0].tripCount).toBe(2);
  });

  it('filters stored risk cells inside the privacy-zone guard', async () => {
    await saveRouteRiskIndex(new Map([
      ['private', { lat: 43.6537, lng: -79.3832, tripCount: 2, totalEvents: 1, harshCount: 1, speedSum: 40, eventTypes: { harsh_brake: 1 }, riskScore: 60, riskLevel: 'high' }],
      ['public', { lat: 43.6567, lng: -79.3832, tripCount: 2, totalEvents: 0, harshCount: 0, speedSum: 40, eventTypes: {}, riskScore: 0, riskLevel: 'low' }],
    ]));

    const loaded = await loadRouteRiskIndex([{
      id: 'home',
      lat: 43.6537,
      lng: -79.3832,
      radius_m: 50,
    }]);

    expect(loaded.has('private')).toBe(false);
    expect(loaded.has('public')).toBe(true);
  });

  it('trims storage when serialized index exceeds 2 MB', async () => {
    const index = new Map();
    for (let i = 0; i < 6000; i++) {
      index.set(`seg-${i}`, {
        tripCount: i,
        totalEvents: 0,
        eventTypes: {},
        filler: 'x'.repeat(400),
      });
    }
    await saveRouteRiskIndex(index);
    const loaded = await loadRouteRiskIndex();
    expect(loaded.size).toBe(5000);
    expect(loaded.has('seg-5999')).toBe(true);
  });
});
