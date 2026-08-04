package com.drivesense.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import android.util.Log;

/**
 * Privacy-safe process and responsiveness watchdog.
 *
 * It never stores route data, coordinates, trip identifiers, WebView URLs with
 * query strings, JavaScript values, stack traces, or Android exit descriptions.
 */
final class AppExperienceWatchdog {
    private static final String TAG = "AppExperienceWatchdog";
    private static final String PREFS = "roadsage_app_watchdog";
    private static final String KEY_FOREGROUND = "foreground";
    private static final String KEY_LAST_STATE = "last_state";
    private static final String KEY_LAST_HEARTBEAT_AT = "last_heartbeat_at";
    private static final String KEY_LAST_CHECKPOINT = "last_checkpoint";
    private static final String KEY_LAST_RESOURCE_SNAPSHOT = "last_resource_snapshot";
    private static final String KEY_LAST_EXIT_TIMESTAMP = "last_exit_timestamp";
    private static final String KEY_RUN_ID = "run_id";
    private static final String KEY_LAST_MEMORY_EVENT_AT = "last_memory_event_at";
    private static final String KEY_LAST_RESOURCE_PRESSURE_AT = "last_resource_pressure_at";

    static final long UI_STALL_THRESHOLD_MS = 5_000L;
    private static final long HEARTBEAT_INTERVAL_MS = 1_000L;
    private static final long PERSIST_HEARTBEAT_INTERVAL_MS = 15_000L;
    private static final long MEMORY_EVENT_RATE_LIMIT_MS = 60_000L;
    private static final long RESOURCE_PRESSURE_RATE_LIMIT_MS = 15 * 60_000L;
    private static final long LOW_STORAGE_USABLE_BYTES = 512L * 1024L * 1024L;
    private static final int MAX_EXIT_RECORDS_TO_INSPECT = 5;

    private static final Object LOCK = new Object();
    private static Handler mainHandler;
    private static ScheduledExecutorService scheduler;
    private static Context appContext;
    private static volatile boolean foreground;
    private static volatile boolean stallActive;
    private static volatile long lastMainAckElapsed;
    private static volatile long stallStartedElapsed;
    private static volatile long lastPersistedHeartbeatElapsed;
    private static volatile String runId = "";

    private AppExperienceWatchdog() {}

