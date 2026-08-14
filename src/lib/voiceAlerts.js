import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings, SETTINGS_CHANGED_EVENT } from '@/lib/trackingStore';
import NativeSpeech from '@/lib/driveSenseNativePlugin';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  buildVoiceAlertMessage,
  normalizeVoiceAlertMessageKey,
  resolveVoiceAlertMessageStyle,
} from '@/lib/voiceAlertMessages';

const lastSpokenAtByKey = new Map();
const DEFAULT_RATE = 0.92;
const DEFAULT_VOLUME = 0.95;
const DEFAULT_PITCH = 1;
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_QUEUE_MODE = 'add';

export const VOICE_ALERT_CONTROL_GROUPS = Object.freeze([
  Object.freeze({
    settingKey: 'voice_speed_alerts_enabled',
    label: 'Speed warnings',
    alerts: 'Speed-limit warnings',
  }),
  Object.freeze({
    settingKey: 'voice_driving_event_alerts_enabled',
    label: 'Driving event warnings',
    alerts: 'Harsh braking, rapid acceleration, sharp corners, close manoeuvres, stop/start patterns, repeated-event areas, and places you brake hard',
  }),
  Object.freeze({
    settingKey: 'voice_attention_incident_alerts_enabled',
    label: 'Attention and incident warnings',
    alerts: 'Phone use, heading drift, and possible incidents',
  }),
  Object.freeze({
    settingKey: 'voice_coaching_reminder_alerts_enabled',
    label: 'Coaching and reminders',
    alerts: 'Coach briefing, long-drive reminders, and extended-idle reminders',
  }),
]);

const ALERT_GROUP_SETTING_BY_KEY = Object.freeze({
  speeding: 'voice_speed_alerts_enabled',
  harsh_brake: 'voice_driving_event_alerts_enabled',
  rapid_accel: 'voice_driving_event_alerts_enabled',
  sharp_turn: 'voice_driving_event_alerts_enabled',
  sharp_cornering: 'voice_driving_event_alerts_enabled',
  close_proximity: 'voice_driving_event_alerts_enabled',
  close_manoeuvre: 'voice_driving_event_alerts_enabled',
  stop_start: 'voice_driving_event_alerts_enabled',
  stop_start_pattern: 'voice_driving_event_alerts_enabled',
  repeated_event_area: 'voice_driving_event_alerts_enabled',
  late_braking_pattern: 'voice_driving_event_alerts_enabled',
  phone_use: 'voice_attention_incident_alerts_enabled',
  heading_drift: 'voice_attention_incident_alerts_enabled',
  heading_drift_beta: 'voice_attention_incident_alerts_enabled',
  possible_incident: 'voice_attention_incident_alerts_enabled',
  long_drive: 'voice_coaching_reminder_alerts_enabled',
  fatigue: 'voice_coaching_reminder_alerts_enabled',
  idle: 'voice_coaching_reminder_alerts_enabled',
});

function settingIsEnabled(raw, defaultValue = true) {
  if (raw === false || raw === 0) return false;
  if (raw === true || raw === 1) return true;
  if (typeof raw !== 'string') return defaultValue;
  const value = raw.trim().toLowerCase();
  if (!value || value === 'undefined' || value === 'null') return defaultValue;
  return !['false', '0', 'off', 'no', 'disabled'].includes(value);
}

export function isVoiceAlertEnabled(settings = {}) {
  return settingIsEnabled(settings.voice_alerts_enabled);
}

export function isTripStartVoiceAlertEnabled(settings = {}) {
  return settingIsEnabled(settings.trip_start_voice_alert_enabled);
}

export function voiceAlertGroupSettingForKey(key) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  if (!normalizedKey) return null;
  if (normalizedKey.startsWith('speeding_')) return 'voice_speed_alerts_enabled';
  if (normalizedKey.startsWith('coach_program_brief_')) return 'voice_coaching_reminder_alerts_enabled';
  if (normalizedKey.startsWith('coach_program_')) {
    const matchedEventKey = Object.keys(ALERT_GROUP_SETTING_BY_KEY)
      .find((eventKey) => normalizedKey.endsWith(`_${eventKey}`));
    return matchedEventKey
      ? ALERT_GROUP_SETTING_BY_KEY[matchedEventKey]
      : 'voice_coaching_reminder_alerts_enabled';
  }
  const direct = ALERT_GROUP_SETTING_BY_KEY[normalizedKey];
  if (direct) return direct;
  // An alias used to resolve in the message catalog but not here, so it returned
  // null and isVoiceAlertTypeEnabled read that as "no group governs this" and
  // allowed it — an alias could speak with its group switched off. Direct keys
  // are matched first so no existing mapping changes; this only fills gaps.
  const aliased = normalizeVoiceAlertMessageKey(normalizedKey);
  return ALERT_GROUP_SETTING_BY_KEY[aliased] || null;
}

