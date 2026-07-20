// @ts-check
import { getTripComponentScore } from '@/lib/tripEngine';

export const PREMIUM_TRIP_TIME_PERIODS = Object.freeze({
  DAWN: 'dawn',
  DAY: 'day',
  DUSK: 'dusk',
  NIGHT: 'night',
});

const TIME_PRESENTATIONS = Object.freeze({
  dawn: { label: 'Morning Drive', shortLabel: 'Morning' },
  day: { label: 'Day Drive', shortLabel: 'Daytime' },
  dusk: { label: 'Evening Drive', shortLabel: 'Evening' },
  night: { label: 'Night Drive', shortLabel: 'Night' },
});

/**
 * Uses the same local clock interpretation as the card's formatted trip time.
 * @param {string|number|Date|null|undefined} startTime
 */
export function getPremiumTripTimePresentation(startTime) {
  const date = startTime instanceof Date ? startTime : new Date(startTime || 0);
  const hour = Number.isFinite(date.getTime()) ? date.getHours() : 12;
  const period = hour >= 5 && hour < 9
    ? PREMIUM_TRIP_TIME_PERIODS.DAWN
    : hour >= 9 && hour < 17
      ? PREMIUM_TRIP_TIME_PERIODS.DAY
      : hour >= 17 && hour < 21
        ? PREMIUM_TRIP_TIME_PERIODS.DUSK
        : PREMIUM_TRIP_TIME_PERIODS.NIGHT;

  return { ...TIME_PRESENTATIONS[period], hour, period };
}

const SCORE_TONES = Object.freeze([
  { minimum: 85, tone: 'excellent', label: 'Excellent', hue: '151 79% 53%' },
  { minimum: 70, tone: 'good', label: 'Good', hue: '198 91% 55%' },
  { minimum: 55, tone: 'fair', label: 'Fair', hue: '39 96% 56%' },
  { minimum: 40, tone: 'poor', label: 'Poor', hue: '25 95% 55%' },
  { minimum: 0, tone: 'risky', label: 'Risky', hue: '0 88% 61%' },
]);

/** @param {unknown} score */
export function getPremiumTripScorePresentation(score) {
  const numeric = score == null || score === '' ? null : Number(score);
  if (!Number.isFinite(numeric)) {
    return {
      degrees: 0,
      label: 'Unavailable',
      normalizedScore: null,
      tone: 'unavailable',
      hue: '215 18% 58%',
    };
  }

  const normalizedScore = Math.max(0, Math.min(100, numeric));
  const selected = SCORE_TONES.find(({ minimum }) => normalizedScore >= minimum) || SCORE_TONES[SCORE_TONES.length - 1];
  return {
    ...selected,
    degrees: Math.round(normalizedScore * 36) / 10,
    normalizedScore,
  };
}

/**
 * Dusk receives the two risk-sensitive city treatments shown in the visual
 * reference. Other periods keep their distinct time-of-day scenes.
 * @param {string} period
 * @param {string} scoreTone
 * @param {{eventCount?: number, distanceKm?: number, aggressive?: boolean, proximityCount?: number}} [context]
 */
export function getPremiumTripSceneVariant(period, scoreTone, context = {}) {
  if (period !== PREMIUM_TRIP_TIME_PERIODS.DUSK) return period;
  const eventCount = Math.max(0, Number(context.eventCount) || 0);
  const distanceKm = Math.max(0, Number(context.distanceKm) || 0);
  const eventDensity = distanceKm > 0 ? eventCount / distanceKm : eventCount;
  const needsAttention = context.aggressive === true ||
    (Number(context.proximityCount) || 0) > 0 ||
    eventCount >= 4 ||
    (eventCount >= 3 && eventDensity >= 1.5);

  if (scoreTone === 'fair' && needsAttention) return 'dusk-risk';
  if (scoreTone === 'fair') return 'dusk-caution';
  if (scoreTone === 'poor' || scoreTone === 'risky') return 'dusk-risk';
  return PREMIUM_TRIP_TIME_PERIODS.DUSK;
}

/** @param {Record<string, any>} trip */
export function getConfirmedPhoneUseCount(trip = {}) {
  const confirmedEvents = [
    ...(Array.isArray(trip.phone_use_events) ? trip.phone_use_events : []),
    ...(Array.isArray(trip.driving_events)
      ? trip.driving_events.filter((event) => event?.type === 'phone_use')
      : []),
  ].filter((event) => (
    event?.source === 'android_usage_access' ||
    (event?.type === 'phone_use' && event?.diagnostic_only !== true && event?.source !== 'gps_proxy')
  ));

  if (trip.phone_use_score_available !== true && trip.phone_use_score_status !== 'android_usage_access') return 0;
  return Math.max(Number(trip.phone_use_window_count) || 0, confirmedEvents.length);
}

/** @param {Record<string, any>} trip */
export function getPremiumTripEventCount(trip = {}) {
  return (Number(trip.harsh_brakes_count) || 0)
    + (Number(trip.rapid_accel_count) || 0)
    + (Number(trip.sharp_turns_count) || 0)
    + (Number(trip.speeding_events_count) || 0)
    + getConfirmedPhoneUseCount(trip);
}

/**
 * Compares a trip with up to five immediately preceding scored trips.
 * @param {Record<string, any>} trip
 * @param {Array<Record<string, any>>} trips
 */
export function getPremiumTripScoreDelta(trip, trips = []) {
  const recent = [...(Array.isArray(trips) ? trips : [])].sort(
    (a, b) => new Date(b?.start_time || 0).getTime() - new Date(a?.start_time || 0).getTime()
  );
  const index = recent.findIndex((item) => String(item?.id) === String(trip?.id));
  const currentScore = getTripComponentScore(trip, 'overall').value;
  if (index < 0 || !Number.isFinite(currentScore)) return null;

  const previousFive = recent
    .slice(index + 1, index + 6)
    .map((item) => getTripComponentScore(item, 'overall').value)
    .filter(Number.isFinite);

  if (previousFive.length < 3) {
    return {
      delta: null,
      direction: 'flat',
      insufficientBaseline: true,
      sampleCount: previousFive.length,
    };
  }

  const average = previousFive.reduce((sum, score) => sum + score, 0) / previousFive.length;
  const delta = currentScore - average;
  return {
    delta,
    direction: delta >= 3 ? 'up' : delta <= -3 ? 'down' : 'flat',
    insufficientBaseline: false,
    sampleCount: previousFive.length,
  };
}
