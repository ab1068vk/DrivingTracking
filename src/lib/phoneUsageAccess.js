import { scoringValue } from '@/lib/scoringConstants';

const round2 = (value) => Math.round(value * 100) / 100;

const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const riskRank = { none: 0, low: 1, medium: 2, high: 3 };
const MOVING_USAGE_SPEED_KMH = 15;
const MAX_ROUTE_EVENT_DELTA_MS = 20_000;
const MIN_USAGE_SESSION_SECONDS = 5;
const MOVING_WINDOW_GAP_MERGE_MS = 3_000;
const MAX_USAGE_ROUTE_ACCURACY_M = 50;
const SCREEN_CONTEXT_WINDOW_MS = 10_000;
export const PHONE_USE_SEVERITY_THRESHOLDS = Object.freeze({
  /**
   * Provisional heuristic: Android foreground-session duration that marks a
   * moving phone-use event as high severity.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  HIGH_DURATION_SECONDS: scoringValue('PHONE_HIGH_DURATION_SECONDS'),
  /**
   * Provisional heuristic: vehicle speed that marks any moving phone-use event
   * as high severity.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  HIGH_SPEED_KMH: scoringValue('PHONE_HIGH_SPEED_KMH'),
  /**
   * Provisional heuristic: Android foreground-session duration that marks a
   * moving phone-use event as medium severity.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  MEDIUM_DURATION_SECONDS: scoringValue('PHONE_MEDIUM_DURATION_SECONDS'),
  /**
   * Provisional heuristic: vehicle speed that marks any moving phone-use event
   * as medium severity.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  MEDIUM_SPEED_KMH: scoringValue('PHONE_MEDIUM_SPEED_KMH'),
});
export const PHONE_USE_PENALTY_POINTS = Object.freeze({
  /**
   * Provisional score deduction for a high-severity confirmed phone-use event.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  high: scoringValue('PHONE_PENALTY_HIGH'),
  /**
   * Provisional score deduction for a medium-severity confirmed phone-use event.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  medium: scoringValue('PHONE_PENALTY_MEDIUM'),
  /**
   * Provisional score deduction for a low-severity confirmed phone-use event.
   * Not calibrated to published distracted-driving research or NHTSA data.
   */
  low: scoringValue('PHONE_PENALTY_LOW'),
});
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
  phone_use_score: null,
  phone_use_score_available: false,
  phone_use_score_status: 'usage_access_required',
  phone_use_pct_of_trip: 0,
  phone_proxy_events: [],
  phone_proxy_count: 0,
  phone_proxy_risk: 'none',
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
    const pointMs = timestampMs(point?.timestamp ?? point?.time);
    if (pointMs == null) continue;
    const delta = Math.abs(pointMs - targetMs);
    if (delta < bestDelta) {
      bestPoint = point;
      bestDelta = delta;
    }
  }
  return { point: bestPoint, deltaMs: bestDelta };
}

function movingUsageWindows(routePoints = [], sessionStartMs, sessionEndMs) {
  const points = routePoints
    .map((point) => ({
      point,
      timestamp: timestampMs(point?.timestamp ?? point?.time),
      speedKmh: Math.max(0, Number(point?.speed_kmh ?? point?.speedKmh) || 0),
      accuracyM: Number(point?.accuracy ?? point?.accuracy_m),
    }))
    .filter((entry) => entry.timestamp != null)
    .sort((left, right) => left.timestamp - right.timestamp);

  const windows = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const sampleDurationMs = next.timestamp - current.timestamp;
    const inaccurate = Number.isFinite(current.accuracyM) && current.accuracyM > MAX_USAGE_ROUTE_ACCURACY_M;
    if (
      sampleDurationMs <= 0 ||
      sampleDurationMs > MAX_ROUTE_EVENT_DELTA_MS ||
      inaccurate ||
      current.speedKmh < MOVING_USAGE_SPEED_KMH
    ) {
      continue;
    }

    const startMs = Math.max(sessionStartMs, current.timestamp);
    const endMs = Math.min(sessionEndMs, next.timestamp);
    if (endMs <= startMs) continue;

    const durationMs = endMs - startMs;
    const previous = windows[windows.length - 1];
    if (previous && startMs - previous.endMs <= MOVING_WINDOW_GAP_MERGE_MS) {
      previous.endMs = endMs;
      previous.movingDurationMs += durationMs;
      previous.weightedSpeedMs += current.speedKmh * durationMs;
      previous.maxSpeedKmh = Math.max(previous.maxSpeedKmh, current.speedKmh);
      previous.points.push(current.point);
    } else {
      windows.push({
        startMs,
        endMs,
        movingDurationMs: durationMs,
        weightedSpeedMs: current.speedKmh * durationMs,
        maxSpeedKmh: current.speedKmh,
        points: [current.point],
      });
    }
  }

  return windows.filter((window) => window.movingDurationMs >= MIN_USAGE_SESSION_SECONDS * 1000);
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

