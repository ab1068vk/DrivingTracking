package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;

final class NativeSettingsStore {
    private static final String SETTINGS_PREFS_ENCRYPTED = "road_sage_native_settings_v2";
    private static final String SETTINGS_KEY = "road_sage_settings";

    private NativeSettingsStore() {}

    static String getSettingsJson(Context context) {
        return prefs(context).getString(SETTINGS_KEY, null);
    }

    static boolean saveSettingsJson(Context context, String settingsJson) {
        if (settingsJson == null || settingsJson.trim().isEmpty()) return false;
        return prefs(context).edit().putString(SETTINGS_KEY, settingsJson).commit();
    }

    private static SharedPreferences prefs(Context context) {
        return EncryptedPreferenceStore.open(context, SETTINGS_PREFS_ENCRYPTED);
    }
}
