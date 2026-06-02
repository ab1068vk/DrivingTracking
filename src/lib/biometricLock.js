let biometricEnabled = false;
let unlockedAt = null;

export function setBiometricLockEnabled(enabled) {
  biometricEnabled = enabled === true;
  if (!biometricEnabled) unlockedAt = null;
}

export function isBiometricLockEnabled() {
  return biometricEnabled;
}

export function getLockTimeoutMs(settings = {}) {
  const minutes = Number(settings.lock_timeout_minutes ?? 5);
  if (!Number.isFinite(minutes) || minutes < 0) return 5 * 60 * 1000;
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
  if (!biometricEnabled) return false;
  if (!unlockedAt) return true;

  const timeoutMs = getLockTimeoutMs(settings);
  if (timeoutMs === 0) return false;

  return Number(now) - unlockedAt > timeoutMs;
}

export function msUntilAutoLock(settings = {}, now = Date.now()) {
  if (!biometricEnabled || !unlockedAt) return 0;

  const timeoutMs = getLockTimeoutMs(settings);
  if (timeoutMs === 0) return Number.POSITIVE_INFINITY;

  const elapsedMs = Number(now) - unlockedAt;
  return Math.max(0, timeoutMs - elapsedMs + 1);
}
