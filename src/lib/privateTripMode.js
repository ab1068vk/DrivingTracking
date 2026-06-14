import { haversineDistance } from '@/lib/tripEngine';

export const PRIVATE_TRIP_MODE = 'summary_only';

const finiteNumber = (value, fallback = 0) => {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const pointTimestampMs = (point) => {
  const timestamp = new Date(point?.timestamp ?? point?.time ?? Date.now()).getTime();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
};

export function isPrivateTrip(trip) {
  return trip?.privacy_mode === PRIVATE_TRIP_MODE;
}

export function createPrivateTripRuntime(summary = {}) {
  return {
    lastPoint: null,
    recentPoints: [],
    distanceM: Math.max(0, finiteNumber(summary.distance_m)),
    speedSampleSumKmh: Math.max(0, finiteNumber(summary.speed_sample_sum_kmh)),
    speedSampleCount: Math.max(0, Math.round(finiteNumber(summary.speed_sample_count))),
    runningSpeedSumKmh: Math.max(0, finiteNumber(summary.running_speed_sum_kmh)),
    runningSpeedSampleCount: Math.max(0, Math.round(finiteNumber(summary.running_speed_sample_count))),
    maxSpeedKmh: Math.max(0, finiteNumber(summary.max_speed_kmh)),
    pointCount: Math.max(0, Math.round(finiteNumber(summary.gps_points_processed))),
  };
}

export function processPrivateTripPoint(runtime, point, startTime) {
  const session = runtime || createPrivateTripRuntime();
  const lat = finiteNumber(point?.lat ?? point?.latitude, null);
  const lng = finiteNumber(point?.lng ?? point?.longitude, null);
  const timestampMs = pointTimestampMs(point);
  const speedKmh = Math.max(0, finiteNumber(point?.speed_kmh ?? point?.speedKmh));

  if (lat != null && lng != null) {
    if (session.lastPoint) {
      session.distanceM += haversineDistance(
        session.lastPoint.lat,
        session.lastPoint.lng,
        lat,
        lng
      ) * 1000;
    }
    const volatilePoint = { lat, lng, timestamp: new Date(timestampMs).toISOString() };
    session.lastPoint = volatilePoint;
    session.recentPoints.push(volatilePoint);
    session.recentPoints = session.recentPoints.filter((item) => (
      new Date(item.timestamp).getTime() >= timestampMs - 10 * 60 * 1000
    )).slice(-600);
  }

  session.speedSampleSumKmh += speedKmh;
  session.speedSampleCount += 1;
  session.maxSpeedKmh = Math.max(session.maxSpeedKmh, speedKmh);
  if (speedKmh >= 2) {
    session.runningSpeedSumKmh += speedKmh;
    session.runningSpeedSampleCount += 1;
  }
  session.pointCount += 1;

  const startMs = new Date(startTime).getTime();
  const durationSeconds = Number.isFinite(startMs)
    ? Math.max(0, Math.round((timestampMs - startMs) / 1000))
    : 0;

  return {
    distance_m: Math.round(session.distanceM * 10) / 10,
    duration_seconds: durationSeconds,
    avg_speed_kmh: durationSeconds > 0
      ? Math.round((session.distanceM / durationSeconds) * 3.6 * 10) / 10
      : 0,
    avg_running_speed_kmh: session.runningSpeedSampleCount > 0
      ? Math.round((session.runningSpeedSumKmh / session.runningSpeedSampleCount) * 10) / 10
      : 0,
    max_speed_kmh: Math.round(session.maxSpeedKmh * 10) / 10,
    speed_sample_sum_kmh: Math.round(session.speedSampleSumKmh * 10) / 10,
    speed_sample_count: session.speedSampleCount,
    running_speed_sum_kmh: Math.round(session.runningSpeedSumKmh * 10) / 10,
    running_speed_sample_count: session.runningSpeedSampleCount,
    gps_points_processed: session.pointCount,
    gps_points_stored: 0,
  };
}

export function buildPrivateTripRecord(trip, endTime = new Date().toISOString()) {
  const summary = trip?.private_trip_summary || {};
  const startMs = new Date(trip?.start_time).getTime();
  const endMs = new Date(endTime).getTime();
  const durationSeconds = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 1000))
    : Math.max(0, finiteNumber(summary.duration_seconds));
  const distanceM = Math.max(0, finiteNumber(summary.distance_m));
  const distanceKm = Math.round(distanceM) / 1000;
  const avgSpeedKmh = durationSeconds > 0
    ? Math.round((distanceM / durationSeconds) * 3.6 * 10) / 10
    : 0;

  return {
    start_time: trip.start_time,
    end_time: endTime,
    duration_seconds: durationSeconds,
    wall_clock_duration_seconds: durationSeconds,
    gap_seconds: 0,
    distance_km: distanceKm,
    avg_speed_kmh: avgSpeedKmh,
    avg_running_speed_kmh: Math.max(0, finiteNumber(summary.avg_running_speed_kmh)),
    max_speed_kmh: Math.max(0, finiteNumber(summary.max_speed_kmh)),
    idle_time_seconds: null,
    route_points: [],
    route_points_raw_count: 0,
    route_points_map_count: 0,
    driving_events: [],
    privacy_mode: PRIVATE_TRIP_MODE,
    private_trip_summary: {
      distance_m: Math.round(distanceM * 10) / 10,
      duration_seconds: durationSeconds,
      avg_speed_kmh: avgSpeedKmh,
      avg_running_speed_kmh: Math.max(0, finiteNumber(summary.avg_running_speed_kmh)),
      max_speed_kmh: Math.max(0, finiteNumber(summary.max_speed_kmh)),
      gps_points_processed: Math.max(0, Math.round(finiteNumber(summary.gps_points_processed))),
      gps_points_stored: 0,
    },
    score_overall: null,
    score_safety: null,
    score_smoothness: null,
    score_eco: null,
    score_confidence_label: 'unavailable',
    score_safety_confidence: 'unavailable',
    score_smoothness_confidence: 'unavailable',
    score_eco_confidence: 'unavailable',
    score_status: 'unavailable_private_trip',
    needs_rescore: false,
    harsh_brakes_count: 0,
    rapid_accel_count: 0,
    sharp_turns_count: 0,
    speeding_events_count: 0,
    weather_context: null,
    weather_skipped_reason: 'private_trip',
    speed_limit_context: {
      provider: 'openstreetmap_overpass',
      status: 'skipped_private_trip',
      coverage: 0,
      source: null,
      fallback_country: null,
      error: null,
    },
    map_matching_context: {
      provider: 'osrm',
      status: 'skipped_private_trip',
      confidence: null,
      snapped_coverage: 0,
      isOsrmDemoUrl: false,
    },
    data_quality_flags: Array.from(new Set([
      ...(Array.isArray(trip.data_quality_flags) ? trip.data_quality_flags : []),
      'summary_only_private_trip',
    ])),
    score_confidence_flag: 'private_trip_no_route',
    status: 'completed',
    trip_state: 'saved',
    background_tracking: trip.background_tracking === true,
    start_source: trip.start_source || 'manual',
    tracking_timeline: Array.isArray(trip.timeline) ? trip.timeline : [],
  };
}
