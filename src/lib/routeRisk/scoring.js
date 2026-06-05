import {
  ROUTE_RISK_CONSTANTS,
  SPEED_RISK_FULL_KMH,
  SPEED_RISK_MAX_POINTS,
  SPEED_RISK_START_KMH,
} from '@/lib/routeRisk/constants';

export const speedRiskBonus = (avgSpeedKmh = 0) => {
  const speed = Number(avgSpeedKmh) || 0;
  if (speed <= SPEED_RISK_START_KMH) return 0;
  const ratio = Math.min(1, (speed - SPEED_RISK_START_KMH) / (SPEED_RISK_FULL_KMH - SPEED_RISK_START_KMH));
  return Math.round(ratio * SPEED_RISK_MAX_POINTS);
};

export const riskLevelForScore = (riskScore = 0) => {
  const score = Number(riskScore) || 0;
  if (score >= 60) return 'high';
  if (score >= 30) return 'moderate';
  return 'low';
};

export const scoreRouteRiskCell = (cell = {}) => {
  const tripCount = Math.max(1, Number(cell.tripCount) || 0);
  const avgSpeed = cell.tripCount ? (Number(cell.speedSum) || 0) / cell.tripCount : 0;
  const eventRate = (Number(cell.totalEvents) || 0) / tripCount;
  const harshRate = (Number(cell.harshCount) || 0) / tripCount;
  const riskScore = Math.min(100, Math.round(
    eventRate * ROUTE_RISK_CONSTANTS.ROUTE_RISK_EVENT_WEIGHT +
    harshRate * ROUTE_RISK_CONSTANTS.ROUTE_RISK_HARSH_WEIGHT +
    speedRiskBonus(avgSpeed)
  ));

  return {
    ...cell,
    avgSpeed,
    riskScore,
    riskLevel: riskLevelForScore(riskScore),
  };
};

export const dominantEventType = (eventTypes = {}) => (
  Object.entries(eventTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || null
);
