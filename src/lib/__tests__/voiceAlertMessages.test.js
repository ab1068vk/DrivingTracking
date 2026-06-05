import { describe, expect, it } from 'vitest';

import { buildAlertMessage, buildTtsParams } from '@/lib/voiceAlertMessages';

describe('voice alert messages', () => {
  it('builds contextual speeding messages', () => {
    expect(buildAlertMessage('speeding', {
      speedKmh: 105,
      limitKmh: 90,
      overKmh: 15,
    })).toBe('Speed warning. 105 kilometres per hour. 15 over the limit.');

    expect(buildAlertMessage('speeding', {
      speedKmh: 112,
      overKmh: 22,
    }, 1)).toBe('Still speeding. 112 kilometres per hour. 22 over. Reduce speed now.');
  });

  it('escalates repeated safety events', () => {
    expect(buildAlertMessage('harsh_brake')).toBe(
      'Harsh braking detected. Try to brake earlier and more gradually.'
    );
    expect(buildAlertMessage('harsh_brake', {}, 2)).toBe(
      'Repeated harsh braking. Maintain a longer following distance.'
    );
  });

  it('builds contextual long-drive and repeated-area messages', () => {
    expect(buildAlertMessage('long_drive', { durationMins: 126 })).toContain('126 minutes');
    expect(buildAlertMessage('repeated_event_area', { typeLabel: 'harsh brake' })).toBe(
      'Repeated event area ahead. harsh brake was recorded here before.'
    );
  });

  it('returns empty text for unknown alert keys', () => {
    expect(buildAlertMessage('unknown_alert')).toBe('');
  });

  it('adjusts TTS params by priority and user settings', () => {
    expect(buildTtsParams('phone_use', {
      voice_alert_rate: 1.1,
      voice_alert_volume: 0.8,
    })).toEqual({
      rate: 1.16,
      pitch: 1.1,
      volume: 0.8,
      earconEnabled: true,
    });

    expect(buildTtsParams('idle', { voice_alert_volume: 2, voice_earcon_enabled: false })).toEqual({
      rate: 0.85,
      pitch: 0.9,
      volume: 1,
      earconEnabled: false,
    });
  });
});
