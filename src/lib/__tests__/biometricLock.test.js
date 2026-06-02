import { afterEach, describe, expect, it } from 'vitest';
import {
  getLockTimeoutMs,
  isBiometricLockEnabled,
  isLocked,
  lock,
  markUnlocked,
  setBiometricLockEnabled,
} from '@/lib/biometricLock';

describe('biometric lock session timeout', () => {
  afterEach(() => {
    setBiometricLockEnabled(false);
    lock();
  });

  it('uses a configurable lock timeout with a five minute default', () => {
    expect(getLockTimeoutMs({})).toBe(5 * 60 * 1000);
    expect(getLockTimeoutMs({ lock_timeout_minutes: 1 })).toBe(60 * 1000);
    expect(getLockTimeoutMs({ lock_timeout_minutes: 0 })).toBe(0);
    expect(getLockTimeoutMs({ lock_timeout_minutes: -1 })).toBe(5 * 60 * 1000);
  });

  it('only locks when biometrics are enabled and the timeout has elapsed', () => {
    markUnlocked(1_000);
    expect(isLocked({ lock_timeout_minutes: 1 }, 10 * 60 * 1000)).toBe(false);

    setBiometricLockEnabled(true);
    expect(isBiometricLockEnabled()).toBe(true);
    expect(isLocked({ lock_timeout_minutes: 1 }, 1_000 + 60 * 1000)).toBe(false);
    expect(isLocked({ lock_timeout_minutes: 1 }, 1_000 + 60 * 1000 + 1)).toBe(true);
  });

  it('locks immediately after background auto-lock clears the unlock time', () => {
    setBiometricLockEnabled(true);
    markUnlocked(1_000);
    expect(isLocked({ lock_timeout_minutes: 0 }, 10 * 60 * 1000)).toBe(false);

    lock();
    expect(isLocked({ lock_timeout_minutes: 0 }, 10 * 60 * 1000)).toBe(true);
  });
});
