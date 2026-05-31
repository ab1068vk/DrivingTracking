import { afterEach, describe, expect, it, vi } from 'vitest';
import { tripService } from '@/api/trips';
import { importDriveSenseBackup } from '@/lib/dataBackup';
import { runStorageKeyMigration, STORAGE_KEY_MIGRATION_DONE_KEY } from '@/lib/storageKeyMigration';
import { TRIP_SCHEMA_VERSION } from '@/lib/localTripRepository';

vi.mock('@/api/trips', () => ({
  tripService: {
    upsertMany: vi.fn(async (trips) => trips),
  },
}));

vi.mock('@/api/vehicles', () => ({
  vehicleService: {
    upsertMany: vi.fn(async (vehicles) => vehicles),
  },
}));

function makeMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => store.get(key) ?? null),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    values: store,
  };
}

const buildV1Trip = () => ({
  id: 'smoke-v1-trip',
  schema_version: TRIP_SCHEMA_VERSION,
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  end_time: '2026-01-01T12:05:00.000Z',
  updated_at: '2026-01-01T12:05:00.000Z',
  route_points: [],
  driving_events: [],
  distance_km: 0,
  duration_seconds: 300,
  score_overall: null,
  score_safety: null,
  score_smoothness: null,
  score_eco: null,
  component_scores: {},
  score_provenance: {
    scoring_version: null,
    components: {},
    constants_snapshot: {},
  },
  vehicle_id: null,
  nickname: null,
  notes: null,
  tags: [],
  is_favorite: false,
});

const buildBackup = ({ version = 1, trips = [] } = {}) => ({
  app: 'Road Sage',
  version,
  trips,
});

describe('migration smoke tests', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('copies legacy storage keys before backup migration smoke coverage runs', async () => {
    const storage = makeMemoryStorage({
      drivesense_trips: JSON.stringify([{ id: 'legacy-trip' }]),
    });
    vi.stubGlobal('localStorage', storage);

    await expect(runStorageKeyMigration()).resolves.toBe(true);

    expect(storage.values.get('road_sage_trips')).toBe(JSON.stringify([{ id: 'legacy-trip' }]));
    expect(storage.values.get(STORAGE_KEY_MIGRATION_DONE_KEY)).toBe('1');
  });

  it('migrates a v1 backup all the way to current without data loss', async () => {
    const v1Trip = buildV1Trip();
    const backup = buildBackup({ version: 1, trips: [v1Trip] });
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(backup)),
    };

    const result = await importDriveSenseBackup(file);

    expect(result.trips).toBe(1);
    expect(result.warnings).toHaveLength(0);
    expect(tripService.upsertMany).toHaveBeenCalledTimes(1);
    const [[importedTrips]] = tripService.upsertMany.mock.calls;
    expect(importedTrips[0]).toMatchObject({
      id: v1Trip.id,
      status: 'completed',
      route_points: [],
      driving_events: [],
      score_provenance: expect.any(Object),
      needs_rescore: true,
    });
  });
});
