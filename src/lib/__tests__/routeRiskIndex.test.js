import { describe, expect, it } from 'vitest';
import {
  buildRouteRiskIndex,
  getSegmentsForTrip,
  loadRouteRiskIndex,
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
