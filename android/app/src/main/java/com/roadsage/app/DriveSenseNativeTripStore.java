package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

class DriveSenseNativeTripStore {
    private static final String PREFS_OLD = "drivesense_native_tracking";
    private static final String PREFS = "road_sage_native_tracking";
    private static final String PREFS_ENCRYPTED = "road_sage_native_tracking_v2";
    private static final String KEY_COMPLETED_TRIPS = "completed_trips";
    private static final String KEY_SERVICE_ENABLED = "service_enabled";
    private static final String KEY_DIAGNOSTIC_EVENTS = "diagnostic_events";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final String KEY_MIGRATED_FROM_V1 = "migrated_from_drivesense_v1";
    private static final String KEY_MIGRATED_FROM_PLAINTEXT = "migrated_from_plaintext";
    private static final int MAX_DIAGNOSTIC_EVENTS = 120;

    static SharedPreferences prefs(Context context) {
        return migratePlaintextPrefsIfNeeded(context);
    }

    static SharedPreferences migratePlaintextPrefsIfNeeded(Context context) {
        SharedPreferences encryptedPrefs = EncryptedPreferenceStore.open(context, PREFS_ENCRYPTED);
        if (!encryptedPrefs.getBoolean(KEY_MIGRATED_FROM_PLAINTEXT, false)) {
            SharedPreferences.Editor editor = encryptedPrefs.edit();
            editor.putBoolean(KEY_MIGRATED_FROM_V1, true);
            editor.putBoolean(KEY_MIGRATED_FROM_PLAINTEXT, true);
            editor.commit();
        }

        EncryptedPreferenceStore.deletePlaintext(context, PREFS);
        EncryptedPreferenceStore.deletePlaintext(context, PREFS_OLD);
        return encryptedPrefs;
    }

    static boolean isServiceEnabled(Context context) {
        return prefs(context).getBoolean(KEY_SERVICE_ENABLED, false);
    }

    static void setServiceEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_SERVICE_ENABLED, enabled).apply();
    }

    static JSONArray getCompletedTrips(Context context) {
        String raw = prefs(context).getString(KEY_COMPLETED_TRIPS, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void addCompletedTrip(Context context, JSONObject trip) {
        JSONArray trips = getCompletedTrips(context);
        trips.put(trip);
        prefs(context).edit().putString(KEY_COMPLETED_TRIPS, trips.toString()).apply();
    }

    static void clearCompletedTrips(Context context) {
        SharedPreferences storage = prefs(context);
        JSONArray trips = getCompletedTrips(context);
        for (int i = 0; i < trips.length(); i++) {
            JSONObject trip = trips.optJSONObject(i);
            if (trip == null) continue;
            RoadSageAutoTrackingService.zeroMotionSamples(trip.optJSONArray("motion_samples"));
        }
        storage.edit().putString(KEY_COMPLETED_TRIPS, trips.toString()).commit();
        storage.edit().putString(KEY_COMPLETED_TRIPS, "[]").apply();
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
        prefs(context);
        return ParkedLocationPreferenceReconciler.readLatest(context);
    }

    static void saveLastParkedLocation(Context context, double lat, double lng, long timestampMs, String tripId, String source) {
        JSONObject parked = new JSONObject();
        try {
            parked.put("lat", roundCoordinate(lat));
            parked.put("lng", roundCoordinate(lng));
            parked.put("timestamp", RoadSageAutoTrackingService.iso(timestampMs));
            parked.put("timestamp_ms", timestampMs);
            parked.put("tripId", tripId);
            parked.put("source", source);
            ParkedLocationPreferenceReconciler.writeCurrent(context, parked);
        } catch (JSONException ignored) {}
    }

    static void saveLastParkedLocation(Context context, JSONObject parked) {
        if (parked != null) {
            try {
                double lat = parked.optDouble("lat", Double.NaN);
                double lng = parked.optDouble("lng", Double.NaN);
                if (Double.isFinite(lat)) parked.put("lat", roundCoordinate(lat));
                if (Double.isFinite(lng)) parked.put("lng", roundCoordinate(lng));
            } catch (JSONException ignored) {}
        }
        ParkedLocationPreferenceReconciler.writeCurrent(context, parked);
    }

    static void clearLastParkedLocation(Context context) {
        ParkingLocationClearer.clear(context);
    }

    static String newTripId() {
        return "native_trip_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static double roundCoordinate(double value) {
        if (!Double.isFinite(value)) return value;
        return Math.round(value * 100000d) / 100000d;
    }
}
