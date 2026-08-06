import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map(),
  failKeyWrite: false,
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  appendPrivacyEvent: vi.fn(async () => ({})),
}));

vi.mock('@/lib/hashChainLog', () => ({ appendPrivacyEvent: mocks.appendPrivacyEvent }));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
  recordSystemEvent: mocks.recordSystemEvent,
  logError: mocks.logSystemFailure,
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => (
    mocks.store.has(key) ? structuredClone(mocks.store.get(key)) : fallback
  )),
  setEncryptedJson: vi.fn(async (key, value) => {
    if (mocks.failKeyWrite && key === 'drivesense_privacy_cell_key_v1') {
      throw new Error('Secure key store unavailable.');
    }
    mocks.store.set(key, structuredClone(value));
  }),
  removeEncryptedJson: vi.fn(async (key) => {
    mocks.store.delete(key);
  }),
  encryptSensitiveValue: vi.fn(async (value) => value),
}));

import { hmacSha256, sha256, toHex, utf8Bytes } from '@/lib/sha256';
import {
  adoptPrivacyCellKey,
  ensurePrivacyCellKey,
  isKeyedCellHash,
  keyedPrivacyCellHash,
} from '@/lib/privacyCellKey';
import {
  PRIVACY_ZONES_SECURE_KEY,
  createPrivacyCellHashes,
  isPointInPrivacyZone,
  loadPrivacyZonesFromStorage,
  savePrivacyZonesToStorage,
} from '@/lib/privacyZones';
import { localSettings } from '@/lib/trackingStore';

const HOME = Object.freeze({ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 });
const KEY_A = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY_B = 'f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f38=';

describe('sha256 primitive', () => {
  it('matches the published SHA-256 and HMAC-SHA-256 vectors', () => {
    expect(toHex(sha256(utf8Bytes('abc'))))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // RFC 4231 test case 2.
    expect(toHex(hmacSha256(utf8Bytes('Jefe'), utf8Bytes('what do ya want for nothing?'))))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('keyed privacy cell hashes', () => {
  beforeEach(() => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    mocks.store = new Map();
    mocks.failKeyWrite = false;
    mocks.recordSystemEvent.mockClear();
    adoptPrivacyCellKey('');
  });

  it('produces a different hash per key, so the stored list cannot be enumerated without one', () => {
    adoptPrivacyCellKey(KEY_A);
    const underA = keyedPrivacyCellHash(214000, 5000000, 50);
    adoptPrivacyCellKey(KEY_B);
    const underB = keyedPrivacyCellHash(214000, 5000000, 50);

    expect(isKeyedCellHash(underA)).toBe(true);
    expect(underA).not.toBe(underB);
    // The legacy scheme is a plain hash of the same label, so it is identical on
    // every device; that is exactly what made the old cells brute-forceable.
    expect(underA).not.toContain('pzc_');
  });

  it('returns null rather than a guessable hash when no key is loaded', () => {
    expect(keyedPrivacyCellHash(214000, 5000000, 50)).toBeNull();
  });

  it('stores keyed cells and still answers membership for the zone they cover', async () => {
    adoptPrivacyCellKey(KEY_A);
    const hashes = createPrivacyCellHashes(HOME);
    const cellOnly = {
      id: HOME.id,
      label: HOME.label,
      type: 'circle',
      radius_m: HOME.radius_m,
      privacy_cell_size_m: 50,
      privacy_cell_hashes: hashes,
    };

    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.every(isKeyedCellHash)).toBe(true);
    expect(isPointInPrivacyZone({ lat: 43.65, lng: -79.38 }, [cellOnly])?.id).toBe('home');
    expect(isPointInPrivacyZone({ lat: 43.66, lng: -79.38 }, [cellOnly])).toBeNull();
  });

  it('treats a keyed zone as private when the key is missing instead of ignoring it', () => {
    adoptPrivacyCellKey(KEY_A);
    const cellOnly = {
      id: 'home',
      label: 'Home',
      type: 'circle',
      radius_m: 100,
      privacy_cell_size_m: 50,
      privacy_cell_hashes: createPrivacyCellHashes(HOME),
    };
    adoptPrivacyCellKey('');

    // Fail closed: an unreadable guard must not read as "nothing is private".
    expect(isPointInPrivacyZone({ lat: 1, lng: 1 }, [cellOnly])?.id).toBe('home');
    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_cell_key_missing',
      expect.any(Error),
      expect.objectContaining({ zone_id: 'home' })
    );
  });

  it('keeps the key out of the plaintext settings mirror', async () => {
    await savePrivacyZonesToStorage([HOME]);
    const key = await ensurePrivacyCellKey();

    expect(key.length).toBe(32);
    expect(JSON.stringify(localSettings.get())).not.toContain(mocks.store.get('drivesense_privacy_cell_key_v1'));
    expect(JSON.stringify(localSettings.get().privacy_zones)).not.toContain('privacy_cell_hashes');
  });

  it('re-keys a stored legacy zone on load without changing what it protects', async () => {
    // An install from before the cell key existed: the write fails, so the zone
    // is stored with the old unkeyed hashes.
    mocks.failKeyWrite = true;
    await savePrivacyZonesToStorage([HOME]);
    const stored = mocks.store.get(PRIVACY_ZONES_SECURE_KEY);
    expect(stored[0].privacy_cell_hashes.some(isKeyedCellHash)).toBe(false);
    expect(isPointInPrivacyZone({ lat: 43.65, lng: -79.38 }, stored)?.id).toBe('home');

    mocks.failKeyWrite = false;
    adoptPrivacyCellKey('');
    const zones = await loadPrivacyZonesFromStorage({});

    expect(zones[0].privacy_cell_hashes.every(isKeyedCellHash)).toBe(true);
    expect(zones[0].privacy_cell_schema).toBe('keyed_grid_v2');
    expect(zones[0].privacy_cell_hashes.length).toBe(stored[0].privacy_cell_hashes.length);
    expect(isPointInPrivacyZone({ lat: 43.65, lng: -79.38 }, zones)?.id).toBe('home');
    expect(isPointInPrivacyZone({ lat: 43.66, lng: -79.38 }, zones)).toBeNull();
    expect(mocks.recordSystemEvent).toHaveBeenCalledWith(
      'privacy_zones_cell_key_migration',
      expect.objectContaining({ rekeyed_zone_count: 1, unrecoverable_zone_count: 0 }),
      expect.anything()
    );
    expect(JSON.stringify(mocks.store.get(PRIVACY_ZONES_SECURE_KEY))).not.toContain('43.65');
  });
});
