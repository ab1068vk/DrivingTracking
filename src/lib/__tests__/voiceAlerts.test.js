import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  isNative: false,
  nativeSpeech: {
    speak: undefined,
    speakText: vi.fn(),
  },
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => mockState.isNative,
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: mockState.nativeSpeech,
}));

import { canSpeakSafetyAlert, resetSafetyAlertCooldowns, speakSafetyAlert, speakSafetyAlertOnce } from '@/lib/voiceAlerts';

function stubSpeechSynthesis(overrides = {}) {
  const SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
    }
  };
  const speechSynthesis = {
    cancel: vi.fn(),
    getVoices: vi.fn(() => [{}]),
    speak: vi.fn((utterance) => utterance.onend?.()),
    ...overrides,
  };
  vi.stubGlobal('SpeechSynthesisUtterance', SpeechSynthesisUtterance);
  vi.stubGlobal('window', {
    speechSynthesis,
    SpeechSynthesisUtterance,
  });
  return speechSynthesis;
}

describe('voice alert cooldowns', () => {
  afterEach(() => {
    mockState.isNative = false;
    mockState.nativeSpeech.speak = undefined;
    mockState.nativeSpeech.speakText = vi.fn();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('allows unkeyed alerts without cooldown tracking', () => {
    resetSafetyAlertCooldowns();
    expect(canSpeakSafetyAlert(null, 60000, 1000)).toBe(true);
  });

  it('throttles keyed alerts after a successful spoken message', async () => {
    resetSafetyAlertCooldowns();
    stubSpeechSynthesis({ getVoices: undefined });

    const settings = { voice_alerts_enabled: true };
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 1000)).toBe(true);
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 30000)).toBe(false);
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 61000)).toBe(true);
  });

  it('treats missing-string voice alert settings as enabled defaults', async () => {
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakSafetyAlert('Speed warning.', { voice_alerts_enabled: 'undefined' })).toBe(true);
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it('does not speak when voice alerts are explicitly disabled by stored string', async () => {
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakSafetyAlert('Speed warning.', { voice_alerts_enabled: 'false' })).toBe(false);
    expect(speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it('waits for browser voices before speaking', async () => {
    let voices = [];
    const listeners = new Map();
    const speechSynthesis = stubSpeechSynthesis({
      getVoices: vi.fn(() => voices),
      addEventListener: vi.fn((event, callback) => listeners.set(event, callback)),
    });

    const spoken = speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true });
    await Promise.resolve();
    expect(speechSynthesis.speak).not.toHaveBeenCalled();

    voices = [{}];
    listeners.get('voiceschanged')();

    expect(await spoken).toBe(true);
    expect(speechSynthesis.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      speechSynthesis.speak.mock.invocationCallOrder[0]
    );
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it('falls back to the repo native speakText bridge when speak is unavailable', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith({
      text: 'Eyes on the road.',
      rate: 0.95,
      volume: 0.95,
      language: 'en-US',
    });
  });

  it('passes speech tuning to the native speak bridge when present', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speak = vi.fn().mockResolvedValue();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speak).toHaveBeenCalledWith({
      text: 'Eyes on the road.',
      rate: 0.95,
      volume: 0.95,
      language: 'en-US',
    });
    expect(mockState.nativeSpeech.speakText).not.toHaveBeenCalled();
  });
});
