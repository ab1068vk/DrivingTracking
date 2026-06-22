import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@/lib/tripEngine';
import {
  assertScoreInputsDoNotContainRawZoneKinematics,
  hasPrivacyRedactionMarker,
  rawKinematicPointsInsidePrivacyZones,
  scoreTripWithPrivacyInputs,
} from '@/lib/scoreInputPrivacy';

const zone = {
  id: 'home-zone',
  label: 'Home',
  lat: 43,
  lng: -79,
  radius_m: 120,
};

describe('score input privacy', () => {
  it('masks raw privacy-zone kinematics before the scoring function receives inputs', () => {
    const start = '2026-06-22T12:00:00.000Z';
    const end = '2026-06-22T12:01:00.000Z';
    const rawRoute = [
      { lat: 43, lng: -79, timestamp: start, speed_kmh: 48, heading: 90, accuracy: 4 },
      { lat: 43.003, lng: -79.003, timestamp: end, speed_kmh: 42, heading: 95, accuracy: 5 },
    ];
    let capturedInput = null;

    expect(rawKinematicPointsInsidePrivacyZones(rawRoute, [zone])).toHaveLength(1);

    const scored = scoreTripWithPrivacyInputs({
      trip: { start_time: start, end_time: end },
      routePoints: rawRoute,
      thresholds: DEFAULT_THRESHOLDS,
      settings: { privacy_zones: [zone] },
      endTime: end,
      onScoreInput: (input) => {
        capturedInput = input;
      },
    });

    expect(capturedInput).toBeTruthy();
    expect(() => assertScoreInputsDoNotContainRawZoneKinematics(
      capturedInput.routePoints,
      capturedInput.privacyZones
    )).not.toThrow();
    expect(capturedInput.routePoints.some(hasPrivacyRedactionMarker)).toBe(true);
    expect(scored.scoreInputPrivacy).toMatchObject({
      masked: true,
      touchedPrivacyZone: true,
      trendExcluded: true,
    });
  });
});
