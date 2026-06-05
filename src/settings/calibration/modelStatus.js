import { SCORING_VERSION, hasProvisionalCalibration } from '@/lib/scoringConstants';

export function calibrationModelStatus() {
  const provisional = hasProvisionalCalibration();
  return {
    provisional,
    label: provisional ? 'Scoring model: Provisional' : `Scoring model: Calibrated v${SCORING_VERSION.slice(0, 8)}`,
    versionHash: SCORING_VERSION.slice(0, 8),
  };
}
