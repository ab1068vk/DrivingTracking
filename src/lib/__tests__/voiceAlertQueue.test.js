import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  isNative: false,
  nativeSpeech: {
    speak: vi.fn(),
    speakText: vi.fn(),
  },
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => mockState.isNative,
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: mockState.nativeSpeech,
}));

vi.mock('@/lib/voiceEarcon', () => ({
  playEarcon: vi.fn(() => Promise.resolve()),
}));

import { playEarcon } from '@/lib/voiceEarcon';
import { enqueueVoiceAlert, getVoiceAlertQueueState, silenceAllAlerts } from '@/lib/voiceAlertQueue';

function stubSpeechSynthesis() {
  const utterances = [];
  const SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
    }
  };
  const speechSynthesis = {
    cancel: vi.fn(),
    getVoices: vi.fn(() => [{}]),
    speak: vi.fn((utterance) => {
      utterances.push(utterance);
    }),
  };
  vi.stubGlobal('SpeechSynthesisUtterance', SpeechSynthesisUtterance);
  vi.stubGlobal('window', {
    speechSynthesis,
    SpeechSynthesisUtterance,
  });
  return { speechSynthesis, utterances };
}

describe('voice alert priority queue', () => {
  afterEach(() => {
    silenceAllAlerts();
    mockState.isNative = false;
    mockState.nativeSpeech.speak = vi.fn();
    mockState.nativeSpeech.speakText = vi.fn();
    playEarcon.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('preempts lower-priority speech for critical alerts', async () => {
    const { speechSynthesis, utterances } = stubSpeechSynthesis();

    expect(enqueueVoiceAlert({ key: 'idle', text: 'Idle reminder.' })).toBe(true);
    await Promise.resolve();
    expect(enqueueVoiceAlert({ key: 'possible_incident', text: 'Check in now.' })).toBe(true);
    await Promise.resolve();

    expect(speechSynthesis.cancel).toHaveBeenCalledTimes(1);
    expect(utterances.map((utterance) => utterance.text)).toEqual([
      'Idle reminder.',
      'Check in now.',
    ]);
    expect(getVoiceAlertQueueState()).toMatchObject({
      isSpeaking: true,
      currentKey: 'possible_incident',
      currentPriority: 3,
      pendingCount: 0,
    });
  });

  it('queues same-or-lower priority alerts and drains the highest pending alert first', async () => {
    const { utterances } = stubSpeechSynthesis();

    enqueueVoiceAlert({ key: 'speeding', text: 'Speed warning.' });
    await Promise.resolve();
    enqueueVoiceAlert({ key: 'rapid_accel', text: 'Accelerate smoothly.' });
    enqueueVoiceAlert({ key: 'harsh_brake', text: 'Brake earlier.' });

    expect(utterances.map((utterance) => utterance.text)).toEqual(['Speed warning.']);
    expect(getVoiceAlertQueueState()).toMatchObject({
      currentKey: 'speeding',
      pendingCount: 2,
    });

    utterances[0].onend();
    await Promise.resolve();
    await Promise.resolve();

    expect(utterances.map((utterance) => utterance.text)).toEqual([
      'Speed warning.',
      'Brake earlier.',
    ]);
    expect(getVoiceAlertQueueState()).toMatchObject({
      currentKey: 'harsh_brake',
      pendingKeys: ['rapid_accel'],
    });
  });

  it('deduplicates pending keys and drops info alerts while busy', async () => {
    stubSpeechSynthesis();

    enqueueVoiceAlert({ key: 'speeding', text: 'Speed warning.' });
    await Promise.resolve();
    expect(enqueueVoiceAlert({ key: 'rapid_accel', text: 'Accelerate smoothly.' })).toBe(true);
    expect(enqueueVoiceAlert({ key: 'rapid_accel', text: 'Accelerate smoothly again.' })).toBe(false);
    expect(enqueueVoiceAlert({ key: 'idle', text: 'Idle reminder.' })).toBe(false);

    expect(getVoiceAlertQueueState()).toMatchObject({
      currentKey: 'speeding',
      pendingKeys: ['rapid_accel'],
    });
  });

  it('limits pending queue depth by pruning the lowest-priority pending alert', async () => {
    stubSpeechSynthesis();

    enqueueVoiceAlert({ key: 'speeding', text: 'Speed warning.' });
    await Promise.resolve();
    enqueueVoiceAlert({ key: 'rapid_accel', text: 'Accelerate smoothly.' });
    enqueueVoiceAlert({ key: 'long_drive', text: 'Take a break.' });
    enqueueVoiceAlert({ key: 'harsh_brake', text: 'Brake earlier.' });

    expect(getVoiceAlertQueueState()).toMatchObject({
      currentKey: 'speeding',
      pendingCount: 2,
      pendingKeys: ['long_drive', 'harsh_brake'],
    });
  });

  it('uses the native speak bridge with tuned speech params', async () => {
    vi.useFakeTimers();
    mockState.isNative = true;
    mockState.nativeSpeech.speak = vi.fn().mockResolvedValue();

    expect(enqueueVoiceAlert({
      key: 'phone_use',
      text: 'Phone detected.',
      rate: 1.05,
      pitch: 1.1,
      volume: 0.8,
    })).toBe(true);

    await vi.runOnlyPendingTimersAsync();

    expect(mockState.nativeSpeech.speak).toHaveBeenCalledWith({
      text: 'Phone detected.',
      rate: 1.05,
      pitch: 1.1,
      volume: 0.8,
      language: 'en-US',
      earconEnabled: true,
      earconPattern: 3,
    });
  });

  it('plays a web earcon before speaking unless disabled', async () => {
    const { utterances } = stubSpeechSynthesis();

    enqueueVoiceAlert({ key: 'speeding', text: 'Speed warning.', volume: 0.7 });
    await Promise.resolve();

    expect(playEarcon).toHaveBeenCalledWith(2, 0.7);
    expect(utterances.map((utterance) => utterance.text)).toEqual(['Speed warning.']);

    utterances[0].onend();
    await Promise.resolve();
    playEarcon.mockClear();

    enqueueVoiceAlert({ key: 'rapid_accel', text: 'Accelerate smoothly.', earconEnabled: false });
    await Promise.resolve();

    expect(playEarcon).not.toHaveBeenCalled();
    expect(utterances.map((utterance) => utterance.text)).toEqual([
      'Speed warning.',
      'Accelerate smoothly.',
    ]);
  });
});
