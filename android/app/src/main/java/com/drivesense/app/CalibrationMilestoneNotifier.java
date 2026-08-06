package com.drivesense.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Notifies when personal detection-calibration progress reaches a step, at the
 * moment a background trip finishes, so the user is not told about it only the
 * next time they happen to open Settings.
 *
 * This is a different system from the Milestones page: it tracks how much
 * driving evidence exists for calibrating the user's own detection thresholds.
 *
 * No threshold logic is duplicated here. JavaScript owns the targets and the
 * set of already-delivered milestone IDs, and mirrors both into this store via
 * {@link #syncStateFromJs}. Native only adds the trip that just finished and
 * compares counters.
 */
final class CalibrationMilestoneNotifier {
    private static final String TAG = "CalibrationMilestones";
    private static final String CHANNEL_ID = "drivesense_coaching";
    private static final int NOTIFICATION_ID = 5900;
    private static final String KEY_STATE = "calibration_milestone_state_v1";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String SETTINGS_KEY = "drivesense_settings";

    private static final String MILESTONE_TRIPS_READY = "calibration_trips_ready";
    private static final String MILESTONE_DISTANCE_READY = "calibration_distance_ready";
    private static final String MILESTONE_HALFWAY = "calibration_halfway";

    private CalibrationMilestoneNotifier() {}

    /**
     * Replace the mirrored calibration state with what JavaScript computed.
     * Called whenever the web layer recalculates progress, so native never
     * drifts from the authoritative trip history.
     */
    static void syncStateFromJs(Context context, JSONObject state) {
        if (context == null || state == null) return;
        DriveSenseNativeTripStore.prefs(context)
            .edit()
            .putString(KEY_STATE, state.toString())
            .apply();
    }

    /**
     * Record a completed background trip and notify for any calibration step it
     * just crossed. Safe to call when no state has been mirrored yet: without
     * targets from JavaScript there is nothing to compare, so it does nothing.
     */
    static void recordCompletedTrip(Context context, double distanceKm) {
        if (context == null) return;
        try {
            JSONObject state = readState(context);
            if (state == null) return;

            double tripsTarget = state.optDouble("tripsTarget", 0d);
            double kmTarget = state.optDouble("kmTarget", 0d);
            if (tripsTarget <= 0d || kmTarget <= 0d) return;

            int tripsAnalyzed = state.optInt("tripsAnalyzed", 0) + 1;
            double kmAnalyzed = state.optDouble("kmAnalyzed", 0d) +
                (Double.isNaN(distanceKm) || distanceKm < 0d ? 0d : distanceKm);
            state.put("tripsAnalyzed", tripsAnalyzed);
            state.put("kmAnalyzed", kmAnalyzed);

            Set<String> notified = readNotified(state);
            String reached = null;
            String title = null;
            String body = null;

            if (tripsAnalyzed >= tripsTarget && !notified.contains(MILESTONE_TRIPS_READY)) {
                reached = MILESTONE_TRIPS_READY;
                title = "Enough trips for calibration";
                body = tripsAnalyzed + " trips analysed - Road Sage can now suggest detection " +
                    "thresholds from your own driving.";
            } else if (kmAnalyzed >= kmTarget && !notified.contains(MILESTONE_DISTANCE_READY)) {
                reached = MILESTONE_DISTANCE_READY;
                title = "Enough distance for calibration";
                body = Math.round(kmAnalyzed) + " km analysed - enough road for a personal " +
                    "threshold estimate.";
            } else if (
                (tripsAnalyzed >= tripsTarget / 2d || kmAnalyzed >= kmTarget / 2d) &&
                !notified.contains(MILESTONE_HALFWAY)
            ) {
                reached = MILESTONE_HALFWAY;
                title = "Calibration halfway there";
                body = tripsAnalyzed + " trips and " + Math.round(kmAnalyzed) + " km analysed. " +
                    "Keep driving to unlock personal detection thresholds.";
            }

            if (reached != null && notify(context, title, body)) {
                notified.add(reached);
                state.put("notified", new JSONArray(notified));
            }
            syncStateFromJs(context, state);
        } catch (Exception error) {
            Log.w(TAG, "Could not record completed trip for calibration milestones", error);
        }
    }

    private static JSONObject readState(Context context) {
        SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
        String raw = prefs.getString(KEY_STATE, null);
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Set<String> readNotified(JSONObject state) {
        Set<String> ids = new LinkedHashSet<>();
        JSONArray array = state.optJSONArray("notified");
        if (array == null) return ids;
        for (int index = 0; index < array.length(); index++) {
            String id = array.optString(index, null);
            if (id != null && !id.isEmpty()) ids.add(id);
        }
        return ids;
    }

    private static boolean isNotificationEnabled(Context context) {
        try {
            String raw = context
                .getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(SETTINGS_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return true;
            JSONObject settings = new JSONObject(raw);
            if (!settings.optBoolean("notifications_enabled", true)) return false;
            return settings.optBoolean("calibration_notifications", true);
        } catch (Exception ignored) {
            return true;
        }
    }

    private static boolean notify(Context context, String title, String body) {
        if (!isNotificationEnabled(context)) return false;
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
        ) return false;

        createChannel(context);
        Intent intent = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("drivesense://settings/detection-thresholds"),
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
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification.build());
            return true;
        } catch (SecurityException error) {
            Log.w(TAG, "Could not post calibration milestone notification", error);
            return false;
        }
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Coaching & Milestones",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Driving improvement tips and personal milestones");
        manager.createNotificationChannel(channel);
    }
}
