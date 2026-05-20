import {
  AUTO_START_GPS_FALLBACK_SECONDS,
  AUTO_START_SPEED_KMH,
} from '@/lib/activityRecognition';

const DIAGNOSTIC_EVENTS_KEY = 'drivesense_tracking_diagnostics';
const MAX_EVENTS = 120;

const safeJsonParse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const asArray = (value) => Array.isArray(value) ? value : [];

export function getTrackingDiagnostics() {
  if (typeof localStorage === 'undefined') {
    return { events: [], lastAutoStart: null, lastAutoStop: null, lastTripEnd: null };
  }
  const events = asArray(safeJsonParse(localStorage.getItem(DIAGNOSTIC_EVENTS_KEY), []));
  const lastAutoStart = [...events].reverse().find((event) => event.type === 'auto_start' || event.type === 'trip_started') || null;
  const lastAutoStop = [...events].reverse().find((event) => event.type === 'auto_stop' || event.type === 'trip_ended') || null;
  const lastTripEnd = [...events].reverse().find((event) => event.type === 'trip_ended' || event.type === 'trip_discarded') || null;
  return { events, lastAutoStart, lastAutoStop, lastTripEnd };
}

export function recordTrackingDiagnostic(event = {}) {
  if (typeof localStorage === 'undefined') return null;
  const nextEvent = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source: 'web',
    type: 'info',
    ...event,
  };
  const current = getTrackingDiagnostics().events;
  const next = [nextEvent, ...current].slice(0, MAX_EVENTS);
  try {
    localStorage.setItem(DIAGNOSTIC_EVENTS_KEY, JSON.stringify(next));
  } catch {}
  return nextEvent;
}

export function clearTrackingDiagnostics() {
  try {
    localStorage.removeItem(DIAGNOSTIC_EVENTS_KEY);
  } catch {}
}

export function normalizeNativeDiagnosticEvents(nativePayload = {}) {
  const events = Array.isArray(nativePayload?.events) ? nativePayload.events : [];
  return events.map((event, index) => ({
    id: event.id || `native_${index}_${event.timestamp || ''}`,
    source: 'android',
    type: event.type || 'native_event',
    timestamp: event.timestamp || new Date().toISOString(),
    title: event.title || nativeEventTitle(event.type),
    detail: event.detail || '',
    reason: event.reason || null,
    speed_kmh: event.speed_kmh ?? null,
    drift_m: event.drift_m ?? null,
    stopped_seconds: event.stopped_seconds ?? null,
  }));
}

function nativeEventTitle(type) {
  const labels = {
    service_armed: 'Native service armed',
    armed_location_watch: 'Movement watcher armed',
    candidate_started: 'Candidate trip started',
    candidate_confirmed: 'Candidate trip confirmed',
    candidate_hidden_parking_cooldown: 'Candidate hidden near parked location',
    auto_start: 'Trip auto-started',
    ending_review: 'Trip ending reviewed',
    tail_trimmed: 'Trip tail trimmed',
    trip_ended: 'Trip ended',
    trip_discarded: 'Trip discarded',
    phone_usage_access: 'Phone usage access checked',
  };
  return labels[type] || 'Native tracking event';
}

