import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, sanitizeError, scrubDiagnosticText } from '@/lib/errorReporting';

const stubLocalStorage = () => {
  const values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
  return values;
};

describe('error reporting privacy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scrubs coordinate-bearing URLs and bare coordinate decimals from error messages', () => {
    const error = new TypeError(
      'Failed to fetch https://nominatim.openstreetmap.org/reverse?format=json&lat=43.651234&lon=-79.383210&zoom=17 near 43.651234,-79.383210'
    );
    error.stack = [
      'TypeError: Failed to fetch https://nominatim.openstreetmap.org/reverse?lat=43.651234&lon=-79.383210',
      '    at fetchRoute (C:\\Users\\name\\project\\src\\x.js:1:1)',
    ].join('\n');

    const sanitized = sanitizeError(error);

    expect(sanitized.message).toContain('lat=[REDACTED]');
    expect(sanitized.message).toContain('lon=[REDACTED]');
    expect(sanitized.message).toContain('[COORD]');
    expect(sanitized.message).not.toContain('43.651234');
    expect(sanitized.message).not.toContain('-79.383210');
    expect(sanitized.stack).not.toContain('43.651234');
    expect(sanitized.stack).not.toContain('-79.383210');
    expect(sanitized.stack).not.toContain('C:\\Users');
  });

  it('scrubs string extras and drops sensitive coordinate-shaped extra keys', () => {
    const values = stubLocalStorage();

    const diagnostic = logError('reverse_geocode_lookup', new Error('lookup failed at 43.651234'), {
      lat: 43.651234,
      lng: -79.383210,
      route_points: [{ lat: 43.651234, lng: -79.383210 }],
      url: 'https://example.test/reverse?q=43.651234,-79.383210&zoom=17',
      point_count: 12,
    });
    const events = JSON.parse(values.get('road_sage_tracking_diagnostics'));

    expect(diagnostic.detail).not.toContain('43.651234');
    expect(diagnostic.lat).toBeUndefined();
    expect(diagnostic.lng).toBeUndefined();
    expect(diagnostic.route_points).toBeUndefined();
    expect(diagnostic.lat_redacted).toBe(true);
    expect(diagnostic.lng_redacted).toBe(true);
    expect(diagnostic.route_points_redacted).toBe(true);
    expect(diagnostic.url).toContain('q=[REDACTED]');
    expect(diagnostic.url).not.toContain('43.651234');
    expect(diagnostic.point_count).toBe(12);
    expect(JSON.stringify(events)).not.toContain('43.651234');
    expect(JSON.stringify(events)).not.toContain('-79.383210');
  });

  it('redacts coordinate query params without removing unrelated query params', () => {
    expect(scrubDiagnosticText('https://example.test/path?format=json&lat=43.651234&zoom=17'))
      .toBe('https://example.test/path?format=json&lat=[REDACTED]&zoom=17');
  });
});
