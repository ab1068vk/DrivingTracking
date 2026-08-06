const UNKNOWN_ALERT_KEY = 'general';
export const VOICE_ALERT_MESSAGE_STYLES = Object.freeze({
  MODE_DEFAULT: 'mode_default',
  COACHING: 'coaching',
  TECHNICAL: 'technical',
});

// CHANGES (session):
// - Added VOICE_COOLDOWNS_BY_TIER and TIER_EVENT_LABELS.
// - Modified buildSpeedingMessage to export tier-aware voice wording while preserving legacy catalog behavior.
// - Renamed regional default wording to REGION_DEFAULT and softened regional default messages.
// - Ensured non-posted legacy speed messages use speed-check coaching wording.
// - Updated REGION_DEFAULT voice wording and removed forbidden certainty terms from estimated tiers.
// - Updated REGION_DEFAULT event label to "no posted sign confirmed" wording.

// Defined in src/lib/speed/speedTierNames.js; re-exported here for the existing
// import sites. It used to be a second literal that could drift from the first.
export { VOICE_COOLDOWNS_BY_TIER } from '@/lib/speed/speedTierNames';

export const TIER_EVENT_LABELS = Object.freeze({
  POSTED: 'Posted speed limit (OSM or user-confirmed)',
  MAP_ESTIMATED: 'Road-type estimate — check posted signs',
  LEARNED_LOCAL: 'Learned from past trips on this road',
  REGION_DEFAULT: 'Regional default estimate — no posted sign confirmed',
  GPS_INFERRED: 'Inferred from traffic — may not reflect posted limit; reduced penalty weight',
  UNKNOWN: 'Speed limit unavailable',
});

const VOICE_ALERT_MESSAGE_CATALOG = Object.freeze({
  general: Object.freeze({
    title: 'Safety alert',
    messages: Object.freeze([
      () => 'Safety alert. Check Road Sage when it is safe to do so.',
      () => 'Safety alert. Review the drive status when it is safe.',
    ]),
  }),
  speeding: Object.freeze({
    title: 'Speed check',
    messages: Object.freeze([
      (context) => buildSpeedingMessage(context, 'Speed check. Ease off and check posted signs.'),
      (context) => buildSpeedingMessage(context, 'Speed check. Bring your speed down smoothly and check posted signs.'),
    ]),
  }),
  harsh_brake: Object.freeze({
    title: 'Hard braking',
    messages: Object.freeze([
      () => 'Hard braking detected. Open your following space and brake earlier.',
      () => 'Hard braking detected. Ease in sooner and keep more room ahead.',
    ]),
  }),
  rapid_accel: Object.freeze({
    title: 'Rapid acceleration',
    messages: Object.freeze([
      () => 'Rapid acceleration detected. Ease into the throttle.',
      () => 'Quick acceleration detected. Keep the launch smooth and steady.',
    ]),
  }),
  cornering: Object.freeze({
    title: 'Sharp cornering',
    messages: Object.freeze([
      () => 'Sharp cornering detected. Slow before the turn and steer smoothly.',
      () => 'Cornering alert. Ease off before the bend and keep it smooth.',
    ]),
  }),
  phone_use: Object.freeze({
    title: 'Phone activity',
    messages: Object.freeze([
      () => 'Phone activity detected. Eyes on the road. Review it when parked.',
      () => 'Phone activity detected. Eyes forward. Review it when parked.',
    ]),
  }),
  close_proximity: Object.freeze({
    title: 'Brake-turn manoeuvre',
    messages: Object.freeze([
      () => 'Close manoeuvre detected. Create space, then review conditions when safe.',
      () => 'Brake-turn alert. Ease off and keep extra room ahead.',
    ]),
  }),
  heading_drift_beta: Object.freeze({
    title: 'Attention pattern',
    messages: Object.freeze([
      () => 'Attention pattern recorded. Keep your eyes up and plan a break if you feel tired.',
      () => 'Heading variation recorded. Stay alert and consider a break soon.',
    ]),
  }),
  stop_start_pattern: Object.freeze({
    title: 'Stop-start pattern',
    messages: Object.freeze([
      () => 'Repeated stop-start pattern recorded. Add space ahead and keep inputs smooth.',
      () => 'Stop-start pattern detected. Smooth spacing can help.',
    ]),
  }),
  idle: Object.freeze({
    title: 'Idling reminder',
    messages: Object.freeze([
      () => 'Extended idling recorded. Move off smoothly when traffic clears.',
      () => 'Idling reminder. Keep the trip moving when conditions allow.',
    ]),
  }),
  fatigue: Object.freeze({
    title: 'Fatigue reminder',
    messages: Object.freeze([
      () => 'Long drive reminder. Plan a break soon when it is safe.',
      () => 'Fatigue reminder. Take a break when you can.',
    ]),
  }),
  repeated_event_area: Object.freeze({
    title: 'Repeated event area',
    messages: Object.freeze([
      (context) => buildRepeatedEventAreaMessage(context),
      () => 'Repeated event area ahead. Stay alert and give yourself extra space.',
    ]),
  }),
  possible_incident: Object.freeze({
    title: 'Possible incident',
    messages: Object.freeze([
      (context) => buildPossibleIncidentMessage(context),
      () => 'Possible incident signal recorded. Check in when you can.',
    ]),
  }),
  tracking_ready: Object.freeze({
    title: 'Tracking ready',
    messages: Object.freeze([
      () => 'Road Sage is tracking and voice alerts are ready.',
      () => 'Tracking is ready. Drive safely.',
    ]),
  }),
  tracking_blocked: Object.freeze({
    title: 'Tracking blocked',
    messages: Object.freeze([
      (context) => buildTrackingBlockedMessage(context),
      () => 'Tracking did not start. Check permissions in Road Sage.',
    ]),
  }),
});

