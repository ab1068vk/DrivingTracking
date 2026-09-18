import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  storage: new Map(),
  reads: [],
  writes: [],
  trip: { id: 'trip-queued', route_points: [{ lat: 1, lng: 2 }, { lat: 1.1, lng: 2.1 }] },
  buildPatch: vi.fn(),
  buildWeatherPatch: vi.fn(),
  updateTrip: vi.fn(),
  getTrip: vi.fn(),
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => {
    state.reads.push(key);
    return state.storage.has(key) ? state.storage.get(key) : fallback;
  }),
  setJson: vi.fn(async (key, value) => {
    state.writes.push(key);
    if (value === null) state.storage.delete(key);
    else state.storage.set(key, value);
  }),
}));

vi.mock('@/lib/openSourceTripContext', () => ({
  buildOpenSourceTripContextPatch: state.buildPatch,
  buildWeatherOnlyTripContextPatch: state.buildWeatherPatch,
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    update: state.updateTrip,
    getById: state.getTrip,
  },
}));

vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: vi.fn(() => ({ weather_context_enabled: true })) },
}));

vi.mock('@/lib/systemLog', () => ({ recordSystemEvent: vi.fn() }));

import {
  ROAD_CONTEXT_QUEUE_CONVERSION_STORAGE_KEY,
  ROAD_CONTEXT_QUEUE_PAGE_SIZE,
  ROAD_CONTEXT_QUEUE_STORAGE_KEY,
  ROAD_CONTEXT_TURN_MAX_EXAMINED,
  convertLegacyRoadContextQueue,
  listPendingRoadContextEntries,
  resumePendingRoadContextJobs,
  runRoadContextRefresh,
  runWeatherContextRefresh,
  stepPendingRoadContextJobs,
} from '@/lib/roadContextQueue';
import { MONOLITHIC_DOCUMENT_OWNER } from '@/lib/monolithicCompatibility';

describe('road context recovery queue', () => {
  beforeEach(() => {
    state.storage.clear();
    state.reads = [];
    state.writes = [];
    state.buildPatch.mockReset();
    state.buildWeatherPatch.mockReset();
    state.updateTrip.mockReset();
    state.getTrip.mockReset();
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    state.buildWeatherPatch.mockResolvedValue({ weather_context: { status: 'fetched' } });
    state.updateTrip.mockResolvedValue({ ...state.trip, speed_limit_context: { status: 'fetched' } });
    state.getTrip.mockResolvedValue(state.trip);
  });

  it('persists before work starts and clears only after the trip update succeeds', async () => {
    state.buildPatch.mockImplementationOnce(async () => {
      await expect(listPendingRoadContextEntries()).resolves.toEqual([
        expect.objectContaining({ tripId: state.trip.id }),
      ]);
      return { speed_limit_context: { status: 'fetched' } };
    });

    await runRoadContextRefresh(state.trip, {});

    expect(state.updateTrip).toHaveBeenCalledWith(state.trip.id, {
      speed_limit_context: { status: 'fetched' },
    });
    expect(state.buildPatch).toHaveBeenCalledWith(state.trip, {
      weather_context_enabled: false,
    }, {
      immediateRequests: true,
    });
    await expect(listPendingRoadContextEntries()).resolves.toEqual([]);
  });

  it('keeps interrupted work and completes it on the next resume', async () => {
    state.buildPatch.mockRejectedValueOnce(new Error('app closed'));
    await expect(runRoadContextRefresh(state.trip, {})).rejects.toThrow('app closed');
    await expect(listPendingRoadContextEntries()).resolves.toHaveLength(1);

    await resumePendingRoadContextJobs();

    expect(state.getTrip).toHaveBeenCalledWith(state.trip.id);
    expect(state.updateTrip).toHaveBeenCalledTimes(1);
    await expect(listPendingRoadContextEntries()).resolves.toEqual([]);
  });

  it('strips weather authorization from every road-data job', async () => {
    await runRoadContextRefresh(state.trip, {
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
    });

    expect(state.buildPatch).toHaveBeenCalledWith(state.trip, {
      weather_context_enabled: false,
      speed_limit_lookup_enabled: true,
    }, {
      immediateRequests: true,
    });
  });

  it('runs a weather-only refresh without adding a road-context recovery job', async () => {
    await runWeatherContextRefresh(state.trip, {});

    expect(state.buildWeatherPatch).toHaveBeenCalledWith(state.trip, {}, {
      immediateRequests: true,
    });
    expect(state.updateTrip).toHaveBeenCalledWith(state.trip.id, {
      weather_context: { status: 'fetched' },
    });
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY) || []).toEqual([]);
  });
});

