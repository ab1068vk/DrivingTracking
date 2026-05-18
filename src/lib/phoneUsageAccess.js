const round2 = (value) => Math.round(value * 100) / 100;

const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const riskRank = { none: 0, low: 1, medium: 2, high: 3 };
const emptyPhoneUse = () => ({
  phone_use_events: [],
  phone_use_window_count: 0,
  phone_use_total_seconds: 0,
  phone_use_high_confidence_count: 0,
  phone_use_risk: 'none',
  phone_use_score: 100,
  phone_use_pct_of_trip: 0,
});

function nearestRoutePoint(routePoints = [], targetMs = null) {
  if (!routePoints.length || targetMs == null) return null;
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const point of routePoints) {
    const pointMs = timestampMs(point?.timestamp);
    if (pointMs == null) continue;
    const delta = Math.abs(pointMs - targetMs);
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }
  return best;
}

function eventKey(event = {}) {
  return [
    event.source || 'gps',
    event.startTime || event.timestamp || '',
    event.endTime || '',
    Math.round(Number(event.durationS ?? event.duration_seconds) || 0),
  ].join('|');
}

export function buildPhoneUseFromAndroidUsage(summary = {}, routePoints = [], tripDurationSeconds = 0) {
  const sessions = Array.isArray(summary?.events) ? summary.events : [];
  const events = sessions
    .map((session, index) => {
      const startMs = Number(session.start_ms) || timestampMs(session.start_time);
      const endMs = Number(session.end_ms) || timestampMs(session.end_time);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

      const durationS = Math.max(1, Math.round(Number(session.duration_seconds) || ((endMs - startMs) / 1000)));
      if (durationS < 2) return null;

      const midpointMs = startMs + (endMs - startMs) / 2;
      const routePoint = nearestRoutePoint(routePoints, midpointMs) || routePoints[Math.min(routePoints.length - 1, Math.max(0, index))] || {};
      const speedKmh = Number(routePoint.speed_kmh) || 0;
      const confidence = durationS >= 10 ? 0.98 : 0.90;
      const severity = durationS >= 45 || speedKmh >= 80
        ? 'high'
        : durationS >= 10 || speedKmh >= 30
          ? 'medium'
          : 'low';

      return {
        type: 'phone_use',
        source: 'android_usage_access',
        package_name: session.package_name,
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        timestamp: new Date(startMs).toISOString(),
        durationS,
        duration_seconds: durationS,
        lat: routePoint.lat,
        lng: routePoint.lng,
        speed_kmh: Math.round(speedKmh),
        confidence,
        confidence_level: 'high',
        signals_triggered: ['android_usage_access'],
        severity,
        value: confidence,
      };
    })
    .filter(Boolean);

  const totalSeconds = events.reduce((sum, event) => sum + (event.durationS || 0), 0);
  const highConfidenceCount = events.length;
  const phoneUseRisk = events.length === 0
    ? 'none'
    : totalSeconds >= 60 || events.length >= 3
      ? 'high'
      : totalSeconds >= 10
        ? 'medium'
        : 'low';
  const penalty = events.reduce((sum, event) => (
    sum + (event.severity === 'high' ? 20 : event.severity === 'medium' ? 10 : 4)
  ), 0);
  const duration = Math.max(1, Number(tripDurationSeconds) || 1);

  return {
    phone_use_events: events,
    phone_use_window_count: events.length,
    phone_use_total_seconds: totalSeconds,
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: Math.max(0, Math.round(100 - penalty)),
    phone_use_pct_of_trip: round2((totalSeconds / duration) * 100),
  };
}

export function buildPhoneUseFromEvents(events = [], tripDurationSeconds = 0, fallbackRisk = 'none') {
  const phoneEvents = (events || [])
    .filter((event) => event?.type === 'phone_use')
    .map((event) => {
      const startMs = timestampMs(event.startTime || event.timestamp);
      const endMs = timestampMs(event.endTime);
      const durationS = Number(event.durationS ?? event.duration_seconds) ||
        (startMs != null && endMs != null && endMs > startMs ? Math.round((endMs - startMs) / 1000) : 0);
      const confidence = Number(event.confidence ?? event.value) || (event.confidence_level === 'high' ? 0.9 : event.confidence_level === 'medium' ? 0.65 : 0.45);
      return {
        ...event,
        type: 'phone_use',
        timestamp: event.timestamp || event.startTime || new Date().toISOString(),
        startTime: event.startTime || event.timestamp,
        durationS: Math.max(0, Math.round(durationS)),
        duration_seconds: Math.max(0, Math.round(durationS)),
        confidence,
        confidence_level: event.confidence_level || (confidence >= 0.75 ? 'high' : confidence >= 0.55 ? 'medium' : 'low'),
        severity: event.severity || (confidence >= 0.75 ? 'high' : confidence >= 0.55 ? 'medium' : 'low'),
      };
    });

  if (!phoneEvents.length) return emptyPhoneUse();

  const totalSeconds = phoneEvents.reduce((sum, event) => sum + (Number(event.durationS ?? event.duration_seconds) || 0), 0);
  const highConfidenceCount = phoneEvents.filter((event) => (
    event.confidence_level === 'high' || Number(event.confidence) >= 0.75
  )).length;
  const duration = Math.max(1, Number(tripDurationSeconds) || 1);
  const calculatedRisk = totalSeconds >= 60 || highConfidenceCount >= 2
    ? 'high'
    : totalSeconds >= 10 || highConfidenceCount >= 1
      ? 'medium'
      : 'low';
  const phoneUseRisk = [fallbackRisk || 'none', calculatedRisk]
    .sort((a, b) => (riskRank[b] || 0) - (riskRank[a] || 0))[0] || 'none';
  const penalty = phoneEvents.reduce((sum, event) => (
    sum + (event.severity === 'high' ? 20 : event.severity === 'medium' ? 10 : 4)
  ), 0);

  return {
    phone_use_events: phoneEvents,
    phone_use_window_count: phoneEvents.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: Math.max(0, Math.round(100 - penalty)),
    phone_use_pct_of_trip: round2((totalSeconds / duration) * 100),
  };
}

