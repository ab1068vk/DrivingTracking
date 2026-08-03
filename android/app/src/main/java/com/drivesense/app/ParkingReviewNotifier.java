package com.drivesense.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

/** Privacy-safe prompt for a low-confidence parking result. */
final class ParkingReviewNotifier {
    private static final String CHANNEL_ID = "drivesense_parking";
    private static final int NOTIFICATION_ID = 4701;
    private static final String KEY_LAST_NOTIFIED_REVISION = "parking_review_notified_revision";

    private ParkingReviewNotifier() {}

    static void reconcile(Context context) {
        JSONObject state = DriveSenseNativeTripStore.getLastParkingState(context);
        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(context);
        if (
            state == null ||
            parked == null ||
            !"saved".equals(state.optString("status", ""))
        ) {
            cancel(context);
            return;
        }
        int confidenceScore = parked.optInt("confidence_score", 0);
        if (confidenceScore <= 0 || confidenceScore >= 60 || parked.optBoolean("verified", false)) {
            cancel(context);
            return;
        }
        notifyIfNeeded(context, parked);
    }

    private static void notifyIfNeeded(Context context, JSONObject parked) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
        ) return;

        long revision = DriveSenseNativeTripStore.parkingStateRevision(parked);
        long previous = DriveSenseNativeTripStore.prefs(context)
            .getLong(KEY_LAST_NOTIFIED_REVISION, 0L);
        if (revision > 0L && previous == revision) return;

        createChannel(context);
        Intent intent = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("drivesense://parking/verify"),
            context,
            MainActivity.class
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_drivesense)
            .setContentTitle("Verify where you parked")
            .setContentText("Parking confidence is low. Check the marker before using directions.")
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification.build());
            DriveSenseNativeTripStore.prefs(context)
                .edit()
                .putLong(KEY_LAST_NOTIFIED_REVISION, revision)
                .apply();
        } catch (SecurityException ignored) {}
    }

    static void cancel(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Parking review",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Prompts you to verify a low-confidence parked-car location.");
        manager.createNotificationChannel(channel);
    }
}
