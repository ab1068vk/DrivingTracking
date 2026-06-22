import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendPrivacyEvent: vi.fn(async () => ({})),
  getEncryptedJson: vi.fn(),
  setEncryptedJson: vi.fn(),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  pinnedFetch: vi.fn(),
  stored: [],
}));

vi.mock('@/lib/hashChainLog', () => ({
  appendPrivacyEvent: mocks.appendPrivacyEvent,
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: mocks.getEncryptedJson,
  setEncryptedJson: mocks.setEncryptedJson,
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
  recordSystemEvent: mocks.recordSystemEvent,
}));

vi.mock('@/lib/pinnedFetch', () => ({
  pinnedFetch: mocks.pinnedFetch,
}));

import {
  PRIVACY_GATEWAY_DOWNGRADE_WARNING,
  privacyGatedFetch,
} from '@/lib/privacyGatedFetch';
import { loadTransmissionLog } from '@/lib/transmissionLog';
import { localSettings } from '@/lib/trackingStore';

describe('privacyGatedFetch', () => {
  beforeEach(() => {
    const settingsValues = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => settingsValues.get(key) || null),
      setItem: vi.fn((key, value) => settingsValues.set(key, String(value))),
      removeItem: vi.fn((key) => settingsValues.delete(key)),
    });
    mocks.stored = [];
    mocks.appendPrivacyEvent.mockClear();
    mocks.logSystemFailure.mockClear();
    mocks.recordSystemEvent.mockClear();
    mocks.pinnedFetch.mockReset();
    mocks.pinnedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.getEncryptedJson.mockImplementation(async (_key, fallback) => (
      mocks.stored == null ? fallback : structuredClone(mocks.stored)
    ));
    mocks.setEncryptedJson.mockImplementation(async (_key, value) => {
      await Promise.resolve();
      mocks.stored = structuredClone(value);
    });
    localSettings.set({
      ...localSettings.get(),
      heightened_privacy_mode: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downgrades an under-declared rounded request when the outgoing payload is raw precision', async () => {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=43.650412&longitude=-79.380177';

    await privacyGatedFetch('open-meteo', { url }, {
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      sentCoords: '43.6504, -79.3802',
      protections: ['rounded to 4 decimals'],
    });

    expect(mocks.pinnedFetch).toHaveBeenCalledWith(url, expect.objectContaining({}));
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'raw',
      privacyTransformVerified: false,
      privacyTransformSource: 'privacyGatedFetch:open-meteo',
      status: 'warning',
    });
    expect(entry.privacyVerificationWarnings).toEqual(expect.arrayContaining([
      PRIVACY_GATEWAY_DOWNGRADE_WARNING,
      'Raw coordinates left the app; consent or guards do not make this a protected send.',
    ]));
  });

  it('verifies a rounded request when the actual outgoing payload is rounded', async () => {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=43.6504&longitude=-79.3801';

    await privacyGatedFetch('open-meteo', { url }, {
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      sentCoords: '43.6504, -79.3801',
      protections: ['rounded to 4 decimals'],
    });

    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:open-meteo',
      privacyVerificationEvidence: ['privacy gateway verified open-meteo payload precision <= 4 decimals'],
      privacyVerificationWarnings: [],
      status: 'safe',
    });
  });

  it('logs a dependency-injected zone block without sending the request', async () => {
    const result = await privacyGatedFetch('osrm', { url: 'https://osrm.example/match/v1/driving/-79.38,43.65;-79.39,43.66' }, {
      type: 'Route matching',
      coordinateDisclosure: 'raw',
      guard: () => ({
        blocked: true,
        privacyVerificationEvidence: ['route endpoint was inside the privacy-zone guard buffer'],
        protections: ['route endpoint near privacy zone - request blocked'],
        zonesSuppressed: ['Home'],
      }),
    });

    expect(result.blocked).toBe(true);
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'osrm',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:osrm',
      privacyVerificationEvidence: ['route endpoint was inside the privacy-zone guard buffer'],
      sentCoords: null,
      bytesOut: 0,
      status: 'blocked',
      zonesSuppressed: ['Home'],
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });

  it('blocks Open-Meteo, Overpass, and OSRM at the gateway in heightened privacy mode', async () => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...localSettings.get(),
      heightened_privacy_mode: true,
    }));

    const results = await Promise.all([
      privacyGatedFetch('open-meteo', { url: 'https://api.open-meteo.com/v1/forecast?latitude=43.6500&longitude=-79.3800' }, {
        coordinateDisclosure: 'rounded',
      }),
      privacyGatedFetch('overpass', { url: 'https://overpass-api.de/api/interpreter' }, {
        coordinateDisclosure: 'bounding_box',
      }),
      privacyGatedFetch('osrm', { url: 'https://osrm.example/match/v1/driving/-79.38,43.65;-79.39,43.66' }, {
        coordinateDisclosure: 'raw',
      }),
    ]);

    expect(results.every((result) => result.blocked)).toBe(true);
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
    const entries = await loadTransmissionLog();
    expect(entries.map((entry) => entry.service).sort()).toEqual(['open-meteo', 'osrm', 'overpass']);
    expect(entries.every((entry) => entry.status === 'blocked')).toBe(true);
    expect(entries.every((entry) => entry.protections.includes('heightened privacy mode'))).toBe(true);
  });

  it('logs network failures after the sanitized transmission record is written', async () => {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=43.6504&longitude=-79.3801';
    mocks.pinnedFetch.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(privacyGatedFetch('open-meteo', { url }, {
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      sentCoords: '43.6504, -79.3801',
      protections: ['rounded to 4 decimals'],
    })).rejects.toThrow('network unavailable');

    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'rounded',
      privacyTransformSource: 'privacyGatedFetch:open-meteo',
    });
    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_gateway_fetch_failed',
      expect.any(Error),
      expect.objectContaining({
        service: 'open-meteo',
        request_logged: true,
        disclosure_level: 'rounded',
        verified_before_send: true,
      })
    );
    expect(JSON.stringify(mocks.logSystemFailure.mock.calls[0][2])).not.toContain('43.6504');
    expect(JSON.stringify(mocks.logSystemFailure.mock.calls[0][2])).not.toContain('-79.3801');
  });
});
