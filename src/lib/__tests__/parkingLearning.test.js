import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map();

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => stored.has(key) ? stored.get(key) : fallback),
  setJson: vi.fn(async (key, value) => stored.set(key, structuredClone(value))),
}));

import {
  getParkingLearningProfile,
  PARKING_LEARNING_KEY,
  parkingPointDistanceM,
  recordParkingLearningFeedback,
} from '@/lib/parkingLearning';

describe('local parking learning', () => {
  beforeEach(() => stored.clear());

  it('learns stricter transient-stop thresholds from repeated rejected locations', async () => {
    await recordParkingLearningFeedback({ kind: 'rejected' });
    const profile = await recordParkingLearningFeedback({ kind: 'rejected' });

    expect(profile).toMatchObject({
      feedback_count: 2,
      rejected_count: 2,
      strictness_level: 2,
      short_stop_max_seconds: 65,
      in_vehicle_stop_max_seconds: 180,
      minimum_automatic_confidence: 60,
    });
    expect(stored.get(PARKING_LEARNING_KEY)).not.toHaveProperty('lat');
    expect(stored.get(PARKING_LEARNING_KEY)).not.toHaveProperty('lng');
  });

  it('extends refinement after a substantial marker correction and balances with verification', async () => {
    const corrected = await recordParkingLearningFeedback({
      kind: 'marker_moved',
      movementM: 35,
    });
    expect(corrected).toMatchObject({
      marker_correction_count: 1,
      large_marker_correction_count: 1,
      refinement_duration_ms: 60_000,
      refinement_max_fixes: 12,
    });

    await recordParkingLearningFeedback({ kind: 'verified' });
    expect((await getParkingLearningProfile()).verified_count).toBe(1);
  });

  it('calculates marker movement without storing either coordinate', () => {
    expect(parkingPointDistanceM(
      { lat: 43.65, lng: -79.38 },
      { lat: 43.6503, lng: -79.38 }
    )).toBeGreaterThan(30);
  });
});
