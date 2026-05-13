package com.drivesense.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.google.android.gms.location.ActivityRecognitionResult;
import com.google.android.gms.location.DetectedActivity;

public class DriveSenseActivityReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ActivityRecognitionResult.hasResult(intent)) return;
        ActivityRecognitionResult result = ActivityRecognitionResult.extractResult(intent);
        if (result == null) return;
        DetectedActivity activity = result.getMostProbableActivity();
        DriveSenseAutoTrackingService.handleActivityBroadcast(context, activity);
        DriveSenseActivityRecognitionPlugin.publishActivity(activity);
    }
}
