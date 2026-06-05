import { describe, expect, it } from 'vitest';
import { getStaleTripIds } from '../useStaleTripDetection';
import { getCurrentSettingsVersion } from '../useSettingsVersion';
import { buildDrivingThresholds, buildScoreConstantsSnapshot, SCORING_VERSION } from '@/lib/tripEngine';

const baseSettings = {
  threshold_harsh_brake_ms2: 4,
  threshold_rapid_accel_ms2: 3,
  threshold_sharp_turn_g_low: 0.35,
  threshold_sharp_turn_g_medium: 0.5,
  threshold_sharp_turn_g_high: 0.7,
  threshold_speeding_kmh: 120,
};

function completedTrip(id, settings = baseSettings) {
  const thresholds = buildDrivingThresholds(settings);
  return {
    id,
    status: 'completed',
    score_provenance: {
      scoring_version: SCORING_VERSION,
      settings_version: getCurrentSettingsVersion(settings),
      constants_snapshot: buildScoreConstantsSnapshot(thresholds),
    },
  };
}

describe('getStaleTripIds', () => {
  it('returns completed trips scored with older settings fingerprints', () => {
    const currentSettings = {
      ...baseSettings,
      threshold_harsh_brake_ms2: 5,
    };
    const stale = completedTrip('stale', baseSettings);
    const current = completedTrip('current', currentSettings);

    expect(getStaleTripIds([stale, current], currentSettings)).toEqual(['stale']);
  });

  it('ignores incomplete trips', () => {
    const settingsVersion = getCurrentSettingsVersion(baseSettings);
    expect(getStaleTripIds([{
      ...completedTrip('candidate'),
      status: 'candidate',
      scored_with_settings_version: 'old',
    }], baseSettings, settingsVersion)).toEqual([]);
  });
});
