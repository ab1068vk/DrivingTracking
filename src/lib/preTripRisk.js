import { analyzeDayOfWeek, analyzeTimeOfDay, computePersonalBaseline } from '@/lib/tripInsights';

export const PRE_TRIP_RISK_WEIGHTS = {
  timeOfDay: 0.16,
  dayOfWeek: 0.12,
  recentTrend: 0.20,
  dailyFatigue: 0.22,
  lastTripOutcome: 0.12,
  weather: 0.10,
  dangerZones: 0.08,
};

const SIGNAL_LABELS = {
  timeOfDay: 'Higher-risk time of day for you',
  dayOfWeek: 'This day of week trends lower for you',
  recentTrend: 'Your scores have been declining recently',
  dailyFatigue: 'High daily fatigue accumulation',
  lastTripOutcome: 'Low score on your last trip',
  weather: 'Weather may raise trip risk',
  dangerZones: 'Known danger zones are nearby',
};

const SIGNAL_TIPS = {
  timeOfDay: 'Drive the first few minutes deliberately and leave extra following room.',
  dayOfWeek: 'Start smooth and treat this route like a fresh baseline.',
  recentTrend: 'Pick one behaviour to protect this trip instead of fixing everything.',
  dailyFatigue: 'A short break before starting will improve alertness.',
  lastTripOutcome: 'Ease into this drive and avoid repeating the last trip pattern.',
  weather: 'Increase following distance and brake earlier than usual.',
  dangerZones: 'Start slowly and watch for the familiar risk segment.',
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

export function computePreTripRisk(trips = [], settings = {}, dailyFatigueState = null, context = {}) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const recent = last90Days(completed);
  const now = new Date();
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
  };

  const compositeRisk = Math.round(
    signals.timeOfDay * PRE_TRIP_RISK_WEIGHTS.timeOfDay +
    signals.dayOfWeek * PRE_TRIP_RISK_WEIGHTS.dayOfWeek +
    signals.recentTrend * PRE_TRIP_RISK_WEIGHTS.recentTrend +
    signals.dailyFatigue * PRE_TRIP_RISK_WEIGHTS.dailyFatigue +
    signals.lastTripOutcome * PRE_TRIP_RISK_WEIGHTS.lastTripOutcome +
    signals.weather * PRE_TRIP_RISK_WEIGHTS.weather +
    signals.dangerZones * PRE_TRIP_RISK_WEIGHTS.dangerZones
  );
  const riskLevel = compositeRisk >= 65 || (signals.dailyFatigue >= 90 && signals.lastTripOutcome >= 70)
    ? 'high'
    : compositeRisk >= 40 ? 'moderate' : 'low';
  const primaryKey = Object.entries(signals).sort((a, b) => b[1] - a[1])[0]?.[0] || 'timeOfDay';

  return {
    compositeRisk,
    readinessScore: 100 - compositeRisk,
    riskLevel,
    primaryConcern: SIGNAL_LABELS[primaryKey],
    tipText: SIGNAL_TIPS[primaryKey],
    signals,
  };
}
