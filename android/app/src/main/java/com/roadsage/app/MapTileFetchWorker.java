package com.roadsage.app;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.Log;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
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
    private static final String NATIVE_PREFS = "road_sage_native_tracking";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String CAPACITOR_LAST_PARKED_KEY = "road_sage_last_parked";

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
        if (getInputData().getBoolean(KEY_PRIVACY_ZONE, false)) return Result.success();

        Context context = getApplicationContext();
        int widgetId = getInputData().getInt(KEY_WIDGET_ID, -1);
        double lat = getInputData().getDouble(KEY_LAT, Double.NaN);
        double lng = getInputData().getDouble(KEY_LNG, Double.NaN);
        int tileW = getInputData().getInt(KEY_TILE_WIDTH, 300);
        int tileH = getInputData().getInt(KEY_TILE_HEIGHT, 150);

        if (widgetId == -1 || !Double.isFinite(lat) || !Double.isFinite(lng)) return Result.failure();

        String url = String.format(
            Locale.US,
            "https://staticmap.openstreetmap.de/staticmap.php?center=%.6f,%.6f&zoom=16&size=%dx%d",
            lat,
            lng,
            tileW,
            tileH
        );
        Bitmap raw = fetchTile(url);
        if (raw == null) return Result.retry();

        Bitmap pinned = raw.copy(Bitmap.Config.ARGB_8888, true);
        raw.recycle();
        drawParkedPin(pinned, tileW);

        File cacheFile = getCacheFile(context, widgetId);
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
        return new File(context.getFilesDir(), "parked_map_widget_" + widgetId + ".png");
    }

    private static Bitmap fetchTile(String url) {
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

        try {
            String geoUrl = String.format(
                Locale.US,
                "https://nominatim.openstreetmap.org/reverse?format=json&lat=%.6f&lon=%.6f&zoom=17&addressdetails=0",
                lat,
                lng
            );
            String body = fetchText(geoUrl);
            if (body == null || body.trim().isEmpty()) return;

            JSONObject geo = new JSONObject(body);
            String shortAddr = shortenAddress(geo.optString("display_name", ""));
            if (shortAddr.isEmpty()) return;

            updateStoredAddress(context, shortAddr);
            if (widgetId != -1) {
                AppWidgetManager mgr = AppWidgetManager.getInstance(context);
                RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_parked_car);
                rv.setTextViewText(R.id.tv_parked_address, shortAddr);
                rv.setViewVisibility(R.id.tv_parked_address, android.view.View.VISIBLE);
                mgr.partiallyUpdateAppWidget(widgetId, rv);
            }
        } catch (Exception e) {
            Log.w(TAG, "Geocode silent fail: " + e.getMessage());
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
            context.getSharedPreferences(NATIVE_PREFS, Context.MODE_PRIVATE),
            KEY_LAST_PARKED,
            addr,
            false
        );
        updateJsonAddress(
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE),
            CAPACITOR_LAST_PARKED_KEY,
            addr,
            false
        );
    }

    private static void updateJsonAddress(SharedPreferences prefs, String key, String addr, boolean writeWhenMissing) {
        String raw = prefs.getString(key, null);
        if ((raw == null || raw.trim().isEmpty()) && !writeWhenMissing) return;

        try {
            JSONObject parked = new JSONObject(raw == null ? "{}" : raw);
            parked.put("address", addr);
            prefs.edit().putString(key, parked.toString()).apply();
        } catch (JSONException e) {
            Log.w(TAG, "Stored address update failed: " + e.getMessage());
        }
    }
}