const TECHNICAL_VOICE_ALERT_MESSAGE_CATALOG = Object.freeze({
  general: Object.freeze({
    title: 'Telemetry alert',
    messages: Object.freeze([
      () => 'Telemetry alert recorded. Check Road Sage when available.',
      () => 'Telemetry alert recorded. Review the drive status when available.',
    ]),
  }),
  speeding: Object.freeze({
    title: 'Speed threshold',
    messages: Object.freeze([
      (context) => buildSpeedingMessage(context, 'Speed threshold exceeded.', { style: 'technical' }),
      (context) => buildSpeedingMessage(context, 'Speed threshold exceeded. Verify posted signs.', { style: 'technical' }),
    ]),
  }),
  harsh_brake: Object.freeze({
    title: 'Hard braking event',
    messages: Object.freeze([
      () => 'Hard braking event recorded.',
      () => 'Hard braking threshold exceeded.',
    ]),
  }),
  rapid_accel: Object.freeze({
    title: 'Acceleration event',
    messages: Object.freeze([
      () => 'Acceleration threshold exceeded.',
      () => 'Rapid acceleration event recorded.',
    ]),
  }),
  cornering: Object.freeze({
    title: 'Cornering event',
    messages: Object.freeze([
      () => 'Cornering threshold exceeded.',
      () => 'Lateral movement event recorded.',
    ]),
  }),
  phone_use: Object.freeze({
    title: 'Phone activity window',
    messages: Object.freeze([
      (context) => buildPhoneUseTechnicalMessage(context),
      () => 'Phone-use window detected.',
    ]),
  }),
  close_proximity: Object.freeze({
    title: 'Brake-turn event',
    messages: Object.freeze([
      () => 'Brake-turn manoeuvre pattern recorded.',
      () => 'Close manoeuvre telemetry recorded.',
    ]),
  }),
  heading_drift_beta: Object.freeze({
    title: 'Heading pattern',
    messages: Object.freeze([
      () => 'GPS heading pattern recorded.',
      () => 'Heading variation threshold exceeded.',
    ]),
  }),
  stop_start_pattern: Object.freeze({
    title: 'Stop-start pattern',
    messages: Object.freeze([
      () => 'Stop-start pattern recorded.',
      () => 'Repeated stop-start threshold exceeded.',
    ]),
  }),
  idle: Object.freeze({
    title: 'Idle event',
    messages: Object.freeze([
      () => 'Idle duration threshold exceeded.',
      () => 'Extended idle event recorded.',
    ]),
  }),
  fatigue: Object.freeze({
    title: 'Drive duration',
    messages: Object.freeze([
      () => 'Drive duration threshold exceeded.',
      () => 'Long-drive threshold recorded.',
    ]),
  }),
  repeated_event_area: Object.freeze({
    title: 'Repeated event area',
    messages: Object.freeze([
      (context) => buildRepeatedEventAreaTechnicalMessage(context),
      () => 'Repeated event area recorded ahead.',
    ]),
  }),
  possible_incident: Object.freeze({
    title: 'Possible incident signal',
    messages: Object.freeze([
      (context) => buildPossibleIncidentTechnicalMessage(context),
      () => 'Possible incident signal recorded.',
    ]),
  }),
  tracking_ready: Object.freeze({
    title: 'Tracking ready',
    messages: Object.freeze([
      () => 'Recording active. Voice alert delivery ready.',
      () => 'Tracking active. Voice alert channel ready.',
    ]),
  }),
  tracking_blocked: Object.freeze({
    title: 'Tracking unavailable',
    messages: Object.freeze([
      (context) => buildTrackingBlockedTechnicalMessage(context),
      () => 'Tracking unavailable. Source unavailable.',
    ]),
  }),
});

