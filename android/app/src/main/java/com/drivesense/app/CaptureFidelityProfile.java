package com.drivesense.app;

/**
 * Motion-capture budgets for the `capture_fidelity` setting. Pure logic for unit testing.
 *
 * Mirrors src/lib/captureFidelity.js and src/lib/appConstants.js. Fidelity is its
 * own setting rather than a behaviour of experience_mode, because experience_mode
 * is a presentation contract: letting a cosmetic toggle change what lands on disk
 * would make trips recorded in the two modes non-comparable.
 *
 * GPS cadence is deliberately identical under every fidelity. GPS dominates
 * battery, and the IMU already runs at SENSOR_DELAY_GAME for every trip with most
 * of it discarded before storage, so high fidelity mostly stops throwing data
 * away. The cost is storage, which is why both a sample-count budget and a byte
 * budget exist — a count-only cap is how a device with little free space ends up
 * with a 40 MB trip.
 */
final class CaptureFidelityProfile {

    static final String STANDARD = "standard";
    static final String HIGH = "high";

    static final int STANDARD_SAMPLE_BUDGET = 5000;
    static final int HIGH_SAMPLE_BUDGET = 15000;
    /** Roughly the on-disk size of one serialized motion sample. */
    static final int SAMPLE_BYTES_ESTIMATE = 200;
    /** Hard ceiling on stored motion bytes for a single trip, at any fidelity. */
    static final long MAX_MOTION_BYTES_PER_TRIP = 4L * 1024L * 1024L;

    private CaptureFidelityProfile() {
    }

    static String normalize(String fidelity) {
        if (fidelity == null) return STANDARD;
        String trimmed = fidelity.trim().toLowerCase();
        return HIGH.equals(trimmed) ? HIGH : STANDARD;
    }

    static Profile resolve(String fidelity) {
        return HIGH.equals(normalize(fidelity))
            ? new Profile(HIGH, HIGH_SAMPLE_BUDGET, 100L, true)
            : new Profile(STANDARD, STANDARD_SAMPLE_BUDGET, 100L, false);
    }

    /**
     * Drops the effective budget when the device is short on space, so the
     * low-storage pressure event AppExperienceWatchdog already reports actually
     * changes behaviour instead of only being logged.
     */
    static Profile underStoragePressure(Profile profile, boolean lowStorage) {
        if (profile == null) return resolve(STANDARD);
        if (!lowStorage || profile.sampleBudget <= STANDARD_SAMPLE_BUDGET) return profile;
        return new Profile(profile.fidelity, STANDARD_SAMPLE_BUDGET, profile.sampleMinIntervalMs, false);
    }

    static final class Profile {
        final String fidelity;
        final int sampleBudget;
        final long sampleMinIntervalMs;
        final boolean eventWindowsEnabled;

        Profile(String fidelity, int sampleBudget, long sampleMinIntervalMs, boolean eventWindowsEnabled) {
            this.fidelity = fidelity;
            this.sampleBudget = sampleBudget;
            this.sampleMinIntervalMs = sampleMinIntervalMs;
            this.eventWindowsEnabled = eventWindowsEnabled;
        }

        /**
         * The count budget capped by the byte ceiling, whichever binds first.
         *
         * `bytesPerSample` must come from a real serialized sample, not from
         * SAMPLE_BYTES_ESTIMATE — a byte cap derived from the same estimate that
         * sized the count budget could never bind and would be decorative. The
         * estimate is only the fallback for the very first sample of a trip.
         */
        int effectiveSampleBudget(long bytesPerSample) {
            long perSample = bytesPerSample > 0L ? bytesPerSample : SAMPLE_BYTES_ESTIMATE;
            long byteBudget = MAX_MOTION_BYTES_PER_TRIP / perSample;
            if (byteBudget < 1L) byteBudget = 1L;
            return (int) Math.min((long) sampleBudget, byteBudget);
        }

        long estimatedBytes() {
            return (long) sampleBudget * SAMPLE_BYTES_ESTIMATE;
        }
    }
}
