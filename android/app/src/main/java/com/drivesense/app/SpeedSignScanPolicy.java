package com.drivesense.app;

import android.os.PowerManager;

/** Battery/heat/corridor-aware OCR schedule. Pure logic for unit testing. */
final class SpeedSignScanPolicy {
    private SpeedSignScanPolicy() {}

    static Decision decide(
        int batteryPercent,
        boolean charging,
        int thermalStatus,
        double speedKmh,
        boolean confirmedRoad,
        long msSinceCandidate
    ) {
        if (speedKmh < 12d) return new Decision(6_000L, "Paused while slow", false);
        if (thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) {
            return new Decision(4_000L, "Heat-saving scan", true);
        }
        if (!charging && batteryPercent <= 30) {
            return new Decision(2_500L, "Battery-saving scan", true);
        }
        if (msSinceCandidate >= 0L && msSinceCandidate < 60_000L) {
            return new Decision(2_000L, "Recent sign cooldown", true);
        }
        if (confirmedRoad) {
            return new Decision(1_200L, "Confirmed-road change watch", true);
        }
        return new Decision(900L, "Unknown-road active scan", true);
    }

    static final class Decision {
        final long analysisIntervalMs;
        final String label;
        final boolean analyze;

        Decision(long analysisIntervalMs, String label, boolean analyze) {
            this.analysisIntervalMs = analysisIntervalMs;
            this.label = label;
            this.analyze = analyze;
        }
    }
}
