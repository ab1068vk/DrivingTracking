import { clamp, percentile, round } from './numberUtils.js';
import {
  ELEVATED_ROUTE_RISK_SCORE,
  HARSH_EVENT_RATIO_THRESHOLD,
  HARSH_ROUTE_SCORE_LIFT,
} from './routeRiskConfig.js';

function safeRate(value, fallback = 1) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

export function fitRouteRiskEventWeight(routeGroups) {
  const p90 = percentile(routeGroups.map((group) => group.meanEventRatePerKm), 0.9, 1);
  return round(clamp(ELEVATED_ROUTE_RISK_SCORE / safeRate(p90), 1, 250), 2);
}

export function fitRouteRiskHarshWeight(routeGroups) {
  const harshGroups = routeGroups.filter((group) => group.harshEventRatio > HARSH_EVENT_RATIO_THRESHOLD);
  const referenceRate = percentile(
    (harshGroups.length ? harshGroups : routeGroups).map((group) => group.meanEventRatePerKm),
    0.5,
    1
  );

  return round(clamp(
    HARSH_ROUTE_SCORE_LIFT / (safeRate(referenceRate) * HARSH_EVENT_RATIO_THRESHOLD),
    1,
    250
  ), 2);
}

export function fitEventDensityMaxEventsPerKm(routeGroups) {
  const rates = routeGroups.flatMap((group) => group.trips.map((trip) => trip.eventRatePerKm));
  return round(clamp(percentile(rates, 0.95, 5), 0.1, 100), 2);
}

export function fitDangerZoneSaturationCount(routeGroups) {
  const eventBearingGroups = routeGroups
    .map((group) => group.trips.filter((trip) => trip.eventCount > 0).length)
    .filter((count) => count > 0);
  return Math.max(1, Math.round(percentile(eventBearingGroups, 0.95, 5)));
}

export function routeRiskScoreForGroup(group, constants) {
  return clamp(
    group.meanEventRatePerKm * constants.ROUTE_RISK_EVENT_WEIGHT +
    group.meanHarshEventRatePerKm * constants.ROUTE_RISK_HARSH_WEIGHT,
    0,
    100
  );
}
