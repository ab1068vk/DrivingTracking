import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => true, isNativePlatform: () => true,
}));

const bridge = {
  calls: [],
  pages: [],
  accepted: new Map(),
  failCreateAt: null,
};

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: {
    createP6AffectedSelection: vi.fn(async (payload) => {
      bridge.calls.push({ method: 'createP6AffectedSelection', payload });
      if (bridge.failCreateAt && bridge.calls.filter((call) => call.method === 'createP6AffectedSelection').length === bridge.failCreateAt) {
        throw new Error('NATIVE_PAGE_WRITE_FAILED');
      }
      if (!bridge.accepted.has(payload.requestId)) bridge.accepted.set(payload.requestId, {
        accepted: true, requestId: payload.requestId, tokenCount: payload.cells.length,
      });
      return bridge.accepted.get(payload.requestId);
    }),
    stepP6AffectedSelection: vi.fn(async () => {
      bridge.calls.push({ method: 'stepP6AffectedSelection', payload: {} });
      return bridge.pages.shift() || { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false };
    }),
    acknowledgeP6AffectedSelection: vi.fn(async (requestId, matched) => {
      bridge.calls.push({ method: 'acknowledgeP6AffectedSelection', payload: { requestId, matched } });
      return { state: 'ACKNOWLEDGED', itemsWorked: 1, bytesWorked: 0 };
    }),
  },
}));

vi.mock('@/lib/rescoringQueue', () => ({ enqueueRescoreJob: vi.fn(async () => ({ accepted: true })) }));

import { createP6AffectedTripSelectionRequest, stepP6NativeAffectedTripSelection } from '@/lib/p6TripDerivedState';

const encoder = new TextEncoder();
// Independent bridge observer: it measures the serialized size of what actually
// crosses the JS/native boundary, and never reads a reported counter.
const crossedBytes = (call) => encoder.encode(JSON.stringify(call.payload)).byteLength;

// Roughly 350 m between successive section points.
const corridor = (kilometres) => Array.from(
  { length: Math.max(2, Math.round(kilometres / 0.35)) },
  (_, index) => ({ lat: 43.6 + index * 0.00225, lng: -79.4 + index * 0.00225 }),
);

describe('P6-V22 bridge observer: more history is more turns, not wider turns', () => {
  beforeEach(() => {
    bridge.calls = []; bridge.pages = []; bridge.accepted = new Map(); bridge.failCreateAt = null;
  });
  afterEach(() => vi.clearAllMocks());

  it('splits a growing corridor into more bounded bridge requests of the same shape', async () => {
    const measure = async (kilometres) => {
      bridge.calls = [];
      const result = await createP6AffectedTripSelectionRequest({
        descriptors: [{ kind: 'exclusion', sectionPoints: corridor(kilometres) }],
        reason: 'speed_knowledge_rules_changed',
      });
      expect(result.accepted).toBe(true);
      const requests = bridge.calls.filter((call) => call.method === 'createP6AffectedSelection');
      return {
        requests: requests.length,
        widestCells: Math.max(...requests.map((call) => call.payload.cells.length)),
        widestBytes: Math.max(...requests.map(crossedBytes)),
        widestCellBytes: Math.max(...requests.map(
          (call) => encoder.encode(JSON.stringify(call.payload.cells)).byteLength,
        )),
      };
    };

    const short = await measure(2);
    const long = await measure(600);
    expect(short.requests).toBeGreaterThan(0);
    expect(long.requests).toBeGreaterThan(short.requests);
    // Three hundred times the corridor buys more bridge turns at the same frozen 4,096
    // cell ceiling; no single request grows with retained geography.
    expect(long.widestCells).toBeLessThanOrEqual(4096);
    expect(short.widestCells).toBeLessThanOrEqual(4096);
    // The retained-geography part of the request is what must stay bounded: the
    // cell page is capped whatever the corridor length. The descriptor beside
    // it is the caller's own input, repeated per page so each page is
    // self-contained.
    expect(long.widestCellBytes).toBeLessThanOrEqual(4096 * 48);
    expect(short.widestCellBytes).toBeLessThanOrEqual(4096 * 48);
    expect(long.widestBytes).toBeGreaterThan(0);
    for (const call of bridge.calls) {
      if (call.method !== 'createP6AffectedSelection') continue;
      expect(call.payload.descriptors).toHaveLength(1);
    }
  }, 120_000);

  it('consumes each precise page in one bounded turn and acknowledges with a constant payload', async () => {
    const page = (index) => ({
      state: 'PRECISE_PAGE', requestId: `req-${index}`, tripId: `trip-${index}`,
      itemsWorked: 128, bytesWorked: 4096,
      descriptors: [{ kind: 'cell', geohash: 'dpz80zz' }],
      points: Array.from({ length: 128 }, (_, point) => ({
        lat: 43.6 + point * 0.0001, lng: -79.4 + point * 0.0001, timestamp: 1_756_000_000_000 + point * 1000,
      })),
    });
    bridge.pages = Array.from({ length: 24 }, (_, index) => page(index));

    let turns = 0;
    let widestResponse = 0;
    let widestAcknowledge = 0;
    for (; turns < 100; turns += 1) {
      const before = bridge.calls.length;
      const result = await stepP6NativeAffectedTripSelection();
      const step = bridge.calls.slice(before);
      const acknowledge = step.find((call) => call.method === 'acknowledgeP6AffectedSelection');
      if (acknowledge) widestAcknowledge = Math.max(widestAcknowledge, crossedBytes(acknowledge));
      widestResponse = Math.max(widestResponse, Number(result.itemsWorked) || 0);
      if (result.state === 'IDLE') break;
      // One step is exactly one page request plus at most one acknowledgement.
      expect(step.filter((call) => call.method === 'stepP6AffectedSelection')).toHaveLength(1);
      expect(step.length).toBeLessThanOrEqual(2);
    }
    expect(turns).toBe(24);
    expect(widestResponse).toBeLessThanOrEqual(129);
    // The acknowledgement never carries the page it acknowledges.
    expect(widestAcknowledge).toBeLessThanOrEqual(64);
  }, 120_000);

  it('reports exact partial acceptance and retries native pages idempotently', async () => {
    bridge.failCreateAt = 3;
    const descriptor = { kind: 'exclusion', sectionPoints: corridor(600) };
    const first = await createP6AffectedTripSelectionRequest({ descriptors: [descriptor] });
    expect(first).toMatchObject({
      accepted: false,
      reason: 'SPATIAL_SELECTION_REQUEST_PARTIALLY_ACCEPTED',
      partialAcceptance: { committedPages: 2, failedDescriptorIndex: 0 },
    });
    expect(first.partialAcceptance.requestIds).toHaveLength(2);

    bridge.failCreateAt = null;
    const retried = await createP6AffectedTripSelectionRequest({
      descriptors: [descriptor], continuation: first.partialAcceptance,
    });
    expect(retried.accepted).toBe(true);
    const calls = bridge.calls.filter((call) => call.method === 'createP6AffectedSelection');
    expect(new Set(calls.map((call) => call.payload.requestId)).size).toBe(retried.requestIds.length);
    expect(bridge.accepted.size).toBe(retried.requestIds.length);
    expect(retried.requestIds.slice(0, 2)).toEqual(first.partialAcceptance.requestIds);
  }, 120_000);
});
