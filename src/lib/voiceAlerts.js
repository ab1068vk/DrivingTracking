import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';

const NativeSpeech = registerPlugin('DriveSenseActivityRecognition');
const lastSpokenAtByKey = new Map();

export function canSpeakSafetyAlert(key, cooldownMs = 0, now = Date.now()) {
  if (!key || !cooldownMs) return true;
  const last = lastSpokenAtByKey.get(key);
  if (!last) return true;
  return now - last >= cooldownMs;
}

export async function speakSafetyAlert(text, settings = localSettings.get()) {
  const message = String(text || '').trim();
  if (!message || settings.voice_alerts_enabled === false || typeof window === 'undefined') return false;

  if (isNativePlatform()) {
    try {
      await NativeSpeech.speakText({ text: message });
      return true;
    } catch {
      // Fall through to Web Speech for browser/WebView cases without the native bridge.
    }
  }

  if (!window.speechSynthesis) return false;
  const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
  if (!Utterance) return false;

  const utterance = new Utterance(message);
  utterance.rate = 0.95;
  utterance.volume = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}

export async function speakSafetyAlertOnce(key, text, settings = localSettings.get(), cooldownMs = 0, now = Date.now()) {
  if (!canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, settings);
  if (spoken && key) lastSpokenAtByKey.set(key, now);
  return spoken;
}

export function resetSafetyAlertCooldowns() {
  lastSpokenAtByKey.clear();
}

export function testVoiceAlert(settings = localSettings.get()) {
  return speakSafetyAlert('Road Sage voice alerts are working.', settings);
}
