/**
 * Why a drive stayed quiet, tallied across the drive rather than per fix.
 *
 * This exists because of the predicted failure mode of the hazard horizon: it
 * suppresses far more than the radial alert it replaced — hazards behind, off
 * corridor, beyond the horizon, already alerted — so a normal working drive and
 * a broken one both look like silence. The difference is only visible in the
 * reason tallies, which means they have to survive the drive and reach the
 * tracking diagnostics console.
 *
 * A single fix's diagnostics answer nothing ("this one fix was too slow"). The
 * drive-level counts answer the actual question: 400 fixes all rejected for
 * `below_min_speed` is a stuck speed source, all rejected for `no_heading` is a
 * bearing problem, and an empty knowledge base is a different bug again from
 * "nothing was ahead of you".
 *
 * Kept out of `useHazardHorizon` so it is a plain object with no React in the
 * way: the hook renders, this counts.
 */

/** Drive-level tallies. */
const blank = () => ({
  fixes: 0, stopReasons: {}, suppressed: {}, knownZones: 0, knownSegments: 0,
});

const bump = (into, key, by = 1) => {
  if (key) into[key] = (into[key] || 0) + by;
};

/** The reason accounting for the most fixes, which is the one worth reporting. */
const dominant = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || null;

export function createHazardDriveTally() {
  let drive = blank();

  return {
    /** @param {{diagnostics?: any, suppressed?: Array<{reason: string}>}} horizon */
    record(horizon) {
      if (!horizon) return;
      const diagnostics = horizon.diagnostics || {};
      drive.fixes += 1;
      // A stop reason means the fix was never projected, so its lone `suppressed`
      // entry is the same fact restated. Only one of the two tallies applies.
      if (diagnostics.stopReason) {
        bump(drive.stopReasons, diagnostics.stopReason);
      } else {
        for (const entry of horizon.suppressed || []) bump(drive.suppressed, entry?.reason);
      }
      drive.knownZones = Math.max(drive.knownZones, Number(diagnostics.knownZones) || 0);
      drive.knownSegments = Math.max(drive.knownSegments, Number(diagnostics.knownSegments) || 0);
    },

    /**
     * The diagnostic event for the drive that just ended, or null when there is
     * nothing to report. Resets the tally, so one drive cannot inflate the next.
     *
     * Returns the event rather than writing it: `recordTrackingDiagnostic`
     * rewrites a 120-entry localStorage ring buffer per call, and deciding
     * whether a write is worth making is this function's whole job.
     *
     * @param {{alertCount?: number}} gateStats
     */
    flush(gateStats = {}) {
      const ended = drive;
      drive = blank();
      // reset() also runs on mount and on every tracking-state change, so an
      // unstarted drive must not leave a misleading empty record behind.
      if (ended.fixes === 0) return null;

      const alertCount = Number(gateStats.alertCount) || 0;
      const topStop = dominant(ended.stopReasons);
      const topSuppressed = dominant(ended.suppressed);
      return {
        type: 'hazard_horizon_summary',
        title: 'Hazard warnings this drive',
        detail: `${alertCount} spoken over ${ended.fixes} evaluated fixes`
          + ` (${ended.knownZones} known areas, ${ended.knownSegments} known segments).`
          + (topStop ? ` Most fixes skipped: ${topStop[0]} x${topStop[1]}.` : '')
          + (topSuppressed ? ` Most suppressed hazard reason: ${topSuppressed[0]} x${topSuppressed[1]}.` : ''),
        context: 'hazard_horizon',
        reason: topStop?.[0] || topSuppressed?.[0] || null,
        alert_count: alertCount,
        fixes: ended.fixes,
        known_zones: ended.knownZones,
        known_segments: ended.knownSegments,
        stop_reasons: ended.stopReasons,
        suppressed_reasons: ended.suppressed,
      };
    },
  };
}
