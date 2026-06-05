// src/lib/voiceEscalation.js
// Tracks per-key offense counts within the session.
// Resets escalation if the driver shows sustained improvement.
// Pure in-memory: never stored, never transmitted.

const ESCALATION_RESET_MS = {
  speeding: 5 * 60_000,
  harsh_brake: 3 * 60_000,
  rapid_accel: 3 * 60_000,
  stop_start_pattern: 8 * 60_000,
  phone_use: 15 * 60_000,
  close_proximity: 10 * 60_000,
  heading_drift_beta: 20 * 60_000,
  long_drive: 60 * 60_000,
  idle: 10 * 60_000,
  repeated_event_area: 5 * 60_000,
};

const store = new Map();

/**
 * Record an offense and return the current escalation level.
 * Levels are 0=first, 1=repeated, 2=severe/repeated pattern.
 */
export function recordOffenseAndGetLevel(key, now = Date.now()) {
  const resetMs = ESCALATION_RESET_MS[key] ?? 5 * 60_000;
  const entry = store.get(key);

  if (!entry || now - entry.lastMs > resetMs) {
    store.set(key, { count: 1, lastMs: now });
    return 0;
  }

  const newCount = Math.min(entry.count + 1, 3);
  store.set(key, { count: newCount, lastMs: now });
  return Math.min(newCount - 1, 2);
}

export function recordImprovement(key) {
  store.delete(key);
}

export function resetAllEscalation() {
  store.clear();
}

export function getCurrentLevel(key) {
  return Math.min((store.get(key)?.count ?? 1) - 1, 2);
}
