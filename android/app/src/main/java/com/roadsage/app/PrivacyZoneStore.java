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
    private static final String ENCRYPTED_PREFS = "road_sage_privacy_zones_v2";
    private static final String NATIVE_KEY = "zones_json";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String CAPACITOR_KEY = "road_sage_privacy_zones";

    private PrivacyZoneStore() {}

    public static void migratePlaintextPrefsIfNeeded(Context context) {
        SharedPreferences encrypted = encryptedPrefs(context);
        String nativeJson = EncryptedPreferenceStore.plaintext(context, NATIVE_PREFS).getString(NATIVE_KEY, null);
        String capacitorJson = EncryptedPreferenceStore.plaintext(context, CAPACITOR_PREFS).getString(CAPACITOR_KEY, null);
        String migratedJson = nativeJson != null ? nativeJson : capacitorJson;

        if (migratedJson != null && !encrypted.contains(NATIVE_KEY)) {
            encrypted.edit().putString(NATIVE_KEY, migratedJson).commit();
        }

        if (EncryptedPreferenceStore.hasEntries(context, NATIVE_PREFS)) {
            EncryptedPreferenceStore.deletePlaintext(context, NATIVE_PREFS);
        }
        if (capacitorJson != null) {
            EncryptedPreferenceStore.plaintext(context, CAPACITOR_PREFS)
                .edit()
                .remove(CAPACITOR_KEY)
                .commit();
        }
    }

    public static List<PrivacyZone> getZones(Context context) {
        String json = getZonesJson(context);
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

    public static String getZonesJson(Context context) {
        migratePlaintextPrefsIfNeeded(context);
        return encryptedPrefs(context).getString(NATIVE_KEY, null);
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
            saveZonesJson(context, array.toString());
        } catch (JSONException e) {
            Log.w(TAG, "Failed to save privacy zones", e);
        }
    }

    public static void saveZonesJson(Context context, String json) throws JSONException {
        JSONArray array = new JSONArray(json == null ? "[]" : json);
        List<PrivacyZone> zones = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            zones.add(PrivacyZone.fromJson(array.getJSONObject(i)));
        }

        JSONArray normalized = new JSONArray();
        for (PrivacyZone zone : zones) {
            normalized.put(zone.toJson());
        }
        encryptedPrefs(context).edit().putString(NATIVE_KEY, normalized.toString()).apply();
        EncryptedPreferenceStore.deletePlaintext(context, NATIVE_PREFS);
        EncryptedPreferenceStore.plaintext(context, CAPACITOR_PREFS)
            .edit()
            .remove(CAPACITOR_KEY)
            .apply();
    }

    private static SharedPreferences encryptedPrefs(Context context) {
        return EncryptedPreferenceStore.open(context, ENCRYPTED_PREFS);
    }
}
