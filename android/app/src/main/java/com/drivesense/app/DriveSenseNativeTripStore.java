package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;

class DriveSenseNativeTripStore {
    private static final String TAG = "NativeTripStore";
    private static final String PREFS = "drivesense_native_tracking";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String KEY_COMPLETED_TRIPS = "completed_trips";
    private static final String KEY_SERVICE_ENABLED = "service_enabled";
    private static final String KEY_ACTIVE_TRIP_STATUS = "active_trip_status";
    private static final String KEY_WIDGET_TRIP_ACTIVE = "widget_trip_active";
    private static final String KEY_DIAGNOSTIC_EVENTS = "diagnostic_events";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final String SHARED_LAST_PARKED_KEY = "drivesense_last_parked";
    private static final String COMPLETED_TRIPS_CONTEXT = "native:completed_trips";
    private static final String ACTIVE_TRIP_STATUS_CONTEXT = "native:active_trip_status";
    private static final String LAST_PARKED_CONTEXT = "native:last_parked";
    private static final String SHARED_LAST_PARKED_CONTEXT = "storage:drivesense_last_parked";
    private static final int MAX_DIAGNOSTIC_EVENTS = 120;

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isServiceEnabled(Context context) {
        return prefs(context).getBoolean(KEY_SERVICE_ENABLED, false);
    }

