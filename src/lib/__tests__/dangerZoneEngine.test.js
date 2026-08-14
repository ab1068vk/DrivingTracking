/**
 * "Repeated event area" has to mean something the driver would recognise: a
 * place they keep having the same trouble. The engine used to count raw events
 * on a rounded grid, which got both halves wrong — a single drive could
 * manufacture a "repeated" area, while three genuinely co-located events could
 * be split by an invisible grid line and counted as nothing.
 *
 * Several tests here previously asserted the old behaviour (whole zones built
 * from one trip). They have been rewritten rather than deleted, because what
 * they were really checking — thresholds, severity bands, type breakdown — still
 * matters; only the number of drives involved had to change.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAlertDangerZones,
  buildDangerZones,
  checkDangerZoneProximity,
  DANGER_ZONE_CELL_SIZE_M,
  DANGER_ZONE_MIN_EVENTS,
} from '@/lib/dangerZoneEngine';
import { DANGER_ZONE_MIN_TRIPS } from '@/lib/appConstants';

const event = (lat, lng, severity = 'low', type = 'harsh_brake') => ({
  type,
  severity,
  lat,
  lng,
  timestamp: '2026-01-01T12:00:00.000Z',
});

const trip = (events, id = 't1') => ({
  id,
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  driving_events: events,
});

/** The same place visited on `count` separate drives, `perTrip` events each. */
const drives = (count, perTrip, lat = 43.6532, lng = -79.3832, severity = 'low') => (
  Array.from({ length: count }, (_, i) => trip(
    Array.from({ length: perTrip }, () => event(lat, lng, severity)),
    `trip_${i}`
  ))
);

