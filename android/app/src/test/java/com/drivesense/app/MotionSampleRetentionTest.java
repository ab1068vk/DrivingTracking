package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MotionSampleRetentionTest {

    private static final int BUDGET = 5000;
    /** 10 Hz sampling, matching MOTION_SAMPLE_MIN_INTERVAL_MS. */
    private static final long SAMPLE_INTERVAL_MS = 100L;

    private static JSONArray sampleRun(int count) throws Exception {
        JSONArray samples = new JSONArray();
        for (int index = 0; index < count; index++) {
            samples.put(new JSONObject().put("timestamp_ms", index * SAMPLE_INTERVAL_MS));
        }
        return samples;
    }

    /**
     * Feeds samples one at a time, exactly as appendMotionSample does, so the
     * test exercises the real amortized call pattern rather than one bulk pass.
     */
    private static JSONArray recordDrive(int sampleCount) throws Exception {
        JSONArray samples = new JSONArray();
        for (int index = 0; index < sampleCount; index++) {
            samples.put(new JSONObject().put("timestamp_ms", index * SAMPLE_INTERVAL_MS));
            MotionSampleRetention.enforceBudget(samples, BUDGET);
        }
        return samples;
    }

    private static long firstTimestamp(JSONArray samples) {
        return samples.optJSONObject(0).optLong("timestamp_ms", -1L);
    }

    private static long lastTimestamp(JSONArray samples) {
        return samples.optJSONObject(samples.length() - 1).optLong("timestamp_ms", -1L);
    }

    @Test
    public void leavesBuffersInsideBudgetUntouched() throws Exception {
        JSONArray samples = sampleRun(BUDGET);

        assertEquals(0, MotionSampleRetention.enforceBudget(samples, BUDGET));
        assertEquals(BUDGET, samples.length());
    }

    @Test
    public void keepsWholeTripCoverageAfterThreeTimesBudgetOverflow() throws Exception {
        // 15000 samples at 10 Hz is a 25-minute drive: three times the budget.
        int recorded = BUDGET * 3;
        JSONArray samples = recordDrive(recorded);
        long driveEndMs = (recorded - 1) * SAMPLE_INTERVAL_MS;

        assertTrue("buffer must stay inside budget", samples.length() <= BUDGET);
        // The old FIFO policy would have left first == (recorded - BUDGET) * interval,
        // i.e. the first 20 minutes of the drive deleted outright.
        assertEquals("the drive's first sample must survive", 0L, firstTimestamp(samples));
        assertEquals("the drive's latest sample must survive", driveEndMs, lastTimestamp(samples));

        // Coverage, not just endpoints: every tenth of the drive must retain samples.
        for (int bucket = 0; bucket < 10; bucket++) {
            long from = (driveEndMs * bucket) / 10;
            long to = (driveEndMs * (bucket + 1)) / 10;
            int inBucket = 0;
            for (int index = 0; index < samples.length(); index++) {
                long timestamp = samples.optJSONObject(index).optLong("timestamp_ms", -1L);
                if (timestamp >= from && timestamp < to) inBucket++;
            }
            assertTrue("decile " + bucket + " of the drive lost all coverage", inBucket > 0);
        }
    }

    @Test
    public void degradesOlderStretchesBeforeNewerOnes() throws Exception {
        JSONArray samples = recordDrive(BUDGET * 3);
        long driveEndMs = (BUDGET * 3 - 1) * SAMPLE_INTERVAL_MS;
        long midpoint = driveEndMs / 2;

        int older = 0;
        int newer = 0;
        for (int index = 0; index < samples.length(); index++) {
            if (samples.optJSONObject(index).optLong("timestamp_ms", -1L) < midpoint) older++;
            else newer++;
        }

        assertTrue("recent driving should keep the finer resolution", newer > older);
        assertTrue("older driving must still be represented", older > 0);
    }

    @Test
    public void survivesAVeryLongDriveWithoutLosingItsStart() throws Exception {
        // 60000 samples at 10 Hz is a 100-minute drive.
        JSONArray samples = recordDrive(BUDGET * 12);

        assertTrue(samples.length() <= BUDGET);
        assertEquals(0L, firstTimestamp(samples));
        assertEquals((BUDGET * 12 - 1) * SAMPLE_INTERVAL_MS, lastTimestamp(samples));
    }

    @Test
    public void timestampsStayStrictlyIncreasing() throws Exception {
        JSONArray samples = recordDrive(BUDGET * 3);

        long previous = -1L;
        for (int index = 0; index < samples.length(); index++) {
            long timestamp = samples.optJSONObject(index).optLong("timestamp_ms", -1L);
            assertTrue("samples must stay in chronological order", timestamp > previous);
            previous = timestamp;
        }
    }

    @Test
    public void reportsHowManySamplesWereDropped() throws Exception {
        int recorded = BUDGET * 3;
        JSONArray samples = new JSONArray();
        int dropped = 0;
        for (int index = 0; index < recorded; index++) {
            samples.put(new JSONObject().put("timestamp_ms", index * SAMPLE_INTERVAL_MS));
            dropped += MotionSampleRetention.enforceBudget(samples, BUDGET);
        }

        assertEquals(recorded, samples.length() + dropped);
    }

    @Test
    public void enforcesDegenerateBudgetsWithoutLooping() throws Exception {
        JSONArray samples = sampleRun(20);

        int dropped = MotionSampleRetention.enforceBudget(samples, 3);

        assertEquals(3, samples.length());
        assertEquals(17, dropped);
    }

    @Test
    public void ignoresNullBuffersAndNonPositiveBudgets() throws Exception {
        assertEquals(0, MotionSampleRetention.enforceBudget(null, BUDGET));
        assertEquals(0, MotionSampleRetention.enforceBudget(sampleRun(10), 0));
    }
}