export function isVoiceAlertTypeEnabled(key, settings = {}) {
  if (!isVoiceAlertEnabled(settings)) return false;
  const settingKey = voiceAlertGroupSettingForKey(key);
  return settingKey ? settingIsEnabled(settings[settingKey]) : true;
}

export function shouldMuteWebViewVoiceForTrip(trip = {}, { isAndroidPlatform = false } = {}) {
  return isAndroidPlatform === true && (
    trip?.native_manual_background === true ||
    trip?.voice_alert_owner === 'native_android'
  );
}

export function getVoiceAlertDeliveryStatus({
  settings = localSettings.get(),
  trip = null,
  isAndroidPlatform = false,
  nativeStatus = null,
  tracking = false,
} = {}) {
  if (!isVoiceAlertEnabled(settings)) {
    const tripStartEnabled = isTripStartVoiceAlertEnabled(settings);
    return {
      status: 'disabled',
      label: 'Live alerts off',
      detail: tripStartEnabled
        ? 'Recurring live voice alerts are off; the one-time trip-start confirmation remains on.'
        : 'Live voice alerts and the trip-start confirmation are disabled in Settings.',
    };
  }

  const enabledGroupCount = VOICE_ALERT_CONTROL_GROUPS
    .filter((group) => settingIsEnabled(settings[group.settingKey]))
    .length;
  if (enabledGroupCount === 0) {
    return {
      status: 'groups_disabled',
      label: 'Recurring groups off',
      detail: isTripStartVoiceAlertEnabled(settings)
        ? 'All recurring voice groups are off; the one-time trip-start confirmation remains on.'
        : 'All recurring voice groups and the trip-start confirmation are off.',
    };
  }

  if (shouldMuteWebViewVoiceForTrip(trip, { isAndroidPlatform })) {
    return {
      status: 'native',
      label: 'Android native voice',
      detail: 'Android is handling spoken alerts from the background tracking service.',
    };
  }

  if (isAndroidPlatform && nativeStatus?.enabled === true && !tracking) {
    return {
      status: 'armed',
      label: 'Native service armed',
      detail: 'Android background auto tracking can speak alerts when a native trip starts.',
    };
  }

  if (tracking) {
    return {
      status: 'webview',
      label: 'App voice coach',
      detail: 'Spoken alerts are coming from the app while this trip is active.',
    };
  }

  return {
    status: 'ready',
    label: 'Voice alerts ready',
    detail: 'Road Sage will speak during active trips when alert conditions are met.',
  };
}

function normalizeSpeechParams(params = {}) {
  const rate = Number(params.rate);
  const pitch = Number(params.pitch);
  const volume = Number(params.volume);
  const interrupt = params.interrupt === true || params.queueMode === 'flush';
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_RATE,
    pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : DEFAULT_PITCH,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULT_VOLUME,
    language: DEFAULT_LANGUAGE,
    interrupt,
    queueMode: interrupt ? 'flush' : DEFAULT_QUEUE_MODE,
  };
}

export function canSpeakSafetyAlert(key, cooldownMs = 0, now = Date.now()) {
  if (!key || !cooldownMs) return true;
  const last = lastSpokenAtByKey.get(key);
  if (!last) return true;
  return now - last >= cooldownMs;
}

export function markSafetyAlertSpoken(key, now = Date.now()) {
  if (key) lastSpokenAtByKey.set(key, now);
}

