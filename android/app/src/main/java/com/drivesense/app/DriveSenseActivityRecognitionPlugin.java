package com.drivesense.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

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

import androidx.core.content.ContextCompat;

import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;

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
    private DriveSenseSpeechController speechController;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        speechController = new DriveSenseSpeechController(getContext());
        activityClient = ActivityRecognition.getClient(getContext());
        Intent intent = new Intent(getContext(), DriveSenseActivityReceiver.class);
        activityIntent = PendingIntent.getBroadcast(
            getContext(),
            42,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (speechController != null) speechController.shutdown();
        super.handleOnDestroy();
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

    @PluginMethod
    public void startNativeAutoTracking(PluginCall call) {
        if (!hasNativeAutoTrackingPermissions()) {
            call.reject("Location, background location, notification, and physical activity permissions are required for native auto tracking.");
            return;
        }

        try {
            DriveSenseAutoTrackingService.start(getContext());
        } catch (Exception error) {
            call.reject(error.getMessage());
            return;
        }
        JSObject payload = new JSObject();
        payload.put("enabled", true);
        payload.put("batteryOptimizationIgnored", isBatteryOptimizationIgnored());
        call.resolve(payload);
    }

    @PluginMethod
    public void startNativeManualTrip(PluginCall call) {
        if (!hasNativeManualTripPermissions()) {
            call.reject("Location, background location, and notification permissions are required for native manual trip alerts.");
            return;
        }

        double startTimeMsValue = call.getData().optDouble("startTimeMs", System.currentTimeMillis());
        long startTimeMs = Double.isFinite(startTimeMsValue)
            ? Math.round(startTimeMsValue)
            : System.currentTimeMillis();
        String tripId = call.getString("tripId", "");
        try {
            DriveSenseAutoTrackingService.startManualTrip(getContext(), startTimeMs, tripId);
        } catch (Exception error) {
            call.reject(error.getMessage());
            return;
        }
        JSObject payload = new JSObject();
        payload.put("enabled", true);
        payload.put("manualTripActive", true);
        payload.put("batteryOptimizationIgnored", isBatteryOptimizationIgnored());
        call.resolve(payload);
    }

    @PluginMethod
    public void discardNativeManualTrip(PluginCall call) {
        boolean keepArmed = Boolean.TRUE.equals(call.getBoolean("keepArmed", false));
        DriveSenseAutoTrackingService.discardManualTrip(getContext(), keepArmed);
        JSObject payload = new JSObject();
        payload.put("enabled", keepArmed && DriveSenseNativeTripStore.isServiceEnabled(getContext()));
        payload.put("manualTripActive", false);
        call.resolve(payload);
    }

    @PluginMethod
    public void endNativeActiveTrip(PluginCall call) {
        boolean keepArmed = Boolean.TRUE.equals(call.getBoolean("keepArmed", false));
        DriveSenseAutoTrackingService.endActiveTrip(getContext(), keepArmed);
        JSObject payload = new JSObject();
        payload.put("enabled", keepArmed && DriveSenseNativeTripStore.isServiceEnabled(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void stopNativeAutoTracking(PluginCall call) {
        DriveSenseAutoTrackingService.stop(getContext());
        JSObject payload = new JSObject();
        payload.put("enabled", false);
        call.resolve(payload);
    }

    @PluginMethod
    public void speakText(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("text is required.");
            return;
        }
        float rate = floatParam(call, "rate", 0.95f, 0.5f, 1.4f);
        float pitch = floatParam(call, "pitch", 1.0f, 0.75f, 1.25f);
        float volume = floatParam(call, "volume", 0.95f, 0.0f, 1.0f);
        boolean interrupt = "flush".equals(call.getString("queueMode", "add")) ||
            Boolean.TRUE.equals(call.getBoolean("interrupt", false));
        if (speechController == null) speechController = new DriveSenseSpeechController(getContext());
        speechController.speak(text, rate, pitch, volume, interrupt, new DriveSenseSpeechController.Callback() {
            @Override
            public void onAccepted() {
                call.resolve();
            }

            @Override
            public void onError(String message) {
                call.reject(message);
            }
        });
    }

    @PluginMethod
    public void stopSpeech(PluginCall call) {
        if (speechController != null) speechController.stop();
        DriveSenseAutoTrackingService.stopSpeech(getContext());
        call.resolve();
    }

    @PluginMethod
    public void openAppLocationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException error) {
            call.reject(error.getMessage());
        }
    }

    private float floatParam(PluginCall call, String key, float fallback, float min, float max) {
        double value = call.getData().optDouble(key, fallback);
        if (Double.isNaN(value) || Double.isInfinite(value)) return fallback;
        return (float) Math.max(min, Math.min(max, value));
    }

    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        Intent intent;
        if (!isBatteryOptimizationIgnored()) {
            intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            getContext().startActivity(intent);
            JSObject payload = new JSObject();
            payload.put("batteryOptimizationIgnored", isBatteryOptimizationIgnored());
            call.resolve(payload);
        } catch (ActivityNotFoundException error) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception fallbackError) {
                call.reject(fallbackError.getMessage());
            }
        }
    }

    @PluginMethod
    public void usageAccessStatus(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("usageAccessGranted", DriveSensePhoneUsageTracker.hasUsageAccess(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void openUsageAccessSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            JSObject payload = new JSObject();
            payload.put("usageAccessGranted", DriveSensePhoneUsageTracker.hasUsageAccess(getContext()));
            call.resolve(payload);
        } catch (ActivityNotFoundException error) {
            try {
                Intent fallback = new Intent(Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception fallbackError) {
                call.reject(fallbackError.getMessage());
            }
        }
    }

    @PluginMethod
    public void getPhoneUsageSummary(PluginCall call) {
        Double startMsValue = call.getDouble("startMs");
        Double endMsValue = call.getDouble("endMs");
        if (startMsValue == null || endMsValue == null) {
            call.reject("startMs and endMs are required.");
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(DriveSensePhoneUsageTracker.queryTripUsage(
                getContext(),
                startMsValue.longValue(),
                endMsValue.longValue()
            )));
        } catch (JSONException error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void batteryOptimizationStatus(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("batteryOptimizationIgnored", isBatteryOptimizationIgnored());
        call.resolve(payload);
    }

    @PluginMethod
    public void nativeAutoTrackingStatus(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("enabled", DriveSenseNativeTripStore.isServiceEnabled(getContext()));
        payload.put("completedTripsCount", DriveSenseNativeTripStore.getCompletedTrips(getContext()).length());
        payload.put("diagnosticEventsCount", DriveSenseNativeTripStore.getDiagnosticEvents(getContext()).length());
        call.resolve(payload);
    }

    @PluginMethod
    public void getNativeDiagnostics(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("enabled", DriveSenseNativeTripStore.isServiceEnabled(getContext()));
        payload.put("events", DriveSenseNativeTripStore.getDiagnosticEvents(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void clearNativeDiagnostics(PluginCall call) {
        DriveSenseNativeTripStore.clearDiagnosticEvents(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getNativeCompletedTrips(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("trips", DriveSenseNativeTripStore.getCompletedTrips(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void clearNativeCompletedTrips(PluginCall call) {
        DriveSenseNativeTripStore.clearCompletedTrips(getContext());
        call.resolve();
    }

    @PluginMethod
    public void encryptSensitivePayload(PluginCall call) {
        String plaintext = call.getString("plaintext");
        String context = call.getString("context", "drivesense");
        if (plaintext == null) {
            call.reject("plaintext is required.");
            return;
        }
        try {
            JSObject payload = new JSObject();
            payload.put("ciphertext", DriveSensePayloadCrypto.encrypt(plaintext, context));
            call.resolve(payload);
        } catch (Exception error) {
            call.reject("Sensitive payload encryption failed.", error);
        }
    }

    @PluginMethod
    public void decryptSensitivePayload(PluginCall call) {
        String ciphertext = call.getString("ciphertext");
        String context = call.getString("context", "drivesense");
        if (ciphertext == null) {
            call.reject("ciphertext is required.");
            return;
        }
        try {
            JSObject payload = new JSObject();
            payload.put("plaintext", DriveSensePayloadCrypto.decrypt(ciphertext, context));
            call.resolve(payload);
        } catch (Exception error) {
            call.reject("Sensitive payload decryption failed.", error);
        }
    }

    @PluginMethod
    public void saveExportToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String data = call.getString("data");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        boolean isBase64 = Boolean.TRUE.equals(call.getBoolean("base64", false));
        if (filename == null || filename.trim().isEmpty()) {
            call.reject("filename is required.");
            return;
        }
        if (data == null) {
            call.reject("data is required.");
            return;
        }

        try {
            byte[] bytes = isBase64 ? Base64.decode(data, Base64.DEFAULT) : data.getBytes(StandardCharsets.UTF_8);
            JSObject payload = saveDownload(filename, bytes, mimeType);
            call.resolve(payload);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void openExportLocation(PluginCall call) {
        String uriString = call.getString("uri");
        String mimeType = call.getString("mimeType", "*/*");

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (uriString != null && !uriString.trim().isEmpty()) {
                intent.setDataAndType(Uri.parse(uriString), mimeType);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                intent.setData(Uri.parse("content://com.android.providers.downloads.documents/root/downloads"));
            }
            getContext().startActivity(intent);
            JSObject payload = new JSObject();
            payload.put("opened", true);
            call.resolve(payload);
        } catch (ActivityNotFoundException error) {
            try {
                Intent fallback = new Intent(Intent.ACTION_VIEW);
                fallback.setData(Uri.parse("content://com.android.externalstorage.documents/root/primary"));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                JSObject payload = new JSObject();
                payload.put("opened", true);
                call.resolve(payload);
            } catch (Exception fallbackError) {
                call.reject("No app is available to open the exported file or Downloads folder.", fallbackError);
            }
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
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

    private boolean hasNativeAutoTrackingPermissions() {
        boolean fineLocation = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean backgroundLocation = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean activity = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
        boolean notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return fineLocation && backgroundLocation && activity && notifications;
    }

    private boolean hasNativeManualTripPermissions() {
        boolean fineLocation = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean backgroundLocation = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return fineLocation && backgroundLocation && notifications;
    }

    private boolean isBatteryOptimizationIgnored() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return powerManager != null && powerManager.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private JSObject saveDownload(String filename, byte[] data, String mimeType) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveDownloadWithMediaStore(filename, data, mimeType);
        }
        return saveDownloadWithPublicFile(filename, data);
    }

    private JSObject saveDownloadWithMediaStore(String filename, byte[] data, String mimeType) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("Unable to create Downloads file.");

        try (OutputStream output = resolver.openOutputStream(uri)) {
            if (output == null) throw new Exception("Unable to open Downloads file.");
            output.write(data);
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            throw error;
        }

        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, values, null, null);

        JSObject payload = new JSObject();
        payload.put("uri", uri.toString());
        payload.put("filename", filename);
        return payload;
    }

    private JSObject saveDownloadWithPublicFile(String filename, byte[] data) throws Exception {
        File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!downloadsDir.exists() && !downloadsDir.mkdirs()) {
            throw new Exception("Unable to open Downloads folder.");
        }

        File file = new File(downloadsDir, filename);
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(data);
        }

        JSObject payload = new JSObject();
        payload.put("uri", Uri.fromFile(file).toString());
        payload.put("filename", filename);
        return payload;
    }

    private static String mapType(int type) {
        switch (type) {
            case DetectedActivity.IN_VEHICLE:
                return "in_vehicle";
            case DetectedActivity.ON_BICYCLE:
                return "on_bicycle";
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
