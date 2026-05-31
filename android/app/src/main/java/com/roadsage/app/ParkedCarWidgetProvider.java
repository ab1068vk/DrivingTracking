package com.roadsage.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.os.Build;
import android.os.BatteryManager;
import android.os.Bundle;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Log;
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
    private static final String TAG = "ParkedWidget";
    private static final String ACTION_AGE_UPDATE = "com.roadsage.app.ACTION_AGE_UPDATE";
    static final String ACTION_CLEAR_PARKING = "com.roadsage.app.ACTION_CLEAR_PARKING";
    private static final String DEEP_LINK_DASHBOARD = "drivesense://dashboard";
    private static final long[] AGE_ALARM_OFFSETS_MS = {
        60_000L,
        5 * 60_000L,
        10 * 60_000L,
        30 * 60_000L,
        60 * 60_000L,
        2 * 3_600_000L,
        6 * 3_600_000L,
        24 * 3_600_000L,
    };

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null
            && (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction()))) {
            refreshAll(context);
            return;
        }

        if (intent != null && ACTION_CLEAR_PARKING.equals(intent.getAction())) {
            cancelAgeAlarms(context);
            ParkingLocationClearer.clear(context);
            refreshAll(context);
            return;
        }

        if (intent != null && ACTION_AGE_UPDATE.equals(intent.getAction())) {
            updateAgeText(context);
            return;
        }

        super.onReceive(context, intent);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            updateWidget(context, manager, widgetId);
        }
        scheduleAgeAlarmsForCurrentParking(context);
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        cancelAgeAlarms(context);
        for (int widgetId : widgetIds) {
            WorkManager.getInstance(context).cancelUniqueWork(mapWorkName(widgetId));
            File cacheFile = MapTileFetchWorker.getCacheFile(context, widgetId);
            if (cacheFile.exists()) cacheFile.delete();
        }
        scheduleAgeAlarmsForCurrentParking(context);
    }

    @Override
    public void onAppWidgetOptionsChanged(
        Context context,
        AppWidgetManager manager,
        int widgetId,
        Bundle newOptions
    ) {
        File cacheFile = MapTileFetchWorker.getCacheFile(context, widgetId);
        if (cacheFile.exists()) cacheFile.delete();

        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(context);
        if (parked == null) {
            updateWidget(context, manager, widgetId);
            return;
        }

        double lat = parked.optDouble("lat", Double.NaN);
        double lng = parked.optDouble("lng", Double.NaN);
        if (!Double.isFinite(lat) || !Double.isFinite(lng)) {
            updateWidget(context, manager, widgetId);
            return;
        }

        if (PrivacyZoneStore.findMatchingZone(lat, lng, context) != null) {
            updateWidget(context, manager, widgetId);
            return;
        }

        String address = parked.optString("address", "").trim();
        scheduleMapFetch(context, widgetId, lat, lng, false, address, newOptions);
    }

    @Override
    public void onDisabled(Context context) {
        WorkManager.getInstance(context).cancelAllWorkByTag("parked_map");
        cancelAgeAlarms(context);
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
        scheduleAgeAlarmsForCurrentParking(context);
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

        PrivacyZone matchedZone = PrivacyZoneStore.findMatchingZone(lat, lng, context);
        boolean isPrivate = matchedZone != null;
        String address = parked.optString("address", "").trim();
        boolean hasPublicAddress = !isPrivate && !address.isEmpty();

        views.setViewVisibility(R.id.iv_map, View.VISIBLE);
        views.setViewVisibility(R.id.tv_empty_hint, View.GONE);
        views.setViewVisibility(R.id.btn_navigate, View.VISIBLE);
        views.setViewVisibility(R.id.btn_clear_parking, View.VISIBLE);
        views.setViewVisibility(R.id.iv_privacy_badge, isPrivate ? View.VISIBLE : View.GONE);

        if (isPrivate) {
            views.setTextViewText(R.id.tv_parked_status, buildParkedStatusText(matchedZone, timestampMs, System.currentTimeMillis()));
            views.setImageViewResource(R.id.iv_map, R.drawable.widget_map_placeholder);
            views.setContentDescription(R.id.iv_map, context.getString(R.string.widget_privacy_map_hidden_description));
            views.setViewVisibility(R.id.tv_parked_address, View.GONE);
            WorkManager.getInstance(context).cancelUniqueWork(mapWorkName(widgetId));
        } else {
            views.setTextViewText(R.id.tv_parked_status, buildParkedStatusText(null, timestampMs, System.currentTimeMillis()));
            views.setContentDescription(R.id.iv_map, context.getString(R.string.widget_parked_map_description));
            if (hasPublicAddress) {
                views.setTextViewText(R.id.tv_parked_address, address);
                views.setViewVisibility(R.id.tv_parked_address, View.VISIBLE);
            } else {
                views.setViewVisibility(R.id.tv_parked_address, View.GONE);
            }

            File cacheFile = MapTileFetchWorker.getCacheFile(context, widgetId);
            if (cacheFile.exists() && cacheFile.lastModified() >= timestampMs) {
                Bitmap cached = BitmapFactory.decodeFile(cacheFile.getAbsolutePath());
                if (cached != null) {
                    views.setImageViewBitmap(R.id.iv_map, cached);
                    if (address.isEmpty()) {
                        scheduleMapFetch(context, widgetId, lat, lng, false, address);
                    }
                }
            } else {
                views.setImageViewResource(R.id.iv_map, R.drawable.widget_map_placeholder);
                scheduleMapFetch(context, widgetId, lat, lng, false, address);
            }
        }

        setClearParkingIntent(context, views, widgetId);
        setNavigateIntent(context, views, widgetId, lat, lng);
        setDashboardTapIntent(context, views, widgetId + 10_000);
        manager.updateAppWidget(widgetId, views);
    }

    private static void updateAgeText(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, ParkedCarWidgetProvider.class));
        if (widgetIds == null || widgetIds.length == 0) return;

        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(context);
        if (parked == null) {
            cancelAgeAlarms(context);
            return;
        }

        double lat = parked.optDouble("lat", Double.NaN);
        double lng = parked.optDouble("lng", Double.NaN);
        long parkedMs = parkedTimestampMs(parked, System.currentTimeMillis());
        PrivacyZone matchedZone = Double.isFinite(lat) && Double.isFinite(lng)
            ? PrivacyZoneStore.findMatchingZone(lat, lng, context)
            : null;
        String status = buildParkedStatusText(matchedZone, parkedMs, System.currentTimeMillis());

        for (int widgetId : widgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_parked_car);
            views.setTextViewText(R.id.tv_parked_status, status);
            manager.partiallyUpdateAppWidget(widgetId, views);
        }
    }

    private static String buildParkedStatusText(PrivacyZone zone, long parkedMs, long nowMs) {
        long ageMs = Math.max(0L, nowMs - parkedMs);
        if (zone != null) {
            return "Parked near " + zone.name + " · " + formatAge(ageMs);
        }
        return "Parked " + formatAge(ageMs);
    }

    private static void scheduleAgeAlarmsForCurrentParking(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, ParkedCarWidgetProvider.class));
        if (widgetIds == null || widgetIds.length == 0) {
            cancelAgeAlarms(context);
            return;
        }

        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(context);
        if (parked == null) {
            cancelAgeAlarms(context);
            return;
        }
        scheduleAgeAlarms(context, parkedTimestampMs(parked, System.currentTimeMillis()));
    }

    private static void scheduleAgeAlarms(Context context, long parkedTimestampMs) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;
        cancelAgeAlarms(context);

        long now = System.currentTimeMillis();
        for (long offsetMs : AGE_ALARM_OFFSETS_MS) {
            long triggerMs = parkedTimestampMs + offsetMs;
            if (triggerMs <= now) continue;

            PendingIntent pendingIntent = ageUpdatePendingIntent(
                context,
                offsetMs,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            if (offsetMs <= 3_600_000L) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pendingIntent);
                } else {
                    alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pendingIntent);
                }
            } else {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pendingIntent);
            }
        }
    }

    private static void cancelAgeAlarms(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        for (long offsetMs : AGE_ALARM_OFFSETS_MS) {
            PendingIntent pendingIntent = ageUpdatePendingIntent(
                context,
                offsetMs,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
            );
            if (pendingIntent != null) alarmManager.cancel(pendingIntent);
        }
    }

    private static PendingIntent ageUpdatePendingIntent(Context context, long offsetMs, int flags) {
        Intent intent = new Intent(context, ParkedCarWidgetProvider.class);
        intent.setAction(ACTION_AGE_UPDATE);
        return PendingIntent.getBroadcast(context, (int) (offsetMs / 1000L), intent, flags);
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
        views.setViewVisibility(R.id.iv_privacy_badge, View.GONE);
        views.setViewVisibility(R.id.tv_empty_hint, View.VISIBLE);
        views.setViewVisibility(R.id.btn_navigate, View.GONE);
        views.setViewVisibility(R.id.btn_clear_parking, View.GONE);
        views.setViewVisibility(R.id.tv_parked_address, View.GONE);
        views.setTextViewText(R.id.tv_parked_status, "No parked location saved yet");
    }

    private static void setClearParkingIntent(Context context, RemoteViews views, int widgetId) {
        Intent intent = new Intent(context, ParkedCarWidgetProvider.class);
        intent.setAction(ACTION_CLEAR_PARKING);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        PendingIntent pendingIntent = PendingIntent.getBroadcast(
            context,
            widgetId + 50_000,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.btn_clear_parking, pendingIntent);
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

    private static void scheduleMapFetch(Context context, int widgetId, double lat, double lng, boolean isPrivate, String existingAddress) {
        scheduleMapFetch(context, widgetId, lat, lng, isPrivate, existingAddress, null);
    }

    private static void scheduleMapFetch(
        Context context,
        int widgetId,
        double lat,
        double lng,
        boolean isPrivate,
        String existingAddress,
        Bundle widgetOptions
    ) {
        if (isPrivate) return;

        if (isBatteryLow(context)) {
            Log.d(TAG, "Map fetch skipped — battery low");
            return;
        }

        int[] size = computeTileSize(context, widgetId, widgetOptions);

        Data input = new Data.Builder()
            .putInt(MapTileFetchWorker.KEY_WIDGET_ID, widgetId)
            .putDouble(MapTileFetchWorker.KEY_LAT, lat)
            .putDouble(MapTileFetchWorker.KEY_LNG, lng)
            .putInt(MapTileFetchWorker.KEY_TILE_WIDTH, size[0])
            .putInt(MapTileFetchWorker.KEY_TILE_HEIGHT, size[1])
            .putString(MapTileFetchWorker.KEY_EXISTING_ADDRESS, existingAddress == null ? "" : existingAddress)
            .putBoolean(MapTileFetchWorker.KEY_PRIVACY_ZONE, isPrivate)
            .build();

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build();

        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(MapTileFetchWorker.class)
            .setConstraints(constraints)
            .setInputData(input)
            .addTag("parked_map")
            .build();

        WorkManager.getInstance(context).enqueueUniqueWork(mapWorkName(widgetId), ExistingWorkPolicy.REPLACE, work);
    }

    private static String mapWorkName(int widgetId) {
        return "parked_car_map_" + widgetId;
    }

    private static int[] computeTileSize(Context context, int widgetId) {
        return computeTileSize(context, widgetId, null);
    }

    private static int[] computeTileSize(Context context, int widgetId, Bundle widgetOptions) {
        Bundle opts = widgetOptions;
        if (opts == null) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            opts = mgr.getAppWidgetOptions(widgetId);
        }
        int maxDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 300);
        float density = context.getResources().getDisplayMetrics().density;
        int tileW = Math.min((int) (maxDp * density * 0.9f), 600);
        int tileH = Math.min(tileW / 2, 300);
        return new int[]{tileW, tileH};
    }

    private static boolean isBatteryLow(Context context) {
        Intent b = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return false;

        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, 100);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
            || status == BatteryManager.BATTERY_STATUS_FULL;
        return scale > 0 && (level * 100f / scale) < 15f && !charging;
    }
}
