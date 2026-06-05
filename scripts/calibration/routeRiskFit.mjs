import {
  ROUTE_RISK_MIN_ROUTE_GROUP_COUNT,
  ROUTE_RISK_MIN_TRIP_COUNT,
  fitRouteRiskConstants,
  routeRiskCalibrationSample,
} from '../../src/lib/calibrationFitting.js';
import { ROUTE_RISK_PROMOTABLE_CONSTANT_KEYS } from './currentConstants.mjs';

const resultToScoringConstants = (routeRiskFit) => ({
  ROUTE_RISK_EVENT_WEIGHT: routeRiskFit.ROUTE_RISK_EVENT_WEIGHT,
  ROUTE_RISK_HARSH_WEIGHT: routeRiskFit.ROUTE_RISK_HARSH_WEIGHT,
  PREDICTIVE_EVENT_DENSITY_MAX_PER_KM: routeRiskFit.EVENT_DENSITY_MAX_EVENTS_PER_KM,
  PREDICTIVE_DANGER_ZONE_SATURATION_COUNT: routeRiskFit.DANGER_ZONE_SATURATION_COUNT,
});

function mergeRouteRiskFit(result, routeRiskFit, sample) {
  return {
    ...result,
    constants: {
      ...result.constants,
      ...resultToScoringConstants(routeRiskFit),
    },
    fittedConstantKeys: [
      ...(result.fittedConstantKeys || ['PENALTY_SCALE_FACTOR']),
      ...ROUTE_RISK_PROMOTABLE_CONSTANT_KEYS,
    ],
    routeRiskCalibration: {
      status: 'refitted',
      eligibleTripCount: sample.eligibleTripCount,
      routeGroupCount: sample.routeGroupCount,
      constants: resultToScoringConstants(routeRiskFit),
      validation: routeRiskFit.validation,
    },
  };
}

function mergeInsufficientRouteRiskSample(result, sample) {
  return {
    ...result,
    routeRiskCalibration: {
      status: 'insufficient_sample',
      eligibleTripCount: sample.eligibleTripCount,
      routeGroupCount: sample.routeGroupCount,
      minTripCount: ROUTE_RISK_MIN_TRIP_COUNT,
      minRouteGroupCount: ROUTE_RISK_MIN_ROUTE_GROUP_COUNT,
      note: `Route risk constants not refitted — need ${ROUTE_RISK_MIN_TRIP_COUNT} eligible trips and ${ROUTE_RISK_MIN_ROUTE_GROUP_COUNT} route groups, have ${sample.eligibleTripCount} trips and ${sample.routeGroupCount} route groups.`,
    },
  };
}

export function attachRouteRiskCalibration(result, trips) {
  const sample = routeRiskCalibrationSample(trips);
  if (!sample.readyForPromotion) {
    return mergeInsufficientRouteRiskSample(result, sample);
  }

  return mergeRouteRiskFit(result, fitRouteRiskConstants(trips), sample);
}
