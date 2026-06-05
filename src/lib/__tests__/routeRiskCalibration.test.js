import { describe, expect, it } from 'vitest';
import {
  ROUTE_RISK_MIN_ROUTE_GROUP_COUNT,
  ROUTE_RISK_MIN_TRIP_COUNT,
  fitRouteRiskConstants,
  routeRiskCalibrationSample,
} from '@/lib/calibrationFitting';

const baseLat = 43.65;
const baseLng = -79.38;

function routePoints(routeIndex) {
  const lat = baseLat + routeIndex * 0.01;
  return [
    { lat, lng: baseLng, speed_kmh: 40, timestamp: '2026-01-01T12:00:00.000Z' },
    { lat: lat + 0.001, lng: baseLng + 0.001, speed_kmh: 42, timestamp: '2026-01-01T12:01:00.000Z' },
  ];
}

function eventsForTrip({ eventCount = 0, harshCount = 0 } = {}) {
  return [
    ...Array.from({ length: harshCount }, () => ({
      type: 'harsh_brake',
      lat: baseLat,
      lng: baseLng,
    })),
    ...Array.from({ length: Math.max(0, eventCount - harshCount) }, () => ({
      type: 'speeding',
      lat: baseLat,
      lng: baseLng,
    })),
  ];
}

function trip(routeIndex, tripIndex, options = {}) {
  return {
    id: `route-${routeIndex}-trip-${tripIndex}`,
    status: 'completed',
    distance_km: options.distanceKm ?? 5,
    route_points: routePoints(routeIndex),
    driving_events: eventsForTrip(options),
  };
}

function repeatedRoutes(routeCount, tripsPerRoute) {
  return Array.from({ length: routeCount }, (_, routeIndex) => (
    Array.from({ length: tripsPerRoute }, (_, tripIndex) => {
      const harshRoute = routeIndex % 5 === 0;
      const activeRoute = routeIndex % 2 === 0;
      return trip(routeIndex, tripIndex, {
        eventCount: activeRoute ? 2 + (routeIndex % 4) : 1,
        harshCount: harshRoute ? 2 : 0,
      });
    })
  )).flat();
}

describe('route risk calibration', () => {
  it('requires 500 eligible trips and 50 repeated route groups for promotion readiness', () => {
    const smallSample = routeRiskCalibrationSample(repeatedRoutes(10, 3));
    const readySample = routeRiskCalibrationSample(repeatedRoutes(50, 10));

    expect(smallSample.readyForPromotion).toBe(false);
    expect(readySample).toMatchObject({
      eligibleTripCount: ROUTE_RISK_MIN_TRIP_COUNT,
      routeGroupCount: ROUTE_RISK_MIN_ROUTE_GROUP_COUNT,
      readyForPromotion: true,
    });
  });

  it('fits internal consistency constants from repeated route history', () => {
    const result = fitRouteRiskConstants(repeatedRoutes(12, 5));

    expect(result).toMatchObject({
      ROUTE_RISK_EVENT_WEIGHT: expect.any(Number),
      ROUTE_RISK_HARSH_WEIGHT: expect.any(Number),
      EVENT_DENSITY_MAX_EVENTS_PER_KM: expect.any(Number),
      DANGER_ZONE_SATURATION_COUNT: expect.any(Number),
      validation: {
        repeatedRouteConsistency: expect.any(Number),
        harshVsNormalRouteRatio: expect.any(Number),
        saturationEffectiveness: expect.any(Number),
      },
    });
    expect(result.ROUTE_RISK_EVENT_WEIGHT).toBeGreaterThan(0);
    expect(result.ROUTE_RISK_HARSH_WEIGHT).toBeGreaterThan(0);
    expect(result.EVENT_DENSITY_MAX_EVENTS_PER_KM).toBeGreaterThan(0);
    expect(result.validation.harshVsNormalRouteRatio).toBeGreaterThan(1);
  });
});
