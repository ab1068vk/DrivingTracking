import { analyzeDayOfWeek, analyzeTimeOfDay, computePersonalBaseline } from '@/lib/tripInsights';

export const PRE_TRIP_RISK_WEIGHTS = {
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

const last90Days = (trips = []) => {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return trips.filter((trip) => new Date(trip.start_time || 0).getTime() >= cutoff);
};

const currentBucketLabel = (hour) => {
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 22) return 'Evening';
  return 'Night';
};

const fallbackTimeRisk = (hour) => {
  if (hour >= 22 || hour < 5) return 60;
  if (hour >= 7 && hour <= 9) return 35;
  if (hour >= 16 && hour <= 18) return 40;
  return 20;
};

const routeRiskFromContext = (context = {}) => {
  const directScore = Number(context.routeRiskScore ?? context.predictiveRouteRisk?.riskScore);
  if (Number.isFinite(directScore)) return Math.max(0, Math.min(100, directScore));

  const level = context.routeRiskLevel || context.predictiveRouteRisk?.riskLevel;
  if (level === 'high') return 75;
  if (level === 'moderate') return 45;
  if (level === 'low') return 15;
  return 0;
};

const recentRestRisk = (lastTrip, nowMs) => {
  if (!lastTrip) return 10;
  const endMs = new Date(lastTrip.end_time || lastTrip.start_time || 0).getTime();
  if (!Number.isFinite(endMs) || endMs <= 0 || endMs > nowMs) return 10;

  const minutesSinceLastTrip = (nowMs - endMs) / 60000;
  if (minutesSinceLastTrip < 15) return 80;
  if (minutesSinceLastTrip < 30) return 60;
  if (minutesSinceLastTrip < 60) return 35;
  return 5;
};

export function computePreTripRisk(trips = [], settings = {}, dailyFatigueState = null, context = {}) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const recent = last90Days(completed);
  const now = new Date();
  const nowMs = now.getTime();
  const timeData = analyzeTimeOfDay(recent);
  const dayData = analyzeDayOfWeek(recent);
  const timeBucket = timeData.find((bucket) => bucket.label === currentBucketLabel(now.getHours()));
  const dayEntry = dayData[now.getDay()];
  const baseline = computePersonalBaseline(recent);
  const sorted = [...completed].sort((a, b) => (
    new Date(b.end_time || b.start_time || 0).getTime() -
    new Date(a.end_time || a.start_time || 0).getTime()
  ));
  const lastTrip = sorted[0] || null;

  const signals = {
    timeOfDay: timeBucket?.avgScore != null ? Math.max(0, 100 - timeBucket.avgScore) : fallbackTimeRisk(now.getHours()),
    dayOfWeek: dayEntry?.avgScore != null ? Math.max(0, 100 - dayEntry.avgScore) : 25,
    recentTrend: baseline.trend === 'declining' ? 65 : baseline.trend === 'improving' ? 10 : 30,
    dailyFatigue: dailyFatigueState
      ? dailyFatigueState.fatigueLevel === 'critical'
        ? 90
        : dailyFatigueState.fatigueLevel === 'high'
          ? 70
          : dailyFatigueState.fatigueLevel === 'moderate'
            ? 40
            : 10
      : 20,
    lastTripOutcome: lastTrip ? Math.max(0, 100 - (lastTrip.score_overall ?? lastTrip.overall_score ?? 50)) : 25,
    weather: Number(context.weatherRiskScore) || Number(context.weather_context?.riskScore) || 0,
    dangerZones: Math.min(100, (Number(context.nearbyDangerZoneCount) || 0) * 35),
    routeForecast: routeRiskFromContext(context),
    recentRest: recentRestRisk(lastTrip, nowMs),
  };

  const compositeRisk = Math.round(
    signals.timeOfDay * PRE_TRIP_RISK_WEIGHTS.timeOfDay +
    signals.dayOfWeek * PRE_TRIP_RISK_WEIGHTS.dayOfWeek +
    signals.recentTrend * PRE_TRIP_RISK_WEIGHTS.recentTrend +
    signals.dailyFatigue * PRE_TRIP_RISK_WEIGHTS.dailyFatigue +
    signals.lastTripOutcome * PRE_TRIP_RISK_WEIGHTS.lastTripOutcome +
    signals.weather * PRE_TRIP_RISK_WEIGHTS.weather +
    signals.dangerZones * PRE_TRIP_RISK_WEIGHTS.dangerZones +
    signals.routeForecast * PRE_TRIP_RISK_WEIGHTS.routeForecast +
    signals.recentRest * PRE_TRIP_RISK_WEIGHTS.recentRest
  );
  const riskLevel = compositeRisk >= 65 || (signals.dailyFatigue >= 90 && signals.lastTripOutcome >= 70)
    ? 'high'
    : compositeRisk >= 40 ? 'moderate' : 'low';
  const primaryKey = Object.entries(signals).sort((a, b) => b[1] - a[1])[0]?.[0] || 'timeOfDay';
  const topSignals = Object.entries(signals)
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
    signals,
  };
}
