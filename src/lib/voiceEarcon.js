// src/lib/voiceEarcon.js
// Generates short pre-speech audio tones using Web AudioContext.
// 100% on-device. No microphone, no network, no GPS.

const EARCON_PATTERNS = {
  3: [
    { freq: 880, duration: 80, gap: 40 },
    { freq: 660, duration: 80, gap: 40 },
    { freq: 880, duration: 120, gap: 0 },
  ],
  2: [
    { freq: 660, duration: 100, gap: 60 },
    { freq: 660, duration: 100, gap: 0 },
  ],
  1: [
    { freq: 520, duration: 140, gap: 0 },
  ],
  0: [],
};

let audioContext = null;

function getAudioContext() {
  if (typeof window === 'undefined') return null;

  if (!audioContext || audioContext.state === 'closed') {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      audioContext = new AudioContextClass();
    } catch {
      return null;
    }
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => null);
  }

  return audioContext;
}

/**
 * Play a priority-appropriate earcon before speaking.
 * Resolves immediately if AudioContext is unavailable.
 */
export function playEarcon(priority = 1, volumeScale = 1.0) {
  const pattern = EARCON_PATTERNS[priority] ?? [];
  if (pattern.length === 0) return Promise.resolve();

  const ctx = getAudioContext();
  if (!ctx) return Promise.resolve();

  return new Promise((resolve) => {
    let startTime = ctx.currentTime + 0.05;
    let lastEnd = startTime;
    const volume = Math.max(0, Math.min(1, Number(volumeScale) || 0));

    for (const { freq, duration, gap } of pattern) {
      const durationSeconds = duration / 1000;
      const gapSeconds = gap / 1000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.4 * volume, startTime + 0.005);
      gain.gain.setValueAtTime(0.4 * volume, startTime + durationSeconds - 0.01);
      gain.gain.linearRampToValueAtTime(0, startTime + durationSeconds);

      osc.start(startTime);
      osc.stop(startTime + durationSeconds);

      lastEnd = startTime + durationSeconds + gapSeconds;
      startTime += durationSeconds + gapSeconds;
    }

    const delayMs = Math.max(0, (lastEnd - ctx.currentTime) * 1000 + 50);
    setTimeout(resolve, delayMs);
  });
}
