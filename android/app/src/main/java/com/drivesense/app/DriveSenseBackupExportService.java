package com.drivesense.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class DriveSenseBackupExportService extends Service {
    static final String ACTION_START = "com.drivesense.app.action.START_BACKUP_EXPORT";
    static final String ACTION_UPDATE = "com.drivesense.app.action.UPDATE_BACKUP_EXPORT";
    static final String ACTION_COMPLETE = "com.drivesense.app.action.COMPLETE_BACKUP_EXPORT";
    static final String ACTION_FAIL = "com.drivesense.app.action.FAIL_BACKUP_EXPORT";
    static final String ACTION_CANCEL_FROM_APP = "com.drivesense.app.action.CANCEL_BACKUP_EXPORT_FROM_APP";
    static final String ACTION_CANCEL_FROM_NOTIFICATION = "com.drivesense.app.action.CANCEL_BACKUP_EXPORT_FROM_NOTIFICATION";
    static final String EXTRA_TASK_ID = "taskId";
    static final String EXTRA_PROGRESS = "progress";
    static final String EXTRA_LABEL = "label";
    static final String EXTRA_FILENAME = "filename";

    private static final String CHANNEL_ID = "roadsage_backup_export";
    private static final int NOTIFICATION_ID = 4301;
    private static final Set<String> CANCELLED_TASKS = ConcurrentHashMap.newKeySet();
    private static final Set<String> ACTIVE_TASKS = ConcurrentHashMap.newKeySet();

    private String activeTaskId;
    private int activeProgress;
    private String activeLabel = "Preparing backup";

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        String taskId = intent != null ? intent.getStringExtra(EXTRA_TASK_ID) : null;

        if (ACTION_START.equals(action)) {
            activeTaskId = taskId;
            activeProgress = clampProgress(intent.getIntExtra(EXTRA_PROGRESS, 0));
            activeLabel = safeLabel(intent.getStringExtra(EXTRA_LABEL), "Preparing backup");
            if (activeTaskId != null) {
                CANCELLED_TASKS.remove(activeTaskId);
                ACTIVE_TASKS.add(activeTaskId);
            }
            startAsForeground(buildProgressNotification());
            return START_NOT_STICKY;
        }

        if (taskId == null || activeTaskId == null || !activeTaskId.equals(taskId)) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        if (ACTION_UPDATE.equals(action)) {
            activeProgress = clampProgress(intent.getIntExtra(EXTRA_PROGRESS, activeProgress));
            activeLabel = safeLabel(intent.getStringExtra(EXTRA_LABEL), activeLabel);
            notifyProgress();
        } else if (ACTION_COMPLETE.equals(action)) {
            String filename = safeLabel(intent.getStringExtra(EXTRA_FILENAME), "Road Sage backup");
            showFinishedNotification("Backup saved", filename + " was saved to Downloads.");
            finishAndStop(taskId);
        } else if (ACTION_FAIL.equals(action)) {
            showFinishedNotification("Backup could not be saved", safeLabel(intent.getStringExtra(EXTRA_LABEL), "Open Road Sage and try again."));
            finishAndStop(taskId);
        } else if (ACTION_CANCEL_FROM_NOTIFICATION.equals(action)) {
            CANCELLED_TASKS.add(taskId);
            DriveSenseActivityRecognitionPlugin.publishBackupExportCancellation(taskId);
            DriveSenseActivityRecognitionPlugin.cancelAllPendingExports(this);
            clearAndStop(taskId);
        } else if (ACTION_CANCEL_FROM_APP.equals(action)) {
            DriveSenseActivityRecognitionPlugin.cancelAllPendingExports(this);
            clearAndStop(taskId);
        }
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onTimeout(int startId, int foregroundServiceType) {
        String taskId = activeTaskId;
        if (taskId != null) {
            CANCELLED_TASKS.add(taskId);
            DriveSenseActivityRecognitionPlugin.publishBackupExportCancellation(taskId);
            DriveSenseActivityRecognitionPlugin.cancelAllPendingExports(this);
            clearAndStop(taskId);
        } else {
            stopSelf(startId);
        }
    }

    static void start(Context context, String taskId, int progress, String label) {
        Intent intent = taskIntent(context, ACTION_START, taskId);
        intent.putExtra(EXTRA_PROGRESS, clampProgress(progress));
        intent.putExtra(EXTRA_LABEL, label);
        ContextCompat.startForegroundService(context, intent);
    }

    static void update(Context context, String taskId, int progress, String label) {
        Intent intent = taskIntent(context, ACTION_UPDATE, taskId);
        intent.putExtra(EXTRA_PROGRESS, clampProgress(progress));
        intent.putExtra(EXTRA_LABEL, label);
        context.startService(intent);
    }

    static void complete(Context context, String taskId, String filename) {
        Intent intent = taskIntent(context, ACTION_COMPLETE, taskId);
        intent.putExtra(EXTRA_FILENAME, filename);
        context.startService(intent);
    }

    static void fail(Context context, String taskId, String message) {
        Intent intent = taskIntent(context, ACTION_FAIL, taskId);
        intent.putExtra(EXTRA_LABEL, message);
        context.startService(intent);
    }

    static void cancelFromApp(Context context, String taskId) {
        context.startService(taskIntent(context, ACTION_CANCEL_FROM_APP, taskId));
    }

    static boolean isCancelled(String taskId) {
        return taskId != null && CANCELLED_TASKS.contains(taskId);
    }

    static boolean hasActiveTask() {
        return !ACTIVE_TASKS.isEmpty();
    }

    static void clearCancellation(String taskId) {
        if (taskId != null) CANCELLED_TASKS.remove(taskId);
    }

    private static Intent taskIntent(Context context, String action, String taskId) {
        Intent intent = new Intent(context, DriveSenseBackupExportService.class);
        intent.setAction(action);
        intent.putExtra(EXTRA_TASK_ID, taskId);
        return intent;
    }

    private Notification buildProgressNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            4302,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        Intent cancelIntent = taskIntent(this, ACTION_CANCEL_FROM_NOTIFICATION, activeTaskId);
        PendingIntent cancelPendingIntent = PendingIntent.getService(
            this,
            4303,
            cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_drivesense)
            .setContentTitle("Exporting Road Sage backup")
            .setContentText(activeLabel)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(activeLabel + " You can use other apps while this continues."))
            .setProgress(100, activeProgress, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openPendingIntent)
            .addAction(0, "Cancel", cancelPendingIntent)
            .build();
    }

    private void startAsForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void notifyProgress() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildProgressNotification());
    }

    private void showFinishedNotification(String title, String body) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_drivesense)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, notification);
    }

    private void clearAndStop(String taskId) {
        if (taskId != null) ACTIVE_TASKS.remove(taskId);
        activeTaskId = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void finishAndStop(String taskId) {
        clearCancellation(taskId);
        if (taskId != null) ACTIVE_TASKS.remove(taskId);
        activeTaskId = null;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (activeTaskId != null) {
            ACTIVE_TASKS.remove(activeTaskId);
            DriveSenseActivityRecognitionPlugin.cancelAllPendingExports(this);
        }
        super.onDestroy();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Backup exports",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows progress while a Road Sage backup is exported.");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private static int clampProgress(int value) {
        return Math.max(0, Math.min(100, value));
    }

    private static String safeLabel(String value, String fallback) {
        String clean = value == null ? "" : value.trim();
        if (clean.isEmpty()) return fallback;
        return clean.length() > 160 ? clean.substring(0, 160) : clean;
    }

    private static int immutableFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
    }
}
