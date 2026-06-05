// src/lib/voiceAlertMessages.js
// On-device only. No GPS coordinates, no network calls.

// Each key maps to [first-offense, second-offense, severe] message builders.
// Builders are functions so they can embed context values.
export const ALERT_MESSAGES = {
  phone_use: [
    () => 'Phone detected. Please focus on driving.',
    () => 'Phone use detected again. Eyes on the road.',
    () => 'Phone use recorded a third time. This is dangerous. Put the phone down.',
  ],

  close_proximity: [
    () => 'Following distance warning. Ease back from the vehicle ahead.',
    () => 'Close proximity again. Increase your following distance.',
    () => 'Repeated close proximity. Leave more space.',
  ],

  possible_incident: [
    (ctx) => ctx?.emergencyWorkflow
      ? 'Possible incident signal recorded. Emergency check-in is active until you end or review the trip.'
      : (ctx?.message ?? 'Possible incident detected. Check your surroundings.'),
    (ctx) => ctx?.emergencyWorkflow
      ? 'Another incident signal recorded. Emergency check-in remains active.'
      : (ctx?.message ?? 'Another incident signal. Stay alert.'),
    (ctx) => ctx?.emergencyWorkflow
      ? 'Repeated incident signals. Consider pulling over safely and reviewing the trip.'
      : (ctx?.message ?? 'Repeated incident signals. Consider pulling over safely.'),
  ],

  speeding: [
    (ctx) => {
      const speed = Math.round(ctx?.speedKmh ?? 0);
      const limit = Math.round(ctx?.limitKmh ?? 0);
      const over = Math.round(ctx?.overKmh ?? 0);
      if (limit > 0 && over > 0) {
        return `Speed warning. ${speed} kilometres per hour. ${over} over the limit.`;
      }
      return `Speed warning. ${speed} kilometres per hour.`;
    },
    (ctx) => {
      const speed = Math.round(ctx?.speedKmh ?? 0);
      const over = Math.round(ctx?.overKmh ?? 0);
      return over > 0
        ? `Still speeding. ${speed} kilometres per hour. ${over} over. Reduce speed now.`
        : `Still speeding. ${speed} kilometres per hour. Reduce speed now.`;
    },
    (ctx) => {
      const speed = Math.round(ctx?.speedKmh ?? 0);
      return `Speeding alert. ${speed} kilometres per hour. Please slow down.`;
    },
  ],

  harsh_brake: [
    () => 'Harsh braking detected. Try to brake earlier and more gradually.',
    () => 'Another harsh brake. Anticipate stops further ahead.',
    () => 'Repeated harsh braking. Maintain a longer following distance.',
  ],

  rapid_accel: [
    () => 'Rapid acceleration. Try to build speed more smoothly.',
    () => 'Aggressive acceleration again. Ease on the throttle.',
    () => 'Repeated hard acceleration. Smooth starts improve safety and fuel efficiency.',
  ],

  stop_start_pattern: [
    () => 'Repeated stop-start pattern recorded. Try to maintain a steadier pace.',
    () => 'Stop-start pattern again. Coasting more may help.',
    () => 'Frequent stop-start driving noted. Allow more space to the vehicle ahead.',
  ],

  heading_drift_beta: [
    () => 'Unusual steering pattern detected. Take a break when it is safe.',
    () => 'Steering variation pattern again. Consider stopping for a rest.',
    () => 'Repeated heading drift. Fatigue may be a factor. Please stop when safe.',
  ],

  long_drive: [
    (ctx) => `Long drive reminder. You have been driving for ${Math.round(ctx?.durationMins ?? 0)} minutes. Consider a short break.`,
    (ctx) => `Still driving after ${Math.round(ctx?.durationMins ?? 0)} minutes. A break improves alertness.`,
    (ctx) => `Over ${Math.round(ctx?.durationMins ?? 0)} minutes driving. Fatigue risk is high. Stop when it is safe.`,
  ],

  idle: [
    () => 'Extended idling recorded. Stopping the engine saves fuel.',
    () => 'Still idling. Engine-off is better for the environment and fuel costs.',
    () => 'Prolonged idle. Consider switching off the engine.',
  ],

  repeated_event_area: [
    (ctx) => `Repeated event area ahead. ${ctx?.typeLabel ?? 'A driving event'} was recorded here before.`,
    (ctx) => `${ctx?.typeLabel ?? 'Driving event'} area approaching again. Stay alert.`,
    (ctx) => `Repeated ${ctx?.typeLabel ?? 'event'} zone. Take extra care here.`,
  ],
};

export const ALERT_PRIORITY = {
  phone_use: 3,
  possible_incident: 3,
  close_proximity: 2,
  speeding: 2,
  harsh_brake: 2,
  heading_drift_beta: 2,
  rapid_accel: 1,
  stop_start_pattern: 1,
  long_drive: 1,
  repeated_event_area: 1,
  idle: 0,
};

export const SEVERITY_TTS = {
  3: { rate: 1.05, pitch: 1.1 },
  2: { rate: 0.95, pitch: 1.0 },
  1: { rate: 0.9, pitch: 0.95 },
  0: { rate: 0.85, pitch: 0.9 },
};

/**
 * Build a voice message for an alert type at a given escalation level.
 * @param {string} key Alert key (for example, "speeding").
 * @param {object} ctx Context values: speedKmh, limitKmh, overKmh, durationMins, typeLabel, message.
 * @param {number} escalation 0=first, 1=second, 2=severe.
 * @returns {string}
 */
export function buildAlertMessage(key, ctx = {}, escalation = 0) {
  const variants = ALERT_MESSAGES[key];
  if (!variants) return '';
  const idx = Math.max(0, Math.min(Math.floor(Number(escalation) || 0), variants.length - 1));
  try {
    return variants[idx](ctx) ?? '';
  } catch {
    return variants[0](ctx) ?? '';
  }
}

/**
 * Get the TTS parameters for an alert key, adjusted by user settings.
 */
export function buildTtsParams(key, settings = {}) {
  const priority = ALERT_PRIORITY[key] ?? 1;
  const base = SEVERITY_TTS[priority] ?? SEVERITY_TTS[1];
  const userRate = Number(settings.voice_alert_rate) || 1.0;
  const userVolume = Number(settings.voice_alert_volume) || 0.9;
  return {
    rate: parseFloat((base.rate * userRate).toFixed(2)),
    pitch: base.pitch,
    volume: Math.min(1, Math.max(0.1, userVolume)),
    earconEnabled: settings.voice_earcon_enabled !== false,
  };
}