export async function speakSafetyAlert(text, settings = localSettings.get(), speechParams = {}) {
  const message = String(text || '').trim();
  const alertKey = speechParams.alertKey || '';
  if (!message || !isVoiceAlertEnabled(settings)) return false;
  if (alertKey && !isVoiceAlertTypeEnabled(alertKey, settings)) return false;
  const tuning = normalizeSpeechParams(speechParams);

  if (isNativePlatform()) {
    const nativeSpeak = typeof NativeSpeech?.speakText === 'function'
      ? NativeSpeech.speakText.bind(NativeSpeech)
      : typeof NativeSpeech?.speak === 'function'
        ? NativeSpeech.speak.bind(NativeSpeech)
        : null;

    try {
      if (nativeSpeak) {
        await nativeSpeak({ text: message, ...tuning });
        recordSystemEvent('voice_alert_spoken', {
          channel: 'native_plugin',
          message_length: message.length,
          interrupt: tuning.interrupt,
          queue_mode: tuning.queueMode,
        }, { category: 'notification', title: 'Voice alert queued' });
        return true;
      }
    } catch (error) {
      logSystemFailure('voice_alert_speech_output', error, {
        native_platform: true,
        message_length: message.length,
      });
      return false;
    }
  }

  if (typeof window === 'undefined') {
    recordSystemEvent('voice_alert_unavailable', {
      reason: 'window_unavailable',
    }, { category: 'notification', severity: 'warn', title: 'Voice alert unavailable' });
    return false;
  }
  if (!window.speechSynthesis) {
    recordSystemEvent('voice_alert_unavailable', {
      reason: 'speech_synthesis_unavailable',
    }, { category: 'notification', severity: 'warn', title: 'Voice alert unavailable' });
    return false;
  }
  const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
  if (!Utterance) {
    recordSystemEvent('voice_alert_unavailable', {
      reason: 'utterance_unavailable',
    }, { category: 'notification', severity: 'warn', title: 'Voice alert unavailable' });
    return false;
  }

  const utterance = new Utterance(message);
  utterance.rate = tuning.rate;
  utterance.pitch = tuning.pitch;
  utterance.volume = tuning.volume;
  utterance.lang = tuning.language;
  if (tuning.interrupt) {
    window.speechSynthesis.cancel();
  }
  window.speechSynthesis.speak(utterance);
  recordSystemEvent('voice_alert_spoken', {
    channel: 'web_speech',
    message_length: message.length,
    interrupt: tuning.interrupt,
    queue_mode: tuning.queueMode,
  }, { category: 'notification', title: 'Voice alert queued' });
  return true;
}

export async function stopSafetyAlerts() {
  resetSafetyAlertCooldowns();

  if (isNativePlatform() && typeof NativeSpeech?.stopSpeech === 'function') {
    try {
      await NativeSpeech.stopSpeech();
    } catch {
      // Browser speech may still be active in hybrid fallback scenarios.
    }
  }

  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

export async function speakSafetyAlertOnce(key, text, settings = localSettings.get(), cooldownMs = 0, now = Date.now(), speechParams = {}) {
  if (!isVoiceAlertTypeEnabled(key, settings) || !canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, settings, { ...speechParams, alertKey: key });
  if (spoken && key) markSafetyAlertSpoken(key, now);
  return spoken;
}

export async function speakTripStartConfirmationOnce(
  text,
  settings = localSettings.get(),
  cooldownMs = 0,
  now = Date.now(),
  speechParams = {}
) {
  const key = 'tracking_ready';
  if (!isTripStartVoiceAlertEnabled(settings) || !canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, {
    ...settings,
    voice_alerts_enabled: true,
  }, speechParams);
  if (spoken) markSafetyAlertSpoken(key, now);
  return spoken;
}

export function resetSafetyAlertCooldowns() {
  lastSpokenAtByKey.clear();
}

export function testVoiceAlert(settings = localSettings.get()) {
  const message = resolveVoiceAlertMessageStyle(settings) === 'technical'
    ? buildVoiceAlertMessage('tracking_ready', {}, { settings })
    : 'Road Sage voice alerts are ready. Coaching alerts will speak during active trips.';
  return speakSafetyAlert(message, {
    ...settings,
    voice_alerts_enabled: true,
  }, {
    interrupt: true,
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(SETTINGS_CHANGED_EVENT, (event) => {
    const settings = event instanceof CustomEvent
      ? event.detail?.settings || localSettings.get()
      : localSettings.get();
    if (!isVoiceAlertEnabled(settings)) {
      void stopSafetyAlerts();
    }
  });
}
