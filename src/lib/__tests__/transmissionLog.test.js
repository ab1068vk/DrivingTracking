import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendPrivacyEvent: vi.fn(async () => ({})),
  getEncryptedJson: vi.fn(),
  setEncryptedJson: vi.fn(),
  logSystemFailure: vi.fn(),
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
}));

import {
  clearTransmissionLog,
  loadTransmissionLog,
  logTransmission,
} from '@/lib/transmissionLog';

describe('transmissionLog', () => {
  beforeEach(() => {
    mocks.stored = [];
    mocks.appendPrivacyEvent.mockClear();
    mocks.logSystemFailure.mockClear();
    mocks.getEncryptedJson.mockImplementation(async (_key, fallback) => (
      mocks.stored == null ? fallback : structuredClone(mocks.stored)
    ));
    mocks.setEncryptedJson.mockImplementation(async (_key, value) => {
      await Promise.resolve();
      mocks.stored = structuredClone(value);
    });
  });

  it('stores sanitized records and appends a coordinate-free audit event', async () => {
    const record = await logTransmission({
      service: 'open-meteo',
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: true,
      privacyTransformSource: 'test',
      privacyVerificationEvidence: ['coordinate rounded before send'],
      sentCoords: '43.6500, -79.3800',
      protections: ['rounded to 4 decimals'],
      bytesOut: 123.4,
      status: 'safe',
      zonesSuppressed: ['Home'],
    });

    expect(record).toMatchObject({
      service: 'open-meteo',
      bytesOut: 123,
      status: 'safe',
      zonesSuppressed: ['Home'],
      privacyTransformVerified: true,
      privacyVerificationEvidence: ['coordinate rounded before send'],
      privacyVerificationWarnings: [],
    });
    expect(await loadTransmissionLog()).toHaveLength(1);
    expect(mocks.appendPrivacyEvent).toHaveBeenCalledWith({
      op: 'TRANSMISSION',
      tripId: null,
      zoneLabel: 'Home',
      details: {
        service: 'open-meteo',
        status: 'safe',
      },
    });
    expect(JSON.stringify(mocks.appendPrivacyEvent.mock.calls[0][0])).not.toContain('43.6500');
  });

  it('drops expired records and caps the retained log at 500 entries', async () => {
    const now = Date.now();
    mocks.stored = [
      { id: 'expired', expiresAt: now - 1 },
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `kept-${index}`,
        timestamp: now + index,
        expiresAt: now + 60_000,
      })),
    ];

    await logTransmission({
      service: 'export',
      type: 'Full backup',
      coordinateDisclosure: 'committed',
    });
    const loaded = await loadTransmissionLog();

    expect(loaded).toHaveLength(500);
    expect(loaded.some((entry) => entry.id === 'expired')).toBe(false);
    expect(loaded.some((entry) => entry.id === 'kept-0')).toBe(false);
    expect(loaded.at(-1).service).toBe('export');
  });

  it('does not lose records when transmissions are logged concurrently', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      logTransmission({
        service: 'osrm',
        type: `Route matching ${index}`,
        coordinateDisclosure: 'raw',
        status: 'safe',
      })
    )));

    const loaded = await loadTransmissionLog();
    expect(loaded).toHaveLength(20);
    expect(new Set(loaded.map((entry) => entry.type)).size).toBe(20);
    expect(loaded.every((entry) => entry.status === 'warning')).toBe(true);
  });

  it('clears the encrypted log after queued writes finish', async () => {
    const pending = logTransmission({
      service: 'overpass',
      type: 'Speed limit query',
      coordinateDisclosure: 'bounding_box',
    });
    await clearTransmissionLog();
    await pending;

    expect(await loadTransmissionLog()).toEqual([]);
    expect(mocks.appendPrivacyEvent).toHaveBeenCalledWith({ op: 'TRANSMISSION_LOG_CLEARED' });
  });

  it('rejects records without a typed coordinate disclosure', async () => {
    await expect(logTransmission({ service: 'test' })).rejects.toThrow('invalid coordinateDisclosure');
  });

  it('downgrades protected claims that lack named verification evidence', async () => {
    const record = await logTransmission({
      service: 'open-meteo',
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: true,
      privacyTransformSource: 'test',
      sentCoords: '43.6500, -79.3800',
    });

    expect(record.privacyTransformVerified).toBe(false);
    expect(record.status).toBe('warning');
    expect(record.privacyVerificationWarnings).toContain(
      'Protection is caller-reported but not verified by named pre-send evidence.'
    );
  });

  it('marks raw coordinate sends as warnings even when explicit consent is logged', async () => {
    const record = await logTransmission({
      service: 'osrm',
      type: 'Route matching',
      coordinateDisclosure: 'raw',
      privacyTransformVerified: true,
      privacyTransformSource: 'test',
      privacyVerificationEvidence: ['privacy-zone guard ran before request'],
      sentCoords: '10 sampled coordinates',
      protections: ['explicit consent'],
      status: 'safe',
    });

    expect(record.status).toBe('warning');
    expect(record.privacyVerificationWarnings).toContain(
      'Raw coordinates left the app; consent or guards do not make this a protected send.'
    );
  });

  it('migrates legacy claims without retroactively verifying them', async () => {
    mocks.stored = [{
      id: 'legacy',
      status: 'safe',
      sentCoords: '43.6500, -79.3800',
      protections: ['zone-guard +100m', 'rounded to 4dp'],
      expiresAt: Date.now() + 60_000,
    }];
    expect((await loadTransmissionLog())[0]).toMatchObject({
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: false,
      privacyTransformSource: 'migrated_from_v1',
      privacyVerificationWarnings: ['Legacy transmission claim was migrated without pre-send verification evidence.'],
      schemaVersion: 2,
    });
  });
});
