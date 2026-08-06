import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pinnedFetch: vi.fn(),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  isAndroid: vi.fn(() => true),
  enqueue: vi.fn(async () => ({})),
  getResult: vi.fn(),
  remove: vi.fn(async () => ({})),
  store: new Map(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    enqueue: mocks.enqueue,
    getResult: mocks.getResult,
    remove: mocks.remove,
  }),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: mocks.isAndroid,
  isNativePlatform: () => true,
  getNativePlatform: () => 'android',
}));

vi.mock('@/lib/pinnedFetch', () => ({
  pinnedFetch: mocks.pinnedFetch,
}));

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
    mocks.store.set(key, structuredClone(value));
  }),
  removeEncryptedJson: vi.fn(async (key) => {
    mocks.store.delete(key);
  }),
  encryptSensitiveValue: vi.fn(async (value) => value),
}));

import { runNativeRoadDataRequest } from '@/lib/nativeRoadDataQueue';
import { privacyGatedFetch } from '@/lib/privacyGatedFetch';
import { loadTransmissionLog } from '@/lib/transmissionLog';
import { localSettings } from '@/lib/trackingStore';

const OVERPASS_REQUEST = Object.freeze({
  url: 'https://overpass-api.de/api/interpreter',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  // Grid-snapped to 3 decimals, matching what overpassQuery emits.
  body: 'data=%5Bout%3Ajson%5D%3Bway%5B%22highway%22%5D(43.640%2C-79.390%2C43.660%2C-79.370)%3Bout%3B',
});

describe('background road-data requests are inspected by the privacy gateway', () => {
  beforeEach(() => {
    const settingsValues = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => settingsValues.get(key) ?? null),
      setItem: vi.fn((key, value) => settingsValues.set(key, String(value))),
      removeItem: vi.fn((key) => settingsValues.delete(key)),
    });
    mocks.store = new Map();
    mocks.isAndroid.mockReturnValue(true);
    mocks.enqueue.mockClear();
    mocks.remove.mockClear();
    mocks.pinnedFetch.mockReset();
    mocks.getResult.mockReset();
    localSettings.set({ ...localSettings.get(), heightened_privacy_mode: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs the Android-sent payload to the transmission log before enqueueing it', async () => {
    mocks.getResult.mockResolvedValue({ status: 'success', body: JSON.stringify({ elements: [] }) });

    const result = await runNativeRoadDataRequest('overpass', OVERPASS_REQUEST, 1000);

    expect(result).toEqual({ elements: [] });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    // Android owns the socket, so the JS transport must not also fire.
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();

    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'overpass',
      type: 'Background road-data request',
      coordinateDisclosure: 'bounding_box',
      privacyTransformSource: 'privacyGatedFetch:overpass',
    });
    expect(entry.bytesOut).toBeGreaterThan(0);
  });

  it('does not enqueue when the gateway blocks the request', async () => {
    localSettings.set({ ...localSettings.get(), heightened_privacy_mode: true });
    localStorage.setItem('drivesense_settings', JSON.stringify({ heightened_privacy_mode: true }));

    const result = await runNativeRoadDataRequest('overpass', OVERPASS_REQUEST, 1000);

    expect(result).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(await loadTransmissionLog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'overpass', coordinateDisclosure: 'blocked', bytesOut: 0 }),
    ]));
  });

  it('stops polling once the result deadline passes instead of spinning forever', async () => {
    mocks.getResult.mockResolvedValue({ status: 'pending' });
    vi.useFakeTimers();
    try {
      const pending = runNativeRoadDataRequest('overpass', OVERPASS_REQUEST, 0);
      const assertion = expect(pending).rejects.toThrow(/did not report a result in time/);
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.remove).toHaveBeenCalled();
  });
});

describe('privacyGatedFetch logOnly mode', () => {
  beforeEach(() => {
    const settingsValues = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => settingsValues.get(key) ?? null),
      setItem: vi.fn((key, value) => settingsValues.set(key, String(value))),
      removeItem: vi.fn((key) => settingsValues.delete(key)),
    });
    mocks.store = new Map();
    mocks.pinnedFetch.mockReset();
    localSettings.set({ ...localSettings.get(), heightened_privacy_mode: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the entry without sending, and still downgrades an under-declared payload', async () => {
    const result = await privacyGatedFetch('open-meteo', {
      url: 'https://api.open-meteo.com/v1/forecast?latitude=43.650412&longitude=-79.380177',
    }, {
      logOnly: true,
      type: 'Background road-data request',
      coordinateDisclosure: 'rounded',
    });

    expect(result).toMatchObject({ blocked: false, logged: true, coordinateDisclosure: 'raw' });
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'raw',
      privacyTransformVerified: false,
    });
  });
});