    static void start(Activity activity) {
        if (activity == null) return;
        synchronized (LOCK) {
            if (scheduler != null) return;
            appContext = activity.getApplicationContext();
            mainHandler = new Handler(Looper.getMainLooper());
            SharedPreferences preferences = prefs(appContext);
            reportPreviousInterruptedSession(appContext, preferences);
            reportLatestProcessExit(appContext, preferences);
            runId = UUID.randomUUID().toString();
            preferences.edit()
                .putString(KEY_RUN_ID, runId)
                .putBoolean(KEY_FOREGROUND, false)
                .putString(KEY_LAST_STATE, "created")
                .putLong(KEY_LAST_HEARTBEAT_AT, System.currentTimeMillis())
                .apply();
            lastMainAckElapsed = SystemClock.elapsedRealtime();
            lastPersistedHeartbeatElapsed = lastMainAckElapsed;
            scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "roadsage-ui-watchdog");
                thread.setDaemon(true);
                return thread;
            });
            scheduler.scheduleAtFixedRate(
                AppExperienceWatchdog::watchdogTick,
                HEARTBEAT_INTERVAL_MS,
                HEARTBEAT_INTERVAL_MS,
                TimeUnit.MILLISECONDS
            );
        }
    }

    static void onResume(Context context) {
        ensureContext(context);
        foreground = true;
        stallActive = false;
        lastMainAckElapsed = SystemClock.elapsedRealtime();
        persistLifecycle("resumed", true, true);
        recordResourcePressureIfNeeded();
    }

    static void onPause(Context context) {
        ensureContext(context);
        foreground = false;
        stallActive = false;
        persistLifecycle("paused", false, true);
    }

    static void onDestroy(Context context) {
        ensureContext(context);
        foreground = false;
        persistLifecycle("destroyed", false, false);
    }

    static void onTrimMemory(Context context, int level) {
        ensureContext(context);
        if (appContext == null) return;
        long now = System.currentTimeMillis();
        SharedPreferences preferences = prefs(appContext);
        long lastAt = preferences.getLong(KEY_LAST_MEMORY_EVENT_AT, 0L);
        boolean critical = level == android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL
            || level == android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE;
        boolean memoryPressure = level == android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
            || level == android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL
            || level >= android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND;
        if (!memoryPressure) return;
        if (now - lastAt < MEMORY_EVENT_RATE_LIMIT_MS && !critical) return;
        preferences.edit().putLong(KEY_LAST_MEMORY_EVENT_AT, now).apply();
        JSONObject resources = resourceSnapshot(appContext);
        JSONObject event = baseEvent(
            "android_memory_pressure",
            "Android memory pressure",
            critical ? "Android reported critical memory pressure." : "Android asked Road Sage to reduce memory use."
        );
        put(event, "trim_level", level);
        put(event, "critical", critical);
        copyResourceFields(resources, event);
        addDiagnostic(event);
    }

    static void onLowMemory(Context context) {
        ensureContext(context);
        if (appContext == null) return;
        JSONObject event = baseEvent(
            "android_low_memory",
            "Android low-memory warning",
            "Android reported that available memory was critically low."
        );
        put(event, "critical", true);
        copyResourceFields(resourceSnapshot(appContext), event);
        addDiagnostic(event);
    }

    static void recordOperationCheckpoint(Context context, String operation, String phase, String pathname) {
        ensureContext(context);
        if (appContext == null) return;
        JSONObject checkpoint = checkpointPayload(operation, phase, pathname, System.currentTimeMillis());
        prefs(appContext).edit().putString(KEY_LAST_CHECKPOINT, checkpoint.toString()).apply();
    }

    static JSONObject getSnapshot(Context context) {
        ensureContext(context);
        JSONObject snapshot = resourceSnapshot(appContext != null ? appContext : context);
        SharedPreferences preferences = prefs(appContext != null ? appContext : context);
        put(snapshot, "foreground", foreground);
        put(snapshot, "ui_stall_active", stallActive);
        put(snapshot, "last_main_heartbeat_age_ms", Math.max(0L, SystemClock.elapsedRealtime() - lastMainAckElapsed));
        put(snapshot, "last_state", safeToken(preferences.getString(KEY_LAST_STATE, "unknown"), 40));
        put(snapshot, "last_heartbeat_at", preferences.getLong(KEY_LAST_HEARTBEAT_AT, 0L));
        JSONObject checkpoint = parseObject(preferences.getString(KEY_LAST_CHECKPOINT, ""));
        if (checkpoint != null) put(snapshot, "last_operation", checkpoint);
        return snapshot;
    }

    static void erase(Context context) {
        if (context == null) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
    }

    static boolean shouldReportStall(boolean isForeground, long heartbeatAgeMs, boolean alreadyActive) {
        return isForeground && heartbeatAgeMs >= UI_STALL_THRESHOLD_MS && !alreadyActive;
    }

    static String exitReasonLabel(int reason) {
        switch (reason) {
            case 1: return "exit_self";
            case 2: return "signaled";
            case 3: return "low_memory";
            case 4: return "crash";
            case 5: return "native_crash";
            case 6: return "anr";
            case 7: return "initialization_failure";
            case 8: return "permission_change";
            case 9: return "excessive_resource_usage";
            case 10: return "user_requested";
            case 11: return "user_stopped";
            case 12: return "dependency_died";
            case 13: return "other";
            case 14: return "freezer";
            case 15: return "package_state_change";
            case 16: return "package_updated";
            default: return "unknown";
        }
    }

    static JSONObject checkpointPayload(String operation, String phase, String pathname, long timestampMs) {
        JSONObject checkpoint = new JSONObject();
        put(checkpoint, "operation", safeToken(operation, 140));
        put(checkpoint, "phase", isAllowedPhase(phase) ? phase : "unknown");
        put(checkpoint, "pathname", safePathname(pathname));
        put(checkpoint, "timestamp", Instant.ofEpochMilli(Math.max(0L, timestampMs)).toString());
        return checkpoint;
    }

    private static void watchdogTick() {
        Context context = appContext;
        Handler handler = mainHandler;
        if (context == null || handler == null) return;
        long nowElapsed = SystemClock.elapsedRealtime();
        handler.post(() -> acknowledgeMainThread(SystemClock.elapsedRealtime()));
        long heartbeatAgeMs = Math.max(0L, nowElapsed - lastMainAckElapsed);
        if (shouldReportStall(foreground, heartbeatAgeMs, stallActive)) {
            stallActive = true;
            stallStartedElapsed = lastMainAckElapsed;
            JSONObject event = baseEvent(
                "android_ui_stall",
                "App UI stopped responding",
                "The Android main thread did not answer the watchdog for at least five seconds."
            );
            put(event, "duration_ms", heartbeatAgeMs);
            appendLastCheckpoint(context, event);
            JSONObject resources = resourceSnapshot(context);
            copyResourceFields(resources, event);
            persistResourceSnapshot(resources);
            addDiagnostic(event);
        }
        if (nowElapsed - lastPersistedHeartbeatElapsed >= PERSIST_HEARTBEAT_INTERVAL_MS) {
            lastPersistedHeartbeatElapsed = nowElapsed;
            persistHeartbeat(context);
        }
    }

    private static void acknowledgeMainThread(long acknowledgedAtElapsed) {
        long previousAck = lastMainAckElapsed;
        lastMainAckElapsed = acknowledgedAtElapsed;
        if (!stallActive) return;
        stallActive = false;
        long durationMs = Math.max(0L, acknowledgedAtElapsed - Math.max(0L, stallStartedElapsed));
        JSONObject event = baseEvent(
            "android_ui_stall_recovered",
            "App UI responded again",
            "The Android main thread recovered after a detected stall."
        );
        put(event, "duration_ms", Math.max(durationMs, acknowledgedAtElapsed - previousAck));
        appendLastCheckpoint(appContext, event);
        addDiagnostic(event);
    }

    private static void persistHeartbeat(Context context) {
        JSONObject resources = resourceSnapshot(context);
        prefs(context).edit()
            .putLong(KEY_LAST_HEARTBEAT_AT, System.currentTimeMillis())
            .putBoolean(KEY_FOREGROUND, foreground)
            .putString(KEY_LAST_STATE, foreground ? "resumed" : "background")
            .putString(KEY_LAST_RESOURCE_SNAPSHOT, resources.toString())
            .apply();
    }

    private static void persistLifecycle(String state, boolean isForeground, boolean includeResources) {
        Context context = appContext;
        if (context == null) return;
        SharedPreferences.Editor editor = prefs(context).edit()
            .putBoolean(KEY_FOREGROUND, isForeground)
            .putString(KEY_LAST_STATE, state)
            .putLong(KEY_LAST_HEARTBEAT_AT, System.currentTimeMillis());
        if (includeResources) editor.putString(KEY_LAST_RESOURCE_SNAPSHOT, resourceSnapshot(context).toString());
        editor.apply();
    }

    private static void reportPreviousInterruptedSession(Context context, SharedPreferences preferences) {
        if (!preferences.getBoolean(KEY_FOREGROUND, false)) return;
        String previousRunId = preferences.getString(KEY_RUN_ID, "");
        if (previousRunId == null || previousRunId.trim().isEmpty()) return;
        long heartbeatAt = preferences.getLong(KEY_LAST_HEARTBEAT_AT, 0L);
        JSONObject event = baseEvent(
            "android_previous_session_interrupted",
            "Previous foreground session ended unexpectedly",
            "Road Sage restarted without observing the previous foreground session pause cleanly."
        );
        put(event, "last_heartbeat_age_ms", heartbeatAt > 0L ? Math.max(0L, System.currentTimeMillis() - heartbeatAt) : -1L);
        put(event, "previous_state", safeToken(preferences.getString(KEY_LAST_STATE, "unknown"), 40));
        appendStoredCheckpoint(preferences, event);
        JSONObject resources = parseObject(preferences.getString(KEY_LAST_RESOURCE_SNAPSHOT, ""));
        if (resources != null) copyResourceFields(resources, event);
        addDiagnostic(context, event);
    }

    private static void reportLatestProcessExit(Context context, SharedPreferences preferences) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return;
        try {
            List<ApplicationExitInfo> records = manager.getHistoricalProcessExitReasons(
                context.getPackageName(),
                0,
                MAX_EXIT_RECORDS_TO_INSPECT
            );
            if (records == null || records.isEmpty()) return;
            long lastReported = preferences.getLong(KEY_LAST_EXIT_TIMESTAMP, 0L);
            ApplicationExitInfo newest = null;
            for (ApplicationExitInfo record : records) {
                if (record == null || record.getTimestamp() <= lastReported) continue;
                if (newest == null || record.getTimestamp() > newest.getTimestamp()) newest = record;
            }
            if (newest == null) return;
            preferences.edit().putLong(KEY_LAST_EXIT_TIMESTAMP, newest.getTimestamp()).commit();
            String reasonLabel = exitReasonLabel(newest.getReason());
            JSONObject event = baseEvent(
                "android_process_exit",
                "Previous Android process exit",
                "Android reported that the previous Road Sage process ended: " + reasonLabel.replace('_', ' ') + "."
            );
            put(event, "reason_code", newest.getReason());
            put(event, "reason_label", reasonLabel);
            put(event, "importance", newest.getImportance());
            put(event, "pss_kb", newest.getPss());
            put(event, "rss_kb", newest.getRss());
            put(event, "exit_timestamp", Instant.ofEpochMilli(newest.getTimestamp()).toString());
            appendStoredCheckpoint(preferences, event);
            addDiagnostic(context, event);
        } catch (RuntimeException ignored) {
            // Process exit history is optional diagnostic evidence.
        }
    }

    private static JSONObject resourceSnapshot(Context context) {
        JSONObject snapshot = new JSONObject();
        if (context == null) return snapshot;
        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (activityManager != null) {
            ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
            activityManager.getMemoryInfo(memoryInfo);
            put(snapshot, "memory_available_bytes", memoryInfo.availMem);
            put(snapshot, "memory_total_bytes", Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN ? memoryInfo.totalMem : 0L);
            put(snapshot, "memory_threshold_bytes", memoryInfo.threshold);
            put(snapshot, "memory_low", memoryInfo.lowMemory);
        }
        Runtime runtime = Runtime.getRuntime();
        put(snapshot, "heap_used_bytes", runtime.totalMemory() - runtime.freeMemory());
        put(snapshot, "heap_max_bytes", runtime.maxMemory());
        put(snapshot, "pss_kb", Debug.getPss());
        File files = context.getFilesDir();
        if (files != null) {
            put(snapshot, "storage_usable_bytes", files.getUsableSpace());
            put(snapshot, "storage_free_bytes", files.getFreeSpace());
            put(snapshot, "storage_total_bytes", files.getTotalSpace());
        }
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        int thermalStatus = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && powerManager != null
            ? powerManager.getCurrentThermalStatus()
            : PowerManager.THERMAL_STATUS_NONE;
        put(snapshot, "thermal_status", thermalStatus);
        put(snapshot, "thermal_label", thermalLabel(thermalStatus));
        Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int batteryTempTenthsC = battery != null
            ? battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE)
            : Integer.MIN_VALUE;
        if (batteryTempTenthsC != Integer.MIN_VALUE) {
            put(snapshot, "battery_temperature_c", Math.round((batteryTempTenthsC / 10.0d) * 10.0d) / 10.0d);
        }
        return snapshot;
    }

    private static void recordResourcePressureIfNeeded() {
        Context context = appContext;
        if (context == null) return;
        JSONObject resources = resourceSnapshot(context);
        boolean memoryLow = resources.optBoolean("memory_low", false);
        long storageUsable = resources.optLong("storage_usable_bytes", Long.MAX_VALUE);
        int thermalStatus = resources.optInt("thermal_status", PowerManager.THERMAL_STATUS_NONE);
        boolean storageLow = storageUsable >= 0L && storageUsable < LOW_STORAGE_USABLE_BYTES;
        boolean thermalHigh = thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE;
        if (!memoryLow && !storageLow && !thermalHigh) return;
        SharedPreferences preferences = prefs(context);
        long now = System.currentTimeMillis();
        if (now - preferences.getLong(KEY_LAST_RESOURCE_PRESSURE_AT, 0L) < RESOURCE_PRESSURE_RATE_LIMIT_MS) return;
        preferences.edit().putLong(KEY_LAST_RESOURCE_PRESSURE_AT, now).apply();
        String reason = memoryLow
            ? "Android reports low available memory."
            : storageLow
                ? "Available app storage is below 512 MB."
                : "Android reports elevated thermal pressure.";
        JSONObject event = baseEvent(
            "android_resource_pressure",
            "Android resource pressure",
            reason
        );
        put(event, "memory_low", memoryLow);
        put(event, "storage_low", storageLow);
        put(event, "thermal_high", thermalHigh);
        copyResourceFields(resources, event);
        addDiagnostic(event);
    }

    private static String thermalLabel(int status) {
        switch (status) {
            case PowerManager.THERMAL_STATUS_LIGHT: return "light";
            case PowerManager.THERMAL_STATUS_MODERATE: return "moderate";
            case PowerManager.THERMAL_STATUS_SEVERE: return "severe";
            case PowerManager.THERMAL_STATUS_CRITICAL: return "critical";
            case PowerManager.THERMAL_STATUS_EMERGENCY: return "emergency";
            case PowerManager.THERMAL_STATUS_SHUTDOWN: return "shutdown";
            default: return "none";
        }
    }

    private static void copyResourceFields(JSONObject source, JSONObject target) {
        if (source == null || target == null) return;
        String[] keys = new String[] {
            "memory_available_bytes", "memory_total_bytes", "memory_threshold_bytes", "memory_low",
            "heap_used_bytes", "heap_max_bytes", "pss_kb", "rss_kb",
            "storage_usable_bytes", "storage_free_bytes", "storage_total_bytes",
            "thermal_status", "thermal_label", "battery_temperature_c"
        };
        for (String key : keys) {
            if (source.has(key)) put(target, key, source.opt(key));
        }
    }

    private static void persistResourceSnapshot(JSONObject resources) {
        Context context = appContext;
        if (context == null || resources == null) return;
        prefs(context).edit().putString(KEY_LAST_RESOURCE_SNAPSHOT, resources.toString()).apply();
    }

    private static void appendLastCheckpoint(Context context, JSONObject event) {
        if (context == null || event == null) return;
        appendStoredCheckpoint(prefs(context), event);
    }

    private static void appendStoredCheckpoint(SharedPreferences preferences, JSONObject event) {
        JSONObject checkpoint = parseObject(preferences.getString(KEY_LAST_CHECKPOINT, ""));
        if (checkpoint != null) put(event, "last_operation", checkpoint);
    }

    private static JSONObject baseEvent(String type, String title, String detail) {
        JSONObject event = new JSONObject();
        put(event, "id", "watchdog_" + UUID.randomUUID());
        put(event, "type", type);
        put(event, "title", title);
        put(event, "detail", detail);
        put(event, "timestamp", Instant.now().toString());
        put(event, "source", "android_watchdog");
        return event;
    }

    private static void addDiagnostic(JSONObject event) {
        if (appContext != null) addDiagnostic(appContext, event);
    }

    private static void addDiagnostic(Context context, JSONObject event) {
        if (context == null || event == null) return;
        DriveSenseNativeTripStore.addDiagnosticEvent(context, event);
    }

    private static void ensureContext(Context context) {
        if (appContext == null && context != null) appContext = context.getApplicationContext();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject parseObject(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException ignored) {
            return null;
        }
    }

    private static boolean isAllowedPhase(String phase) {
        return "start".equals(phase) || "success".equals(phase) || "error".equals(phase)
            || "painted".equals(phase) || "cancelled".equals(phase);
    }

    private static String safePathname(String value) {
        if (value == null || !value.startsWith("/")) return "";
        String path = value.split("[?#]", 2)[0];
        String[] parts = path.split("/", -1);
        for (int index = 1; index < parts.length; index++) {
            if ("trips".equals(parts[index - 1])) parts[index] = ":id";
            else parts[index] = safeToken(parts[index], 80);
        }
        return String.join("/", parts).substring(0, Math.min(160, String.join("/", parts).length()));
    }

    private static String safeToken(String value, int maxLength) {
        String safe = String.valueOf(value == null ? "" : value)
            .replaceAll("[^a-zA-Z0-9._:-]", "_");
        return safe.substring(0, Math.min(Math.max(0, maxLength), safe.length()));
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException error) {
            Log.w(TAG, "Could not put", error);
        }
    }
}
