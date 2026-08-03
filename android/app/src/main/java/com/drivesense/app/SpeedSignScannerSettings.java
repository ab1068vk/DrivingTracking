package com.drivesense.app;

import android.content.Context;

import org.json.JSONObject;

final class SpeedSignScannerSettings {
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String SETTINGS_KEY = "drivesense_settings";

    private SpeedSignScannerSettings() {}

    static boolean isScannerEnabled(Context context) {
        return readBoolean(context, "speed_sign_scanner_enabled", false);
    }

    static boolean isMountedModeEnabled(Context context) {
        return readBoolean(context, "speed_sign_mounted_mode_enabled", false);
    }

    static String units(Context context) {
        try {
            JSONObject settings = readSettings(context);
            return settings != null && "imperial".equals(settings.optString("units", "metric"))
                ? "imperial"
                : "metric";
        } catch (Exception ignored) {
            return "metric";
        }
    }

    static boolean readBooleanFromJson(String raw, String key, boolean defaultValue) {
        try {
            if (raw == null || raw.trim().isEmpty()) return defaultValue;
            JSONObject settings = new JSONObject(raw);
            if (!settings.has(key) || settings.isNull(key)) return defaultValue;
            return settings.optBoolean(key, defaultValue);
        } catch (Exception ignored) {
            return defaultValue;
        }
    }

    static boolean isTripSessionActive(
        boolean nativeTripActive,
        boolean requireNativeTrip,
        String fallbackTripId
    ) {
        if (nativeTripActive) return true;
        return !requireNativeTrip && fallbackTripId != null && !fallbackTripId.trim().isEmpty();
    }

    static boolean shouldStartArmedScanner(
        boolean active,
        boolean candidate,
        boolean manual,
        String state
    ) {
        return active && !candidate && !manual && "recording".equals(state);
    }

    static boolean shouldKeepWaitingForPreparedTrip(
        boolean waitingForAutomaticTrip,
        boolean waitingForPreparedManualTrip
    ) {
        return waitingForAutomaticTrip || waitingForPreparedManualTrip;
    }

    static boolean shouldStartPreparedManualScanner(
        boolean active,
        boolean candidate,
        boolean manual,
        String state,
        String activeTripId,
        String expectedTripId
    ) {
        String activeId = activeTripId == null ? "" : activeTripId.trim();
        String expectedId = expectedTripId == null ? "" : expectedTripId.trim();
        return active
            && !candidate
            && manual
            && "recording".equals(state)
            && !expectedId.isEmpty()
            && expectedId.equals(activeId);
    }

    private static boolean readBoolean(Context context, String key, boolean defaultValue) {
        try {
            String raw = context
                .getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(SETTINGS_KEY, null);
            return readBooleanFromJson(raw, key, defaultValue);
        } catch (Exception ignored) {
            return defaultValue;
        }
    }

    private static JSONObject readSettings(Context context) {
        try {
            String raw = context
                .getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(SETTINGS_KEY, null);
            return raw == null || raw.trim().isEmpty() ? null : new JSONObject(raw);
        } catch (Exception ignored) {
            return null;
        }
    }
}
