import { describe, expect, it } from 'vitest';

import { decodeP6PointBlock, encodeP6PointBlock } from '@/lib/p6PointBlockCodec';

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;

const point = (overrides = {}) => ({
  lat: 43.6512345, lng: -79.3812345, timestamp: 1_756_000_000_000, speedKmh: 42.5,
  heading: 91, accuracy: 6, speedLimitKmh: 60, limitSource: 'osm',
  utcOffsetMinutes: -240, timezoneId: 'America/Toronto', ...overrides,
});

describe('P6 public-point block codec', () => {
  it('round-trips every compact field and keeps absence distinct from zero', () => {
    const points = [
      point(),
      point({
        speedKmh: null, heading: null, accuracy: null, speedLimitKmh: null,
        limitSource: '', utcOffsetMinutes: null, timezoneId: '',
      }),
      point({ speedKmh: 0, heading: 0, accuracy: 0, speedLimitKmh: 0, utcOffsetMinutes: 0, timestamp: null }),
    ];
    const decoded = decodeP6PointBlock(encodeP6PointBlock(points));
    expect(decoded).toHaveLength(3);
    for (let index = 0; index < points.length; index += 1) {
      for (const [key, value] of Object.entries(points[index])) {
        expect(decoded[index][key], `${key}@${index}`).toBe(value);
      }
    }
  });

  it('carries a non-numeric recorded-at value through unchanged', () => {
    const decoded = decodeP6PointBlock(encodeP6PointBlock([
      point({ timestamp: '2026-09-01T00:00:00.000Z' }),
      point({ timestamp: null }),
    ]));
    expect(decoded[0].timestamp).toBe('2026-09-01T00:00:00.000Z');
    expect(decoded[1].timestamp).toBeNull();
  });

  it('decodes a legacy array of point objects unchanged', () => {
    const legacy = [{ lat: 5, lng: 6, timestamp: 7 }];
    expect(decodeP6PointBlock(legacy)).toBe(legacy);
    expect(decodeP6PointBlock(null)).toEqual([]);
    expect(decodeP6PointBlock({ v: 2, n: 0 })).toEqual([]);
  });

  it('spends a small fraction of the frozen per-point envelope term', () => {
    // E(N,P,S) budgets 224 bytes per permitted public point for the block, its
    // posting, index overhead and encrypted framing together, so the block
    // itself has to cost a fraction of that even before AES-GCM and base64.
    const points = Array.from({ length: 128 }, (_, index) => point({
      lat: 43.65 + index * 0.00021, lng: -79.38 - index * 0.00017,
      timestamp: 1_756_000_000_000 + index * 1000, speedKmh: 40 + (index % 30),
    }));
    const encoded = bytes(encodeP6PointBlock(points));
    const named = bytes(points);
    expect(encoded).toBeLessThan(named / 3);
    expect(encoded / points.length).toBeLessThan(60);
  });
});
