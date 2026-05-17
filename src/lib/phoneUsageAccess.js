const round2 = (value) => Math.round(value * 100) / 100;

const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const riskRank = { none: 0, low: 1, medium: 2, high: 3 };

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