describe('P4-C-F06: the road-context queue is durably paged', () => {
  beforeEach(() => {
    state.storage.clear();
    state.reads = [];
    state.writes = [];
    state.buildPatch.mockReset();
    state.updateTrip.mockReset();
    state.getTrip.mockReset();
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    state.updateTrip.mockImplementation(async (id) => ({ id }));
    state.getTrip.mockImplementation(async (id) => ({ id, route_points: [] }));
  });

  const seed = async (count) => {
    for (let index = 0; index < count; index += 1) {
      const trip = { id: `trip-${index}`, route_points: [] };
      state.buildPatch.mockRejectedValueOnce(new Error('offline'));
      await expect(runRoadContextRefresh(trip, {})).rejects.toThrow('offline');
    }
  };

  const storageTouchesPerTurn = async () => {
    state.reads = [];
    state.writes = [];
    await stepPendingRoadContextJobs({ maxEntries: 4 });
    return {
      queueRecordReads: state.reads.filter((key) => key.includes('road_context')).length,
      queueRecordWrites: state.writes.filter((key) => key.includes('road_context')).length,
    };
  };

  it.each([8, 60, 240])('touches a fixed number of queue records per turn at N=%s', async (total) => {
    await seed(total);
    await expect(listPendingRoadContextEntries()).resolves.toHaveLength(total);

    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    const touches = await storageTouchesPerTurn();

    // Metadata plus one page plus per-entry membership markers for that page:
    // never a function of the total queued N.
    const ceiling = (ROAD_CONTEXT_QUEUE_PAGE_SIZE * 3) + 16;
    expect(touches.queueRecordReads).toBeLessThanOrEqual(ceiling);
    expect(touches.queueRecordWrites).toBeLessThanOrEqual(ceiling);
  });

  it('never reads or writes one document holding every queued entry', async () => {
    await seed(60);
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    state.reads = [];
    state.writes = [];

    await stepPendingRoadContextJobs({ maxEntries: 4 });

    for (const key of [...state.reads, ...state.writes]) {
      const value = state.storage.get(key);
      if (Array.isArray(value)) {
        expect(value.length).toBeLessThanOrEqual(ROAD_CONTEXT_QUEUE_PAGE_SIZE);
      }
    }
  });

  it('drains through more turns as the queue grows, preserving dedupe and retries', async () => {
    await seed(30);
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    // Re-queueing an already-queued trip is still a no-op.
    await runRoadContextRefresh({ id: 'trip-0', route_points: [] }, {});
    await expect(listPendingRoadContextEntries()).resolves.toHaveLength(29);

    let turns = 0;
    for (; turns < 200; turns += 1) {
      const turn = await stepPendingRoadContextJobs({ maxEntries: 4 });
      if (!turn.processed) break;
    }

    expect(turns).toBeGreaterThan(1);
    await expect(listPendingRoadContextEntries()).resolves.toEqual([]);
  });

  it('reports every entry it read, not only the ones it ran', async () => {
    await seed(8);
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    const turn = await stepPendingRoadContextJobs({ maxEntries: 4 });

    // P4-C-F09: the turn ran four entries but read the whole page to find them,
    // and the eight rows it read are what it actually consumed.
    expect(turn.processed).toBe(4);
    expect(turn.examined).toBe(8);
    expect(turn.examined).toBeLessThanOrEqual(ROAD_CONTEXT_TURN_MAX_EXAMINED);
  });
});

