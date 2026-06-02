package com.roadsage.app;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.Log;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

public class MapTileFetchWorker extends Worker {
    private static final String TAG = "MapTileFetchWorker";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final Object GEOCODE_LOCK = new Object();
    private static final String MAP_CACHE_PREFIX = "widget_map_";
    private static final String LEGACY_MAP_CACHE_PREFIX = "parked_map_widget_";
    private static final String MAP_CACHE_SUFFIX = ".png";
    private static final int OSM_WIDGET_ZOOM = 16;
    private static final int OSM_TILE_SIZE = 256;
    private static final double MAX_WEB_MERCATOR_LAT = 85.05112878d;
    private static final String[] OSM_TILE_HOSTS = {
        "a.tile.openstreetmap.org",
        "b.tile.openstreetmap.org",
        "c.tile.openstreetmap.org"
    };

    static final String KEY_WIDGET_ID = "widget_id";
    static final String KEY_LAT = "lat";
    static final String KEY_LNG = "lng";
    static final String KEY_TILE_WIDTH = "tile_width";
    static final String KEY_TILE_HEIGHT = "tile_height";
    static final String KEY_PRIVACY_ZONE = "privacy_zone";
    static final String KEY_EXISTING_ADDRESS = "existing_address";

    public MapTileFetchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        int widgetId = getInputData().getInt(KEY_WIDGET_ID, -1);
        double lat = getInputData().getDouble(KEY_LAT, Double.NaN);
        double lng = getInputData().getDouble(KEY_LNG, Double.NaN);
        int tileW = getInputData().getInt(KEY_TILE_WIDTH, 300);
        int tileH = getInputData().getInt(KEY_TILE_HEIGHT, 150);

        if (widgetId == -1 || !Double.isFinite(lat) || !Double.isFinite(lng)) return Result.failure();
        if (
            getInputData().getBoolean(KEY_PRIVACY_ZONE, false) ||
            PrivacyZoneStore.findMatchingZone(lat, lng, context) != null
        ) {
            deleteCacheForWidgetAndLocation(context, widgetId, lat, lng);
            showPrivacyPlaceholder(context, widgetId);
            return Result.success();
        }

        Bitmap raw = fetchMapTiles(lat, lng, tileW, tileH);
        if (raw == null) return Result.retry();

        Bitmap pinned = applyDarkMapStyle(raw);
        raw.recycle();
        drawParkedPin(pinned, pinned.getWidth());

