package com.roadsage.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONObject;

import java.io.File;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Locale;

public class ParkedCarWidgetProvider extends AppWidgetProvider {
    private static final String DEEP_LINK_DASHBOARD = "drivesense://dashboard";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            updateWidget(context, manager, widgetId);
        }
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            File cacheFile = MapTileFetchWorker.getCacheFile(context, widgetId);
            if (cacheFile.exists()) cacheFile.delete();
        }
    }

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, ParkedCarWidgetProvider.class));
        if (widgetIds == null || widgetIds.length == 0) return;

        for (int widgetId : widgetIds) {
            File cacheFile = MapTileFetchWorker.getCacheFile(context, widgetId);
            if (cacheFile.exists()) cacheFile.delete();
            updateWidget(context, manager, widgetId);
        }
    }

    static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_parked_car);
        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(context);

        if (parked == null) {
            showEmptyState(views);
            setDashboardTapIntent(context, views, widgetId);
            manager.updateAppWidget(widgetId, views);
            return;
        }

        double lat = parked.optDouble("lat", Double.NaN);
        double lng = parked.optDouble("lng", Double.NaN);
        long timestampMs = parkedTimestampMs(parked, System.currentTimeMillis());
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || timestampMs <= 0L) {
            showEmptyState(views);
            setDashboardTapIntent(context, views, widgetId);
            manager.updateAppWidget(widgetId, views);
            return;
        }

        long ageMs = Math.max(0L, System.currentTimeMillis() - timestampMs);
        views.setViewVisibility(R.id.iv_map, View.VISIBLE);
        views.setViewVisibility(R.id.tv_empty_hint, View.GONE);
        views.setViewVisibility(R.id.btn_navigate, View.VISIBLE);
        views.setTextViewText(R.id.tv_parked_status, "Parked " + formatAge(ageMs));

        File cacheFile = MapTileFetchWorker.getCacheFile(context, widgetId);
        if (cacheFile.exists() && cacheFile.lastModified() >= timestampMs) {
            Bitmap cached = BitmapFactory.decodeFile(cacheFile.getAbsolutePath());
            if (cached != null) {
                views.setImageViewBitmap(R.id.iv_map, cached);
            }
        } else {
            views.setImageViewResource(R.id.iv_map, R.drawable.widget_map_placeholder);
            scheduleMapFetch(context, widgetId, lat, lng);
        }

        setNavigateIntent(context, views, widgetId, lat, lng);
        setDashboardTapIntent(context, views, widgetId + 10_000);
        manager.updateAppWidget(widgetId, views);
    }

    static String formatAge(long ageMs) {
        long totalMinutes = Math.max(0L, ageMs) / 60_000L;
        if (totalMinutes < 1L) return "just now";
        if (totalMinutes < 60L) return totalMinutes + "m ago";

        long hours = totalMinutes / 60L;
        long minutes = totalMinutes % 60L;
        if (minutes == 0L) return hours + "h ago";
        return hours + "h " + minutes + "m ago";
    }

    static long parkedTimestampMs(JSONObject parked, long fallbackMs) {
        long timestampMs = parked.optLong("timestamp_ms", 0L);
        if (timestampMs > 0L) return timestampMs;

        String timestamp = parked.optString("timestamp", "");
        if (!timestamp.trim().isEmpty()) {
            try {
                return Instant.parse(timestamp).toEpochMilli();
            } catch (DateTimeParseException ignored) {}
        }

        return fallbackMs;
    }

    private static void showEmptyState(RemoteViews views) {
        views.setViewVisibility(R.id.iv_map, View.GONE);
        views.setViewVisibility(R.id.tv_empty_hint, View.VISIBLE);
        views.setViewVisibility(R.id.btn_navigate, View.GONE);
        views.setTextViewText(R.id.tv_parked_status, "No parked location saved yet");
    }

    private static void setNavigateIntent(Context context, RemoteViews views, int widgetId, double lat, double lng) {
        Uri geoUri = Uri.parse(String.format(
            Locale.US,
            "geo:%.6f,%.6f?q=%.6f,%.6f(Your%%20Car)",
            lat,
            lng,
            lat,
            lng
        ));
        Intent intent = new Intent(Intent.ACTION_VIEW, geoUri);
        intent.addCategory(Intent.CATEGORY_DEFAULT);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            widgetId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.btn_navigate, pendingIntent);
    }

    private static void setDashboardTapIntent(Context context, RemoteViews views, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.putExtra("deeplink", DEEP_LINK_DASHBOARD);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);
    }

    private static void scheduleMapFetch(Context context, int widgetId, double lat, double lng) {
        String tileUrl = String.format(
            Locale.US,
            "https://staticmap.openstreetmap.de/staticmap.php?center=%.6f,%.6f&zoom=16&size=300x150",
            lat,
            lng
        );

        Data input = new Data.Builder()
            .putString(MapTileFetchWorker.KEY_URL, tileUrl)
            .putInt(MapTileFetchWorker.KEY_WIDGET_ID, widgetId)
            .putDouble(MapTileFetchWorker.KEY_LAT, lat)
            .putDouble(MapTileFetchWorker.KEY_LNG, lng)
            .build();

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(MapTileFetchWorker.class)
            .setConstraints(constraints)
            .setInputData(input)
            .addTag("parked_map")
            .build();

        String workName = "parked_car_map_" + widgetId;
        WorkManager.getInstance(context).enqueueUniqueWork(workName, ExistingWorkPolicy.REPLACE, work);
    }
}
