package com.roadsage.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
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
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

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
            alias = "bluetoothConnect",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        )
    }
)
public class DriveSenseActivityRecognitionPlugin extends Plugin {
    private static final String SECURE_EXPORT_MIME_TYPE = "application/octet-stream";
    private static final int BACKUP_ENC_VERSION = 1;
    private static final int BACKUP_ENC_HEADER_BYTES = 1 + 32 + 12;
    private static final int MIN_ENCRYPTED_EXPORT_BYTES = BACKUP_ENC_HEADER_BYTES + 16;
    private static final int EARCON_SAMPLE_RATE = 22050;
    /** Normal speech rate (1.0 = default Android TTS speed). */
    private static final float TTS_SPEECH_RATE = 1.0f;
    /**
     * Queue mode: flush any current speech, then speak this utterance.
     * Equals TextToSpeech.QUEUE_FLUSH. Use for safety alerts so they
     * are never delayed by a queued utterance.
     */
    private static final int TTS_QUEUE_MODE = TextToSpeech.QUEUE_FLUSH;
    private static WeakReference<DriveSenseActivityRecognitionPlugin> instance;
    private ActivityRecognitionClient activityClient;
    private PendingIntent activityIntent;
    private TextToSpeech textToSpeech;
    private boolean textToSpeechReady = false;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean audioFocusGranted = false;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        activityClient = ActivityRecognition.getClient(getContext());
        Intent intent = new Intent(getContext(), DriveSenseActivityReceiver.class);
        activityIntent = PendingIntent.getBroadcast(
            getContext(),
            42,
            intent,
            PendingIntentCompat.mutableFlags(PendingIntent.FLAG_UPDATE_CURRENT)
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
            textToSpeechReady = false;
        }
        abandonAudioFocus();
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

