package com.drivesense.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

public final class DriveSenseBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (
            !Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
        ) return;
        JSONObject parkingReminder = DriveSenseNativeTripStore.getParkingReminderState(context);
        if (parkingReminder != null) {
            WhereIParkedWidgetProvider.scheduleReminderDeadlineRefresh(
                context,
                parkingReminder.optLong("reminder_at_ms", 0L)
            );
        }
        ParkingPhotoExpiryScheduler.reconcile(context);
        WhereIParkedWidgetProvider.refreshAll(context);
        ParkingReviewNotifier.reconcile(context);
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;

        if (!hasRequiredPermissions(context)) {
            record(context, "service_restart_skipped", "Background tracking restart needs permissions.", action);
            return;
        }

        boolean started = DriveSenseAutoTrackingService.start(context);
        record(
            context,
            started ? "service_restart_requested" : "service_restart_failed",
            started
                ? "Background tracking restart requested after reboot or app update."
                : "Android did not allow background tracking to restart.",
            action
        );
    }

    private static boolean hasRequiredPermissions(Context context) {
        boolean location = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;
        if (!location) return false;

        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) != PackageManager.PERMISSION_GRANTED
        ) return false;
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACTIVITY_RECOGNITION
            ) != PackageManager.PERMISSION_GRANTED
        ) return false;
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED;
    }

    private static void record(Context context, String type, String title, String reason) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", type);
            event.put("title", title);
            event.put("reason", reason == null ? "system_restart" : reason);
            event.put("timestamp", java.time.Instant.now().toString());
            event.put("source", "android");
            DriveSenseNativeTripStore.addDiagnosticEvent(context, event);
        } catch (Exception ignored) {}
    }
}
