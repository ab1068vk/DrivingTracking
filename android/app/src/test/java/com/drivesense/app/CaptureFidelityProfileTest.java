package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CaptureFidelityProfileTest {

    @Test
    public void unknownAndBlankValuesResolveToStandard() {
        assertEquals(CaptureFidelityProfile.STANDARD, CaptureFidelityProfile.normalize(null));
        assertEquals(CaptureFidelityProfile.STANDARD, CaptureFidelityProfile.normalize(""));
        assertEquals(CaptureFidelityProfile.STANDARD, CaptureFidelityProfile.normalize("   "));
        assertEquals(CaptureFidelityProfile.STANDARD, CaptureFidelityProfile.normalize("ultra"));
        assertEquals(CaptureFidelityProfile.HIGH, CaptureFidelityProfile.normalize("HIGH"));
        assertEquals(CaptureFidelityProfile.HIGH, CaptureFidelityProfile.normalize(" high "));
    }

    @Test
    public void standardMatchesTodaysRecordingBehaviour() {
        CaptureFidelityProfile.Profile standard = CaptureFidelityProfile.resolve(CaptureFidelityProfile.STANDARD);

        assertEquals(CaptureFidelityProfile.STANDARD_SAMPLE_BUDGET, standard.sampleBudget);
        assertEquals(100L, standard.sampleMinIntervalMs);
        assertFalse(standard.eventWindowsEnabled);
    }

    @Test
    public void highKeepsMoreHistoryAtTheSameSamplingRate() {
        CaptureFidelityProfile.Profile standard = CaptureFidelityProfile.resolve(CaptureFidelityProfile.STANDARD);
        CaptureFidelityProfile.Profile high = CaptureFidelityProfile.resolve(CaptureFidelityProfile.HIGH);

        assertEquals(CaptureFidelityProfile.HIGH_SAMPLE_BUDGET, high.sampleBudget);
        assertTrue(high.sampleBudget > standard.sampleBudget);
        assertTrue(high.eventWindowsEnabled);
        // The sampling interval must not change: that is what keeps trips recorded
        // at either fidelity comparable to each other.
        assertEquals(standard.sampleMinIntervalMs, high.sampleMinIntervalMs);
    }

    @Test
    public void byteCeilingBindsWhenSamplesAreFatterThanEstimated() {
        CaptureFidelityProfile.Profile high = CaptureFidelityProfile.resolve(CaptureFidelityProfile.HIGH);

        // At the nominal size the count budget governs.
        assertEquals(
            CaptureFidelityProfile.HIGH_SAMPLE_BUDGET,
            high.effectiveSampleBudget(CaptureFidelityProfile.SAMPLE_BYTES_ESTIMATE)
        );
        // At 600 bytes per sample the byte ceiling governs instead, which is the
        // whole point: a count-only cap is how a trip reaches tens of megabytes.
        int capped = high.effectiveSampleBudget(600L);
        assertTrue(capped < CaptureFidelityProfile.HIGH_SAMPLE_BUDGET);
        assertTrue((long) capped * 600L <= CaptureFidelityProfile.MAX_MOTION_BYTES_PER_TRIP);
    }

    @Test
    public void unmeasuredSampleSizeFallsBackToTheEstimate() {
        CaptureFidelityProfile.Profile high = CaptureFidelityProfile.resolve(CaptureFidelityProfile.HIGH);

        assertEquals(
            high.effectiveSampleBudget(CaptureFidelityProfile.SAMPLE_BYTES_ESTIMATE),
            high.effectiveSampleBudget(0L)
        );
        assertEquals(
            high.effectiveSampleBudget(CaptureFidelityProfile.SAMPLE_BYTES_ESTIMATE),
            high.effectiveSampleBudget(-10L)
        );
    }

    @Test
    public void neverReturnsAZeroBudget() {
        CaptureFidelityProfile.Profile high = CaptureFidelityProfile.resolve(CaptureFidelityProfile.HIGH);

        assertTrue(high.effectiveSampleBudget(Long.MAX_VALUE) >= 1);
    }

    @Test
    public void lowStorageDowngradesHighFidelityToTheStandardBudget() {
        CaptureFidelityProfile.Profile high = CaptureFidelityProfile.resolve(CaptureFidelityProfile.HIGH);
        CaptureFidelityProfile.Profile degraded = CaptureFidelityProfile.underStoragePressure(high, true);

        assertEquals(CaptureFidelityProfile.STANDARD_SAMPLE_BUDGET, degraded.sampleBudget);
        assertFalse(degraded.eventWindowsEnabled);
        // The user's chosen fidelity is preserved so the downgrade is reportable
        // rather than looking like the setting silently reverted.
        assertEquals(CaptureFidelityProfile.HIGH, degraded.fidelity);
    }

    @Test
    public void lowStorageLeavesTheStandardProfileAlone() {
        CaptureFidelityProfile.Profile standard = CaptureFidelityProfile.resolve(CaptureFidelityProfile.STANDARD);

        assertEquals(standard, CaptureFidelityProfile.underStoragePressure(standard, true));
        assertEquals(standard, CaptureFidelityProfile.underStoragePressure(standard, false));
    }

    @Test
    public void ampleStorageLeavesHighFidelityIntact() {
        CaptureFidelityProfile.Profile high = CaptureFidelityProfile.resolve(CaptureFidelityProfile.HIGH);

        assertEquals(high, CaptureFidelityProfile.underStoragePressure(high, false));
    }

    @Test
    public void nullProfileResolvesRatherThanThrowing() {
        assertEquals(
            CaptureFidelityProfile.STANDARD,
            CaptureFidelityProfile.underStoragePressure(null, true).fidelity
        );
    }
}
