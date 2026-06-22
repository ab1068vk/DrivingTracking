import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  encryptedStorage: new Map(),
  getEncryptedJson: vi.fn(async (key, fallback) => (
    mocks.encryptedStorage.has(key) ? mocks.encryptedStorage.get(key) : fallback
  )),
  setEncryptedJson: vi.fn(async (key, value) => {
    mocks.encryptedStorage.set(key, value);
  }),
  logSystemFailure: vi.fn(),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: mocks.getEncryptedJson,
  setEncryptedJson: mocks.setEncryptedJson,
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
}));

import {
  dismissPrivacyZoneSuggestion,
  getPrivacyZoneSuggestions,
  PRIVACY_ZONE_SUGGESTION_DISMISSAL_MS,
  privacyZoneDraftFromSuggestion,
} from '@/lib/privacyZoneSuggestions';

const center = { lat: 43.65, lng: -79.38 };
const metersNorth = (meters) => ({
  lat: center.lat + meters / 111320,
  lng: center.lng,
});

const tripsForDays = (count, offsets = [0]) => Array.from({ length: count }, (_, index) => {
  const day = new Date(Date.UTC(2026, 0, index + 1, 12, 0, 0));
  const point = metersNorth(offsets[index % offsets.length]);
  return {
    id: `trip-${index}`,
    start_time: day.toISOString(),
    end_time: new Date(day.getTime() + 30 * 60 * 1000).toISOString(),
    route_points: [{ ...point, timestamp: day.toISOString() }],
  };
});

describe('privacy zone suggestions', () => {
  afterEach(() => {
    mocks.encryptedStorage.clear();
    vi.clearAllMocks();
    mocks.getEncryptedJson.mockImplementation(async (key, fallback) => (
      mocks.encryptedStorage.has(key) ? mocks.encryptedStorage.get(key) : fallback
    ));
    mocks.setEncryptedJson.mockImplementation(async (key, value) => {
      mocks.encryptedStorage.set(key, value);
    });
  });

  it('does not suggest clusters below the five-day occurrence threshold', async () => {
    await expect(getPrivacyZoneSuggestions({
      trips: tripsForDays(4),
      zones: [],
      now: Date.parse('2026-02-01T12:00:00.000Z'),
    })).resolves.toEqual([]);
  });

  it('contains no network request path', () => {
    const source = readFileSync(new URL('../privacyZoneSuggestions.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('apiClient');
  });

  it('suggests a cluster at the five-day threshold without exposing its points', async () => {
    const suggestions = await getPrivacyZoneSuggestions({
      trips: tripsForDays(5, [0, 20, 40, 60, 80]),
      zones: [],
      now: Date.parse('2026-02-01T12:00:00.000Z'),
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      suggestedCenter: {
        lat: expect.any(Number),
        lng: expect.any(Number),
      },
      occurrenceDays: 5,
      suggestedRadiusM: expect.any(Number),
      firstSeenAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
    });
    expect(suggestions[0].suggestedRadiusM).toBeGreaterThanOrEqual(50);
    expect(suggestions[0]).not.toHaveProperty('points');
  });

  it('keeps a qualifying cluster above the occurrence threshold', async () => {
    const suggestions = await getPrivacyZoneSuggestions({
      trips: tripsForDays(7),
      zones: [],
      now: Date.parse('2026-02-01T12:00:00.000Z'),
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].occurrenceDays).toBe(7);
  });

  it('uses the 90th-percentile covering radius instead of one distant outlier', async () => {
    const suggestions = await getPrivacyZoneSuggestions({
      trips: tripsForDays(10, [0, 0, 0, 0, 0, 0, 0, 0, 0, 150]),
      zones: [],
      now: Date.parse('2026-02-01T12:00:00.000Z'),
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestedRadiusM).toBe(50);
  });

  it('suppresses a duplicate suggestion when an existing zone is nearby', async () => {
    await expect(getPrivacyZoneSuggestions({
      trips: tripsForDays(6),
      zones: [{ ...center, id: 'home', radius_m: 100 }],
      now: Date.parse('2026-02-01T12:00:00.000Z'),
    })).resolves.toEqual([]);
  });

  it('suppresses a dismissed cluster for 90 days and restores it after expiry', async () => {
    const now = Date.parse('2026-02-01T12:00:00.000Z');
    const trips = tripsForDays(6);
    const [suggestion] = await getPrivacyZoneSuggestions({ trips, zones: [], now });

    await dismissPrivacyZoneSuggestion(suggestion, now);

    await expect(getPrivacyZoneSuggestions({
      trips,
      zones: [],
      now: now + PRIVACY_ZONE_SUGGESTION_DISMISSAL_MS - 1,
    })).resolves.toEqual([]);
    await expect(getPrivacyZoneSuggestions({
      trips,
      zones: [],
      now: now + PRIVACY_ZONE_SUGGESTION_DISMISSAL_MS + 1,
    })).resolves.toHaveLength(1);
  });

  it('builds a Settings draft without exposing a point list', () => {
    expect(privacyZoneDraftFromSuggestion({
      suggestedCenter: center,
      suggestedRadiusM: 140,
    })).toEqual({
      label: 'Suggested private place',
      radius_m: '140',
      location: center,
    });
  });

  it('logs suggestion failures without passing underlying point details', async () => {
    mocks.getEncryptedJson.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(getPrivacyZoneSuggestions({
      trips: tripsForDays(6),
      zones: [],
      now: Date.parse('2026-02-01T12:00:00.000Z'),
    })).resolves.toEqual([]);

    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_zone_suggestions_failed',
      expect.any(Error),
      expect.objectContaining({
        trip_count: 6,
        zone_count: 0,
      })
    );
    expect(JSON.stringify(mocks.logSystemFailure.mock.calls[0][2])).not.toContain('route_points');
    expect(JSON.stringify(mocks.logSystemFailure.mock.calls[0][2])).not.toContain('43.');
    expect(JSON.stringify(mocks.logSystemFailure.mock.calls[0][2])).not.toContain('-79.');
  });
});
