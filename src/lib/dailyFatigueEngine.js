import { clamp } from '@/lib/mathUtils';
import { scoringValue } from '@/lib/scoringConstants';

const startOfLocalDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const DAILY_FATIGUE_THRESHOLDS = Object.freeze({
  MODERATE: 3,
  HIGH: 5,
  CRITICAL: 7,
});
export const DAILY_FATIGUE_DEFAULTS = Object.freeze({
  /**
   * Provisional early-warning threshold. A 90-minute simulator study observed
   * time-on-task fatigue effects, but this score is not outcome-calibrated.
   * @see https://doi.org/10.1016/j.physbeh.2008.02.015
   */
  FATIGUE_ONSET_MINUTES: scoringValue('DAILY_FATIGUE_ONSET_MINUTES'),
  /**
   * Provisional recovery threshold. A simulated driving study found a 30-minute
   * rest reduced subjective fatigue but not performance; this model remains approximate.
   * @see https://doi.org/10.1177/001872088502700207
   */
  RECOVERY_BREAK_MINUTES: scoringValue('DAILY_RECOVERY_BREAK_MINUTES'),
  /**
   * Product-model interpolation cap, not a researched full-recovery guarantee.
   * It uses the cited rest-break evidence only as context for recovery modelling.
   * @see https://doi.org/10.1177/001872088502700207
   */
  FULL_RECOVERY_BREAK_MINUTES: scoringValue('DAILY_FULL_RECOVERY_BREAK_MINUTES'),
  /**
   * Provisional heuristic: score assigned at the fatigue-onset minute threshold.
   * Not calibrated to published driving-fatigue research or clinical guidance.
   */
  FATIGUE_SCORE_AT_ONSET: scoringValue('DAILY_FATIGUE_SCORE_AT_ONSET'),
  /**
   * Provisional UI guidance for suggested rest by fatigue level.
   * Not calibrated to published driving-fatigue research or clinical guidance.
   */
  RECOMMENDED_BREAK_MINUTES: Object.freeze({
    critical: 30,
    high: 20,
    moderate: 10,
    low: 0,
  }),
});

const getTimeMs = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const getActiveDrivingMinutes = (trip) => {
  const movingSeconds = Math.max(0, (Number(trip?.duration_seconds) || 0) - (Number(trip?.idle_time_seconds) || 0));
  return movingSeconds / 60;
};

const applyBreakRecovery = (fatigueMinutes, breakMinutes) => {
  if (!(breakMinutes > DAILY_FATIGUE_DEFAULTS.RECOVERY_BREAK_MINUTES)) return fatigueMinutes;
  return fatigueMinutes * Math.max(0, 1 - breakMinutes / DAILY_FATIGUE_DEFAULTS.FULL_RECOVERY_BREAK_MINUTES);
};

/**
 * Return completed trips that started during the current local day.
 * @param {Array<object>} trips - Trip records to filter.
 * @returns {Array<object>} Completed trips from today.
 * @example getTodayTrips(completedTrips)
 */
export function getTodayTrips(trips = []) {
  const start = startOfLocalDay();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return (trips || []).filter((trip) => {
    if (trip?.status !== 'completed') return false;
    const startTime = new Date(trip.start_time);
    return startTime >= start && startTime < end;
  });
}

/**
 * Compute cumulative daily fatigue from today's trips and recovery time.
 * @param {Array<object>} todayTrips - Completed trips from the current local day.
 * @param {object} settings - User settings; may include a test-only now clock.
 * @param {number} fatigueOnsetMinutes - Learned minute threshold where fatigue starts rising.
 * @returns {object} Fatigue totals, level, break recommendation, and warning state.
 * @example computeDailyFatigue(todayTrips, settings, habitProfile?.fatigueOnsetMinutes)
 */
