package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

final class ParkedLocationPreferenceSource {
    private final String prefsName;
    private final String key;

    ParkedLocationPreferenceSource(String prefsName, String key) {
        this.prefsName = prefsName;
        this.key = key;
    }

    String read(Context context) {
        return prefs(context).getString(key, null);
    }

    void write(Context context, JSONObject value) {
        prefs(context).edit().putString(key, value.toString()).apply();
    }

    void clear(Context context) {
        prefs(context).edit().remove(key).apply();
    }

    private SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(prefsName, Context.MODE_PRIVATE);
    }
}