export function buildParkingTimeline(trip = {}) {
  const timeline = [];
  if (!trip) return timeline;

  if (trip.start_time) {
    timeline.push({
      timestamp: trip.start_time,
      type: 'trip_started',
      title: 'Trip started',
      detail: trip.start_source === 'native_auto'
        ? 'Android native auto-tracking started this trip.'
        : trip.start_source === 'auto'
          ? 'In-app auto tracking started this trip.'
          : 'Manual trip recording started.',
    });
  }

  const nativeTimeline = Array.isArray(trip.native_tracking_timeline) ? trip.native_tracking_timeline : [];
  for (const item of nativeTimeline) {
    timeline.push({
      timestamp: item.timestamp || trip.end_time || trip.start_time,
      type: item.type || 'native_event',
      title: item.title || nativeEventTitle(item.type),
      detail: item.detail || item.reason || '',
      reason: item.reason,
      speed_kmh: item.speed_kmh,
      stopped_seconds: item.stopped_seconds,
      drift_m: item.drift_m,
    });
  }

  const trafficIdle = Number(trip.traffic_idle_seconds) || 0;
  const parkedIdle = Number(trip.sustained_idle_seconds) || Math.max(0, (Number(trip.idle_time_seconds) || 0) - trafficIdle);
  if (trafficIdle > 0) {
    timeline.push({
      timestamp: trip.end_time || trip.start_time,
      type: 'traffic_stop',
      title: 'Traffic stops counted',
      detail: `${Math.round(trafficIdle)} seconds classified as short traffic-stop idle.`,
    });
  }
  if (parkedIdle > 0) {
    timeline.push({
      timestamp: trip.end_time || trip.start_time,
      type: 'parked_idle',
      title: 'Parked idle counted',
      detail: `${Math.round(parkedIdle)} seconds classified as parked or sustained idle.`,
    });
  }
  if (trip.parking_stop_detected) {
    timeline.push({
      timestamp: trip.end_time || trip.start_time,
      type: 'parking_detected',
      title: 'Final stop detected',
      detail: `Trip ended from a parked/stopped state after ${Math.round(trip.parking_stop_duration_seconds || 0)} seconds.`,
    });
  }
  if (trip.end_time) {
    timeline.push({
      timestamp: trip.end_time,
      type: 'trip_ended',
      title: 'Trip ended',
      detail: trip.native_auto_stop_reason
        ? `Native stop reason: ${trip.native_auto_stop_reason}.`
        : trip.parking_stop_detected
          ? 'Ended while parked or stopped.'
          : 'Ended while route was still moving or manually stopped.',
    });
  }

  return timeline
    .filter((item) => item.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

export function buildTrackingHealth(/** @type {any} */ { permissionStatus = {}, nativeStatus = {}, batteryStatus = {}, latestTrip = null } = {}) {
  const checks = [
    {
      id: 'native',
      label: 'Native service',
      status: nativeStatus?.enabled ? 'good' : 'warn',
      value: nativeStatus?.enabled ? 'Armed' : 'Not running',
      detail: nativeStatus?.enabled ? 'Android can detect trips in the background.' : 'Background auto tracking is not armed.',
    },
    {
      id: 'location',
      label: 'Location',
      status: permissionStatus?.foregroundLocation === 'granted' ? 'good' : 'bad',
      value: permissionStatus?.foregroundLocation || 'unknown',
      detail: 'Needed for speed, route, stops, parking, and maps.',
    },
    {
      id: 'background',
      label: 'Background location',
      status: permissionStatus?.backgroundLocation === 'granted' ? 'good' : 'warn',
      value: permissionStatus?.backgroundLocation || 'unknown',
      detail: 'Needed for reliable auto tracking while the app is closed.',
    },
    {
      id: 'activity',
      label: 'Physical activity',
      status: permissionStatus?.activityRecognition === 'granted' ? 'good' : 'warn',
      value: permissionStatus?.activityRecognition || 'unknown',
      detail: 'Helps tell driving apart from walking and parked time.',
    },
    {
      id: 'motion',
      label: 'Motion sensors',
      status: permissionStatus?.motionSensors === 'granted' ? 'good' : permissionStatus?.motionSensors === 'unavailable' ? 'warn' : 'warn',
      value: permissionStatus?.motionSensors || 'unknown',
      detail: 'Used for sensor fusion, phone movement, harsh event confirmation, and possible incident detection.',
    },
    {
      id: 'notifications',
      label: 'Notifications',
      status: permissionStatus?.notifications === 'granted' ? 'good' : 'warn',
      value: permissionStatus?.notifications || 'unknown',
      detail: 'Needed for live safety warnings, trip summaries, coaching, maintenance, and background tracking notices.',
    },
    {
      id: 'bluetooth',
      label: 'Bluetooth / OBD-II',
      status: permissionStatus?.bluetooth === 'unavailable' ? 'warn' : 'good',
      value: permissionStatus?.bluetooth || 'unknown',
      detail: 'Optional. Used only when pairing a compatible OBD-II adapter.',
    },
    {
      id: 'battery',
      label: 'Battery mode',
      status: batteryStatus?.batteryOptimizationIgnored ? 'good' : 'warn',
      value: batteryStatus?.batteryOptimizationIgnored ? 'Unrestricted' : 'May restrict',
      detail: 'Restricted battery mode can delay auto-start after parking.',
    },
    {
      id: 'usage',
      label: 'Phone Usage Access',
      status: permissionStatus?.phoneUsageAccess === 'granted' ? 'good' : 'warn',
      value: permissionStatus?.phoneUsageAccess || 'unknown',
      detail: 'Optional, but makes phone-use detection use real foreground app activity.',
    },
    {
      id: 'latest-trip',
      label: 'Latest trip end',
      status: latestTrip?.parking_stop_detected ? 'good' : latestTrip ? 'warn' : 'unknown',
      value: latestTrip ? (latestTrip.parking_stop_detected ? 'Parked' : 'Not parked') : 'No trips',
      detail: latestTrip ? `Ended ${latestTrip.end_time ? new Date(latestTrip.end_time).toLocaleString() : 'recently'}.` : 'No completed trip found.',
    },
  ];
  return checks;
}

function formatDecisionTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'recently';
  return date.toLocaleString();
}

function humanReason(reason) {
  return reason ? String(reason).replace(/_/g, ' ') : null;
}

function latestTrackingDecision(events = []) {
  const decisionTypes = new Set([
    'auto_blocked',
    'candidate_started',
    'candidate_confirmed',
    'candidate_hidden_parking_cooldown',
    'auto_start',
    'trip_started',
    'trip_discarded',
    'auto_stop',
    'ending_review',
    'tail_trimmed',
    'trip_ended',
    'service_armed',
    'armed_location_watch',
  ]);
  return asArray(events)
    .filter((event) => decisionTypes.has(event.type))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] || null;
}