const ALERT_KEY_ALIASES = Object.freeze({
  speed: 'speeding',
  speed_limit: 'speeding',
  over_speed: 'speeding',
  brake: 'harsh_brake',
  hard_brake: 'harsh_brake',
  harsh_braking: 'harsh_brake',
  accel: 'rapid_accel',
  acceleration: 'rapid_accel',
  rapid_acceleration: 'rapid_accel',
  turn: 'cornering',
  sharp_turn: 'cornering',
  distraction: 'phone_use',
  phone: 'phone_use',
  close: 'close_proximity',
  close_proximity_alert: 'close_proximity',
  brake_turn: 'close_proximity',
  heading_drift: 'heading_drift_beta',
  attention_pattern: 'heading_drift_beta',
  stop_start: 'stop_start_pattern',
  stop_go: 'stop_start_pattern',
  idling: 'idle',
  tired: 'fatigue',
  long_drive: 'fatigue',
  event_area: 'repeated_event_area',
  repeated_area: 'repeated_event_area',
  repeated_event: 'repeated_event_area',
  hazard_area: 'repeated_event_area',
  crash: 'possible_incident',
  incident: 'possible_incident',
  possible_crash: 'possible_incident',
  ready: 'tracking_ready',
  blocked: 'tracking_blocked',
  tracking_issue: 'tracking_blocked',
});

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatKmh(value) {
  const number = finiteNumber(value);
  return number === null ? null : `${Math.round(number)} kilometers per hour`;
}

function formatShortKmh(value) {
  const number = finiteNumber(value);
  return number === null ? null : `${Math.round(number)} km/h`;
}

function humanizeEventType(value) {
  const label = normalizeSpaces(String(value || '').replace(/_/g, ' '));
  return label || 'risk event';
}

