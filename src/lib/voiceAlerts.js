import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import NativeSpeech from '@/lib/driveSenseNativePlugin';

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
    try {
      const payload = { text: message, ...tuning };
      if (typeof NativeSpeech?.speakText === 'function') {
        await NativeSpeech.speakText(payload);
      } else {
        await NativeSpeech.speak(payload);
      }
      return true;
    } catch {
      // Fall through to Web Speech for browser/WebView cases without the native bridge.
    }
  }

  if (typeof window === 'undefined') return false;
  if (!window.speechSynthesis) return false;
  const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
  if (!Utterance) return false;

  const utterance = new Utterance(message);
  utterance.rate = tuning.rate;
  utterance.pitch = tuning.pitch;
  utterance.volume = tuning.volume;
  utterance.lang = tuning.language;
  if (tuning.interrupt) {
    window.speechSynthesis.cancel();
  }
  window.speechSynthesis.speak(utterance);
  return true;
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
