import { analyzeDayOfWeek, analyzeTimeOfDay, computePersonalBaseline } from '@/lib/tripInsights';
import { getFallbackTimeRisk, getTimeBucket } from '@/lib/habitProfile';
import { clamp } from '@/lib/mathUtils';

const RISK_CONSTANTS = {
  MIN_TRIPS_FOR_BUCKET: 3,
  MIN_TRIPS_FOR_DAY: 2,
  MIN_TRIPS_FOR_CALIBRATION: 5,
  FULL_CALIBRATION_TRIPS: 30,
  FALLBACK_NIGHT_RISK: 60,
  FALLBACK_MORNING_RUSH_RISK: 35,
  FALLBACK_EVENING_RUSH_RISK: 40,
  FALLBACK_DEFAULT_RISK: 20,
  HIGH_RISK_FLOOR: 65,
  MODERATE_RISK_FLOOR: 40,
  GATE_ADJUSTMENT_MAX: 5,
  TREND_WINDOW: 20,
  RECENT_TRIP_DAYS: 90,
};

const DEFAULT_WEIGHTS = {
  timeOfDay: 0.14,
  dayOfWeek: 0.10,
  recentTrend: 0.18,
  dailyFatigue: 0.20,
  lastTripOutcome: 0.12,
  weather: 0.08,
  dangerZones: 0.06,
  routeForecast: 0.08,
  recentRest: 0.04,
};

export const PRE_TRIP_RISK_WEIGHTS = DEFAULT_WEIGHTS;

export const PRE_TRIP_RISK_SIGNAL_GATES = {
  moderateTimeOfDay: 60,
  highTimeOfDay: 80,
  moderateRouteForecast: 40,
  highRouteForecast: 65,
  moderateDailyFatigue: 70,
  highDailyFatigue: 90,
  moderateRecentRest: 80,
  moderateWeather: 60,
  moderateDangerZones: 70,
};

const SIGNAL_LABELS = {
  timeOfDay: 'Higher-risk time of day for you',
  dayOfWeek: 'This day of week trends lower for you',
  recentTrend: 'Your scores have been declining recently',
  dailyFatigue: 'High daily fatigue accumulation',
  lastTripOutcome: 'Low score on your last trip',
  weather: 'Weather may raise trip risk',
  dangerZones: 'Known danger zones are nearby',
  routeForecast: 'Predicted route conditions look elevated',
  recentRest: 'Short recovery since your last trip',
};

const SIGNAL_TIPS = {
  timeOfDay: 'Drive the first few minutes deliberately and leave extra following room.',
  dayOfWeek: 'Start smooth and treat this route like a fresh baseline.',
  recentTrend: 'Pick one behaviour to protect this trip instead of fixing everything.',
  dailyFatigue: 'A short break before starting will improve alertness.',
  lastTripOutcome: 'Ease into this drive and avoid repeating the last trip pattern.',
  weather: 'Increase following distance and brake earlier than usual.',
  dangerZones: 'Start slowly and watch for the familiar risk segment.',
  routeForecast: 'Consider the calmer window or start with a wider safety margin.',
  recentRest: 'Pause briefly before driving again, especially after a demanding trip.',
};

const last90Days = (trips = [], now = new Date()) => {
  const cutoff = now.getTime() - RISK_CONSTANTS.RECENT_TRIP_DAYS * 24 * 60 * 60 * 1000;
  return trips.filter((trip) => new Date(trip.start_time || trip.startedAt || 0).getTime() >= cutoff);
};

const fallbackTimeRisk = (hour) => {
  if (hour >= 22 || hour < 5) return RISK_CONSTANTS.FALLBACK_NIGHT_RISK;
  if (hour >= 7 && hour <= 9) return RISK_CONSTANTS.FALLBACK_MORNING_RUSH_RISK;
  if (hour >= 16 && hour <= 18) return RISK_CONSTANTS.FALLBACK_EVENING_RUSH_RISK;
  return RISK_CONSTANTS.FALLBACK_DEFAULT_RISK;
};

const routeRiskFromContext = (context = {}) => {
  const directScore = Number(context.routeRiskScore ?? context.predictiveRouteRisk?.riskScore);
  if (Number.isFinite(directScore)) return clamp(directScore, 0, 100);

  const level = context.routeRiskLevel || context.predictiveRouteRisk?.riskLevel;
  if (level === 'high') return 75;
  if (level === 'moderate') return 45;
  if (level === 'low') return 15;
  return 0;
};

