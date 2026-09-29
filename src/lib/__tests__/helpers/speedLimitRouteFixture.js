/**
 * DPD-044 — a deterministic long route for the speed-limit review.
 *
 * Points advance ~35 m apart along a gently turning path, so a precision-7
 * geohash cell holds a handful of consecutive points and a long route crosses
 * hundreds of cells — the shape that made the review O(points × cells). Road
 * names change every ~60 points, most points carry a reviewable estimate (so
 * nearly every cell needs a decision), some carry a posted limit, and the route
 * includes privacy-masked points, repeated coordinates (GPS jitter) and a
 * return leg that revisits earlier cells (overlapping sections).
 */
const ROADS = ['King St W', 'Spadina Ave', 'Queen St W', 'Bathurst St', 'Dundas St W', 'Lake Shore Blvd'];

export function buildSpeedLimitRoute(pointCount, { seed = 1, start = Date.UTC(2026, 3, 2, 12) } = {}) {
  const points = [];
  let lat = 43.64 + (seed % 7) * 0.001;
  let lng = -79.40 - (seed % 5) * 0.001;
  let heading = 0.3;
  const half = Math.floor(pointCount * 0.8);
  for (let index = 0; index < pointCount; index += 1) {
    if (index < half) {
      heading += Math.sin(index / 37 + seed) * 0.02;
      lat += Math.cos(heading) * 0.00032;
      lng += Math.sin(heading) * 0.00045;
    } else {
      // Return leg over earlier ground: revisits cells already driven.
      const back = points[Math.max(0, half - 1 - (index - half) * 2)];
      lat = back.lat + 0.00003;
      lng = back.lng - 0.00003;
    }
    const road = ROADS[Math.floor(index / 60) % ROADS.length];
    const point = {
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      timestamp: start + index * 1000,
      speed_limit_road_name: index % 97 === 13 ? '' : road,
      // Posted limits only on occasional stretches: most cells need a decision, as on the A54 routes.
      speed_limit_source: Math.floor(index / 300) % 5 === 0 ? 'openstreetmap' : 'region_default_estimate',
      speed_limit_kmh: 40 + (Math.floor(index / 60) % 4) * 10,
    };
    if (index % 331 === 7) point.masked_for_privacy = true;
    if (index % 53 === 5 && index > 0) {
      point.lat = points[index - 1].lat;
      point.lng = points[index - 1].lng;
    }
    points.push(point);
  }
  return {
    id: `route-${pointCount}-${seed}`,
    status: 'completed',
    start_time: new Date(start).toISOString(),
    end_time: new Date(start + pointCount * 1000).toISOString(),
    trip_utc_offset_minutes: -240,
    route_points: points,
  };
}