describe('P4-C-F06-A: the monolithic v1 road-context document is not lifecycle work', () => {
  beforeEach(() => {
    state.storage.clear();
    state.reads = [];
    state.writes = [];
    state.buildPatch.mockReset();
    state.updateTrip.mockReset();
    state.getTrip.mockReset();
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    state.updateTrip.mockImplementation(async (id) => ({ id }));
    state.getTrip.mockImplementation(async (id) => ({ id, route_points: [] }));
  });

  const legacyDocument = (count) => Array.from({ length: count }, (_, index) => ({
    tripId: `legacy-${index}`,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
  }));

  it.each([100, 2500, 10000])(
    'a bounded turn never reads or rewrites the v1 document at N=%s',
    async (total) => {
      state.storage.set(ROAD_CONTEXT_QUEUE_STORAGE_KEY, legacyDocument(total));
      state.reads = [];
      state.writes = [];

      const turn = await stepPendingRoadContextJobs({ maxEntries: 4 });

      // Load-bearing: restoring the whole-document parse/rewrite per turn puts
      // the legacy key back into these lists and fails here.
      expect(state.reads).not.toContain(ROAD_CONTEXT_QUEUE_STORAGE_KEY);
      expect(state.writes).not.toContain(ROAD_CONTEXT_QUEUE_STORAGE_KEY);
      expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toHaveLength(total);
      // The obligation is reported, and it is reported as somebody else's.
      expect(turn).toMatchObject({
        processed: 0,
        legacyDocumentPending: true,
        legacyDocumentOwner: MONOLITHIC_DOCUMENT_OWNER,
      });
      expect(turn.legacyDocumentWake).toMatchObject({ type: 'compatibility_conversion' });
    }
  );

  it('costs the same per turn however large the v1 document is', async () => {
    const costAt = async (total) => {
      state.storage.clear();
      state.storage.set(ROAD_CONTEXT_QUEUE_STORAGE_KEY, legacyDocument(total));
      state.reads = [];
      state.writes = [];
      await stepPendingRoadContextJobs({ maxEntries: 4 });
      return { reads: state.reads.length, writes: state.writes.length };
    };

    const small = await costAt(100);
    const large = await costAt(10000);
    expect(large).toEqual(small);
  });

  it('converts the v1 document only in the explicit compatibility session', async () => {
    state.storage.set(ROAD_CONTEXT_QUEUE_STORAGE_KEY, legacyDocument(60));

    await stepPendingRoadContextJobs({ maxEntries: 4 });
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toHaveLength(60);

    const session = await convertLegacyRoadContextQueue();

    expect(session).toMatchObject({ converted: 60, completed: true });
    // The document is drained one bounded page at a time, so no queued trip is
    // discarded and nothing is converted in one unbounded allocation.
    expect(session.pages).toBe(Math.ceil(60 / ROAD_CONTEXT_QUEUE_PAGE_SIZE));
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toBeUndefined();
    await expect(listPendingRoadContextEntries()).resolves.toHaveLength(60);

    // Once discharged, a turn stops reporting the obligation at O(1).
    const turn = await stepPendingRoadContextJobs({ maxEntries: 4 });
    expect(turn.legacyDocumentPending).toBeUndefined();
    // And the session is idempotent.
    await expect(convertLegacyRoadContextQueue()).resolves.toMatchObject({
      converted: 0, completed: true,
    });
  });

  it('resumes an interrupted conversion from its restart-safe marker', async () => {
    // A session that stopped after its first page: the marker records progress
    // and the document still holds everything it had not moved yet.
    state.storage.set(ROAD_CONTEXT_QUEUE_CONVERSION_STORAGE_KEY, {
      startedAt: 1, moved: 25, completedAt: null,
    });
    state.storage.set(ROAD_CONTEXT_QUEUE_STORAGE_KEY, legacyDocument(35));

    // The obligation is still outstanding for a bounded turn.
    const before = await stepPendingRoadContextJobs({ maxEntries: 4 });
    expect(before.legacyDocumentPending).toBe(true);

    await convertLegacyRoadContextQueue();

    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toBeUndefined();
    await expect(listPendingRoadContextEntries()).resolves.toHaveLength(35);
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_CONVERSION_STORAGE_KEY)).toMatchObject({
      moved: 60,
    });
  });

  it('the explicit resume is the compatibility owner', async () => {
    state.storage.set(ROAD_CONTEXT_QUEUE_STORAGE_KEY, legacyDocument(30));

    await resumePendingRoadContextJobs();

    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toBeUndefined();
    await expect(listPendingRoadContextEntries()).resolves.toEqual([]);
    expect(state.updateTrip).toHaveBeenCalledTimes(30);
  });
});