const phoneUseSeverity = (durationS, speedKmh) => {
  if (
    durationS >= PHONE_USE_SEVERITY_THRESHOLDS.HIGH_DURATION_SECONDS ||
    speedKmh >= PHONE_USE_SEVERITY_THRESHOLDS.HIGH_SPEED_KMH
  ) {
    return 'high';
  }
  if (
    durationS >= PHONE_USE_SEVERITY_THRESHOLDS.MEDIUM_DURATION_SECONDS ||
    speedKmh >= PHONE_USE_SEVERITY_THRESHOLDS.MEDIUM_SPEED_KMH
  ) {
    return 'medium';
  }
  return 'low';
};

const phoneUsePenalty = (event = {}) => PHONE_USE_PENALTY_POINTS[event.severity] ?? PHONE_USE_PENALTY_POINTS.low;

export function buildPhoneUseFromAndroidUsage(summary = {}, routePoints = [], tripDurationSeconds = 0) {
  const sessions = Array.isArray(summary?.events) ? summary.events : [];
  const events = sessions
    .flatMap((session) => {
      if (isPassiveUsagePackage(session.package_name || '')) return null;
      const startMs = Number(session.start_ms) || timestampMs(session.start_time);
      const endMs = Number(session.end_ms) || timestampMs(session.end_time);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

      return movingUsageWindows(routePoints, startMs, endMs).map((window) => {
        const durationS = Math.max(1, Math.round(window.movingDurationMs / 1000));
        const speedKmh = window.weightedSpeedMs / Math.max(1, window.movingDurationMs);
        const midpointMs = window.startMs + (window.endMs - window.startMs) / 2;
        const routePoint = nearestRoutePoint(window.points, midpointMs).point || window.points[0] || {};
        const retainsStartContext = window.startMs - startMs <= SCREEN_CONTEXT_WINDOW_MS;
        const startedAfterUnlock = retainsStartContext && session.started_after_unlock === true;
        const startedAfterScreenOn = retainsStartContext && session.started_after_screen_on === true;
        const interactionContext = startedAfterUnlock
          ? 'after_unlock'
          : startedAfterScreenOn
            ? 'after_screen_on'
            : 'foreground_only';
        const confidence = durationS >= PHONE_USE_SEVERITY_THRESHOLDS.MEDIUM_DURATION_SECONDS ? 0.92 : 0.82;
        const severity = phoneUseSeverity(durationS, speedKmh);

        return {
          type: 'phone_use',
          source: 'android_usage_access',
          startTime: new Date(window.startMs).toISOString(),
          endTime: new Date(window.endMs).toISOString(),
          timestamp: new Date(window.startMs).toISOString(),
          durationS,
          duration_seconds: durationS,
          lat: routePoint.lat,
          lng: routePoint.lng,
          speed_kmh: Math.round(speedKmh),
          max_speed_kmh: Math.round(window.maxSpeedKmh),
          gps_sample_count: window.points.length,
          started_after_unlock: startedAfterUnlock,
          started_after_screen_on: startedAfterScreenOn,
          interaction_context: interactionContext,
          confidence,
          confidence_level: 'high',
          signals_triggered: [
            'android_usage_access',
            'moving_trip_overlap',
            'moving_duration_clipped',
            ...(startedAfterUnlock ? ['recent_unlock'] : []),
            ...(startedAfterScreenOn ? ['recent_screen_on'] : []),
          ],
          severity,
          value: confidence,
        };
      });
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
  const penalty = events.reduce((sum, event) => sum + phoneUsePenalty(event), 0);
  const duration = Math.max(1, Number(tripDurationSeconds) || 1);

  return {
    phone_use_events: events,
    phone_use_window_count: events.length,
    phone_use_total_seconds: totalSeconds,
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: Math.max(0, Math.round(100 - penalty)),
    phone_use_score_available: summary?.usage_access_granted === true,
    phone_use_score_status: summary?.usage_access_granted === true ? 'android_usage_access' : 'usage_access_required',
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
        source: event.source || 'legacy_unverified',
        diagnostic_only: event.source !== 'android_usage_access',
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

  const confirmedEvents = phoneEvents.filter((event) => event.source === 'android_usage_access');
  const proxyEvents = phoneEvents.filter((event) => event.source !== 'android_usage_access');
  if (!confirmedEvents.length) {
    return {
      ...emptyPhoneUse(),
      phone_proxy_events: proxyEvents,
      phone_proxy_count: proxyEvents.length,
      phone_proxy_risk: proxyEvents.length > 0 ? 'possible' : 'none',
      data_sources: [...new Set(proxyEvents.map((event) => event.source === 'gps_proxy' ? 'gps_proxy' : 'legacy_unverified'))],
    };
  }
  const totalSeconds = confirmedEvents.reduce((sum, event) => sum + (Number(event.durationS ?? event.duration_seconds) || 0), 0);
  const highConfidenceCount = confirmedEvents.filter((event) => (
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
  const penalty = confirmedEvents.reduce((sum, event) => sum + phoneUsePenalty(event), 0);

  return {
    phone_use_events: confirmedEvents,
    phone_use_window_count: confirmedEvents.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: Math.max(0, Math.round(100 - penalty)),
    phone_use_score_available: true,
    phone_use_score_status: 'android_usage_access',
    phone_use_pct_of_trip: round2((totalSeconds / duration) * 100),
    phone_proxy_events: proxyEvents,
    phone_proxy_count: proxyEvents.length,
    phone_proxy_risk: proxyEvents.length > 0 ? 'possible' : 'none',
    data_sources: [...new Set(['android_usage_access', ...proxyEvents.map((event) => event.source === 'gps_proxy' ? 'gps_proxy' : 'legacy_unverified')])],
  };
}

const dataSourcesForSignal = (signal = {}, fallback = null) => {
  const sources = new Set(Array.isArray(signal.data_sources) ? signal.data_sources.filter(Boolean) : []);
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
    ...(gpsPhoneUse.phone_proxy_events || []),
    ...(usagePhoneUse.phone_proxy_events || []),
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

  const confirmedEvents = deduped.filter((event) => event.source === 'android_usage_access');
  const proxyEvents = deduped.filter((event) => event.source !== 'android_usage_access');
  const totalSeconds = confirmedEvents.reduce((sum, event) => sum + (Number(event.durationS ?? event.duration_seconds) || 0), 0);
  const highConfidenceCount = confirmedEvents.filter((event) => (
    event.confidence_level === 'high' || Number(event.confidence) >= 0.75
  )).length;
  const duration = Math.max(1, Number(tripDurationSeconds) || 1);
  const dataSources = [
    ...dataSourcesForSignal(gpsPhoneUse, 'gps_proxy'),
    ...dataSourcesForSignal(usagePhoneUse, 'android_usage_access'),
  ];
  const hasUsageAccess = dataSources.includes('android_usage_access') ||
    gpsPhoneUse.phone_use_score_available === true ||
    usagePhoneUse.phone_use_score_available === true;
  const risk = confirmedEvents.length === 0
    ? 'none'
    : totalSeconds >= 60 || confirmedEvents.length >= 3
      ? 'high'
      : totalSeconds >= 10
        ? 'medium'
        : 'low';
  const penalty = confirmedEvents.reduce((sum, event) => sum + phoneUsePenalty(event), 0);
  const proxyRisk = proxyEvents.length === 0
    ? 'none'
    : proxyEvents.some((event) => event.confidence_level === 'high' || Number(event.confidence) >= 0.75)
      ? 'likely'
      : 'possible';

  return {
    phone_use_events: confirmedEvents,
    phone_use_window_count: confirmedEvents.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: risk,
    phone_use_score: hasUsageAccess ? Math.max(0, Math.round(100 - penalty)) : null,
    phone_use_score_available: hasUsageAccess,
    phone_use_score_status: hasUsageAccess ? 'android_usage_access' : 'usage_access_required',
    phone_use_pct_of_trip: round2((totalSeconds / duration) * 100),
    phone_proxy_events: proxyEvents,
    phone_proxy_count: proxyEvents.length,
    phone_proxy_risk: proxyRisk,
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
      phone_use_score: null,
      phone_use_score_available: false,
      phone_use_score_status: 'usage_access_required',
      phone_use_pct_of_trip: Number(trip.phone_use_pct_of_trip) || 0,
      phone_proxy_count: Number(trip.phone_use_window_count) || 0,
      phone_proxy_risk: 'possible',
      data_sources: ['legacy_unverified'],
    }
    : emptyPhoneUse();

  return mergeManyPhoneUseSignals([detectionPhoneUse, nativeUsage, storedEvents, summaryOnly], tripDurationSeconds);
}

export function buildPhoneUsageAccessProvenance(trip = {}, currentUsageAccessGranted = null) {
  const recordedUsageAccessGranted = typeof trip.native_phone_usage_access_granted === 'boolean'
    ? trip.native_phone_usage_access_granted
    : null;
  const currentGranted = typeof currentUsageAccessGranted === 'boolean'
    ? currentUsageAccessGranted
    : null;
  const changed = recordedUsageAccessGranted !== null &&
    currentGranted !== null &&
    recordedUsageAccessGranted !== currentGranted;
  let note = null;
  if (changed && recordedUsageAccessGranted) {
    note = 'Phone use score was recorded when Usage Access was granted. Current permission status has changed.';
  } else if (changed) {
    note = 'Usage Access was not available when this trip was recorded. Current permission status has changed.';
  }

  return {
    recordedUsageAccessGranted,
    currentUsageAccessGranted: currentGranted,
    changed,
    note,
  };
}

export function mergePhoneUseEventsIntoDrivingEvents(drivingEvents = [], phoneUse = {}) {
  const retained = (drivingEvents || []).filter((event) => event?.type !== 'phone_use');
  const stored = buildPhoneUseFromEvents((drivingEvents || []).filter((event) => event?.type === 'phone_use'));
  const merged = mergePhoneUseSignals(stored, phoneUse);
  return [...retained, ...merged.phone_use_events];
}
