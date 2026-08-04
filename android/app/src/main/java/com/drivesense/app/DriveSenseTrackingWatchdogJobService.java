package com.drivesense.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * Periodic backstop for {@link DriveSenseTrackingWatchdog}. Catches the case where the process
 * died without {@code onTaskRemoved} running at all (low-memory kill, force-stop by an OEM
 * cleaner), which leaves no in-process opportunity to schedule the immediate alarm.
 */
public class DriveSenseTrackingWatchdogJobService extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        // The check only reads SharedPreferences and a process-local flag, so it is cheap
        // enough to run inline; no work remains once it returns.
        try {
            DriveSenseTrackingWatchdog.checkAndRecover(getApplicationContext());
        } catch (Exception ignored) {
            // A watchdog must never crash the app it is protecting.
        }
        jobFinished(params, false);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
