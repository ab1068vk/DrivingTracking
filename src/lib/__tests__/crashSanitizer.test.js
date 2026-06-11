import { describe, expect, it } from 'vitest';
import { sanitizeCrashPayload } from '@/lib/crashSanitizer';

describe('sanitizeCrashPayload', () => {
  it('redacts GPS coordinates, privacy zones, routes, and timestamps', () => {
    const payload = {
      message: 'Failure near 43.6532,-79.3832 at 2026-06-11T14:30:00.000Z',
      latitude: 43.6532,
      zoneCenter: { lat: 43.65, lng: -79.38 },
      trip: {
        route_points: [{ latitude: 43.7, longitude: -79.4 }],
        start_time: 1781188200000,
      },
      zone_id: 'home',
      stack: 'location lat=43.6532 lng=-79.3832; raw 43.7001 -79.4001; state {"latitude":43.7123}',
    };

    const sanitized = sanitizeCrashPayload(payload);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.latitude).toBe('[REDACTED]');
    expect(sanitized.zoneCenter).toBe('[REDACTED]');
    expect(sanitized.zone_id).toBe('[REDACTED]');
    expect(sanitized.trip.route_points).toBe('[REDACTED]');
    expect(sanitized.trip.start_time).toBe('[TS_REDACTED]');
    expect(serialized).not.toContain('43.6532');
    expect(serialized).not.toContain('-79.3832');
    expect(serialized).not.toContain('43.7123');
    expect(serialized).not.toContain('1781188200000');
    expect(serialized).not.toContain('2026-06-11T14:30:00.000Z');
  });

  it('handles errors, circular references, and hostile getters without leaking', () => {
    const payload = {
      error: new Error('Route failed at 43.6532,-79.3832'),
      coordinates: [43.6532, -79.3832],
    };
    payload.self = payload;
    Object.defineProperty(payload, 'unsafe', {
      enumerable: true,
      get() {
        throw new Error('secret location 43.7000,-79.4000');
      },
    });

    const sanitized = sanitizeCrashPayload(payload);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.coordinates).toBe('[REDACTED]');
    expect(sanitized.self).toBe('[CIRCULAR]');
    expect(sanitized.unsafe).toBe('[REDACTED]');
    expect(serialized).not.toContain('43.6532');
    expect(serialized).not.toContain('43.7000');
  });

  it('redacts coordinate pairs even when their containing key is unknown', () => {
    const sanitized = sanitizeCrashPayload({
      debug: {
        samples: [[43.6532, -79.3832], [43.7001, -79.4001]],
      },
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('43.6532');
    expect(serialized).not.toContain('-79.4001');
    expect(serialized).toContain('[LAT_REDACTED],[LNG_REDACTED]');
  });
});
