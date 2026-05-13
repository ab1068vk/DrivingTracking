package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

class DriveSenseNativeTripStore {
    private static final String PREFS = "drivesense_native_tracking";
    private static final String KEY_COMPLETED_TRIPS = "completed_trips";
    private static final String KEY_SERVICE_ENABLED = "service_enabled";

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
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

    static String newTripId() {
        return "native_trip_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 8);
    }
}
