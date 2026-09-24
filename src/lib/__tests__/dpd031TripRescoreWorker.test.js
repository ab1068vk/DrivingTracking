import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  logError: vi.fn(),
}));

const { logSystemFailure } = await import('@/lib/systemLog');
const { buildDrivingThresholds } = await import('@/lib/tripEngine');
const { computeTripRescore, packKnowledgeResults, unpackKnowledgeResults } = await import('@/lib/tripRescoreCompute');
const {
  computeTripRescoreOffMainThread,
  TRIP_RESCORE_WORKER_TIMEOUT_MS,
  __resetTripRescoreWorkerForTests,
} = await import('@/lib/tripRescoreWorkerClient');

// DPD-031. The rescore's scoring moved into a Web Worker so a long route cannot
// freeze the UI. These tests pin that the move changes no score: the worker gets
// structured-cloned input, and the knowledge result is an array carrying extra
// properties that a naive clone would silently drop.

const buildTrip = (count) => {
  const t0 = Date.parse('2026-09-01T21:30:00Z');
  const route = [];
  let lat = 43.65;
  let lng = -79.38;
  for (let i = 0; i < count; i += 1) {
    const cruise = i % 300 < 20 ? 18 + (i % 20) * 3 : 78 + ((i * 7) % 23); // stops, acceleration, cruise
    lat += 0.00012;
    lng += (i % 60 < 30 ? 0.00009 : -0.00004);
    route.push({ lat, lng, speed_kmh: cruise, accuracy: 6, heading: 45, timestamp: new Date(t0 + i * 2000).toISOString() });
  }
  return {
    id: 'rs_test_dpd031',
    status: 'completed',
    start_time: route[0].timestamp,
    end_time: route[route.length - 1].timestamp,
    route_points: route,
    weather_context: null,
  };
};

const buildKnowledge = (points) => {
  const results = points.map((p, i) => (i % 5 === 0
    ? { limitKmh: i % 10 === 0 ? 60 : 80, source: 'trip_consensus', confidence: 0.8, geohash: 'dpz83n' }
    : null));
  Object.defineProperty(results, 'knowledgeMetadata', {
    configurable: true,
    enumerable: false,
    value: { schemaVersion: 4, knowledgeRevision: 7, knowledgeUpdatedAt: '2026-09-18T20:00:00.000Z' },
  });
  results.sourceReliability = { trip_consensus: { hits: 12, misses: 3 } };
  return results;
};

const inputFor = (trip) => ({
  trip,
  scoringRoutePoints: trip.route_points,
  thresholds: buildDrivingThresholds({}),
  privacyZones: [],
  settings: {},
  knowledge: packKnowledgeResults(buildKnowledge(trip.route_points)),
});

// Only the wall-clock provenance stamps differ between two runs of the same input
// (measured: score_provenance.computed_at, score_inputs.computed_at). Everything
// else - every score, event and statistic - must be identical.
const stable = (result) => {
  const copy = structuredClone(result);
  if (copy?.scores?.score_provenance) delete copy.scores.score_provenance.computed_at;
  if (copy?.scores?.score_inputs) delete copy.scores.score_inputs.computed_at;
  return copy;
};

afterEach(() => {
  __resetTripRescoreWorkerForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  logSystemFailure.mockClear();
});

describe('DPD-031 rescore worker boundary', () => {
  it('carries knowledgeMetadata and sourceReliability across a structured clone', () => {
    const original = buildKnowledge([{}, {}, {}, {}, {}, {}]);
    const naive = structuredClone(original);
    expect(naive.knowledgeMetadata).toBeUndefined(); // why packing exists
    const restored = unpackKnowledgeResults(structuredClone(packKnowledgeResults(original)));
    expect([...restored]).toEqual([...original]);
    expect(restored.knowledgeMetadata).toEqual(original.knowledgeMetadata);
    expect(Object.keys(restored)).not.toContain('knowledgeMetadata'); // still non-enumerable
    expect(restored.sourceReliability).toEqual(original.sourceReliability);
  });

  it('scores a large route identically in-process and through the worker boundary', () => {
    const trip = buildTrip(3000);
    const direct = computeTripRescore(inputFor(trip));
    const viaClone = structuredClone(computeTripRescore(structuredClone(inputFor(trip))));
    expect(stable(viaClone)).toEqual(stable(direct));
    expect(direct.scores.score_overall).toEqual(expect.any(Number));
    expect(direct.stats.duration_seconds).toBe(2999 * 2);
  });

  it('is deterministic across repeated runs', () => {
    const trip = buildTrip(1200);
    expect(stable(computeTripRescore(inputFor(trip)))).toEqual(stable(computeTripRescore(inputFor(trip))));
  });

  it('uses the worker when one exists and never computes on the main thread', async () => {
    const posted = [];
    class FakeWorker {
      constructor() { this.listeners = { message: [], error: [] }; }
      addEventListener(type, fn) { this.listeners[type].push(fn); }
      postMessage(data) {
        posted.push(data.requestId);
        const result = computeTripRescore(structuredClone(data.input));
        setTimeout(() => this.listeners.message.forEach((fn) => fn({ data: structuredClone({ requestId: data.requestId, result }) })), 0);
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const trip = buildTrip(600);
    const result = await computeTripRescoreOffMainThread(inputFor(trip));
    expect(posted).toHaveLength(1);
    expect(stable(result)).toEqual(stable(computeTripRescore(inputFor(trip))));
    expect(logSystemFailure).not.toHaveBeenCalled();
  });

  it('falls back to the main thread, visibly, when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const trip = buildTrip(300);
    const first = await computeTripRescoreOffMainThread(inputFor(trip));
    await computeTripRescoreOffMainThread(inputFor(trip));
    expect(stable(first)).toEqual(stable(computeTripRescore(inputFor(trip))));
    expect(logSystemFailure).toHaveBeenCalledTimes(1); // logged once, not per trip
    expect(logSystemFailure.mock.calls[0][0]).toBe('trip_rescore_worker_fallback');
  });

  it('falls back when the worker module fails to load, so the rescore still converges', async () => {
    class BrokenWorker {
      constructor() { this.listeners = { message: [], error: [] }; }
      addEventListener(type, fn) { this.listeners[type].push(fn); }
      postMessage() { setTimeout(() => this.listeners.error.forEach((fn) => fn({ message: 'module load failed' })), 0); }
      terminate() {}
    }
    vi.stubGlobal('Worker', BrokenWorker);
    const trip = buildTrip(300);
    const result = await computeTripRescoreOffMainThread(inputFor(trip));
    expect(stable(result)).toEqual(stable(computeTripRescore(inputFor(trip))));
    expect(logSystemFailure).toHaveBeenCalledWith('trip_rescore_worker_fallback', expect.any(Error));
  });

  it('fails a hung request after the timeout instead of hanging the queue', async () => {
    vi.useFakeTimers();
    class SilentWorker {
      addEventListener() {}
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', SilentWorker);
    const pending = computeTripRescoreOffMainThread(inputFor(buildTrip(50)));
    const settled = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(TRIP_RESCORE_WORKER_TIMEOUT_MS + 1);
    await settled;
  });
});
