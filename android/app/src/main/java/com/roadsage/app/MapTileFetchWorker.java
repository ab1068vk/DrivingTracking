package com.roadsage.app;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MapTileFetchWorker extends Worker {
    static final String KEY_URL = "tile_url";
    static final String KEY_WIDGET_ID = "widget_id";
    static final String KEY_LAT = "lat";
    static final String KEY_LNG = "lng";

    public MapTileFetchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String url = getInputData().getString(KEY_URL);
        int widgetId = getInputData().getInt(KEY_WIDGET_ID, -1);

        if (url == null || widgetId == -1) return Result.failure();

        Bitmap raw = fetchTile(url);
        if (raw == null) return Result.retry();

        Bitmap pinned = raw.copy(Bitmap.Config.ARGB_8888, true);
        raw.recycle();
        drawParkedPin(pinned);

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

    private static void drawParkedPin(Bitmap bitmap) {
        Canvas canvas = new Canvas(bitmap);
        int centerX = bitmap.getWidth() / 2;
        int centerY = bitmap.getHeight() / 2;

        Paint white = new Paint(Paint.ANTI_ALIAS_FLAG);
        white.setColor(Color.WHITE);
        white.setShadowLayer(6f, 0f, 2f, 0x88000000);
        canvas.drawCircle(centerX, centerY, 22f, white);

        Paint blue = new Paint(Paint.ANTI_ALIAS_FLAG);
        blue.setColor(0xFF3B82F6);
        canvas.drawCircle(centerX, centerY, 16f, blue);

        Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        text.setColor(Color.WHITE);
        text.setTextSize(20f);
        text.setTypeface(Typeface.DEFAULT_BOLD);
        text.setTextAlign(Paint.Align.CENTER);
        float textY = centerY - (text.ascent() + text.descent()) / 2f;
        canvas.drawText("P", centerX, textY, text);
    }
}
