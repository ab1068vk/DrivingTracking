// src/lib/voiceAlerts.js
// On-device TTS only. No speed data, no GPS, no network calls in this file.

import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import NativeSpeech from '@/lib/driveSenseNativePlugin';

const DEFAULT_RATE = 0.95;
const DEFAULT_VOLUME = 0.95;
const DEFAULT_PITCH = 1;
const DEFAULT_LANGUAGE = 'en-US';
const VOICES_READY_TIMEOUT_MS = 1500;

// In-memory cooldown map (per-session, intentionally reset on reload)
const lastSpokenAt = new Map();

// Helpers

/**
 * Normalise any value stored for voice_alerts_enabled.
 * Handles: true, false, "true", "false", "undefined", null, undefined.
 */
export function isVoiceAlertEnabled(settings) {
  const raw = settings?.voice_alerts_enabled;
  if (raw === false || raw === 0) return false;
  if (typeof raw !== 'string') return true;

  const value = raw.trim().toLowerCase();
  if (!value || value === 'undefined' || value === 'null') return true;
  return !['false', '0', 'off', 'no', 'disabled'].includes(value);
}

// Cooldown gate

export function canSpeakSafetyAlert(key, cooldownMs = 0, now = Date.now()) {
  if (!key || cooldownMs <= 0) return true;
  const last = lastSpokenAt.get(key);
  if (last === undefined) return true;
  return now - last >= cooldownMs;
}

export function resetSafetyAlertCooldowns() {
  lastSpokenAt.clear();
}

export function markSafetyAlertSpoken(key, now = Date.now()) {
  if (key) lastSpokenAt.set(key, now);
}

// Core speak (web path)

function normalizeSpeechParams(params = {}) {
  const rate = Number(params.rate);
  const pitch = Number(params.pitch);
  const volume = Number(params.volume);
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_RATE,
    pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : DEFAULT_PITCH,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_VOLUME,
  };
}

function speakWeb(text, params = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Window not available'));
      return;
    }

    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
    if (!synth || !Utterance) {
      reject(new Error('SpeechSynthesis not available'));
      return;
    }

    // Always cancel any queued speech first to avoid stale-queue buildup.
    synth.cancel();
    const speechParams = normalizeSpeechParams(params);

    let spoken = false;
    let timeout = null;

    const speak = () => {
      if (spoken) return;
      spoken = true;
      if (timeout) clearTimeout(timeout);

      const utter = new Utterance(text);
      utter.rate = speechParams.rate;
      utter.pitch = speechParams.pitch;
      utter.volume = speechParams.volume;
      utter.lang = DEFAULT_LANGUAGE;
      utter.onend = () => resolve();
      utter.onerror = (event) => reject(new Error(`SpeechSynthesis error: ${event.error || 'unknown'}`));
      synth.speak(utter);
    };

    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    if (!Array.isArray(voices) || voices.length > 0 || typeof synth.addEventListener !== 'function') {
      speak();
      return;
    }

    // Otherwise wait for the voiceschanged event (Chrome / Android WebView).
    timeout = setTimeout(() => {
      // Voices never loaded: attempt anyway with system default.
      speak();
    }, VOICES_READY_TIMEOUT_MS);

    synth.addEventListener('voiceschanged', speak, { once: true });
  });
}

// Core speak (native Android path)

async function speakNative(text, params = {}) {
  // NativeSpeech bridges to DriveSenseActivityRecognitionPlugin -> Android TTS.
  // The plugin must be initialised; the try/catch surfaces failures upstream.
  const speechParams = normalizeSpeechParams(params);
  const payload = { text, ...speechParams, language: DEFAULT_LANGUAGE };
  if (typeof NativeSpeech?.speak === 'function') {
    await NativeSpeech.speak(payload);
    return;
  }
  await NativeSpeech.speakText(payload);
}

// Public API

/**
 * Speak text respecting the user's voice-alerts setting.
 * Speed and GPS data are NEVER passed here: this is pure audio output.
 */
export async function speakSafetyAlert(text, settings = localSettings.get(), ttsParams = {}) {
  const message = typeof text === 'string' ? text.trim() : '';
  if (!message || !isVoiceAlertEnabled(settings)) return false;

  if (isNativePlatform()) {
    await speakNative(message, ttsParams);
  } else {
    await speakWeb(message, ttsParams);
  }

  return true;
}

/**
 * Speak text at most once per cooldown window for a given key.
 */
export async function speakSafetyAlertOnce(
  key,
  text,
  settings = localSettings.get(),
  cooldownMs = 0,
  now = Date.now(),
  ttsParams = {}
) {
  if (!canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, settings, ttsParams);
  if (spoken && key) markSafetyAlertSpoken(key, now);
  return spoken;
}

/**
 * Test helper: speaks a fixed phrase to confirm TTS is wired up.
 * Called from Settings -> Advanced -> Test Voice Alert.
 */
export async function testVoiceAlert(settings = localSettings.get()) {
  return speakSafetyAlert('Road Sage voice alerts are working.', settings);
}