export function computeDailyFatigue(
  todayTrips = [],
  settings = {},
  fatigueOnsetMinutes = DAILY_FATIGUE_DEFAULTS.FATIGUE_ONSET_MINUTES
) {
  const trips = [...(todayTrips || [])]
    .filter((trip) => (
      trip?.status === 'completed' &&
      getTimeMs(trip.start_time) != null &&
      getTimeMs(trip.end_time) != null
    ))
    .sort((a, b) => (getTimeMs(a.start_time) ?? 0) - (getTimeMs(b.start_time) ?? 0));
  const now = settings?.now instanceof Date
    ? settings.now
    : settings?.now != null
      ? new Date(settings.now)
      : new Date();
  const onsetMinutes = Number.isFinite(Number(fatigueOnsetMinutes)) && Number(fatigueOnsetMinutes) > 0
    ? Number(fatigueOnsetMinutes)
    : DAILY_FATIGUE_DEFAULTS.FATIGUE_ONSET_MINUTES;
  const totalDrivingMinutes = Math.max(0, trips.reduce((sum, trip) => sum + getActiveDrivingMinutes(trip), 0));
  const tripCount = trips.length;

  let longestBreakMinutes = 0;
  let accumulatedFatigueMinutes = 0;
  let lastEndTimeMs = null;

  for (const trip of trips) {
    const currentStart = getTimeMs(trip.start_time);
    if (lastEndTimeMs != null && currentStart != null) {
      const breakMinutes = Math.max(0, (currentStart - lastEndTimeMs) / 60000);
      longestBreakMinutes = Math.max(longestBreakMinutes, breakMinutes);
      accumulatedFatigueMinutes = applyBreakRecovery(accumulatedFatigueMinutes, breakMinutes);
    }

    accumulatedFatigueMinutes += getActiveDrivingMinutes(trip);
    lastEndTimeMs = getTimeMs(trip.end_time) ?? currentStart ?? lastEndTimeMs;
  }

  const lastTrip = trips[trips.length - 1] || null;
  const lastTripEndTime = lastTrip ? (getTimeMs(lastTrip.end_time) ?? getTimeMs(lastTrip.start_time)) : null;
  const minutesSinceLastTrip = lastTripEndTime != null && Number.isFinite(now.getTime())
    ? Math.max(0, (now.getTime() - lastTripEndTime) / 60000)
    : null;
  if (minutesSinceLastTrip != null) {
    accumulatedFatigueMinutes = applyBreakRecovery(accumulatedFatigueMinutes, minutesSinceLastTrip);
  }

  const fatigueRatio = clamp(accumulatedFatigueMinutes / onsetMinutes, 0, 2);
  const cumulativeFatigueScore = clamp(
    Math.round((fatigueRatio * DAILY_FATIGUE_DEFAULTS.FATIGUE_SCORE_AT_ONSET) * 10) / 10,
    0,
    10
  );
  const fatigueLevel = cumulativeFatigueScore >= DAILY_FATIGUE_THRESHOLDS.CRITICAL
    ? 'critical'
    : cumulativeFatigueScore >= DAILY_FATIGUE_THRESHOLDS.HIGH
      ? 'high'
      : cumulativeFatigueScore >= DAILY_FATIGUE_THRESHOLDS.MODERATE
        ? 'moderate'
        : 'low';
  const recommendedBreakMinutes = DAILY_FATIGUE_DEFAULTS.RECOMMENDED_BREAK_MINUTES[fatigueLevel] ?? 0;

  return {
    totalDrivingMinutes: Math.round(totalDrivingMinutes),
    accumulatedFatigueMinutes: Math.round(accumulatedFatigueMinutes),
    tripCount,
    longestBreakMinutes: Math.round(longestBreakMinutes),
    minutesSinceLastTrip: minutesSinceLastTrip == null ? null : Math.round(minutesSinceLastTrip),
    cumulativeFatigueScore,
    fatigueLevel,
    recommendedBreakMinutes,
    shouldWarnBeforeTrip: fatigueLevel === 'high' || fatigueLevel === 'critical',
  };
}
