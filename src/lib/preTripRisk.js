import { analyzeDayOfWeek, analyzeTimeOfDay, computePersonalBaseline } from '@/lib/tripInsights';
import { weightedBlend } from '@/lib/scoring/componentScores';
import { getTimeBucket } from '@/lib/habitProfile';
import { clamp } from '@/lib/mathUtils';
import { scoringValue } from '@/lib/scoringConstants';

const RISK_CONSTANTS = scoringValue('PRE_TRIP_READINESS_POLICY');

/**
 * Provisional pre-trip readiness signal weights. These are product heuristics,
 * not calibrated to crash, claims, or naturalistic driving outcome data.
 */
const DEFAULT_WEIGHTS = scoringValue('PRE_TRIP_RISK_WEIGHTS');

export const PRE_TRIP_RISK_WEIGHTS = DEFAULT_WEIGHTS;
/**
 * Provisional fraction of an insufficient personalized bucket's weight that is
 * redistributed to broader recent-trend and fatigue signals.
 */
export const PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO = scoringValue('PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO');
export const PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS = scoringValue('PRE_TRIP_REDISTRIBUTION_TARGETS');

export const PRE_TRIP_RISK_SIGNAL_GATES = scoringValue('PRE_TRIP_SIGNAL_GATES');

const SIGNAL_LABELS = {
  timeOfDay: 'Higher-risk time of day for you',
  dayOfWeek: 'This day of week trends lower for you',
  recentTrend: 'Your scores have been declining recently',
  dailyFatigue: 'High daily fatigue accumulation',
  lastTripOutcome: 'Low score on your last trip',
  weather: 'Weather may raise trip risk',
  dangerZones: 'Your repeated driving-event areas are nearby',
  routeForecast: 'Historical context estimate looks elevated',
  recentRest: 'Short recovery since your last trip',
};

const SIGNAL_TIPS = {
  timeOfDay: 'Drive the first few minutes deliberately and leave extra following room.',
  dayOfWeek: 'Start smooth and treat this route like a fresh baseline.',
  recentTrend: 'Pick one behaviour to protect this trip instead of fixing everything.',
  dailyFatigue: 'A short break before starting will improve alertness.',
  lastTripOutcome: 'Ease into this drive and avoid repeating the last trip pattern.',
  weather: 'Leave more space ahead and brake earlier than usual.',
  dangerZones: 'Start slowly and watch for the familiar repeated-event area.',
  routeForecast: 'Consider the calmer window or start with a wider safety margin.',
  recentRest: 'Pause briefly before driving again, especially after a demanding trip.',
};

const last90Days = (trips = [], now = new Date()) => {
  const cutoff = now.getTime() - RISK_CONSTANTS.RECENT_TRIP_DAYS * 24 * 60 * 60 * 1000;
  return trips.filter((trip) => new Date(trip.start_time || trip.startedAt || 0).getTime() >= cutoff);
};

const routeRiskFromContext = (context = {}) => {
  if (
    context.predictiveRouteRisk?.insufficientHistory ||
    context.predictiveRouteRisk?.status === 'insufficient_history'
  ) {
    return null;
  }

  const rawScore = context.routeRiskScore ?? context.predictiveRouteRisk?.riskScore;
  const directScore = rawScore == null || rawScore === '' ? Number.NaN : Number(rawScore);
  if (Number.isFinite(directScore)) return clamp(directScore, 0, 100);

  return null;
};

const recentRestRisk = (lastTrip, nowMs) => {
  if (!lastTrip) return null;
  const endMs = new Date(lastTrip.end_time || lastTrip.endedAt || lastTrip.start_time || lastTrip.startedAt || 0).getTime();
  if (!Number.isFinite(endMs) || endMs <= 0 || endMs > nowMs) return null;

  const minutesSinceLastTrip = (nowMs - endMs) / 60000;
  if (minutesSinceLastTrip < 15) return 80;
  if (minutesSinceLastTrip < 30) return 60;
  if (minutesSinceLastTrip < 60) return 35;
  return 5;
};

const dailyFatigueRisk = (dailyFatigueState) => {
  if (!dailyFatigueState) return null;
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
    const freed = adjusted.timeOfDay * PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO;
    adjusted.timeOfDay -= freed;
    adjusted.recentTrend += freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.recentTrend;
    adjusted.dailyFatigue += freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.dailyFatigue;
  }

  if (profile.dayOfWeek?.[currentDow]?.insufficient) {
    const freed = adjusted.dayOfWeek * PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO;
    adjusted.dayOfWeek -= freed;
    adjusted.recentTrend += freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.recentTrend;
    adjusted.dailyFatigue += freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.dailyFatigue;
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

const signalValue = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const riskFloorFromSignalGates = (signals, profile) => {
  const gates = PRE_TRIP_RISK_SIGNAL_GATES;
  const floors = deriveSignalGates(profile);
  const highSignal =
    signalValue(signals.timeOfDay) >= gates.highTimeOfDay ||
    signalValue(signals.routeForecast) >= gates.highRouteForecast ||
    (signalValue(signals.dailyFatigue) >= gates.highDailyFatigue && signalValue(signals.lastTripOutcome) >= 70);

  if (highSignal) return floors.highFloor;

  const moderateSignal =
    signalValue(signals.timeOfDay) >= gates.moderateTimeOfDay ||
    signalValue(signals.routeForecast) >= gates.moderateRouteForecast ||
    signalValue(signals.dailyFatigue) >= gates.moderateDailyFatigue ||
    signalValue(signals.recentRest) >= gates.moderateRecentRest ||
    signalValue(signals.weather) >= gates.moderateWeather ||
    signalValue(signals.dangerZones) >= gates.moderateDangerZones;

  return moderateSignal ? floors.moderateFloor : 0;
};

const weightedRisk = (signals, weights) => weightedBlend(
  Object.entries(weights).map(([key, weight]) => ({ score: signals[key], weight }))
);

const nullableRisk = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
};

