package com.roadsage.app;

import android.content.Context;

import androidx.work.WorkManager;

import java.io.File;

final class ParkingLocationClearer {
    private static final String MAP_CACHE_PREFIX = "parked_map_widget_";

    private ParkingLocationClearer() {}

    static void clear(Context context) {
        ParkedLocationPreferenceReconciler.clearCurrent(context);
        EncryptedPreferenceStore.deletePlaintext(context, "road_sage_native_tracking");
        EncryptedPreferenceStore.deletePlaintext(context, "drivesense_native_tracking");
        clearMapCache(context);
        WorkManager.getInstance(context).cancelAllWorkByTag("parked_map");
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
