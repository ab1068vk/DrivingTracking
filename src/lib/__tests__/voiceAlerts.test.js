import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  isNative: false,
  nativeSpeech: {
    speak: undefined,
    speakText: vi.fn(),
  },
  systemLog: {
    logSystemFailure: vi.fn(),
    recordSystemEvent: vi.fn(),
  },
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => mockState.isNative,
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: mockState.nativeSpeech,
}));

vi.mock('@/lib/systemLog', () => mockState.systemLog);

import {
  canSpeakSafetyAlert,
  getVoiceAlertDeliveryStatus,
  isTripStartVoiceAlertEnabled,
  isVoiceAlertEnabled,
  isVoiceAlertTypeEnabled,
  markSafetyAlertSpoken,
  resetSafetyAlertCooldowns,
  shouldMuteWebViewVoiceForTrip,
  speakSafetyAlert,
  speakSafetyAlertOnce,
  speakTripStartConfirmationOnce,
  stopSafetyAlerts,
  testVoiceAlert,
  voiceAlertGroupSettingForKey,
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
    mockState.nativeSpeech.stopSpeech = undefined;
    mockState.systemLog.logSystemFailure.mockReset();
    mockState.systemLog.recordSystemEvent.mockReset();
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
    expect(isTripStartVoiceAlertEnabled({ trip_start_voice_alert_enabled: 'false' })).toBe(false);
    expect(isTripStartVoiceAlertEnabled({})).toBe(true);
  });

  it('maps every recurring alert family to its user-facing voice group', () => {
    expect(voiceAlertGroupSettingForKey('speeding_posted')).toBe('voice_speed_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('harsh_brake')).toBe('voice_driving_event_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('repeated_event_area')).toBe('voice_driving_event_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('phone_use')).toBe('voice_attention_incident_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('possible_incident')).toBe('voice_attention_incident_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('coach_program_brief_123')).toBe('voice_coaching_reminder_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('coach_program_123_harsh_brake')).toBe('voice_driving_event_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('long_drive')).toBe('voice_coaching_reminder_alerts_enabled');
  });

  it('blocks only the disabled recurring voice group', async () => {
    resetSafetyAlertCooldowns();
    const speechSynthesis = stubSpeechSynthesis();
    const settings = {
      voice_alerts_enabled: true,
      voice_speed_alerts_enabled: false,
      voice_driving_event_alerts_enabled: true,
    };

    expect(isVoiceAlertTypeEnabled('speeding_posted', settings)).toBe(false);
    expect(await speakSafetyAlertOnce('speeding_posted', 'Speed warning.', settings, 0, 1000)).toBe(false);
    expect(await speakSafetyAlertOnce('harsh_brake', 'Brake smoothly.', settings, 0, 1000)).toBe(true);
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it('keeps trip-start confirmation independent from recurring live alerts', async () => {
    resetSafetyAlertCooldowns();
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakTripStartConfirmationOnce(
      'Road Sage is tracking.',
      {
        trip_start_voice_alert_enabled: true,
        voice_alerts_enabled: false,
      },
      5 * 60 * 1000,
      1000,
      { interrupt: true }
    )).toBe(true);
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);

    resetSafetyAlertCooldowns();
    expect(await speakTripStartConfirmationOnce(
      'Road Sage is tracking.',
      {
        trip_start_voice_alert_enabled: false,
        voice_alerts_enabled: true,
      },
      5 * 60 * 1000,
      2000
    )).toBe(false);
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it('mutes WebView speech when Android native tracking owns trip voice', () => {
    expect(shouldMuteWebViewVoiceForTrip(
      { native_manual_background: true },
      { isAndroidPlatform: true }
    )).toBe(true);
    expect(shouldMuteWebViewVoiceForTrip(
      { voice_alert_owner: 'native_android' },
      { isAndroidPlatform: true }
    )).toBe(true);
    expect(shouldMuteWebViewVoiceForTrip(
      { native_manual_background: true },
      { isAndroidPlatform: false }
    )).toBe(false);
  });

  it('reports the current voice alert delivery owner', () => {
    expect(getVoiceAlertDeliveryStatus({
      settings: {
        voice_alerts_enabled: false,
        trip_start_voice_alert_enabled: true,
      },
    })).toMatchObject({
      status: 'disabled',
      label: 'Live alerts off',
      detail: expect.stringContaining('trip-start confirmation remains on'),
    });
    expect(getVoiceAlertDeliveryStatus({
      settings: { voice_alerts_enabled: true },
      trip: { native_manual_background: true },
      isAndroidPlatform: true,
      tracking: true,
    })).toMatchObject({ status: 'native', label: 'Android native voice' });
    expect(getVoiceAlertDeliveryStatus({
      settings: { voice_alerts_enabled: true },
      nativeStatus: { enabled: true },
      isAndroidPlatform: true,
      tracking: false,
    }).status).toBe('armed');
    expect(getVoiceAlertDeliveryStatus({
      settings: { voice_alerts_enabled: true },
      tracking: true,
    }).status).toBe('webview');
    expect(getVoiceAlertDeliveryStatus({
      settings: {
        voice_alerts_enabled: true,
        trip_start_voice_alert_enabled: true,
        voice_speed_alerts_enabled: false,
        voice_driving_event_alerts_enabled: false,
        voice_attention_incident_alerts_enabled: false,
        voice_coaching_reminder_alerts_enabled: false,
      },
    })).toMatchObject({
      status: 'groups_disabled',
      label: 'Recurring groups off',
      detail: expect.stringContaining('trip-start confirmation remains on'),
    });
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
    expect(speechSynthesis.cancel).not.toHaveBeenCalled();
    expect(mockState.systemLog.recordSystemEvent).toHaveBeenCalledWith(
      'voice_alert_spoken',
      expect.objectContaining({ channel: 'web_speech', message_length: 'Ease back.'.length }),
      expect.objectContaining({ category: 'notification', title: 'Voice alert queued' })
    );
  });

  it('only interrupts browser speech when requested', async () => {
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakSafetyAlert(
      'Urgent alert.',
      { voice_alerts_enabled: true },
      { interrupt: true }
    )).toBe(true);

    expect(speechSynthesis.cancel).toHaveBeenCalledTimes(1);
  });

  it('passes tuning through the native speakText bridge', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith({
      text: 'Eyes on the road.',
      rate: 0.92,
      pitch: 1,
      volume: 0.95,
      language: 'en-US',
      interrupt: false,
      queueMode: 'add',
    });
    expect(mockState.systemLog.recordSystemEvent).toHaveBeenCalledWith(
      'voice_alert_spoken',
      expect.objectContaining({ channel: 'native_plugin', message_length: 'Eyes on the road.'.length }),
      expect.objectContaining({ category: 'notification', title: 'Voice alert queued' })
    );
  });

  it('prefers the Android speakText bridge when present', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speak = vi.fn().mockResolvedValue();
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith({
      text: 'Eyes on the road.',
      rate: 0.92,
      pitch: 1,
      volume: 0.95,
      language: 'en-US',
      interrupt: false,
      queueMode: 'add',
    });
    expect(mockState.nativeSpeech.speak).not.toHaveBeenCalled();
  });

  it('does not fall back to browser speech when the native Android bridge rejects', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockRejectedValue(new Error('audio focus denied'));
    const speechSynthesis = stubSpeechSynthesis();

    expect(await speakSafetyAlert('Eyes on the road.', { voice_alerts_enabled: true })).toBe(false);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledTimes(1);
    expect(speechSynthesis.speak).not.toHaveBeenCalled();
    expect(mockState.systemLog.logSystemFailure).toHaveBeenCalledWith(
      'voice_alert_speech_output',
      expect.any(Error),
      expect.objectContaining({ native_platform: true })
    );
  });

  it('does not consume keyed cooldowns when native Android speech fails', async () => {
    mockState.isNative = true;
    resetSafetyAlertCooldowns();
    mockState.nativeSpeech.speakText = vi.fn()
      .mockRejectedValueOnce(new Error('audio focus denied'))
      .mockResolvedValueOnce();

    expect(await speakSafetyAlertOnce('phone_use', 'Eyes up.', { voice_alerts_enabled: true }, 60000, 1000)).toBe(false);
    expect(await speakSafetyAlertOnce('phone_use', 'Eyes up.', { voice_alerts_enabled: true }, 2000)).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledTimes(2);
  });

  it('marks the settings test alert as interruptible', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await testVoiceAlert({ voice_alerts_enabled: true })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith({
      text: 'Road Sage voice alerts are ready. Coaching alerts will speak during active trips.',
      rate: 0.92,
      pitch: 1,
      volume: 0.95,
      language: 'en-US',
      interrupt: true,
      queueMode: 'flush',
    });
  });

  it('allows the explicit settings voice test while the recurring master switch is off', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await testVoiceAlert({
      voice_alerts_enabled: false,
      voice_speed_alerts_enabled: false,
    })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledTimes(1);
  });

  it('uses technical test-alert wording when tracking mode requests mode default', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await testVoiceAlert({
      voice_alerts_enabled: true,
      experience_mode: 'tracking',
      voice_alert_style: 'mode_default',
    })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Recording active. Voice alert delivery ready.',
      interrupt: true,
      queueMode: 'flush',
    }));
  });

  it('lets an explicit coaching style override tracking mode test-alert wording', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.speakText = vi.fn().mockResolvedValue();

    expect(await testVoiceAlert({
      voice_alerts_enabled: true,
      experience_mode: 'tracking',
      voice_alert_style: 'coaching',
    })).toBe(true);
    expect(mockState.nativeSpeech.speakText).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Road Sage voice alerts are ready. Coaching alerts will speak during active trips.',
    }));
  });

  it('preserves Android native ownership while style settings change wording', () => {
    expect(getVoiceAlertDeliveryStatus({
      settings: {
        voice_alerts_enabled: true,
        experience_mode: 'tracking',
        voice_alert_style: 'mode_default',
      },
      trip: { voice_alert_owner: 'native_android' },
      isAndroidPlatform: true,
      tracking: true,
    })).toMatchObject({ status: 'native', label: 'Android native voice' });
  });

  it('stops queued native and browser speech immediately', async () => {
    mockState.isNative = true;
    mockState.nativeSpeech.stopSpeech = vi.fn().mockResolvedValue();
    const speechSynthesis = stubSpeechSynthesis();

    await stopSafetyAlerts();

    expect(mockState.nativeSpeech.stopSpeech).toHaveBeenCalledTimes(1);
    expect(speechSynthesis.cancel).toHaveBeenCalledTimes(1);
  });
});