export function buildDashboardTrackingExplanation(/** @type {any} */ {
  settings = {},
  permissionStatus = {},
  nativeStatus = {},
  batteryStatus = {},
  diagnostics = {},
  latestTrip = null,
  tracking = false,
  currentSpeedKmh = null,
  currentActivity = null,
  isAndroidPlatform = false,
} = {}) {
  const mode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');
  const autoEnabled = !settings.tracking_paused && (
    settings.auto_tracking_enabled ||
    mode === 'auto_detect' ||
    mode === 'background_auto'
  );
  const backgroundAuto = mode === 'background_auto';
  const foregroundLocation = permissionStatus?.foregroundLocation || (settings.location_permission_granted ? 'granted' : 'unknown');
  const backgroundLocation = permissionStatus?.backgroundLocation || (settings.background_location_granted ? 'granted' : 'unknown');
  const activityRecognition = permissionStatus?.activityRecognition || (settings.activity_permission_granted ? 'granted' : 'unknown');
  const notifications = permissionStatus?.notifications || (settings.notification_permission_granted ? 'granted' : 'unknown');
  const blockerDetails = [];
  const nativeArmed = !backgroundAuto || !isAndroidPlatform || nativeStatus?.enabled === true;
  const batteryClear = !backgroundAuto || !isAndroidPlatform || batteryStatus?.batteryOptimizationIgnored === true;

  if (mode === 'paused') {
    blockerDetails.push('Tracking is paused in Settings.');
  }
  if (autoEnabled && foregroundLocation !== 'granted') {
    blockerDetails.push('Location permission is not granted, so Road Sage cannot confirm speed or route movement.');
  }
  if (autoEnabled && isAndroidPlatform && activityRecognition !== 'granted') {
    blockerDetails.push('Physical Activity permission is not granted, so Android cannot tell the app you are in a vehicle.');
  }
  if (backgroundAuto && backgroundLocation !== 'granted') {
    blockerDetails.push('Background location is not granted, so trips may not start while the app is closed.');
  }
  if (backgroundAuto && notifications !== 'granted') {
    blockerDetails.push('Notifications are not granted, so Android may block the persistent background tracking service.');
  }
  if (backgroundAuto && isAndroidPlatform && nativeStatus && nativeStatus.enabled === false) {
    blockerDetails.push('The Android background tracking service is not armed.');
  }
  if (backgroundAuto && batteryStatus && batteryStatus.batteryOptimizationIgnored === false) {
    blockerDetails.push('Battery optimization may delay or stop background auto-start checks.');
  }

  const lastDecision = latestTrackingDecision(diagnostics?.events);
  const speedText = Number.isFinite(Number(currentSpeedKmh))
    ? `${Math.round(Number(currentSpeedKmh))} km/h`
    : 'no current speed';
  const activityLabel = currentActivity?.type || currentActivity?.activity || null;
  const reason = humanReason(lastDecision?.reason);
  const facts = [
    autoEnabled ? `Mode: ${backgroundAuto ? 'Background auto' : mode === 'auto_detect' ? 'Auto-detect' : 'Auto enabled'}` : `Mode: ${mode === 'manual' ? 'Manual' : mode}`,
    `Location: ${foregroundLocation}`,
    isAndroidPlatform ? `Activity: ${activityRecognition}` : null,
    backgroundAuto ? `Background: ${backgroundLocation}` : null,
    backgroundAuto ? `Notifications: ${notifications}` : null,
    backgroundAuto && isAndroidPlatform ? `Native service: ${nativeStatus?.enabled ? 'armed' : 'not armed'}` : null,
    backgroundAuto && isAndroidPlatform ? `Battery: ${batteryStatus?.batteryOptimizationIgnored ? 'unrestricted' : 'may restrict'}` : null,
    Number.isFinite(Number(currentSpeedKmh)) ? `Current speed: ${speedText}` : null,
    activityLabel ? `Current activity: ${activityLabel}` : null,
  ].filter(Boolean);
  const allRequiredReady = autoEnabled &&
    foregroundLocation === 'granted' &&
    (!isAndroidPlatform || activityRecognition === 'granted') &&
    (!backgroundAuto || backgroundLocation === 'granted') &&
    (!backgroundAuto || notifications === 'granted') &&
    nativeArmed &&
    batteryClear;
  const movingFastEnough = Number(currentSpeedKmh) >= AUTO_START_SPEED_KMH;
  const advancedFacts = [
    allRequiredReady ? 'All required setup checks are green.' : null,
    movingFastEnough ? 'GPS is moving fast enough for fallback detection.' : 'GPS is not showing sustained driving speed yet.',
    isAndroidPlatform && !activityLabel ? 'Waiting for Android activity callback; GPS fallback can still start after sustained movement.' : null,
    backgroundAuto ? 'If the app was force-stopped by Android or the phone was rebooted, open Road Sage once to re-arm background detection.' : null,
  ].filter(Boolean);

  if (tracking) {
    return {
      status: 'good',
      headline: 'Tracking started',
      detail: 'Road Sage is recording this trip now.',
      facts,
      lastDecision,
    };
  }

  if (!autoEnabled) {
    return {
      status: mode === 'paused' ? 'bad' : 'warn',
      headline: mode === 'paused' ? 'Tracking will not start' : 'Auto tracking is off',
      detail: mode === 'paused'
        ? 'Unpause tracking in Settings before manual or automatic trips can start.'
        : 'Manual mode will not start trips by itself. Tap Start Trip or switch to auto-detect/background auto.',
      facts,
      lastDecision,
    };
  }

  if (blockerDetails.length > 0) {
    return {
      status: blockerDetails.some((detail) => detail.includes('not granted') || detail.includes('paused')) ? 'bad' : 'warn',
      headline: 'Auto tracking did not start',
      detail: blockerDetails[0],
      facts: [...facts, ...blockerDetails.slice(1)],
      lastDecision,
    };
  }

  if (lastDecision?.type === 'trip_discarded') {
    return {
      status: 'warn',
      headline: 'Last auto trip was ignored',
      detail: reason === 'auto too short'
        ? 'Road Sage detected movement, but the trip was too short to save as real driving.'
        : reason
          ? `The last candidate was discarded because ${reason}.`
        : `The last trip was discarded${reason ? ` because ${reason}` : ''}.`,
      facts,
      lastDecision,
    };
  }

  if (lastDecision?.type === 'candidate_started' || lastDecision?.type === 'candidate_hidden_parking_cooldown') {
    return {
      status: 'warn',
      headline: 'Checking movement',
      detail: lastDecision.type === 'candidate_hidden_parking_cooldown'
        ? 'Road Sage started a hidden candidate near the parked location and is waiting for stronger vehicle-like proof before saving it.'
        : 'Road Sage started a hidden candidate and will save it only if the movement proves vehicle-like.',
      facts,
      lastDecision,
    };
  }

  if (lastDecision?.type === 'tail_trimmed') {
    return {
      status: 'good',
      headline: 'Parked tail trimmed',
      detail: 'Road Sage removed likely walking or GPS drift after parking before saving the trip map and score.',
      facts,
      lastDecision,
    };
  }

  if (lastDecision?.type === 'auto_start' || (lastDecision?.type === 'trip_started' && lastDecision?.reason === 'auto_detection')) {
    return {
      status: 'good',
      headline: 'Last auto start succeeded',
      detail: `Auto tracking started ${formatDecisionTime(lastDecision.timestamp)}${reason ? ` because ${reason}` : ''}.`,
      facts,
      lastDecision,
    };
  }

  if (latestTrip?.start_source === 'auto' || latestTrip?.start_source === 'native_auto') {
    return {
      status: 'good',
      headline: 'Latest trip auto-started',
      detail: `The latest saved trip started from ${latestTrip.start_source === 'native_auto' ? 'Android background auto tracking' : 'in-app auto detection'}.`,
      facts,
      lastDecision,
    };
  }

  return {
    status: 'warn',
    headline: allRequiredReady ? 'Ready, but no drive signal yet' : 'Waiting for a drive signal',
    detail: allRequiredReady
      ? `Permissions and services are ready. Road Sage will start when it sees in-vehicle activity or about ${AUTO_START_GPS_FALLBACK_SECONDS} seconds of sustained GPS movement at or above ${AUTO_START_SPEED_KMH} km/h. Current reading: ${speedText}.`
      : isAndroidPlatform
        ? `Auto tracking is armed. It starts when Android reports in-vehicle activity or sustained GPS movement. Current reading: ${speedText}.`
        : `Auto tracking is armed. It starts after sustained GPS movement. Current reading: ${speedText}.`,
    facts: [...facts, ...advancedFacts],
    lastDecision,
  };
}
