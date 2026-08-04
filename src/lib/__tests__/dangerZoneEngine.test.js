import { describe, expect, it } from 'vitest';
import {
  buildDangerZones,
  checkDangerZoneProximity,
  DANGER_ZONE_CELL_SIZE_M,
  DANGER_ZONE_MIN_EVENTS,
} from '@/lib/dangerZoneEngine';

const event = (lat, lng, severity = 'low', type = 'harsh_brake') => ({
  type,
  severity,
  lat,
  lng,
  timestamp: '2026-01-01T12:00:00.000Z',
});

const trip = (events) => ({
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  driving_events: events,
});

describe('dangerZoneEngine', () => {
  it('buildDangerZones with 0 trips returns []', () => {
    expect(buildDangerZones([])).toEqual([]);
  });

  it('keeps the premium evidence explanation aligned with engine defaults', () => {
    expect(DANGER_ZONE_CELL_SIZE_M).toBe(80);
    expect(DANGER_ZONE_MIN_EVENTS).toBe(3);
    expect(buildDangerZones([trip([
      event(43.6532, -79.3832),
      event(43.6532, -79.3832),
    ])])).toEqual([]);
    expect(buildDangerZones([trip([
      event(43.6532, -79.3832),
      event(43.6532, -79.3832),
      event(43.6532, -79.3832),
    ])])).toHaveLength(1);
  });

  it('filters out events below minEvents threshold', () => {
    const zones = buildDangerZones([trip([event(43.6532, -79.3832)])], { minEvents: 2 });
    expect(zones).toEqual([]);
  });

  it('merges nearby events into one zone', () => {
    const zones = buildDangerZones([trip([
      event(43.6532, -79.3832),
      event(43.6532, -79.3832, 'medium', 'speeding'),
    ])], { minEvents: 2 });

    expect(zones).toHaveLength(1);
    expect(zones[0].eventCount).toBe(2);
    expect(zones[0].typeBreakdown.speeding).toBe(1);
  });

  it('excludes low-confidence proxy events from repeated event areas', () => {
    const zones = buildDangerZones([trip([
      event(43.6532, -79.3832, 'medium', 'near_miss'),
      event(43.6532, -79.3832, 'medium', 'close_proximity'),
    ])], { minEvents: 1 });

    expect(zones).toEqual([]);
  });

  it('assigns riskLevel for each severity band', () => {
    const low = buildDangerZones([trip([event(43.65, -79.38)])], { minEvents: 1 })[0];
    const medium = buildDangerZones([trip([
      event(43.65, -79.38, 'high'),
      event(43.65, -79.38, 'low'),
    ])], { minEvents: 1 })[0];
    const high = buildDangerZones([trip([
      event(43.65, -79.38, 'high'),
      event(43.65, -79.38, 'high'),
      event(43.65, -79.38, 'medium'),
    ])], { minEvents: 1 })[0];
    const critical = buildDangerZones([trip(Array.from({ length: 5 }, (_, _index) => (
      event(43.65, -79.38, 'high')
    )))], { minEvents: 1 })[0];

    expect(low.riskLevel).toBe('low');
    expect(medium.riskLevel).toBe('medium');
    expect(high.riskLevel).toBe('high');
    expect(critical.riskLevel).toBe('critical');
  });

  it('returns only nearby repeated event areas sorted by distance', () => {
    const zones = [
      { id: 'near', lat: 43.65321, lng: -79.3832 },
      { id: 'far', lat: 43.7, lng: -79.4 },
    ];
    const nearby = checkDangerZoneProximity(43.6532, -79.3832, zones, 200);

    expect(nearby.map((zone) => zone.id)).toEqual(['near']);
  });

  it('returns [] when no zones are nearby', () => {
    const zones = [{ id: 'far', lat: 43.7, lng: -79.4 }];
    expect(checkDangerZoneProximity(43.6532, -79.3832, zones, 100)).toEqual([]);
  });
});
