package com.drivesense.app;

import android.os.PowerManager;

/**
 * Battery/heat-aware in-trip capture ladder. Pure logic for unit testing.
 *
 * This is a protective governor, not an optimizer. Framing it as an optimizer is
 * what would make it dangerous: it would then be tempted to trade fidelity for
 * battery during ordinary driving. Instead it only acts in states where the
 * realistic alternative is a dead phone or a thermally throttled service and a
 * lost trip — reduced fidelity beats no trip.
 *
 * The invariant that makes this safe:
 *
 *   NORMAL is the ceiling. No tier may return an interval shorter than NORMAL's.
 *
 * Because NORMAL's values are exactly today's values, the default path stays
 * bit-identical to current behaviour, which removes "adaptive sampling degraded
 * my data" as a default-path failure mode.
 *
 * THERMAL_GUARD deliberately leaves GPS alone. Device heat is dominated by CPU
 * and radio work; dropping the GPS rate is what actually breaks the product,
 * while thinning IMU sampling costs far less.
 */
final class CaptureTierPolicy {

    static final String TIER_NORMAL = "normal";
    static final String TIER_THERMAL_GUARD = "thermal_guard";
    static final String TIER_BATTERY_GUARD = "battery_guard";
    static final String TIER_CRITICAL = "critical";

    /** Today's live-trip values. Every other tier must be at least this coarse. */
    static final long NORMAL_LOCATION_INTERVAL_MS = 2000L;
    static final long NORMAL_MIN_UPDATE_INTERVAL_MS = 1000L;
    static final long NORMAL_MOTION_INTERVAL_MS = 100L;

    /** No degradation happens above this battery level, whatever else is true. */
    static final int BATTERY_GUARD_PERCENT = 15;
    static final int CRITICAL_BATTERY_PERCENT = 5;

    private CaptureTierPolicy() {
    }

    static Decision decide(
        int batteryPercent,
        boolean charging,
        int thermalStatus,
        boolean adaptiveEnabled
    ) {
        if (!adaptiveEnabled) return normal("Adaptive capture is off");

        boolean severeHeat = thermalStatus >= PowerManager.THERMAL_STATUS_SEVERE;
        boolean criticalBattery = !charging && batteryPercent >= 0 && batteryPercent <= CRITICAL_BATTERY_PERCENT;
        if (severeHeat || criticalBattery) {
            return new Decision(
                8000L,
                4000L,
                0L,
                TIER_CRITICAL,
                "Critical power saving",
                severeHeat ? "thermal_status_severe" : "battery_at_or_below_5_percent_not_charging"
            );
        }

        if (!charging && batteryPercent >= 0 && batteryPercent <= BATTERY_GUARD_PERCENT) {
            return new Decision(
                4000L,
                2000L,
                250L,
                TIER_BATTERY_GUARD,
                "Battery guard",
                "battery_at_or_below_15_percent_not_charging"
            );
        }

        if (thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) {
            // GPS stays at NORMAL on purpose; only motion sampling thins.
            return new Decision(
                NORMAL_LOCATION_INTERVAL_MS,
                NORMAL_MIN_UPDATE_INTERVAL_MS,
                200L,
                TIER_THERMAL_GUARD,
                "Heat guard",
                "thermal_status_moderate_or_higher"
            );
        }

        return normal("no_pressure");
    }

    private static Decision normal(String reason) {
        return new Decision(
            NORMAL_LOCATION_INTERVAL_MS,
            NORMAL_MIN_UPDATE_INTERVAL_MS,
            NORMAL_MOTION_INTERVAL_MS,
            TIER_NORMAL,
            "Full capture",
            reason
        );
    }

    static final class Decision {
        final long locationIntervalMs;
        final long minUpdateIntervalMs;
        /** 0 means motion sampling is suspended for this tier. */
        final long motionSampleMinIntervalMs;
        final String tier;
        final String label;
        final String reason;

        Decision(
            long locationIntervalMs,
            long minUpdateIntervalMs,
            long motionSampleMinIntervalMs,
            String tier,
            String label,
            String reason
        ) {
            this.locationIntervalMs = locationIntervalMs;
            this.minUpdateIntervalMs = minUpdateIntervalMs;
            this.motionSampleMinIntervalMs = motionSampleMinIntervalMs;
            this.tier = tier;
            this.label = label;
            this.reason = reason;
        }

        boolean isThrottled() {
            return !TIER_NORMAL.equals(tier);
        }

        boolean motionSuspended() {
            return motionSampleMinIntervalMs <= 0L;
        }
    }
}
