export const LOCAL_TEST_TRIP_PREFIX = 'feature_test_trip_';

const TEST_TRIP_ROUTES = [
  { name: '[Test] Morning Commute', tags: ['commute', 'city'], daysAgo: 0, hour: 8, start: [43.6502, -79.3921], step: [0.00078, 0.00118], speedKmh: 43 },
  { name: '[Test] Afternoon Errand', tags: ['errand', 'city'], daysAgo: 1, hour: 15, start: [43.6611, -79.4074], step: [-0.00072, 0.00124], speedKmh: 39 },
  { name: '[Test] Evening Commute', tags: ['commute', 'city'], daysAgo: 2, hour: 18, start: [43.6852, -79.3994], step: [-0.0008, -0.00116], speedKmh: 41 },
  { name: '[Test] Highway Eastbound', tags: ['highway'], daysAgo: 3, hour: 10, start: [43.6516, -79.5281], step: [0.00034, 0.00242], speedKmh: 84 },
  { name: '[Test] Rainy Evening', tags: ['commute', 'rain'], daysAgo: 4, hour: 19, start: [43.7074, -79.4181], step: [-0.00081, 0.0011], speedKmh: 37 },
  { name: '[Test] Weekend Practice', tags: ['practice', 'city'], daysAgo: 6, hour: 11, start: [43.6392, -79.4179], step: [0.00092, 0.00102], speedKmh: 36 },
  { name: '[Test] Night Return', tags: ['night', 'city'], daysAgo: 7, hour: 23, start: [43.7004, -79.4022], step: [-0.00076, -0.0012], speedKmh: 42 },
  { name: '[Test] Highway Westbound', tags: ['highway'], daysAgo: 9, hour: 16, start: [43.6558, -79.3124], step: [0.00026, -0.0025], speedKmh: 88 },
  { name: '[Test] Downtown Errand', tags: ['errand', 'city'], daysAgo: 10, hour: 12, start: [43.6441, -79.3747], step: [0.00088, -0.00108], speedKmh: 34 },
  { name: '[Test] Morning Commute Repeat', tags: ['commute', 'city'], daysAgo: 12, hour: 8, start: [43.6504, -79.392], step: [0.00079, 0.00117], speedKmh: 45 },
  { name: '[Test] Highway Connector', tags: ['highway'], daysAgo: 14, hour: 14, start: [43.6912, -79.489], step: [-0.00022, 0.00238], speedKmh: 81 },
  { name: '[Test] Late Shift Return', tags: ['night', 'commute'], daysAgo: 16, hour: 22, start: [43.6774, -79.3652], step: [-0.00084, -0.00115], speedKmh: 40 },
];

const TEST_POINT_COUNT = 38;
const POINT_INTERVAL_MS = 10 * 1000;

function tripStartTime(now, route) {
  const timestamp = new Date(now);
  timestamp.setDate(timestamp.getDate() - route.daysAgo);
  timestamp.setHours(route.hour, 10, 0, 0);
  return timestamp;
}

function buildRoutePoints(route, startTime) {
  return Array.from({ length: TEST_POINT_COUNT }, (_, index) => {
    const curve = Math.sin((index / (TEST_POINT_COUNT - 1)) * Math.PI) * 0.00045;
    const cruisingSpeed = route.speedKmh + Math.round(Math.sin(index * 0.75) * 4);

    return {
      lat: Number((route.start[0] + route.step[0] * index + curve).toFixed(6)),
      lng: Number((route.start[1] + route.step[1] * index - curve * 0.4).toFixed(6)),
      speed_kmh: index === 0 ? 8 : index === TEST_POINT_COUNT - 1 ? 5 : Math.max(18, cruisingSpeed),
      accuracy: 6,
      altitude: Number((84 + Math.sin(index * 0.22) * 2).toFixed(1)),
      altitude_accuracy: 5,
      timestamp: new Date(startTime.getTime() + index * POINT_INTERVAL_MS).toISOString(),
    };
  });
}

export function buildLocalFeatureTestTrips(now = new Date()) {
  return TEST_TRIP_ROUTES.map((route, index) => {
    const startTime = tripStartTime(now, route);
    const routePoints = buildRoutePoints(route, startTime);

    return {
      id: `${LOCAL_TEST_TRIP_PREFIX}${String(index + 1).padStart(2, '0')}`,
      status: 'completed',
      nickname: route.name,
      notes: 'Synthetic local feature-test trip. Remove from Tracking Diagnostics when testing is complete.',
      tags: route.tags,
      tag: route.tags[0],
      test_fixture: true,
      test_fixture_suite: 'feature_testing',
      start_time: routePoints[0].timestamp,
      end_time: routePoints[routePoints.length - 1].timestamp,
      route_points: routePoints,
      route_points_raw_count: routePoints.length,
      route_points_map_count: routePoints.length,
      needs_rescore: true,
      schema_version: 0,
    };
  });
}
