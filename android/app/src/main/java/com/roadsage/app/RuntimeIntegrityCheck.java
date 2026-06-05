package com.roadsage.app;

import android.content.Context;
import android.os.Build;
import android.os.Debug;
import android.provider.Settings;

import java.io.File;
import java.util.Locale;

final class RuntimeIntegrityCheck {
    private RuntimeIntegrityCheck() {}

    static boolean isDebuggerAttached() {
        return Debug.isDebuggerConnected() || Debug.waitingForDebugger();
    }

    static boolean isProbablyEmulator() {
        String fingerprint = lower(Build.FINGERPRINT);
        String model = lower(Build.MODEL);
        String manufacturer = lower(Build.MANUFACTURER);
        String brand = lower(Build.BRAND);
        String device = lower(Build.DEVICE);
        String product = lower(Build.PRODUCT);
        return fingerprint.contains("generic") ||
            fingerprint.contains("vbox") ||
            fingerprint.contains("test-keys") ||
            model.contains("emulator") ||
            model.contains("android sdk built for") ||
            manufacturer.contains("genymotion") ||
            (brand.startsWith("generic") && device.startsWith("generic")) ||
            product.contains("sdk_gphone") ||
            product.contains("google_sdk");
    }

    static boolean isRootLikely() {
        if (Build.TAGS != null && Build.TAGS.contains("test-keys")) return true;
        String[] paths = {
            "/system/app/Superuser.apk",
            "/sbin/su",
            "/system/bin/su",
            "/system/xbin/su",
            "/data/local/xbin/su",
            "/data/local/bin/su",
            "/system/sd/xbin/su",
            "/system/bin/failsafe/su",
            "/data/local/su"
        };
        for (String path : paths) {
            if (new File(path).exists()) return true;
        }
        return false;
    }

    static boolean isAdbEnabled(Context context) {
        try {
            return Settings.Global.getInt(context.getContentResolver(), Settings.Global.ADB_ENABLED, 0) == 1;
        } catch (Exception ignored) {
            return false;
        }
    }

    static String status(Context context) {
        StringBuilder status = new StringBuilder();
        if (isRootLikely()) status.append("root;");
        if (isDebuggerAttached()) status.append("debugger;");
        if (isProbablyEmulator()) status.append("emulator;");
        if (isAdbEnabled(context)) status.append("adb;");
        return status.length() == 0 ? "ok" : status.toString();
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.US);
    }
}
