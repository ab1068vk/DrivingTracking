const finite = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const timeMs = (value) => {
  if (value == null || value === '') return null;
  const direct = finite(value);
  if (direct != null && direct > 10_000_000_000) return direct;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const pointTime = (point = {}) => timeMs(
  point.timestamp ?? point.time ?? point.recorded_at ?? point.timestamp_ms ?? point.timestampMs
);

const eventTime = (event = {}) => timeMs(
  event.timestamp ?? event.time ?? event.start_time ?? event.startTime ?? event.recorded_at
);

const speedKmh = (point = {}) => {
  const kmh = finite(point.speed_kmh ?? point.speedKmh ?? point.obd_speed_kmh);
  if (kmh != null) return Math.max(0, kmh);
  const metersPerSecond = finite(point.speed);
  return metersPerSecond == null ? null : Math.max(0, metersPerSecond * 3.6);
};

const speedLimitKmh = (point = {}) => {
  const value = finite(point.speed_limit_kmh ?? point.speedLimitKmh ?? point.limit_kmh);
  return value != null && value > 0 ? value : null;
};

const privacyMasked = (item = {}) => item.masked_for_privacy === true ||
  item.privacy_gap === true || item.privacy_boundary === true ||
  item.privacy_live_redacted === true || item.privacy_purged === true;

const routeGap = (previous, current, deltaSeconds) => current?.tracking_gap === true ||
  current?.route_gap === true || (deltaSeconds != null && deltaSeconds > 120) ||
  privacyMasked(previous) || privacyMasked(current);

const titleCase = (value) => String(value || 'observation')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const sampleEvenly = (rows, maxRows) => {
  if (rows.length <= maxRows) return rows;
  const sampled = [];
  const step = (rows.length - 1) / (maxRows - 1);
  for (let index = 0; index < maxRows; index += 1) sampled.push(rows[Math.round(index * step)]);
  return sampled;
};

const nearestEvent = (events, timestamp, toleranceMs = 15_000) => {
  let best = null;
  let bestDelta = Infinity;
  events.forEach((event) => {
    const timestampMs = eventTime(event);
    if (timestampMs == null) return;
    const delta = Math.abs(timestampMs - timestamp);
    if (delta < bestDelta && delta <= toleranceMs) {
      best = event;
      bestDelta = delta;
    }
  });
  return best;
};

export function buildTripTelemetrySeries(trip = {}, { maxPoints = 600 } = {}) {
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const events = Array.isArray(trip?.driving_events) ? trip.driving_events : [];
  const fallbackStart = timeMs(trip.start_time);
  const durationMs = Math.max(1, finite(trip.duration_seconds) || 0) * 1000;
  const withTimes = routePoints.map((point, index) => ({
    point,
    sourceIndex: index,
    timestamp: pointTime(point) ?? (fallbackStart == null ? index * 1000 : fallbackStart + (durationMs * index / Math.max(1, routePoints.length - 1))),
  })).sort((a, b) => a.timestamp - b.timestamp);
  const start = withTimes[0]?.timestamp ?? fallbackStart ?? 0;
  const end = withTimes[withTimes.length - 1]?.timestamp ?? (start + durationMs);
  let previousAcceleration = null;

  const rows = withTimes.map(({ point, sourceIndex, timestamp }, index) => {
    const previousEntry = withTimes[index - 1];
    const previousSpeed = previousEntry ? speedKmh(previousEntry.point) : null;
    const speed = speedKmh(point);
    const deltaSeconds = previousEntry ? (timestamp - previousEntry.timestamp) / 1000 : null;
    const gap = previousEntry ? routeGap(previousEntry.point, point, deltaSeconds) : privacyMasked(point);
    let acceleration = finite(point.acceleration_ms2 ?? point.longitudinal_acceleration_ms2 ?? point.acceleration);
    let accelerationSource = acceleration == null ? null : 'retained sensor';
    if (acceleration == null && speed != null && previousSpeed != null && deltaSeconds >= 0.25 && deltaSeconds <= 30 && !gap) {
      acceleration = ((speed - previousSpeed) / 3.6) / deltaSeconds;
      accelerationSource = 'derived from speed';
    }
    let jerk = finite(point.jerk_ms3 ?? point.jerk);
    let jerkSource = jerk == null ? null : 'retained sensor';
    if (jerk == null && acceleration != null && previousAcceleration != null && deltaSeconds >= 0.25 && deltaSeconds <= 30 && !gap) {
      jerk = (acceleration - previousAcceleration) / deltaSeconds;
      jerkSource = 'derived from speed';
    }
    if (acceleration != null) previousAcceleration = acceleration;
    else if (gap) previousAcceleration = null;
    const observation = nearestEvent(events, timestamp);
    const lat = finite(point.lat);
    const lng = finite(point.lng);
    const masked = privacyMasked(point) || lat == null || lng == null;
    return {
      id: `${trip.id || 'trip'}-sample-${sourceIndex}`,
      sourceIndex,
      timestamp,
      elapsedSeconds: Math.max(0, (timestamp - start) / 1000),
      elapsedMinutes: Math.max(0, (timestamp - start) / 60_000),
      progress: end > start ? ((timestamp - start) / (end - start)) * 100 : 0,
      speedKmh: speed,
      speedLimitKmh: speedLimitKmh(point),
      speedLimitSource: point.speed_limit_source || point.speedLimitSource || null,
      accelerationMs2: acceleration,
      accelerationSource,
      jerkMs3: jerk,
      jerkSource,
      lateralG: finite(point.lateral_g ?? point.lateralG),
      accuracyM: finite(point.accuracy),
      altitudeM: finite(point.altitude),
      sampleIntervalSeconds: deltaSeconds != null && deltaSeconds >= 0 ? deltaSeconds : null,
      gap,
      privacyMasked: masked,
      lat: masked ? null : lat,
      lng: masked ? null : lng,
      observationType: observation?.type || null,
      observationLabel: observation ? titleCase(observation.type) : null,
      rawPoint: point,
    };
  });

  return sampleEvenly(rows, Math.max(20, maxPoints));
}

export function nearestTelemetrySample(series = [], timestamp) {
  const target = finite(timestamp);
  if (target == null || !series.length) return null;
  return series.reduce((best, row) => (
    !best || Math.abs(row.timestamp - target) < Math.abs(best.timestamp - target) ? row : best
  ), null);
}

export function summarizeTripTelemetry(trip = {}, series = buildTripTelemetrySeries(trip)) {
  const validSpeed = series.filter((row) => row.speedKmh != null);
  const validAccuracy = series.filter((row) => row.accuracyM != null);
  const intervals = series.map((row) => row.sampleIntervalSeconds).filter((value) => value != null && value <= 120);
  const speedCoverage = series.filter((row) => row.speedLimitKmh != null).length;
  const exceeded = series.filter((row) => row.speedKmh != null && row.speedLimitKmh != null && row.speedKmh > row.speedLimitKmh).length;
  const accelerationDerived = series.some((row) => row.accelerationSource === 'derived from speed');
  const sensorAcceleration = series.some((row) => row.accelerationSource === 'retained sensor');
  return {
    sampleCount: series.length,
    maxSpeedKmh: validSpeed.length ? Math.max(...validSpeed.map((row) => row.speedKmh)) : null,
    averageAccuracyM: validAccuracy.length ? validAccuracy.reduce((sum, row) => sum + row.accuracyM, 0) / validAccuracy.length : null,
    averageIntervalSeconds: intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null,
    routeGapCount: series.filter((row) => row.gap).length,
    privacyGapCount: series.filter((row) => row.privacyMasked).length,
    speedLimitCoveragePct: series.length ? Math.round(speedCoverage / series.length * 100) : 0,
    thresholdExceededPct: speedCoverage ? Math.round(exceeded / speedCoverage * 100) : null,
    accelerationEvidence: sensorAcceleration ? 'retained sensor' : accelerationDerived ? 'derived from speed' : 'unavailable',
    jerkEvidence: series.some((row) => row.jerkSource === 'retained sensor') ? 'retained sensor' : series.some((row) => row.jerkSource === 'derived from speed') ? 'derived from speed' : 'unavailable',
  };
}

export function buildNormalizedComparison(primaryTrip = {}, secondaryTrip = {}, bins = 80) {
  const normalize = (trip) => {
    const series = buildTripTelemetrySeries(trip, { maxPoints: 900 });
    return Array.from({ length: bins + 1 }, (_, index) => {
      return nearestTelemetrySample(series, series[0]?.timestamp + ((series[series.length - 1]?.timestamp - series[0]?.timestamp) * index / bins));
    }).map((row, index) => ({ progress: index / bins * 100, speedKmh: row?.speedKmh ?? null }));
  };
  const primary = normalize(primaryTrip);
  const secondary = normalize(secondaryTrip);
  return primary.map((row, index) => ({
    progress: row.progress,
    primarySpeedKmh: row.speedKmh,
    comparisonSpeedKmh: secondary[index]?.speedKmh ?? null,
  }));
}

export function buildTrackingTrendSeries(trips = []) {
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => timeMs(trip?.start_time) != null)
    .sort((a, b) => timeMs(a.start_time) - timeMs(b.start_time))
    .slice(-30)
    .map((trip, index) => ({
      id: trip.id || `trip-${index}`,
      timestamp: timeMs(trip.start_time),
      label: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(trip.start_time)),
      distanceKm: finite(trip.distance_km),
      averageSpeedKmh: finite(trip.avg_speed_kmh),
      eventRate: finite(trip.distance_km) > 0
        ? ((Array.isArray(trip.driving_events) ? trip.driving_events.length : finite(trip.driving_events_count ?? trip.event_count) || 0) / finite(trip.distance_km)) * 10
        : null,
      routeSamples: Array.isArray(trip.route_points) ? trip.route_points.length : finite(trip.route_point_count ?? trip.route_points_count),
    }));
}

