package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;
import java.util.UUID;

class DriveSenseNativeTripStore {
    private static final String PREFS_OLD = "drivesense_native_tracking";
    private static final String PREFS = "road_sage_native_tracking";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String KEY_COMPLETED_TRIPS = "completed_trips";
    private static final String KEY_SERVICE_ENABLED = "service_enabled";
    private static final String KEY_DIAGNOSTIC_EVENTS = "diagnostic_events";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final String SHARED_LAST_PARKED_KEY_OLD = "drivesense_last_parked";
    private static final String SHARED_LAST_PARKED_KEY = "road_sage_last_parked";
    private static final String KEY_MIGRATED_FROM_V1 = "migrated_from_drivesense_v1";
    private static final int MAX_DIAGNOSTIC_EVENTS = 120;

    static SharedPreferences prefs(Context context) {
        SharedPreferences oldPrefs = context.getSharedPreferences(PREFS_OLD, Context.MODE_PRIVATE);
        SharedPreferences currentPrefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!currentPrefs.contains(KEY_MIGRATED_FROM_V1) && oldPrefs.getAll().size() > 0) {
            SharedPreferences.Editor editor = currentPrefs.edit();
            for (Map.Entry<String, ?> entry : oldPrefs.getAll().entrySet()) {
                Object value = entry.getValue();
                String key = entry.getKey();
                if (value instanceof String) editor.putString(key, (String) value);
                else if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
                else if (value instanceof Integer) editor.putInt(key, (Integer) value);
                else if (value instanceof Long) editor.putLong(key, (Long) value);
                else if (value instanceof Float) editor.putFloat(key, (Float) value);
            }
            editor.putBoolean(KEY_MIGRATED_FROM_V1, true);
            editor.apply();
        }
        return currentPrefs;
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
        prefs(context).edit().putString(KEY_COMPLETED_TRIPS, "[]").apply();
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
        String raw = prefs(context).getString(KEY_LAST_PARKED, null);
        if (raw == null || raw.trim().isEmpty()) {
            raw = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString(SHARED_LAST_PARKED_KEY, null);
        }
        if (raw == null || raw.trim().isEmpty()) {
            raw = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString(SHARED_LAST_PARKED_KEY_OLD, null);
        }
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    static void saveLastParkedLocation(Context context, double lat, double lng, long timestampMs, String tripId, String source) {
        JSONObject parked = new JSONObject();
        try {
            parked.put("lat", lat);
            parked.put("lng", lng);
            parked.put("timestamp", RoadSageAutoTrackingService.iso(timestampMs));
            parked.put("timestamp_ms", timestampMs);
            parked.put("tripId", tripId);
            parked.put("source", source);
            prefs(context).edit().putString(KEY_LAST_PARKED, parked.toString()).apply();
        } catch (JSONException ignored) {}
    }

    static String newTripId() {
        return "native_trip_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 8);
    }
}
