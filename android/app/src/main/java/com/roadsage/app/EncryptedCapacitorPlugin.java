package com.roadsage.app;

import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "EncryptedCapacitorPlugin")
public class EncryptedCapacitorPlugin extends Plugin {
    private static final String PREFS_NAME = "road_sage_capacitor_preferences_v2";

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.trim().isEmpty()) {
            call.reject("key is required.");
            return;
        }
        JSObject result = new JSObject();
        result.put("value", prefs().getString(key, null));
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.trim().isEmpty()) {
            call.reject("key is required.");
            return;
        }
        prefs().edit().putString(key, value == null ? "null" : value).apply();
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.trim().isEmpty()) {
            call.reject("key is required.");
            return;
        }
        prefs().edit().remove(key).apply();
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        prefs().edit().clear().apply();
        call.resolve();
    }

    private SharedPreferences prefs() {
        return EncryptedPreferenceStore.open(getContext(), PREFS_NAME);
    }
}
