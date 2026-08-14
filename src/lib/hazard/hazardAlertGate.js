/**
 * Decides when a ranked hazard has earned being spoken about.
 *
 * The old warning had one guard: a flat 60 s cooldown. Any zone within 300 m
 * spoke, once a minute, for the whole drive — including zones the vehicle was
 * driving away from, because nothing ever checked.
 *
 * The gate this replaces it with asks for a *sustained approach*, not sustained
 * time: across consecutive fixes the hazard must get closer, and the rate it
 * closes at must match the vehicle's own speed. That single test is what
 * separates a hazard on the road being driven from one on a road running
 * alongside it — the parallel road falls behind at its own rate, and no map data
 * is needed to notice.
 *
 * Hysteresis works by absence rather than by an out-of-band reading. A hazard
 * that leaves the warning window simply stops being offered, so a tracker is
 * kept for `releaseSeconds` after it was last seen: a hazard flickering at the
 * band edge, or briefly outranked by another, keeps its progress instead of
 * restarting from zero on every fix.
 */
import {
  HAZARD_ALERT_GLOBAL_COOLDOWN_MS,
  HAZARD_ALERT_MAX_PER_DRIVE,
  HAZARD_ALERT_RELEASE_SECONDS,
  HAZARD_ALERT_SUSTAINED_FIXES,
  HAZARD_APPROACH_TOLERANCE,
  HAZARD_PREEMPT_MIN_INTERVAL_MS,
  HAZARD_PREEMPT_URGENCY_DELTA,
} from '@/lib/appConstants';

/** Trackers are per-hazard and short-lived; this only bounds a pathological drive. */
const MAX_TRACKED_HAZARDS = 32;

const numeric = (value) => {
  if (value == null || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

export function createHazardAlertGate({
  sustainedFixes = HAZARD_ALERT_SUSTAINED_FIXES,
  releaseSeconds = HAZARD_ALERT_RELEASE_SECONDS,
  cooldownMs = HAZARD_ALERT_GLOBAL_COOLDOWN_MS,
  maxPerDrive = HAZARD_ALERT_MAX_PER_DRIVE,
  approachTolerance = HAZARD_APPROACH_TOLERANCE,
  preemptUrgencyDelta = HAZARD_PREEMPT_URGENCY_DELTA,
  preemptMinIntervalMs = HAZARD_PREEMPT_MIN_INTERVAL_MS,
} = {}) {
  /** @type {Map<string, {etaSeconds: number, alongTrackM: number, atMs: number, fixes: number}>} */
  let trackers = new Map();
  /** @type {Set<string>} */
  let alerted = new Set();
  let lastAlertMs = null;
  let lastAlertUrgency = 0;
  let lastPreemptMs = null;
  let alertCount = 0;

  const dropExpired = (nowMs) => {
    for (const [id, tracker] of trackers) {
      if (nowMs - tracker.atMs > releaseSeconds * 1000) trackers.delete(id);
    }
    while (trackers.size > MAX_TRACKED_HAZARDS) {
      trackers.delete(trackers.keys().next().value);
    }
  };

  const reset = () => {
    trackers = new Map();
    alerted = new Set();
    lastAlertMs = null;
    lastAlertUrgency = 0;
    lastPreemptMs = null;
    alertCount = 0;
  };

  return {
    /**
     * @param {{hazardId: string, kind?: string, etaSeconds: number, urgency?: number,
     *          speedKmh: number, alongTrackM: number, nowMs?: number}} input
     * @returns {{shouldAlert: boolean, reason: string, approachFixes: number}}
     */
    evaluate({
      hazardId, kind = null, etaSeconds, urgency = 0, speedKmh, alongTrackM, nowMs = Date.now(),
    } = {}) {
      const no = (reason, approachFixes = 0) => ({ shouldAlert: false, reason, approachFixes });
      if (!hazardId) {
        dropExpired(nowMs);
        return no('no_hazard');
      }
      if (alerted.has(hazardId)) return no('already_alerted');
      if (alertCount >= maxPerDrive) return no('max_per_drive');

      const eta = numeric(etaSeconds);
      const along = numeric(alongTrackM);
      const speedMs = numeric(speedKmh) / 3.6;
      if (!Number.isFinite(eta) || !Number.isFinite(along) || !(speedMs > 0)) {
        return no('unusable_reading');
      }

      dropExpired(nowMs);
      const previous = trackers.get(hazardId);
      if (!previous) {
        trackers.set(hazardId, { etaSeconds: eta, alongTrackM: along, atMs: nowMs, fixes: 1 });
        return no('awaiting_sustained_approach', 1);
      }

      // A clock that jumps backwards must not produce a negative interval nor
      // latch a stale start forever.
      const atMs = nowMs < previous.atMs ? nowMs : previous.atMs;
      const elapsedS = (nowMs - atMs) / 1000;
      const expectedClosureM = speedMs * elapsedS;
      const actualClosureM = previous.alongTrackM - along;
      const closing = eta < previous.etaSeconds && actualClosureM > 0;
      // The closure rate has to look like the vehicle's own speed. A hazard on a
      // diverging parallel road drifts out of the corridor instead.
      const consistent = expectedClosureM > 0 &&
        Math.abs(actualClosureM - expectedClosureM) <= approachTolerance * expectedClosureM;

      const fixes = closing && consistent ? previous.fixes + 1 : 1;
      trackers.set(hazardId, { etaSeconds: eta, alongTrackM: along, atMs: nowMs, fixes });
      if (fixes < sustainedFixes) return no('awaiting_sustained_approach', fixes);

      if (lastAlertMs != null && nowMs - lastAlertMs < cooldownMs) {
        // One escape, or a mild area caught early would mute a serious hazard
        // that becomes urgent inside the same cooldown.
        const preemptAllowed = urgency - lastAlertUrgency >= preemptUrgencyDelta &&
          (lastPreemptMs == null || nowMs - lastPreemptMs >= preemptMinIntervalMs);
        if (!preemptAllowed) return no('cooldown', fixes);
        lastPreemptMs = nowMs;
      }

      alerted.add(hazardId);
      trackers.delete(hazardId);
      lastAlertMs = nowMs;
      lastAlertUrgency = urgency;
      alertCount += 1;
      return { shouldAlert: true, reason: kind || 'alert', approachFixes: fixes };
    },

    /** A new drive re-arms every hazard: the one-shot set is per drive, not per app run. */
    startDrive() {
      reset();
    },

    reset,

    stats() {
      return {
        alertCount,
        alertedHazards: alerted.size,
        trackedHazards: trackers.size,
        lastAlertMs,
        lastAlertUrgency,
      };
    },
  };
}

/**
 * Dashboard and LiveCoachOverlay both run against the same drive, so they must
 * share one notion of what has already been said. Two independent gates would
 * let the overlay repeat a warning Dashboard had just spoken.
 */
export const liveHazardAlertGate = createHazardAlertGate();
