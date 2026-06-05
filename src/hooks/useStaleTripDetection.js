import { useMemo } from 'react';
import { buildDrivingThresholds, buildScoreConstantsSnapshot, getScoreProvenanceStatus } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { settingsVersionFromSnapshot } from './useSettingsVersion';

export function getStaleTripIds(trips = [], settings = localSettings.get(), currentSettingsVersion = null) {
  const thresholds = buildDrivingThresholds(settings);
  const expectedVersion = currentSettingsVersion || settingsVersionFromSnapshot(buildScoreConstantsSnapshot(thresholds));

  return trips
    .filter((trip) => {
      if (trip?.status !== 'completed') return false;
      const storedVersion = trip.scored_with_settings_version || trip.scoredWithSettingsVersion || trip.score_provenance?.settings_version;
      if (storedVersion && storedVersion !== expectedVersion) return true;
      return getScoreProvenanceStatus(trip, thresholds).needsRescore;
    })
    .map((trip) => trip.id);
}

export function useStaleTripDetection(trips, settings, currentSettingsVersion) {
  return useMemo(
    () => getStaleTripIds(trips, settings, currentSettingsVersion),
    [trips, settings, currentSettingsVersion]
  );
}
