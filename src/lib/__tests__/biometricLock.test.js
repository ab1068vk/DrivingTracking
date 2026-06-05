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

  it('is disabled by default', () => {
    expect(isBiometricLockEnabled()).toBe(false);
  });

  it('stays disabled unless biometric lock is explicitly enabled', () => {
    expect(isBiometricLockEnabled()).toBe(false);
    expect(getLockTimeoutMs({})).toBe(Number.POSITIVE_INFINITY);

    setBiometricLockEnabled(true);
    expect(getLockTimeoutMs({})).toBe(5 * 60 * 1000);
    expect(getLockTimeoutMs({ lock_timeout_minutes: 1 })).toBe(60 * 1000);
    expect(getLockTimeoutMs({ lock_timeout_minutes: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(getLockTimeoutMs({ lock_timeout_minutes: -1 })).toBe(5 * 60 * 1000);
  });

  it('requires an explicit true value to enable biometric lock', () => {
    expect(isBiometricLockEnabled()).toBe(false);
    setBiometricLockEnabled(false);
    expect(isBiometricLockEnabled()).toBe(false);
    setBiometricLockEnabled(true);
    expect(isBiometricLockEnabled()).toBe(true);
  });

  it('only locks when biometrics are enabled and the timeout has elapsed', () => {
    markUnlocked(1_000);
    expect(isLocked({ lock_timeout_minutes: 1 }, 10 * 60 * 1000)).toBe(false);

    setBiometricLockEnabled(true);
    expect(isBiometricLockEnabled()).toBe(true);
    expect(isLocked({ lock_timeout_minutes: 1 }, 1_000 + 60 * 1000)).toBe(false);
    expect(isLocked({ lock_timeout_minutes: 1 }, 1_000 + 60 * 1000 + 1)).toBe(true);
  });

  it('never locks when disabled, regardless of elapsed time', () => {
    setBiometricLockEnabled(false);
    markUnlocked(0);

    expect(isLocked({ lock_timeout_minutes: 5 }, 10 * 60 * 1000)).toBe(false);
  });

  it('locks immediately after background auto-lock clears the unlock time', () => {
    setBiometricLockEnabled(true);
    markUnlocked(1_000);
    expect(isLocked({ lock_timeout_minutes: 0 }, 10 * 60 * 1000)).toBe(false);

    lock();
    expect(isLocked({ lock_timeout_minutes: 0 }, 10 * 60 * 1000)).toBe(true);
  });
});
