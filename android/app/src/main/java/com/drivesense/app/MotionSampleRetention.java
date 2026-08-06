package com.drivesense.app;

import org.json.JSONArray;

/**
 * Keeps the in-trip IMU buffer inside its budget without deleting the beginning
 * of the drive.
 *
 * The previous policy was FIFO: once the buffer hit its cap every new sample
 * evicted the oldest one, so a long drive kept only its tail. At the 10 Hz
 * sampling cadence and a 5000-sample budget that meant a 30-minute drive threw
 * away its first ~22 minutes outright — the buffer silently became a
 * last-8-minutes recorder while everything downstream still read it as "the
 * trip's motion data".
 *
 * Generational decimation instead thins the oldest half by dropping every second
 * sample. Coverage stays whole-trip; only the resolution of older stretches
 * degrades, and it degrades in halvings, so the oldest generation of a very long
 * drive is coarse rather than absent. Every consumer already treats these
 * samples as an irregular time series keyed on each sample's own timestamp
 * (normalizeMotionSample / buildSensorFusionSummary / detectLaneChanges), so no
 * reader assumes a fixed rate and the on-disk shape is unchanged.
 */
final class MotionSampleRetention {

    /** Below this the halving maths cannot make progress, so callers fall back to FIFO. */
    static final int MIN_DECIMATION_BUDGET = 8;

    private MotionSampleRetention() {
    }

    /**
     * Thin {@code samples} in place until it fits {@code budget}.
     *
     * @return the number of samples dropped, for capture-profile reporting.
     */
    static int enforceBudget(JSONArray samples, int budget) {
        if (samples == null || budget <= 0) return 0;
        int dropped = 0;
        while (samples.length() > budget) {
            int thinned = budget >= MIN_DECIMATION_BUDGET ? thinOldestHalf(samples) : 0;
            if (thinned <= 0) {
                // Degenerate budget: keep the cap honest rather than looping forever.
                samples.remove(0);
                thinned = 1;
            }
            dropped += thinned;
        }
        return dropped;
    }

    /**
     * Drops every second sample from the oldest half, keeping index 0 so the
     * moment the drive started is never the sample that gets evicted.
     */
    private static int thinOldestHalf(JSONArray samples) {
        int half = samples.length() / 2;
        if (half < 2) return 0;
        int start = half - 1;
        if (start % 2 == 0) start -= 1;
        int dropped = 0;
        // Descending so each removal cannot shift an index still to be visited.
        for (int index = start; index >= 1; index -= 2) {
            samples.remove(index);
            dropped++;
        }
        return dropped;
    }
}
