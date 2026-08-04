package com.drivesense.app;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.os.Build;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import android.util.Log;

class DriveSensePhoneUsageTracker {
    private static final String TAG = "PhoneUsageTracker";
    private static final long MIN_SESSION_MS = 5_000L;
    private static final long MERGE_GAP_MS = 10_000L;
    private static final long MAX_SESSION_MS = 30 * 60_000L;
    private static final long SCREEN_CONTEXT_WINDOW_MS = 10_000L;

    static boolean hasUsageAccess(Context context) {
        AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return false;
        int mode;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            mode = appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.getPackageName()
            );
        } else {
            mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.getPackageName()
            );
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    static JSONObject queryTripUsage(Context context, long startMs, long endMs) {
        JSONObject result = emptyResult(false);
        if (endMs <= startMs || !hasUsageAccess(context)) return result;

        UsageStatsManager usageStats = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usageStats == null) return result;

        JSONArray sessions = new JSONArray();
        String activePackage = null;
        long activeStartMs = 0L;
        long lastClosedEndMs = 0L;
        long lastScreenInteractiveMs = 0L;
        long lastUnlockMs = 0L;
        boolean activeStartedAfterScreenOn = false;
        boolean activeStartedAfterUnlock = false;
        String ownPackage = context.getPackageName();

        UsageEvents usageEvents = usageStats.queryEvents(startMs, endMs);
        UsageEvents.Event event = new UsageEvents.Event();
        while (usageEvents != null && usageEvents.hasNextEvent()) {
            usageEvents.getNextEvent(event);
            int type = event.getEventType();
            long eventMs = event.getTimeStamp();
            if (isScreenInteractiveEvent(type)) {
                lastScreenInteractiveMs = eventMs;
                if (type == UsageEvents.Event.KEYGUARD_HIDDEN) {
                    lastUnlockMs = eventMs;
                }
                continue;
            }
            if (isScreenInteractionEndedEvent(type)) {
                if (activePackage != null) {
                    lastClosedEndMs = appendSession(
                        sessions,
                        activePackage,
                        activeStartMs,
                        eventMs,
                        lastClosedEndMs,
                        activeStartedAfterScreenOn,
                        activeStartedAfterUnlock
                    );
                    activePackage = null;
                    activeStartMs = 0L;
                    activeStartedAfterScreenOn = false;
                    activeStartedAfterUnlock = false;
                }
                lastScreenInteractiveMs = 0L;
                lastUnlockMs = 0L;
                continue;
            }

            String packageName = event.getPackageName();
            if (isIgnoredPackage(packageName, ownPackage)) continue;

            if (isForegroundEvent(type)) {
                if (activePackage != null && !activePackage.equals(packageName)) {
                    lastClosedEndMs = appendSession(
                        sessions,
                        activePackage,
                        activeStartMs,
                        eventMs,
                        lastClosedEndMs,
                        activeStartedAfterScreenOn,
                        activeStartedAfterUnlock
                    );
                }
                if (!packageName.equals(activePackage)) {
                    activePackage = packageName;
                    activeStartMs = eventMs;
                    activeStartedAfterScreenOn = isWithinContextWindow(eventMs, lastScreenInteractiveMs);
                    activeStartedAfterUnlock = isWithinContextWindow(eventMs, lastUnlockMs);
                }
            } else if (isBackgroundEvent(type) && activePackage != null && activePackage.equals(packageName)) {
                lastClosedEndMs = appendSession(
                    sessions,
                    activePackage,
                    activeStartMs,
                    eventMs,
                    lastClosedEndMs,
                    activeStartedAfterScreenOn,
                    activeStartedAfterUnlock
                );
                activePackage = null;
                activeStartMs = 0L;
                activeStartedAfterScreenOn = false;
                activeStartedAfterUnlock = false;
            }
        }

        if (activePackage != null) {
            appendSession(
                sessions,
                activePackage,
                activeStartMs,
                endMs,
                lastClosedEndMs,
                activeStartedAfterScreenOn,
                activeStartedAfterUnlock
            );
        }

        long totalSeconds = 0L;
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session == null) continue;
            totalSeconds += session.optLong("duration_seconds", 0L);
            // Package identity is needed only while merging/filtering foreground
            // sessions. It must not enter the completed-trip journal.
            session.remove("package_name");
        }

        try {
            result.put("usage_access_granted", true);
            result.put("events", sessions);
            result.put("event_count", sessions.length());
            result.put("total_seconds", totalSeconds);
            result.put("package_filter_applied", true);
        } catch (JSONException error) {
            Log.w(TAG, "Could not query trip usage", error);
        }
        return result;
    }

    private static JSONObject emptyResult(boolean granted) {
        JSONObject result = new JSONObject();
        try {
            result.put("usage_access_granted", granted);
            result.put("events", new JSONArray());
            result.put("event_count", 0);
            result.put("total_seconds", 0);
        } catch (JSONException error) {
            Log.w(TAG, "Could not empty result", error);
        }
        return result;
    }

    private static boolean isForegroundEvent(int type) {
        return type == UsageEvents.Event.MOVE_TO_FOREGROUND ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && type == UsageEvents.Event.ACTIVITY_RESUMED);
    }

    private static boolean isBackgroundEvent(int type) {
        return type == UsageEvents.Event.MOVE_TO_BACKGROUND ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && (
                type == UsageEvents.Event.ACTIVITY_PAUSED ||
                type == UsageEvents.Event.ACTIVITY_STOPPED
            ));
    }

    private static boolean isScreenInteractionEndedEvent(int type) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && (
            type == UsageEvents.Event.SCREEN_NON_INTERACTIVE ||
            type == UsageEvents.Event.KEYGUARD_SHOWN
        );
    }

    private static boolean isScreenInteractiveEvent(int type) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && (
            type == UsageEvents.Event.SCREEN_INTERACTIVE ||
            type == UsageEvents.Event.KEYGUARD_HIDDEN
        );
    }

    private static boolean isWithinContextWindow(long eventMs, long contextMs) {
        return contextMs > 0L &&
            eventMs >= contextMs &&
            eventMs - contextMs <= SCREEN_CONTEXT_WINDOW_MS;
    }

    private static boolean isIgnoredPackage(String packageName, String ownPackage) {
        if (packageName == null || packageName.equals(ownPackage)) return true;
        return packageName.equals("android") ||
            packageName.startsWith("com.android.systemui") ||
            packageName.startsWith("com.android.launcher") ||
            packageName.startsWith("com.android.settings") ||
            packageName.startsWith("com.android.permissioncontroller") ||
            packageName.startsWith("com.android.inputmethod") ||
            packageName.startsWith("com.android.providers") ||
            packageName.startsWith("com.android.phone") ||
            packageName.startsWith("com.android.server.telecom") ||
            packageName.equals("com.google.android.apps.maps") ||
            packageName.equals("com.google.android.projection.gearhead") ||
            packageName.equals("com.google.android.apps.youtube.music") ||
            packageName.equals("com.google.android.googlequicksearchbox") ||
            packageName.equals("com.spotify.music") ||
            packageName.equals("com.waze") ||
            packageName.toLowerCase().contains("launcher") ||
            packageName.toLowerCase().contains("keyboard") ||
            packageName.toLowerCase().contains("inputmethod");
    }

    private static long appendSession(
        JSONArray sessions,
        String packageName,
        long startMs,
        long endMs,
        long lastClosedEndMs,
        boolean startedAfterScreenOn,
        boolean startedAfterUnlock
    ) {
        long durationMs = Math.min(Math.max(0L, endMs - startMs), MAX_SESSION_MS);
        if (durationMs < MIN_SESSION_MS) return lastClosedEndMs;
        long effectiveEndMs = startMs + durationMs;

        JSONObject previous = sessions.length() > 0 ? sessions.optJSONObject(sessions.length() - 1) : null;
        if (previous != null && packageName.equals(previous.optString("package_name")) && startMs - lastClosedEndMs <= MERGE_GAP_MS) {
            long previousStartMs = previous.optLong("start_ms", startMs);
            long mergedDurationMs = Math.min(MAX_SESSION_MS, Math.max(0L, effectiveEndMs - previousStartMs));
            long mergedEndMs = previousStartMs + mergedDurationMs;
            long mergedDurationSeconds = Math.max(1L, mergedDurationMs / 1000L);
            try {
                previous.put("end_ms", mergedEndMs);
                previous.put("end_time", DriveSenseAutoTrackingService.iso(mergedEndMs));
                previous.put("duration_seconds", mergedDurationSeconds);
                previous.put(
                    "started_after_screen_on",
                    previous.optBoolean("started_after_screen_on", false) || startedAfterScreenOn
                );
                previous.put(
                    "started_after_unlock",
                    previous.optBoolean("started_after_unlock", false) || startedAfterUnlock
                );
            } catch (JSONException error) {
                Log.w(TAG, "Could not is ignored package", error);
            }
            return mergedEndMs;
        }

        JSONObject session = new JSONObject();
        try {
            session.put("package_name", packageName);
            session.put("start_ms", startMs);
            session.put("end_ms", effectiveEndMs);
            session.put("start_time", DriveSenseAutoTrackingService.iso(startMs));
            session.put("end_time", DriveSenseAutoTrackingService.iso(effectiveEndMs));
            session.put("duration_seconds", Math.max(1L, durationMs / 1000L));
            session.put("started_after_screen_on", startedAfterScreenOn);
            session.put("started_after_unlock", startedAfterUnlock);
            session.put("source", "android_usage_access");
        } catch (JSONException error) {
            Log.w(TAG, "Could not is ignored package", error);
        }
        sessions.put(session);
        return effectiveEndMs;
    }
}
