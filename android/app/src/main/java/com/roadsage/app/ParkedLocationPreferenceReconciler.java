package com.roadsage.app;

import android.content.Context;

import org.json.JSONObject;

final class ParkedLocationPreferenceReconciler {
    private static final ParkedLocationPreferenceSource CURRENT_NATIVE =
        new ParkedLocationPreferenceSource("road_sage_native_tracking", "last_parked_location");
    private static final ParkedLocationPreferenceSource LEGACY_NATIVE =
        new ParkedLocationPreferenceSource("drivesense_native_tracking", "last_parked_location");
    private static final ParkedLocationPreferenceSource CURRENT_SHARED =
        new ParkedLocationPreferenceSource("CapacitorStorage", "road_sage_last_parked");
    private static final ParkedLocationPreferenceSource LEGACY_SHARED =
        new ParkedLocationPreferenceSource("CapacitorStorage", "drivesense_last_parked");

    private static final ParkedLocationPreferenceSource[] READ_SOURCES = {
        CURRENT_NATIVE,
        LEGACY_NATIVE,
        CURRENT_SHARED,
        LEGACY_SHARED
    };

    private ParkedLocationPreferenceReconciler() {}

    static JSONObject readLatest(Context context) {
        ParkedLocationRecord latest = null;
        for (ParkedLocationPreferenceSource source : READ_SOURCES) {
            ParkedLocationRecord candidate = ParkedLocationRecord.parse(source.read(context));
            if (ParkedLocationRecord.isNewerThan(candidate, latest)) {
                latest = candidate;
            }
        }

        if (latest == null) return null;

        writeCurrent(context, latest.json);
        clearLegacy(context);
        return latest.json;
    }

    static void writeCurrent(Context context, JSONObject parked) {
        CURRENT_NATIVE.write(context, parked);
    }

    private static void clearLegacy(Context context) {
        LEGACY_NATIVE.clear(context);
        LEGACY_SHARED.clear(context);
    }
}