    static void setServiceEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_SERVICE_ENABLED, enabled).apply();
    }

    static JSONObject getActiveTripStatus(Context context) {
        String stored = prefs(context).getString(KEY_ACTIVE_TRIP_STATUS, "");
        if (stored == null || stored.trim().isEmpty()) return null;
        try {
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, ACTIVE_TRIP_STATUS_CONTEXT);
            JSONObject status = new JSONObject(raw);
            if (!DriveSensePayloadCrypto.isEncryptedStoredValue(stored)) {
                setActiveTripStatus(context, status);
            }
            return status;
        } catch (Exception error) {
            clearActiveTripStatus(context);
            return null;
        }
    }

    static void setActiveTripStatus(Context context, JSONObject status) {
        if (status == null) {
            clearActiveTripStatus(context);
            return;
        }
        try {
            boolean wasActive = prefs(context).getBoolean(KEY_WIDGET_TRIP_ACTIVE, false);
            boolean isActive = status.optBoolean("active", false);
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(status.toString(), ACTIVE_TRIP_STATUS_CONTEXT);
            prefs(context).edit()
                .putString(KEY_ACTIVE_TRIP_STATUS, encrypted)
                .putBoolean(KEY_WIDGET_TRIP_ACTIVE, isActive)
                .apply();
            if (wasActive != isActive) WhereIParkedWidgetProvider.refreshAll(context);
        } catch (Exception ignored) {}
    }

    static void clearActiveTripStatus(Context context) {
        boolean wasActive = prefs(context).getBoolean(KEY_WIDGET_TRIP_ACTIVE, false);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(prefs(context), KEY_ACTIVE_TRIP_STATUS)) {
            prefs(context).edit().remove(KEY_ACTIVE_TRIP_STATUS).apply();
        }
        prefs(context).edit().putBoolean(KEY_WIDGET_TRIP_ACTIVE, false).apply();
        if (wasActive) WhereIParkedWidgetProvider.refreshAll(context);
    }

    static JSONArray getCompletedTrips(Context context) {
        String stored = prefs(context).getString(KEY_COMPLETED_TRIPS, "[]");
        try {
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, COMPLETED_TRIPS_CONTEXT);
            if (!DriveSensePayloadCrypto.isEncryptedStoredValue(stored)) {
                saveCompletedTrips(context, raw);
            }
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static void addCompletedTrip(Context context, JSONObject trip) {
        JSONArray current = getCompletedTrips(context);
        JSONArray next = new JSONArray();
        String tripId = trip == null ? "" : trip.optString("id", "");
        boolean replaced = false;
        for (int i = 0; i < current.length(); i++) {
            JSONObject existing = current.optJSONObject(i);
            if (
                !replaced &&
                existing != null &&
                !tripId.isEmpty() &&
                tripId.equals(existing.optString("id", ""))
            ) {
                next.put(trip);
                replaced = true;
            } else if (existing != null) {
                next.put(existing);
            }
        }
        if (!replaced && trip != null) next.put(trip);
        saveCompletedTrips(context, next.toString());
    }

    static boolean acknowledgePendingEmergencyWorkflow(Context context, String acknowledgedAt) {
        JSONArray current = getCompletedTrips(context);
        JSONArray next = new JSONArray();
        boolean changed = false;
        for (int i = 0; i < current.length(); i++) {
            JSONObject trip = current.optJSONObject(i);
            if (trip == null) continue;
            boolean tripChanged = false;
            JSONArray events = trip.optJSONArray("driving_events");
            if (events != null) {
                for (int eventIndex = 0; eventIndex < events.length(); eventIndex++) {
                    JSONObject event = events.optJSONObject(eventIndex);
                    if (event == null || !"possible_crash".equals(event.optString("type", ""))) continue;
                    if (!event.optBoolean("emergency_workflow_pending", false) && event.has("emergency_workflow_acknowledged")) continue;
                    try {
                        event.put("emergency_workflow_pending", false);
                        event.put("emergency_workflow_acknowledged", "ok");
                        event.put("emergency_workflow_acknowledged_at", acknowledgedAt);
                        tripChanged = true;
                    } catch (JSONException ignored) {}
                }
            }
            if (trip.optBoolean("emergency_workflow_pending", false)) {
                try {
                    trip.put("emergency_workflow_pending", false);
                    trip.put("emergency_workflow_acknowledged_at", acknowledgedAt);
                    trip.put("emergency_workflow_acknowledged_action", "ok");
                    tripChanged = true;
                } catch (JSONException ignored) {}
            }
            if (tripChanged) changed = true;
            next.put(trip);
        }
        if (changed) saveCompletedTrips(context, next.toString());
        return changed;
    }

    static void clearCompletedTrips(Context context) {
        if (!SecureDeleteHelper.overwriteAndRemovePreference(prefs(context), KEY_COMPLETED_TRIPS)) {
            saveCompletedTrips(context, "[]");
        }
    }

    private static void saveCompletedTrips(Context context, String raw) {
        try {
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(raw, COMPLETED_TRIPS_CONTEXT);
            prefs(context).edit().putString(KEY_COMPLETED_TRIPS, encrypted).apply();
        } catch (Exception ignored) {}
    }

    static JSONArray getDiagnosticEvents(Context context) {
        String raw = prefs(context).getString(KEY_DIAGNOSTIC_EVENTS, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void addDiagnosticEvent(Context context, JSONObject event) {
        JSONArray current = getDiagnosticEvents(context);
        JSONArray next = new JSONArray();
        next.put(event);
        for (int i = 0; i < current.length() && next.length() < MAX_DIAGNOSTIC_EVENTS; i++) {
            JSONObject item = current.optJSONObject(i);
            if (item != null) next.put(item);
        }
        prefs(context).edit().putString(KEY_DIAGNOSTIC_EVENTS, next.toString()).apply();
    }

    static void clearDiagnosticEvents(Context context) {
        prefs(context).edit().putString(KEY_DIAGNOSTIC_EVENTS, "[]").apply();
    }

    static JSONObject getLastParkedLocation(Context context) {
        JSONObject nativeParked = readParkedLocation(
            prefs(context).getString(KEY_LAST_PARKED, null),
            LAST_PARKED_CONTEXT
        );
        JSONObject sharedParked = readParkedLocation(
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(SHARED_LAST_PARKED_KEY, null),
            SHARED_LAST_PARKED_CONTEXT
        );
        JSONObject parked = parkedTimestampMs(sharedParked) >= parkedTimestampMs(nativeParked)
            ? sharedParked
            : nativeParked;
        if (parked == null || parked.optBoolean("suppressed", false)) return null;
        if (PrivacyZoneChecker.isInsidePrivacyZone(
            context,
            parked.optDouble("lat", Double.NaN),
            parked.optDouble("lng", Double.NaN)
        )) {
            clearLastParkedLocation(context);
            return null;
        }
        return parked;
    }

    private static JSONObject readParkedLocation(String stored, String contextName) {
        if (stored == null || stored.trim().isEmpty()) return null;
        try {
            String raw;
            if (DriveSensePayloadCrypto.isEncryptedStoredValue(stored)) {
                raw = DriveSensePayloadCrypto.decryptStoredValue(stored, contextName);
            } else {
                JSONObject wrapper = new JSONObject(stored);
                if (wrapper.optBoolean("encrypted", false) && wrapper.has("ciphertext")) {
                    raw = DriveSensePayloadCrypto.decrypt(
                        wrapper.getString("ciphertext"),
                        contextName,
                        wrapper.optInt("key_version", 0)
                    );
                } else {
                    raw = stored;
                }
            }
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private static long parkedTimestampMs(JSONObject parked) {
        if (parked == null) return Long.MIN_VALUE;
        long storedMs = parked.optLong("timestamp_ms", 0L);
        if (storedMs > 0L) return storedMs;
        try {
            return Instant.parse(parked.optString("timestamp", "")).toEpochMilli();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    static void saveLastParkedLocation(Context context, double lat, double lng, long timestampMs, String tripId, String source) {
        saveLastParkedLocation(context, lat, lng, timestampMs, tripId, source, null);
    }

    static void saveLastParkedLocation(
        Context context,
        double lat,
        double lng,
        long timestampMs,
        String tripId,
        String source,
        JSONObject resolution
    ) {
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 90d || Math.abs(lng) > 180d) {
            return;
        }
        if (PrivacyZoneChecker.isInsidePrivacyZone(context, lat, lng)) {
            clearLastParkedLocation(context);
            Log.i(TAG, "Parked location suppressed (privacy zone)");
            return;
        }

        JSONObject parked = new JSONObject();
        try {
            parked.put("lat", lat);
            parked.put("lng", lng);
            parked.put("timestamp", DriveSenseAutoTrackingService.iso(timestampMs));
            parked.put("timestamp_ms", timestampMs);
            parked.put("tripId", tripId);
            parked.put("source", source);
            if (resolution != null) {
                parked.put("confidence", resolution.optString("confidence", "estimated"));
                parked.put("accuracy_m", resolution.optLong("accuracy_m", 0L));
                parked.put("strategy", resolution.optString("strategy", "last_trip_point"));
                parked.put("sample_count", resolution.optInt("sample_count", 1));
                parked.put("spread_m", resolution.optLong("spread_m", 0L));
            }
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(parked.toString(), LAST_PARKED_CONTEXT);
            prefs(context).edit().putString(KEY_LAST_PARKED, encrypted).apply();
            WhereIParkedWidgetProvider.refreshAll(context);
        } catch (Exception ignored) {}
    }

    static void clearLastParkedLocation(Context context) {
        SharedPreferences nativePreferences = prefs(context);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(nativePreferences, KEY_LAST_PARKED)) {
            nativePreferences.edit().remove(KEY_LAST_PARKED).apply();
        }

        SharedPreferences sharedPreferences =
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(
            sharedPreferences,
            SHARED_LAST_PARKED_KEY
        )) {
            sharedPreferences.edit().remove(SHARED_LAST_PARKED_KEY).apply();
        }
        WhereIParkedWidgetProvider.refreshAll(context);
    }

    static String newTripId() {
        return "native_trip_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 8);
    }
}