function resolveRequestedStyle(settingsOrOptions = {}, options = {}) {
  const settings = options.settings || settingsOrOptions.settings || settingsOrOptions;
  const explicit = options.style || settingsOrOptions.style || settings?.voice_alert_style;
  if (explicit === VOICE_ALERT_MESSAGE_STYLES.COACHING) return VOICE_ALERT_MESSAGE_STYLES.COACHING;
  if (explicit === VOICE_ALERT_MESSAGE_STYLES.TECHNICAL) return VOICE_ALERT_MESSAGE_STYLES.TECHNICAL;
  const mode = settings?.experience_mode || settingsOrOptions.experience_mode;
  return mode === 'tracking'
    ? VOICE_ALERT_MESSAGE_STYLES.TECHNICAL
    : VOICE_ALERT_MESSAGE_STYLES.COACHING;
}

export function resolveVoiceAlertMessageStyle(settings = {}, options = {}) {
  return resolveRequestedStyle(settings, options);
}

function buildTechnicalSpeedingMessage(context = {}, fallback = null) {
  const speed = formatShortKmh(context.speedKmh);
  const limit = formatShortKmh(context.speedLimitKmh);
  const overLimit = formatShortKmh(context.overLimitKmh);
  if (speed && limit) {
    const source = context.tier === 'POSTED' ||
      context.speedLimitSource === 'openstreetmap' ||
      context.speedLimitSource === 'user_confirmed_posted_sign'
      ? 'posted'
      : 'estimated';
    return `Speed threshold exceeded: ${speed} in ${source} ${limit} zone.`;
  }
  if (overLimit) return `Speed threshold exceeded: ${overLimit} over threshold.`;
  if (context.tier && context.tier !== 'POSTED') return 'Route speed source is estimated; check posted signs.';
  return fallback;
}

export function buildSpeedingMessage(context = {}, fallback = null, options = {}) {
  if (resolveRequestedStyle(context, options) === VOICE_ALERT_MESSAGE_STYLES.TECHNICAL) {
    return buildTechnicalSpeedingMessage(context, fallback);
  }

  if (context.tier) {
    const speed = `${Math.round(Number(context.speedKmh) || 0)} km/h`;
    const limit = context.speedLimitKmh ? `${Math.round(Number(context.speedLimitKmh))} km/h` : null;

    switch (context.tier) {
      case 'POSTED':
        return limit
          ? `Speed warning. You are at ${speed} in a posted ${limit} zone. Ease off smoothly.`
          : 'Speed warning. Ease off and settle back.';
      case 'MAP_ESTIMATED':
        return limit
          ? `Speed check. Estimated ${limit} road-type zone. Check posted signs.`
          : 'Speed check. Ease off and check signs.';
      case 'LEARNED_LOCAL':
        return limit
          ? `Speed check. This road is usually around ${limit}. Check posted signs and ease off smoothly.`
          : 'Speed check. Ease off and check signs.';
      case 'REGION_DEFAULT':
        return limit
          ? `Speed check. This area is estimated around ${limit}. Check posted signs.`
          : 'Speed check. Ease off and check posted signs.';
      case 'GPS_INFERRED':
        return 'Speed check. Road speed is uncertain. Ease off and check signs.';
      default:
        return null;
    }
  }

  const speed = formatKmh(context.speedKmh);
  const limit = formatKmh(context.speedLimitKmh);
  const overLimit = formatKmh(context.overLimitKmh);
  const source = context.speedLimitSource || context.limitSource;
  const postedSource = source === 'openstreetmap' || source === 'user_confirmed_posted_sign';
  const estimatedSource = context.limitIsEstimated || !postedSource;

  if (speed && limit) {
    if (estimatedSource) {
      return `Speed check. You are at ${speed} in an estimated ${limit} zone. Check posted signs.`;
    }
    return `Speed warning. You are at ${speed} in a posted ${limit} zone. Ease off smoothly.`;
  }

  if (overLimit) {
    if (estimatedSource) {
      return `Speed check. You are about ${overLimit} over the estimated zone. Check posted signs.`;
    }
    return `Speed warning. You are about ${overLimit} over the limit. Ease off smoothly.`;
  }

  return fallback;
}

