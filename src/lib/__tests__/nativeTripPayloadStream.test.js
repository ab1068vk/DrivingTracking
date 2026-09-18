import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  chunks: [],
  closed: [],
}));

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    openTripPayload: vi.fn(async () => ({ handle: 'payload-handle', chunkCount: fixture.chunks.length })),
    readTripPayloadChunk: vi.fn(async ({ chunkIndex }) => ({ plaintextBase64: base64(fixture.chunks[chunkIndex]) })),
    closeTripPayload: vi.fn(async ({ handle }) => { fixture.closed.push(handle); return { closed: true }; }),
  }),
}));

import { iterateNativeTripJsonArray } from '@/lib/nativeTripArchive';

describe('native canonical payload array stream', () => {
  beforeEach(() => {
    fixture.closed.length = 0;
    const json = JSON.stringify({
      id: 'streamed-trip',
      note: 'route_points before value must not confuse the key parser',
      route_points: Array.from({ length: 1000 }, (_, index) => ({
        index,
        lat: 43 + index / 10000,
        lng: -79 - index / 10000,
        label: index === 511 ? 'escaped \\"point\\"' : 'point',
      })),
      status: 'completed',
    });
    fixture.chunks = [];
    for (let offset = 0; offset < json.length; offset += 997) {
      fixture.chunks.push(json.slice(offset, offset + 997));
    }
  });

  it('yields exact points across arbitrary chunk and escape boundaries and always closes the handle', async () => {
    const indexes = [];
    for await (const point of iterateNativeTripJsonArray('streamed-trip')) indexes.push(point.index);
    expect(indexes).toHaveLength(1000);
    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(999);
    expect(fixture.closed).toEqual(['payload-handle']);
  });
});
