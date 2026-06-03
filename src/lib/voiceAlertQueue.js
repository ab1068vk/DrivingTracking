// src/lib/voiceAlertQueue.js
// Priority queue for voice alerts. Runs entirely on-device.
// No GPS, no speed values, no coordinates pass through this file.

import { isNativePlatform } from '@/lib/nativePlatform';
import NativeSpeech from '@/lib/driveSenseNativePlugin';
import { ALERT_PRIORITY } from '@/lib/voiceAlertMessages';

export const PRIORITY = { INFO: 0, WARNING: 1, DANGER: 2, CRITICAL: 3 };

const MAX_QUEUE_DEPTH = 2;
const DEFAULT_LANGUAGE = 'en-US';
const VOICES_READY_TIMEOUT_MS = 1500;
const MIN_NATIVE_SPEECH_MS = 1200;
const MAX_NATIVE_SPEECH_MS = 6500;

let currentPriority = -1;
let currentKey = null;
let isSpeaking = false;
let activeToken = 0;
const pendingQueue = [];

function estimatedNativeSpeechMs(text) {
  const wordCount = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.min(MAX_NATIVE_SPEECH_MS, Math.max(MIN_NATIVE_SPEECH_MS, 500 + wordCount * 325));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEntry(entry = {}) {
  const key = entry.key;
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  const priority = ALERT_PRIORITY[key] ?? PRIORITY.WARNING;
  return {
    key,
    text,
    priority,
    rate: entry.rate ?? 0.95,
    pitch: entry.pitch ?? 1.0,
    volume: entry.volume ?? 0.95,
    language: entry.language ?? DEFAULT_LANGUAGE,
  };
}

function pruneQueue() {
  while (pendingQueue.length >= MAX_QUEUE_DEPTH) {
    let lowestIdx = 0;
    for (let i = 1; i < pendingQueue.length; i += 1) {
      if (pendingQueue[i].priority < pendingQueue[lowestIdx].priority) lowestIdx = i;
    }
    pendingQueue.splice(lowestIdx, 1);
  }
}

function cancelCurrentSpeech() {
  activeToken += 1;
  if (!isNativePlatform() && typeof window !== 'undefined') {
    window?.speechSynthesis?.cancel?.();
  }
  isSpeaking = false;
  currentPriority = -1;
  currentKey = null;
}

async function speakNative(entry) {
  const payload = {
    text: entry.text,
    rate: entry.rate,
    volume: entry.volume,
    pitch: entry.pitch,
    language: entry.language,
  };
  if (typeof NativeSpeech?.speak === 'function') {
    await NativeSpeech.speak(payload);
  } else {
    await NativeSpeech.speakText(payload);
  }
  await sleep(estimatedNativeSpeechMs(entry.text));
}

function speakWeb(entry) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }

    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
    if (!synth || !Utterance) {
      resolve();
      return;
    }

    const proceed = () => {
      const utter = new Utterance(entry.text);
      utter.rate = entry.rate;
      utter.volume = entry.volume;
      utter.pitch = entry.pitch;
      utter.lang = entry.language;
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      synth.speak(utter);
    };

    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    if (!Array.isArray(voices) || voices.length > 0 || typeof synth.addEventListener !== 'function') {
      proceed();
      return;
    }

    const tid = setTimeout(proceed, VOICES_READY_TIMEOUT_MS);
    synth.addEventListener('voiceschanged', () => {
      clearTimeout(tid);
      proceed();
    }, { once: true });
  });
}

async function speakNow(entry) {
  const token = ++activeToken;
  isSpeaking = true;
  currentPriority = entry.priority;
  currentKey = entry.key ?? null;

  try {
    if (isNativePlatform()) {
      await speakNative(entry);
    } else {
      await speakWeb(entry);
    }
  } catch {
    // Never let a TTS failure crash the app.
  } finally {
    if (token !== activeToken) return;
    isSpeaking = false;
    currentPriority = -1;
    currentKey = null;
    drainQueue();
  }
}

function drainQueue() {
  if (pendingQueue.length === 0 || isSpeaking) return;

  let bestIdx = 0;
  for (let i = 1; i < pendingQueue.length; i += 1) {
    if (pendingQueue[i].priority > pendingQueue[bestIdx].priority) bestIdx = i;
  }

  const next = pendingQueue.splice(bestIdx, 1)[0];
  void speakNow(next);
}

/**
 * Enqueue a voice alert. Higher priority preempts lower priority speech.
 * Same-or-lower priority is queued with a small max depth to avoid stale buildup.
 */
export function enqueueVoiceAlert(alert) {
  const entry = normalizeEntry(alert);
  if (!entry.text) return false;

  const alreadyQueued = entry.key && pendingQueue.some((queued) => queued.key === entry.key);
  if (alreadyQueued || (entry.key && entry.key === currentKey)) return false;

  if (entry.priority === PRIORITY.INFO && (isSpeaking || pendingQueue.length > 0)) return false;

  if (isSpeaking && entry.priority > currentPriority) {
    cancelCurrentSpeech();
  }

  pruneQueue();
  pendingQueue.push(entry);
  drainQueue();
  return true;
}

export function silenceAllAlerts() {
  pendingQueue.length = 0;
  cancelCurrentSpeech();
}

export function getVoiceAlertQueueState() {
  return {
    isSpeaking,
    currentPriority,
    currentKey,
    pendingCount: pendingQueue.length,
    pendingKeys: pendingQueue.map((entry) => entry.key),
  };
}
