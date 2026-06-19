import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings, SETTINGS_CHANGED_EVENT } from '@/lib/trackingStore';
import NativeSpeech from '@/lib/driveSenseNativePlugin';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

const lastSpokenAtByKey = new Map();
const DEFAULT_RATE = 0.92;
const DEFAULT_VOLUME = 0.95;
const DEFAULT_PITCH = 1;
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_QUEUE_MODE = 'add';

export function isVoiceAlertEnabled(settings = {}) {
  const raw = settings.voice_alerts_enabled;
  if (raw === false || raw === 0) return false;
  if (typeof raw !== 'string') return true;
  const value = raw.trim().toLowerCase();
  if (!value || value === 'undefined' || value === 'null') return true;
  return !['false', '0', 'off', 'no', 'disabled'].includes(value);
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
    return {
      status: 'disabled',
      label: 'Voice alerts off',
      detail: 'Live voice alerts are disabled in Settings.',
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
  if (!message || !isVoiceAlertEnabled(settings)) return false;
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
  if (!canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, settings, speechParams);
  if (spoken && key) markSafetyAlertSpoken(key, now);
  return spoken;
}

export function resetSafetyAlertCooldowns() {
  lastSpokenAtByKey.clear();
}

export function testVoiceAlert(settings = localSettings.get()) {
  return speakSafetyAlert('Road Sage voice alerts are ready. Coaching alerts will speak during active trips.', settings, {
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