const recentRestRisk = (lastTrip, nowMs) => {
  if (!lastTrip) return 10;
  const endMs = new Date(lastTrip.end_time || lastTrip.endedAt || lastTrip.start_time || lastTrip.startedAt || 0).getTime();
  if (!Number.isFinite(endMs) || endMs <= 0 || endMs > nowMs) return 10;

  const minutesSinceLastTrip = (nowMs - endMs) / 60000;
  if (minutesSinceLastTrip < 15) return 80;
  if (minutesSinceLastTrip < 30) return 60;
  if (minutesSinceLastTrip < 60) return 35;
  return 5;
};

const dailyFatigueRisk = (dailyFatigueState) => {
  if (!dailyFatigueState) return 20;
  if (dailyFatigueState.fatigueLevel === 'critical') return 90;
  if (dailyFatigueState.fatigueLevel === 'high') return 70;
  if (dailyFatigueState.fatigueLevel === 'moderate') return 40;
  return 10;
};

const normalizeWeights = (weights) => {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total]));
};

/**
 * Derive readiness signal weights from profile confidence and bucket data quality.
 * @param {object|null} profile - Optional habit profile returned by buildHabitProfile.
 * @param {Date} now - Clock used to resolve current time and day buckets.
 * @returns {object} Normalized signal weight map that sums to 1.
 * @example deriveWeights(habitProfile, new Date())
 */
export function deriveWeights(profile = null, now = new Date()) {
  if (!profile || Number(profile.confidence) < 0.3) {
    return DEFAULT_WEIGHTS;
  }

  const adjusted = { ...DEFAULT_WEIGHTS };
  const currentBucket = getTimeBucket(now.getHours());
  const currentDow = now.getDay();

  if (profile.timeBuckets?.[currentBucket]?.insufficient) {
    const freed = adjusted.timeOfDay * 0.5;
    adjusted.timeOfDay -= freed;
    adjusted.recentTrend += freed * 0.6;
    adjusted.dailyFatigue += freed * 0.4;
  }

  if (profile.dayOfWeek?.[currentDow]?.insufficient) {
    const freed = adjusted.dayOfWeek * 0.5;
    adjusted.dayOfWeek -= freed;
    adjusted.recentTrend += freed * 0.6;
    adjusted.dailyFatigue += freed * 0.4;
  }

  return normalizeWeights(adjusted);
}

/**
 * Derive signal-gate floors from a driver's calibrated all-time average.
 * @param {object|null} profile - Optional habit profile returned by buildHabitProfile.
 * @returns {{highFloor: number, moderateFloor: number}} Adaptive gate floors.
 * @example deriveSignalGates(habitProfile)
 */
export function deriveSignalGates(profile = null) {
  if (!profile || Number(profile.confidence) < 0.3) {
    return {
      highFloor: RISK_CONSTANTS.HIGH_RISK_FLOOR,
      moderateFloor: RISK_CONSTANTS.MODERATE_RISK_FLOOR,
    };
  }

  const baseline = Number.isFinite(Number(profile.allTimeAvgScore)) ? Number(profile.allTimeAvgScore) : 70;
  const adjustment = clamp((baseline - 70) / 10, -RISK_CONSTANTS.GATE_ADJUSTMENT_MAX, RISK_CONSTANTS.GATE_ADJUSTMENT_MAX);

  return {
    highFloor: RISK_CONSTANTS.HIGH_RISK_FLOOR - adjustment,
    moderateFloor: RISK_CONSTANTS.MODERATE_RISK_FLOOR - adjustment,
  };
}

const riskFloorFromSignalGates = (signals, profile) => {
  const gates = PRE_TRIP_RISK_SIGNAL_GATES;
  const floors = deriveSignalGates(profile);
  const highSignal =
    signals.timeOfDay >= gates.highTimeOfDay ||
    signals.routeForecast >= gates.highRouteForecast ||
    (signals.dailyFatigue >= gates.highDailyFatigue && signals.lastTripOutcome >= 70);

  if (highSignal) return floors.highFloor;

  const moderateSignal =
    signals.timeOfDay >= gates.moderateTimeOfDay ||
    signals.routeForecast >= gates.moderateRouteForecast ||
    signals.dailyFatigue >= gates.moderateDailyFatigue ||
    signals.recentRest >= gates.moderateRecentRest ||
    signals.weather >= gates.moderateWeather ||
    signals.dangerZones >= gates.moderateDangerZones;

  return moderateSignal ? floors.moderateFloor : 0;
};

const weightedRisk = (signals, weights) => Math.round(Object.entries(weights).reduce(
  (sum, [key, weight]) => sum + clamp(signals[key], 0, 100) * weight,
  0
));

