package com.drivesense.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/**
 * Relaunches {@link DriveSenseAutoTrackingService} after the process is killed without an
 * explicit stop (OEM battery managers, task swipe, low-memory kill). Boot recovery is handled
 * separately by {@link DriveSenseBootReceiver}; this covers everything short of a reboot.
 *
 * <p>Recovery is layered because Android 12+ forbids starting a foreground service from the
 * background outside a documented exemption:
 * <ol>
 *   <li>the service's own {@code onTaskRemoved}, which is exempt because an FGS is still running;
 *   <li>an alarm/job check that attempts a direct restart and is expected to fail sometimes;
 *   <li>a tap-to-resume notification, which is always legal because a user tap is an exemption.
 * </ol>
 */
public final class DriveSenseTrackingWatchdog extends BroadcastReceiver {
    static final String ACTION_CHECK = "com.drivesense.app.action.TRACKING_WATCHDOG_CHECK";
    private static final int ALARM_REQUEST_ID = 46_071;
    private static final int JOB_ID = 46_072;
    private static final int RESUME_REQUEST_ID = 46_073;
    private static final int NOTIF_ID_RECOVERY = 4105;
    private static final String RECOVERY_CHANNEL_ID = "drivesense_tracking_recovery";
    private static final long IMMEDIATE_CHECK_DELAY_MS = 5_000L;
    // JobScheduler clamps periodic jobs to 15 minutes; asking for less silently gets rounded up.
    private static final long PERIODIC_CHECK_INTERVAL_MS = 15 * 60_000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null || !ACTION_CHECK.equals(intent.getAction())) return;
        checkAndRecover(context.getApplicationContext());
    }

    /** Arms the periodic backstop. Safe to call repeatedly; the job is replaced, not stacked. */
    static void armPeriodicCheck(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        ComponentName target = new ComponentName(context, DriveSenseTrackingWatchdogJobService.class);
        JobInfo job = new JobInfo.Builder(JOB_ID, target)
            .setPeriodic(PERIODIC_CHECK_INTERVAL_MS)
            .setPersisted(true)
            .setRequiresDeviceIdle(false)
            .setRequiresCharging(false)
            .build();
        try {
            scheduler.schedule(job);
        } catch (Exception ignored) {
            // Scheduling limits vary by OEM; the alarm and notification paths still apply.
        }
    }

    /** Schedules a near-term one-shot check, used when we know tracking was just interrupted. */
    static void scheduleImmediateCheck(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        long triggerAt = System.currentTimeMillis() + IMMEDIATE_CHECK_DELAY_MS;
        PendingIntent alarm = alarmIntent(context);
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarm);
            } else {
                // Exact alarms are reserved for calendar/alarm-clock apps on Android 12+ and
                // requesting SCHEDULE_EXACT_ALARM for a tracking watchdog would not be approved.
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarm);
            }
        } catch (Exception ignored) {
            // Fall through: the periodic job and the notification remain available.
        }
    }

    /** Called when the service is torn down without an explicit stop. */
    static void onTrackingInterrupted(Context context) {
        Context app = context.getApplicationContext();
        scheduleImmediateCheck(app);
        // An inexact alarm can be deferred for a long time in Doze, so offer the user a way
        // back immediately rather than leaving tracking silently dead.
        postResumeNotification(app);
    }

    /** Clears every recovery path. Called on an explicit user stop. */
    static void cancel(Context context) {
        Context app = context.getApplicationContext();
        AlarmManager manager = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) manager.cancel(alarmIntent(app));
        JobScheduler scheduler = (JobScheduler) app.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) scheduler.cancel(JOB_ID);
        clearResumeNotification(app);
    }

    static void checkAndRecover(Context context) {
        Context app = context.getApplicationContext();
        if (!DriveSenseNativeTripStore.isServiceEnabled(app)) {
            // The user turned tracking off; the watchdog must not resurrect it.
            cancel(app);
            return;
        }
        if (DriveSenseAutoTrackingService.isRunning()) {
            clearResumeNotification(app);
            return;
        }
        if (attemptForegroundRestart(app)) {
            clearResumeNotification(app);
            return;
        }
        postResumeNotification(app);
    }

    private static boolean attemptForegroundRestart(Context context) {
        try {
            Intent intent = new Intent(context, DriveSenseAutoTrackingService.class)
                .setAction(DriveSenseAutoTrackingService.ACTION_START);
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (Exception ignored) {
            // ForegroundServiceStartNotAllowedException on Android 12+ is the expected outcome
            // when the app has been backgrounded; the notification path below is the fallback.
            return false;
        }
    }

    private static void postResumeNotification(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureRecoveryChannel(context);

        Intent resume = new Intent(context, DriveSenseAutoTrackingService.class)
            .setAction(DriveSenseAutoTrackingService.ACTION_START);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // Starting the foreground service from a notification tap is always permitted.
        PendingIntent resumeIntent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? PendingIntent.getForegroundService(context, RESUME_REQUEST_ID, resume, flags)
            : PendingIntent.getService(context, RESUME_REQUEST_ID, resume, flags);

        String message = "Tracking was stopped by the system. Tap to resume trip tracking.";
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, RECOVERY_CHANNEL_ID)
            .setSmallIcon(context.getResources().getIdentifier("ic_stat_drivesense", "drawable", context.getPackageName()))
            .setContentTitle("Road Sage tracking paused")
            .setContentText(message)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(resumeIntent);

        try {
            NotificationManagerCompat.from(context).notify(NOTIF_ID_RECOVERY, builder.build());
        } catch (Exception ignored) {
            // Notification delivery is best-effort; never crash the recovery path.
        }
    }

    private static void clearResumeNotification(Context context) {
        try {
            NotificationManagerCompat.from(context).cancel(NOTIF_ID_RECOVERY);
        } catch (Exception ignored) {
            // Nothing to clean up if the notification was never posted.
        }
    }

    private static void ensureRecoveryChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            RECOVERY_CHANNEL_ID,
            "Tracking Recovery",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Tells you when trip tracking was stopped by the system.");
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, DriveSenseTrackingWatchdog.class).setAction(ACTION_CHECK);
        return PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
