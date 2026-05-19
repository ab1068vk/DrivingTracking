import { afterEach, describe, expect, it, vi } from 'vitest';
import { canSpeakSafetyAlert, resetSafetyAlertCooldowns, speakSafetyAlertOnce } from '@/lib/voiceAlerts';

describe('voice alert cooldowns', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows unkeyed alerts without cooldown tracking', () => {
    resetSafetyAlertCooldowns();
    expect(canSpeakSafetyAlert(null, 60000, 1000)).toBe(true);
  });

  it('throttles keyed alerts after a successful spoken message', async () => {
    resetSafetyAlertCooldowns();
    const SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
      constructor(text) {
        this.text = text;
      }
    };
    vi.stubGlobal('SpeechSynthesisUtterance', SpeechSynthesisUtterance);
    vi.stubGlobal('window', {
      speechSynthesis: {
        cancel() {},
        speak() {},
      },
      SpeechSynthesisUtterance,
    });

    const settings = { voice_alerts_enabled: true };
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 1000)).toBe(true);
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 30000)).toBe(false);
    expect(await speakSafetyAlertOnce('speeding', 'Speed warning.', settings, 60000, 61000)).toBe(true);
  });
});
