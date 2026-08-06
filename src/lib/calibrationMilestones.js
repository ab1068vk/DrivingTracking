/**
 * Personal detection-calibration progress milestones.
 *
 * This is a distinct system from the Milestones page (achievements and driver
 * progression). It tracks how close the user is to Road Sage being able to
 * calibrate their personal detection thresholds from their own driving, and
 * notifies at the moment a step is reached rather than the next time the
 * Settings page happens to be opened.
 *
 * Thresholds mirror computeCalibrationProfile in thresholdCalibration.js; the
 * two must move together.
 */

/** Minimum trips computeCalibrationProfile needs before it will fit anything. */
export const CALIBRATION_TRIPS_TARGET = 15;
/** Minimum distance, in km, computeCalibrationProfile needs. */
export const CALIBRATION_KM_TARGET = 200;

export const CALIBRATION_MILESTONE_IDS = Object.freeze({
  HALFWAY: 'calibration_halfway',
  TRIPS_READY: 'calibration_trips_ready',
  DISTANCE_READY: 'calibration_distance_ready',
  READY: 'calibration_ready',
  CONFIDENCE_MEDIUM: 'calibration_confidence_medium',
  CONFIDENCE_HIGH: 'calibration_confidence_high',
});

const milestone = (id, title, body) => ({ id, title, body });

/**
 * Progress toward personal calibration, derived from the same completed-trip
 * set computeCalibrationProfile uses.
 *
 * @param {any[]} trips
 * @returns {{tripsAnalyzed:number, kmAnalyzed:number, tripsNeeded:number, kmNeeded:number, percent:number}}
 */
export function summarizeCalibrationProgress(trips = []) {
  const completed = (Array.isArray(trips) ? trips : []).filter((trip) => trip?.status === 'completed');
  const tripsAnalyzed = completed.length;
  const kmAnalyzed = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const tripsNeeded = Math.max(0, CALIBRATION_TRIPS_TARGET - tripsAnalyzed);
  const kmNeeded = Math.max(0, Math.ceil(CALIBRATION_KM_TARGET - kmAnalyzed));
  const percent = Math.min(100, Math.round(Math.max(
    tripsAnalyzed / CALIBRATION_TRIPS_TARGET,
    kmAnalyzed / CALIBRATION_KM_TARGET
  ) * 100));
  return {
    tripsAnalyzed,
    kmAnalyzed: Math.round(kmAnalyzed * 10) / 10,
    tripsNeeded,
    kmNeeded,
    percent,
  };
}

/**
 * Milestones currently reached. IDs are stable so the caller's dedupe store
 * delivers each one exactly once, however often this is evaluated.
 *
 * `profile` is optional; when a computed calibration profile is available its
 * `confidence` tier adds the two later milestones.
 *
 * @param {{tripsAnalyzed:number, kmAnalyzed:number}} progress
 * @param {any} [profile] result of computeCalibrationProfile
 * @returns {Array<{id:string, title:string, body:string}>}
 */
export function evaluateCalibrationMilestones(progress, profile = null) {
  const tripsAnalyzed = Number(progress?.tripsAnalyzed) || 0;
  const kmAnalyzed = Number(progress?.kmAnalyzed) || 0;
  const reached = [];

  const tripsReady = tripsAnalyzed >= CALIBRATION_TRIPS_TARGET;
  const distanceReady = kmAnalyzed >= CALIBRATION_KM_TARGET;

  if (!tripsReady && !distanceReady && (
    tripsAnalyzed >= CALIBRATION_TRIPS_TARGET / 2 || kmAnalyzed >= CALIBRATION_KM_TARGET / 2
  )) {
    reached.push(milestone(
      CALIBRATION_MILESTONE_IDS.HALFWAY,
      'Calibration halfway there',
      `${tripsAnalyzed} trips and ${Math.round(kmAnalyzed)} km analysed. Keep driving to unlock personal detection thresholds.`
    ));
  }
  if (tripsReady) {
    reached.push(milestone(
      CALIBRATION_MILESTONE_IDS.TRIPS_READY,
      'Enough trips for calibration',
      `${tripsAnalyzed} trips analysed - Road Sage can now suggest detection thresholds from your own driving.`
    ));
  }
  if (distanceReady) {
    reached.push(milestone(
      CALIBRATION_MILESTONE_IDS.DISTANCE_READY,
      'Enough distance for calibration',
      `${Math.round(kmAnalyzed)} km analysed - enough road for a personal threshold estimate.`
    ));
  }

  if (profile && profile.insufficient === false) {
    reached.push(milestone(
      CALIBRATION_MILESTONE_IDS.READY,
      'Personal calibration ready',
      'Open Settings to review the detection thresholds suggested from your driving.'
    ));
    if (profile.confidence === 'medium' || profile.confidence === 'high') {
      reached.push(milestone(
        CALIBRATION_MILESTONE_IDS.CONFIDENCE_MEDIUM,
        'Calibration confidence: medium',
        'Your suggested thresholds now rest on a broader sample of your driving.'
      ));
    }
    if (profile.confidence === 'high') {
      reached.push(milestone(
        CALIBRATION_MILESTONE_IDS.CONFIDENCE_HIGH,
        'Calibration confidence: high',
        'Your suggested detection thresholds are based on a large sample of your own driving.'
      ));
    }
  }

  return reached;
}
