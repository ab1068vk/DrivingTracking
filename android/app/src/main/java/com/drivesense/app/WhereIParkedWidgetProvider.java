package com.drivesense.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.time.Instant;
import java.util.Locale;

/** Privacy-aware home-screen widget for the last confirmed parked position. */
public class WhereIParkedWidgetProvider extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.drivesense.app.action.REFRESH_WHERE_I_PARKED_WIDGET";
    private static final long MINUTE_MS = 60_000L;
    private static final long HOUR_MS = 60L * MINUTE_MS;
    private static final long DAY_MS = 24L * HOUR_MS;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) updateWidget(context, manager, appWidgetId);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) refreshAll(context);
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

        JSONObject activeTrip = DriveSenseNativeTripStore.getActiveTripStatus(context);
        boolean tripActive = activeTrip != null && activeTrip.optBoolean("active", false);
        JSONObject parked = tripActive ? null : DriveSenseNativeTripStore.getLastParkedLocation(context);

        if (tripActive) renderActiveTrip(context, views);
        else if (hasValidParkedLocation(parked)) renderParked(context, views, parked, appWidgetId);
        else renderEmpty(context, views);

        manager.updateAppWidget(appWidgetId, views);
    }

    private static void renderActiveTrip(Context context, RemoteViews views) {
        views.setTextViewText(R.id.widget_status, context.getString(R.string.where_i_parked_driving_title));
        views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_driving_detail));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_open_app));
        views.setViewVisibility(R.id.widget_directions, View.GONE);
    }

    private static void renderParked(Context context, RemoteViews views, JSONObject parked, int appWidgetId) {
        views.setTextViewText(
            R.id.widget_status,
            context.getString(R.string.where_i_parked_saved_title, formatElapsed(context, parkedTimestampMs(parked)))
        );
        String confidence = parked.optString("confidence", "estimated");
        int detailResource = "high".equals(confidence)
            ? R.string.where_i_parked_saved_detail_high
            : "medium".equals(confidence)
                ? R.string.where_i_parked_saved_detail_medium
                : R.string.where_i_parked_saved_detail_estimated;
        views.setTextViewText(R.id.widget_detail, context.getString(detailResource));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_open_app));
        views.setTextViewText(R.id.widget_directions, context.getString(R.string.where_i_parked_directions));
        views.setViewVisibility(R.id.widget_directions, View.VISIBLE);
        views.setOnClickPendingIntent(
            R.id.widget_directions,
            directionsIntent(context, appWidgetId, parked.optDouble("lat", Double.NaN), parked.optDouble("lng", Double.NaN))
        );
    }

    private static void renderEmpty(Context context, RemoteViews views) {
        views.setTextViewText(R.id.widget_status, context.getString(R.string.where_i_parked_empty_title));
        views.setTextViewText(R.id.widget_detail, context.getString(R.string.where_i_parked_empty_detail));
        views.setTextViewText(R.id.widget_open_app, context.getString(R.string.where_i_parked_open_app));
        views.setViewVisibility(R.id.widget_directions, View.GONE);
    }

    private static boolean hasValidParkedLocation(JSONObject parked) {
        if (parked == null) return false;
        double lat = parked.optDouble("lat", Double.NaN);
        double lng = parked.optDouble("lng", Double.NaN);
        return Double.isFinite(lat) && Double.isFinite(lng) && Math.abs(lat) <= 90d && Math.abs(lng) <= 180d;
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

    private static PendingIntent directionsIntent(Context context, int appWidgetId, double lat, double lng) {
        String coordinate = String.format(Locale.US, "%.7f,%.7f", lat, lng);
        Uri uri = Uri.parse("geo:0,0?q=" + Uri.encode(coordinate + " (Parked vehicle)"));
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 20_000 + appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
