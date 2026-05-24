import { checkDangerZoneProximity } from '@/lib/dangerZoneEngine';
import { getFallbackTimeRisk } from '@/lib/habitProfile';
import { clamp } from '@/lib/mathUtils';
import { isEveningRushHour, isNightRiskHour } from '@/lib/appConstants';

const ROUTE_RISK_CONSTANTS = {
  RECENT_TRIP_WINDOW: 20,
  DEFAULT_AVG_SCORE: 75,
  EVENT_DENSITY_WEIGHT: 18,
  MAX_DANGER_ZONE_RISK: 30,
  DANGER_ZONE_DECAY_COUNT: 3,
  WEATHER_WEIGHT: 0.25,
  BASELINE_SCORE_WEIGHT: 0.45,
  LATE_NIGHT_TIME_RISK: 18,
  EVENING_RUSH_TIME_RISK: 10,
  PERSONAL_TIME_RISK_SCALE: 0.18,
  FALLBACK_TIME_RISK_SCALE: 0.3,
  MIN_PERSONAL_CONFIDENCE: 0.3,
  MIN_TEXT_CONFIDENCE: 0.5,
  MIN_HOURLY_RISK_HOURS: 6,
  WINDOW_LOOKAHEAD_HOURS: 12,
  RISK_EQUIVALENT_MARGIN: 5,
  PROXIMITY_METERS: 2000,
};

function personalTimeRisk(hour, profile) {
  if (!profile || Number(profile.confidence) < ROUTE_RISK_CONSTANTS.MIN_PERSONAL_CONFIDENCE) {
    if (isNightRiskHour(hour)) return ROUTE_RISK_CONSTANTS.LATE_NIGHT_TIME_RISK;
    if (isEveningRushHour(hour)) return ROUTE_RISK_CONSTANTS.EVENING_RUSH_TIME_RISK;
    return 0;
  }

  const hourData = profile.hourlyRisk?.[hour];
  if (!hourData || hourData.tripCount < 2) {
    return clamp(Math.round(getFallbackTimeRisk(hour, profile) * ROUTE_RISK_CONSTANTS.FALLBACK_TIME_RISK_SCALE), 0, ROUTE_RISK_CONSTANTS.LATE_NIGHT_TIME_RISK);
  }

  return clamp(Math.round(hourData.riskScore * ROUTE_RISK_CONSTANTS.PERSONAL_TIME_RISK_SCALE), 0, ROUTE_RISK_CONSTANTS.LATE_NIGHT_TIME_RISK);
}

