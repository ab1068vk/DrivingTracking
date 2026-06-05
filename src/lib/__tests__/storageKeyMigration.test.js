import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import {
  runStorageKeyMigration,
  STORAGE_KEY_MIGRATION_DONE_KEY,
} from '@/lib/storageKeyMigration';

function makeMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => store.get(key) ?? null),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn((key) => store.delete(key)),
    values: store,
  };
}

describe('Road Sage storage key migration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies legacy DriveSense localStorage keys to Road Sage keys and keeps the originals', async () => {
    const storage = makeMemoryStorage({
      drivesense_trips: JSON.stringify([{ id: 'trip-1' }]),
      drivesense_settings: JSON.stringify({ onboarding_completed: true }),
    });
    vi.stubGlobal('localStorage', storage);

    await expect(runStorageKeyMigration()).resolves.toBe(true);

    expect(storage.values.get('road_sage_trips')).toBe(JSON.stringify([{ id: 'trip-1' }]));
    expect(storage.values.get('road_sage_settings')).toBe(JSON.stringify({ onboarding_completed: true }));
    expect(storage.values.get('drivesense_trips')).toBe(JSON.stringify([{ id: 'trip-1' }]));
    expect(storage.values.get('drivesense_trips__migrated_to__road_sage_trips')).toBe('1');
    expect(storage.values.get(STORAGE_KEY_MIGRATION_DONE_KEY)).toBe('1');
  });

  it('lets mobileStorage read legacy keys and write current keys', async () => {
    const storage = makeMemoryStorage({
      drivesense_danger_zones: JSON.stringify([{ id: 'zone-1' }]),
    });
    vi.stubGlobal('localStorage', storage);

    await expect(getJson('road_sage_danger_zones', [])).resolves.toEqual([{ id: 'zone-1' }]);
    expect(storage.values.get('road_sage_danger_zones')).toBe(JSON.stringify([{ id: 'zone-1' }]));

    await setJson('drivesense_danger_zones', [{ id: 'zone-2' }]);
    expect(storage.values.get('road_sage_danger_zones')).toBe(JSON.stringify([{ id: 'zone-2' }]));

    await removeJson('road_sage_danger_zones');
    expect(storage.values.has('road_sage_danger_zones')).toBe(false);
    expect(storage.values.has('drivesense_danger_zones')).toBe(false);
  });
});
