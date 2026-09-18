import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-C-F05-B — storage presence is tri-state, and uncertainty retains the key.
 *
 * `hasStoredJson` used to answer a boolean and swallow every enumeration
 * failure as `false`. `fallbackTripDocumentReleasesKey` read that `false` as a
 * proven absence and destroyed the retiring encryption key — which, if an
 * unstamped legacy `drivesense_trips` blob was in fact still there, makes the
 * archive permanently unreadable. These tests drive the real `probeStoredJson`
 * against each storage shape it can meet in production.
 */

const nativePlatform = vi.hoisted(() => ({ value: false }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => nativePlatform.value),
    getPlatform: vi.fn(() => (nativePlatform.value ? 'android' : 'web')),
  },
  registerPlugin: vi.fn(() => ({})),
}));

const preferences = vi.hoisted(() => ({ keys: vi.fn(async () => ({ keys: [] })) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: preferences }));

vi.mock('@/lib/systemLog', () => ({
  logError: vi.fn(),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

import { STORAGE_PRESENCE, probeStoredJson } from '@/lib/mobileStorage';

const KEY = 'drivesense_trips';

/** A `localStorage` double whose enumeration behaviour the test controls. */
const installLocalStorage = ({ keys = [], enumerate = true, throws = null, point = true } = {}) => {
  const store = new Map(keys.map((key) => [key, '{}']));
  const stub = {
    getItem: point ? vi.fn((key) => (store.has(key) ? store.get(key) : null)) : undefined,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  if (enumerate) {
    Object.defineProperty(stub, 'length', {
      get: () => {
        if (throws) throw throws;
        return store.size;
      },
    });
    stub.key = vi.fn((index) => {
      if (throws) throw throws;
      return [...store.keys()][index] ?? null;
    });
  }
  vi.stubGlobal('localStorage', stub);
  return stub;
};

beforeEach(() => {
  nativePlatform.value = false;
  preferences.keys.mockReset();
  preferences.keys.mockResolvedValue({ keys: [] });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeStoredJson answers PRESENT / ABSENT / UNKNOWN', () => {
  it('reports PRESENT when enumeration finds the key', async () => {
    installLocalStorage({ keys: ['drivesense_settings', KEY] });
    await expect(probeStoredJson(KEY)).resolves.toBe(STORAGE_PRESENCE.PRESENT);
  });

  it('reports ABSENT when enumeration succeeds and the key is not there', async () => {
    installLocalStorage({ keys: ['drivesense_settings'] });
    await expect(probeStoredJson(KEY)).resolves.toBe(STORAGE_PRESENCE.ABSENT);
  });

  it('reports UNKNOWN when enumeration throws', async () => {
    installLocalStorage({ keys: [KEY], throws: new DOMException('denied', 'SecurityError') });
    // Load-bearing: the pre-fix `catch => false` answered ABSENT here.
    await expect(probeStoredJson(KEY)).resolves.toBe(STORAGE_PRESENCE.UNKNOWN);
  });

  it('reports UNKNOWN when the storage object supports neither enumeration nor point reads', async () => {
    installLocalStorage({ enumerate: false, point: false });
    await expect(probeStoredJson(KEY)).resolves.toBe(STORAGE_PRESENCE.UNKNOWN);
  });

  it('falls back to a point read when only that is available', async () => {
    installLocalStorage({ keys: [KEY], enumerate: false });
    await expect(probeStoredJson(KEY)).resolves.toBe(STORAGE_PRESENCE.PRESENT);
    installLocalStorage({ keys: [], enumerate: false });
    await expect(probeStoredJson(KEY)).resolves.toBe(STORAGE_PRESENCE.ABSENT);
  });

  /**
   * `nativePlatform.js` caches `Capacitor.isNativePlatform()` at module load, so
   * an Android probe has to be loaded after the platform is set.
   */
  const nativeProbe = async () => {
    nativePlatform.value = true;
    vi.resetModules();
    const storage = await import('@/lib/mobileStorage');
    return storage.probeStoredJson(KEY);
  };

  it('reports UNKNOWN when the native Preferences bridge fails', async () => {
    preferences.keys.mockRejectedValue(new Error('bridge unavailable'));
    await expect(nativeProbe()).resolves.toBe(STORAGE_PRESENCE.UNKNOWN);
  });

  it('reports UNKNOWN when the native key enumeration is malformed', async () => {
    preferences.keys.mockResolvedValue({ keys: null });
    await expect(nativeProbe()).resolves.toBe(STORAGE_PRESENCE.UNKNOWN);
  });

  it('answers from the native Preferences key set when it enumerates', async () => {
    preferences.keys.mockResolvedValue({ keys: ['a', KEY] });
    await expect(nativeProbe()).resolves.toBe(STORAGE_PRESENCE.PRESENT);
    preferences.keys.mockResolvedValue({ keys: ['a'] });
    await expect(nativeProbe()).resolves.toBe(STORAGE_PRESENCE.ABSENT);
  });
});

describe('P4-C-F05-B: only a proven absence releases a retiring key', () => {
  /**
   * The repository is loaded per case so `probeStoredJson` sees the storage
   * shape this case installed.
   */
  const releasesKeyWith = async (install) => {
    vi.resetModules();
    install();
    const repository = await import('@/lib/localTripRepository');
    return {
      reference: await repository.readFallbackTripDocumentReference(),
      releases: await repository.fallbackTripDocumentReleasesKey(1),
    };
  };

  it('retains V1 when the reference marker says the archive still uses it', async () => {
    const outcome = await releasesKeyWith(() => {
      installLocalStorage({
        keys: ['drivesense_trips_fallback_reference_v1'],
      });
      localStorage.getItem = vi.fn((key) => (
        key === 'drivesense_trips_fallback_reference_v1'
          ? JSON.stringify({ present: true, keyVersion: 1, updatedAt: 1 })
          : null
      ));
    });
    expect(outcome.reference).toMatchObject({ known: true, present: true, keyVersion: 1 });
    expect(outcome.releases).toBe(false);
  });

  it('retains V1 when no marker exists but enumeration finds the archive', async () => {
    const outcome = await releasesKeyWith(() => installLocalStorage({ keys: [KEY] }));
    expect(outcome.reference).toMatchObject({ known: false, present: true });
    expect(outcome.releases).toBe(false);
  });

  it('releases V1 when no marker exists and enumeration proves no archive', async () => {
    const outcome = await releasesKeyWith(() => installLocalStorage({ keys: ['other'] }));
    expect(outcome.reference).toMatchObject({ known: false, present: false });
    expect(outcome.releases).toBe(true);
  });

  it('retains V1 when enumeration throws', async () => {
    const outcome = await releasesKeyWith(() => installLocalStorage({
      keys: ['other'], throws: new DOMException('denied', 'SecurityError'),
    }));
    expect(outcome.reference.present).toBeNull();
    // Load-bearing: `catch => false` released the key here.
    expect(outcome.releases).toBe(false);
  });

  it('retains V1 when key probing is unavailable entirely', async () => {
    const outcome = await releasesKeyWith(() => installLocalStorage({
      enumerate: false, point: false,
    }));
    expect(outcome.reference.present).toBeNull();
    expect(outcome.releases).toBe(false);
  });
});
