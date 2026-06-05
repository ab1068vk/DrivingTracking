const UNKNOWN_ALERT_KEY = 'general';

const VOICE_ALERT_MESSAGE_CATALOG = Object.freeze({
  general: Object.freeze({
    title: 'Safety alert',
    messages: Object.freeze([
      () => 'Safety alert. Check Road Sage when it is safe.',
      () => 'Safety alert. Please review the drive status when it is safe.',
    ]),
  }),
  speeding: Object.freeze({
    title: 'Speed warning',
    messages: Object.freeze([
      (context) => buildSpeedingMessage(context, 'Speed warning. Ease back to the limit.'),
      (context) => buildSpeedingMessage(context, 'Speed warning. Slow down smoothly.'),
    ]),
  }),
  harsh_brake: Object.freeze({
    title: 'Hard braking',
    messages: Object.freeze([
      () => 'Hard braking detected. Leave more room ahead.',
      () => 'Hard braking detected. Smooth inputs help your score.',
    ]),
  }),
  rapid_accel: Object.freeze({
    title: 'Rapid acceleration',
    messages: Object.freeze([
      () => 'Rapid acceleration detected. Accelerate smoothly.',
      () => 'Quick acceleration detected. Keep it steady.',
    ]),
  }),
  cornering: Object.freeze({
    title: 'Sharp cornering',
    messages: Object.freeze([
      () => 'Sharp cornering detected. Slow before the turn.',
      () => 'Cornering alert. Keep the turn smooth.',
    ]),
  }),
  phone_use: Object.freeze({
    title: 'Phone use',
    messages: Object.freeze([
      () => 'Phone use detected. Keep your eyes on the road.',
      () => 'Phone distraction warning. Handle it when parked.',
    ]),
  }),
  fatigue: Object.freeze({
    title: 'Fatigue reminder',
    messages: Object.freeze([
      () => 'Long drive reminder. Consider a break soon.',
      () => 'Fatigue reminder. Take a break when you can.',
    ]),
  }),
  tracking_ready: Object.freeze({
    title: 'Tracking ready',
    messages: Object.freeze([
      () => 'Road Sage is ready to track.',
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
  tired: 'fatigue',
  long_drive: 'fatigue',
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

function buildSpeedingMessage(context, fallback) {
  const speed = formatKmh(context.speedKmh);
  const limit = formatKmh(context.speedLimitKmh);
  const overLimit = formatKmh(context.overLimitKmh);

  if (speed && limit) {
    return `Speed warning. You are at ${speed} in a ${limit} zone. Ease back smoothly.`;
  }

  if (overLimit) {
    return `Speed warning. You are about ${overLimit} over the limit. Ease back smoothly.`;
  }

  return fallback;
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
