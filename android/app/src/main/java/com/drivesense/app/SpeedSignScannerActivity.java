package com.drivesense.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraState;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class SpeedSignScannerActivity extends AppCompatActivity {
    private static final String TAG = "SpeedSignScanner";
    static final String EXTRA_UNITS = "units";
    static final String EXTRA_TRIP_ID = "tripId";
    static final String EXTRA_MAX_SESSION_MINUTES = "maxSessionMinutes";
    static final String EXTRA_REQUIRE_NATIVE_TRIP = "requireNativeTrip";
    static final String EXTRA_LAUNCH_SOURCE = "launchSource";
    static final String EXTRA_WAIT_FOR_AUTOMATIC_TRIP = "waitForAutomaticTrip";
    static final String EXTRA_WAIT_FOR_PREPARED_MANUAL_TRIP = "waitForPreparedManualTrip";
    static final String EXTRA_ARM_TIMEOUT_MINUTES = "armTimeoutMinutes";
    private static final String LAST_SCAN_SUMMARY_KEY = "speed_sign_last_scan_summary_v1";
    private static final long SAFETY_CHECK_INTERVAL_MS = 2_000L;
    // Grace period after a camera failure so the message is readable before the screen closes.
    private static final long CAMERA_FAILURE_AUTO_CLOSE_MS = 15_000L;
    private static final long PREVIEW_START_TIMEOUT_MS = 10_000L;
    private static final long DISTANT_FOCUS_RETRY_MS = 5_000L;
    private static final double MIN_ANALYSIS_SPEED_KMH = 12d;
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static final AtomicBoolean ARMED_FOR_TRIP = new AtomicBoolean(false);

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final SpeedSignObservationFusion fusion = new SpeedSignObservationFusion();
    private final AtomicBoolean processing = new AtomicBoolean(false);
    private ExecutorService cameraExecutor;
    private ProcessCameraProvider cameraProvider;
    private Camera activeCamera;
    private TextRecognizer recognizer;
    private FusedLocationProviderClient locationClient;
    private LocationCallback locationCallback;
    private volatile Location lastLocation;
    private TextView statusView;
    private TextView evidenceView;
    private TextView cameraStateView;
    private TextView titleView;
    private TextView safetyView;
    private TextView focusGuideView;
    private Button closeButton;
    private PreviewView previewView;
    private String units = "metric";
    private String fallbackTripId = "";
    private boolean requireNativeTrip;
    private long sessionDeadlineMs;
    private long lastAnalysisMs;
    private int capturedCount;
    private boolean stopping;
    private boolean previewStreaming;
    private boolean cameraFailed;
    private long cameraFailedAtMs;
    private boolean waitingForAutomaticTrip;
    private boolean waitingForPreparedManualTrip;
    private boolean scanningManualTrip;
    private boolean scanStarted;
    private boolean ownsRunningFlag;
    private int maxSessionMinutes = 20;
    private long armDeadlineMs;
    private boolean focusDiagnosticRecorded;
    private long lastCandidateMs;
    private String scanPolicyLabel = "Preparing adaptive scan";
    private String visualQualityLabel = "Waiting for a forward road view";
    private double lastVisualQuality;
    private int qualityRejectedCount;
    private int analyzedFrameCount;
    private int signTargetFrameCount;
    private int readableTextFrameCount;
    private int regulatoryTextFrameCount;
    private int consecutiveBlurFrames;
    private long lastFocusRequestMs;
    private String focusStateLabel = "Preparing forward focus";

    static boolean isRunning() {
        return RUNNING.get();
    }

    static boolean isArmedForTrip() {
        return ARMED_FOR_TRIP.get();
    }

    static JSONObject lastScanSummary(Context context) {
        String raw = DriveSenseNativeTripStore.prefs(context).getString(
            LAST_SCAN_SUMMARY_KEY,
            ""
        );
        if (raw == null || raw.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    static boolean isSafeToStart(Context context) {
        return batteryPercent(context) >= 20 || isCharging(context)
            ? thermalStatus(context) < PowerManager.THERMAL_STATUS_SEVERE
            : false;
    }

    static Intent createIntent(
        Context context,
        String tripId,
        String units,
        int maxSessionMinutes,
        boolean requireNativeTrip,
        String launchSource
    ) {
        Intent intent = new Intent(context, SpeedSignScannerActivity.class);
        intent.putExtra(EXTRA_UNITS, "imperial".equals(units) ? "imperial" : "metric");
        intent.putExtra(EXTRA_TRIP_ID, tripId == null ? "" : tripId.trim());
        intent.putExtra(EXTRA_MAX_SESSION_MINUTES, Math.max(5, Math.min(30, maxSessionMinutes)));
        intent.putExtra(EXTRA_REQUIRE_NATIVE_TRIP, requireNativeTrip);
        intent.putExtra(EXTRA_LAUNCH_SOURCE, launchSource == null ? "" : launchSource);
        return intent;
    }

    static Intent createArmedIntent(
        Context context,
        String units,
        int maxSessionMinutes,
        int armTimeoutMinutes
    ) {
        Intent intent = createIntent(
            context,
            "",
            units,
            maxSessionMinutes,
            true,
            "armed_ready_screen"
        );
        intent.putExtra(EXTRA_WAIT_FOR_AUTOMATIC_TRIP, true);
        intent.putExtra(EXTRA_ARM_TIMEOUT_MINUTES, Math.max(5, Math.min(30, armTimeoutMinutes)));
        return intent;
    }

    static Intent createPreparedManualIntent(
        Context context,
        String tripId,
        String units,
        int maxSessionMinutes
    ) {
        Intent intent = createIntent(
            context,
            tripId,
            units,
            maxSessionMinutes,
            true,
            "prepared_manual_trip"
        );
        intent.putExtra(EXTRA_WAIT_FOR_PREPARED_MANUAL_TRIP, true);
        return intent;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().getDecorView().setBackgroundColor(Color.BLACK);
        if (
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED ||
            !SpeedSignScannerSettings.isScannerEnabled(this)
        ) {
            showUnavailableScreen(
                ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                    ? "Camera permission is not available. Return to Road Sage Settings and allow Camera."
                    : "Speed-sign scanning is disabled. Enable it in Road Sage Settings first."
            );
            finish();
            return;
        }
        if (!RUNNING.compareAndSet(false, true)) {
            showUnavailableScreen("A speed-sign scanner session is already active.");
            finish();
            return;
        }
        ownsRunningFlag = true;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        fallbackTripId = getIntent().getStringExtra(EXTRA_TRIP_ID);
        if (fallbackTripId == null) fallbackTripId = "";
        fallbackTripId = fallbackTripId.trim();
        requireNativeTrip = getIntent().getBooleanExtra(EXTRA_REQUIRE_NATIVE_TRIP, false);
        units = "imperial".equals(getIntent().getStringExtra(EXTRA_UNITS)) ? "imperial" : "metric";
        maxSessionMinutes = Math.max(5, Math.min(30, getIntent().getIntExtra(EXTRA_MAX_SESSION_MINUTES, 20)));
        waitingForAutomaticTrip = getIntent().getBooleanExtra(EXTRA_WAIT_FOR_AUTOMATIC_TRIP, false);
        waitingForPreparedManualTrip = getIntent().getBooleanExtra(
            EXTRA_WAIT_FOR_PREPARED_MANUAL_TRIP,
            false
        );
        boolean waitingForTrip = waitingForAutomaticTrip || waitingForPreparedManualTrip;
        previewView = buildUi(maxSessionMinutes, waitingForTrip);
        if (waitingForTrip) {
            int armTimeoutMinutes = waitingForPreparedManualTrip
                ? 1
                : Math.max(
                    5,
                    Math.min(30, getIntent().getIntExtra(EXTRA_ARM_TIMEOUT_MINUTES, 15))
                );
            armDeadlineMs = System.currentTimeMillis() + armTimeoutMinutes * 60_000L;
            ARMED_FOR_TRIP.set(true);
            recordScannerDiagnostic(
                waitingForPreparedManualTrip
                    ? "speed_sign_manual_scan_prepared"
                    : "speed_sign_scan_armed",
                waitingForPreparedManualTrip
                    ? "Waiting for the parked manual-trip start to reach the native recorder."
                    : "Mounted Ready screen armed before departure."
            );
            mainHandler.post(armedTripCheck);
            return;
        }
        if (!isTripActive() || !isSafeToStart(this)) {
            showCameraError(
                !isTripActive()
                    ? "No active trip was found. Start or confirm a trip before opening the scanner."
                    : "The scanner is paused because the battery is low or the phone is too warm.",
                "scanner_preflight_blocked"
            );
            return;
        }
        beginScanning();
    }

    private void beginScanning() {
        if (scanStarted || stopping) return;
        if (!isTripActive() || !isSafeToStart(this)) {
            showCameraError(
                !isTripActive()
                    ? "The automatic trip is no longer active."
                    : "The scanner is paused because the battery is low or the phone is too warm.",
                "scanner_start_blocked"
            );
            return;
        }
        JSONObject activeTrip = DriveSenseNativeTripStore.getActiveTripStatus(this);
        scanningManualTrip = activeTrip != null
            && activeTrip.optBoolean("active", false)
            && activeTrip.optBoolean("manual", false);
        scanStarted = true;
        waitingForAutomaticTrip = false;
        waitingForPreparedManualTrip = false;
        ARMED_FOR_TRIP.set(false);
        sessionDeadlineMs = System.currentTimeMillis() + maxSessionMinutes * 60_000L;
        if (titleView != null) titleView.setText("On-device sign scan");
        cameraStateView.setText("Trip confirmed · Opening rear camera…");
        statusView.setText(
            scanningManualTrip
                ? "Manual trip started while parked. Opening the rear camera now."
                : "Automatic trip confirmed. Starting the rear camera without driver interaction."
        );
        evidenceView.setText("Keep driving normally. Sign review remains locked until after parking.");
        if (safetyView != null) {
            safetyView.setText(
                "No interaction is required while moving. Scanning stops automatically at trip end, low battery, high heat, or "
                    + maxSessionMinutes + " minutes."
            );
        }
        if (closeButton != null) closeButton.setVisibility(View.GONE);
        cameraExecutor = Executors.newSingleThreadExecutor();
        try {
            recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        } catch (Throwable error) {
            showCameraError(
                "The on-device sign reader could not initialize. Restart Road Sage and try again.",
                "scanner_text_recognizer_failed:" + error.getClass().getSimpleName()
            );
            return;
        }
        try {
            startLocationContext();
        } catch (Throwable error) {
            Log.w(TAG, "Location context unavailable; camera scanning can continue.", error);
        }
        previewView.post(() -> startCamera(previewView));
        mainHandler.postDelayed(() -> {
            if (!stopping && !previewStreaming) {
                showCameraError(
                    "The rear-camera preview did not start. Close the scanner, make sure no other app is using the camera, and try again.",
                    "scanner_preview_timeout"
                );
            }
        }, PREVIEW_START_TIMEOUT_MS);
        mainHandler.post(safetyCheck);
    }

    private final Runnable armedTripCheck = new Runnable() {
        @Override
        public void run() {
            if (
                stopping ||
                !SpeedSignScannerSettings.shouldKeepWaitingForPreparedTrip(
                    waitingForAutomaticTrip,
                    waitingForPreparedManualTrip
                )
            ) return;
            long now = System.currentTimeMillis();
            if (now >= armDeadlineMs) {
                recordScannerDiagnostic(
                    "speed_sign_scan_arm_expired",
                    waitingForPreparedManualTrip
                        ? "The prepared manual trip did not reach the native recorder before timeout."
                        : "No automatic trip was confirmed before the Ready screen timeout."
                );
                stopScanner(
                    waitingForPreparedManualTrip
                        ? "Manual trip camera start timed out. The trip may still be recording."
                        : "Arming expired."
                );
                return;
            }
            if (!isSafeToStart(SpeedSignScannerActivity.this)) {
                recordScannerDiagnostic(
                    "speed_sign_scan_arm_safety_cancelled",
                    "Arming cancelled for battery or thermal protection."
                );
                stopScanner("Arming cancelled for battery or temperature protection.");
                return;
            }
            JSONObject trip = DriveSenseNativeTripStore.getActiveTripStatus(
                SpeedSignScannerActivity.this
            );
            boolean confirmedTrip = trip != null && (
                waitingForPreparedManualTrip
                    ? SpeedSignScannerSettings.shouldStartPreparedManualScanner(
                        trip.optBoolean("active", false),
                        trip.optBoolean("candidate", true),
                        trip.optBoolean("manual", false),
                        trip.optString("state", ""),
                        trip.optString("id", ""),
                        fallbackTripId
                    )
                    : SpeedSignScannerSettings.shouldStartArmedScanner(
                        trip.optBoolean("active", false),
                        trip.optBoolean("candidate", true),
                        trip.optBoolean("manual", false),
                        trip.optString("state", "")
                    )
            );
            if (confirmedTrip) {
                fallbackTripId = trip.optString("id", "").trim();
                beginScanning();
                return;
            }
            long remainingMinutes = Math.max(1L, (armDeadlineMs - now + 59_999L) / 60_000L);
            statusView.setText(
                waitingForPreparedManualTrip
                    ? "Starting the manual trip recorder · camera remains off until it is confirmed"
                    : "Ready for the next automatic trip · " + remainingMinutes
                        + " min remaining · screen stays awake"
            );
            mainHandler.postDelayed(this, 1_000L);
        }
    };

    private void showUnavailableScreen(String message) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        TextView view = text(message, 16, true);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(28), dp(28), dp(28), dp(28));
        root.addView(view, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);
    }

    private PreviewView buildUi(int maxMinutes, boolean armedWaiting) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        PreviewView preview = new PreviewView(this);
        preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(preview, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        TextView focusGuide = text("FORWARD ROAD / SIGN FOCUS Â· PREPARING", 11, true);
        focusGuideView = focusGuide;
        focusGuide.setGravity(Gravity.CENTER);
        focusGuide.setTextColor(0xFFE2F8FF);
        GradientDrawable focusGuideBackground = new GradientDrawable();
        focusGuideBackground.setColor(0x1206B6D4);
        focusGuideBackground.setStroke(dp(2), 0xAA22D3EE);
        focusGuideBackground.setCornerRadius(dp(18));
        focusGuide.setBackground(focusGuideBackground);
        FrameLayout.LayoutParams focusGuideParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(132),
            Gravity.TOP
        );
        focusGuideParams.setMargins(dp(36), dp(150), dp(36), 0);
        root.addView(focusGuide, focusGuideParams);
        preview.getPreviewStreamState().observe(this, streamState -> {
            if (streamState != PreviewView.StreamState.STREAMING) return;
            previewStreaming = true;
            cameraFailed = false;
            if (cameraStateView != null) cameraStateView.setVisibility(View.GONE);
            if (statusView != null) {
                statusView.setText(
                    "Rear camera ready. Focus is biased to the forward road/sign box; scanning runs locally while the vehicle is moving."
                );
            }
            recordScannerDiagnostic("scanner_preview_streaming", "Rear-camera preview started.");
        });

        cameraStateView = text(
            armedWaiting
                ? "Ready for next drive\nCamera is off while waiting"
                : "Opening rear camera…",
            16,
            true
        );
        cameraStateView.setGravity(Gravity.CENTER);
        cameraStateView.setPadding(dp(18), dp(14), dp(18), dp(14));
        cameraStateView.setBackgroundColor(0xE6111B2B);
        FrameLayout.LayoutParams cameraStateParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        );
        cameraStateParams.setMargins(dp(24), dp(24), dp(24), dp(24));
        root.addView(cameraStateView, cameraStateParams);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(dp(18), dp(18), dp(18), dp(14));
        header.setBackgroundColor(0xCC07111F);
        titleView = text(
            waitingForPreparedManualTrip
                ? "Manual trip + camera"
                : armedWaiting ? "Mounted scan armed" : "On-device sign scan",
            20,
            true
        );
        statusView = text(
            armedWaiting
                ? waitingForPreparedManualTrip
                    ? "Starting the manual trip safely before the rear camera opens."
                    : "Waiting for Road Sage to confirm the next automatic trip. Keep this Ready screen visible on the mounted phone."
                : "Point the mounted phone forward. Full frames are discarded; one encrypted sign crop may be kept temporarily for parked review.",
            14,
            false
        );
        evidenceView = text(
            armedWaiting
                ? waitingForPreparedManualTrip
                    ? "Camera is off during this short handoff. No interaction is required after it opens."
                    : "No camera use while waiting. No further interaction is needed after you begin driving."
                : "No repeated regulatory sign candidate yet.",
            13,
            false
        );
        header.addView(titleView);
        header.addView(statusView);
        header.addView(evidenceView);
        FrameLayout.LayoutParams headerParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP
        );
        root.addView(header, headerParams);

        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.VERTICAL);
        footer.setGravity(Gravity.CENTER);
        footer.setPadding(dp(18), dp(14), dp(18), dp(18));
        footer.setBackgroundColor(0xCC07111F);
        safetyView = text(
            armedWaiting
                ? waitingForPreparedManualTrip
                    ? "Start this mode only while parked. If the manual recorder cannot be confirmed within one minute, camera startup cancels."
                    : "Arm only while parked. This screen keeps the display awake and cancels if hidden, locked, unsafe, or not started within 15 minutes."
                : "Do not interact while moving. Scanner stops at low battery, high heat, trip end, or " + maxMinutes + " minutes.",
            13,
            false
        );
        closeButton = new Button(this);
        closeButton.setText(
            waitingForPreparedManualTrip
                ? "Cancel camera start"
                : armedWaiting ? "Cancel armed scan" : "Stop sign scan"
        );
        closeButton.setOnClickListener(view -> stopScanner("Stopped by user."));
        footer.addView(safetyView);
        footer.addView(closeButton, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        FrameLayout.LayoutParams footerParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM
        );
        root.addView(footer, footerParams);
        setContentView(root);
        return preview;
    }

    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(Color.WHITE);
        view.setTextSize(sp);
        view.setPadding(0, 0, 0, dp(8));
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void startCamera(PreviewView previewView) {
        final ListenableFuture<ProcessCameraProvider> future;
        try {
            future = ProcessCameraProvider.getInstance(this);
        } catch (Throwable error) {
            showCameraError(
                "Android could not initialize the camera service on this phone.",
                "scanner_camera_provider_failed:" + error.getClass().getSimpleName()
            );
            return;
        }
        future.addListener(() -> {
            try {
                cameraProvider = future.get();
                if (!cameraProvider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                    showCameraError(
                        "This phone did not report an available rear camera.",
                        "scanner_back_camera_unavailable"
                    );
                    return;
                }
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                    // Distant roadside sign text is often too small for 640x480 OCR.
                    // KEEP_ONLY_LATEST plus the adaptive OCR cadence still bounds power use.
                    .setTargetResolution(new Size(1280, 720))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();
                analysis.setAnalyzer(cameraExecutor, this::analyzeFrame);
                cameraProvider.unbindAll();
                Camera camera = cameraProvider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis
                );
                activeCamera = camera;
                requestDistantRoadFocus();
                camera.getCameraInfo().getCameraState().observe(this, state -> {
                    CameraState.StateError stateError = state.getError();
                    if (stateError == null) return;
                    showCameraError(
                        "The rear camera stopped with Android camera error " + stateError.getCode()
                            + ". Close other camera apps and try again.",
                        "scanner_camera_state_error:" + stateError.getCode()
                    );
                });
                if (statusView != null) statusView.setText("Starting rear-camera preview…");
                recordScannerDiagnostic("scanner_camera_bound", "Rear camera bound to scanner.");
            } catch (Throwable error) {
                showCameraError(
                    "The rear camera could not start on this device. Close other camera apps and try again.",
                    "scanner_camera_bind_failed:" + error.getClass().getSimpleName()
                );
            }
        }, ContextCompat.getMainExecutor(this));
    }

    /**
     * Bias autofocus and exposure toward the road/sign area above the dashboard.
     * This is automatic so the driver never needs to tap the preview while moving.
     */
    private void requestDistantRoadFocus() {
        Camera camera = activeCamera;
        PreviewView preview = previewView;
        if (stopping || camera == null || preview == null) return;
        int width = preview.getWidth();
        int height = preview.getHeight();
        if (width <= 0 || height <= 0) {
            preview.postDelayed(this::requestDistantRoadFocus, 250L);
            return;
        }

        if (System.currentTimeMillis() - lastFocusRequestMs < DISTANT_FOCUS_RETRY_MS) return;
        lastFocusRequestMs = System.currentTimeMillis();
        MeteringPoint roadPoint = preview.getMeteringPointFactory().createPoint(
            width * 0.5f,
            height * 0.34f,
            0.20f
        );
        FocusMeteringAction action = new FocusMeteringAction.Builder(
            roadPoint,
            FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE
        )
            // Do not release focus back to the nearest high-contrast dashboard
            // every few seconds. Distant road signs stay in the same focus
            // range; a new request is made only after repeated blurred frames.
            .disableAutoCancel()
            .build();

        ListenableFuture<androidx.camera.core.FocusMeteringResult> focusFuture =
            camera.getCameraControl().startFocusAndMetering(action);
        focusFuture.addListener(() -> {
            if (stopping) return;
            try {
                boolean focused = focusFuture.get().isFocusSuccessful();
                focusStateLabel = focused ? "Forward focus locked" : "Forward focus retrying";
                if (focusGuideView != null) {
                    focusGuideView.setText(
                        focused
                            ? "FORWARD ROAD / SIGN FOCUS Â· LOCKED"
                            : "FORWARD ROAD / SIGN FOCUS Â· RETRYING"
                    );
                }
                if (!focusDiagnosticRecorded) {
                    focusDiagnosticRecorded = true;
                    recordScannerDiagnostic(
                        focused ? "scanner_distant_focus_ready" : "scanner_distant_focus_attempted",
                        focused
                            ? "Autofocus locked on the forward road-sign region."
                            : "The phone accepted the forward road focus request without reporting a lock."
                    );
                }
            } catch (Throwable error) {
                if (!focusDiagnosticRecorded) {
                    focusDiagnosticRecorded = true;
                    recordScannerDiagnostic(
                        "scanner_distant_focus_unavailable",
                        "This camera did not support the forward-road focus request; Android continuous focus remains active."
                    );
                }
            } finally {
                try {
                    if (!focusFuture.get().isFocusSuccessful() && !stopping) {
                        mainHandler.postDelayed(this::requestDistantRoadFocus, DISTANT_FOCUS_RETRY_MS);
                    }
                } catch (Throwable ignored) {
                    if (!stopping) mainHandler.postDelayed(this::requestDistantRoadFocus, DISTANT_FOCUS_RETRY_MS);
                }
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void showCameraError(String message, String reason) {
        cameraFailed = true;
        if (cameraFailedAtMs == 0L) cameraFailedAtMs = System.currentTimeMillis();
        Log.e(TAG, reason + ": " + message);
        recordScannerDiagnostic("speed_sign_camera_error", reason);
        // Release the camera immediately. A failure that leaves the camera bound and the
        // analyzer thread running keeps the screen awake and drains battery for the rest of
        // the session, with no way out because the close button is hidden while scanning.
        releaseCameraAfterFailure();
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (cameraStateView != null) {
                cameraStateView.setText(message);
                cameraStateView.setVisibility(View.VISIBLE);
            }
            if (statusView != null) statusView.setText("Sign scanning is not active.");
            if (evidenceView != null) {
                evidenceView.setText("No picture or sign data was captured. Tap Stop sign scan to return.");
            }
            // Scanning has stopped, so the user is no longer interacting while the detector
            // runs and the exit control can safely come back.
            if (closeButton != null) closeButton.setVisibility(View.VISIBLE);
        });
    }

    private void releaseCameraAfterFailure() {
        try {
            activeCamera = null;
            if (cameraProvider != null) cameraProvider.unbindAll();
            if (cameraExecutor != null) cameraExecutor.shutdown();
        } catch (Exception error) {
            Log.w(TAG, "Could not release camera after failure", error);
        }
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    private void recordScannerDiagnostic(String type, String reason) {
        JSONObject event = new JSONObject();
        try {
            event.put("id", "native_" + System.currentTimeMillis() + "_speed_sign_camera");
            event.put("timestamp", new java.text.SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                java.util.Locale.US
            ).format(new java.util.Date()));
            event.put("type", type);
            event.put("title", "Speed-sign camera status");
            event.put("reason", reason);
            event.put("detail", reason);
            event.put("speed_kmh", 0);
            event.put("stopped_seconds", 0);
            event.put("drift_m", 0);
            DriveSenseNativeTripStore.addDiagnosticEvent(this, event);
        } catch (Exception ignored) {
            Log.w(TAG, "Could not record scanner diagnostic.", ignored);
        }
    }

    private void analyzeFrame(@NonNull ImageProxy imageProxy) {
        long now = System.currentTimeMillis();
        JSONObject tripStatus = DriveSenseNativeTripStore.getActiveTripStatus(this);
        boolean confirmedRoad = tripStatus != null
            && "user_confirmed_posted_sign".equals(tripStatus.optString("speed_limit_source", ""));
        SpeedSignScanPolicy.Decision policy = SpeedSignScanPolicy.decide(
            batteryPercent(this),
            isCharging(this),
            thermalStatus(this),
            currentTripSpeedKmh(),
            confirmedRoad,
            lastCandidateMs > 0L ? now - lastCandidateMs : -1L
        );
        scanPolicyLabel = policy.label;
        if (
            stopping ||
            !policy.analyze ||
            now - lastAnalysisMs < policy.analysisIntervalMs ||
            !processing.compareAndSet(false, true)
        ) {
            imageProxy.close();
            return;
        }
        lastAnalysisMs = now;
        if (imageProxy.getImage() == null) {
            processing.set(false);
            imageProxy.close();
            return;
        }

        Bitmap upright = SpeedSignReviewCrop.uprightBitmap(imageProxy);
        SpeedSignVisualGate.Result visual = SpeedSignVisualGate.analyze(upright);
        visualQualityLabel = visual.qualityLabel;
        lastVisualQuality = visual.qualityScore;
        analyzedFrameCount += 1;
        if (visual.signTargetFound) signTargetFrameCount += 1;
        if (!visual.accepted || visual.analysisBitmap == null) {
            qualityRejectedCount += 1;
            if ("motion_or_blur".equals(visual.reason)) {
                consecutiveBlurFrames += 1;
                if (
                    consecutiveBlurFrames >= 3 &&
                    System.currentTimeMillis() - lastFocusRequestMs >= DISTANT_FOCUS_RETRY_MS
                ) {
                    consecutiveBlurFrames = 0;
                    mainHandler.post(this::requestDistantRoadFocus);
                }
            } else {
                consecutiveBlurFrames = 0;
            }
            if (upright != null) upright.recycle();
            processing.set(false);
            imageProxy.close();
            return;
        }
        consecutiveBlurFrames = 0;

        recognizeFrameBitmap(
            visual,
            upright,
            imageProxy,
            visual.analysisBitmap,
            visual.fallbackBitmap != null
        );
    }

    private void recognizeFrameBitmap(
        SpeedSignVisualGate.Result visual,
        Bitmap upright,
        ImageProxy imageProxy,
        Bitmap bitmap,
        boolean allowFallback
    ) {
        if (bitmap == null || bitmap.isRecycled()) {
            finishAnalyzedFrame(visual, upright, imageProxy);
            return;
        }
        recognizer.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(result -> {
                List<String> lines = new ArrayList<>();
                result.getTextBlocks().forEach(block ->
                    block.getLines().forEach(line -> lines.add(line.getText()))
                );
                if (!lines.isEmpty()) readableTextFrameCount += 1;
                SpeedSignObservationFusion.ParsedFrame parsed =
                    SpeedSignObservationFusion.parseFrame(lines);
                if (parsed == null && allowFallback && visual.fallbackBitmap != null) {
                    recognizeFrameBitmap(
                        visual,
                        upright,
                        imageProxy,
                        visual.fallbackBitmap,
                        false
                    );
                    return;
                }
                if (parsed != null) regulatoryTextFrameCount += 1;
                SpeedSignObservationFusion.FusedObservation candidate = parsed == null
                    ? null
                    : fusion.addFrame(lines, System.currentTimeMillis());
                if (candidate != null) {
                    lastCandidateMs = System.currentTimeMillis();
                    byte[] crop = SpeedSignReviewCrop.croppedJpeg(
                        bitmap,
                        result,
                        candidate.displayedValue
                    );
                    if (crop == null && visual.signTargetFound && bitmap == visual.analysisBitmap) {
                        crop = SpeedSignReviewCrop.candidateJpeg(bitmap);
                    }
                    recordCandidate(candidate, crop, visual);
                }
                finishAnalyzedFrame(visual, upright, imageProxy);
            })
            .addOnFailureListener(error -> {
                if (allowFallback && visual.fallbackBitmap != null) {
                    recognizeFrameBitmap(
                        visual,
                        upright,
                        imageProxy,
                        visual.fallbackBitmap,
                        false
                    );
                } else {
                    finishAnalyzedFrame(visual, upright, imageProxy);
                }
            });
    }

    private void finishAnalyzedFrame(
        SpeedSignVisualGate.Result visual,
        Bitmap upright,
        ImageProxy imageProxy
    ) {
        if (upright != null && !upright.isRecycled()) upright.recycle();
        if (visual.analysisBitmap != null && !visual.analysisBitmap.isRecycled()) {
            visual.analysisBitmap.recycle();
        }
        if (
            visual.fallbackBitmap != null &&
            visual.fallbackBitmap != visual.analysisBitmap &&
            !visual.fallbackBitmap.isRecycled()
        ) {
            visual.fallbackBitmap.recycle();
        }
        imageProxy.close();
        processing.set(false);
    }

    private void recordCandidate(
        SpeedSignObservationFusion.FusedObservation candidate,
        byte[] reviewImageJpeg,
        SpeedSignVisualGate.Result visual
    ) {
        if (!SpeedSignEvidenceStore.append(
            this,
            candidate,
            units,
            fallbackTripId,
            lastLocation,
            reviewImageJpeg,
            visual == null ? 0d : visual.qualityScore,
            visual == null ? "Unavailable" : visual.qualityLabel,
            scanPolicyLabel,
            visual != null && visual.signTargetFound,
            visual == null ? 0d : visual.signTargetScore
        )) return;
        capturedCount += 1;
        runOnUiThread(() -> {
            if (evidenceView == null || isFinishing() || isDestroyed()) return;
            evidenceView.setText(
                "Saved " + capturedCount + " private candidate"
                    + (capturedCount == 1 ? "" : "s")
                    + " for review after parking. Its temporary sign crop is encrypted and nothing changed in scoring or alerts."
            );
        });
    }

    private final Runnable safetyCheck = new Runnable() {
        @Override
        public void run() {
            if (stopping) return;
            long now = System.currentTimeMillis();
            if (!isTripActive()) {
                stopScanner("Trip ended. Sign scanning stopped.");
                return;
            }
            if (now >= sessionDeadlineMs) {
                stopScanner("Session time limit reached.");
                return;
            }
            if (!isSafeToStart(SpeedSignScannerActivity.this)) {
                stopScanner("Sign scanning stopped to protect battery or temperature.");
                return;
            }
            // The camera is already released by showCameraError; close out once the user has
            // had a chance to read why, instead of idling until the session limit.
            if (cameraFailed && now - cameraFailedAtMs >= CAMERA_FAILURE_AUTO_CLOSE_MS) {
                stopScanner("Sign scanning stopped because the camera was unavailable.");
                return;
            }
            int battery = batteryPercent(SpeedSignScannerActivity.this);
            long remainingMinutes = Math.max(0L, (sessionDeadlineMs - now + 59_999L) / 60_000L);
            if (!cameraFailed && statusView != null) {
                statusView.setText(
                    "Offline scan active · " + scanPolicyLabel + " · " + battery + "% battery · up to "
                        + remainingMinutes + " min · " + visualQualityLabel + " ("
                        + Math.round(lastVisualQuality * 100d) + "% quality)."
                );
            }
            if (!cameraFailed && evidenceView != null) {
                evidenceView.setText(
                    "Live detector: " + analyzedFrameCount + " frame"
                        + (analyzedFrameCount == 1 ? "" : "s") + " checked / "
                        + signTargetFrameCount + " sign-like target"
                        + (signTargetFrameCount == 1 ? "" : "s") + " / "
                        + readableTextFrameCount + " readable-text frame"
                        + (readableTextFrameCount == 1 ? "" : "s") + " / "
                        + regulatoryTextFrameCount + " regulatory match"
                        + (regulatoryTextFrameCount == 1 ? "" : "es") + " / "
                        + capturedCount + " saved for parked review."
                );
            }
            if (!cameraFailed && safetyView != null && qualityRejectedCount > 0) {
                safetyView.setText(
                    "Forward-road privacy crop active (" + focusStateLabel + "). " + qualityRejectedCount
                        + " dark, glare, or blurred frame" + (qualityRejectedCount == 1 ? " was" : "s were")
                        + " skipped before OCR."
                );
            }
            mainHandler.postDelayed(this, SAFETY_CHECK_INTERVAL_MS);
        }
    };

    private boolean isTripActive() {
        JSONObject status = DriveSenseNativeTripStore.getActiveTripStatus(this);
        return SpeedSignScannerSettings.isTripSessionActive(
            status != null && status.optBoolean("active", false),
            requireNativeTrip,
            fallbackTripId
        );
    }

    private double currentTripSpeedKmh() {
        JSONObject status = DriveSenseNativeTripStore.getActiveTripStatus(this);
        if (status != null && status.optBoolean("active", false)) {
            return status.optDouble("speed_kmh", 0d);
        }
        Location location = lastLocation;
        return location != null && location.hasSpeed() ? location.getSpeed() * 3.6d : 0d;
    }

    private void startLocationContext() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) return;
        locationClient = LocationServices.getFusedLocationProviderClient(this);
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                Location location = result.getLastLocation();
                if (location != null && location.getAccuracy() <= 60f) lastLocation = location;
            }
        };
        LocationRequest request = new LocationRequest.Builder(
            Priority.PRIORITY_BALANCED_POWER_ACCURACY,
            5_000L
        )
            .setMinUpdateDistanceMeters(20f)
            .setMinUpdateIntervalMillis(3_000L)
            .build();
        locationClient.getLastLocation().addOnSuccessListener(location -> {
            if (location != null && location.getAccuracy() <= 60f) lastLocation = location;
        });
        locationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
    }

    private void stopScanner(String reason) {
        if (stopping) return;
        if (scanStarted && analyzedFrameCount > 0) {
            persistScanSummary();
            recordScannerDiagnostic(
                "speed_sign_scan_summary",
                "Checked " + analyzedFrameCount + " frames; isolated " + signTargetFrameCount
                    + " sign-like targets; read text in " + readableTextFrameCount
                    + " frames; matched regulatory text in " + regulatoryTextFrameCount
                    + " frames; saved " + capturedCount + " candidates."
            );
        }
        stopping = true;
        ARMED_FOR_TRIP.set(false);
        if (statusView != null) statusView.setText(reason);
        mainHandler.removeCallbacksAndMessages(null);
        activeCamera = null;
        if (cameraProvider != null) cameraProvider.unbindAll();
        finish();
    }

    private void persistScanSummary() {
        JSONObject summary = new JSONObject();
        try {
            summary.put("timestamp", System.currentTimeMillis());
            summary.put("framesChecked", analyzedFrameCount);
            summary.put("signTargets", signTargetFrameCount);
            summary.put("readableTextFrames", readableTextFrameCount);
            summary.put("regulatoryMatches", regulatoryTextFrameCount);
            summary.put("savedCandidates", capturedCount);
            summary.put("qualityRejectedFrames", qualityRejectedCount);
            summary.put("focusMode", focusStateLabel);
            DriveSenseNativeTripStore.prefs(this)
                .edit()
                .putString(LAST_SCAN_SUMMARY_KEY, summary.toString())
                .apply();
        } catch (Exception ignored) {
            Log.w(TAG, "Could not persist scanner summary.", ignored);
        }
    }

    @Override
    protected void onDestroy() {
        stopping = true;
        mainHandler.removeCallbacksAndMessages(null);
        activeCamera = null;
        if (cameraProvider != null) cameraProvider.unbindAll();
        if (recognizer != null) recognizer.close();
        if (locationClient != null && locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback);
        }
        if (cameraExecutor != null) cameraExecutor.shutdownNow();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (ownsRunningFlag) {
            ARMED_FOR_TRIP.set(false);
            RUNNING.set(false);
        }
        super.onDestroy();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (ownsRunningFlag && !isChangingConfigurations() && !isFinishing()) {
            recordScannerDiagnostic(
                "speed_sign_scan_visibility_cancelled",
                waitingForPreparedManualTrip
                    ? "Prepared manual camera screen was hidden or the phone locked."
                    : waitingForAutomaticTrip
                        ? "Armed Ready screen was hidden or the phone locked."
                        : "Scanner screen was hidden or the phone locked."
            );
            stopScanner("Scanner cancelled because Road Sage is no longer visible.");
        }
    }

    @Override
    public void onBackPressed() {
        stopScanner("Stopped by user.");
    }

    private static int batteryPercent(Context context) {
        Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery == null) return 100;
        int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        return level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : 100;
    }

    private static boolean isCharging(Context context) {
        Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery == null) return false;
        int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        return status == BatteryManager.BATTERY_STATUS_CHARGING
            || status == BatteryManager.BATTERY_STATUS_FULL;
    }

    private static int thermalStatus(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return PowerManager.THERMAL_STATUS_NONE;
        PowerManager manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return manager == null ? PowerManager.THERMAL_STATUS_NONE : manager.getCurrentThermalStatus();
    }
}
