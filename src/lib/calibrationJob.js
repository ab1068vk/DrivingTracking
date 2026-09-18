import { clearBoundedJobCheckpoint, runBoundedTripJob } from '@/lib/boundedTripJob';
import { createCalibrationAccumulator } from '@/lib/thresholdCalibration';

/**
 * Explicit bounded calibration job.
 *
 * Calibration used to load the whole archive — every trip, every route point —
 * into one array before fitting thresholds. It now streams one trip at a time
 * into fixed-size histograms, so memory is flat in retained history and the
 * result is identical at the precision calibration reports.
 *
 * This is an explicit action. Opening Settings must never start it.
 */
export const CALIBRATION_JOB_KEY = 'calibration_profile';

export async function runCalibrationJob({
  currentThresholds = {},
  surveyLabels = [],
  signal = null,
  onProgress = null,
} = {}) {
  const accumulator = createCalibrationAccumulator(currentThresholds);

  const outcome = await runBoundedTripJob({
    jobKey: CALIBRATION_JOB_KEY,
    fingerprint: `calibration:${JSON.stringify(currentThresholds || {})}`,
    status: 'completed',
    loadFullTrip: true,
    signal,
    onProgress,
    // Histograms live in memory for the duration of the run, so a resume must
    // re-derive from the start rather than replay a partial fit.
    resume: false,
    initialState: () => ({}),
    onTrip: ({ trip }) => {
      accumulator.addTrip(trip);
    },
  });

  if (outcome.cancelled) {
    return { profile: null, cancelled: true, processed: outcome.processed };
  }

  await clearBoundedJobCheckpoint(CALIBRATION_JOB_KEY);
  return {
    profile: accumulator.result({ surveyLabels }),
    cancelled: false,
    processed: outcome.processed,
  };
}
