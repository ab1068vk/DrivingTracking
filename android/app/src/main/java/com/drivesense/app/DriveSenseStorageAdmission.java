package com.drivesense.app;

import android.content.Context;
import android.os.StatFs;

/** Single conservative free-space observation boundary shared by canonical stores. */
final class DriveSenseStorageAdmission {
    private static volatile Long testAvailableBytes;
    private DriveSenseStorageAdmission() {}

    static long availableBytes(Context context) {
        Long test = testAvailableBytes;
        return test != null
            ? test
            : new StatFs(context.getNoBackupFilesDir().getAbsolutePath()).getAvailableBytes();
    }

    /** Package-private fixture hook; no production API exposes this override. */
    static void setAvailableBytesForTests(Long value) { testAvailableBytes = value; }
}
