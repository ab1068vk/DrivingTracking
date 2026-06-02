package com.roadsage.app;

import android.content.Context;

import androidx.work.WorkManager;

final class ParkingLocationClearer {
    private ParkingLocationClearer() {}

    static void clear(Context context) {
        ParkedLocationPreferenceReconciler.clearCurrent(context);
        EncryptedPreferenceStore.deletePlaintext(context, "road_sage_native_tracking");
        EncryptedPreferenceStore.deletePlaintext(context, "drivesense_native_tracking");
        MapTileFetchWorker.clearWidgetMapCache(context);
        SecureDelete.wipeSensitiveFiles(context);
        WorkManager.getInstance(context).cancelAllWorkByTag("parked_map");
    }
}
