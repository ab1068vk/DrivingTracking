import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D3 retirement boundary, at the caller.
 *
 * A VERIFIED spatial owner selects affected trips from its persistent
 * postings, and the retired all-history discovery scan is not entered. A
 * domain that has demoted names its refusal, and the caller takes that typed
 * disposition instead of quietly restoring the scan. Only a domain that never
 * claimed coverage still gets the bounded compatibility scan.
 */

const state = vi.hoisted(() => ({
  trips: [],
  selection: null,
  selectionError: null,
  selectionStep: vi.fn(),
  buildPatch: vi.fn(),
  update: vi.fn(),
  historyPages: vi.fn(),
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    getById: vi.fn(async (id) => state.trips.find((trip) => String(trip.id) === String(id))),
    queryHistoryPage: state.historyPages,
    getPayloadStream: vi.fn(async (id) => {
      const trip = state.trips.find((item) => String(item.id) === String(id));
      return (async function* points() {
        for (const point of trip?.route_points || []) yield point;
      })();
    }),
    update: state.update,
  },
}));
vi.mock('@/lib/openSourceTripContext', () => ({ buildLocalSpeedKnowledgeScorePatch: state.buildPatch }));
vi.mock('@/lib/systemLog', () => ({ recordSystemEvent: vi.fn(), logSystemFailure: vi.fn() }));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: vi.fn(() => ({})) } }));
vi.mock('@/lib/p6TripDerivedState', () => ({
  createP6AffectedTripSelectionRequest: vi.fn(async () => {
    if (state.selectionError) throw state.selectionError;
    return state.selection;
  }),
  stepP6AffectedTripSelection: state.selectionStep,
}));

import { geohashEncode } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCell } from '@/lib/localSpeedScoreRefresh';
import { removeJson, setJson } from '@/lib/mobileStorage';
import { RESCORING_QUEUE_KEY } from '@/lib/rescoringQueue';
import {
  P6_EXPLICIT_OPERATION_STATE_KEY,
  listP6ExplicitOperations,
  markP6ExplicitOperationsAfterRestart,
  readP6ExplicitOperation,
  resumeP6ExplicitOperation,
  runKnownP6ExplicitOperationTurn,
} from '@/lib/p6ExplicitOperations';

const point = { lat: 43.6532, lng: -79.3832 };
const geohash = geohashEncode(point.lat, point.lng);

describe('P6 D3 affected-trip selection retirement', () => {
  beforeEach(async () => {
    await setJson(RESCORING_QUEUE_KEY, []);
    await removeJson(P6_EXPLICIT_OPERATION_STATE_KEY);
    state.trips = [
      { id: 'matching', status: 'completed', route_points: [point, { lat: 43.6533, lng: -79.3833 }] },
    ];
    state.selection = null;
    state.selectionError = null;
    state.selectionStep.mockReset().mockResolvedValue({ state: 'IDLE', itemsWorked: 1, bytesWorked: 0 });
    state.buildPatch.mockReset().mockResolvedValue({ score_overall: 88, needs_rescore: false });
    state.update.mockReset().mockImplementation(async (id, patch) => ({ id, ...patch }));
    state.historyPages.mockReset().mockImplementation(async ({ status = '' } = {}) => ({
      rows: state.trips.filter((trip) => !status || trip.status === status),
      nextCursor: null,
      hasMore: false,
    }));
  });

  it('routes through P6 postings and never enters the retired scan when D3 is VERIFIED', async () => {
    state.selection = { state: 'READY', accepted: true, requestIds: ['req-1'], tokenCount: 3 };

    const result = await refreshTripsCrossingLocalSpeedCell(geohash);

    expect(result).toEqual([]);
    expect(state.historyPages).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('takes the typed refusal, not the retired scan, when D3 has demoted', async () => {
    state.selection = {
      state: 'REBUILD_REQUIRED', accepted: false, reason: 'SPATIAL_SELECTION_UNAVAILABLE',
    };

    const result = await refreshTripsCrossingLocalSpeedCell(geohash);

    expect(result).toHaveLength(0);
    expect(result.spatialSelectionRefused).toBe(true);
    expect(result.spatialSelectionPending).toBe(true);
    expect(result.p6OperationId).toEqual(expect.any(String));
    expect(result.spatialSelectionReason).toBe('SPATIAL_SELECTION_UNAVAILABLE');
    expect(state.historyPages).not.toHaveBeenCalled();
  });

  it('keeps refused descriptors durable across restart and creates requests after D3 recovers', async () => {
    state.selection = {
      state: 'REBUILD_REQUIRED', accepted: false, reason: 'SPATIAL_SELECTION_UNAVAILABLE',
    };
    const refused = await refreshTripsCrossingLocalSpeedCell(geohash);
    const [debt] = await listP6ExplicitOperations();
    expect(debt).toMatchObject({
      operationId: refused.p6OperationId,
      cursor: { phase: 'CREATE_REQUESTS' },
      details: { selectionPending: true, spatialSelectionReason: 'SPATIAL_SELECTION_UNAVAILABLE' },
    });
    expect(debt.details.descriptors).toEqual([{ kind: 'cell', geohash }]);

    await markP6ExplicitOperationsAfterRestart();
    expect((await readP6ExplicitOperation(debt.operationId)).state).toBe('PAUSED_AFTER_RESTART');
    await resumeP6ExplicitOperation(debt.operationId);
    state.selection = { state: 'READY', accepted: true, requestIds: ['recovered-request'], tokenCount: 3 };
    const created = await runKnownP6ExplicitOperationTurn(debt.operationId);
    expect(created).toMatchObject({
      state: 'READY', cursor: { phase: 'DRAIN_SELECTION' },
      details: { selectionPending: false, request: { requestIds: ['recovered-request'] } },
    });
    const completed = await runKnownP6ExplicitOperationTurn(debt.operationId);
    expect(completed.state).toBe('COMPLETED');
    expect(state.selectionStep).toHaveBeenCalledTimes(1);
  });

  it('still runs the bounded compatibility scan for a domain that never claimed coverage', async () => {
    state.selection = { state: 'REBUILD_REQUIRED', accepted: false };

    const result = await refreshTripsCrossingLocalSpeedCell(geohash);

    expect(state.historyPages).toHaveBeenCalled();
    expect(result.map((trip) => trip.id)).toEqual(['matching']);
  });

  it('fails closed rather than scanning when the owner errors for any other reason', async () => {
    state.selectionError = new Error('P6_CONTROL_WRITE_FAILED');

    await expect(refreshTripsCrossingLocalSpeedCell(geohash)).rejects.toThrow('P6_CONTROL_WRITE_FAILED');
    expect(state.historyPages).not.toHaveBeenCalled();
  });
});
