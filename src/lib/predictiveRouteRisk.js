import { checkDangerZoneProximity } from '@/lib/dangerZoneEngine';

export function estimatePredictiveRouteRisk({ trips = [], dangerZones = [], weatherRiskScore = 0, currentLocation = null } = {}) {
  const completed = (trips || []).filter((trip) => trip.status === 'completed');
  const recent = completed.slice(0, 20);
  const avgScore = recent.length
    ? recent.reduce((sum, trip) => sum + (Number(trip.score_overall) || 0), 0) / recent.length
    : 75;
  const eventDensity = recent.reduce((sum, trip) => {
    const events = (Number(trip.harsh_brakes_count) || 0) +
      (Number(trip.speeding_events_count) || 0) +
      (Number(trip.near_miss_count) || 0) * 2 +
      (Number(trip.sharp_turns_count) || 0);
    return sum + events / Math.max(1, Number(trip.distance_km) || 1);
  }, 0) / Math.max(1, recent.length);
  const nearbyZones = currentLocation
    ? checkDangerZoneProximity(currentLocation.lat, currentLocation.lng, dangerZones, 2000)
    : [];
  const hour = new Date().getHours();
  const timeRisk = hour >= 22 || hour < 5 ? 18 : hour >= 16 && hour <= 18 ? 10 : 0;
  const riskScore = Math.max(0, Math.min(100, Math.round(
    (100 - avgScore) * 0.45 +
    eventDensity * 18 +
    nearbyZones.length * 10 +
    Number(weatherRiskScore || 0) * 0.25 +
    timeRisk
  )));

  return {
    riskScore,
    riskLevel: riskScore >= 65 ? 'high' : riskScore >= 40 ? 'moderate' : 'low',
    safestWindow: hour >= 16 && hour <= 18 ? 'After 7 PM or before rush hour' : 'Current time looks acceptable',
    nearbyDangerZoneCount: nearbyZones.length,
    primaryFactor: nearbyZones.length
      ? 'Known danger zones nearby'
      : weatherRiskScore >= 40
        ? 'Weather risk'
        : eventDensity >= 0.6
          ? 'Recent route event density'
          : 'Personal baseline',
  };
}
