import { finiteNumber } from './numberUtils.js';
import {
  ROUTE_RISK_EVENT_TYPES,
  ROUTE_RISK_EXCLUDED_EVENT_TYPES,
  ROUTE_RISK_HARSH_EVENT_TYPES,
} from './routeRiskConfig.js';

const eventTypes = new Set(ROUTE_RISK_EVENT_TYPES);
const excludedEventTypes = new Set(ROUTE_RISK_EXCLUDED_EVENT_TYPES);
const harshEventTypes = new Set(ROUTE_RISK_HARSH_EVENT_TYPES);

function routePoints(trip = {}) {
  return (Array.isArray(trip.route_points) ? trip.route_points : [])
    .map((point) => ({
      lat: finiteNumber(point?.lat ?? point?.coords?.latitude),
      lng: finiteNumber(point?.lng ?? point?.coords?.longitude),
    }))
    .filter((point) => point.lat != null && point.lng != null);
}

function centroid(points = []) {
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

function countedEvents(trip = {}) {
  return (Array.isArray(trip.driving_events) ? trip.driving_events : [])
    .filter((event) => event?.diagnostic_only !== true)
    .filter((event) => !excludedEventTypes.has(event?.type))
    .filter((event) => eventTypes.has(event?.type));
}

function fallbackEventCount(trip = {}) {
  return Math.max(0,
    finiteNumber(trip.harsh_brakes_count, 0) +
    finiteNumber(trip.rapid_accel_count, 0) +
    finiteNumber(trip.sharp_turns_count, 0) +
    finiteNumber(trip.speeding_events_count, 0)
  );
}

function fallbackHarshCount(trip = {}) {
  return Math.max(0, finiteNumber(trip.harsh_brakes_count, 0));
}

function eventCounts(trip = {}) {
  const events = countedEvents(trip);
  if (events.length > 0) {
    return {
      eventCount: events.length,
      harshCount: events.filter((event) => harshEventTypes.has(event?.type)).length,
    };
  }

  return {
    eventCount: fallbackEventCount(trip),
    harshCount: fallbackHarshCount(trip),
  };
}

export function routeRiskTripMetric(trip = {}) {
  if (trip?.status && trip.status !== 'completed') return null;

  const points = routePoints(trip);
  const center = centroid(points);
  const distanceKm = Math.max(0, finiteNumber(trip.distance_km, 0));
  if (!center || distanceKm <= 0) return null;

  const { eventCount, harshCount } = eventCounts(trip);
  const eventRatePerKm = eventCount / distanceKm;

  return {
    trip,
    center,
    distanceKm,
    eventCount,
    harshCount,
    eventRatePerKm,
    harshEventRatePerKm: harshCount / distanceKm,
    harshEventRatio: eventCount > 0 ? harshCount / eventCount : 0,
  };
}

export function routeRiskTripMetrics(trips = []) {
  return (Array.isArray(trips) ? trips : [])
    .map(routeRiskTripMetric)
    .filter(Boolean);
}
