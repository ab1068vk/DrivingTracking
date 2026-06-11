package com.drivesense.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

public class RaspChecker {
    private static final String[] SU_PATHS = new String[] {
        "/system/bin/su",
        "/system/xbin/su",
        "/sbin/su",
        "/su/bin/su",
        "/data/local/xbin/su",
        "/data/local/bin/su",
        "/system/sd/xbin/su",
        "/system/bin/failsafe/su",
        "/system/app/Superuser.apk"
    };

    private static final String[] ROOT_PACKAGES = new String[] {
        "com.topjohnwu.magisk",
        "com.koushikdutta.superuser",
        "com.noshufou.android.su",
        "eu.chainfire.supersu",
        "com.thirdparty.superuser",
        "com.yellowes.su",
        "com.kingroot.kinguser",
        "com.kingo.root",
        "com.smedialink.oneclickroot",
        "com.zhiqupk.root.global"
    };

    public static RaspResult check(Context context) {
        List<String> threats = new ArrayList<>();

        if (hasSuBinary()) {
            threats.add("SU_BINARY");
        }

        String rootPackage = firstInstalledPackage(context, ROOT_PACKAGES);
        if (rootPackage != null) {
            threats.add("ROOT_APP:" + rootPackage);
        }

        if (Build.TAGS != null && Build.TAGS.contains("test-keys")) {
            threats.add("TEST_KEYS");
        }

        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            threats.add("DEBUGGABLE");
        }

        if (isAdbEnabled(context)) {
            threats.add("ADB_ENABLED");
        }

        if (isProbablyEmulator()) {
            threats.add("EMULATOR");
        }

        return new RaspResult(threats.isEmpty(), threats);
    }

    private static boolean hasSuBinary() {
        for (String path : SU_PATHS) {
            if (new File(path).exists()) {
                return true;
            }
        }
        return false;
    }

    private static String firstInstalledPackage(Context context, String[] packages) {
        PackageManager packageManager = context.getPackageManager();
        for (String packageName : packages) {
            try {
                packageManager.getPackageInfo(packageName, 0);
                return packageName;
            } catch (PackageManager.NameNotFoundException ignored) {
                // Package is not installed or not visible to this app.
            }
        }
        return null;
    }

    private static boolean isAdbEnabled(Context context) {
        try {
            return Settings.Global.getInt(
                context.getContentResolver(),
                Settings.Global.ADB_ENABLED,
                0
            ) == 1;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private static boolean isProbablyEmulator() {
        String fingerprint = safe(Build.FINGERPRINT);
        String model = safe(Build.MODEL);
        String manufacturer = safe(Build.MANUFACTURER);
        String brand = safe(Build.BRAND);
        String device = safe(Build.DEVICE);
        String product = safe(Build.PRODUCT);
        String hardware = safe(Build.HARDWARE);

        return fingerprint.startsWith("generic") ||
            fingerprint.startsWith("unknown") ||
            model.contains("Emulator") ||
            model.contains("Android SDK built for x86") ||
            manufacturer.contains("Genymotion") ||
            hardware.contains("goldfish") ||
            hardware.contains("ranchu") ||
            (brand.startsWith("generic") && device.startsWith("generic")) ||
            product.contains("sdk_gphone") ||
            product.contains("google_sdk");
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
