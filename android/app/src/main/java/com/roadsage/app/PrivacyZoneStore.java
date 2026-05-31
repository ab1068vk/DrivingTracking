package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;

public final class PrivacyZoneStore {
    private static final String TAG = "PrivacyZoneStore";
    private static final String NATIVE_PREFS = "road_sage_privacy_zones";
    private static final String NATIVE_KEY = "zones_json";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String CAPACITOR_KEY = "road_sage_privacy_zones";

    private PrivacyZoneStore() {}

    public static List<PrivacyZone> getZones(Context context) {
        String json = getNativeJson(context);
        if (json == null) {
            json = getCapacitorJson(context);
        }
        if (json == null || json.trim().isEmpty()) {
            return new ArrayList<>();
        }

        try {
            JSONArray array = new JSONArray(json);
            List<PrivacyZone> zones = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) {
                try {
                    zones.add(PrivacyZone.fromJson(array.getJSONObject(i)));
                } catch (JSONException e) {
                    Log.w(TAG, "Skipping invalid privacy zone", e);
                }
            }
            return zones;
        } catch (JSONException e) {
            Log.w(TAG, "Failed to parse privacy zones", e);
            return new ArrayList<>();
        }
    }

    @Nullable
    public static PrivacyZone findMatchingZone(double lat, double lng, Context context) {
        for (PrivacyZone zone : getZones(context)) {
            if (zone.containsPoint(lat, lng)) {
                return zone;
            }
        }
        return null;
    }

    public static void saveZones(Context context, List<PrivacyZone> zones) {
        try {
            JSONArray array = new JSONArray();
            for (PrivacyZone zone : zones) {
                array.put(zone.toJson());
            }
            context.getSharedPreferences(NATIVE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(NATIVE_KEY, array.toString())
                .apply();
        } catch (JSONException e) {
            Log.w(TAG, "Failed to save privacy zones", e);
        }
    }

    @Nullable
    private static String getNativeJson(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(NATIVE_PREFS, Context.MODE_PRIVATE);
        return prefs.getString(NATIVE_KEY, null);
    }

    @Nullable
    private static String getCapacitorJson(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        return prefs.getString(CAPACITOR_KEY, null);
    }
}