        File cacheFile = getCacheFile(context, widgetId, lat, lng);
        try (FileOutputStream output = new FileOutputStream(cacheFile)) {
            pinned.compress(Bitmap.CompressFormat.PNG, 90, output);
            output.flush();
        } catch (Exception e) {
            pinned.recycle();
            return Result.retry();
        }

        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_parked_car);
        Bitmap display = BitmapFactory.decodeFile(cacheFile.getAbsolutePath());
        if (display != null) {
            views.setImageViewBitmap(R.id.iv_map, display);
            manager.partiallyUpdateAppWidget(widgetId, views);
        }

        pinned.recycle();
        maybeReverseGeocode(context, widgetId, lat, lng);
        return Result.success();
    }

    static File getCacheFile(Context context, int widgetId) {
        return new File(context.getFilesDir(), LEGACY_MAP_CACHE_PREFIX + widgetId + MAP_CACHE_SUFFIX);
    }

    static File getCacheFile(Context context, int widgetId, double lat, double lng) {
        if (!Double.isFinite(lat) || !Double.isFinite(lng)) return getCacheFile(context, widgetId);
        return new File(
            context.getFilesDir(),
            String.format(Locale.US, MAP_CACHE_PREFIX + "%.4f_%.4f" + MAP_CACHE_SUFFIX, lat, lng)
        );
    }

    static void deleteCacheForWidgetAndLocation(Context context, int widgetId, double lat, double lng) {
        File legacyFile = getCacheFile(context, widgetId);
        if (legacyFile.exists()) SecureDelete.wipeAndDelete(legacyFile);

        File locationFile = getCacheFile(context, widgetId, lat, lng);
        if (locationFile.exists()) SecureDelete.wipeAndDelete(locationFile);
    }

    static void clearWidgetMapCache(Context context) {
        File[] cacheFiles = context.getFilesDir().listFiles((dir, name) -> (
            name.endsWith(MAP_CACHE_SUFFIX) &&
                (name.startsWith(MAP_CACHE_PREFIX) || name.startsWith(LEGACY_MAP_CACHE_PREFIX))
        ));
        if (cacheFiles == null) return;

        for (File file : cacheFiles) {
            if (!file.isFile()) continue;
            boolean deleted = SecureDelete.wipeAndDelete(file);
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "Cleared widget cache file: " + file.getName() + " deleted=" + deleted);
            }
        }
    }

    private static void showPrivacyPlaceholder(Context context, int widgetId) {
        File cacheFile = getCacheFile(context, widgetId);
        if (cacheFile.exists()) SecureDelete.wipeAndDelete(cacheFile);

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_parked_car);
        views.setImageViewResource(R.id.iv_map, R.drawable.widget_map_placeholder);
        views.setContentDescription(R.id.iv_map, context.getString(R.string.widget_privacy_map_hidden_description));
        AppWidgetManager.getInstance(context).partiallyUpdateAppWidget(widgetId, views);
    }

    private static Bitmap applyDarkMapStyle(Bitmap source) {
        Bitmap dark = Bitmap.createBitmap(source.getWidth(), source.getHeight(), Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(dark);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColorFilter(new ColorMatrixColorFilter(new float[]{
            -0.75f, 0f, 0f, 0f, 207f,
            0f, -0.78f, 0f, 0f, 239f,
            0f, 0f, -0.85f, 0f, 271f,
            0f, 0f, 0f, 1f, 0f
        }));
        canvas.drawBitmap(source, 0f, 0f, paint);
        return dark;
    }

    private static Bitmap fetchMapTiles(double lat, double lng, int tileW, int tileH) {
        int width = Math.max(128, Math.min(tileW, 1024));
        int height = Math.max(96, Math.min(tileH, 1024));
        int tileCount = 1 << OSM_WIDGET_ZOOM;
        double clampedLat = Math.max(-MAX_WEB_MERCATOR_LAT, Math.min(MAX_WEB_MERCATOR_LAT, lat));
        double latRad = Math.toRadians(clampedLat);
        double centerX = ((lng + 180d) / 360d) * tileCount * OSM_TILE_SIZE;
        double centerY = (
            1d - Math.log(Math.tan(latRad) + (1d / Math.cos(latRad))) / Math.PI
        ) / 2d * tileCount * OSM_TILE_SIZE;
        double left = centerX - width / 2d;
        double top = centerY - height / 2d;
        int startX = (int) Math.floor(left / OSM_TILE_SIZE);
        int endX = (int) Math.floor((left + width - 1d) / OSM_TILE_SIZE);
        int startY = (int) Math.floor(top / OSM_TILE_SIZE);
        int endY = (int) Math.floor((top + height - 1d) / OSM_TILE_SIZE);

        Bitmap map = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(map);
        canvas.drawColor(0xFFE5E7EB);

        for (int tileX = startX; tileX <= endX; tileX++) {
            for (int tileY = startY; tileY <= endY; tileY++) {
                if (tileY < 0 || tileY >= tileCount) continue;
                int wrappedX = Math.floorMod(tileX, tileCount);
                Bitmap tile = fetchBitmap(osmTileUrl(wrappedX, tileY));
                if (tile == null) {
                    map.recycle();
                    return null;
                }
                canvas.drawBitmap(
                    tile,
                    (float) (tileX * OSM_TILE_SIZE - left),
                    (float) (tileY * OSM_TILE_SIZE - top),
                    null
                );
                tile.recycle();
            }
        }

        return map;
    }

    private static String osmTileUrl(int tileX, int tileY) {
        String host = OSM_TILE_HOSTS[Math.floorMod(tileX + tileY, OSM_TILE_HOSTS.length)];
        return String.format(
            Locale.US,
            "https://%s/%d/%d/%d.png",
            host,
            OSM_WIDGET_ZOOM,
            tileX,
            tileY
        );
    }

    private static Bitmap fetchBitmap(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(12_000);
            connection.setRequestProperty("User-Agent", "RoadSage/1.0 (Android parked car widget)");
            connection.connect();

            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                return null;
            }

            try (InputStream input = connection.getInputStream()) {
                return BitmapFactory.decodeStream(input);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void drawParkedPin(Bitmap bitmap, int tileW) {
        Canvas canvas = new Canvas(bitmap);
        int centerX = bitmap.getWidth() / 2;
        int centerY = bitmap.getHeight() / 2;
        float scale = tileW / 300f;
        float pinRadius = scale * 16f;
        float outerRadius = scale * 22f;
        float textSize = scale * 20f;

        Paint white = new Paint(Paint.ANTI_ALIAS_FLAG);
        white.setColor(Color.WHITE);
        white.setShadowLayer(6f, 0f, 2f, 0x88000000);
        canvas.drawCircle(centerX, centerY, outerRadius, white);

        Paint blue = new Paint(Paint.ANTI_ALIAS_FLAG);
        blue.setColor(0xFF3B82F6);
        canvas.drawCircle(centerX, centerY, pinRadius, blue);

        Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        text.setColor(Color.WHITE);
        text.setTextSize(textSize);
        text.setTypeface(Typeface.DEFAULT_BOLD);
        text.setTextAlign(Paint.Align.CENTER);
        float textY = centerY - (text.ascent() + text.descent()) / 2f;
        canvas.drawText("P", centerX, textY, text);
    }

    private void maybeReverseGeocode(Context context, int widgetId, double lat, double lng) {
        String existing = getInputData().getString(KEY_EXISTING_ADDRESS);
        boolean priv = getInputData().getBoolean(KEY_PRIVACY_ZONE, false);
        if (priv || (existing != null && !existing.trim().isEmpty())) return;
        if (PrivacyZoneStore.findMatchingZone(lat, lng, context) != null) return;

        synchronized (GEOCODE_LOCK) {
            if (hasStoredAddress(context)) return;

            try {
                JSONObject geo = reverseGeocodeIfPermitted(context, lat, lng);
                if (geo == null) return;
                String shortAddr = shortenAddress(geo.optString("display_name", ""));
                if (shortAddr.isEmpty()) return;

                updateStoredAddress(context, shortAddr);
                if (widgetId != -1) {
                    AppWidgetManager mgr = AppWidgetManager.getInstance(context);
                    RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_parked_car);
                    rv.setTextViewText(R.id.tv_parked_address, shortAddr);
                    rv.setViewVisibility(R.id.tv_parked_address, android.view.View.VISIBLE);
                    rv.setContentDescription(R.id.btn_navigate, "Navigate to car parked at " + shortAddr);
                    mgr.partiallyUpdateAppWidget(widgetId, rv);
                }
            } catch (Exception e) {
                if (BuildConfig.DEBUG) {
                    Log.w(TAG, "Geocode silent fail: " + e.getMessage());
                }
            }
        }
    }

    @Nullable
    private static JSONObject reverseGeocodeIfPermitted(Context context, double lat, double lng) {
        if (PrivacyZoneStore.findMatchingZone(lat, lng, context) != null) return null;

        try {
            String geoUrl = String.format(
                Locale.US,
                "https://nominatim.openstreetmap.org/reverse?format=json&lat=%.6f&lon=%.6f&zoom=17&addressdetails=0",
                lat,
                lng
            );
            String body = fetchText(geoUrl);
            if (body == null || body.trim().isEmpty()) return null;
            return new JSONObject(body);
        } catch (JSONException e) {
            if (BuildConfig.DEBUG) {
                Log.w(TAG, "Geocode parse failed");
            }
            return null;
        }
    }

    private static String fetchText(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(12_000);
            connection.setRequestProperty("User-Agent", "RoadSage/1.0 (Android parked car widget)");
            connection.connect();

            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                return null;
            }

            try (InputStream input = connection.getInputStream()) {
                return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String shortenAddress(String full) {
        if (full == null) return "";
        String trimmed = full.trim();
        if (trimmed.isEmpty()) return "";

        String[] parts = trimmed.split(",");
        if (parts.length >= 2) {
            return parts[0].trim() + ", " + parts[1].trim();
        }
        return trimmed;
    }

    private static void updateStoredAddress(Context context, String addr) {
        updateJsonAddress(
            DriveSenseNativeTripStore.prefs(context),
            KEY_LAST_PARKED,
            addr,
            false
        );
    }

    private static boolean hasStoredAddress(Context context) {
        return hasAddress(
            DriveSenseNativeTripStore.prefs(context),
            KEY_LAST_PARKED
        );
    }

    private static boolean hasAddress(SharedPreferences prefs, String key) {
        String raw = prefs.getString(key, null);
        if (raw == null || raw.trim().isEmpty()) return false;

        try {
            return !new JSONObject(raw).optString("address", "").trim().isEmpty();
        } catch (JSONException e) {
            return false;
        }
    }

    private static void updateJsonAddress(SharedPreferences prefs, String key, String addr, boolean writeWhenMissing) {
        String raw = prefs.getString(key, null);
        if ((raw == null || raw.trim().isEmpty()) && !writeWhenMissing) return;

        try {
            JSONObject parked = new JSONObject(raw == null ? "{}" : raw);
            parked.put("address", addr);
            prefs.edit().putString(key, parked.toString()).apply();
        } catch (JSONException e) {
            if (BuildConfig.DEBUG) {
                Log.w(TAG, "Stored address update failed: " + e.getMessage());
            }
        }
    }
}
