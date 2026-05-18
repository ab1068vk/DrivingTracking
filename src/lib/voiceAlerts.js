import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';

const NativeSpeech = registerPlugin('DriveSenseActivityRecognition');

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

export function testVoiceAlert(settings = localSettings.get()) {
  return speakSafetyAlert('Road Sage voice alerts are working.', settings);
}