describe('buildDangerZones', () => {
  it('returns [] for no trips', () => {
    expect(buildDangerZones([])).toEqual([]);
  });

  it('will not call one drive repeated, however many events it contained', () => {
    // The 4 s harsh-brake cooldown means three brakes inside one small area on a
    // single bad approach is entirely ordinary. That is one occurrence, not a
    // pattern, and it used to produce an area.
    expect(buildDangerZones(drives(1, 5), { minEvents: 3 })).toEqual([]);
  });

  it('forms an area once the same place recurs across drives', () => {
    const zones = buildDangerZones(drives(3, 1), { minEvents: 3 });
    expect(zones).toHaveLength(1);
    expect(zones[0].tripCount).toBe(3);
    expect(zones[0].eventCount).toBe(3);
  });

  it('keeps the documented defaults', () => {
    expect(DANGER_ZONE_CELL_SIZE_M).toBe(80);
    expect(DANGER_ZONE_MIN_EVENTS).toBe(3);
    expect(DANGER_ZONE_MIN_TRIPS).toBe(2);
    expect(buildDangerZones(drives(2, 1))).toEqual([]);
    expect(buildDangerZones(drives(3, 1))).toHaveLength(1);
  });

  it('honours both thresholds independently', () => {
    // Enough events but not enough drives.
    expect(buildDangerZones(drives(1, 4), { minEvents: 2, minTrips: 2 })).toEqual([]);
    // Enough drives but not enough events.
    expect(buildDangerZones(drives(2, 1), { minEvents: 4, minTrips: 2 })).toEqual([]);
    expect(buildDangerZones(drives(2, 2), { minEvents: 4, minTrips: 2 })).toHaveLength(1);
  });

  it('clusters events that a rounded grid would have split', () => {
    // Three events spanning 12 m astride the old 80 m grid boundary. This is the
    // case that reported "no repeated event area" at a place braked at weekly.
    const latStep = 80 / 111320;
    const boundary = (Math.round(43.6532 / latStep) + 0.5) * latStep;
    const zones = buildDangerZones(
      [-6, 0, 6].map((d, i) => trip([event(boundary + d / 111320, -79.3832)], `trip_${i}`)),
      { minEvents: 3 }
    );
    expect(zones).toHaveLength(1);
    expect(zones[0].eventCount).toBe(3);
  });

  it('merges nearby events of different types into one area', () => {
    const zones = buildDangerZones([
      trip([event(43.6532, -79.3832)], 'a'),
      trip([event(43.6532, -79.3832, 'medium', 'sharp_turn')], 'b'),
    ], { minEvents: 2 });

    expect(zones).toHaveLength(1);
    expect(zones[0].eventCount).toBe(2);
    expect(zones[0].typeBreakdown.sharp_turn).toBe(1);
    expect(zones[0].typeBreakdown.harsh_brake).toBe(1);
  });

  it('counts rapid_acceleration, which was silently excluded before', () => {
    const zones = buildDangerZones([
      trip([event(43.6532, -79.3832, 'medium', 'rapid_acceleration')], 'a'),
      trip([event(43.6532, -79.3832, 'medium', 'rapid_acceleration')], 'b'),
    ], { minEvents: 2 });
    expect(zones).toHaveLength(1);
    expect(zones[0].dominantType).toBe('rapid_acceleration');
  });

  it('does not cluster speeding, because its position is not repeatable', () => {
    // A continuous over-limit run emits one event at whichever fix was fastest,
    // so the same road twice puts them nowhere near each other. Habitual
    // speeding is a stretch, handled by speedingStretches.
    const zones = buildDangerZones([
      trip([event(43.6532, -79.3832, 'medium', 'speeding')], 'a'),
      trip([event(43.6532, -79.3832, 'medium', 'speeding')], 'b'),
    ], { minEvents: 2 });
    expect(zones).toEqual([]);
  });

  it('excludes low-confidence proxy events', () => {
    const zones = buildDangerZones([
      trip([event(43.6532, -79.3832, 'medium', 'near_miss')], 'a'),
      trip([event(43.6532, -79.3832, 'medium', 'close_proximity')], 'b'),
    ], { minEvents: 1, minTrips: 1 });
    expect(zones).toEqual([]);
  });

  it('skips diagnostic-only events and trips that never completed', () => {
    const diagnostic = { ...event(43.6532, -79.3832), diagnostic_only: true };
    expect(buildDangerZones([
      trip([diagnostic], 'a'),
      trip([diagnostic], 'b'),
    ], { minEvents: 1, minTrips: 1 })).toEqual([]);

    const running = { ...trip([event(43.6532, -79.3832)], 'a'), status: 'in_progress' };
    expect(buildDangerZones([running, trip([event(43.6532, -79.3832)], 'b')], {
      minEvents: 1, minTrips: 1,
    })).toHaveLength(1);
  });

  it('never places an area at Null Island from privacy-masked events', () => {
    // Masking nulls coordinates in place. Number(null) is 0, so these used to
    // pile up at (0, 0) and could form an area out of the driver's private trips.
    const masked = { type: 'harsh_brake', severity: 'high', lat: null, lng: null, masked_for_privacy: true };
    const zones = buildDangerZones(
      Array.from({ length: 5 }, (_, i) => trip([masked], `trip_${i}`)),
      { minEvents: 1, minTrips: 1 }
    );
    expect(zones).toEqual([]);
  });

  it('assigns riskLevel for each severity band', () => {
    const at = (severities) => buildDangerZones(
      severities.map((severity, i) => trip([event(43.65, -79.38, severity)], `trip_${i}`)),
      { minEvents: 1, minTrips: 1 }
    )[0];

    expect(at(['low']).riskLevel).toBe('low');
    expect(at(['high', 'low']).riskLevel).toBe('medium');
    expect(at(['high', 'high', 'medium']).riskLevel).toBe('high');
    expect(at(Array.from({ length: 5 }, () => 'high')).riskLevel).toBe('critical');
  });

  it('reports exposure as unknown rather than zero when no index is supplied', () => {
    const zone = buildDangerZones(drives(3, 1), { minEvents: 3 })[0];
    expect(zone.passes).toBeNull();
    expect(zone.eventRate).toBeNull();
  });

  it('ranks a place that catches you most passes above one you merely drive often', () => {
    // Same event count at both places; only exposure differs. Without this the
    // busiest commute road always wins, which is the opposite of useful.
    const caughtOften = { lat: 43.6532, lng: -79.3832 };
    const busyRoad = { lat: 43.7532, lng: -79.3832 };
    const trips = [0, 1, 2].map((i) => trip([
      event(caughtOften.lat, caughtOften.lng),
      event(busyRoad.lat, busyRoad.lng),
    ], `trip_${i}`));

    const zones = buildDangerZones(trips, {
      minEvents: 3,
      routeRiskIndex: [
        { ...caughtOften, tripCount: 4 },
        { ...busyRoad, tripCount: 60 },
      ],
    });

    expect(zones).toHaveLength(2);
    expect(zones[0].lat).toBeCloseTo(caughtOften.lat, 4);
    expect(zones[0].passes).toBe(4);
    expect(zones[0].eventRate).toBeCloseTo(0.75, 5);
    expect(zones[1].passes).toBe(60);
    expect(zones[1].eventRate).toBeCloseTo(0.05, 5);
  });

  it('gives a stable id across rebuilds so alert history survives', () => {
    const first = buildDangerZones(drives(3, 1), { minEvents: 3 })[0];
    const second = buildDangerZones(drives(3, 1), { minEvents: 3 })[0];
    expect(first.id).toBe(second.id);
  });
});

describe('buildAlertDangerZones', () => {
  it('uses the looser alert threshold but still requires repetition', () => {
    expect(buildAlertDangerZones(drives(1, 4))).toEqual([]);
    expect(buildAlertDangerZones(drives(2, 1))).toHaveLength(1);
  });

  it('accepts overrides so callers can pass exposure', () => {
    const zones = buildAlertDangerZones(drives(2, 1), {
      routeRiskIndex: [{ lat: 43.6532, lng: -79.3832, tripCount: 8 }],
    });
    expect(zones[0].passes).toBe(8);
  });
});

describe('checkDangerZoneProximity', () => {
  it('returns only nearby areas sorted by distance', () => {
    const zones = [
      { id: 'near', lat: 43.65321, lng: -79.3832 },
      { id: 'far', lat: 43.7, lng: -79.4 },
    ];
    expect(checkDangerZoneProximity(43.6532, -79.3832, zones, 200).map((z) => z.id)).toEqual(['near']);
  });

  it('returns [] when nothing is nearby', () => {
    expect(checkDangerZoneProximity(43.6532, -79.3832, [{ id: 'far', lat: 43.7, lng: -79.4 }], 100))
      .toEqual([]);
  });
});
