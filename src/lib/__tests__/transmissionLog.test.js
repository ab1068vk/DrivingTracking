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

    await logTransmission({ service: 'export', type: 'Full backup' });
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
        status: 'safe',
      })
    )));

    const loaded = await loadTransmissionLog();
    expect(loaded).toHaveLength(20);
    expect(new Set(loaded.map((entry) => entry.type)).size).toBe(20);
  });

  it('clears the encrypted log after queued writes finish', async () => {
    const pending = logTransmission({ service: 'overpass', type: 'Speed limit query' });
    await clearTransmissionLog();
    await pending;

    expect(await loadTransmissionLog()).toEqual([]);
  });
});
