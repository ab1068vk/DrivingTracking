import { routeRiskCalibrationGroups } from './routeRiskGroups.js';
import {
  ROUTE_RISK_MIN_ROUTE_GROUP_COUNT,
  ROUTE_RISK_MIN_TRIP_COUNT,
} from './routeRiskConfig.js';
import {
  fitDangerZoneSaturationCount,
  fitEventDensityMaxEventsPerKm,
  fitRouteRiskEventWeight,
  fitRouteRiskHarshWeight,
} from './routeRiskFit.js';
import { routeRiskTripMetrics } from './routeRiskTripMetrics.js';
import { validateRouteRiskFit } from './routeRiskValidation.js';

export { ROUTE_RISK_MIN_ROUTE_GROUP_COUNT, ROUTE_RISK_MIN_TRIP_COUNT };

export function routeRiskCalibrationSample(trips = []) {
  const eligibleTrips = routeRiskTripMetrics(trips);
  const routeGroups = routeRiskCalibrationGroups(trips);

  return {
    eligibleTripCount: eligibleTrips.length,
    routeGroupCount: routeGroups.length,
    routeGroups,
    readyForPromotion: eligibleTrips.length >= ROUTE_RISK_MIN_TRIP_COUNT &&
      routeGroups.length >= ROUTE_RISK_MIN_ROUTE_GROUP_COUNT,
  };
}

export function fitRouteRiskConstants(trips = []) {
  const sample = routeRiskCalibrationSample(trips);
  if (!sample.routeGroups.length) {
    throw new Error('fitRouteRiskConstants requires at least one route group with 3 completed trips.');
  }

  const constants = {
    ROUTE_RISK_EVENT_WEIGHT: fitRouteRiskEventWeight(sample.routeGroups),
    ROUTE_RISK_HARSH_WEIGHT: fitRouteRiskHarshWeight(sample.routeGroups),
    EVENT_DENSITY_MAX_EVENTS_PER_KM: fitEventDensityMaxEventsPerKm(sample.routeGroups),
    DANGER_ZONE_SATURATION_COUNT: fitDangerZoneSaturationCount(sample.routeGroups),
  };

  return {
    ...constants,
    validation: validateRouteRiskFit(sample.routeGroups, constants),
  };
}
