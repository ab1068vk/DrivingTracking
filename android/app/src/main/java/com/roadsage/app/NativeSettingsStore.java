package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

final class NativeSettingsStore {
    private static final String TAG = "NativeSettingsStore";
    private static final String SETTINGS_PREFS_ENCRYPTED = "road_sage_native_settings_v2";
    private static final String SETTINGS_KEY = "road_sage_settings";
    private static final Object SETTINGS_WRITE_LOCK = new Object();

    private NativeSettingsStore() {}

    static String getSettingsJson(Context context) {
        return prefs(context).getString(SETTINGS_KEY, null);
    }

    static boolean saveSettingsJson(Context context, String settingsJson) {
        if (settingsJson == null || settingsJson.trim().isEmpty()) return false;
        synchronized (SETTINGS_WRITE_LOCK) {
            return prefs(context).edit().putString(SETTINGS_KEY, settingsJson).commit();
        }
    }

    static boolean updateSettingsFields(Context context, Map<String, Object> updates) {
        if (updates == null || updates.isEmpty()) return false;
        synchronized (SETTINGS_WRITE_LOCK) {
            String current = getSettingsJson(context);
            try {
                return saveSettingsJson(context, stampedSettingsJson(current, updates));
            } catch (JSONException error) {
                Log.e(TAG, "updateSettingsFields: failed to stamp settings", error);
                return false;
            }
        }
    }

    static String stampedSettingsJson(String current, Map<String, Object> updates) throws JSONException {
        JSONObject settings = current == null || current.trim().isEmpty()
            ? new JSONObject()
            : new JSONObject(current);

        for (Map.Entry<String, Object> entry : updates.entrySet()) {
            settings.put(entry.getKey(), entry.getValue());
        }

        int revision = settings.optInt("_settings_revision", 0);
        settings.put("_settings_revision", revision + 1);
        settings.put("_settings_updated_at", isoNowUtc());
        return settings.toString();
    }

    private static String isoNowUtc() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }

    private static SharedPreferences prefs(Context context) {
        return EncryptedPreferenceStore.open(context, SETTINGS_PREFS_ENCRYPTED);
    }
}
