package com.roadsage.app;

import android.content.Context;

import org.json.JSONObject;

final class ParkedLocationPreferenceReconciler {
    private static final String KEY_LAST_PARKED = "last_parked_location";

    private ParkedLocationPreferenceReconciler() {}

    static JSONObject readLatest(Context context) {
        ParkedLocationPreferenceSource current = currentNative(context);
        ParkedLocationRecord latest = ParkedLocationRecord.parse(current.read());
        if (latest == null) return null;

        return latest.json;
    }

    static void writeCurrent(Context context, JSONObject parked) {
        currentNative(context).write(parked);
    }

    static void clearCurrent(Context context) {
        currentNative(context).clear();
    }

    private static ParkedLocationPreferenceSource currentNative(Context context) {
        return new ParkedLocationPreferenceSource(DriveSenseNativeTripStore.prefs(context), KEY_LAST_PARKED);
    }
}
