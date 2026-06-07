const UNKNOWN_ALERT_KEY = 'general';

const VOICE_ALERT_MESSAGE_CATALOG = Object.freeze({
  general: Object.freeze({
    title: 'Safety alert',
    messages: Object.freeze([
      () => 'Safety alert. Check Road Sage when it is safe to do so.',
      () => 'Safety alert. Review the drive status when it is safe.',
    ]),
  }),
  speeding: Object.freeze({
    title: 'Speed warning',
    messages: Object.freeze([
      (context) => buildSpeedingMessage(context, 'Speed warning. Ease off and settle back to the limit.'),
      (context) => buildSpeedingMessage(context, 'Speed warning. Bring your speed down smoothly.'),
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
    title: 'Phone use',
    messages: Object.freeze([
      () => 'Phone use detected. Keep your eyes up. Handle the phone only when parked.',
      () => 'Phone distraction warning. Eyes on the road; deal with it when parked.',
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

function humanizeEventType(value) {
  const label = normalizeSpaces(String(value || '').replace(/_/g, ' '));
  return label || 'risk event';
}

function buildSpeedingMessage(context, fallback) {
  const speed = formatKmh(context.speedKmh);
  const limit = formatKmh(context.speedLimitKmh);
  const overLimit = formatKmh(context.overLimitKmh);

  if (speed && limit) {
    const zoneLabel = context.limitIsEstimated || context.speedLimitSource === 'inferred'
      ? `an estimated ${limit} zone`
      : `a ${limit} zone`;
    return `Speed warning. You are at ${speed} in ${zoneLabel}. Ease off smoothly.`;
  }

  if (overLimit) {
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

function buildPossibleIncidentMessage(context) {
  if (context.emergencyWorkflow) {
    return 'Possible incident signal recorded. Emergency check-in is active until you review the trip.';
  }
  return 'Possible incident signal recorded. Check in now if you can.';
}

function buildTrackingBlockedMessage(context) {
  const reason = normalizeSpaces(context.reason);
  if (reason) return `Tracking did not start. ${reason}`;
  return 'Tracking did not start. Check permissions and tracking mode.';
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
  const entry = VOICE_ALERT_MESSAGE_CATALOG[normalizedKey];
  const messageIndex = clampMessageIndex(
    options.messageIndex ?? options.escalationLevel ?? context.escalationLevel,
    entry.messages.length
  );
  const message = entry.messages[messageIndex](context);
  return normalizeSpaces(message);
}
