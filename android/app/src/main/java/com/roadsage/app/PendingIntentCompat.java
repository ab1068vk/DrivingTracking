package com.roadsage.app;

import android.app.PendingIntent;
import android.os.Build;

public final class PendingIntentCompat {
    private PendingIntentCompat() {}

    /**
     * Returns FLAG_IMMUTABLE on API 23+ combined with any caller-supplied flags.
     * Use this for every PendingIntent that does not need to be mutated.
     */
    public static int immutableFlags(int baseFlags) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return baseFlags | PendingIntent.FLAG_IMMUTABLE;
        }
        return baseFlags;
    }

    /**
     * Returns FLAG_MUTABLE on API 31+ combined with any caller-supplied flags.
     * Use only when an external API must add fill-in data before delivery.
     */
    public static int mutableFlags(int baseFlags) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return baseFlags | PendingIntent.FLAG_MUTABLE;
        }
        return baseFlags;
    }
}
