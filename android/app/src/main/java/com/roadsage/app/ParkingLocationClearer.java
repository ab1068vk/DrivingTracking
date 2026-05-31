package com.roadsage.app;

import android.content.Context;

import androidx.work.WorkManager;

import java.io.File;

final class ParkingLocationClearer {
    private static final String[] NATIVE_PREFS = {
        "road_sage_native_tracking",
        "drivesense_native_tracking"
    };
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final String KEY_SHARED_LAST_PARKED = "road_sage_last_parked";
    private static final String KEY_SHARED_LAST_PARKED_OLD = "drivesense_last_parked";
    private static final String MAP_CACHE_PREFIX = "parked_map_widget_";

    private ParkingLocationClearer() {}

    static void clear(Context context) {
        clearNativePrefs(context);
        clearCapacitorPrefs(context);
        clearMapCache(context);
        WorkManager.getInstance(context).cancelAllWorkByTag("parked_map");
    }

    private static void clearNativePrefs(Context context) {
        for (String prefName : NATIVE_PREFS) {
            context.getSharedPreferences(prefName, Context.MODE_PRIVATE)
                .edit()
                .remove(KEY_LAST_PARKED)
                .apply();
        }
    }

    private static void clearCapacitorPrefs(Context context) {
        context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_SHARED_LAST_PARKED)
            .remove(KEY_SHARED_LAST_PARKED_OLD)
            .apply();
    }

    private static void clearMapCache(Context context) {
        File[] cache = context.getFilesDir().listFiles((dir, name) -> name.startsWith(MAP_CACHE_PREFIX));
        if (cache == null) return;

        for (File file : cache) {
            if (file.isFile()) {
                file.delete();
            }
        }
    }
}