function formatHour(hour) {
  const normalized = ((Math.trunc(Number(hour) || 0) % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const displayHour = normalized % 12 || 12;
  return `${displayHour}:00 ${suffix}`;
}

function saferWindowText(currentHour, profile) {
  if (
    !profile ||
    Number(profile.confidence) < ROUTE_RISK_CONSTANTS.MIN_TEXT_CONFIDENCE ||
    Object.keys(profile.hourlyRisk || {}).length < ROUTE_RISK_CONSTANTS.MIN_HOURLY_RISK_HOURS
  ) {
    if (isNightRiskHour(currentHour)) {
      return 'Late night is higher risk. Consider waiting until daylight or after a proper rest.';
    }
    if (isEveningRushHour(currentHour)) {
      return 'After 7 PM or before rush hour';
    }
    return 'Current time looks acceptable';
  }

  const upcoming = [];
  for (let offset = 1; offset <= ROUTE_RISK_CONSTANTS.WINDOW_LOOKAHEAD_HOURS; offset++) {
    const hour = (currentHour + offset) % 24;
    const risk = profile.hourlyRisk?.[hour]?.riskScore ?? getFallbackTimeRisk(hour, profile);
    upcoming.push({ hour, risk });
  }

  upcoming.sort((a, b) => a.risk - b.risk);
  const best = upcoming[0];
  const currentRisk = profile.hourlyRisk?.[currentHour]?.riskScore ?? getFallbackTimeRisk(currentHour, profile);

  if (best.risk >= currentRisk - ROUTE_RISK_CONSTANTS.RISK_EQUIVALENT_MARGIN) {
    return 'Current time looks as good as any upcoming window for you.';
  }

  return `Based on your history, ${formatHour(best.hour)} tends to be a lower-risk window for you.`;
}

function dangerZoneRisk(zoneCount) {
  return Math.round(
    ROUTE_RISK_CONSTANTS.MAX_DANGER_ZONE_RISK *
    (1 - Math.exp(-Math.max(0, zoneCount) / ROUTE_RISK_CONSTANTS.DANGER_ZONE_DECAY_COUNT))
  );
}

function dangerZonePrimaryFactor(zoneCount) {
  if (!zoneCount) return null;
  const zoneLabel = zoneCount === 1 ? 'zone' : 'zones';
  const radiusKm = ROUTE_RISK_CONSTANTS.PROXIMITY_METERS / 1000;
  return `Known danger zones nearby (${zoneCount} ${zoneLabel} within ${radiusKm} km)`;
}

/**
 * Estimate upcoming route risk from recent driving, nearby danger zones, weather, and time.
 * @param {object} params - Route risk inputs.
 * @param {Array<object>} [params.trips] - Completed trip history.
 * @param {Array<object>} [params.dangerZones] - Learned danger-zone coordinates.
 * @param {number} [params.weatherRiskScore] - Weather risk score from 0 to 100.
 * @param {{lat:number,lng:number}|null} [params.currentLocation] - Current GPS coordinate.
 * @param {object|null} [params.habitProfile] - Optional learned profile returned by buildHabitProfile.
 * @param {Date|string|number|null} [params.now] - Optional clock for deterministic risk estimates.
 * @returns {object} Predictive route risk score, level, safer window text, and primary factor.
 * @example estimatePredictiveRouteRisk({ trips, dangerZones, habitProfile })
 */
export function estimatePredictiveRouteRisk({
  trips = [],
  dangerZones = [],
  weatherRiskScore = 0,
  currentLocation = null,
  habitProfile = null,
  now: nowInput = null,
} = {}) {
  const completed = (trips || []).filter((trip) => trip.status === 'completed');
  const sorted = [...completed].sort((a, b) => (
    new Date(b.startTime || b.start_time || 0).getTime() - new Date(a.startTime || a.start_time || 0).getTime()
  ));
  const recent = sorted.slice(0, ROUTE_RISK_CONSTANTS.RECENT_TRIP_WINDOW);
  const avgScore = recent.length
    ? recent.reduce((sum, trip) => sum + (Number(trip.score_overall ?? trip.score) || 0), 0) / recent.length
    : ROUTE_RISK_CONSTANTS.DEFAULT_AVG_SCORE;
  const eventDensity = recent.reduce((sum, trip) => {
    const events = (Number(trip.harsh_brakes_count) || 0) +
      (Number(trip.speeding_events_count) || 0) +
      (Number(trip.near_miss_count) || 0) * 2 +
      (Number(trip.sharp_turns_count) || 0);
    return sum + events / Math.max(1, Number(trip.distance_km) || 1);
  }, 0) / Math.max(1, recent.length);
  const nearbyZones = currentLocation
    ? checkDangerZoneProximity(currentLocation.lat, currentLocation.lng, dangerZones, ROUTE_RISK_CONSTANTS.PROXIMITY_METERS)
    : [];
  const now = nowInput instanceof Date
    ? nowInput
    : nowInput != null
      ? new Date(nowInput)
      : new Date();
  const hour = now.getHours();
  const timeRisk = personalTimeRisk(hour, habitProfile);
  const zoneRisk = dangerZoneRisk(nearbyZones.length);
  const riskScore = clamp(Math.round(
    (100 - avgScore) * ROUTE_RISK_CONSTANTS.BASELINE_SCORE_WEIGHT +
    eventDensity * ROUTE_RISK_CONSTANTS.EVENT_DENSITY_WEIGHT +
    zoneRisk +
    Number(weatherRiskScore || 0) * ROUTE_RISK_CONSTANTS.WEATHER_WEIGHT +
    timeRisk
  ), 0, 100);

  return {
    riskScore,
    riskLevel: riskScore >= 65 ? 'high' : riskScore >= 40 ? 'moderate' : 'low',
    safestWindow: saferWindowText(hour, habitProfile),
    nearbyDangerZoneCount: nearbyZones.length,
    dangerZoneRisk: zoneRisk,
    primaryFactor: nearbyZones.length
      ? dangerZonePrimaryFactor(nearbyZones.length)
      : weatherRiskScore >= 40
        ? 'Weather risk'
        : eventDensity >= 0.6
          ? 'Recent route event density'
          : 'Personal baseline',
  };
}