const declineRiskFromDelta = (delta) => {
  if (delta == null || delta === '') return null;
  const parsed = Number(delta);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.round(Math.max(0, -parsed)), 0, 100);
};

const finiteRisk = (value) => Number.isFinite(Number(value));

const signalSource = (source, { actualUserData = false, fallback = false } = {}) => ({
  source,
  actualUserData,
  fallback,
});

const profileBucketHasTrips = (bucket, minimumTrips) => (
  bucket?.insufficient === false &&
  Number(bucket.tripCount) >= minimumTrips &&
  finiteRisk(bucket.riskScore)
);

/**
 * Compute trip readiness risk from historical trips, current fatigue, and route context.
 * @param {Array<object>} trips - Completed and recent trip records.
 * @param {object} settings - User settings object kept for API compatibility.
 * @param {object|null} dailyFatigueState - Daily fatigue state from computeDailyFatigue.
 * @param {object} context - Weather, repeated-event-area, historical-context, and optional now values.
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
  const hasProfileTimeRisk = habitProfile && profileBucketHasTrips(profileTimeBucket, RISK_CONSTANTS.MIN_TRIPS_FOR_BUCKET);
  const hasProfileDayRisk = habitProfile && profileBucketHasTrips(profileDayEntry, RISK_CONSTANTS.MIN_TRIPS_FOR_DAY);
  const hasProfileTrendRisk = habitProfile && Number(habitProfile.confidence) > 0 && finiteRisk(habitProfile.trendDelta);
  const hasLegacyTimeRisk = legacyTimeBucket?.avgScore != null && legacyTimeBucket.trips >= RISK_CONSTANTS.MIN_TRIPS_FOR_BUCKET;
  const hasLegacyDayRisk = legacyDayEntry?.avgScore != null && legacyDayEntry.trips >= RISK_CONSTANTS.MIN_TRIPS_FOR_DAY;
  const legacyTimeRisk = hasLegacyTimeRisk
    ? 100 - legacyTimeBucket.avgScore
    : null;
  const legacyDayRisk = hasLegacyDayRisk
    ? 100 - legacyDayEntry.avgScore
    : null;
  const baselineTrendRisk = declineRiskFromDelta(baseline.delta);
  const lastTripScore = lastTrip
    ? nullableRisk(lastTrip.score_overall ?? lastTrip.overall_score ?? lastTrip.score)
    : null;
  const weatherRisk = nullableRisk(context.weatherRiskScore ?? context.weather_context?.riskScore);
  const dangerZoneRisk = context.nearbyDangerZoneCount == null
    ? null
    : clamp((Number(context.nearbyDangerZoneCount) || 0) * 35, 0, 100);
  const routeForecastRisk = routeRiskFromContext(context);
  const restRisk = recentRestRisk(lastTrip, nowMs);
  const fatigueRisk = dailyFatigueRisk(dailyFatigueState);
  const timeOfDayRisk = hasProfileTimeRisk
    ? profileTimeBucket.riskScore
    : hasLegacyTimeRisk
      ? legacyTimeRisk
      : null;
  const dayOfWeekRisk = hasProfileDayRisk
    ? profileDayEntry.riskScore
    : hasLegacyDayRisk
      ? legacyDayRisk
      : null;
  const recentTrendRisk = hasProfileTrendRisk
    ? declineRiskFromDelta(habitProfile.trendDelta)
    : baselineTrendRisk;

  const signals = {
    timeOfDay: timeOfDayRisk,
    dayOfWeek: dayOfWeekRisk,
    recentTrend: recentTrendRisk,
    dailyFatigue: fatigueRisk,
    lastTripOutcome: lastTripScore == null ? null : 100 - lastTripScore,
    weather: weatherRisk,
    dangerZones: dangerZoneRisk,
    routeForecast: routeForecastRisk,
    recentRest: restRisk,
  };
  const signalProvenance = {
    timeOfDay: hasProfileTimeRisk
      ? signalSource('habit_profile_time_bucket', { actualUserData: true })
      : hasLegacyTimeRisk
        ? signalSource('legacy_time_bucket_history', { actualUserData: true })
        : signalSource('unavailable_personal_time_history', { fallback: true }),
    dayOfWeek: hasProfileDayRisk
      ? signalSource('habit_profile_day_bucket', { actualUserData: true })
      : hasLegacyDayRisk
        ? signalSource('legacy_day_history', { actualUserData: true })
        : signalSource('unavailable_personal_day_history', { fallback: true }),
    recentTrend: recentTrendRisk != null
      ? signalSource(hasProfileTrendRisk ? 'habit_profile_trend_delta' : 'personal_baseline_delta', { actualUserData: true })
      : signalSource('unavailable_personal_trend', { fallback: true }),
    dailyFatigue: fatigueRisk != null
      ? signalSource('daily_fatigue_state', { actualUserData: true })
      : signalSource('unavailable_daily_fatigue'),
    lastTripOutcome: lastTripScore != null
      ? signalSource('last_completed_trip_score', { actualUserData: true })
      : signalSource('unavailable_last_trip'),
    weather: weatherRisk != null
      ? signalSource('weather_context')
      : signalSource('unavailable_weather'),
    dangerZones: dangerZoneRisk != null
      ? signalSource('personal_repeated_event_areas', { actualUserData: true })
      : signalSource('unavailable_danger_zones'),
    routeForecast: routeForecastRisk != null
      ? signalSource('personal_route_history', { actualUserData: true })
      : signalSource('unavailable_route_history'),
    recentRest: restRisk != null
      ? signalSource('recent_trip_timing', { actualUserData: true })
      : signalSource('unavailable_recent_rest'),
  };

  const clampedSignals = Object.fromEntries(Object.entries(signals).map(([key, value]) => [
    key,
    value == null || value === '' || !Number.isFinite(Number(value)) ? null : clamp(Number(value), 0, 100),
  ]));
  const availableSignalKeys = Object.entries(clampedSignals)
    .filter(([, value]) => value != null)
    .map(([key]) => key);
  const actualUserSignalKeys = availableSignalKeys.filter((key) => signalProvenance[key]?.actualUserData === true);
  const fallbackSignalKeys = Object.entries(signalProvenance)
    .filter(([, provenance]) => provenance.fallback === true)
    .map(([key]) => key);
  const weights = deriveWeights(habitProfile, now);
  const missingCoreSignals = [
    clampedSignals.timeOfDay == null ? 'timeOfDay' : null,
    clampedSignals.recentTrend == null ? 'recentTrend' : null,
  ].filter(Boolean);
  const fallbackGateTriggered = fallbackSignalKeys.length > 1;
  const hasCoreReadinessEvidence = missingCoreSignals.length === 0 && !fallbackGateTriggered;
  const weightedCompositeRisk = hasCoreReadinessEvidence ? weightedRisk(clampedSignals, weights) : null;
  const gateFloor = hasCoreReadinessEvidence ? riskFloorFromSignalGates(clampedSignals, habitProfile) : 0;
  const compositeRisk = weightedCompositeRisk == null && gateFloor <= 0
    ? null
    : clamp(Math.round(Math.max(weightedCompositeRisk ?? 0, gateFloor)), 0, 100);
  const riskLevel = compositeRisk >= RISK_CONSTANTS.HIGH_RISK_FLOOR
    ? 'high'
    : compositeRisk == null
      ? 'unavailable'
      : compositeRisk >= RISK_CONSTANTS.MODERATE_RISK_FLOOR
        ? 'moderate'
        : 'low';
  const availableSignals = Object.entries(clampedSignals).filter(([, value]) => value != null);
  const primaryKey = availableSignals.sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const topSignals = Object.entries(clampedSignals)
    .filter(([, value]) => value != null)
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
    readinessScore: compositeRisk == null ? null : 100 - compositeRisk,
    riskLevel,
    primaryConcern: SIGNAL_LABELS[primaryKey] || 'Insufficient readiness evidence',
    tipText: SIGNAL_TIPS[primaryKey] || 'Start only when you feel ready and GPS has a clear signal.',
    topSignals,
    signals: clampedSignals,
    habitProfile,
    dataQuality: {
      confidence: habitProfile?.confidence ?? 0,
      readinessEvidence: compositeRisk == null ? 'unavailable' : availableSignals.length >= 6 ? 'high' : availableSignals.length >= 3 ? 'developing' : 'low',
      availableSignalCount: availableSignals.length,
      actualUserSignalCount: actualUserSignalKeys.length,
      actualUserSignalKeys,
      fallbackSignalCount: fallbackSignalKeys.length,
      fallbackSignalKeys,
      fallbackGateTriggered,
      missingCoreSignals,
      signalProvenance,
      sufficientTimeData: clampedSignals.timeOfDay != null,
      sufficientDayData: clampedSignals.dayOfWeek != null,
      sufficientTrendData: clampedSignals.recentTrend != null,
      personalised: (habitProfile?.confidence ?? 0) >= 0.3,
    },
  };
}