function buildRepeatedEventAreaMessage(context) {
  const eventType = humanizeEventType(context.eventType || context.type || context.dominantType);
  const distance = finiteNumber(context.distanceM);
  if (distance !== null && distance > 0) {
    return `Repeated ${eventType} area about ${Math.round(distance)} meters ahead. Slow your scan and keep extra space.`;
  }
  return `Repeated ${eventType} area ahead. Stay alert and keep extra space.`;
}

function buildRepeatedEventAreaTechnicalMessage(context) {
  const eventType = humanizeEventType(context.eventType || context.type || context.dominantType);
  const distance = finiteNumber(context.distanceM);
  if (distance !== null && distance > 0) {
    return `Repeated ${eventType} area recorded about ${Math.round(distance)} meters ahead.`;
  }
  return `Repeated ${eventType} area recorded ahead.`;
}

function buildPossibleIncidentMessage(context) {
  if (context.emergencyWorkflow) {
    return 'Possible incident signal recorded. Emergency check-in is active until you review the trip.';
  }
  return 'Possible incident signal recorded. Check in now if you can.';
}

function buildPossibleIncidentTechnicalMessage(context) {
  if (context.emergencyWorkflow) {
    return 'Possible incident signal recorded. Emergency workflow active.';
  }
  return 'Possible incident signal recorded.';
}

function buildTrackingBlockedMessage(context) {
  const reason = normalizeSpaces(context.reason);
  if (reason) return `Tracking did not start. ${reason}`;
  return 'Tracking did not start. Check permissions and tracking mode.';
}

function buildTrackingBlockedTechnicalMessage(context) {
  const reason = normalizeSpaces(context.reason);
  if (reason) return `Tracking unavailable. ${reason}`;
  return 'Tracking unavailable. Source unavailable.';
}

function buildPhoneUseTechnicalMessage(context) {
  const source = context.source || context.evidenceSource || context.phoneUseSource;
  if (source === 'android_usage_access' || source === 'usage_access') {
    return 'Foreground phone activity detected from Android Usage Access.';
  }
  if (source === 'gps_proxy') {
    return 'Phone activity pattern detected from GPS diagnostic proxy.';
  }
  return 'Phone activity window detected.';
}

function clampMessageIndex(index, messageCount) {
  const number = Math.trunc(finiteNumber(index) ?? 0);
  return Math.max(0, Math.min(messageCount - 1, number));
}

export function normalizeVoiceAlertMessageKey(key) {
  const normalized = normalizeKey(key);
  const aliased = ALERT_KEY_ALIASES[normalized] || normalized;
  return VOICE_ALERT_MESSAGE_CATALOG[aliased] ? aliased : UNKNOWN_ALERT_KEY;
}

export function listVoiceAlertMessageKeys() {
  return Object.keys(VOICE_ALERT_MESSAGE_CATALOG);
}

export function getVoiceAlertMessageCatalog() {
  return VOICE_ALERT_MESSAGE_CATALOG;
}

export function getVoiceAlertMessageTitle(key) {
  const normalizedKey = normalizeVoiceAlertMessageKey(key);
  return VOICE_ALERT_MESSAGE_CATALOG[normalizedKey].title;
}

export function buildVoiceAlertMessage(key, context = {}, options = {}) {
  const normalizedKey = normalizeVoiceAlertMessageKey(key);
  const style = resolveRequestedStyle(options.settings || context.settings || context, options);
  const catalog = style === VOICE_ALERT_MESSAGE_STYLES.TECHNICAL
    ? TECHNICAL_VOICE_ALERT_MESSAGE_CATALOG
    : VOICE_ALERT_MESSAGE_CATALOG;
  const entry = catalog[normalizedKey] || catalog[UNKNOWN_ALERT_KEY];
  const messageIndex = clampMessageIndex(
    options.messageIndex ?? options.escalationLevel ?? context.escalationLevel,
    entry.messages.length
  );
  const message = entry.messages[messageIndex](context);
  return normalizeSpaces(message);
}
