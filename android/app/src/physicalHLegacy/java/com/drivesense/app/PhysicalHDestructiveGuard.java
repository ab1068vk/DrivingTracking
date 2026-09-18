package com.drivesense.app;

import android.content.Context;

/** Legacy fixture builds never expose destructive Physical H drivers. */
public final class PhysicalHDestructiveGuard {
    private PhysicalHDestructiveGuard() {}
    public static void requireUnavailable(Context context) {
        throw new SecurityException("PHYSICAL_H_LEGACY_DRIVER_UNAVAILABLE");
    }
}
