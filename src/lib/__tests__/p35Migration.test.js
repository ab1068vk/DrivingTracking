import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listLegacyMigrationPage: vi.fn(),
  getLegacyTripForMigration: vi.fn(),
  ingestJournal: vi.fn(),
  migrationCheckpoint: vi.fn(),
  saveMigrationCheckpoint: vi.fn(),
  quarantineLegacySource: vi.fn(),
  completeMigration: vi.fn(),
  streamJsonToMigration: vi.fn(),
  sha256Hex: vi.fn(),
}));

vi.mock('@/lib/localTripRepository', () => ({
  localTripRepository: {
    listLegacyMigrationPage: mocks.listLegacyMigrationPage,
    getLegacyTripForMigration: mocks.getLegacyTripForMigration,
  },
}));

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: {
    ingestJournal: mocks.ingestJournal,
    migrationCheckpoint: mocks.migrationCheckpoint,
    saveMigrationCheckpoint: mocks.saveMigrationCheckpoint,
    quarantineLegacySource: mocks.quarantineLegacySource,
    completeMigration: mocks.completeMigration,
  },
  streamJsonToMigration: mocks.streamJsonToMigration,
  sha256Hex: mocks.sha256Hex,
}));

import { migrateLegacyTripsToNativeArchive } from '@/lib/p35Migration';

describe('P3.5 legacy migration source/target failure boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ingestJournal.mockResolvedValue({ hasMore: false, itemCount: 0 });
    mocks.migrationCheckpoint.mockResolvedValue({ checkpoint: null });
    mocks.saveMigrationCheckpoint.mockResolvedValue({});
    mocks.completeMigration.mockResolvedValue({ verified: true, authorityState: 'NATIVE' });
    mocks.sha256Hex.mockResolvedValue('a'.repeat(64));
    mocks.listLegacyMigrationPage.mockResolvedValue({
      rows: [{ id: 'legacy-1', start_time: '2026-08-01T00:00:00Z' }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('stops and retries a target admission failure without quarantining readable source', async () => {
    mocks.getLegacyTripForMigration.mockResolvedValue({ id: 'legacy-1', route_points: [{ lat: 1, lng: 2 }] });
    const failure = Object.assign(new Error('LOW_SPACE_BLOCKED'), { code: 'LOW_SPACE_BLOCKED' });
    mocks.streamJsonToMigration.mockRejectedValue(failure);

    await expect(migrateLegacyTripsToNativeArchive()).rejects.toBe(failure);
    expect(mocks.quarantineLegacySource).not.toHaveBeenCalled();
    expect(mocks.completeMigration).not.toHaveBeenCalled();
  });

  it('durably quarantines a source read failure and verifies the same shortfall on pass two', async () => {
    mocks.getLegacyTripForMigration.mockRejectedValue(new Error('ciphertext unreadable'));

    await expect(migrateLegacyTripsToNativeArchive()).resolves.toMatchObject({ verified: true });
    expect(mocks.quarantineLegacySource).toHaveBeenCalledTimes(1);
    expect(mocks.quarantineLegacySource).toHaveBeenCalledWith(expect.objectContaining({
      sourceLocator: 'indexeddb:trips:legacy-1',
      errorDetail: 'ciphertext unreadable',
    }));
    expect(mocks.streamJsonToMigration).not.toHaveBeenCalled();
    expect(mocks.completeMigration).toHaveBeenCalledWith(expect.objectContaining({
      expectedCount: 1,
      visitedCount: 1,
      quarantineCount: 1,
    }));
  });
});
