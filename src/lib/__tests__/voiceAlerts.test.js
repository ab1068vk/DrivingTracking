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

import {
  canSpeakSafetyAlert,
  isVoiceAlertEnabled,
  markSafetyAlertSpoken,
  resetSafetyAlertCooldowns,
  speakSafetyAlert,
  speakSafetyAlertOnce,
} from '@/lib/voiceAlerts';

function stubSpeechSynthesis(overrides = {}) {
  const SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
    }
  };
  const speechSynthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
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
  });

  it('allows unkeyed alerts without cooldown tracking', () => {
    resetSafetyAlertCooldowns();
    expect(canSpeakSafetyAlert(null, 60000, 1000)).toBe(true);
  });

  it('throttles keyed alerts after a successful spoken message', async () => {
    resetSafetyAlertCooldowns();
    stubSpeechSynthesis();

    const settings = { voice_alerts_enabled: true };
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 1000)).toBe(true);
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 30000)).toBe(false);
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 61000)).toBe(true);
  });

  it('normalizes stored voice alert enabled values', () => {
    expect(isVoiceAlertEnabled({ voice_alerts_enabled: 'false' })).toBe(false);
    expect(isVoiceAlertEnabled({ voice_alerts_enabled: 'undefined' })).toBe(true);
    expect(isVoiceAlertEnabled({})).toBe(true);
  });

  it('records cooldowns at enqueue time when requested', () => {
    resetSafetyAlertCooldowns();
    markSafetyAlertSpoken('speeding', 1000);

    expect(canSpeakSafetyAlert('speeding', 60000, 30000)).toBe(false);
    expect(canSpeakSafetyAlert('speeding', 60000, 61000)).toBe(true);
  });

  it('does not speak when voice alerts are explicitly disabled by string setting', async () => {
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakSafetyAlert('Speed warning.', { voice_alerts_enabled: 'false' })).toBe(false);
    expect(speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it('applies safe speech tuning to browser speech', async () => {
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakSafetyAlert(
      'Ease back.',
      { voice_alerts_enabled: true },
      { rate: 0.9, pitch: 0.95, volume: 0.8 }
    )).toBe(true);

    const utterance = speechSynthesis.speak.mock.calls[0][0];
    expect(utterance.rate).toBe(0.9);
    expect(utterance.pitch).toBe(0.95);
    expect(utterance.volume).toBe(0.8);
    expect(utterance.lang).toBe('en-US');
  });

  it('passes tuning through the native speakText bridge', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith({
      text: 'Eyes on the road.',
      rate: 0.95,
      pitch: 1,
      volume: 0.95,
      language: 'en-US',
    });
  });

  it('prefers the native speak bridge when present', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speak = vi.fn().mockResolvedValue();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speak).toHaveBeenCalledWith({
      text: 'Eyes on the road.',
      rate: 0.95,
      pitch: 1,
      volume: 0.95,
      language: 'en-US',
    });
    expect(mockState.nativeSpeech.speakText).not.toHaveBeenCalled();
  });
});
