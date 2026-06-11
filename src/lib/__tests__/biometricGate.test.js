import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plugin } = vi.hoisted(() => ({
  plugin: {
    checkAvailability: vi.fn(),
    authenticate: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => plugin),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: vi.fn(() => true),
}));

import {
  APP_LOCK_SETTING_EVENT,
  authenticateDevice,
  getDeviceAuthenticationAvailability,
} from '@/lib/biometricGate';

describe('biometric gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks native device authentication availability', async () => {
    plugin.checkAvailability.mockResolvedValue({ available: true, deviceSecure: true });

    await expect(getDeviceAuthenticationAvailability()).resolves.toEqual({
      available: true,
      deviceSecure: true,
      native: true,
    });
  });

  it('passes a bounded app-owned prompt title and the requested reason', async () => {
    plugin.authenticate.mockResolvedValue({ verified: true });

    await expect(authenticateDevice('Verify to delete this privacy zone')).resolves.toEqual({
      verified: true,
      native: true,
    });
    expect(plugin.authenticate).toHaveBeenCalledWith({
      title: 'Unlock Road Sage',
      subtitle: 'Verify to delete this privacy zone',
    });
    expect(APP_LOCK_SETTING_EVENT).toBe('roadsage-app-lock-setting-changed');
  });
});
