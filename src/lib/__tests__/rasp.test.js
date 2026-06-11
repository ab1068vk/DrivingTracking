import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { plugin } = vi.hoisted(() => ({
  plugin: {
    check: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => plugin),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: vi.fn(() => true),
}));

import {
  checkIntegrity,
  integrityStatusFromSettings,
  sanitizeIntegrityResult,
} from '@/lib/rasp';
import { localSettings } from '@/lib/trackingStore';

describe('rasp integrity bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizes threat labels and requires no threats for a secure result', () => {
    const result = sanitizeIntegrityResult({
      secure: true,
      threats: [' SU_BINARY ', 'x'.repeat(200)],
      checkedAt: '2026-06-11T12:00:00.000Z',
      native: true,
    });

    expect(result.secure).toBe(false);
    expect(result.threats).toEqual(['SU_BINARY', 'x'.repeat(120)]);
    expect(result.checkedAt).toBe('2026-06-11T12:00:00.000Z');
  });

  it('persists compromised status for cross-app privacy display suppression', async () => {
    plugin.check.mockResolvedValue({ secure: false, threats: ['ROOT_APP:com.topjohnwu.magisk'] });

    const result = await checkIntegrity();
    const settings = localSettings.get();

    expect(result.secure).toBe(false);
    expect(settings.rasp_secure).toBe(false);
    expect(settings.rasp_threats).toEqual(['ROOT_APP:com.topjohnwu.magisk']);
    expect(integrityStatusFromSettings(settings)).toMatchObject({
      secure: false,
      threats: ['ROOT_APP:com.topjohnwu.magisk'],
    });
  });
});
