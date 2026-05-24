const round2 = (value) => Math.round(value * 100) / 100;

const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const riskRank = { none: 0, low: 1, medium: 2, high: 3 };
const MOVING_USAGE_SPEED_KMH = 15;
const MAX_ROUTE_EVENT_DELTA_MS = 20_000;
const MIN_USAGE_SESSION_SECONDS = 5;
const PASSIVE_USAGE_PACKAGE_PATTERNS = [
  /^android$/,
  /^com\.android\.(systemui|launcher|settings|permissioncontroller|inputmethod|providers|phone|server\.telecom)/,
  /^com\.google\.android\.(apps\.maps|apps\.youtube\.music|googlequicksearchbox|projection\.gearhead)$/,
  /^com\.waze$/,
  /^com\.spotify\.music$/,
  /launcher/i,
  /(keyboard|inputmethod|\.ime$)/i,
];
const emptyPhoneUse = () => ({
  phone_use_events: [],
  phone_use_window_count: 0,
  phone_use_total_seconds: 0,
  phone_use_high_confidence_count: 0,
  phone_use_risk: 'none',
  phone_use_score: 100,
  phone_use_pct_of_trip: 0,
  data_sources: [],
});

function isPassiveUsagePackage(packageName = '') {
  return PASSIVE_USAGE_PACKAGE_PATTERNS.some((pattern) => pattern.test(packageName));
}

function nearestRoutePoint(routePoints = [], targetMs = null) {
  if (!routePoints.length || targetMs == null) return { point: null, deltaMs: Number.POSITIVE_INFINITY };
  let bestPoint = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const point of routePoints) {
    const pointMs = timestampMs(point?.timestamp);
    if (pointMs == null) continue;
    const delta = Math.abs(pointMs - targetMs);
    if (delta < bestDelta) {
      bestPoint = point;
      bestDelta = delta;
    }
  }
  return { point: bestPoint, deltaMs: bestDelta };
}

function eventKey(event = {}) {
  return [
    event.source || 'gps',
    event.startTime || event.timestamp || '',
    event.endTime || '',
    Math.round(Number(event.durationS ?? event.duration_seconds) || 0),
  ].join('|');
}

const eventInterval = (event = {}) => {
  const start = timestampMs(event.startTime || event.timestamp);
  const durationMs = Math.max(0, Number(event.durationS ?? event.duration_seconds) || 0) * 1000;
  const end = timestampMs(event.endTime) ?? (start == null ? null : start + durationMs);
  return { start, end };
};

const isAndroidSignal = (event = {}) => event.source === 'android_usage_access';

const competingSignalsOverlap = (left = {}, right = {}) => {
  if (isAndroidSignal(left) === isAndroidSignal(right)) return false;
  const a = eventInterval(left);
  const b = eventInterval(right);
  if (a.start == null || a.end == null || b.start == null || b.end == null) return false;
  const overlapToleranceMs = 30_000;
  return a.start <= b.end + overlapToleranceMs && b.start <= a.end + overlapToleranceMs;
};

const eventConfidence = (event = {}) => Number(event.confidence ?? event.value) || 0;

export function buildPhoneUseFromAndroidUsage(summary = {}, routePoints = [], tripDurationSeconds = 0) {
  const sessions = Array.isArray(summary?.events) ? summary.events : [];
  const events = sessions
    .map((session, index) => {
      if (isPassiveUsagePackage(session.package_name || '')) return null;
      const startMs = Number(session.start_ms) || timestampMs(session.start_time);
      const endMs = Number(session.end_ms) || timestampMs(session.end_time);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

      const durationS = Math.max(1, Math.round(Number(session.duration_seconds) || ((endMs - startMs) / 1000)));
      if (durationS < MIN_USAGE_SESSION_SECONDS) return null;

      const midpointMs = startMs + (endMs - startMs) / 2;
      const nearest = nearestRoutePoint(routePoints, midpointMs);
      const routePoint = nearest.point || routePoints[Math.min(routePoints.length - 1, Math.max(0, index))] || {};
      if (!nearest.point || nearest.deltaMs > MAX_ROUTE_EVENT_DELTA_MS) return null;
      const speedKmh = Number(routePoint.speed_kmh) || 0;
      if (speedKmh < MOVING_USAGE_SPEED_KMH) return null;
      const confidence = durationS >= 20 ? 0.92 : 0.82;
      const severity = durationS >= 90 || speedKmh >= 100
        ? 'high'
        : durationS >= 20 || speedKmh >= 50
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
        signals_triggered: ['android_usage_access', 'moving_trip_overlap'],
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
    data_sources: summary?.usage_access_granted === true ? ['android_usage_access'] : [],
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
    data_sources: ['stored_events'],
  };
}

const dataSourcesForSignal = (signal = {}, fallback = null) => {
  if (Array.isArray(signal.data_sources)) return signal.data_sources.filter(Boolean);
  const sources = new Set();
  (signal.phone_use_events || []).forEach((event) => {
    if (event?.source === 'android_usage_access') sources.add('android_usage_access');
    else if (event?.source) sources.add(event.source);
  });
  const scoreIndicatesSignal = Number.isFinite(Number(signal.phone_use_score)) && Number(signal.phone_use_score) < 100;
  const riskIndicatesSignal = signal.phone_use_risk && signal.phone_use_risk !== 'none';
  if (!sources.size && fallback && (Number(signal.phone_use_window_count || 0) > 0 || scoreIndicatesSignal || riskIndicatesSignal)) {
    sources.add(fallback);
  }
  return [...sources];
};

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
    const overlapIndex = deduped.findIndex((existing) => competingSignalsOverlap(existing, event));
    if (overlapIndex >= 0) {
      if (eventConfidence(event) > eventConfidence(deduped[overlapIndex])) {
        deduped[overlapIndex] = event;
      }
      continue;
    }
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
  const dataSources = [
    ...dataSourcesForSignal(gpsPhoneUse, 'gps_proxy'),
    ...dataSourcesForSignal(usagePhoneUse, 'android_usage_access'),
  ];

  return {
    phone_use_events: deduped,
    phone_use_window_count: deduped.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: risk,
    phone_use_score: score,
    phone_use_pct_of_trip: round2((totalSeconds / duration) * 100),
    data_sources: [...new Set(dataSources)],
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
      data_sources: ['summary_only'],
    }
    : emptyPhoneUse();

  return mergeManyPhoneUseSignals([detectionPhoneUse, nativeUsage, storedEvents, summaryOnly], tripDurationSeconds);
}

export function mergePhoneUseEventsIntoDrivingEvents(drivingEvents = [], phoneUse = {}) {
  const retained = (drivingEvents || []).filter((event) => event?.type !== 'phone_use');
  const stored = buildPhoneUseFromEvents((drivingEvents || []).filter((event) => event?.type === 'phone_use'));
  const merged = mergePhoneUseSignals(stored, phoneUse);
  return [...retained, ...merged.phone_use_events];
}