export function mergePhoneUseSignals(gpsPhoneUse = {}, usagePhoneUse = {}, tripDurationSeconds = 0) {
  const events = [
    ...(gpsPhoneUse.phone_use_events || []),
    ...(usagePhoneUse.phone_use_events || []),
  ];
  const deduped = [];
  const seen = new Set();
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  deduped.sort((a, b) => timestampMs(a.startTime || a.timestamp) - timestampMs(b.startTime || b.timestamp));

  const totalSeconds = deduped.reduce((sum, event) => sum + (Number(event.durationS ?? event.duration_seconds) || 0), 0);
  const highConfidenceCount = deduped.filter((event) => (
    event.confidence_level === 'high' || Number(event.confidence) >= 0.75
  )).length;
  const risk = [gpsPhoneUse.phone_use_risk || 'none', usagePhoneUse.phone_use_risk || 'none']
    .sort((a, b) => (riskRank[b] || 0) - (riskRank[a] || 0))[0] || 'none';
  const score = Math.min(gpsPhoneUse.phone_use_score ?? 100, usagePhoneUse.phone_use_score ?? 100);
  const duration = Math.max(1, Number(tripDurationSeconds) || 1);

  return {
    phone_use_events: deduped,
    phone_use_window_count: deduped.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: risk,
    phone_use_score: score,
    phone_use_pct_of_trip: round2((totalSeconds / duration) * 100),
  };
}

export function mergeManyPhoneUseSignals(signals = [], tripDurationSeconds = 0) {
  return signals.reduce(
    (merged, signal) => mergePhoneUseSignals(merged, signal || {}, tripDurationSeconds),
    emptyPhoneUse()
  );
}

export function buildPhoneUseFromTripEvidence(trip = {}, routePoints = [], tripDurationSeconds = 0, detectionPhoneUse = {}) {
  const nativeUsage = buildPhoneUseFromAndroidUsage({
    usage_access_granted: trip.native_phone_usage_access_granted === true,
    events: Array.isArray(trip.native_phone_usage_events) ? trip.native_phone_usage_events : [],
    event_count: Number(trip.native_phone_usage_event_count) || 0,
    total_seconds: Number(trip.native_phone_usage_total_seconds) || 0,
  }, routePoints, tripDurationSeconds);
  const storedEvents = buildPhoneUseFromEvents([
    ...(Array.isArray(trip.phone_use_events) ? trip.phone_use_events : []),
    ...(Array.isArray(trip.driving_events) ? trip.driving_events.filter((event) => event?.type === 'phone_use') : []),
  ], tripDurationSeconds, trip.phone_use_risk || 'none');
  const summaryOnly = Number(trip.phone_use_window_count) > 0 && !storedEvents.phone_use_events.length
    ? {
      phone_use_events: [],
      phone_use_window_count: Number(trip.phone_use_window_count) || 0,
      phone_use_total_seconds: Number(trip.phone_use_total_seconds) || 0,
      phone_use_high_confidence_count: Number(trip.phone_use_high_confidence_count) || 0,
      phone_use_risk: trip.phone_use_risk || 'low',
      phone_use_score: Number.isFinite(Number(trip.phone_use_score)) ? Number(trip.phone_use_score) : 90,
      phone_use_pct_of_trip: Number(trip.phone_use_pct_of_trip) || 0,
    }
    : emptyPhoneUse();

  return mergeManyPhoneUseSignals([detectionPhoneUse, nativeUsage, storedEvents, summaryOnly], tripDurationSeconds);
}

export function mergePhoneUseEventsIntoDrivingEvents(drivingEvents = [], phoneUse = {}) {
  const existing = new Set((drivingEvents || []).map(eventKey));
  const additions = (phoneUse.phone_use_events || []).filter((event) => {
    if (event.type !== 'phone_use') return false;
    const key = eventKey(event);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  return [...(drivingEvents || []), ...additions];
}