    @PluginMethod
    public void requestBluetoothPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.resolve(permissionPayload());
            return;
        }
        requestPermissionForAlias("bluetoothConnect", call, "bluetoothPermissionCallback");
    }

    @PermissionCallback
    private void activityPermissionCallback(PluginCall call) {
        call.resolve(permissionPayload());
    }

    @PermissionCallback
    private void backgroundLocationPermissionCallback(PluginCall call) {
        call.resolve(permissionPayload());
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
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
            RoadSageAutoTrackingService.start(getContext());
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
    public void stopNativeAutoTracking(PluginCall call) {
        RoadSageAutoTrackingService.stop(getContext());
        JSObject payload = new JSObject();
        payload.put("enabled", false);
        call.resolve(payload);
    }

    @PluginMethod
    public void speakText(PluginCall call) {
        String text = call.getString("text", "");
        boolean earconEnabled = Boolean.TRUE.equals(call.getBoolean("earconEnabled", false));
        int earconPattern = call.getInt("earconPattern", 0);
        if (text == null || text.trim().isEmpty()) {
            call.reject("text is required.");
            return;
        }

        if (textToSpeech != null && textToSpeechReady) {
            speakAfterEarcon(text, earconEnabled, earconPattern);
            call.resolve();
            return;
        }

        textToSpeech = new TextToSpeech(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS || textToSpeech == null) {
                textToSpeechReady = false;
                textToSpeech = null;
                call.reject("Android text-to-speech is unavailable.");
                return;
            }
            textToSpeech.setLanguage(Locale.US);
            textToSpeech.setSpeechRate(TTS_SPEECH_RATE);
            textToSpeech.setPitch(1.0f);
            setTextToSpeechAudioAttributes(textToSpeech);
            textToSpeechReady = true;
            speakAfterEarcon(text, earconEnabled, earconPattern);
            call.resolve();
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        speakText(call);
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

    private void speakNow(String text) {
        if (textToSpeech == null || !textToSpeechReady || text == null || text.trim().isEmpty()) return;
        String utteranceId = "road_sage_alert_" + System.currentTimeMillis();
        textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {
            }

            @Override
            public void onDone(String id) {
                abandonAudioFocus();
            }

            @Override
            public void onError(String id) {
                abandonAudioFocus();
            }
        });
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            textToSpeech.speak(text, TTS_QUEUE_MODE, null, utteranceId);
        } else {
            textToSpeech.speak(text, TTS_QUEUE_MODE, null);
            abandonAudioFocus();
        }
    }

    private void speakAfterEarcon(String text, boolean earconEnabled, int earconPattern) {
        if (textToSpeech == null || !textToSpeechReady || text == null || text.trim().isEmpty()) return;
        if (!requestAudioFocusForAlert()) return;
        if (!earconEnabled || earconPattern <= 0) {
            speakNow(text);
            return;
        }

        new Thread(() -> {
            playEarcon(earconPattern);
            if (audioFocusGranted) speakNow(text);
        }).start();
    }

    private void playEarcon(int priorityLevel) {
        if (priorityLevel <= 0) return;

        int[][] pattern;
        switch (priorityLevel) {
            case 3:
                pattern = new int[][]{{880, 80, 40}, {660, 80, 40}, {880, 120, 0}};
                break;
            case 2:
                pattern = new int[][]{{660, 100, 60}, {660, 100, 0}};
                break;
            default:
                pattern = new int[][]{{520, 140, 0}};
                break;
        }

        for (int[] tone : pattern) {
            int freqHz = tone[0];
            int durationMs = tone[1];
            int gapMs = tone[2];
            int numSamples = EARCON_SAMPLE_RATE * durationMs / 1000;
            short[] buffer = new short[numSamples];

            for (int i = 0; i < numSamples; i += 1) {
                double angle = 2.0 * Math.PI * i * freqHz / EARCON_SAMPLE_RATE;
                buffer[i] = (short) (Math.sin(angle) * Short.MAX_VALUE * 0.4);
            }

            AudioTrack track = null;
            try {
                track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build())
                    .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(EARCON_SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                    .setBufferSizeInBytes(numSamples * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build();

                track.write(buffer, 0, numSamples);
                track.play();
                Thread.sleep(durationMs + gapMs);
            } catch (Exception ignored) {
                return;
            } finally {
                if (track != null) {
                    try {
                        track.stop();
                    } catch (Exception ignored) {
                    }
                    track.release();
                }
            }
        }
    }

    private AudioAttributes alertAudioAttributes(int contentType) {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(contentType)
            .build();
    }

    private void setTextToSpeechAudioAttributes(TextToSpeech tts) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && tts != null) {
            tts.setAudioAttributes(alertAudioAttributes(AudioAttributes.CONTENT_TYPE_SPEECH));
        }
    }

    private boolean requestAudioFocusForAlert() {
        if (audioManager == null) {
            audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        }
        if (audioManager == null) return false;
        if (audioManager.getRingerMode() == AudioManager.RINGER_MODE_SILENT) return false;

        abandonAudioFocus();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(alertAudioAttributes(AudioAttributes.CONTENT_TYPE_SPEECH))
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener((focusChange) -> {
                    if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
                        if (textToSpeech != null) textToSpeech.stop();
                        abandonAudioFocus();
                    }
                })
                .build();
            audioFocusGranted = audioManager.requestAudioFocus(audioFocusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } else {
            audioFocusGranted = audioManager.requestAudioFocus(
                null,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }

        return audioFocusGranted;
    }

    private void abandonAudioFocus() {
        if (!audioFocusGranted || audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
            audioFocusRequest = null;
        } else {
            audioManager.abandonAudioFocus(null);
        }
        audioFocusGranted = false;
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
    public void getPrivacyZones(PluginCall call) {
        JSObject payload = new JSObject();
        String zonesJson = PrivacyZoneStore.getZonesJson(getContext());
        payload.put("zonesJson", zonesJson == null ? "[]" : zonesJson);
        call.resolve(payload);
    }

    @PluginMethod
    public void savePrivacyZones(PluginCall call) {
        String zonesJson = call.getString("zonesJson", "[]");
        try {
            PrivacyZoneStore.saveZonesJson(getContext(), zonesJson);
            call.resolve();
        } catch (JSONException error) {
            call.reject("Privacy zones must be a valid zone array.", error);
        }
    }

    @PluginMethod
    public void getSettings(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("settingsJson", NativeSettingsStore.getSettingsJson(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void saveSettings(PluginCall call) {
        String settingsJson = call.getString("settingsJson");
        if (settingsJson == null || settingsJson.trim().isEmpty()) {
            call.reject("settingsJson is required.");
            return;
        }

        try {
            new JSONObject(settingsJson);
            NativeSettingsStore.saveSettingsJson(getContext(), settingsJson);
            call.resolve();
        } catch (JSONException error) {
            call.reject("settingsJson must be valid JSON.", error);
        }
    }

    @PluginMethod
    public void getLastParkedLocation(PluginCall call) {
        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(getContext());
        JSObject payload = new JSObject();
        payload.put("parkedJson", parked == null ? null : parked.toString());
        call.resolve(payload);
    }

    @PluginMethod
    public void saveLastParkedLocation(PluginCall call) {
        String parkedJson = call.getString("parkedJson");
        if (parkedJson == null || parkedJson.trim().isEmpty()) {
            call.reject("parkedJson is required.");
            return;
        }

        try {
            JSONObject parked = new JSONObject(parkedJson);
            DriveSenseNativeTripStore.saveLastParkedLocation(getContext(), parked);
            call.resolve();
        } catch (JSONException error) {
            call.reject("Parked location must be valid JSON.", error);
        }
    }

    @PluginMethod
    public void clearLastParkedLocation(PluginCall call) {
        DriveSenseNativeTripStore.clearLastParkedLocation(getContext());
        call.resolve();
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
        if (!isAllowedSecureExportFilename(filename) ||
            !isSecureExportMimeType(mimeType) ||
            !looksLikeEncryptedRoadSagePayload(data)) {
            call.reject("Only encrypted Road Sage export files can be saved to Downloads.");
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

    private static boolean isAllowedSecureExportFilename(String filename) {
        String normalized = filename == null ? "" : filename.trim().toLowerCase(Locale.US);
        return normalized.endsWith(".rsexport") || normalized.endsWith(".rsbackup");
    }

    private static boolean isSecureExportMimeType(String mimeType) {
        return SECURE_EXPORT_MIME_TYPE.equalsIgnoreCase(String.valueOf(mimeType).trim());
    }

    private static boolean looksLikeEncryptedRoadSagePayload(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        try {
            byte[] decoded = Base64.decode(value.trim(), Base64.DEFAULT);
            return decoded.length > MIN_ENCRYPTED_EXPORT_BYTES &&
                decoded[0] == (byte) BACKUP_ENC_VERSION;
        } catch (IllegalArgumentException error) {
            return false;
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
        payload.put("bluetoothConnect", bluetoothPermissionString());
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

    private String bluetoothPermissionString() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "granted";
        PermissionState state = getPermissionState("bluetoothConnect");
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
