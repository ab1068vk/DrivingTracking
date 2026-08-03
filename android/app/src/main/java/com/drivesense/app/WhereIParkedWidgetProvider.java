package com.drivesense.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.time.Instant;
import java.util.Locale;

/** Privacy-aware home-screen widget for the last confirmed parked position. */
public class WhereIParkedWidgetProvider extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.drivesense.app.action.REFRESH_WHERE_I_PARKED_WIDGET";
    static final String ACTION_REMINDER_DUE =
        "com.drivesense.app.action.WHERE_I_PARKED_REMINDER_DUE";
    private static final int REMINDER_REFRESH_REQUEST_ID = 46_060;
    private static final long MINUTE_MS = 60_000L;
    private static final long HOUR_MS = 60L * MINUTE_MS;
    private static final long DAY_MS = 24L * HOUR_MS;
    private static final long STALE_PARKING_MS = 30L * DAY_MS;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) updateWidget(context, manager, appWidgetId);
    }

    @Override
    public void onAppWidgetOptionsChanged(
        Context context,
        AppWidgetManager manager,
        int appWidgetId,
        android.os.Bundle newOptions
    ) {
        super.onAppWidgetOptionsChanged(context, manager, appWidgetId, newOptions);
        updateWidget(context, manager, appWidgetId);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent == null) return;
        if (ACTION_REMINDER_DUE.equals(intent.getAction())) {
            DriveSenseNativeTripStore.clearParkingReminderState(context);
        } else if (ACTION_REFRESH.equals(intent.getAction())) {
            refreshAll(context);
        }
    }

    static void refreshAll(Context context) {
        Context appContext = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(appContext);
        ComponentName provider = new ComponentName(appContext, WhereIParkedWidgetProvider.class);
        for (int appWidgetId : manager.getAppWidgetIds(provider)) {
            updateWidget(appContext, manager, appWidgetId);
        }
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_where_i_parked);
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshIntent(context, appWidgetId));
        views.setOnClickPendingIntent(R.id.widget_open_app, openAppIntent(context, appWidgetId));
        views.setViewVisibility(R.id.widget_secondary_actions, View.GONE);
        views.setViewVisibility(R.id.widget_reminder, View.GONE);
        views.setViewVisibility(R.id.widget_found, View.GONE);
        views.setViewVisibility(R.id.widget_reminder_countdown, View.GONE);

        JSONObject activeTrip = DriveSenseNativeTripStore.getActiveTripStatus(context);
        boolean confirmedVehicleMovement = isConfirmedVehicleMovement(activeTrip);
        JSONObject parked = confirmedVehicleMovement ? null : DriveSenseNativeTripStore.getLastParkedLocation(context);
        JSONObject parkingState = confirmedVehicleMovement ? null : DriveSenseNativeTripStore.getLastParkingState(context);
        String parkingStatus = parkingState != null
            ? parkingState.optString("status", "")
            : "";

        if (confirmedVehicleMovement) renderVehicleMoving(context, views, appWidgetId);
        else if ("private".equals(parkingStatus)) renderPrivate(context, views, parkingState);
        else if ("unavailable".equals(parkingStatus)) renderNeedsReview(context, views, parkingState);
        else if (hasValidParkedLocation(parked)) {
            boolean conflict = "saved".equals(parkingStatus) && !sameParkingEvent(parkingState, parked);
            renderParked(context, views, parked, appWidgetId, conflict);
        }
        else if ("saved".equals(parkingStatus)) renderNeedsReview(context, views, parkingState);
        else renderEmpty(context, views);
        renderMeta(context, views, parked != null ? parked : parkingState);
        boolean reminderActive = renderReminder(context, views, parkingState);
        applyResponsiveLayout(manager, views, appWidgetId, reminderActive);

        manager.updateAppWidget(appWidgetId, views);
    }

    private static void applyResponsiveLayout(
        AppWidgetManager manager,
        RemoteViews views,
        int appWidgetId,
        boolean reminderActive
    ) {
        android.os.Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 280);
        int minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 160);
        boolean compactHeight = minHeight > 0 && minHeight < 150;
        boolean narrow = minWidth > 0 && minWidth < 260;

        views.setTextViewTextSize(
            R.id.widget_status,
            TypedValue.COMPLEX_UNIT_SP,
            compactHeight || narrow ? 16f : 18f
        );
        if (compactHeight) {
            views.setViewVisibility(R.id.widget_detail, View.GONE);
            views.setViewVisibility(R.id.widget_meta, View.GONE);
            views.setViewVisibility(
                R.id.widget_reminder_countdown,
                compactReminderVisibility(reminderActive)
            );
            views.setViewVisibility(R.id.widget_secondary_actions, View.GONE);
        } else if (narrow) {
            views.setViewVisibility(R.id.widget_secondary_actions, View.GONE);
        }
    }

    static int compactReminderVisibility(boolean reminderActive) {
        return reminderActive ? View.VISIBLE : View.GONE;
    }

    static boolean isConfirmedVehicleMovement(JSONObject activeTrip) {
        if (activeTrip == null || !activeTrip.optBoolean("active", false)) return false;
        boolean candidate = activeTrip.optBoolean(
            "candidate",
            "candidate".equals(activeTrip.optString("state", ""))
        );
        return !candidate;
    }

    private static void renderVehicleMoving(
        Context context,
        RemoteViews views,
        int appWidgetId
    ) {
        views.setTextViewText(R.id.widget_status, context.getString(R.string.where_i_parked_moving_title));
        views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_moving_detail));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_review));
        views.setOnClickPendingIntent(
            R.id.widget_open_app,
            parkingIntent(context, "history", appWidgetId)
        );
        views.setViewVisibility(R.id.widget_directions, View.GONE);
    }

    private static void renderParked(
        Context context,
        RemoteViews views,
        JSONObject parked,
        int appWidgetId,
        boolean conflictingRecord
    ) {
        views.setTextViewText(
            R.id.widget_status,
            context.getString(R.string.where_i_parked_saved_title, formatElapsed(context, parkedTimestampMs(parked)))
        );
        String confidence = parked.optString("confidence", "estimated");
        int confidenceScore = parked.optInt("confidence_score", 0);
        long accuracyM = parked.optLong("accuracy_m", 0L);
        boolean stale = System.currentTimeMillis() - parkedTimestampMs(parked) > STALE_PARKING_MS;
        boolean needsVerification = conflictingRecord || stale || confidenceScore <= 0 || confidenceScore < 60;
        boolean refined = "post_stop_refinement".equals(parked.optString("strategy", "")) ||
            parked.optInt("refinement_count", 0) > 0;
        if (conflictingRecord) {
            views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_conflict_detail));
        } else if (stale) {
            views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_stale_detail));
        } else if (confidenceScore > 0) {
            String detail = confidenceScore + "% confidence";
            if (accuracyM > 0L) detail += " | +/-" + accuracyM + " m GPS";
            if (refined) detail += " | refined after parking";
            String evidence = firstEvidenceLabel(parked);
            if (!evidence.isEmpty()) detail += " | " + evidence;
            detail += ". Location stays hidden.";
            views.setTextViewText(
                R.id.widget_detail,
                detail
            );
        } else {
            int detailResource = "high".equals(confidence)
                ? R.string.where_i_parked_saved_detail_high
                : "medium".equals(confidence)
                    ? R.string.where_i_parked_saved_detail_medium
                    : R.string.where_i_parked_saved_detail_estimated;
            views.setTextViewText(R.id.widget_detail, context.getString(detailResource));
        }
        views.setTextViewText(
            R.id.widget_open_app,
            context.getString(needsVerification
                ? R.string.where_i_parked_verify
                : R.string.where_i_parked_review)
        );
        views.setOnClickPendingIntent(
            R.id.widget_open_app,
            needsVerification
                ? verificationIntent(context, appWidgetId)
                : parkingIntent(context, "history", appWidgetId)
        );
        views.setTextViewText(R.id.widget_directions, context.getString(R.string.where_i_parked_directions));
        views.setViewVisibility(
            R.id.widget_directions,
            needsVerification ? View.GONE : View.VISIBLE
        );
        if (!needsVerification) {
            JSONObject garageEntrance = parked.optBoolean("indoor_estimated", false)
                ? parked.optJSONObject("garage_entrance")
                : null;
            double directionsLat = garageEntrance != null
                ? garageEntrance.optDouble("lat", parked.optDouble("lat", Double.NaN))
                : parked.optDouble("lat", Double.NaN);
            double directionsLng = garageEntrance != null
                ? garageEntrance.optDouble("lng", parked.optDouble("lng", Double.NaN))
                : parked.optDouble("lng", Double.NaN);
            views.setOnClickPendingIntent(
                R.id.widget_directions,
                directionsIntent(
                    context,
                    appWidgetId,
                    directionsLat,
                    directionsLng
                )
            );
        }
        showSecondaryActions(context, views, appWidgetId, true);
    }

    private static void renderPrivate(Context context, RemoteViews views, JSONObject state) {
        views.setTextViewText(
            R.id.widget_status,
            context.getString(
                R.string.where_i_parked_private_title,
                formatElapsed(context, parkedTimestampMs(state))
            )
        );
        views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_private_detail));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_review));
        views.setOnClickPendingIntent(R.id.widget_open_app, verificationIntent(context, 1));
        views.setViewVisibility(R.id.widget_directions, View.GONE);
        showSecondaryActions(context, views, 1, true);
    }

    private static void renderNeedsReview(Context context, RemoteViews views, JSONObject state) {
        views.setTextViewText(
            R.id.widget_status,
            context.getString(
                R.string.where_i_parked_review_title,
                formatElapsed(context, parkedTimestampMs(state))
            )
        );
        views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_review_detail));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_verify));
        views.setOnClickPendingIntent(R.id.widget_open_app, verificationIntent(context, 2));
        views.setViewVisibility(R.id.widget_directions, View.GONE);
        showSecondaryActions(context, views, 2, false);
    }

    private static void renderEmpty(Context context, RemoteViews views) {
        views.setTextViewText(R.id.widget_status, context.getString(R.string.where_i_parked_empty_title));
        views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_empty_detail));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_save));
        views.setOnClickPendingIntent(R.id.widget_open_app, parkingIntent(context, "save", 3));
        views.setViewVisibility(R.id.widget_directions, View.GONE);
    }

    private static boolean hasValidParkedLocation(JSONObject parked) {
        if (parked == null) return false;
        double lat = parked.optDouble("lat", Double.NaN);
        double lng = parked.optDouble("lng", Double.NaN);
        return Double.isFinite(lat) && Double.isFinite(lng) && Math.abs(lat) <= 90d && Math.abs(lng) <= 180d;
    }

    private static boolean sameParkingEvent(JSONObject state, JSONObject parked) {
        if (state == null || parked == null) return false;
        long stateRevision = DriveSenseNativeTripStore.parkingStateRevision(state);
        long parkedRevision = DriveSenseNativeTripStore.parkingStateRevision(parked);
        if (stateRevision > 0L && parkedRevision > 0L && stateRevision != parkedRevision) return false;
        long stateMs = parkedTimestampMs(state);
        long parkedMs = parkedTimestampMs(parked);
        if (stateMs > 0L && parkedMs > 0L && Math.abs(stateMs - parkedMs) > 1_000L) return false;
        String stateTripId = state.optString("tripId", "");
        String parkedTripId = parked.optString("tripId", "");
        return stateTripId.isEmpty() || parkedTripId.isEmpty() || stateTripId.equals(parkedTripId);
    }

    private static void showSecondaryActions(
        Context context,
        RemoteViews views,
        int requestId,
        boolean showReminder
    ) {
        views.setViewVisibility(R.id.widget_secondary_actions, View.VISIBLE);
        views.setViewVisibility(
            R.id.widget_reminder,
            showReminder ? View.VISIBLE : View.GONE
        );
        if (showReminder) {
            views.setOnClickPendingIntent(
                R.id.widget_reminder,
                parkingIntent(context, "reminder", 40_000 + requestId)
            );
        }
        views.setViewVisibility(R.id.widget_found, View.VISIBLE);
        views.setOnClickPendingIntent(
            R.id.widget_found,
            parkingIntent(context, "found", 50_000 + requestId)
        );
    }

    private static void renderMeta(Context context, RemoteViews views, JSONObject record) {
        String health = hasParkingPermissions(context)
            ? context.getString(R.string.where_i_parked_sensors_ready)
            : context.getString(R.string.where_i_parked_permission_warning);
        if (record == null) {
            views.setTextViewText(R.id.widget_meta, health);
            return;
        }
        String meta = context.getString(
            R.string.where_i_parked_synced,
            formatElapsed(context, parkedTimestampMs(record))
        );
        String vehicle = record.optString("vehicle_name", "").trim();
        if (!vehicle.isEmpty()) meta += " | " + vehicle;
        if (record.optBoolean("indoor_estimated", false)) meta += " | indoor estimate";
        if (!record.optString("note", "").trim().isEmpty()) meta += " | note saved";
        if (
            !record.optString("photo_file_id", "").trim().isEmpty() ||
            !record.optString("photo_data_url", "").trim().isEmpty()
        ) meta += " | photo saved";
        meta += " | " + health;
        views.setTextViewText(R.id.widget_meta, meta);
    }

    private static boolean renderReminder(
        Context context,
        RemoteViews views,
        JSONObject parkingState
    ) {
        JSONObject reminder = DriveSenseNativeTripStore.getParkingReminderState(context);
        if (reminder == null) {
            views.setTextViewText(
                R.id.widget_reminder,
                context.getString(R.string.where_i_parked_reminder)
            );
            views.setViewVisibility(R.id.widget_reminder_countdown, View.GONE);
            return false;
        }
        long currentRevision = DriveSenseNativeTripStore.parkingStateRevision(parkingState);
        long reminderRevision = reminder.optLong("state_revision", 0L);
        if (
            reminderRevision > 0L &&
            currentRevision > 0L &&
            reminderRevision != currentRevision
        ) {
            DriveSenseNativeTripStore.clearParkingReminderState(context);
            return false;
        }
        long remainingMs = reminder.optLong("reminder_at_ms", 0L) - System.currentTimeMillis();
        if (remainingMs <= 0L) {
            DriveSenseNativeTripStore.clearParkingReminderState(context);
            return false;
        }
        views.setTextViewText(
            R.id.widget_reminder,
            context.getString(R.string.where_i_parked_reminder_cancel)
        );
        views.setOnClickPendingIntent(
            R.id.widget_reminder,
            parkingIntent(context, "cancelreminder", 60_001)
        );
        views.setChronometer(
            R.id.widget_reminder_countdown,
            SystemClock.elapsedRealtime() + remainingMs,
            context.getString(R.string.where_i_parked_reminder_countdown),
            true
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            views.setChronometerCountDown(R.id.widget_reminder_countdown, true);
        }
        views.setViewVisibility(R.id.widget_reminder_countdown, View.VISIBLE);
        views.setContentDescription(
            R.id.widget_reminder_countdown,
            context.getString(R.string.where_i_parked_reminder_countdown_accessibility)
        );
        views.setOnClickPendingIntent(
            R.id.widget_reminder_countdown,
            parkingIntent(context, "snooze15", 60_002)
        );
        return true;
    }

    static void scheduleReminderDeadlineRefresh(Context context, long reminderAtMs) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        manager.setAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            reminderAtMs,
            reminderDeadlineIntent(context)
        );
    }

    static void cancelReminderDeadlineRefresh(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) manager.cancel(reminderDeadlineIntent(context));
    }

    private static PendingIntent reminderDeadlineIntent(Context context) {
        Intent intent = new Intent(context, WhereIParkedWidgetProvider.class)
            .setAction(ACTION_REMINDER_DUE);
        return PendingIntent.getBroadcast(
            context,
            REMINDER_REFRESH_REQUEST_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static boolean hasParkingPermissions(Context context) {
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
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACTIVITY_RECOGNITION
            ) == PackageManager.PERMISSION_GRANTED;
    }

    private static String firstEvidenceLabel(JSONObject parked) {
        if (parked == null || parked.optJSONArray("evidence") == null) return "";
        String value = parked.optJSONArray("evidence").optString(0, "");
        return value.isEmpty() ? "" : value.replace('_', ' ');
    }

    private static long parkedTimestampMs(JSONObject parked) {
        long storedMs = parked != null ? parked.optLong("timestamp_ms", 0L) : 0L;
        if (storedMs > 0L) return storedMs;
        try {
            return Instant.parse(parked != null ? parked.optString("timestamp", "") : "").toEpochMilli();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    static String formatElapsed(Context context, long timestampMs) {
        if (timestampMs <= 0L) return context.getString(R.string.where_i_parked_recently);
        long elapsedMs = Math.max(0L, System.currentTimeMillis() - timestampMs);
        if (elapsedMs < MINUTE_MS) return context.getString(R.string.where_i_parked_just_now);
        if (elapsedMs < HOUR_MS) {
            long value = Math.max(1L, elapsedMs / MINUTE_MS);
            return context.getResources().getQuantityString(R.plurals.where_i_parked_minutes_ago, (int) value, value);
        }
        if (elapsedMs < DAY_MS) {
            long value = Math.max(1L, elapsedMs / HOUR_MS);
            return context.getResources().getQuantityString(R.plurals.where_i_parked_hours_ago, (int) value, value);
        }
        long value = Math.max(1L, elapsedMs / DAY_MS);
        return context.getResources().getQuantityString(
            R.plurals.where_i_parked_days_ago,
            (int) Math.min(Integer.MAX_VALUE, value),
            value
        );
    }

    private static PendingIntent refreshIntent(Context context, int appWidgetId) {
        Intent intent = new Intent(context, WhereIParkedWidgetProvider.class)
            .setAction(ACTION_REFRESH)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        return PendingIntent.getBroadcast(context, appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openAppIntent(Context context, int appWidgetId) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("widget_source", "where_i_parked");
        return PendingIntent.getActivity(context, 10_000 + appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent verificationIntent(Context context, int requestId) {
        return parkingIntent(context, "verify", requestId);
    }

    private static PendingIntent parkingIntent(Context context, String action, int requestId) {
        Intent intent = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("drivesense://parking/" + action),
            context,
            MainActivity.class
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            context,
            30_000 + requestId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static PendingIntent directionsIntent(Context context, int appWidgetId, double lat, double lng) {
        String coordinate = String.format(Locale.US, "%.7f,%.7f", lat, lng);
        Uri uri = Uri.parse("geo:0,0?q=" + Uri.encode(coordinate + " (Parked vehicle)"));
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 20_000 + appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
