const finite = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const timestampMs = (value) => {
  if (value == null || value === '') return null;
  const numeric = finite(value);
  if (numeric != null && numeric > 10_000_000_000) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const pointTimestamp = (point = {}) => timestampMs(
  point.timestamp ?? point.timestamp_ms ?? point.timestampMs ?? point.time
);

const pointSpeed = (point = {}) => {
  const kmh = finite(point.speed_kmh ?? point.speedKmh ?? point.obd_speed_kmh);
  if (kmh != null) return Math.max(0, kmh);
  const metersPerSecond = finite(point.speed);
  return metersPerSecond == null ? null : Math.max(0, metersPerSecond * 3.6);
};

const privacyMasked = (point = {}) => point.masked_for_privacy === true ||
  point.privacy_gap === true || point.privacy_boundary === true ||
  point.privacy_live_redacted === true || point.privacy_purged === true;

const validCoordinate = (point = {}) => finite(point.lat) != null && finite(point.lng) != null && !privacyMasked(point);

const haversineKm = (first, second) => {
  const lat1 = finite(first?.lat);
  const lng1 = finite(first?.lng);
  const lat2 = finite(second?.lat);
  const lng2 = finite(second?.lng);
  if ([lat1, lng1, lat2, lng2].some((value) => value == null)) return 0;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const routeDistanceKm = (points = []) => points.reduce((total, point, index) => {
  const previous = points[index - 1];
  if (!previous || !validCoordinate(previous) || !validCoordinate(point)) return total;
  const previousTime = pointTimestamp(previous);
  const currentTime = pointTimestamp(point);
  if (previousTime != null && currentTime != null && currentTime - previousTime > 120_000) return total;
  return total + haversineKm(previous, point);
}, 0);

const normalizedEvents = (trip = {}) => {
  const source = Array.isArray(trip.live_events)
    ? trip.live_events
    : Array.isArray(trip.driving_events)
      ? trip.driving_events
      : [];
  return source.map((event, index) => ({
    id: String(event?.id || `live-event-${index}`),
    type: String(event?.type || 'observation'),
    title: String(event?.title || event?.label || event?.type || 'Observation recorded').replace(/_/g, ' '),
    timestamp: event?.timestamp || event?.recorded_at || null,
    value: finite(event?.value),
    unit: event?.unit ? String(event.unit) : null,
    speedKmh: finite(event?.speed_kmh),
  })).sort((a, b) => (timestampMs(b.timestamp) || 0) - (timestampMs(a.timestamp) || 0));
};

const gpsQuality = ({ fixReady, permissionLoss, accuracyM, fixAgeSeconds }) => {
  if (permissionLoss) return { key: 'lost', label: 'GPS permission lost', tone: 'error' };
  if (!fixReady) return { key: 'settling', label: 'GPS settling', tone: 'warn' };
  if (fixAgeSeconds != null && fixAgeSeconds > 15) return { key: 'stale', label: 'GPS fix stale', tone: 'error' };
  if (accuracyM == null) return { key: 'available', label: 'GPS fix available', tone: 'neutral' };
  if (accuracyM <= 15) return { key: 'strong', label: `GPS ±${Math.round(accuracyM)} m`, tone: 'good' };
  if (accuracyM <= 35) return { key: 'fair', label: `GPS ±${Math.round(accuracyM)} m`, tone: 'warn' };
  return { key: 'weak', label: `GPS weak ±${Math.round(accuracyM)} m`, tone: 'error' };
};

export function formatLiveDuration(seconds) {
  const safe = Math.max(0, Math.floor(finite(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

export function buildLiveTrackingSnapshot(trip = {}, nowMs = Date.now()) {
  const route = Array.isArray(trip.route_preview) && trip.route_preview.length
    ? trip.route_preview
    : Array.isArray(trip.route_points)
      ? trip.route_points
      : [];
  const latestPoint = [...route].reverse().find((point) => point && !privacyMasked(point)) || route[route.length - 1] || null;
  const startMs = timestampMs(trip.start_time ?? trip.start_time_ms);
  const reportedDuration = finite(trip.duration_seconds);
  const liveDuration = startMs == null ? 0 : Math.max(0, (nowMs - startMs) / 1000);
  const durationSeconds = Math.max(0, reportedDuration || 0, liveDuration);
  const reportedDistance = finite(trip.distance_km);
  const distanceKm = Math.max(0, reportedDistance ?? routeDistanceKm(route));
  const currentSpeedKmh = finite(trip.speed_kmh) ?? pointSpeed(latestPoint);
  const speedSamples = route.map(pointSpeed).filter((value) => value != null);
  const maxSpeedKmh = finite(trip.max_speed_kmh) ?? (speedSamples.length ? Math.max(...speedSamples) : null);
  const averageSpeedKmh = finite(trip.avg_speed_kmh) ?? (durationSeconds > 0 ? distanceKm / (durationSeconds / 3600) : null);
  const averageRunningSpeedKmh = finite(trip.avg_running_speed_kmh) ?? averageSpeedKmh;
  const lastFixMs = timestampMs(trip.last_location_at) ?? pointTimestamp(latestPoint);
  const reportedFixAge = finite(trip.last_fix_age_seconds);
  const fixAgeSeconds = lastFixMs == null ? reportedFixAge : Math.max(0, (nowMs - lastFixMs) / 1000);
  const accuracyM = finite(trip.gps_accuracy_m) ?? finite(latestPoint?.accuracy);
  const fixReady = trip.gps_fix_ready === true || (lastFixMs != null && fixAgeSeconds <= 15);
  const quality = gpsQuality({
    fixReady,
    permissionLoss: trip.permission_loss === true,
    accuracyM,
    fixAgeSeconds,
  });
  const speedEvidenceReady = fixReady && quality.key !== 'stale' && quality.key !== 'lost';
  const speedLimitKmh = finite(trip.speed_limit_kmh ?? latestPoint?.speed_limit_kmh);
  const speedDeltaKmh = speedLimitKmh != null && currentSpeedKmh != null ? currentSpeedKmh - speedLimitKmh : null;
  const events = normalizedEvents(trip);
  const eventCounts = trip.live_event_counts && typeof trip.live_event_counts === 'object'
    ? Object.fromEntries(Object.entries(trip.live_event_counts).map(([key, value]) => [key, Math.max(0, Math.round(finite(value) || 0))]))
    : events.reduce((counts, event) => ({ ...counts, [event.type]: (counts[event.type] || 0) + 1 }), {});
  const routeMaskedCount = Math.max(
    0,
    Math.round(finite(trip.privacy_masked_point_count) || route.filter(privacyMasked).length)
  );
  const routePointCount = Math.max(0, Math.round(finite(trip.route_point_count) ?? route.length));
  const latestUpdateMs = timestampMs(trip.updated_at) ?? lastFixMs;

  return {
    id: trip.id || null,
    native: trip.native_recording === true,
    state: trip.state || trip.trip_state || 'recording',
    distanceKm,
    durationSeconds,
    currentSpeedKmh: speedEvidenceReady && currentSpeedKmh != null ? Math.max(0, currentSpeedKmh) : null,
    averageSpeedKmh,
    averageRunningSpeedKmh,
    maxSpeedKmh,
    movingSeconds: Math.max(0, finite(trip.moving_seconds) || 0),
    idleSeconds: Math.max(0, finite(trip.idle_seconds) || 0),
    stoppedSeconds: Math.max(0, finite(trip.stopped_seconds) || 0),
    gapSeconds: Math.max(0, finite(trip.gap_seconds) || 0),
    routeGapCount: Math.max(0, Math.round(finite(trip.route_gap_count) || route.filter((point) => point?.tracking_gap === true || point?.route_gap === true).length)),
    routePointCount,
    routePreview: route.slice(-600),
    routeMaskedCount,
    speedLimitKmh,
    speedLimitSource: trip.speed_limit_source || latestPoint?.speed_limit_source || null,
    speedDeltaKmh,
    gps: {
      ...quality,
      fixReady,
      accuracyM,
      fixAgeSeconds,
      lastFixAt: lastFixMs == null ? null : new Date(lastFixMs).toISOString(),
    },
    headingDeg: finite(trip.heading_deg) ?? finite(latestPoint?.heading),
    altitudeM: finite(trip.altitude_m) ?? finite(latestPoint?.altitude),
    accelerationMs2: finite(trip.longitudinal_acceleration_ms2 ?? latestPoint?.acceleration_ms2),
    lateralG: finite(trip.lateral_g ?? latestPoint?.lateral_g),
    headingRateDegS: finite(trip.heading_rate_deg_s),
    linearMotionMagnitudeMs2: finite(trip.linear_motion_magnitude_ms2),
    rotationMagnitudeDegS: finite(trip.rotation_magnitude_deg_s),
    motionSampleCount: Math.max(0, Math.round(finite(trip.motion_sample_count) || 0)),
    motionSensorReady: trip.motion_sensor_ready === true || (Array.isArray(trip.motion_samples) && trip.motion_samples.length > 0),
    linearAccelerationSensorReady: trip.linear_acceleration_sensor_ready === true,
    gyroscopeSensorReady: trip.gyroscope_sensor_ready === true,
    activityType: String(trip.activity_type || 'unknown'),
    activityConfidence: finite(trip.activity_confidence),
    maxDriftSinceStopM: Math.max(0, finite(trip.max_drift_since_stop_m) || 0),
    possibleIncidentActive: trip.possible_incident_active === true,
    events,
    eventCounts,
    latestEvent: events[0] || null,
    updatedAt: latestUpdateMs == null ? null : new Date(latestUpdateMs).toISOString(),
    updateAgeSeconds: latestUpdateMs == null ? null : Math.max(0, (nowMs - latestUpdateMs) / 1000),
  };
}

