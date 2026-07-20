import { describe, expect, it } from 'vitest';
import { resolveParkedLocation } from '@/lib/parkedLocationResolver';

const point = (lat, lng, seconds, speed_kmh, accuracy = 8) => ({
  lat,
  lng,
  speed_kmh,
  accuracy,
  timestamp: new Date(Date.UTC(2026, 6, 18, 18, 0, seconds)).toISOString(),
});

describe('parked location resolver', () => {
  it('uses the stable terminal cluster and avoids a noisy final GPS fix', () => {
    const points = [
      point(43.65, -79.38, 0, 35),
      point(43.651, -79.38, 10, 18),
      point(43.6512, -79.38, 20, 4, 7),
      point(43.65121, -79.38001, 35, 0, 6),
      point(43.65119, -79.38, 50, 0, 8),
      point(43.65155, -79.3803, 65, 0, 55),
    ];

    const result = resolveParkedLocation(points, { endTime: '2026-07-18T18:01:05.000Z' });

    expect(result.location.strategy).toBe('terminal_stop_cluster');
    expect(result.location.confidence).toBe('high');
    expect(result.location.lat).toBeCloseTo(43.6512, 4);
    expect(result.location.lat).not.toBe(points.at(-1).lat);
    expect(points).toContainEqual(expect.objectContaining({
      lat: result.location.lat,
      lng: result.location.lng,
    }));
  });

  it('returns an estimate when only the last trip point is usable', () => {
    const result = resolveParkedLocation([point(43.65, -79.38, 0, 20, 25)]);

    expect(result.location).toMatchObject({
      lat: 43.65,
      lng: -79.38,
      confidence: 'estimated',
      strategy: 'last_trip_point',
      sampleCount: 1,
    });
  });

  it('fails closed when the newest endpoint is privacy-redacted', () => {
    const result = resolveParkedLocation([
      point(43.65, -79.38, 0, 30),
      { lat: null, lng: null, privacy_gap: true, masked_for_privacy: true },
    ]);

    expect(result).toEqual({ location: null, suppressionReason: 'privacy_zone' });
  });

  it('rejects null island instead of offering directions there', () => {
    const result = resolveParkedLocation([{ lat: 0, lng: 0, speed_kmh: 0 }]);

    expect(result.location).toBeNull();
    expect(result.suppressionReason).toBe('trip_end_unavailable');
  });
});

