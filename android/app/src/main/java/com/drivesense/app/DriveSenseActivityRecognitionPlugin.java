package com.drivesense.app;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
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
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityRecognitionClient;
import com.google.android.gms.location.DetectedActivity;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.activity.result.ActivityResult;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

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
        ),
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        )
    }
)
public class DriveSenseActivityRecognitionPlugin extends Plugin {
    private static WeakReference<DriveSenseActivityRecognitionPlugin> instance;
    private ActivityRecognitionClient activityClient;
    private PendingIntent activityIntent;
    private DriveSenseSpeechController speechController;
    private File pendingParkingPhotoFile;
    private static final Map<String, PendingExport> pendingExports = new ConcurrentHashMap<>();

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
        if (!DriveSenseBackupExportService.hasActiveTask()) cancelAllPendingExports(getContext());
        super.handleOnDestroy();
    }

    static void publishBackupExportCancellation(String taskId) {
        DriveSenseActivityRecognitionPlugin plugin = instance != null ? instance.get() : null;
        if (plugin == null) return;
        JSObject payload = new JSObject();
        payload.put("taskId", taskId);
        plugin.notifyListeners("backupExportCancelled", payload, true);
    }

    static void cancelAllPendingExports(Context context) {
        for (String exportId : pendingExports.keySet()) {
            PendingExport pending = pendingExports.remove(exportId);
            if (pending != null) pending.delete(context);
        }
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

        if (!DriveSenseAutoTrackingService.start(getContext())) {
            call.reject("Android did not allow background tracking to start.");
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
    public void captureParkingPhoto(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        launchParkingCamera(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is required to take a parking photo.");
            return;
        }
        launchParkingCamera(call);
    }

    private void launchParkingCamera(PluginCall call) {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("No camera app is available on this device.");
            return;
        }
        try {
            File captureDirectory = new File(getContext().getCacheDir(), "parking_camera");
            if (!captureDirectory.exists() && !captureDirectory.mkdirs()) {
                call.reject("The parking camera cache could not be prepared.");
                return;
            }
            pendingParkingPhotoFile = new File(captureDirectory, UUID.randomUUID() + ".jpg");
            Uri outputUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                pendingParkingPhotoFile
            );
            intent.putExtra(MediaStore.EXTRA_OUTPUT, outputUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception error) {
            call.reject("The parking camera could not be prepared.", error);
            return;
        }
        startActivityForResult(call, intent, "parkingPhotoCaptured");
    }

    @ActivityCallback
    private void parkingPhotoCaptured(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            deletePendingParkingCapture();
            JSObject payload = new JSObject();
            payload.put("cancelled", true);
            call.resolve(payload);
            return;
        }

        Bitmap captured = pendingParkingPhotoFile != null
            ? decodeScaledBitmap(pendingParkingPhotoFile, 1280)
            : null;
        if (captured == null) {
            Intent data = result.getData();
            Object thumbnail = data != null && data.getExtras() != null
                ? data.getExtras().get("data")
                : null;
            if (thumbnail instanceof Bitmap) captured = (Bitmap) thumbnail;
        }
        if (captured == null) {
            deletePendingParkingCapture();
            call.reject("The camera did not return a parking photo.");
            return;
        }

        try {
            call.resolve(storeParkingPhotoBitmap(captured));
        } catch (Exception error) {
            call.reject("The parking photo could not be prepared.", error);
        } finally {
            deletePendingParkingCapture();
        }
    }

    @PluginMethod
    public void storeParkingPhoto(PluginCall call) {
        String dataUrl = call.getString("dataUrl", "");
        int separator = dataUrl.indexOf(',');
        if (!dataUrl.startsWith("data:image/") || separator < 0 || dataUrl.length() > 8_000_000) {
            call.reject("A valid parking photo is required.");
            return;
        }
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(separator + 1), Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) throw new IllegalArgumentException("The parking photo could not be decoded.");
            call.resolve(storeParkingPhotoBitmap(scaleBitmap(bitmap, 1280)));
        } catch (Exception error) {
            call.reject("The parking photo could not be stored.", error);
        }
    }

    @PluginMethod
    public void readParkingPhoto(PluginCall call) {
        String photoId = safeParkingPhotoId(call.getString("photoId", ""));
        if (photoId == null) {
            call.reject("A valid parking photo id is required.");
            return;
        }
        File file = parkingPhotoFile(photoId);
        if (!file.isFile()) {
            call.reject("The parking photo is no longer available.");
            return;
        }
        try {
            String stored = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            JSObject payload = new JSObject();
            payload.put("dataUrl", DriveSensePayloadCrypto.decryptStoredValue(stored, "native:parking_photo:" + photoId));
            call.resolve(payload);
        } catch (Exception error) {
            call.reject("The parking photo could not be opened.", error);
        }
    }

    @PluginMethod
    public void deleteParkingPhoto(PluginCall call) {
        String photoId = safeParkingPhotoId(call.getString("photoId", ""));
        boolean deleted = false;
        if (photoId != null) {
            File file = parkingPhotoFile(photoId);
            try {
                SecureDeleteHelper.secureWipeFile(file);
                deleted = true;
            } catch (Exception ignored) {
                deleted = !file.exists() || file.delete();
            }
            ParkingPhotoExpiryScheduler.cancel(getContext(), photoId);
            DriveSenseNativeTripStore.clearParkingPhotoReference(getContext(), photoId);
        }
        JSObject payload = new JSObject();
        payload.put("deleted", deleted);
        call.resolve(payload);
    }

    private JSObject storeParkingPhotoBitmap(Bitmap bitmap) throws Exception {
        String photoId = UUID.randomUUID().toString();
        String fullDataUrl = bitmapDataUrl(scaleBitmap(bitmap, 1280), 84);
        String encrypted = DriveSensePayloadCrypto.encryptForStorage(fullDataUrl, "native:parking_photo:" + photoId);
        File file = parkingPhotoFile(photoId);
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("Parking photo directory is unavailable.");
        }
        Files.write(file.toPath(), encrypted.getBytes(StandardCharsets.UTF_8));
        JSObject payload = new JSObject();
        payload.put("photoFileId", photoId);
        payload.put("dataUrl", bitmapDataUrl(scaleBitmap(bitmap, 360), 76));
        payload.put("cancelled", false);
        return payload;
    }

    private File parkingPhotoFile(String photoId) {
        return new File(new File(getContext().getFilesDir(), "parking_photos"), photoId + ".enc");
    }

    private void eraseAllParkingPhotos() {
        File directory = new File(getContext().getFilesDir(), "parking_photos");
        File[] files = directory.listFiles();
        if (files != null) {
            for (File file : files) {
                if (file.isFile()) {
                    try {
                        SecureDeleteHelper.secureWipeFile(file);
                    } catch (Exception ignored) {
                        file.delete();
                    }
                }
            }
        }
        directory.delete();
        ParkingPhotoExpiryScheduler.clear(getContext());
        deletePendingParkingCapture();
    }

    private static String safeParkingPhotoId(String value) {
        if (value == null || !value.matches("[0-9a-fA-F-]{36}")) return null;
        return value;
    }

    private static String bitmapDataUrl(Bitmap bitmap, int quality) throws Exception {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
                throw new IllegalStateException("The parking photo could not be encoded.");
            }
            return "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        }
    }

    private static Bitmap scaleBitmap(Bitmap bitmap, int maxEdge) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int largest = Math.max(width, height);
        if (largest <= maxEdge) return bitmap;
        double scale = maxEdge / (double) largest;
        return Bitmap.createScaledBitmap(
            bitmap,
            Math.max(1, (int) Math.round(width * scale)),
            Math.max(1, (int) Math.round(height * scale)),
            true
        );
    }

    private static Bitmap decodeScaledBitmap(File file, int maxEdge) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        int sample = 1;
        while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > maxEdge * 2) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap decoded = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (decoded == null) return null;
        Bitmap oriented = applyExifOrientation(file, decoded);
        return scaleBitmap(oriented, maxEdge);
    }

    private static Bitmap applyExifOrientation(File file, Bitmap bitmap) {
        try {
            ExifInterface exif = new ExifInterface(file.getAbsolutePath());
            int orientation = exif.getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            );
            Matrix matrix = new Matrix();
            switch (orientation) {
                case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                    matrix.setScale(-1f, 1f);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_180:
                    matrix.setRotate(180f);
                    break;
                case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                    matrix.setRotate(180f);
                    matrix.postScale(-1f, 1f);
                    break;
                case ExifInterface.ORIENTATION_TRANSPOSE:
                    matrix.setRotate(90f);
                    matrix.postScale(-1f, 1f);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_90:
                    matrix.setRotate(90f);
                    break;
                case ExifInterface.ORIENTATION_TRANSVERSE:
                    matrix.setRotate(-90f);
                    matrix.postScale(-1f, 1f);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_270:
                    matrix.setRotate(-90f);
                    break;
                default:
                    return bitmap;
            }
            Bitmap transformed = Bitmap.createBitmap(
                bitmap,
                0,
                0,
                bitmap.getWidth(),
                bitmap.getHeight(),
                matrix,
                true
            );
            if (transformed != bitmap) bitmap.recycle();
            return transformed;
        } catch (Exception ignored) {
            return bitmap;
        }
    }

    private void deletePendingParkingCapture() {
        if (pendingParkingPhotoFile != null && pendingParkingPhotoFile.exists()) {
            pendingParkingPhotoFile.delete();
        }
        pendingParkingPhotoFile = null;
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
        boolean enabled = DriveSenseNativeTripStore.isServiceEnabled(getContext());
        org.json.JSONObject activeTrip = DriveSenseNativeTripStore.getActiveTripStatus(getContext());
        boolean recordingActive = enabled && activeTrip != null && activeTrip.optBoolean("active", false);
        if (!enabled && activeTrip != null) {
            DriveSenseNativeTripStore.clearActiveTripStatus(getContext());
            activeTrip = null;
        }
        payload.put("enabled", enabled);
        payload.put("recordingActive", recordingActive);
        payload.put("activeTrip", recordingActive ? activeTrip : null);
        payload.put(
            "activeTripCheckpoint",
            DriveSenseActiveTripCheckpointStore.getStatus(getContext(), System.currentTimeMillis())
        );
        org.json.JSONArray completedTrips = DriveSenseNativeTripStore.getCompletedTrips(getContext());
        payload.put("completedTripsCount", completedTrips.length());
        payload.put("completedTripJournal", DriveSenseNativeTripStore.getCompletedTripJournalStatus(getContext()));
        payload.put("diagnosticEventsCount", DriveSenseNativeTripStore.getDiagnosticEvents(getContext()).length());
        call.resolve(payload);
    }

    @PluginMethod
    public void getNativeDiagnostics(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("enabled", DriveSenseNativeTripStore.isServiceEnabled(getContext()));
        payload.put("events", DriveSenseNativeTripStore.getDiagnosticEvents(getContext()));
        payload.put("watchdog", AppExperienceWatchdog.getSnapshot(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void recordAppExperienceCheckpoint(PluginCall call) {
        String operation = call.getString("operation", "unknown");
        String phase = call.getString("phase", "unknown");
        String pathname = call.getString("pathname", "");
        AppExperienceWatchdog.recordOperationCheckpoint(getContext(), operation, phase, pathname);
        call.resolve();
    }

    @PluginMethod
    public void clearNativeDiagnostics(PluginCall call) {
        DriveSenseNativeTripStore.clearDiagnosticEvents(getContext());
        call.resolve();
    }

    @PluginMethod
    public void refreshWhereIParkedWidget(PluginCall call) {
        WhereIParkedWidgetProvider.refreshAll(getContext());
        ParkingReviewNotifier.reconcile(getContext());
        JSObject payload = new JSObject();
        payload.put("refreshed", true);
        call.resolve(payload);
    }

    @PluginMethod
    public void getNativeParkingSnapshot(PluginCall call) {
        JSObject payload = new JSObject();
        JSONObject state = DriveSenseNativeTripStore.getLastParkingState(getContext());
        JSONObject location = DriveSenseNativeTripStore.getLastParkedLocation(getContext());
        if (state != null) payload.put("state", state);
        if (location != null && "saved".equals(state != null ? state.optString("status", "") : "")) {
            payload.put("location", location);
        }
        call.resolve(payload);
    }

    @PluginMethod
    public void commitNativeParkingSnapshot(PluginCall call) {
        JSObject state = call.getObject("state");
        JSObject location = call.getObject("location");
        if (state == null) {
            call.reject("Parking state is required.");
            return;
        }
        try {
            JSONObject committed = DriveSenseNativeTripStore.commitParkingSnapshot(
                getContext(),
                state,
                location
            );
            JSObject payload = new JSObject();
            payload.put("state", committed);
            payload.put("location", DriveSenseNativeTripStore.getLastParkedLocation(getContext()));
            call.resolve(payload);
        } catch (SecurityException error) {
            call.reject("Privacy protection rejected the parking coordinate.", error);
        } catch (Exception error) {
            call.reject("The Android widget could not commit the parking update.", error);
        }
    }

    @PluginMethod
    public void clearNativeParkingState(PluginCall call) {
        try {
            DriveSenseNativeTripStore.clearParkingSnapshotAtomic(getContext());
            DriveSenseNativeTripStore.clearParkingReminderState(getContext());
            ParkingReviewNotifier.cancel(getContext());
            call.resolve();
        } catch (Exception error) {
            call.reject("The Android parking state could not be cleared.", error);
        }
    }

    @PluginMethod
    public void setNativeParkingReminderState(PluginCall call) {
        Long reminderAt = call.getLong("reminderAt");
        if (reminderAt == null || reminderAt <= System.currentTimeMillis()) {
            call.reject("reminderAt must be a future timestamp.");
            return;
        }
        Long stateRevision = call.getLong("stateRevision");
        DriveSenseNativeTripStore.saveParkingReminderState(
            getContext(),
            reminderAt,
            stateRevision == null ? 0L : stateRevision,
            call.getString("vehicleName", "")
        );
        JSObject payload = new JSObject();
        payload.put("reminderAt", reminderAt);
        payload.put("stateRevision", stateRevision == null ? 0L : stateRevision);
        call.resolve(payload);
    }

    @PluginMethod
    public void getNativeParkingReminderState(PluginCall call) {
        JSObject payload = new JSObject();
        JSONObject state = DriveSenseNativeTripStore.getParkingReminderState(getContext());
        if (state != null) payload.put("state", state);
        call.resolve(payload);
    }

    @PluginMethod
    public void clearNativeParkingReminderState(PluginCall call) {
        DriveSenseNativeTripStore.clearParkingReminderState(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getNativeCompletedTrips(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("trips", DriveSenseNativeTripStore.getCompletedTrips(getContext()));
        payload.put("queueStatus", DriveSenseNativeTripStore.getCompletedTripJournalStatus(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void acknowledgeNativeCompletedTrips(PluginCall call) {
        org.json.JSONArray tripIds = call.getData().optJSONArray("tripIds");
        if (tripIds == null) {
            call.reject("tripIds must be an array.");
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(
                DriveSenseNativeTripStore.acknowledgeCompletedTrips(getContext(), tripIds)
            ));
        } catch (JSONException error) {
            call.reject("Could not encode the completed-trip acknowledgement.", error);
        }
    }

    @PluginMethod
    public void clearNativeCompletedTrips(PluginCall call) {
        DriveSenseNativeTripStore.clearCompletedTrips(getContext());
        call.resolve();
    }

    @PluginMethod
    public void clearNativeActiveTripCheckpoint(PluginCall call) {
        DriveSenseActiveTripCheckpointStore.clear(getContext());
        call.resolve();
    }

    @PluginMethod
    public void eraseNativeLocalData(PluginCall call) {
        DriveSenseAutoTrackingService.stopForDataErasure(getContext());
        SpeedSignEvidenceStore.erase(getContext());
        eraseAllParkingPhotos();
        DriveSenseNativeTripStore.eraseAllForDataRights(getContext());
        JSObject payload = new JSObject();
        payload.put("erased", true);
        call.resolve(payload);
    }

    @PluginMethod
    public void startBackupExportTask(PluginCall call) {
        String taskId = UUID.randomUUID().toString();
        String label = call.getString("label", "Preparing backup");
        Integer progress = call.getInt("progress", 0);
        try {
            DriveSenseBackupExportService.start(getContext(), taskId, progress == null ? 0 : progress, label);
            JSObject payload = new JSObject();
            payload.put("taskId", taskId);
            call.resolve(payload);
        } catch (Exception error) {
            call.reject("Could not start background backup export.", error);
        }
    }

    @PluginMethod
    public void updateBackupExportTask(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null || taskId.trim().isEmpty()) {
            call.reject("taskId is required.");
            return;
        }
        Integer progress = call.getInt("progress", 0);
        String label = call.getString("label", "Exporting backup");
        boolean cancelled = DriveSenseBackupExportService.isCancelled(taskId);
        if (!cancelled) {
            DriveSenseBackupExportService.update(getContext(), taskId, progress == null ? 0 : progress, label);
        }
        JSObject payload = new JSObject();
        payload.put("cancelled", cancelled);
        call.resolve(payload);
    }

    @PluginMethod
    public void finishBackupExportTask(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null || taskId.trim().isEmpty()) {
            call.reject("taskId is required.");
            return;
        }
        String status = call.getString("status", "complete");
        if ("complete".equals(status)) {
            DriveSenseBackupExportService.complete(getContext(), taskId, call.getString("filename", "Road Sage backup"));
        } else if ("failed".equals(status)) {
            DriveSenseBackupExportService.fail(getContext(), taskId, call.getString("message", "Open Road Sage and try again."));
        } else {
            DriveSenseBackupExportService.cancelFromApp(getContext(), taskId);
        }
        DriveSenseBackupExportService.clearCancellation(taskId);
        call.resolve();
    }

    @PluginMethod
    public void isBackupExportTaskCancelled(PluginCall call) {
        String taskId = call.getString("taskId");
        JSObject payload = new JSObject();
        payload.put("cancelled", DriveSenseBackupExportService.isCancelled(taskId));
        call.resolve(payload);
    }

    @PluginMethod
    public void saveExportToDownloads(PluginCall call) {
        String filename;
        try {
            filename = validateDownloadFilename(call.getString("filename"));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        String data = call.getString("data");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        boolean isBase64 = Boolean.TRUE.equals(call.getBoolean("base64", false));
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
    public void beginExportToDownloads(PluginCall call) {
        String filename;
        try {
            filename = validateDownloadFilename(call.getString("filename"));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        String mimeType = call.getString("mimeType", "application/octet-stream");

        try {
            String exportId = UUID.randomUUID().toString();
            PendingExport pending = createPendingExport(exportId, filename, mimeType);
            pendingExports.put(exportId, pending);
            JSObject payload = new JSObject();
            payload.put("exportId", exportId);
            call.resolve(payload);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void appendExportToDownloads(PluginCall call) {
        String exportId = call.getString("exportId");
        String data = call.getString("data");
        PendingExport pending = exportId == null ? null : pendingExports.get(exportId);
        if (pending == null) {
            call.reject("Export session is unavailable.");
            return;
        }
        if (data == null) {
            call.reject("data is required.");
            return;
        }
        if (data.length() > 512 * 1024) {
            call.reject("Export chunk is too large.");
            return;
        }

        try {
            byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
            synchronized (pending) {
                pending.output.write(bytes);
                pending.bytesWritten += bytes.length;
            }
            JSObject payload = new JSObject();
            payload.put("bytesWritten", pending.bytesWritten);
            call.resolve(payload);
        } catch (Exception error) {
            cancelPendingExport(exportId);
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void finishExportToDownloads(PluginCall call) {
        String exportId = call.getString("exportId");
        PendingExport pending = exportId == null ? null : pendingExports.remove(exportId);
        if (pending == null) {
            call.reject("Export session is unavailable.");
            return;
        }

        try {
            synchronized (pending) {
                pending.output.flush();
                pending.output.close();
            }
            if (pending.mediaStoreUri != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(pending.mediaStoreUri, values, null, null);
            }
            JSObject payload = new JSObject();
            payload.put("uri", pending.uri().toString());
            payload.put("filename", pending.filename);
            payload.put("bytesWritten", pending.bytesWritten);
            call.resolve(payload);
        } catch (Exception error) {
            pending.delete(getContext());
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void cancelExportToDownloads(PluginCall call) {
        String exportId = call.getString("exportId");
        boolean cancelled = exportId != null && cancelPendingExport(exportId);
        JSObject payload = new JSObject();
        payload.put("cancelled", cancelled);
        call.resolve(payload);
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

    private static String validateDownloadFilename(String filename) {
        if (filename == null || filename.trim().isEmpty()) {
            throw new IllegalArgumentException("filename is required.");
        }

        String trimmed = filename.trim();
        if (".".equals(trimmed) || "..".equals(trimmed)) {
            throw new IllegalArgumentException("filename is invalid.");
        }
        if (trimmed.length() > 180) {
            throw new IllegalArgumentException("filename is too long.");
        }

        for (int index = 0; index < trimmed.length(); index++) {
            char c = trimmed.charAt(index);
            if (c < 0x20 || c == 0x7f || "\\/:*?\"<>|".indexOf(c) >= 0) {
                throw new IllegalArgumentException("filename contains invalid path characters.");
            }
        }

        return trimmed;
    }

    private JSObject saveDownload(String filename, byte[] data, String mimeType) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveDownloadWithMediaStore(filename, data, mimeType);
        }
        return saveDownloadWithPublicFile(filename, data);
    }

    private PendingExport createPendingExport(String exportId, String filename, String mimeType) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("Unable to create Downloads file.");
            OutputStream output = resolver.openOutputStream(uri);
            if (output == null) {
                resolver.delete(uri, null, null);
                throw new Exception("Unable to open Downloads file.");
            }
            return new PendingExport(exportId, filename, output, uri, null);
        }

        File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!downloadsDir.exists() && !downloadsDir.mkdirs()) {
            throw new Exception("Unable to open Downloads folder.");
        }
        File file = new File(downloadsDir, filename);
        return new PendingExport(exportId, filename, new FileOutputStream(file, false), null, file);
    }

    private boolean cancelPendingExport(String exportId) {
        PendingExport pending = pendingExports.remove(exportId);
        if (pending == null) return false;
        pending.delete(getContext());
        return true;
    }

    private static final class PendingExport {
        final String exportId;
        final String filename;
        final OutputStream output;
        final Uri mediaStoreUri;
        final File publicFile;
        long bytesWritten;

        PendingExport(String exportId, String filename, OutputStream output, Uri mediaStoreUri, File publicFile) {
            this.exportId = exportId;
            this.filename = filename;
            this.output = output;
            this.mediaStoreUri = mediaStoreUri;
            this.publicFile = publicFile;
        }

        Uri uri() {
            return mediaStoreUri != null ? mediaStoreUri : Uri.fromFile(publicFile);
        }

        void delete(Context context) {
            try {
                output.close();
            } catch (Exception ignored) {}
            if (mediaStoreUri != null) {
                context.getContentResolver().delete(mediaStoreUri, null, null);
            } else if (publicFile != null && publicFile.exists()) {
                publicFile.delete();
            }
        }
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