/**
 * Compute trip readiness risk from historical trips, current fatigue, and route context.
 * @param {Array<object>} trips - Completed and recent trip records.
 * @param {object} settings - User settings object kept for API compatibility.
 * @param {object|null} dailyFatigueState - Daily fatigue state from computeDailyFatigue.
 * @param {object} context - Weather, danger-zone, route-risk, and optional now values.
 * @param {object|null} habitProfile - Optional learned profile returned by buildHabitProfile.
 * @returns {object} Readiness result with composite risk, score, signals, and data quality.
 * @example computePreTripRisk(completedTrips, settings, dailyFatigue, context, habitProfile)
 */
export function computePreTripRisk(trips = [], settings = {}, dailyFatigueState = null, context = {}, habitProfile = null) {
  void settings;
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const now = context?.now instanceof Date
    ? context.now
    : context?.now != null
      ? new Date(context.now)
      : new Date();
  const nowMs = now.getTime();
  const recent = last90Days(completed, now);
  const currentBucket = getTimeBucket(now.getHours());
  const currentDow = now.getDay();
  const timeData = analyzeTimeOfDay(recent);
  const dayData = analyzeDayOfWeek(recent);
  const legacyTimeBucket = timeData.find((bucket) => bucket.label === currentBucket);
  const legacyDayEntry = dayData[currentDow];
  const baseline = computePersonalBaseline(recent);
  const sorted = [...completed].sort((a, b) => (
    new Date(b.end_time || b.endedAt || b.start_time || b.startedAt || 0).getTime() -
    new Date(a.end_time || a.endedAt || a.start_time || a.startedAt || 0).getTime()
  ));
  const lastTrip = sorted[0] || null;
  const profileTimeBucket = habitProfile?.timeBuckets?.[currentBucket];
  const profileDayEntry = habitProfile?.dayOfWeek?.[currentDow];

  const signals = {
    timeOfDay: habitProfile && profileTimeBucket?.insufficient === false
      ? profileTimeBucket.riskScore
      : habitProfile
        ? getFallbackTimeRisk(now.getHours(), habitProfile)
        : legacyTimeBucket?.avgScore != null
          ? 100 - legacyTimeBucket.avgScore
          : fallbackTimeRisk(now.getHours()),
    dayOfWeek: habitProfile && profileDayEntry?.insufficient === false
      ? profileDayEntry.riskScore
      : habitProfile
        ? 50
        : legacyDayEntry?.avgScore != null
          ? 100 - legacyDayEntry.avgScore
          : 25,
    recentTrend: habitProfile
      ? habitProfile.trendRisk
      : baseline.trend === 'declining'
        ? 65
        : baseline.trend === 'improving'
          ? 10
          : 30,
    dailyFatigue: dailyFatigueRisk(dailyFatigueState),
    lastTripOutcome: lastTrip ? 100 - (lastTrip.score_overall ?? lastTrip.overall_score ?? lastTrip.score ?? 50) : 25,
    weather: Number(context.weatherRiskScore) || Number(context.weather_context?.riskScore) || 0,
    dangerZones: (Number(context.nearbyDangerZoneCount) || 0) * 35,
    routeForecast: routeRiskFromContext(context),
    recentRest: recentRestRisk(lastTrip, nowMs),
  };

  const clampedSignals = Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, clamp(value, 0, 100)]));
  const weights = deriveWeights(habitProfile, now);
  const weightedCompositeRisk = weightedRisk(clampedSignals, weights);
  const compositeRisk = clamp(Math.round(Math.max(weightedCompositeRisk, riskFloorFromSignalGates(clampedSignals, habitProfile))), 0, 100);
  const riskLevel = compositeRisk >= RISK_CONSTANTS.HIGH_RISK_FLOOR
    ? 'high'
    : compositeRisk >= RISK_CONSTANTS.MODERATE_RISK_FLOOR
      ? 'moderate'
      : 'low';
  const primaryKey = Object.entries(clampedSignals).sort((a, b) => b[1] - a[1])[0]?.[0] || 'timeOfDay';
  const topSignals = Object.entries(clampedSignals)
    .map(([key, value]) => ({
      key,
      value: Math.round(value),
      label: SIGNAL_LABELS[key],
      tip: SIGNAL_TIPS[key],
    }))
    .filter((signal) => signal.value >= 25)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  return {
    compositeRisk,
    readinessScore: 100 - compositeRisk,
    riskLevel,
    primaryConcern: SIGNAL_LABELS[primaryKey],
    tipText: SIGNAL_TIPS[primaryKey],
    topSignals,
    signals: clampedSignals,
    habitProfile,
    dataQuality: {
      confidence: habitProfile?.confidence ?? 0,
      sufficientTimeData: habitProfile ? profileTimeBucket?.insufficient === false : false,
      sufficientDayData: habitProfile ? profileDayEntry?.insufficient === false : false,
      personalised: (habitProfile?.confidence ?? 0) >= 0.3,
    },
  };
}
