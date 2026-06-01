package com.roadsage.app;

import android.content.SharedPreferences;

import org.json.JSONObject;

final class ParkedLocationPreferenceSource {
    private final String key;
    private final SharedPreferences prefs;

    ParkedLocationPreferenceSource(SharedPreferences prefs, String key) {
        this.prefs = prefs;
        this.key = key;
    }

    String read() {
        return prefs.getString(key, null);
    }

    void write(JSONObject value) {
        prefs.edit().putString(key, value.toString()).apply();
    }

    void clear() {
        prefs.edit().remove(key).apply();
    }
}
