package com.drivesense.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;

/** Deletes encrypted parking photos after their user-selected local retention deadline. */
public final class ParkingPhotoExpiryScheduler extends BroadcastReceiver {
    private static final String PREFS = "parking_photo_expiry";
    private static final String KEY_DEADLINES = "deadlines";
    private static final String ACTION_EXPIRE = "com.drivesense.app.action.EXPIRE_PARKING_PHOTOS";
    private static final int REQUEST_ID = 46_061;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null || !ACTION_EXPIRE.equals(intent.getAction())) return;
        PendingResult pending = goAsync();
        Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                reconcile(appContext);
            } finally {
                pending.finish();
            }
        }, "parking-photo-expiry").start();
    }

    static synchronized void schedule(Context context, String photoId, long expiresAtMs) {
        String safeId = safeId(photoId);
        if (safeId == null || expiresAtMs <= 0L) return;
        JSONObject deadlines = read(context);
        try {
            deadlines.put(safeId, expiresAtMs);
        } catch (Exception ignored) {
            return;
        }
        write(context, deadlines);
        reconcile(context);
    }

    static synchronized void cancel(Context context, String photoId) {
        String safeId = safeId(photoId);
        if (safeId == null) return;
        JSONObject deadlines = read(context);
        deadlines.remove(safeId);
        write(context, deadlines);
        scheduleNext(context, deadlines);
    }

    static synchronized void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) manager.cancel(alarmIntent(context));
    }

    static synchronized void reconcile(Context context) {
        JSONObject deadlines = read(context);
        long now = System.currentTimeMillis();
        Iterator<String> keys = deadlines.keys();
        while (keys.hasNext()) {
            String photoId = keys.next();
            long deadline = deadlines.optLong(photoId, 0L);
            File photo = photoFile(context, photoId);
            if (deadline <= 0L || !photo.isFile()) {
                keys.remove();
                continue;
            }
            if (deadline > now) continue;
            try {
                SecureDeleteHelper.secureWipeFile(photo);
            } catch (Exception ignored) {
                if (photo.exists()) photo.delete();
            }
            DriveSenseNativeTripStore.clearParkingPhotoReference(context, photoId);
            keys.remove();
        }
        write(context, deadlines);
        scheduleNext(context, deadlines);
    }

    static File photoFile(Context context, String photoId) {
        return new File(new File(context.getFilesDir(), "parking_photos"), photoId + ".enc");
    }

    private static void scheduleNext(Context context, JSONObject deadlines) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        manager.cancel(alarmIntent(context));
        long next = earliestDeadline(deadlines);
        if (next == Long.MAX_VALUE) return;
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            manager.canScheduleExactAlarms()
        ) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, alarmIntent(context));
        } else {
            // Android 12+ may reserve exact alarms for calendar/alarm-clock apps.
            // The fallback still runs while idle without asking for a sensitive permission.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, alarmIntent(context));
        }
    }

    static long earliestDeadline(JSONObject deadlines) {
        long next = Long.MAX_VALUE;
        if (deadlines == null) return next;
        Iterator<String> keys = deadlines.keys();
        while (keys.hasNext()) {
            long deadline = deadlines.optLong(keys.next(), 0L);
            if (deadline > 0L && deadline < next) next = deadline;
        }
        return next;
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, ParkingPhotoExpiryScheduler.class).setAction(ACTION_EXPIRE);
        return PendingIntent.getBroadcast(
            context,
            REQUEST_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static JSONObject read(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            return new JSONObject(prefs.getString(KEY_DEADLINES, "{}"));
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static void write(Context context, JSONObject deadlines) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_DEADLINES, deadlines.toString())
            .commit();
    }

    private static String safeId(String value) {
        return value != null && value.matches("[0-9a-fA-F-]{36}") ? value : null;
    }
}
