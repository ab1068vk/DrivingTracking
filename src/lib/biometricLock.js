import {
  BIOMETRIC_LOCK_DEFAULT_ENABLED,
  BIOMETRIC_LOCK_TIMEOUT_DEFAULT_MINUTES,
} from '@/lib/appConstants';

let biometricEnabled = BIOMETRIC_LOCK_DEFAULT_ENABLED;
let unlockedAt = null;
export const BIOMETRIC_LOCK_STATE_CHANGE_EVENT = 'road_sage_biometric_lock_state_change';

export function notifyBiometricLockSettingsChanged() {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(BIOMETRIC_LOCK_STATE_CHANGE_EVENT, {
      detail: { enabled: biometricEnabled },
    }));
  } catch {
    // Dispatch is best-effort; callers still update in-memory state directly.
  }
}

export function setBiometricLockEnabled(enabled) {
  biometricEnabled = enabled === true;
  if (!biometricEnabled) unlockedAt = null;
}

export function isBiometricLockEnabled() {
  return biometricEnabled;
}

export function getLockTimeoutMs(settings = {}) {
  if (!isBiometricLockEnabled()) return Number.POSITIVE_INFINITY;

  const minutes = Number(settings.lock_timeout_minutes);
  if (!Number.isFinite(minutes) || minutes < 0) return BIOMETRIC_LOCK_TIMEOUT_DEFAULT_MINUTES * 60 * 1000;
  if (minutes === 0) return Number.POSITIVE_INFINITY;
  return minutes * 60 * 1000;
}

export function markUnlocked(now = Date.now()) {
  unlockedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return unlockedAt;
}

export function lock() {
  unlockedAt = null;
}

export function isLocked(settings = {}, now = Date.now()) {
  if (!isBiometricLockEnabled()) return false;
  if (!unlockedAt) return true;

  const timeoutMs = getLockTimeoutMs(settings);
  if (!Number.isFinite(timeoutMs)) return false;

  return Number(now) - unlockedAt > timeoutMs;
}

export function msUntilAutoLock(settings = {}, now = Date.now()) {
  if (!isBiometricLockEnabled() || !unlockedAt) return 0;

  const timeoutMs = getLockTimeoutMs(settings);
  if (!Number.isFinite(timeoutMs)) return Number.POSITIVE_INFINITY;

  const elapsedMs = Number(now) - unlockedAt;
  return Math.max(0, timeoutMs - elapsedMs + 1);
}
