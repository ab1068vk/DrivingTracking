package com.drivesense.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityRecognitionClient;
import com.google.android.gms.location.DetectedActivity;

import java.lang.ref.WeakReference;

@CapacitorPlugin(
    name = "DriveSenseActivityRecognition",
    permissions = {
        @Permission(
            alias = "activityRecognition",
            strings = { Manifest.permission.ACTIVITY_RECOGNITION }
        ),
        @Permission(
            alias = "backgroundLocation",
            strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
        )
    }
)
public class DriveSenseActivityRecognitionPlugin extends Plugin {
    private static WeakReference<DriveSenseActivityRecognitionPlugin> instance;
    private ActivityRecognitionClient activityClient;
    private PendingIntent activityIntent;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        activityClient = ActivityRecognition.getClient(getContext());
        Intent intent = new Intent(getContext(), DriveSenseActivityReceiver.class);
        activityIntent = PendingIntent.getBroadcast(
            getContext(),
            42,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(permissionPayload());
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(permissionPayload());
            return;
        }
        requestPermissionForAlias("activityRecognition", call, "activityPermissionCallback");
    }

    @PluginMethod
    public void requestBackgroundLocation(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(permissionPayload());
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "backgroundLocationPermissionCallback");
    }

    @PermissionCallback
    private void activityPermissionCallback(PluginCall call) {
        call.resolve(permissionPayload());
    }

    @PermissionCallback
    private void backgroundLocationPermissionCallback(PluginCall call) {
        call.resolve(permissionPayload());
    }

    @PluginMethod
    public void start(PluginCall call) {
        int intervalMs = call.getInt("intervalMs", 15000);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            getPermissionState("activityRecognition") != PermissionState.GRANTED) {
            call.reject("ACTIVITY_RECOGNITION permission is not granted.");
            return;
        }

        activityClient.requestActivityUpdates(intervalMs, activityIntent)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage()));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        activityClient.removeActivityUpdates(activityIntent)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage()));
    }

    static void publishActivity(DetectedActivity activity) {
        DriveSenseActivityRecognitionPlugin plugin = instance != null ? instance.get() : null;
        if (plugin == null || activity == null) return;

        JSObject payload = new JSObject();
        payload.put("type", mapType(activity.getType()));
        payload.put("confidence", activity.getConfidence());
        payload.put("timestamp", System.currentTimeMillis());
        plugin.notifyListeners("activityChanged", payload, true);
    }

    private JSObject permissionPayload() {
        JSObject payload = new JSObject();
        payload.put("activityRecognition", permissionString());
        payload.put("backgroundLocation", backgroundPermissionString());
        return payload;
    }

    private String permissionString() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "granted";
        PermissionState state = getPermissionState("activityRecognition");
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private String backgroundPermissionString() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "granted";
        PermissionState state = getPermissionState("backgroundLocation");
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private static String mapType(int type) {
        switch (type) {
            case DetectedActivity.IN_VEHICLE:
                return "in_vehicle";
            case DetectedActivity.ON_BICYCLE:
                return "cycling";
            case DetectedActivity.ON_FOOT:
                return "on_foot";
            case DetectedActivity.RUNNING:
                return "running";
            case DetectedActivity.STILL:
                return "still";
            case DetectedActivity.WALKING:
                return "walking";
            default:
                return "unknown";
        }
    }
}
