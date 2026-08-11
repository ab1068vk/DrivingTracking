package com.drivesense.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothDevice;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.BroadcastReceiver;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.TriggerEvent;
import android.hardware.TriggerEventListener;
import android.location.Location;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityRecognitionClient;
import com.google.android.gms.location.DetectedActivity;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import android.util.Log;

public class DriveSenseAutoTrackingService extends Service implements SensorEventListener {
    /** Armed-state GPS aggressiveness while no trip is in progress. */
    private enum ArmedTier { HIGH_ACCURACY, BALANCED, DORMANT }

    private static final String TAG = "AutoTrackingService";
    private static volatile boolean dataErasureInProgress = false;
    // Process-scoped liveness marker. A kill resets statics along with the process, so the
    // watchdog can tell "service running" from "process was killed" without polling or
    // trusting a heartbeat timestamp that Doze could delay.
    private static volatile boolean serviceRunning = false;
    // Set only on user/app-authorized stop paths. onDestroy() uses it to tell a real stop
    // apart from the OS or an OEM battery manager tearing the service down mid-drive.
    private boolean explicitStopRequested = false;
    static final String ACTION_START = "com.drivesense.app.action.START_NATIVE_AUTO";
    static final String ACTION_START_MANUAL_TRIP = "com.drivesense.app.action.START_NATIVE_MANUAL_TRIP";
    static final String ACTION_STOP = "com.drivesense.app.action.STOP_NATIVE_AUTO";
    static final String ACTION_STOP_SPEECH = "com.drivesense.app.action.STOP_NATIVE_SPEECH";
    static final String ACTION_END_TRIP = "com.drivesense.app.action.END_NATIVE_TRIP";
    static final String ACTION_DISCARD_MANUAL_TRIP = "com.drivesense.app.action.DISCARD_NATIVE_MANUAL_TRIP";
    static final String ACTION_ACKNOWLEDGE_INCIDENT = "com.drivesense.app.action.ACKNOWLEDGE_POSSIBLE_INCIDENT";
    static final String ACTION_ACTIVITY = "com.drivesense.app.action.ACTIVITY_UPDATE";
    static final String EXTRA_ACTIVITY_TYPE = "activityType";
    static final String EXTRA_ACTIVITY_CONFIDENCE = "activityConfidence";
    static final String EXTRA_START_TIME_MS = "startTimeMs";
    static final String EXTRA_TRIP_ID = "tripId";
    static final String EXTRA_KEEP_ARMED = "keepArmed";

    private static final int NOTIF_ID_TRACKING_START = 4101;
    private static final int ACTIVITY_RECOGNITION_REQUEST_CODE = 4102;
    private static final int NOTIF_ID_AUTO_STATUS = 4103;
    private static final int NOTIF_ID_POSSIBLE_INCIDENT = 4011;
    private static final int NIGHT_START_HOUR = DetectionConstants.NIGHT_START_HOUR;
    private static final int NIGHT_END_HOUR = DetectionConstants.NIGHT_END_HOUR;
    private static final String NIGHT_DETECTION_MODE_SUNSET = "sunset";
    private static final String NIGHT_DETECTION_MODE_CIVIL_TWILIGHT = "civil_twilight";
    private static final String NIGHT_DETECTION_MODE_CUSTOM = "custom";
    private static final String DEFAULT_NIGHT_START_TIME = "22:00";
    private static final String DEFAULT_NIGHT_END_TIME = "05:00";
    private static final double SUN_ZENITH_DEGREES = 90.833d;
    private static final double CIVIL_TWILIGHT_ZENITH_DEGREES = 96d;
    private static final int DEFAULT_NIGHT_BOUNDARY_TOLERANCE_MINUTES = 5;
    private static final String CHANNEL_ID = "drivesense_native_auto_tracking";
    private static final String AUTO_STATUS_CHANNEL_ID = "drivesense_auto_status";
    private static final int MIN_VEHICLE_CONFIDENCE = 65;
    private static final int MIN_STILL_CONFIDENCE = 70;
    private static final int MIN_POINTS_TO_SAVE = 2;
    private static final long MIN_TRIP_MS = DetectionConstants.MIN_TRIP_MS;
    private static final double MIN_TRIP_KM = DetectionConstants.MIN_TRIP_KM;
    private static final long AUTO_STOP_FOOT_MS = 10_000L;
    private static final long AUTO_STOP_STILL_STABLE_MS = 90_000L;
    private static final long AUTO_STOP_STILL_DRIFT_MS = 150_000L;
    private static final long AUTO_STOP_PARKED_GPS_STABLE_MS = 90_000L;
    private static final long AUTO_STOP_PARKED_GPS_RELAXED_MS = 300_000L;
    private static final long AUTO_STOP_IN_VEHICLE_MS = 120_000L;
    private static final long AUTO_STOP_IN_VEHICLE_EXTENDED_MS = 300_000L;
    private static final long AUTO_STOP_IN_VEHICLE_ABSOLUTE_MS = 420_000L;
    private static final long AUTO_STOP_NO_ACTIVITY_MS = 180_000L;
    private static final long STALE_LOCATION_STOP_MS = 30_000L;
    private static final long ACTIVITY_STATE_MAX_AGE_MS = 30_000L;
    private static final double GPS_STILL_DRIFT_M = 8.0d;
    private static final double GPS_VEHICLE_DRIFT_M = 5.0d;
    private static final double GPS_VEHICLE_DRIFT_RELAXED_M = 20.0d;
    private static final float MAX_ACCURACY_M = DetectionConstants.MAX_ACCURACY_M;
    private static final double MIN_POINT_DISTANCE_M = DetectionConstants.MIN_POINT_DISTANCE_M;
    private static final double STATIONARY_SPEED_KMH = DetectionConstants.STATIONARY_SPEED_KMH;
    private static final double MIN_TRUSTED_SPEED_KMH = DetectionConstants.MIN_TRUSTED_SPEED_KMH;
    // Mirrors the reported-vs-implied speed agreement checks in src/lib/tripEngine.js.
    private static final double MIN_REPORTED_MOVEMENT_DISPLACEMENT_M = 2d;
    private static final double REPORTED_SPEED_AGREEMENT_KMH = 12d;
    private static final double MAX_SPEED_KMH = DetectionConstants.MAX_SPEED_KMH;
    private static final double AUTO_START_SPEED_KMH = 5d;
    private static final long AUTO_START_MOVING_MS = 2_000L;
    // Armed-tier back-off thresholds: how long activity recognition must report a confident
    // STILL before armed GPS drops to balanced accuracy, then releases location entirely.
    private static final long ARMED_BALANCED_AFTER_STILL_MS = 2 * 60_000L;
    private static final long ARMED_DORMANT_AFTER_STILL_MS = 10 * 60_000L;
    private static final long ACTIVITY_UPDATE_INTERVAL_MS = 5_000L;
    private static final long PARKING_COOLDOWN_MS = 5 * 60_000L;
    private static final double PARKING_COOLDOWN_RADIUS_M = 75.0d;
    private static final double CANDIDATE_CONFIRM_DISTANCE_M = 150.0d;
    private static final double CANDIDATE_CONFIRM_DISTANCE_COOLDOWN_M = 250.0d;
    private static final double CANDIDATE_CONFIRM_SPEED_KMH = 10.0d;
    private static final double CANDIDATE_CONFIRM_SPEED_COOLDOWN_KMH = 10.0d;
    private static final double WALKING_SPEED_CUTOFF_KMH = 10.0d;
    private static final int CANDIDATE_MIN_STABLE_POINTS = 4;
    private static final int CANDIDATE_MIN_STABLE_POINTS_COOLDOWN = 5;
    private static final long CANDIDATE_MAX_REVIEW_MS = 180_000L;
    private static final String SAFETY_ALERTS_CHANNEL_ID = "drivesense_safety_alerts";
    private static final String SUMMARY_CHANNEL_ID = "drivesense_summary";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String SETTINGS_KEY = "drivesense_settings";
    private static final String PARKING_LEARNING_KEY = "drivesense_parking_learning_v1";
    private static final String SPEED_KNOWLEDGE_KEY = "speed_knowledge_native_mirror_v1";
    private static final String LEGACY_SPEED_KNOWLEDGE_KEY = "speed_knowledge_v1";
    private static final String SPEED_KNOWLEDGE_MIRROR_INITIALIZED_KEY =
        "speed_knowledge_native_mirror_initialized_v1";
    private static final String DANGER_ZONES_KEY = "drivesense_danger_zones";
    private static final String COACH_PROGRAM_KEY = "drivesense_coach_programs_v1";
    private static final String GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
    private static final int SPEED_KNOWLEDGE_GEOHASH_PRECISION = 6;
    private static final int SPEED_KNOWLEDGE_FALLBACK_GEOHASH_PRECISION = 5;
    // Keep legacy geohash-only rules inside the same conservative corridor as
    // the web resolver. A wider native radius could otherwise speak a saved
    // limit from a parallel road while the in-app score correctly rejected it.
    private static final double SPEED_KNOWLEDGE_MATCH_RADIUS_KM = 0.35d;
    private static final double SPEED_KNOWLEDGE_SECTION_MATCH_RADIUS_KM = 0.045d;
    private static final double SPEED_KNOWLEDGE_DIRECTION_TOLERANCE_DEG = 60.0d;
    private static final double SPEED_KNOWLEDGE_MAX_LIMIT_KMH = 210.0d;
    private static final int SPEED_KNOWLEDGE_MIN_TRIP_CONSENSUS_EVIDENCE = 3;
    private static final String NOTIFICATION_PREFS = "drivesense_native_notification_state";
    private static final String KEY_LAST_PHONE_USE_NOTIFICATION_MS = "last_phone_use_notification_ms";
    private static final String KEY_LAST_TRIP_COMPLETED_NOTIFICATION_ID = "last_trip_completed_notification_id";
    private static final int PHONE_USE_NOTIFICATION_ID = 4001;
    private static final int TRIP_COMPLETED_NOTIFICATION_ID = 2002;
    // Micro-steer window, oscillation count and accuracy gate are user-settable, so they are
    // read per sample rather than frozen here; only the non-settable band bounds stay static.
    private static final double PHONE_MICRO_STEER_MIN_DEG = DetectionConstants.PHONE_MICRO_STEER_MIN_DEG;
    private static final double PHONE_MICRO_STEER_MAX_DEG = DetectionConstants.PHONE_MICRO_STEER_MAX_DEG;
    private static final double PHONE_DETECT_MIN_SPEED_KMH = DetectionConstants.PHONE_DETECT_MIN_SPEED_KMH;
    private static final long PHONE_NOTIFY_COOLDOWN_MS = 120_000L;
    private static final long PHONE_WINDOW_COUNT_COOLDOWN_MS = 15_000L;
    private static final long LIVE_NOTIFICATION_MIN_INTERVAL_MS = 10_000L;
    private static final long LIVE_STATUS_MIN_INTERVAL_MS = 2_000L;
    private static final long ACTIVE_CHECKPOINT_INTERVAL_MS = 60_000L;
    private static final long ACTIVE_CHECKPOINT_RESUME_WINDOW_MS = 10 * 60_000L;
    private static final int MAX_LIVE_TELEMETRY_EVENTS = 40;
    private static final int MAX_LIVE_ROUTE_PREVIEW_POINTS = 160;
    private static final long STATS_MAX_SAMPLE_GAP_SECONDS = DetectionConstants.STATS_MAX_SAMPLE_GAP_SECONDS;
    private static final double SUSTAINED_TURN_HEADING_CHANGE_DEG = 35.0d;
    private static final float TTS_SPEECH_RATE = 0.95f;
    private static final float TTS_VOLUME = 0.95f;
    // Shared with the webview through DetectionConstants so the two sides cannot
    // drift. They previously agreed only by hand-copied coincidence.
    private static final long SPEED_ALERT_SUSTAINED_MS = DetectionConstants.SPEED_ALERT_SUSTAINED_MS;
    private static final double SPEED_ALERT_RELEASE_KMH = DetectionConstants.SPEED_ALERT_RELEASE_KMH;
    private static final long SPEED_ALERT_COOLDOWN_MS = 60_000L;
    private static final long SPEED_ALERT_ESTIMATED_COOLDOWN_MS = 90_000L;
    private static final long SPEED_ALERT_INFERRED_COOLDOWN_MS = 180_000L;
    /** inferSpeedZones' window size, so the inferred road context is drawn from the same span. */
    private static final int RECENT_SPEED_WINDOW = 30;
    private static final int MIN_RECENT_SPEED_SAMPLES = 8;
    private static final long TRACKING_READY_ALERT_RETRY_MS = 10_000L;
    private static final long COACH_BRIEF_MIN_DELAY_MS = 12_000L;
    private static final long COACH_BRIEF_MAX_DELAY_MS = 5 * 60_000L;
    private static final long DANGER_ZONE_ALERT_COOLDOWN_MS = 60_000L;
    private static final double DANGER_ZONE_ALERT_RADIUS_M = 300.0d;
    private static final long MANOEUVRE_ALERT_COOLDOWN_MS = 30_000L;
    private static final long CLOSE_MANOEUVRE_ALERT_COOLDOWN_MS = 120_000L;
    private static final long STOP_START_ALERT_COOLDOWN_MS = 60_000L;
    private static final long STOP_START_WINDOW_MS = 2 * 60_000L;
    private static final int STOP_START_ALERT_CYCLES = 3;
    private static final long IDLE_ALERT_COOLDOWN_MS = 5 * 60_000L;
    private static final long FATIGUE_ALERT_COOLDOWN_MS = 30 * 60_000L;
    private static final long HEADING_DRIFT_ALERT_COOLDOWN_MS = 10 * 60_000L;
    private static final long HEADING_DRIFT_WINDOW_MS = 5 * 60_000L;
    private static final int HEADING_DRIFT_MIN_SAMPLES = 8;
    private static final double HEADING_DRIFT_HIGHWAY_SPEED_KMH = DetectionConstants.HEADING_DRIFT_HIGHWAY_SPEED_KMH;
    private static final double HEADING_DRIFT_HIGHWAY_SHARE = 0.80d;
    private static final long LIVE_EVENT_MAX_SAMPLE_GAP_MS = 6_000L;
    private static final double LIVE_EVENT_MAX_ACCURACY_M = 25.0d;
    private static final double SHARP_TURN_MIN_HEADING_CHANGE_DEG = DetectionConstants.SHARP_TURN_MIN_HEADING_CHANGE_DEG;
    private static final double STANDARD_GRAVITY_MS2 = DetectionConstants.STANDARD_GRAVITY_MS2;
    private static final long MAX_TERMINAL_IDLE_SECONDS = DetectionConstants.MAX_TERMINAL_IDLE_SECONDS;
    // Size budget for the in-trip IMU buffer. Overflow is handled by
    // MotionSampleRetention's generational decimation, not FIFO eviction, so a long
    // drive keeps whole-trip coverage at reduced resolution instead of losing its start.
    private static final int MAX_NATIVE_MOTION_SAMPLES = 5000;
    private static final long MOTION_SAMPLE_MIN_INTERVAL_MS = 100L;
    // Battery and thermal state move slowly; re-deciding more often than this would
    // only add wake cost and risk thrashing the LocationRequest.
    private static final long CAPTURE_TIER_EVAL_INTERVAL_MS = 30_000L;
    private static final long MOTION_AXIS_FRESH_MS = 500L;
    private static final int POSSIBLE_INCIDENT_RECENT_POINTS = 8;
    private static final long POSSIBLE_INCIDENT_SAMPLE_WINDOW_MS = 12_000L;
    private static final long POSSIBLE_INCIDENT_ALERT_COOLDOWN_MS = 5 * 60_000L;
    // Keeps the stored trip payload bounded; the 5-minute cooldown already limits the rate.
    private static final int MAX_INCIDENT_EVENTS_PER_TRIP = 20;
    private static final double POSSIBLE_INCIDENT_MIN_SPEED_KMH = 20.0d;
    private static final double POSSIBLE_INCIDENT_LINEAR_MS2 = 18.0d;
    private static final double POSSIBLE_INCIDENT_HIGH_LINEAR_MS2 = 28.0d;
    private static final double POSSIBLE_INCIDENT_ROTATION_DEG_S = 90.0d;
    private static final long POSSIBLE_INCIDENT_STOPPED_SECONDS = 8L;
    private static final long POSSIBLE_INCIDENT_HIGH_STOPPED_SECONDS = 15L;
    private static final long COMPLETED_TRIP_SAVE_RETRY_MS = 60_000L;
    private static final long PARKING_REFINEMENT_WINDOW_MS = 30_000L;
    private static final int PARKING_REFINEMENT_MAX_FIXES = 6;
    private static final double PARKING_REFINEMENT_MOVING_SPEED_KMH = 8.0d;
    private static final double PARKING_REFINEMENT_MAX_DRIFT_M = 35.0d;

    private ActivityRecognitionClient activityClient;
    private FusedLocationProviderClient locationClient;
    private SensorManager sensorManager;
    private Sensor linearAccelerationSensor;
    private Sensor gyroscopeSensor;
    private PendingIntent activityIntent;
    private LocationCallback locationCallback;
    private JSONArray activePoints;
    private JSONArray activeTimeline;
    private JSONArray activeMotionSamples;
    // How many IMU samples retention thinned out of this trip's buffer. Reported so
    // a long drive can state its motion resolution instead of implying full coverage.
    private int activeMotionSamplesDropped = 0;
    // Resolved once per trip so a mid-drive settings change cannot make the buffer
    // policy shift underneath the samples already recorded for this trip.
    private CaptureFidelityProfile.Profile activeCaptureProfile = CaptureFidelityProfile.resolve(null);
    // Measured from the first serialized sample; the byte cap is meaningless if it
    // is derived from the same estimate that sized the count budget.
    private long activeMotionSampleBytes = 0L;
    // Adaptive capture governor state. Time in each tier is accumulated so a trip can
    // state "GPS was throttled for 6 min: battery <=15%, not charging" instead of
    // leaving a quietly degraded stretch unexplained.
    private CaptureTierPolicy.Decision activeCaptureTier = null;
    private long activeCaptureTierSinceMs = 0L;
    private long lastCaptureTierEvalMs = 0L;
    private final java.util.LinkedHashMap<String, Long> activeCaptureTierSeconds = new java.util.LinkedHashMap<>();
    private JSONArray activeIncidentEvents;
    private JSONArray activeTelemetryEvents;
    private long activeStartMs = 0L;
    private long stillSinceMs = 0L;
    private long nonVehicleSinceMs = 0L;
    private Location previousLocation;
    // Single thread so checkpoint writes stay ordered; the newest state always wins.
    private ExecutorService checkpointExecutor;
    // Created lazily rather than in a field initializer: an initializer would make
    // every `new DriveSenseAutoTrackingService()` call Looper.getMainLooper(), which
    // is unmocked in JVM unit tests and took the whole JS/Android parity suite down.
    private Handler mainHandler;
    private ArmedTier armedTier = ArmedTier.HIGH_ACCURACY;
    private long armedStillSinceMs = 0L;
    private Sensor significantMotionSensor;
    private TriggerEventListener significantMotionListener;
    private Location armedPreviousLocation;
    private long lastLocationMs = 0L;
    private long armedMovingSinceMs = 0L;
    private double lastKnownSpeedKmh = 0.0d;
    private double stoppedAnchorLat = Double.NaN;
    private double stoppedAnchorLng = Double.NaN;
    private double maxDriftSinceStopM = 0.0d;
    private final Deque<double[]> recentHeadings = new ArrayDeque<>();
    private final Deque<double[]> nativeHeadingDriftWindow = new ArrayDeque<>();
    /**
     * Recent speeds, used only to guess a road context when no saved road speed
     * matches. 30 samples because that is the window inferSpeedZones uses to pick
     * a zone from its 85th percentile.
     */
    private final Deque<Double> recentSpeedsKmh = new ArrayDeque<>();
    private int nativeMicroSteerCount = 0;
    private long lastPhoneUseNotifyMs = 0L;
    private long lastNativeProxyWindowMs = 0L;
    private long lastNativePhoneWindowMs = 0L;
    private long lastLiveNotificationMs = 0L;
    private long lastLiveStatusMs = 0L;
    private long lastActiveCheckpointMs = 0L;
    private long checkpointRecoveryEndOverrideMs = 0L;
    private JSONObject pendingCompletedTrip;
    private long nextCompletedTripSaveRetryMs = 0L;
    private JSONArray pendingParkingRefinementPoints;
    private JSONObject pendingParkingRefinementSignals;
    private long pendingParkingRefinementDeadlineMs = 0L;
    private long pendingParkingTimestampMs = 0L;
    private String pendingParkingTripId = "";
    private String pendingParkingSource = "";
    private double pendingParkingAnchorLat = Double.NaN;
    private double pendingParkingAnchorLng = Double.NaN;
    private int pendingParkingRefinementFixCount = 0;
    private boolean pendingParkingRefinementStopServiceAfter = false;
    private DriveSenseSpeechController speechController;
    private long speedingSinceMs = 0L;
    private long lastSpeedAlertMs = 0L;
    private long lastHarshBrakeAlertMs = 0L;
    private long lastRapidAccelAlertMs = 0L;
    private long lastCorneringAlertMs = 0L;
    private long lastCloseManoeuvreAlertMs = 0L;
    private long lastStopStartAlertMs = 0L;
    private long lastHeadingDriftAlertMs = 0L;
    private long lastIdleAlertMs = 0L;
    private long lastFatigueAlertMs = 0L;
    private long stopStartWindowStartMs = 0L;
    private int stopStartCycleCount = 0;
    private boolean trackingReadyAlertSpoken = false;
    private boolean trackingReadyAlertPending = false;
    private long lastTrackingReadyAlertAttemptMs = 0L;
    private boolean coachBriefAlertSpoken = false;
    private boolean coachBriefAlertPending = false;
    private long lastDangerZoneAlertMs = 0L;
    private String nativeAutoStartReason = "";
    private String lastNativeAutoStopReason = "";
    private String nativeTripStartSource = "native_auto";
    private String nativeManualTripId = "";
    private String nativeRecoveryTripId = "";
    private boolean candidateTrip = false;
    private boolean candidateNearParked = false;
    private boolean nativeManualTrip = false;
    private boolean hasPermissionLoss = false;
    private long candidateConfirmedMs = 0L;
    private int lastActivityType = DetectedActivity.UNKNOWN;
    private int lastActivityConfidence = 0;
    private long lastActivityUpdateMs = 0L;
    private long lastVehicleExitTransitionMs = 0L;
    private long lastVehicleDisconnectMs = 0L;
    private BroadcastReceiver vehicleConnectionReceiver;
    private float lastAx = Float.NaN;
    private float lastAy = Float.NaN;
    private float lastAz = Float.NaN;
    private float lastGx = Float.NaN;
    private float lastGy = Float.NaN;
    private float lastGz = Float.NaN;
    private long lastLinearSensorMs = 0L;
    private long lastGyroSensorMs = 0L;
    private long lastMotionSampleMs = 0L;
    private long lastNativeSpeechDiagnosticMs = 0L;
    private long lastPossibleIncidentAlertMs = 0L;
    private double lastLongitudinalAccelerationMs2 = 0.0d;
    private double lastLateralG = 0.0d;
    private double lastHeadingRateDegS = 0.0d;

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        explicitStopRequested = false;
        dataErasureInProgress = false;
        checkpointExecutor = Executors.newSingleThreadExecutor();
        updateForegroundNotification("Ready when you start moving");
        ensureSafetyAlertsChannel();
        speechController = new DriveSenseSpeechController(this);
        activityClient = ActivityRecognition.getClient(this);
        locationClient = LocationServices.getFusedLocationProviderClient(this);
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            linearAccelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
            gyroscopeSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        }
        activityIntent = PendingIntent.getBroadcast(
            this,
            ACTIVITY_RECOGNITION_REQUEST_CODE,
            new Intent(this, DriveSenseActivityReceiver.class),
            PendingIntent.FLAG_UPDATE_CURRENT | mutableFlag()
        );
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result == null) return;
                for (Location location : result.getLocations()) {
                    recordLocation(location);
                }
            }
        };
        registerVehicleConnectionReceiver();
        restoreActiveTripCheckpointIfAvailable();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        updateForegroundNotification(
            isTripActive() ? buildLiveTripStatus(System.currentTimeMillis()) : "Ready when you start moving"
        );

        if (ACTION_STOP.equals(action)) {
            stopEverything();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP_SPEECH.equals(action)) {
            if (speechController != null) speechController.stop();
            speedingSinceMs = 0L;
            return START_STICKY;
        }
        if (ACTION_ACKNOWLEDGE_INCIDENT.equals(action)) {
            acknowledgePossibleIncidentFromNotification();
            return START_STICKY;
        }

        DriveSenseNativeTripStore.setServiceEnabled(this, true);
        if (ACTION_START_MANUAL_TRIP.equals(action)) {
            long startTimeMs = intent != null ? intent.getLongExtra(EXTRA_START_TIME_MS, System.currentTimeMillis()) : System.currentTimeMillis();
            String tripId = intent != null ? intent.getStringExtra(EXTRA_TRIP_ID) : "";
            startManualTrip(startTimeMs, tripId);
        }
        if (ACTION_DISCARD_MANUAL_TRIP.equals(action)) {
            boolean keepArmed = intent != null && intent.getBooleanExtra(EXTRA_KEEP_ARMED, false);
            discardActiveTrip("manual_trip_saved_by_app", keepArmed);
            recordDiagnostic("manual_native_trip_discarded", "Native manual trip mirror discarded.", "manual_trip_saved_by_app", 0d, 0L, 0d);
            if (!keepArmed) {
                explicitStopRequested = true;
                DriveSenseTrackingWatchdog.cancel(this);
                DriveSenseNativeTripStore.setServiceEnabled(this, false);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (ACTION_END_TRIP.equals(action)) {
            boolean keepArmed = intent == null || intent.getBooleanExtra(EXTRA_KEEP_ARMED, true);
            finishTrip("notification_end_trip", keepArmed);
            recordDiagnostic("service_armed", "Native service is armed for auto tracking.", "notification_end_trip", 0d, 0L, 0d);
            if (!keepArmed) {
                explicitStopRequested = true;
                DriveSenseTrackingWatchdog.cancel(this);
                DriveSenseNativeTripStore.setServiceEnabled(this, false);
                if (pendingParkingRefinementPoints == null) stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (ACTION_START.equals(action) || action == null) {
            recordDiagnostic("service_armed", "Native service is armed for auto tracking.", "service_start", 0d, 0L, 0d);
        }
        DriveSenseTrackingWatchdog.armPeriodicCheck(this);
        requestActivityUpdates();
        if (!isTripActive()) startArmedLocationUpdates();

        if (ACTION_ACTIVITY.equals(action) && intent != null) {
            handleActivity(
                intent.getIntExtra(EXTRA_ACTIVITY_TYPE, DetectedActivity.UNKNOWN),
                intent.getIntExtra(EXTRA_ACTIVITY_CONFIDENCE, 0)
            );
        }

        return START_STICKY;
    }

    static boolean isRunning() {
        return serviceRunning;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Aggressive OEM launchers kill the whole process when the task is swiped away.
        // Restarting from here is allowed on Android 12+ because this app is *currently*
        // running a foreground service, which is a documented background-start exemption.
        if (!DriveSenseNativeTripStore.isServiceEnabled(this)) {
            super.onTaskRemoved(rootIntent);
            return;
        }
        if (isTripActive()) persistActiveTripCheckpoint(System.currentTimeMillis(), true);
        recordDiagnostic(
            "task_removed",
            "App task removed while tracking was armed; requesting restart.",
            "on_task_removed",
            lastKnownSpeedKmh,
            0L,
            0d
        );
        Intent restart = new Intent(getApplicationContext(), DriveSenseAutoTrackingService.class)
            .setAction(ACTION_START);
        try {
            ContextCompat.startForegroundService(getApplicationContext(), restart);
        } catch (Exception ignored) {
            // The process may be killed before the binder call lands; the watchdog below is
            // the backstop for exactly that race.
        }
        DriveSenseTrackingWatchdog.scheduleImmediateCheck(getApplicationContext());
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        // An involuntary destroy (OEM battery sweep, low-memory stop) must not finalize the
        // drive: doing so splits one real trip into several. Freeze it as a checkpoint instead
        // so a relaunch resumes it, and let restoreActiveTripCheckpointIfAvailable() decide
        // resume-vs-finalize based on how long the gap turned out to be.
        boolean involuntaryStop = isTripActive() && !explicitStopRequested && !dataErasureInProgress;
        if (involuntaryStop) {
            persistActiveTripCheckpoint(System.currentTimeMillis(), true);
            recordDiagnostic(
                "service_destroyed_involuntary",
                "Tracking stopped without an explicit stop; trip kept resumable.",
                "service_destroyed",
                lastKnownSpeedKmh,
                0L,
                0d
            );
            DriveSenseTrackingWatchdog.onTrackingInterrupted(this);
        } else if (!dataErasureInProgress) {
            finishTrip("service_destroyed", false);
        }
        clearPendingParkingRefinement();
        unregisterVehicleConnectionReceiver();
        removeActivityUpdates();
        stopLocationUpdates();
        stopMotionSensors();
        stopSignificantMotionWatch();
        if (dataErasureInProgress) {
            // Clear again after callbacks are detached so no final location
            // callback can recreate native state during the stop race.
            DriveSenseNativeTripStore.eraseAllForDataRights(this);
        }
        if (speechController != null) speechController.shutdown();
        removeTrackingNotification();
        if (mainHandler != null) mainHandler.removeCallbacksAndMessages(null);
        // Teardown checkpoint writes above are synchronous, so nothing durable is lost here.
        if (checkpointExecutor != null) {
            checkpointExecutor.shutdownNow();
            checkpointExecutor = null;
        }
        serviceRunning = false;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static boolean start(Context context) {
        cancelAutoTrackingOffNotification(context);
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_START);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    static void startManualTrip(Context context, long startTimeMs, String tripId) {
        cancelAutoTrackingOffNotification(context);
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_START_MANUAL_TRIP);
        intent.putExtra(EXTRA_START_TIME_MS, startTimeMs > 0L ? startTimeMs : System.currentTimeMillis());
        intent.putExtra(EXTRA_TRIP_ID, tripId == null ? "" : tripId);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception error) {
            Log.w(TAG, "Could not start manual trip", error);
        }
    }

    static void discardManualTrip(Context context, boolean keepArmed) {
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_DISCARD_MANUAL_TRIP);
        intent.putExtra(EXTRA_KEEP_ARMED, keepArmed);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception error) {
            Log.w(TAG, "Could not discard manual trip", error);
        }
    }

    static void endActiveTrip(Context context, boolean keepArmed) {
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_END_TRIP);
        intent.putExtra(EXTRA_KEEP_ARMED, keepArmed);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception error) {
            Log.w(TAG, "Could not end active trip", error);
        }
    }

    static void stop(Context context) {
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_STOP);
        DriveSenseNativeTripStore.setServiceEnabled(context, false);
        try {
            context.stopService(intent);
        } catch (Exception ignored) {
            DriveSenseNativeTripStore.setServiceEnabled(context, false);
        }
        cancelTrackingNotification(context);
        showAutoTrackingOffNotification(context);
    }

    static void stopForDataErasure(Context context) {
        dataErasureInProgress = true;
        DriveSenseNativeTripStore.setServiceEnabled(context, false);
        try {
            context.stopService(new Intent(context, DriveSenseAutoTrackingService.class));
        } catch (Exception ignored) {
            // The caller still clears every native store below.
        }
        cancelTrackingNotification(context);
        cancelAutoTrackingOffNotification(context);
    }

    static void clearNotificationStateForDataErasure(Context context) {
        context.getSharedPreferences(NOTIFICATION_PREFS, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit();
        cancelTrackingNotification(context);
        cancelAutoTrackingOffNotification(context);
    }

    static void stopSpeech(Context context) {
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_STOP_SPEECH);
        ContextCompat.startForegroundService(context, intent);
    }

    static void showAutoTrackingOffNotification(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        ensureAutoStatusChannel(context);
        Intent intent = new Intent(context, MainActivity.class);
        intent.putExtra("deeplink", "drivesense://settings");
        intent.setData(Uri.parse("drivesense://settings"));
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            3,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, AUTO_STATUS_CHANNEL_ID)
            .setSmallIcon(context.getResources().getIdentifier("ic_stat_drivesense", "drawable", context.getPackageName()))
            .setContentTitle("Auto tracking off")
            .setContentText("Road Sage will not start trips until auto tracking is turned back on.")
            .setStyle(new NotificationCompat.BigTextStyle().bigText("Road Sage will not start trips until auto tracking is turned back on."))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        NotificationManagerCompat.from(context).notify(NOTIF_ID_AUTO_STATUS, builder.build());
    }

    private static void cancelAutoTrackingOffNotification(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIF_ID_AUTO_STATUS);
    }

    private static void cancelTrackingNotification(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIF_ID_TRACKING_START);
    }

    private static void ensureAutoStatusChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            AUTO_STATUS_CHANNEL_ID,
            "Auto Tracking Status",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Status updates when Road Sage auto tracking is turned on or off.");
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    static void handleActivityBroadcast(Context context, DetectedActivity activity) {
        if (activity == null) return;
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;

        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_ACTIVITY);
        intent.putExtra(EXTRA_ACTIVITY_TYPE, activity.getType());
        intent.putExtra(EXTRA_ACTIVITY_CONFIDENCE, activity.getConfidence());
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception error) {
            Log.w(TAG, "Could not handle activity broadcast", error);
        }
    }

    private void handleActivity(int type, int confidence) {
        long now = System.currentTimeMillis();
        int previousActivityType = lastActivityType;
        int previousActivityConfidence = lastActivityConfidence;
        lastActivityType = type;
        lastActivityConfidence = confidence;
        lastActivityUpdateMs = now;
        boolean previousWasVehicle =
            previousActivityType == DetectedActivity.IN_VEHICLE &&
            previousActivityConfidence >= MIN_VEHICLE_CONFIDENCE;
        boolean nextLooksLikeExit =
            (
                type == DetectedActivity.STILL ||
                type == DetectedActivity.WALKING ||
                type == DetectedActivity.RUNNING ||
                type == DetectedActivity.ON_FOOT
            ) &&
            confidence >= 70;
        if (isTripActive() && previousWasVehicle && nextLooksLikeExit) {
            lastVehicleExitTransitionMs = now;
            recordTimeline(
                "vehicle_exit_transition",
                "Activity changed from in vehicle to still or on foot.",
                "activity_transition",
                lastKnownSpeedKmh,
                stillSinceMs > 0L ? Math.max(0L, (now - stillSinceMs) / 1000L) : 0L,
                maxDriftSinceStopM
            );
        }
        if (isTripActive() && !hasLocationPermission()) {
            handleLocationPermissionLost("activity_update_permission_missing");
        }
        double speedKmh = lastKnownSpeedKmh;
        boolean onFoot = (type == DetectedActivity.WALKING ||
            type == DetectedActivity.RUNNING ||
            type == DetectedActivity.ON_BICYCLE) &&
            confidence >= 75;
        boolean leftVehicle = onFoot && speedKmh <= WALKING_SPEED_CUTOFF_KMH;

        boolean isStill = type == DetectedActivity.STILL && confidence >= MIN_STILL_CONFIDENCE;
        boolean inVehicle = type == DetectedActivity.IN_VEHICLE && confidence >= MIN_VEHICLE_CONFIDENCE;
        boolean staleParkedSignal = isTripActive() &&
            lastLocationMs > 0L &&
            now - lastLocationMs >= STALE_LOCATION_STOP_MS &&
            (isStill || onFoot);
        boolean speedStopped = speedKmh < STATIONARY_SPEED_KMH || staleParkedSignal;
        boolean gpsStable = maxDriftSinceStopM < GPS_STILL_DRIFT_M && !Double.isNaN(stoppedAnchorLat);
        boolean gpsVeryStable = maxDriftSinceStopM < GPS_VEHICLE_DRIFT_M && !Double.isNaN(stoppedAnchorLat);
        boolean gpsParkedStable = maxDriftSinceStopM < GPS_VEHICLE_DRIFT_M && !Double.isNaN(stoppedAnchorLat);
        boolean gpsParkedRelaxed = maxDriftSinceStopM < GPS_VEHICLE_DRIFT_RELAXED_M && !Double.isNaN(stoppedAnchorLat);

        updateArmedTier(type, confidence, now);

        if (!isTripActive()) {
            if (inVehicle &&
                lastKnownSpeedKmh >= AUTO_START_SPEED_KMH &&
                armedMovingSinceMs > 0L &&
                now - armedMovingSinceMs >= AUTO_START_MOVING_MS) {
                startCandidateTrip("activity_in_vehicle_moving", armedPreviousLocation);
            }
            return;
        }

        if (candidateTrip && onFoot) {
            if (speedKmh <= WALKING_SPEED_CUTOFF_KMH) {
                discardCandidate("movement_looked_like_walking", "Candidate discarded: walking/running signal detected", keepServiceArmed());
            }
            return;
        }

        if (inVehicle && !speedStopped) {
            stillSinceMs = 0L;
            nonVehicleSinceMs = 0L;
            stoppedAnchorLat = Double.NaN;
            stoppedAnchorLng = Double.NaN;
            maxDriftSinceStopM = 0.0d;
            return;
        }

        long stoppedElapsed = stillSinceMs == 0L ? 0L : now - stillSinceMs;
        if (speedKmh < 2.0d &&
            ((stoppedElapsed >= AUTO_STOP_PARKED_GPS_STABLE_MS && gpsParkedStable) ||
                (stoppedElapsed >= AUTO_STOP_PARKED_GPS_RELAXED_MS && gpsParkedRelaxed))) {
            finishTrip("parked_gps_stable", true);
            return;
        }

        if (leftVehicle) {
            if (nonVehicleSinceMs == 0L) nonVehicleSinceMs = now;
            if (now - nonVehicleSinceMs >= AUTO_STOP_FOOT_MS) {
                finishTrip("left_vehicle_on_foot", true);
                return;
            }
            return;
        }

        if (isStill && speedStopped) {
            if (stillSinceMs == 0L) stillSinceMs = now;
            long elapsed = now - stillSinceMs;
            long threshold = gpsStable ? AUTO_STOP_STILL_STABLE_MS : AUTO_STOP_STILL_DRIFT_MS;
            if (elapsed >= threshold) {
                finishTrip(gpsStable ? "still_activity_stable_gps" : "still_activity_timeout", true);
                return;
            }
            return;
        }

        if (inVehicle && speedStopped) {
            if (stillSinceMs == 0L) stillSinceMs = now;
            long elapsed = now - stillSinceMs;
            if (elapsed >= AUTO_STOP_IN_VEHICLE_MS && gpsVeryStable) {
                finishTrip("in_vehicle_parked_stable", true);
                // FIX: Keep the original four-minute fast path for very stable parked GPS.
                return;
            }
            if (elapsed >= AUTO_STOP_IN_VEHICLE_EXTENDED_MS &&
                maxDriftSinceStopM < GPS_VEHICLE_DRIFT_RELAXED_M &&
                !Double.isNaN(stoppedAnchorLat)) {
                finishTrip("in_vehicle_parked_relaxed_drift", true);
                // FIX: Finish after six minutes when GPS drift is relaxed but still parked-like.
                return;
            }
            if (elapsed >= AUTO_STOP_IN_VEHICLE_ABSOLUTE_MS && lastKnownSpeedKmh < 2.0d) {
                finishTrip("in_vehicle_zero_speed_timeout", true);
                // FIX: Finish after eight minutes at near-zero speed even if GPS drift is noisy.
                return;
            }
            return;
        }

        if (type == DetectedActivity.UNKNOWN && speedStopped) {
            if (stillSinceMs == 0L) stillSinceMs = now;
            long elapsed = now - stillSinceMs;
            if (elapsed >= AUTO_STOP_NO_ACTIVITY_MS && gpsStable) {
                finishTrip("unknown_activity_stable_gps", true);
                return;
            }
            return;
        }

        if (!speedStopped) {
            stillSinceMs = 0L;
            nonVehicleSinceMs = 0L;
        }
    }

    private void registerVehicleConnectionReceiver() {
        if (vehicleConnectionReceiver != null) return;
        vehicleConnectionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null ||
                    !BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(intent.getAction()) ||
                    !isTripActive() ||
                    !isSettingEnabled("obd_bluetooth_enabled", false)) {
                    return;
                }
                lastVehicleDisconnectMs = System.currentTimeMillis();
                recordTimeline(
                    "vehicle_connection_disconnected",
                    "The configured OBD Bluetooth vehicle connection disconnected.",
                    "obd_bluetooth_disconnect",
                    lastKnownSpeedKmh,
                    stillSinceMs > 0L
                        ? Math.max(0L, (lastVehicleDisconnectMs - stillSinceMs) / 1000L)
                        : 0L,
                    maxDriftSinceStopM
                );
            }
        };
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(vehicleConnectionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(vehicleConnectionReceiver, filter);
            }
        } catch (Exception ignored) {
            vehicleConnectionReceiver = null;
        }
    }

    private void unregisterVehicleConnectionReceiver() {
        if (vehicleConnectionReceiver == null) return;
        try {
            unregisterReceiver(vehicleConnectionReceiver);
        } catch (Exception error) {
            Log.w(TAG, "Could not unregister vehicle connection receiver", error);
        }
        vehicleConnectionReceiver = null;
    }

    private void requestActivityUpdates() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        activityClient.requestActivityUpdates(ACTIVITY_UPDATE_INTERVAL_MS, activityIntent);
    }

    private void removeActivityUpdates() {
        activityClient.removeActivityUpdates(activityIntent);
    }

    private void startTripIfNeeded() {
        startCandidateTrip("activity_in_vehicle", null);
    }

    private void startTripIfNeeded(String reason) {
        startCandidateTrip(reason, null);
    }

    private void startManualTrip(long startTimeMs, String tripId) {
        if (!retryPendingCompletedTripSave(false)) {
            recordDiagnostic("manual_start_blocked", "Manual trip start delayed until the previous trip is safely queued.", "pending_completed_trip", 0d, 0L, 0d);
            updateNotification("Previous trip recovery pending - open Road Sage");
            return;
        }
        long normalizedStartMs = startTimeMs > 0L ? startTimeMs : System.currentTimeMillis();
        if (isTripActive()) {
            if (nativeManualTrip) {
                recordDiagnostic("manual_native_trip_already_active", "Native manual trip already active.", "manual_start_ignored", lastKnownSpeedKmh, 0L, maxDriftSinceStopM);
                return;
            }
            finishTrip("manual_trip_replaced_existing_native_trip", true);
            if (!retryPendingCompletedTripSave(true)) {
                recordDiagnostic("manual_start_blocked", "Manual trip start delayed until the previous trip is safely queued.", "pending_completed_trip", 0d, 0L, 0d);
                return;
            }
        }
        activeStartMs = normalizedStartMs;
        lastVehicleExitTransitionMs = 0L;
        lastVehicleDisconnectMs = 0L;
        activePoints = new JSONArray();
        activeTimeline = new JSONArray();
        activeMotionSamples = new JSONArray();
        activeMotionSamplesDropped = 0;
        activeCaptureProfile = resolveCaptureProfile();
        activeMotionSampleBytes = 0L;
        activeCaptureTier = null;
        activeCaptureTierSinceMs = 0L;
        lastCaptureTierEvalMs = 0L;
        activeCaptureTierSeconds.clear();
        activeIncidentEvents = new JSONArray();
        activeTelemetryEvents = new JSONArray();
        hasPermissionLoss = false;
        previousLocation = null;
        armedPreviousLocation = null;
        armedMovingSinceMs = 0L;
        stillSinceMs = 0L;
        nonVehicleSinceMs = 0L;
        lastKnownSpeedKmh = 0.0d;
        lastLocationMs = 0L;
        stoppedAnchorLat = Double.NaN;
        stoppedAnchorLng = Double.NaN;
        maxDriftSinceStopM = 0.0d;
        nativeMicroSteerCount = 0;
        lastNativeProxyWindowMs = 0L;
        lastNativePhoneWindowMs = 0L;
        lastLiveNotificationMs = 0L;
        lastLiveStatusMs = 0L;
        lastActiveCheckpointMs = 0L;
        checkpointRecoveryEndOverrideMs = 0L;
        resetNativeAlertState();
        nativeAutoStartReason = "manual_button";
        lastNativeAutoStopReason = "";
        nativeTripStartSource = "native_manual";
        nativeManualTripId = tripId == null ? "" : tripId.trim();
        nativeRecoveryTripId = nativeManualTripId.isEmpty()
            ? DriveSenseNativeTripStore.newTripId()
            : nativeManualTripId;
        nativeManualTrip = true;
        candidateTrip = false;
        candidateNearParked = false;
        candidateConfirmedMs = normalizedStartMs;
        recentHeadings.clear();
        recentSpeedsKmh.clear();
        nativeHeadingDriftWindow.clear();
        resetMotionState();
        recordTimeline("manual_start", "Native manual trip started.", "manual_button", 0d, 0L, 0d);
        recordDiagnostic("manual_start", "Native manual trip started.", "manual_button", 0d, 0L, 0d);
        updateNotification("Manual trip recording in background");
        startMotionSensors();
        startTripLocationUpdates();
        speakTrackingReadyOnce();
    }

    private void startCandidateTrip(String reason, @Nullable Location triggerLocation) {
        if (isTripActive()) return;
        cancelParkingRefinement("new_trip_started");
        if (!retryPendingCompletedTripSave(false)) return;
        long triggerMs = triggerLocation != null && triggerLocation.getTime() > 0L
            ? triggerLocation.getTime()
            : System.currentTimeMillis();
        activeStartMs = triggerMs;
        lastVehicleExitTransitionMs = 0L;
        lastVehicleDisconnectMs = 0L;
        activePoints = new JSONArray();
        activeTimeline = new JSONArray();
        activeMotionSamples = new JSONArray();
        activeMotionSamplesDropped = 0;
        activeCaptureProfile = resolveCaptureProfile();
        activeMotionSampleBytes = 0L;
        activeCaptureTier = null;
        activeCaptureTierSinceMs = 0L;
        lastCaptureTierEvalMs = 0L;
        activeCaptureTierSeconds.clear();
        activeIncidentEvents = new JSONArray();
        activeTelemetryEvents = new JSONArray();
        hasPermissionLoss = false;
        previousLocation = null;
        armedPreviousLocation = null;
        armedMovingSinceMs = 0L;
        stillSinceMs = 0L;
        nonVehicleSinceMs = 0L;
        lastKnownSpeedKmh = 0.0d;
        lastLocationMs = 0L;
        stoppedAnchorLat = Double.NaN;
        stoppedAnchorLng = Double.NaN;
        maxDriftSinceStopM = 0.0d;
        nativeMicroSteerCount = 0;
        lastNativeProxyWindowMs = 0L;
        lastNativePhoneWindowMs = 0L;
        lastLiveNotificationMs = 0L;
        lastLiveStatusMs = 0L;
        lastActiveCheckpointMs = 0L;
        checkpointRecoveryEndOverrideMs = 0L;
        resetNativeAlertState();
        nativeAutoStartReason = reason;
        lastNativeAutoStopReason = "";
        nativeTripStartSource = "native_auto";
        nativeManualTripId = "";
        nativeRecoveryTripId = DriveSenseNativeTripStore.newTripId();
        nativeManualTrip = false;
        candidateTrip = true;
        candidateNearParked = isInParkingCooldown(triggerLocation);
        candidateConfirmedMs = 0L;
        recentHeadings.clear();
        recentSpeedsKmh.clear();
        nativeHeadingDriftWindow.clear();
        resetMotionState();
        if (triggerLocation != null) {
            double triggerSpeedKmh = triggerLocation.hasSpeed()
                ? Math.max(0d, triggerLocation.getSpeed() * 3.6d)
                : Math.max(0d, lastKnownSpeedKmh);
            lastKnownSpeedKmh = triggerSpeedKmh;
            lastLocationMs = triggerLocation.getTime() > 0L ? triggerLocation.getTime() : triggerMs;
            activePoints.put(locationToJson(triggerLocation, triggerSpeedKmh));
            previousLocation = triggerLocation;
        }
        recordTimeline("candidate_started", "Candidate started: speed >= 5 km/h for 2 seconds", reason, lastKnownSpeedKmh, 0L, maxDriftSinceStopM);
        recordDiagnostic("candidate_started", "Candidate started: speed >= 5 km/h for 2 seconds", reason, lastKnownSpeedKmh, 0L, maxDriftSinceStopM);
        if (candidateNearParked) {
            recordTimeline("candidate_hidden_parking_cooldown", "Candidate hidden due to parking cooldown zone", "near_last_parked_location", lastKnownSpeedKmh, 0L, 0d);
            recordDiagnostic("candidate_hidden_parking_cooldown", "Candidate hidden due to parking cooldown zone", "near_last_parked_location", lastKnownSpeedKmh, 0L, 0d);
        }
        updateNotification(candidateNearParked ? "Checking movement near parked car" : "Checking movement");
        startMotionSensors();
        startTripLocationUpdates();
    }

    private boolean isTripActive() {
        return activeStartMs > 0L && activePoints != null;
    }

    private void startTripLocationUpdates() {
        if (!hasLocationPermission()) {
            handleLocationPermissionLost("trip_location_permission_missing");
            return;
        }

        if (activeCaptureTier == null) {
            activeCaptureTier = resolveCaptureTier();
            activeCaptureTierSinceMs = System.currentTimeMillis();
        }

        stopLocationUpdates();
        LocationRequest request = new LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            activeCaptureTier.locationIntervalMs
        )
            .setMinUpdateIntervalMillis(activeCaptureTier.minUpdateIntervalMs)
            .setMinUpdateDistanceMeters(5f)
            .build();

        try {
            locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
        } catch (SecurityException exception) {
            handleLocationPermissionLost("trip_location_permission_security_exception");
        }
        recordDiagnostic("armed_location_watch", "Waiting for movement after a parked or ended trip.", "armed_gps_backup", lastKnownSpeedKmh, 0L, 0d);
    }

    private Handler mainHandler() {
        if (mainHandler == null) mainHandler = new Handler(Looper.getMainLooper());
        return mainHandler;
    }

    private CaptureTierPolicy.Decision resolveCaptureTier() {
        boolean adaptiveEnabled = !"off".equalsIgnoreCase(getSettingString("adaptive_capture_mode", "guard"));
        return CaptureTierPolicy.decide(
            deviceBatteryPercent(),
            deviceIsCharging(),
            deviceThermalStatus(),
            adaptiveEnabled
        );
    }

    /**
     * Re-evaluates the capture tier on the in-trip location tick and re-issues the
     * LocationRequest only when the tier actually changes, so an unchanged decision
     * costs nothing. Every transition lands on the timeline and in diagnostics: a
     * silently degraded stretch of a drive would be worse than no governor at all.
     */
    private void evaluateCaptureTier(long nowMs) {
        if (!isTripActive()) return;
        if (nowMs - lastCaptureTierEvalMs < CAPTURE_TIER_EVAL_INTERVAL_MS) return;
        lastCaptureTierEvalMs = nowMs;

        CaptureTierPolicy.Decision next = resolveCaptureTier();
        CaptureTierPolicy.Decision current = activeCaptureTier;
        if (current == null) {
            activeCaptureTier = next;
            activeCaptureTierSinceMs = nowMs;
            return;
        }
        if (current.tier.equals(next.tier)) return;

        accumulateCaptureTierSeconds(current.tier, nowMs);
        activeCaptureTier = next;
        activeCaptureTierSinceMs = nowMs;
        recordTimeline(
            "capture_tier_" + next.tier,
            next.label + ": " + next.reason,
            next.reason,
            lastKnownSpeedKmh,
            0L,
            maxDriftSinceStopM
        );
        recordDiagnostic(
            "capture_tier_" + next.tier,
            next.label + ": " + next.reason,
            next.reason,
            lastKnownSpeedKmh,
            0L,
            maxDriftSinceStopM
        );
        startTripLocationUpdates();
    }

    private void accumulateCaptureTierSeconds(String tier, long nowMs) {
        if (tier == null || activeCaptureTierSinceMs <= 0L || nowMs <= activeCaptureTierSinceMs) return;
        long seconds = (nowMs - activeCaptureTierSinceMs) / 1000L;
        if (seconds <= 0L) return;
        Long existing = activeCaptureTierSeconds.get(tier);
        activeCaptureTierSeconds.put(tier, (existing == null ? 0L : existing) + seconds);
    }

    private int deviceBatteryPercent() {
        try {
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery == null) return -1;
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            return level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : -1;
        } catch (Exception ignored) {
            return -1;
        }
    }

    private boolean deviceIsCharging() {
        try {
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery == null) return false;
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            return status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL;
        } catch (Exception ignored) {
            return false;
        }
    }

    private int deviceThermalStatus() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return PowerManager.THERMAL_STATUS_NONE;
        try {
            PowerManager manager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return manager == null ? PowerManager.THERMAL_STATUS_NONE : manager.getCurrentThermalStatus();
        } catch (Exception ignored) {
            return PowerManager.THERMAL_STATUS_NONE;
        }
    }

    /**
     * Entry point used when arming and after a trip ends: always start fully responsive so a
     * new drive is never missed, then let {@link #updateArmedTier} back off if the vehicle
     * turns out to be parked.
     */
    private void startArmedLocationUpdates() {
        armedTier = ArmedTier.HIGH_ACCURACY;
        armedStillSinceMs = 0L;
        stopSignificantMotionWatch();
        applyArmedLocationRequest();
    }

    private void applyArmedLocationRequest() {
        if (!hasLocationPermission()) {
            return;
        }

        stopLocationUpdates();
        // Dormant deliberately holds no location request at all; activity recognition and the
        // significant-motion trigger are what wake it back up.
        if (armedTier == ArmedTier.DORMANT) return;

        boolean balanced = armedTier == ArmedTier.BALANCED;
        int priority = balanced ? Priority.PRIORITY_BALANCED_POWER_ACCURACY : Priority.PRIORITY_HIGH_ACCURACY;
        LocationRequest request = new LocationRequest.Builder(priority, balanced ? 30_000L : 5_000L)
            .setMinUpdateIntervalMillis(balanced ? 15_000L : 2_000L)
            .setMinUpdateDistanceMeters(5f)
            .build();

        try {
            locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
        } catch (SecurityException error) {
            Log.w(TAG, "Could not start armed location updates", error);
        }
    }

    /**
     * Backs armed GPS off while the vehicle is confidently parked. Holding
     * PRIORITY_HIGH_ACCURACY 24/7 drains the battery for no benefit and makes the app a
     * bigger target for the OEM battery managers that kill tracking in the first place.
     */
    private void updateArmedTier(int type, int confidence, long now) {
        if (isTripActive()) {
            armedStillSinceMs = 0L;
            return;
        }

        boolean confidentlyStill = type == DetectedActivity.STILL && confidence >= MIN_STILL_CONFIDENCE;
        if (!confidentlyStill) {
            armedStillSinceMs = 0L;
            applyArmedTier(ArmedTier.HIGH_ACCURACY, "activity_moving");
            return;
        }

        if (armedStillSinceMs == 0L) armedStillSinceMs = now;
        long stillForMs = now - armedStillSinceMs;
        if (stillForMs >= ARMED_DORMANT_AFTER_STILL_MS) {
            applyArmedTier(ArmedTier.DORMANT, "still_sustained");
        } else if (stillForMs >= ARMED_BALANCED_AFTER_STILL_MS) {
            applyArmedTier(ArmedTier.BALANCED, "still_confirmed");
        }
    }

    private void applyArmedTier(ArmedTier tier, String reason) {
        if (armedTier == tier) return;
        armedTier = tier;
        if (tier == ArmedTier.DORMANT) {
            startSignificantMotionWatch();
        } else {
            stopSignificantMotionWatch();
        }
        applyArmedLocationRequest();
        recordDiagnostic(
            "armed_tier_" + tier.name().toLowerCase(Locale.US),
            "Armed GPS tier changed to " + tier.name().toLowerCase(Locale.US) + ".",
            reason,
            lastKnownSpeedKmh,
            0L,
            0d
        );
    }

    private void startSignificantMotionWatch() {
        if (sensorManager == null || significantMotionListener != null) return;
        if (significantMotionSensor == null) {
            significantMotionSensor = sensorManager.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);
        }
        if (significantMotionSensor == null) return;
        significantMotionListener = new TriggerEventListener() {
            @Override
            public void onTrigger(TriggerEvent event) {
                // Trigger sensors are one-shot; clear the handle before re-arming GPS so a
                // later dormant transition can register a fresh listener.
                significantMotionListener = null;
                escalateArmedTierForMotion("significant_motion");
            }
        };
        try {
            sensorManager.requestTriggerSensor(significantMotionListener, significantMotionSensor);
        } catch (Exception error) {
            significantMotionListener = null;
            Log.w(TAG, "Could not register significant motion trigger", error);
        }
    }

    private void stopSignificantMotionWatch() {
        if (sensorManager != null && significantMotionSensor != null && significantMotionListener != null) {
            try {
                sensorManager.cancelTriggerSensor(significantMotionListener, significantMotionSensor);
            } catch (Exception error) {
                Log.w(TAG, "Could not cancel significant motion trigger", error);
            }
        }
        significantMotionListener = null;
    }

    private void escalateArmedTierForMotion(String reason) {
        if (isTripActive()) return;
        armedStillSinceMs = 0L;
        applyArmedTier(ArmedTier.HIGH_ACCURACY, reason);
    }

    private void stopLocationUpdates() {
        if (locationClient != null && locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback);
        }
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void handleLocationPermissionLost(String reason) {
        if (hasPermissionLoss) return;
        hasPermissionLoss = true;
        recordTimeline("location_permission_lost", "Location permission lost during trip.", reason, lastKnownSpeedKmh, 0L, maxDriftSinceStopM);
        recordDiagnostic("location_permission_lost", "Location permission lost during trip.", reason, lastKnownSpeedKmh, 0L, maxDriftSinceStopM);
        updateNotification("GPS permission lost - trip data may have gaps");
    }

    private void recordLocation(Location location) {
        if (location == null) return;
        if (location.hasAccuracy() && location.getAccuracy() > MAX_ACCURACY_M) return;

        if (!isTripActive()) {
            if (!retryPendingCompletedTripSave(false)) return;
            boolean stopAfterRefinement = pendingParkingRefinementStopServiceAfter;
            recordParkingRefinementFix(location);
            if (stopAfterRefinement) return;
            handleArmedLocation(location);
            return;
        }

        Location priorLocation = previousLocation;
        double priorSpeedKmh = lastKnownSpeedKmh;
        double speedKmh = location.hasSpeed() ? Math.max(0d, location.getSpeed() * 3.6d) : 0d;
        if (previousLocation != null) {
            long dtMs = Math.max(1L, location.getTime() - previousLocation.getTime());
            double distanceKm = previousLocation.distanceTo(location) / 1000d;
            double distanceM = distanceKm * 1000d;
            double impliedSpeed = distanceKm / (dtMs / 3_600_000d);
            double reportedSpeed = location.hasSpeed() ? speedKmh : impliedSpeed;
            if (isNoise(distanceM, impliedSpeed, reportedSpeed, accuracyOf(previousLocation), accuracyOf(location)) && dtMs < 45_000L) return;
            if (impliedSpeed > MAX_SPEED_KMH || reportedSpeed > MAX_SPEED_KMH) return;
            speedKmh = reliableSpeed(impliedSpeed, reportedSpeed);
        }
        lastKnownSpeedKmh = speedKmh;
        lastLocationMs = location.getTime() > 0L ? location.getTime() : System.currentTimeMillis();

        double bearing = Double.NaN;
        if (location.hasBearing()) bearing = location.getBearing();
        else if (previousLocation != null) bearing = previousLocation.bearingTo(location);
        if (!candidateTrip && !Double.isNaN(bearing)) updatePhoneUseProxy(bearing, speedKmh, location.getAccuracy(), location.getTime() > 0L ? location.getTime() : System.currentTimeMillis());
        if (!candidateTrip && !Double.isNaN(bearing)) updateHeadingDriftWindow(bearing, speedKmh, location.getTime() > 0L ? location.getTime() : System.currentTimeMillis());

        activePoints.put(locationToJson(location, speedKmh));
        previousLocation = location;
        if (candidateTrip) {
            reviewCandidate(false);
            if (!isTripActive()) return;
        }
        if (!candidateTrip) {
            speakTrackingReadyOnce();
            evaluateNativeLiveAlerts(priorLocation, location, priorSpeedKmh, speedKmh);
        }

        if (speedKmh >= STATIONARY_SPEED_KMH) {
            stoppedAnchorLat = Double.NaN;
            stoppedAnchorLng = Double.NaN;
            maxDriftSinceStopM = 0.0d;
            stillSinceMs = 0L;
            nonVehicleSinceMs = 0L;
        } else {
            if (stillSinceMs == 0L) {
                stillSinceMs = lastLocationMs > 0L ? lastLocationMs : System.currentTimeMillis();
            }
            if (Double.isNaN(stoppedAnchorLat)) {
                stoppedAnchorLat = location.getLatitude();
                stoppedAnchorLng = location.getLongitude();
                maxDriftSinceStopM = 0.0d;
            } else {
                double driftM = haversineKm(stoppedAnchorLat, stoppedAnchorLng, location.getLatitude(), location.getLongitude()) * 1000d;
                maxDriftSinceStopM = Math.max(maxDriftSinceStopM, driftM);
            }
            if (maybeFinishForStaleActivityGpsFallback()) return;
        }

        if (!candidateTrip) {
            evaluatePossibleIncident();
        }
        evaluateCaptureTier(System.currentTimeMillis());
        persistActiveTripStatusIfDue();
        updateLiveTripNotification(false);
    }

    private void handleArmedLocation(Location location) {
        long now = System.currentTimeMillis();
        double speedKmh = location.hasSpeed() ? Math.max(0d, location.getSpeed() * 3.6d) : 0d;
        if (armedPreviousLocation != null) {
            long dtMs = Math.max(1L, location.getTime() - armedPreviousLocation.getTime());
            if (dtMs > 0L && dtMs <= 60_000L) {
                double distanceKm = armedPreviousLocation.distanceTo(location) / 1000d;
                double impliedSpeed = distanceKm / (dtMs / 3_600_000d);
                if (!location.hasSpeed()) speedKmh = impliedSpeed;
                else speedKmh = Math.max(speedKmh, impliedSpeed);
            }
        }

        lastKnownSpeedKmh = Math.max(0d, speedKmh);
        lastLocationMs = location.getTime() > 0L ? location.getTime() : now;

        if (speedKmh >= AUTO_START_SPEED_KMH) {
            // Movement seen on a balanced-accuracy fix: restore full accuracy immediately so
            // the trip start is timed from responsive GPS rather than a 30s sample.
            escalateArmedTierForMotion("armed_gps_movement");
            if (armedMovingSinceMs == 0L) armedMovingSinceMs = now;
            if (now - armedMovingSinceMs >= AUTO_START_MOVING_MS) {
                startCandidateTrip("armed_gps_movement", location);
                return;
            }
        } else if (speedKmh < STATIONARY_SPEED_KMH) {
            armedMovingSinceMs = 0L;
        }

        armedPreviousLocation = location;
    }

    private JSONObject locationToJson(Location location, double speedKmh) {
        JSONObject point = new JSONObject();
        try {
            point.put("lat", location.getLatitude());
            point.put("lng", location.getLongitude());
            point.put("speed_kmh", Math.max(0d, speedKmh));
            if (location.hasBearing()) point.put("heading", location.getBearing());
            else point.put("heading", JSONObject.NULL);
            if (location.hasAccuracy()) point.put("accuracy", location.getAccuracy());
            else point.put("accuracy", JSONObject.NULL);
            if (location.hasAltitude()) point.put("altitude", location.getAltitude());
            else point.put("altitude", JSONObject.NULL);
            long pointTimeMs = location.getTime() > 0L ? location.getTime() : System.currentTimeMillis();
            ZonedDateTime localTime = Instant.ofEpochMilli(pointTimeMs).atZone(ZoneId.systemDefault());
            point.put("timestamp", iso(pointTimeMs));
            point.put("timezone_id", localTime.getZone().getId());
            point.put("utc_offset_minutes", localTime.getOffset().getTotalSeconds() / 60);
        } catch (JSONException error) {
            Log.w(TAG, "Could not location to json", error);
        }
        return point;
    }

    private void updateForegroundNotification(String message) {
        persistActiveTripStatus(System.currentTimeMillis());
        Notification notification = buildNotification(message);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID_TRACKING_START, notification);
            return;
        }
        try {
            ServiceCompat.startForeground(
                this,
                NOTIF_ID_TRACKING_START,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            );
        } catch (Exception error) {
            try {
                ServiceCompat.startForeground(
                    this,
                    NOTIF_ID_TRACKING_START,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                );
            } catch (Exception ignored) {
                startForeground(NOTIF_ID_TRACKING_START, notification);
            }
        }
    }

    private boolean keepServiceArmed() {
        return DriveSenseNativeTripStore.isServiceEnabled(this);
    }

    private boolean isStrongOnFootSignal() {
        if (!isActivityStateFresh(System.currentTimeMillis())) return false;
        return (lastActivityType == DetectedActivity.WALKING ||
            lastActivityType == DetectedActivity.RUNNING ||
            lastActivityType == DetectedActivity.ON_BICYCLE) &&
            lastActivityConfidence >= 75;
    }

    private boolean isVehicleSignal() {
        if (!isActivityStateFresh(System.currentTimeMillis())) return false;
        return lastActivityType == DetectedActivity.IN_VEHICLE && lastActivityConfidence >= MIN_VEHICLE_CONFIDENCE;
    }

    private boolean isActivityStateFresh(long nowMs) {
        return lastActivityUpdateMs > 0L && nowMs - lastActivityUpdateMs <= ACTIVITY_STATE_MAX_AGE_MS;
    }

    private boolean maybeFinishForStaleActivityGpsFallback() {
        if (!isTripActive() || candidateTrip) return false;
        long now = System.currentTimeMillis();
        if (isActivityStateFresh(now)) return false;
        long stoppedElapsed = stillSinceMs == 0L ? 0L : Math.max(0L, now - stillSinceMs);
        if (lastKnownSpeedKmh < 2.0d &&
            stoppedElapsed >= AUTO_STOP_PARKED_GPS_RELAXED_MS &&
            maxDriftSinceStopM < GPS_VEHICLE_DRIFT_RELAXED_M &&
            !Double.isNaN(stoppedAnchorLat)) {
            long stoppedSeconds = stoppedElapsed / 1000L;
            recordTimeline("activity_recognition_stale", "Activity recognition stale; GPS-only stop fallback used.", "activity_state_stale", lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
            recordDiagnostic("activity_recognition_stale", "Activity recognition stale; GPS-only stop fallback used.", "activity_state_stale", lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
            finishTrip("activity_recognition_stale", true);
            return true;
        }
        return false;
    }

    private boolean isInParkingCooldown(@Nullable Location triggerLocation) {
        if (triggerLocation == null) return false;
        JSONObject parked = DriveSenseNativeTripStore.getLastParkedLocation(this);
        if (parked == null) return false;
        long parkedMs = parked.optLong("timestamp_ms", 0L);
        if (parkedMs <= 0L && parked.has("timestamp")) {
            parkedMs = parseIso(parked.optString("timestamp", ""));
        }
        if (parkedMs <= 0L || System.currentTimeMillis() - parkedMs > PARKING_COOLDOWN_MS) return false;
        double lat = parked.optDouble("lat", Double.NaN);
        double lng = parked.optDouble("lng", Double.NaN);
        if (Double.isNaN(lat) || Double.isNaN(lng)) return false;
        double distanceM = haversineKm(lat, lng, triggerLocation.getLatitude(), triggerLocation.getLongitude()) * 1000d;
        return distanceM <= PARKING_COOLDOWN_RADIUS_M;
    }

    private void reviewCandidate(boolean forceFinal) {
        if (!candidateTrip || activePoints == null) return;
        long now = System.currentTimeMillis();
        TripStats stats = calculateStats(activePoints, activeStartMs, now);
        int stablePoints = countStablePoints(activePoints);
        double requiredDistanceM = candidateNearParked ? CANDIDATE_CONFIRM_DISTANCE_COOLDOWN_M : CANDIDATE_CONFIRM_DISTANCE_M;
        double requiredSpeedKmh = candidateNearParked ? CANDIDATE_CONFIRM_SPEED_COOLDOWN_KMH : CANDIDATE_CONFIRM_SPEED_KMH;
        int requiredStablePoints = candidateNearParked ? CANDIDATE_MIN_STABLE_POINTS_COOLDOWN : CANDIDATE_MIN_STABLE_POINTS;

        if (isStrongOnFootSignal() && stats.maxSpeedKmh <= WALKING_SPEED_CUTOFF_KMH) {
            discardCandidate("movement_looked_like_walking", "Candidate discarded: walking/running signal detected", keepServiceArmed());
            return;
        }

        boolean enoughGps = stablePoints >= requiredStablePoints;
        boolean enoughDistance = stats.distanceKm * 1000d >= requiredDistanceM;
        boolean vehicleSpeedSegment = stats.maxSpeedKmh >= requiredSpeedKmh;
        boolean vehicleActivity = isVehicleSignal();

        if (enoughGps && enoughDistance && vehicleSpeedSegment && !isStrongOnFootSignal()) {
            candidateTrip = false;
            candidateConfirmedMs = now;
            recordTimeline("candidate_confirmed", "Candidate confirmed: vehicle-like movement detected", vehicleActivity ? "activity_in_vehicle" : "vehicle_speed_distance", stats.maxSpeedKmh, 0L, 0d);
            recordDiagnostic("candidate_confirmed", "Candidate confirmed: vehicle-like movement detected", vehicleActivity ? "activity_in_vehicle" : "vehicle_speed_distance", stats.maxSpeedKmh, 0L, 0d);
            recordTimeline("auto_start", "Native trip started.", nativeAutoStartReason, stats.maxSpeedKmh, 0L, 0d);
            recordDiagnostic("auto_start", "Native trip started.", nativeAutoStartReason, stats.maxSpeedKmh, 0L, 0d);
            updateLiveTripNotification(true);
            speakTrackingReadyOnce();
            return;
        }

        long candidateAgeMs = Math.max(0L, now - activeStartMs);
        if (forceFinal || candidateAgeMs >= CANDIDATE_MAX_REVIEW_MS) {
            String discardReason = "gps_movement_too_short";
            String title = "Candidate discarded: GPS movement too short";
            if (!vehicleSpeedSegment) {
                discardReason = "no_vehicle_speed_segment";
                title = "Candidate discarded: no vehicle-speed segment";
            } else if (!enoughGps) {
                discardReason = "unstable_gps_drift";
                title = "Candidate discarded: unstable GPS drift";
            }
            discardCandidate(discardReason, title, keepServiceArmed());
        }
    }

    private int countStablePoints(JSONArray points) {
        int count = 0;
        if (points == null) return count;
        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;
            double accuracy = point.optDouble("accuracy", MAX_ACCURACY_M);
            if (accuracy <= MAX_ACCURACY_M) count++;
        }
        return count;
    }

    private void discardCandidate(String reason, String title, boolean keepArmed) {
        if (!isTripActive()) return;
        long now = System.currentTimeMillis();
        TripStats stats = calculateStats(activePoints, activeStartMs, now);
        recordTimeline("trip_discarded", title, reason, stats.maxSpeedKmh, 0L, 0d);
        recordDiagnostic("trip_discarded", title, reason, stats.maxSpeedKmh, 0L, 0d);
        discardActiveTrip(reason, keepArmed);
    }

    private void discardActiveTrip(String reason, boolean keepArmed) {
        if (!isTripActive()) return;
        boolean discardedManualTrip = nativeManualTrip;
        activePoints = null;
        activeTimeline = null;
        activeMotionSamples = null;
        activeMotionSamplesDropped = 0;
        activeMotionSampleBytes = 0L;
        activeCaptureTier = null;
        activeCaptureTierSinceMs = 0L;
        lastCaptureTierEvalMs = 0L;
        activeCaptureTierSeconds.clear();
        activeIncidentEvents = null;
        activeTelemetryEvents = null;
        hasPermissionLoss = false;
        activeStartMs = 0L;
        previousLocation = null;
        armedPreviousLocation = null;
        armedMovingSinceMs = 0L;
        stillSinceMs = 0L;
        nonVehicleSinceMs = 0L;
        lastKnownSpeedKmh = 0.0d;
        lastLocationMs = 0L;
        stoppedAnchorLat = Double.NaN;
        stoppedAnchorLng = Double.NaN;
        maxDriftSinceStopM = 0.0d;
        candidateTrip = false;
        candidateNearParked = false;
        nativeManualTrip = false;
        nativeTripStartSource = "native_auto";
        nativeManualTripId = "";
        nativeRecoveryTripId = "";
        candidateConfirmedMs = 0L;
        lastLiveNotificationMs = 0L;
        lastLiveStatusMs = 0L;
        lastActiveCheckpointMs = 0L;
        checkpointRecoveryEndOverrideMs = 0L;
        resetNativeAlertState();
        recentHeadings.clear();
        recentSpeedsKmh.clear();
        nativeHeadingDriftWindow.clear();
        resetMotionState();
        DriveSenseActiveTripCheckpointStore.clear(this);
        stopMotionSensors();
        stopLocationUpdates();
        if (keepArmed && DriveSenseNativeTripStore.isServiceEnabled(this)) {
            startArmedLocationUpdates();
        }
        updateNotification(discardedManualTrip ? "Manual trip ended" : "Ready when you start moving");
    }

    private TailTrimResult trimParkedTail(JSONArray points, String reason, long endMs) {
        TailTrimResult result = new TailTrimResult();
        result.points = points != null ? points : new JSONArray();
        result.endMs = endMs;
        if (points == null || points.length() < 4 || !isParkedStopReason(reason)) return result;

        int lastVehicleIndex = -1;
        for (int i = points.length() - 1; i >= 0; i--) {
            JSONObject point = points.optJSONObject(i);
            if (point != null && point.optDouble("speed_kmh", 0d) >= CANDIDATE_CONFIRM_SPEED_KMH) {
                lastVehicleIndex = i;
                break;
            }
        }
        if (lastVehicleIndex < 0 || lastVehicleIndex >= points.length() - 1) return result;

        int keepThrough = Math.min(lastVehicleIndex + 1, points.length() - 1);
        for (int i = lastVehicleIndex + 1; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point != null && point.optDouble("speed_kmh", 0d) < STATIONARY_SPEED_KMH) {
                keepThrough = i;
                break;
            }
        }

        int removed = points.length() - (keepThrough + 1);
        if (removed <= 0) return result;

        JSONArray trimmed = new JSONArray();
        for (int i = 0; i <= keepThrough; i++) {
            JSONObject point = points.optJSONObject(i);
            if (point != null) trimmed.put(point);
        }
        JSONObject finalPoint = trimmed.optJSONObject(trimmed.length() - 1);
        result.points = trimmed;
        result.removedPoints = removed;
        if (finalPoint != null) result.endMs = parseIso(finalPoint.optString("timestamp"));
        return result;
    }

    private void finishTrip() {
        finishTrip("service_finish", true);
    }

    private void finishTrip(boolean keepArmed) {
        finishTrip("service_finish", keepArmed);
    }

    private void finishTrip(String reason, boolean keepArmed) {
        if (!isTripActive()) return;
        if (candidateTrip) {
            reviewCandidate(true);
            if (!isTripActive() || candidateTrip) return;
        }

        long endMs = checkpointRecoveryEndOverrideMs > 0L
            ? checkpointRecoveryEndOverrideMs
            : System.currentTimeMillis();
        checkpointRecoveryEndOverrideMs = 0L;
        persistActiveTripCheckpoint(endMs, true);
        JSONArray points = activePoints;
        JSONArray timeline = activeTimeline != null ? activeTimeline : new JSONArray();
        JSONArray motionSamples = activeMotionSamples != null ? activeMotionSamples : new JSONArray();
        int motionSamplesDropped = activeMotionSamplesDropped;
        CaptureFidelityProfile.Profile captureProfile = activeCaptureProfile;
        long motionSampleBytes = activeMotionSampleBytes;
        if (activeCaptureTier != null) accumulateCaptureTierSeconds(activeCaptureTier.tier, endMs);
        JSONObject captureTierSeconds = new JSONObject();
        boolean captureThrottled = false;
        for (java.util.Map.Entry<String, Long> entry : activeCaptureTierSeconds.entrySet()) {
            try {
                captureTierSeconds.put(entry.getKey(), entry.getValue());
            } catch (JSONException ignored) {
                // A single unreportable tier must not cost the trip its payload.
            }
            if (!CaptureTierPolicy.TIER_NORMAL.equals(entry.getKey()) && entry.getValue() > 0L) {
                captureThrottled = true;
            }
        }
        // Redacted at construction in evaluatePossibleIncident; re-checked here so a
        // trip recovered from a checkpoint written by an older build cannot journal
        // raw in-zone incident coordinates.
        JSONArray incidentEvents = PrivacyZoneChecker.redactEvents(
            this,
            activeIncidentEvents != null ? activeIncidentEvents : new JSONArray()
        );
        long startMs = activeStartMs;
        boolean startedNearParked = candidateNearParked;
        long confirmedMs = candidateConfirmedMs;
        boolean permissionLoss = hasPermissionLoss;
        String completedStartSource = nativeTripStartSource == null || nativeTripStartSource.trim().isEmpty()
            ? "native_auto"
            : nativeTripStartSource;
        boolean completedManualTrip = nativeManualTrip;
        String completedManualTripId = nativeManualTripId == null ? "" : nativeManualTripId;
        String completedRecoveryTripId = nativeRecoveryTripId == null ? "" : nativeRecoveryTripId;
        long stoppedSeconds = stillSinceMs > 0L ? Math.max(0L, (endMs - stillSinceMs) / 1000L) : 0L;
        JSONObject parkingSignals = buildParkingSignals(
            reason,
            stoppedSeconds,
            lastKnownSpeedKmh,
            maxDriftSinceStopM,
            completedManualTrip
        );
        lastNativeAutoStopReason = reason;
        recordTimeline("ending_review", "Ending review started.", reason, lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
        TailTrimResult tailTrim = trimParkedTail(points, reason, endMs);
        points = tailTrim.points;
        endMs = tailTrim.endMs;
        if (tailTrim.removedPoints > 0) {
            recordTimeline("tail_trimmed", "Trip tail trimmed: walking detected after parking", reason, lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
            recordDiagnostic("tail_trimmed", "Trip tail trimmed: walking detected after parking", reason, lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
        }
        recordTimeline("trip_ended", "Native trip ended.", reason, lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
        recordDiagnostic("trip_ended", "Native trip ended.", reason, lastKnownSpeedKmh, stoppedSeconds, maxDriftSinceStopM);
        activePoints = null;
        activeTimeline = null;
        activeMotionSamples = null;
        activeMotionSamplesDropped = 0;
        activeMotionSampleBytes = 0L;
        activeCaptureTier = null;
        activeCaptureTierSinceMs = 0L;
        lastCaptureTierEvalMs = 0L;
        activeCaptureTierSeconds.clear();
        activeIncidentEvents = null;
        activeTelemetryEvents = null;
        hasPermissionLoss = false;
        activeStartMs = 0L;
        previousLocation = null;
        armedPreviousLocation = null;
        armedMovingSinceMs = 0L;
        stillSinceMs = 0L;
        nonVehicleSinceMs = 0L;
        lastKnownSpeedKmh = 0.0d;
        lastLocationMs = 0L;
        stoppedAnchorLat = Double.NaN;
        stoppedAnchorLng = Double.NaN;
        maxDriftSinceStopM = 0.0d;
        candidateTrip = false;
        nativeManualTrip = false;
        nativeTripStartSource = "native_auto";
        nativeManualTripId = "";
        nativeRecoveryTripId = "";
        lastLiveNotificationMs = 0L;
        lastLiveStatusMs = 0L;
        lastActiveCheckpointMs = 0L;
        resetNativeAlertState();
        recentHeadings.clear();
        recentSpeedsKmh.clear();
        nativeHeadingDriftWindow.clear();
        resetMotionState();
        stopMotionSensors();
        stopLocationUpdates();
        if (keepArmed && DriveSenseNativeTripStore.isServiceEnabled(this)) {
            startArmedLocationUpdates();
        }
        updateNotification(isParkedStopReason(reason) ? "Parked - waiting for movement" : "Ready when you start moving");

        TripStats stats = calculateStats(points, startMs, endMs);
        if (points.length() < MIN_POINTS_TO_SAVE || stats.durationSeconds < MIN_TRIP_MS / 1000L || stats.distanceKm < MIN_TRIP_KM) {
            DriveSenseActiveTripCheckpointStore.clear(this);
            recordDiagnostic("trip_discarded", "Native trip was too short to save.", reason, 0d, stoppedSeconds, 0d);
            return;
        }
        if (stats.nightClassification != null && stats.nightClassification.optBoolean("custom_fallback_used", false)) {
            recordDiagnostic(
                "night_detection_fallback",
                "Night detection used the custom fallback window.",
                stats.nightClassification.optString("fallback_reason", "gps_coordinates_unavailable"),
                stats.maxSpeedKmh,
                stoppedSeconds,
                maxDriftSinceStopM
            );
        }

        JSONObject trip = new JSONObject();
        String tripId = completedManualTrip && !completedManualTripId.trim().isEmpty()
            ? completedManualTripId
            : !completedRecoveryTripId.trim().isEmpty()
                ? completedRecoveryTripId
                : DriveSenseNativeTripStore.newTripId();
        try {
            JSONObject phoneUsage = DriveSensePhoneUsageTracker.queryTripUsage(this, startMs, endMs);
            trip.put("id", tripId);
            trip.put("start_time", iso(startMs));
            trip.put("end_time", iso(endMs));
            trip.put("duration_seconds", stats.durationSeconds);
            trip.put("wall_clock_duration_seconds", stats.wallClockDurationSeconds);
            trip.put("gap_seconds", stats.gapSeconds);
            trip.put("distance_km", round(stats.distanceKm, 3));
            trip.put("avg_speed_kmh", round(stats.avgSpeedKmh, 1));
            trip.put("avg_running_speed_kmh", round(stats.avgRunningSpeedKmh, 1));
            trip.put("max_speed_kmh", round(stats.maxSpeedKmh, 1));
            trip.put("idle_time_seconds", stats.idleSeconds);
            trip.put("night_driving", stats.nightDriving);
            if (stats.nightClassification != null) {
                trip.put("night_classification", stats.nightClassification);
                trip.put("trip_timezone_id", stats.nightClassification.optString("timezone_id", ZoneId.systemDefault().getId()));
                trip.put("trip_utc_offset_minutes", stats.nightClassification.optInt("utc_offset_minutes", 0));
            }
            trip.put("route_points", PrivacyZoneChecker.redactRoutePoints(this, points));
            trip.put("motion_samples", motionSamples);
            trip.put("native_motion_sample_count", motionSamples.length());
            // Retention thins the oldest half rather than evicting the trip's start,
            // so coverage stays whole-trip; this says how much resolution was traded.
            trip.put("native_motion_samples_dropped", motionSamplesDropped);
            trip.put("motion_capture_profile", buildMotionCaptureProfile(
                captureProfile,
                motionSamples,
                motionSamplesDropped,
                motionSampleBytes,
                stats.durationSeconds
            ));
            trip.put("driving_events", incidentEvents);
            trip.put("possible_crash_count", incidentEvents.length());
            trip.put("emergency_workflow_pending", hasPendingEmergencyWorkflow(incidentEvents));
            trip.put("score_overall", JSONObject.NULL);
            trip.put("score_safety", JSONObject.NULL);
            trip.put("score_smoothness", JSONObject.NULL);
            trip.put("score_confidence_label", "unavailable");
            trip.put("score_safety_confidence", "unavailable");
            trip.put("score_smoothness_confidence", "unavailable");
            trip.put("needs_rescore", true);
            trip.put("score_status", "pending_javascript_scoring");
            trip.put("harsh_brakes_count", 0);
            trip.put("rapid_accel_count", 0);
            trip.put("sharp_turns_count", 0);
            trip.put("speeding_events_count", 0);
            trip.put("status", "completed");
            trip.put("background_tracking", true);
            trip.put("start_source", completedStartSource);
            if (completedManualTrip) trip.put("manual_session_id", tripId);
            trip.put("native_trip_state", completedManualTrip ? "manual_confirmed" : "confirmed");
            trip.put("native_candidate_started_at", iso(startMs));
            if (confirmedMs > 0L) trip.put("native_candidate_confirmed_at", iso(confirmedMs));
            trip.put("native_candidate_near_parked", startedNearParked);
            trip.put("native_tail_trimmed_points", tailTrim.removedPoints);
            trip.put("native_auto_start_reason", nativeAutoStartReason);
            trip.put("native_auto_stop_reason", lastNativeAutoStopReason);
            trip.put("native_tracking_timeline", timeline);
            JSONObject speedLimitContext = new JSONObject();
            speedLimitContext.put("status", "deferred_review");
            speedLimitContext.put("source", "native_auto_tracking");
            speedLimitContext.put("review_required", true);
            speedLimitContext.put("reason", "background_tracking_cannot_confirm_posted_signs_while_driving");
            trip.put("speed_limit_context", speedLimitContext);
            trip.put("speed_limit_review_required", true);
            trip.put("speed_limit_review_reason", "Background tracking cannot confirm posted signs while driving.");
            JSONArray flags = new JSONArray();
            if (permissionLoss) flags.put("location_permission_loss");
            if (captureThrottled) flags.put("capture_throttled");
            if (flags.length() > 0) {
                trip.put("data_quality_flags", flags);
                // A permission loss is a real gap; a governor throttle is reduced
                // resolution, not missing data, so only the former lowers confidence.
                if (permissionLoss) trip.put("score_confidence_flag", "data_gap_detected");
            }
            if (captureTierSeconds.length() > 0) trip.put("capture_tier_seconds", captureTierSeconds);
            trip.put("native_phone_proxy_count", nativeMicroSteerCount);
            trip.put("native_phone_usage_access_granted", phoneUsage.optBoolean("usage_access_granted", false));
            trip.put("native_phone_usage_events", phoneUsage.optJSONArray("events") != null ? phoneUsage.optJSONArray("events") : new JSONArray());
            trip.put("native_phone_usage_event_count", phoneUsage.optInt("event_count", 0));
            trip.put("native_phone_usage_total_seconds", phoneUsage.optLong("total_seconds", 0L));
            trip.put("created_at", iso(endMs));
            trip.put("updated_at", iso(endMs));
        } catch (JSONException error) {
            Log.w(TAG, "Could not finish trip", error);
        }

        boolean completedTripSaved = DriveSenseNativeTripStore.addCompletedTrip(this, trip);
        if (!completedTripSaved) {
            pendingCompletedTrip = trip;
            nextCompletedTripSaveRetryMs = System.currentTimeMillis() + COMPLETED_TRIP_SAVE_RETRY_MS;
            recordDiagnostic(
                "trip_save_failed",
                "Native trip ended but could not be queued for app recovery.",
                reason,
                stats.maxSpeedKmh,
                stoppedSeconds,
                maxDriftSinceStopM
            );
            updateNotification("Trip save failed - open Road Sage");
            return;
        }
        recordDiagnostic(
            "trip_saved",
            "Native trip safely queued for app import.",
            reason,
            stats.maxSpeedKmh,
            stoppedSeconds,
            maxDriftSinceStopM
        );
        DriveSenseActiveTripCheckpointStore.clear(this);
        JSONObject rawParkingEndpoint = points.optJSONObject(points.length() - 1);
        boolean privateParkingEndpoint = rawParkingEndpoint != null && PrivacyZoneChecker.isInsidePrivacyZone(
            this,
            rawParkingEndpoint.optDouble("lat", Double.NaN),
            rawParkingEndpoint.optDouble("lng", Double.NaN)
        );
        JSONObject parkedResolution = isAdministrativeStopReason(reason) || privateParkingEndpoint
            ? null
            : DriveSenseParkingResolver.resolve(points, endMs, parkingSignals);
        String parkingSource = tailTrim.removedPoints > 0
            ? "native_trimmed_parked_tail"
            : isParkedStopReason(reason) ? "native_parking_stop" : "native_trip_end";
        if (isAdministrativeStopReason(reason)) {
            // Disabling/restarting the tracking service is not evidence that the
            // vehicle parked. Preserve the already-confirmed car location instead
            // of replacing it with the phone's walking/shutdown endpoint.
            recordDiagnostic(
                "parking_update_ignored",
                "Administrative tracking shutdown preserved the current parked car.",
                reason,
                stats.maxSpeedKmh,
                stoppedSeconds,
                maxDriftSinceStopM
            );
        } else if (parkedResolution != null && parkedResolution.has("ignored_reason")) {
            recordDiagnostic(
                "parking_update_ignored",
                "Transient stop did not replace the current parked car.",
                parkedResolution.optString("ignored_reason", "transient_stop"),
                stats.maxSpeedKmh,
                stoppedSeconds,
                maxDriftSinceStopM
            );
        } else if (parkedResolution != null) {
            DriveSenseNativeTripStore.saveLastParkedLocation(
                this,
                parkedResolution.optDouble("lat"),
                parkedResolution.optDouble("lng"),
                endMs,
                tripId,
                parkingSource,
                parkedResolution
            );
            if (!privateParkingEndpoint) {
                beginParkingRefinement(
                    points,
                    parkedResolution,
                    parkingSignals,
                    endMs,
                    tripId,
                    parkingSource,
                    !keepArmed
                );
            }
        } else {
            // Preserve the last safe public coordinate for recovery/history, but
            // make the newest parking outcome authoritative. The widget can now
            // distinguish a protected stop from a GPS result that needs review.
            DriveSenseNativeTripStore.suppressLastParkedLocation(
                this,
                endMs,
                tripId,
                privateParkingEndpoint ? "privacy_zone" : "trip_end_unavailable"
            );
        }
        candidateConfirmedMs = 0L;
        candidateNearParked = false;
        sendTripCompletedNotification(trip, stats);
        // Personal detection-calibration progress is evaluated here so a step
        // reached on a background trip is reported straight away, rather than
        // the next time the user opens the Settings page.
        CalibrationMilestoneNotifier.recordCompletedTrip(this, stats == null ? 0d : stats.distanceKm);
    }

    private JSONObject buildParkingSignals(
        String reason,
        long stoppedSeconds,
        double lastMovingSpeedKmh,
        double gpsDriftM,
        boolean manualEnd
    ) {
        JSONObject signals = new JSONObject();
        try {
            signals.put("stop_reason", reason == null ? "" : reason);
            signals.put("stopped_seconds", Math.max(0L, stoppedSeconds));
            signals.put("last_moving_speed_kmh", Math.max(0d, lastMovingSpeedKmh));
            signals.put("gps_drift_m", Double.isFinite(gpsDriftM) ? gpsDriftM : JSONObject.NULL);
            signals.put("activity_type", activityTypeName(lastActivityType));
            signals.put("activity_confidence", Math.max(0, Math.min(100, lastActivityConfidence)));
            signals.put("manual_end", manualEnd);
            signals.put(
                "vehicle_exit_transition",
                lastVehicleExitTransitionMs >= activeStartMs && lastVehicleExitTransitionMs > 0L
            );
            signals.put(
                "vehicle_disconnected",
                lastVehicleDisconnectMs >= activeStartMs && lastVehicleDisconnectMs > 0L
            );
            signals.put("parking_learning_profile", readParkingLearningProfile());
        } catch (JSONException error) {
            Log.w(TAG, "Could not finish trip", error);
        }
        return signals;
    }

    private JSONObject readParkingLearningProfile() {
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(PARKING_LEARNING_KEY, null);
            return raw == null || raw.trim().isEmpty() ? new JSONObject() : new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static long parkingRefinementDurationMs(JSONObject signals) {
        JSONObject profile = signals != null ? signals.optJSONObject("parking_learning_profile") : null;
        long requested = profile != null ? profile.optLong("refinement_duration_ms", PARKING_REFINEMENT_WINDOW_MS) : PARKING_REFINEMENT_WINDOW_MS;
        return Math.max(PARKING_REFINEMENT_WINDOW_MS, Math.min(60_000L, requested));
    }

    private static int parkingRefinementMaxFixes(JSONObject signals) {
        JSONObject profile = signals != null ? signals.optJSONObject("parking_learning_profile") : null;
        int requested = profile != null ? profile.optInt("refinement_max_fixes", PARKING_REFINEMENT_MAX_FIXES) : PARKING_REFINEMENT_MAX_FIXES;
        return Math.max(PARKING_REFINEMENT_MAX_FIXES, Math.min(12, requested));
    }

    private void beginParkingRefinement(
        JSONArray points,
        JSONObject initialResolution,
        JSONObject signals,
        long parkingTimestampMs,
        String tripId,
        String source,
        boolean stopServiceAfter
    ) {
        if (!hasLocationPermission() || points == null || initialResolution == null) return;
        clearPendingParkingRefinement();
        try {
            pendingParkingRefinementPoints = new JSONArray(points.toString());
        } catch (Exception ignored) {
            pendingParkingRefinementPoints = points;
        }
        pendingParkingRefinementSignals = signals;
        pendingParkingTimestampMs = parkingTimestampMs;
        pendingParkingTripId = tripId == null ? "" : tripId;
        pendingParkingSource = source == null ? "native_trip_end" : source;
        pendingParkingAnchorLat = initialResolution.optDouble("lat", Double.NaN);
        pendingParkingAnchorLng = initialResolution.optDouble("lng", Double.NaN);
        pendingParkingRefinementFixCount = 0;
        pendingParkingRefinementStopServiceAfter = stopServiceAfter;
        pendingParkingRefinementDeadlineMs = System.currentTimeMillis() + parkingRefinementDurationMs(signals);
        if (!startParkingRefinementLocationUpdates()) {
            cancelParkingRefinement("location_permission_lost");
            return;
        }
        updateNotification("Parked - refining location");
        recordDiagnostic(
            "parking_refinement_started",
            "Collecting a short post-stop GPS cluster.",
            "post_stop_refinement",
            0d,
            0L,
            0d
        );
    }

    private void recordParkingRefinementFix(Location location) {
        if (pendingParkingRefinementPoints == null || location == null) return;
        long nowMs = System.currentTimeMillis();
        if (nowMs > pendingParkingRefinementDeadlineMs) {
            finishParkingRefinement("window_complete");
            return;
        }
        double speedKmh = location.hasSpeed() ? Math.max(0d, location.getSpeed() * 3.6d) : 0d;
        if (speedKmh > PARKING_REFINEMENT_MOVING_SPEED_KMH) {
            cancelParkingRefinement("vehicle_moved");
            return;
        }
        double driftM = haversineKm(
            pendingParkingAnchorLat,
            pendingParkingAnchorLng,
            location.getLatitude(),
            location.getLongitude()
        ) * 1000d;
        if (!Double.isFinite(driftM) || driftM > PARKING_REFINEMENT_MAX_DRIFT_M) {
            cancelParkingRefinement("location_drifted");
            return;
        }
        if (PrivacyZoneChecker.isInsidePrivacyZone(
            this,
            location.getLatitude(),
            location.getLongitude()
        )) {
            DriveSenseNativeTripStore.suppressLastParkedLocation(
                this,
                pendingParkingTimestampMs,
                pendingParkingTripId,
                "privacy_zone"
            );
            cancelParkingRefinement("privacy_zone");
            return;
        }

        JSONObject point = locationToJson(location, speedKmh);
        try {
            point.put("parking_refinement", true);
        } catch (JSONException error) {
            Log.w(TAG, "Could not record parking refinement fix", error);
        }
        pendingParkingRefinementPoints.put(point);
        pendingParkingRefinementFixCount++;
        if (
            pendingParkingRefinementFixCount >= parkingRefinementMaxFixes(pendingParkingRefinementSignals) ||
            nowMs >= pendingParkingRefinementDeadlineMs
        ) {
            finishParkingRefinement("fix_target_reached");
        }
    }

    private void finishParkingRefinement(String reason) {
        if (pendingParkingRefinementPoints == null) return;
        if (pendingParkingRefinementFixCount <= 0) {
            cancelParkingRefinement("no_refinement_fixes");
            return;
        }
        JSONObject resolution = DriveSenseParkingResolver.resolve(
            pendingParkingRefinementPoints,
            System.currentTimeMillis(),
            pendingParkingRefinementSignals
        );
        if (resolution != null && resolution.has("ignored_reason")) {
            recordDiagnostic(
                "parking_refinement_ignored",
                "Post-stop fixes still looked like a transient vehicle stop.",
                resolution.optString("ignored_reason", "transient_stop"),
                0d,
                pendingParkingRefinementFixCount,
                0d
            );
        } else if (resolution != null) {
            DriveSenseNativeTripStore.saveLastParkedLocation(
                this,
                resolution.optDouble("lat", Double.NaN),
                resolution.optDouble("lng", Double.NaN),
                pendingParkingTimestampMs,
                pendingParkingTripId,
                pendingParkingSource + "_refined",
                resolution
            );
            recordDiagnostic(
                "parking_refinement_completed",
                "Parking location confidence updated from post-stop fixes.",
                reason,
                0d,
                pendingParkingRefinementFixCount,
                resolution.optDouble("spread_m", 0d)
            );
        } else {
            recordDiagnostic(
                "parking_refinement_unavailable",
                "Post-stop fixes did not form a trustworthy parking cluster.",
                reason,
                0d,
                pendingParkingRefinementFixCount,
                0d
            );
        }
        boolean stopServiceAfter = pendingParkingRefinementStopServiceAfter;
        clearPendingParkingRefinement();
        completeParkingRefinementLifecycle(stopServiceAfter);
    }

    private void cancelParkingRefinement(String reason) {
        if (pendingParkingRefinementPoints == null) return;
        recordDiagnostic(
            "parking_refinement_cancelled",
            "Post-stop parking refinement stopped.",
            reason,
            0d,
            pendingParkingRefinementFixCount,
            0d
        );
        boolean stopServiceAfter = pendingParkingRefinementStopServiceAfter;
        clearPendingParkingRefinement();
        completeParkingRefinementLifecycle(stopServiceAfter);
    }

    private boolean startParkingRefinementLocationUpdates() {
        if (!hasLocationPermission()) return false;
        stopLocationUpdates();
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5_000L)
            .setMinUpdateIntervalMillis(1_000L)
            .build();
        try {
            locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
            return true;
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private void completeParkingRefinementLifecycle(boolean stopServiceAfter) {
        if (stopServiceAfter || !DriveSenseNativeTripStore.isServiceEnabled(this)) {
            stopLocationUpdates();
            stopSelf();
            return;
        }
        startArmedLocationUpdates();
        updateNotification("Parked - waiting for movement");
    }

    private void clearPendingParkingRefinement() {
        pendingParkingRefinementPoints = null;
        pendingParkingRefinementSignals = null;
        pendingParkingRefinementDeadlineMs = 0L;
        pendingParkingTimestampMs = 0L;
        pendingParkingTripId = "";
        pendingParkingSource = "";
        pendingParkingAnchorLat = Double.NaN;
        pendingParkingAnchorLng = Double.NaN;
        pendingParkingRefinementFixCount = 0;
        pendingParkingRefinementStopServiceAfter = false;
    }

    private TripStats calculateStats(JSONArray points, long startMs, long endMs) {
        TripStats stats = new TripStats();
        stats.wallClockDurationSeconds = Math.max(0L, (endMs - startMs) / 1000L);
        stats.durationSeconds = stats.wallClockDurationSeconds;
        if (points == null || points.length() < 2) return stats;
        NightSettings nightSettings = readNightSettings();
        NightClassificationResult nightClassification = classifyTripNightDriving(points, nightSettings);
        stats.nightDriving = nightClassification.isNight;
        stats.nightClassification = nightClassification.metadata;

        // Accumulate in fractional seconds so sub-second sample gaps are not truncated to
        // zero (which would drop the segment entirely) or rounded up (which would inflate
        // implied speed). Rounded into the long stats fields once the loop finishes.
        double gapSecondsAccum = 0d;
        double movingSecondsAccum = 0d;
        double idleSecondsAccum = 0d;

        for (int i = 1; i < points.length(); i++) {
            JSONObject prev = points.optJSONObject(i - 1);
            JSONObject curr = points.optJSONObject(i);
            if (prev == null || curr == null) continue;

            double distance = haversineKm(
                prev.optDouble("lat"),
                prev.optDouble("lng"),
                curr.optDouble("lat"),
                curr.optDouble("lng")
            );
            if (!Double.isFinite(distance)) continue;
            long prevMs = parseIso(prev.optString("timestamp"));
            long currMs = parseIso(curr.optString("timestamp"));
            double dt = (currMs - prevMs) / 1000d;
            if (!(dt > 0d)) continue;
            double impliedSpeed = distance / (dt / 3600d);
            double reportedSpeed = curr.optDouble("speed_kmh", impliedSpeed);
            if (dt > STATS_MAX_SAMPLE_GAP_SECONDS) {
                gapSecondsAccum += dt;
                stats.gapCount += 1;
                continue;
            }
            if (impliedSpeed > MAX_SPEED_KMH || reportedSpeed > MAX_SPEED_KMH) continue;

            double distanceM = distance * 1000d;
            if (isNoise(distanceM, impliedSpeed, reportedSpeed, prev.optDouble("accuracy", 0d), curr.optDouble("accuracy", 0d))) {
                continue;
            }

            double speed = reliableSpeed(impliedSpeed, reportedSpeed);
            stats.distanceKm += distance;
            stats.maxSpeedKmh = Math.max(stats.maxSpeedKmh, speed);
            stats.speedSamples += 1;

            if (speed >= STATIONARY_SPEED_KMH) movingSecondsAccum += dt;
            else idleSecondsAccum += dt;

        }

        stats.gapSeconds = Math.round(gapSecondsAccum);
        stats.movingSeconds = Math.round(movingSecondsAccum);
        stats.idleSeconds = Math.round(idleSecondsAccum);

        JSONObject last = points.optJSONObject(points.length() - 1);
        if (last != null) {
            long lastMs = parseIso(last.optString("timestamp"));
            long terminalIdleSeconds = Math.max(0L, (endMs - lastMs) / 1000L);
            double lastSpeed = last.optDouble("speed_kmh", 0d);
            if (lastSpeed < STATIONARY_SPEED_KMH && terminalIdleSeconds > 0L) {
                stats.idleSeconds += Math.min(terminalIdleSeconds, MAX_TERMINAL_IDLE_SECONDS);
            }
        }

        stats.durationSeconds = Math.max(0L, stats.wallClockDurationSeconds - stats.gapSeconds);
        stats.avgSpeedKmh = stats.durationSeconds > 0L && stats.distanceKm > 0d
            ? stats.distanceKm / (stats.durationSeconds / 3600d)
            : 0d;
        stats.avgRunningSpeedKmh = stats.movingSeconds > 0L && stats.distanceKm > 0d
            ? stats.distanceKm / (stats.movingSeconds / 3600d)
            : 0d;
        if (stats.speedSamples == 0) stats.maxSpeedKmh = 0d;
        return stats;
    }

    private double accuracyOf(Location location) {
        return location != null && location.hasAccuracy() ? location.getAccuracy() : 0d;
    }

    private double noiseFloor(double previousAccuracy, double currentAccuracy) {
        double effectiveAccuracy = Math.max(previousAccuracy, currentAccuracy);
        return Math.max(MIN_POINT_DISTANCE_M, Math.min(25d, effectiveAccuracy * 0.6d));
    }

    private boolean isNoise(double distanceM, double impliedSpeedKmh, double reportedSpeedKmh, double previousAccuracy, double currentAccuracy) {
        double floor = noiseFloor(previousAccuracy, currentAccuracy);
        // Frequent samples can each be shorter than the accuracy-derived floor. A trusted
        // vehicle-speed reading can support those short steps only when it agrees with real
        // coordinate displacement, otherwise a stale speed reading turns duplicate fixes or a
        // poor-accuracy wobble into accepted movement.
        // Must stay in step with calculateSegmentMetrics in src/lib/tripEngine.js.
        boolean reportedShowsVehicleMovement = reportedSpeedKmh >= MIN_TRUSTED_SPEED_KMH &&
            distanceM >= MIN_REPORTED_MOVEMENT_DISPLACEMENT_M &&
            Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= REPORTED_SPEED_AGREEMENT_KMH;
        boolean tinyMovement = distanceM < floor && !reportedShowsVehicleMovement;
        boolean displacementSaysStill = impliedSpeedKmh < STATIONARY_SPEED_KMH && distanceM < floor * 1.5d;
        boolean reportedDisagrees = reportedSpeedKmh < MIN_TRUSTED_SPEED_KMH && displacementSaysStill;
        return tinyMovement || reportedDisagrees;
    }

    private double reliableSpeed(double impliedSpeedKmh, double reportedSpeedKmh) {
        boolean reportedCloseToImplied = Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= REPORTED_SPEED_AGREEMENT_KMH;
        boolean reportedTooLowForMovement = reportedSpeedKmh < MIN_TRUSTED_SPEED_KMH &&
            impliedSpeedKmh >= MIN_TRUSTED_SPEED_KMH &&
            !reportedCloseToImplied;
        boolean reportedStationaryWhileMoving = reportedSpeedKmh < STATIONARY_SPEED_KMH &&
            impliedSpeedKmh >= MIN_TRUSTED_SPEED_KMH;
        return Math.max(0d, (reportedTooLowForMovement || reportedStationaryWhileMoving)
            ? impliedSpeedKmh
            : reportedSpeedKmh);
    }

    private void startMotionSensors() {
        if (sensorManager == null || activeMotionSamples == null) return;
        if (linearAccelerationSensor != null) {
            sensorManager.registerListener(this, linearAccelerationSensor, SensorManager.SENSOR_DELAY_GAME);
        }
        if (gyroscopeSensor != null) {
            sensorManager.registerListener(this, gyroscopeSensor, SensorManager.SENSOR_DELAY_GAME);
        }
    }

    private void stopMotionSensors() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
    }

    private void resetMotionState() {
        lastAx = Float.NaN;
        lastAy = Float.NaN;
        lastAz = Float.NaN;
        lastGx = Float.NaN;
        lastGy = Float.NaN;
        lastGz = Float.NaN;
        lastLinearSensorMs = 0L;
        lastGyroSensorMs = 0L;
        lastMotionSampleMs = 0L;
        lastLongitudinalAccelerationMs2 = 0.0d;
        lastLateralG = 0.0d;
        lastHeadingRateDegS = 0.0d;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.sensor == null || event.values == null || event.values.length < 3) return;
        if (!isTripActive() || activeMotionSamples == null) return;

        long now = System.currentTimeMillis();
        int sensorType = event.sensor.getType();
        if (sensorType == Sensor.TYPE_LINEAR_ACCELERATION) {
            lastAx = event.values[0];
            lastAy = event.values[1];
            lastAz = event.values[2];
            lastLinearSensorMs = now;
            appendMotionSample(now);
        } else if (sensorType == Sensor.TYPE_GYROSCOPE) {
            lastGx = event.values[0];
            lastGy = event.values[1];
            lastGz = event.values[2];
            lastGyroSensorMs = now;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // The scoring model uses sample magnitudes and axes; Android sensor accuracy is not currently scored.
    }

    /**
     * Describes what the IMU buffer actually captured, so forensics can say
     * "motion covered the whole trip at ~2.5 Hz" instead of silently implying
     * full-rate coverage across a long drive.
     */
    private JSONObject buildMotionCaptureProfile(
        CaptureFidelityProfile.Profile profile,
        JSONArray motionSamples,
        int droppedSamples,
        long bytesPerSample,
        long durationSeconds
    ) {
        JSONObject captured = new JSONObject();
        try {
            CaptureFidelityProfile.Profile resolved = profile == null
                ? CaptureFidelityProfile.resolve(null)
                : profile;
            int retained = motionSamples == null ? 0 : motionSamples.length();
            captured.put("fidelity", resolved.fidelity);
            captured.put("budget", resolved.effectiveSampleBudget(bytesPerSample));
            captured.put("event_windows_enabled", resolved.eventWindowsEnabled);
            captured.put("retained_sample_count", retained);
            captured.put("dropped_sample_count", Math.max(0, droppedSamples));
            captured.put("recorded_sample_count", retained + Math.max(0, droppedSamples));
            captured.put("bytes_per_sample", bytesPerSample > 0L ? bytesPerSample : JSONObject.NULL);
            captured.put(
                "effective_hz_estimate",
                durationSeconds > 0L ? round((double) retained / durationSeconds, 2) : JSONObject.NULL
            );
            // Retention thins, it does not truncate, so retained samples always span
            // the whole drive. This flag says the resolution is uneven, not partial.
            captured.put("whole_trip_coverage", true);
            captured.put("resolution_reduced", droppedSamples > 0);
        } catch (JSONException error) {
            Log.w(TAG, "Could not build motion capture profile", error);
        }
        return captured;
    }

    /**
     * Reads `capture_fidelity` from the shared settings blob the JS app writes.
     * No bridge work is needed: the service already reads CapacitorStorage directly.
     */
    private CaptureFidelityProfile.Profile resolveCaptureProfile() {
        CaptureFidelityProfile.Profile profile = CaptureFidelityProfile.resolve(
            getSettingString("capture_fidelity", CaptureFidelityProfile.STANDARD)
        );
        return CaptureFidelityProfile.underStoragePressure(profile, isDeviceStorageLow());
    }

    private boolean isDeviceStorageLow() {
        try {
            java.io.File dir = getFilesDir();
            if (dir == null) return false;
            return dir.getUsableSpace() < AppExperienceWatchdog.LOW_STORAGE_USABLE_BYTES;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void appendMotionSample(long timestampMs) {
        if (activeMotionSamples == null) return;
        long minIntervalMs = activeCaptureProfile != null
            ? activeCaptureProfile.sampleMinIntervalMs
            : MOTION_SAMPLE_MIN_INTERVAL_MS;
        if (activeCaptureTier != null) {
            // The governor can only ever make sampling coarser (CaptureTierPolicy
            // enforces NORMAL as its ceiling), and 0 means suspended.
            if (activeCaptureTier.motionSuspended()) return;
            minIntervalMs = Math.max(minIntervalMs, activeCaptureTier.motionSampleMinIntervalMs);
        }
        if (timestampMs - lastMotionSampleMs < minIntervalMs) return;
        if (timestampMs - lastLinearSensorMs > MOTION_AXIS_FRESH_MS) return;

        JSONObject sample = new JSONObject();
        try {
            double linearMagnitude = Math.sqrt(lastAx * lastAx + lastAy * lastAy + lastAz * lastAz);
            sample.put("timestamp", iso(timestampMs));
            sample.put("timestamp_ms", timestampMs);
            sample.put("ax", lastAx);
            sample.put("ay", lastAy);
            sample.put("az", lastAz);
            sample.put("linear_magnitude_ms2", linearMagnitude);
            if (timestampMs - lastGyroSensorMs <= MOTION_AXIS_FRESH_MS) {
                double rotationMagnitudeRadS = Math.sqrt(lastGx * lastGx + lastGy * lastGy + lastGz * lastGz);
                sample.put("gx", lastGx);
                sample.put("gy", lastGy);
                sample.put("gz", lastGz);
                sample.put("gz_deg_s", Math.toDegrees(lastGz));
                sample.put("rotation_magnitude_deg_s", Math.toDegrees(rotationMagnitudeRadS));
            } else {
                sample.put("gx", JSONObject.NULL);
                sample.put("gy", JSONObject.NULL);
                sample.put("gz", JSONObject.NULL);
                sample.put("gz_deg_s", JSONObject.NULL);
                sample.put("rotation_magnitude_deg_s", JSONObject.NULL);
            }
            sample.put("source", "android_native_sensors");
            activeMotionSamples.put(sample);
            if (activeMotionSampleBytes <= 0L) {
                activeMotionSampleBytes = sample.toString().length();
            }
            activeMotionSamplesDropped += MotionSampleRetention.enforceBudget(
                activeMotionSamples,
                activeCaptureProfile == null
                    ? MAX_NATIVE_MOTION_SAMPLES
                    : activeCaptureProfile.effectiveSampleBudget(activeMotionSampleBytes)
            );
            lastMotionSampleMs = timestampMs;
        } catch (JSONException error) {
            Log.w(TAG, "Could not append motion sample", error);
        }
    }

    private void evaluatePossibleIncident() {
        if (activeIncidentEvents == null) activeIncidentEvents = new JSONArray();
        long now = System.currentTimeMillis();
        // Only the cooldown suppresses repeat alerts. A previous incident must NOT disable
        // detection for the rest of the trip: one false positive from a pothole would then
        // hide a real crash later in the same drive. The cap only bounds the stored payload.
        if (activeIncidentEvents.length() >= MAX_INCIDENT_EVENTS_PER_TRIP) return;
        if (now - lastPossibleIncidentAlertMs < POSSIBLE_INCIDENT_ALERT_COOLDOWN_MS) return;

        JSONObject incident = detectNativePossibleIncident(
            activePoints,
            activeMotionSamples,
            lastActivityType,
            lastActivityConfidence,
            isSettingEnabled("sensor_fusion_enabled", true) &&
                isSettingEnabled("crash_detection_enabled", true)
        );
        if (incident == null) return;

        boolean emergencyWorkflow = isSettingEnabled("emergency_workflow_enabled", false);
        try {
            incident.put("emergency_workflow_pending", emergencyWorkflow);
            incident.put("source", "android_native_background");
            incident.put("native_background", true);
        } catch (JSONException error) {
            Log.w(TAG, "Could not evaluate possible incident", error);
        }
        // The incident copies its coordinates from the raw active route point, so
        // redact before it reaches the in-memory list that feeds both the recovery
        // checkpoint and the completed-trip journal.
        activeIncidentEvents.put(PrivacyZoneChecker.redactEvent(this, incident));
        recordLiveTelemetryEvent(
            "possible_incident",
            "Possible incident signal recorded",
            incident.optDouble("peak_linear_ms2", 0d),
            "m/s²",
            now
        );
        lastPossibleIncidentAlertMs = now;

        String workflowBody = emergencyWorkflow
            ? "Possible incident signal recorded. Emergency check-in is active until you review the trip."
            : "Possible incident signal recorded. Check in now if you can.";
        recordTimeline(
            "possible_crash",
            "Possible incident signal recorded.",
            emergencyWorkflow ? "emergency_workflow_active" : "check_in_prompt",
            incident.optDouble("speed_before_kmh", lastKnownSpeedKmh),
            incident.optLong("stopped_seconds", 0L),
            maxDriftSinceStopM
        );
        recordDiagnostic(
            "possible_incident",
            "Possible incident signal recorded.",
            emergencyWorkflow ? "emergency_workflow_active" : "check_in_prompt",
            incident.optDouble("speed_before_kmh", lastKnownSpeedKmh),
            incident.optLong("stopped_seconds", 0L),
            maxDriftSinceStopM
        );
        sendPossibleIncidentNotification(emergencyWorkflow);
        if (isNativeVoiceAlertTypeEnabled("possible_incident")) {
            speakNativeAlert(workflowBody, true);
        }
        updateNotification(emergencyWorkflow ? "Possible incident - open Road Sage to check in" : "Possible incident signal recorded");
    }

    @Nullable
    static JSONObject detectNativePossibleIncident(
        @Nullable JSONArray points,
        @Nullable JSONArray motionSamples,
        int activityType,
        int activityConfidence,
        boolean crashDetectionEnabled
    ) {
        if (!crashDetectionEnabled || points == null || motionSamples == null) return null;
        if (points.length() < 2 || motionSamples.length() < 3) return null;

        int startIndex = Math.max(0, points.length() - POSSIBLE_INCIDENT_RECENT_POINTS);
        JSONObject latestPoint = points.optJSONObject(points.length() - 1);
        if (latestPoint == null) return null;
        long latestMs = jsonTimestampMs(latestPoint);
        if (latestMs <= 0L) latestMs = System.currentTimeMillis();

        double maxRecentSpeed = 0d;
        long stoppedSeconds = 0L;
        Long previousStoppedMs = null;
        for (int i = startIndex; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;
            double speed = Math.max(0d, point.optDouble("speed_kmh", 0d));
            maxRecentSpeed = Math.max(maxRecentSpeed, speed);
            if (speed < 3d) {
                long pointMs = jsonTimestampMs(point);
                if (previousStoppedMs != null && pointMs > previousStoppedMs) {
                    stoppedSeconds += Math.max(0L, (pointMs - previousStoppedMs) / 1000L);
                }
                if (pointMs > 0L) previousStoppedMs = pointMs;
            }
        }

        double peakLinear = 0d;
        double peakRotation = 0d;
        for (int i = 0; i < motionSamples.length(); i++) {
            JSONObject sample = motionSamples.optJSONObject(i);
            if (sample == null) continue;
            long sampleMs = jsonTimestampMs(sample);
            if (sampleMs <= 0L || Math.abs(sampleMs - latestMs) > POSSIBLE_INCIDENT_SAMPLE_WINDOW_MS) continue;
            peakLinear = Math.max(peakLinear, sample.optDouble("linear_magnitude_ms2", 0d));
            peakRotation = Math.max(peakRotation, sample.optDouble("rotation_magnitude_deg_s", 0d));
        }

        boolean stillActivity = activityType == DetectedActivity.STILL && activityConfidence >= 60;
        boolean likelyIncident = maxRecentSpeed >= POSSIBLE_INCIDENT_MIN_SPEED_KMH &&
            peakLinear >= POSSIBLE_INCIDENT_LINEAR_MS2 &&
            peakRotation >= POSSIBLE_INCIDENT_ROTATION_DEG_S &&
            (stoppedSeconds >= POSSIBLE_INCIDENT_STOPPED_SECONDS || stillActivity);
        if (!likelyIncident) return null;

        JSONObject incident = new JSONObject();
        try {
            incident.put("type", "possible_crash");
            incident.put("severity", peakLinear >= POSSIBLE_INCIDENT_HIGH_LINEAR_MS2 ? "high" : "medium");
            incident.put("lat", latestPoint.optDouble("lat", Double.NaN));
            incident.put("lng", latestPoint.optDouble("lng", Double.NaN));
            incident.put("timestamp", latestPoint.optString("timestamp", iso(latestMs)));
            incident.put("timestamp_ms", latestMs);
            incident.put("speed_before_kmh", Math.round(maxRecentSpeed));
            incident.put("peak_linear_ms2", round(peakLinear, 2));
            incident.put("peak_rotation_deg_s", round(peakRotation, 2));
            incident.put("stopped_seconds", Math.round(stoppedSeconds));
            incident.put("activity_type", activityType == DetectedActivity.STILL ? "still" : "unknown");
            incident.put("activity_confidence", activityConfidence);
            incident.put("confidence", peakLinear >= POSSIBLE_INCIDENT_HIGH_LINEAR_MS2 && stoppedSeconds >= POSSIBLE_INCIDENT_HIGH_STOPPED_SECONDS ? 0.9d : 0.72d);
        } catch (JSONException error) {
            Log.w(TAG, "Could not evaluate possible incident", error);
        }
        return incident;
    }

    private static long jsonTimestampMs(JSONObject object) {
        if (object == null) return 0L;
        long direct = object.optLong("timestamp_ms", 0L);
        if (direct > 0L) return direct;
        String timestamp = object.optString("timestamp", "");
        if (timestamp == null || timestamp.trim().isEmpty()) return 0L;
        try {
            return Instant.parse(timestamp).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return 0L;
        }
    }

    private static boolean hasPendingEmergencyWorkflow(JSONArray events) {
        if (events == null) return false;
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.optJSONObject(i);
            if (event != null && event.optBoolean("emergency_workflow_pending", false)) return true;
        }
        return false;
    }

    private void acknowledgePossibleIncidentFromNotification() {
        String acknowledgedAt = iso(System.currentTimeMillis());
        boolean activeUpdated = acknowledgeIncidentEvents(activeIncidentEvents, acknowledgedAt);
        boolean storedUpdated = DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(this, acknowledgedAt);
        recordDiagnostic(
            "emergency_check_in",
            activeUpdated || storedUpdated
                ? "Driver checked in OK from notification."
                : "Driver check-in notification action received.",
            "notification_ok",
            lastKnownSpeedKmh,
            0L,
            maxDriftSinceStopM
        );
        NotificationManagerCompat.from(this).cancel(NOTIF_ID_POSSIBLE_INCIDENT);
        if (activeUpdated && isTripActive()) {
            updateNotification("Possible incident acknowledged");
        }
    }

    private static boolean acknowledgeIncidentEvents(@Nullable JSONArray events, String acknowledgedAt) {
        if (events == null) return false;
        boolean changed = false;
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.optJSONObject(i);
            if (event == null || !"possible_crash".equals(event.optString("type", ""))) continue;
            if (!event.optBoolean("emergency_workflow_pending", false) && event.has("emergency_workflow_acknowledged")) continue;
            try {
                event.put("emergency_workflow_pending", false);
                event.put("emergency_workflow_acknowledged", "ok");
                event.put("emergency_workflow_acknowledged_at", acknowledgedAt);
                changed = true;
            } catch (JSONException error) {
                Log.w(TAG, "Could not acknowledge incident events", error);
            }
        }
        return changed;
    }

    private static double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double earthKm = 6371d;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.pow(Math.sin(dLat / 2d), 2d) +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
            Math.pow(Math.sin(dLng / 2d), 2d);
        double c = 2d * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0d, 1d - a)));
        return earthKm * c;
    }

    private void updatePhoneUseProxy(double bearing, double speedKmh, float accuracyM, long timestampMs) {
        double maxAccuracyM = getSettingDouble("phone_proxy_max_accuracy_m", DetectionConstants.PHONE_PROXY_MAX_ACCURACY_M);
        if (!isSettingEnabled("phone_use_detection_enabled", true) || accuracyM > maxAccuracyM) return;
        long microSteerWindowMs = (long) (getSettingDouble(
            "phone_micro_steer_window_s", DetectionConstants.PHONE_MICRO_STEER_WINDOW_S) * 1000d);
        // src/lib/tripEngine.js reads the same pair of keys in this order.
        int microSteerMinCount = (int) Math.round(getSettingDouble(
            "phone_micro_steer_count",
            getSettingDouble("threshold_phone_proxy_oscillations", DetectionConstants.PHONE_MICRO_STEER_COUNT)));
        while (!recentHeadings.isEmpty() && timestampMs - recentHeadings.peekFirst()[1] > microSteerWindowMs) {
            recentHeadings.pollFirst();
        }
        recentHeadings.addLast(new double[]{ bearing, timestampMs });

        if (speedKmh < PHONE_DETECT_MIN_SPEED_KMH || recentHeadings.size() < 3) return;

        int oscillations = 0;
        double[] prev2 = null;
        double[] prev1 = null;
        double[] first = null;
        double[] last = null;
        for (double[] entry : recentHeadings) {
            if (first == null) first = entry;
            last = entry;
            if (prev2 != null && prev1 != null) {
                double d1 = signedHeadingDiff(prev2[0], prev1[0]);
                double d2 = signedHeadingDiff(prev1[0], entry[0]);
                double abs1 = Math.abs(d1);
                double abs2 = Math.abs(d2);
                boolean bothMicro = abs1 >= PHONE_MICRO_STEER_MIN_DEG && abs1 <= PHONE_MICRO_STEER_MAX_DEG
                    && abs2 >= PHONE_MICRO_STEER_MIN_DEG && abs2 <= PHONE_MICRO_STEER_MAX_DEG;
                boolean reversed = (d1 > 0d && d2 < 0d) || (d1 < 0d && d2 > 0d);
                if (bothMicro && reversed) oscillations++;
            }
            prev2 = prev1;
            prev1 = entry;
        }

        double netHeadingChange = first != null && last != null ? Math.abs(signedHeadingDiff(first[0], last[0])) : 0.0d;
        boolean sustainedTurnLike = netHeadingChange >= SUSTAINED_TURN_HEADING_CHANGE_DEG && oscillations < microSteerMinCount;
        if (sustainedTurnLike) return;

        if (oscillations >= microSteerMinCount) {
            if (timestampMs - lastNativeProxyWindowMs < PHONE_WINDOW_COUNT_COOLDOWN_MS) return;
            lastNativeProxyWindowMs = timestampMs;
            nativeMicroSteerCount++;
        }
    }

    private void updateHeadingDriftWindow(double bearing, double speedKmh, long timestampMs) {
        while (!nativeHeadingDriftWindow.isEmpty() &&
            timestampMs - nativeHeadingDriftWindow.peekFirst()[1] > HEADING_DRIFT_WINDOW_MS) {
            nativeHeadingDriftWindow.pollFirst();
        }
        nativeHeadingDriftWindow.addLast(new double[]{ bearing, timestampMs, Math.max(0d, speedKmh) });
    }

    private boolean shouldAlertHeadingDrift(double thresholdDeg) {
        if (nativeHeadingDriftWindow.size() < HEADING_DRIFT_MIN_SAMPLES) return false;
        double[] headings = new double[nativeHeadingDriftWindow.size()];
        int index = 0;
        int highwayCount = 0;
        for (double[] entry : nativeHeadingDriftWindow) {
            headings[index++] = entry[0];
            if (entry.length > 2 && entry[2] >= HEADING_DRIFT_HIGHWAY_SPEED_KMH) highwayCount++;
        }
        double highwayShare = nativeHeadingDriftWindow.isEmpty()
            ? 0d
            : highwayCount / (double) nativeHeadingDriftWindow.size();
        return highwayShare >= HEADING_DRIFT_HIGHWAY_SHARE &&
            calculateAngularStdDev(headings) > thresholdDeg;
    }

    private boolean recordStopStartCycle(long nowMs, double priorSpeedKmh, double speedKmh, double accelerationMs2) {
        // The JS detector picks its threshold set from the trip median moving speed. Live
        // coaching has no trip median yet, so the current speed stands in for it; the split
        // point itself is shared so the two sides agree on where urban ends.
        boolean citySpeedPattern = priorSpeedKmh < DetectionConstants.STOP_START_URBAN_SPEED_SPLIT_KMH;
        double requiredDecel = citySpeedPattern
            ? getSettingDouble("threshold_stop_start_urban_decel_ms2", DetectionConstants.STOP_START_URBAN_DECEL_MS2)
            : getSettingDouble("threshold_stop_start_decel_ms2", DetectionConstants.STOP_START_DECEL_MS2);
        // Only the highway pair is user-settable; urban minimum speed and speed drop are
        // detector-internal on the JS side too, so they come straight from the shared constants.
        double minSpeedKmh = citySpeedPattern
            ? DetectionConstants.STOP_START_URBAN_MIN_SPEED_KMH
            : getSettingDouble("threshold_stop_start_min_speed_kmh", DetectionConstants.STOP_START_MIN_SPEED_KMH);
        double speedDropKmh = citySpeedPattern
            ? DetectionConstants.STOP_START_URBAN_SPEED_DROP_KMH
            : getSettingDouble("threshold_stop_start_speed_drop_kmh", DetectionConstants.STOP_START_SPEED_DROP_KMH);
        if (priorSpeedKmh < minSpeedKmh ||
            priorSpeedKmh - speedKmh < speedDropKmh ||
            accelerationMs2 > -Math.abs(requiredDecel)) {
            return false;
        }

        if (stopStartWindowStartMs == 0L || nowMs - stopStartWindowStartMs > STOP_START_WINDOW_MS) {
            stopStartWindowStartMs = nowMs;
            stopStartCycleCount = 0;
        }
        stopStartCycleCount++;
        return stopStartCycleCount >= STOP_START_ALERT_CYCLES;
    }

    private void speakNativeAlert(String text) {
        speakNativeAlert(text, false, null);
    }

    private void speakNativeAlert(String text, boolean interrupt) {
        speakNativeAlert(text, interrupt, null);
    }

    private void speakNativeAlert(String text, boolean interrupt, @Nullable Runnable onAccepted) {
        speakNativeAlert(text, interrupt, onAccepted, null);
    }

    private void speakNativeAlert(
        String text,
        boolean interrupt,
        @Nullable Runnable onAccepted,
        @Nullable Runnable onError
    ) {
        if (text == null || text.trim().isEmpty()) return;
        if (speechController == null) speechController = new DriveSenseSpeechController(this);
        speechController.speak(text, TTS_SPEECH_RATE, 1.0f, TTS_VOLUME, interrupt, new DriveSenseSpeechController.Callback() {
            @Override
            public void onAccepted() {
                recordNativeVoiceAlertAccepted(text);
                if (onAccepted != null) onAccepted.run();
            }

            @Override
            public void onError(String message) {
                long now = System.currentTimeMillis();
                if (onError != null) onError.run();
                if (now - lastNativeSpeechDiagnosticMs >= 30_000L) {
                    lastNativeSpeechDiagnosticMs = now;
                    recordDiagnostic(
                        "voice_alert_failed",
                        "Voice alert could not play.",
                        message == null || message.trim().isEmpty() ? "unknown_tts_error" : message,
                        lastKnownSpeedKmh,
                        0L,
                        0d
                    );
                }
            }
        });
    }

    private boolean retryPendingCompletedTripSave(boolean force) {
        if (pendingCompletedTrip == null) return true;
        long nowMs = System.currentTimeMillis();
        if (!force && nowMs < nextCompletedTripSaveRetryMs) return false;
        if (!DriveSenseNativeTripStore.addCompletedTrip(this, pendingCompletedTrip)) {
            nextCompletedTripSaveRetryMs = nowMs + COMPLETED_TRIP_SAVE_RETRY_MS;
            updateNotification("Previous trip recovery pending - open Road Sage");
            return false;
        }
        pendingCompletedTrip = null;
        nextCompletedTripSaveRetryMs = 0L;
        DriveSenseActiveTripCheckpointStore.clear(this);
        recordDiagnostic(
            "trip_save_recovered",
            "Previous trip was safely queued after a storage retry.",
            "completed_trip_retry",
            0d,
            0L,
            0d
        );
        updateNotification("Previous trip recovered - ready for movement");
        return true;
    }

    private boolean isNativeVoiceAlertTypeEnabled(String alertKey) {
        if (!isSettingEnabled("voice_alerts_enabled", true)) return false;
        String key = alertKey == null ? "" : alertKey.trim().toLowerCase(Locale.US);
        if (key.startsWith("speeding")) {
            return isSettingEnabled("voice_speed_alerts_enabled", true);
        }
        if (
            key.equals("harsh_brake") ||
            key.equals("rapid_accel") ||
            key.equals("sharp_cornering") ||
            key.equals("close_manoeuvre") ||
            key.equals("stop_start_pattern") ||
            key.equals("repeated_event_area")
        ) {
            return isSettingEnabled("voice_driving_event_alerts_enabled", true);
        }
        if (
            key.equals("phone_use") ||
            key.equals("heading_drift") ||
            key.equals("possible_incident")
        ) {
            return isSettingEnabled("voice_attention_incident_alerts_enabled", true);
        }
        if (
            key.startsWith("coach_program") ||
            key.equals("fatigue") ||
            key.equals("idle")
        ) {
            return isSettingEnabled("voice_coaching_reminder_alerts_enabled", true);
        }
        return true;
    }

    private void recordNativeVoiceAlertAccepted(String text) {
        recordDiagnostic(
            "voice_alert_spoken",
            "Native voice alert accepted.",
            nativeVoiceAlertReason(text),
            lastKnownSpeedKmh,
            0L,
            maxDriftSinceStopM
        );
    }

    private String nativeVoiceAlertReason(String text) {
        String message = text == null ? "" : text.trim();
        if (message.startsWith("Road Sage is tracking") || message.startsWith("Recording active.")) return "tracking_ready";
        if (message.startsWith("Today's focus is")) return "coach_program_brief";
        if (
            message.startsWith("Repeated event area") ||
            (message.startsWith("Repeated ") && message.contains(" area "))
        ) {
            return "repeated_event_area";
        }
        if (message.startsWith("Speed warning.")) return "posted_speed_warning";
        if (message.startsWith("Speed check.")) return "estimated_speed_check";
        if (message.startsWith("Long drive reminder.")) return "long_drive";
        if (message.startsWith("Idling reminder.") || message.startsWith("Idle duration threshold")) return "idle";
        if (message.startsWith("Close manoeuvre detected.") || message.startsWith("Brake-turn manoeuvre")) return "close_manoeuvre";
        if (message.startsWith("Repeated stop-start pattern") || message.startsWith("Stop-start pattern")) return "stop_start_pattern";
        if (message.startsWith("Hard braking detected.") || message.startsWith("Hard braking event")) return "harsh_brake";
        if (message.startsWith("Rapid acceleration detected.") || message.startsWith("Acceleration threshold")) return "rapid_accel";
        if (message.startsWith("Sharp cornering detected.") || message.startsWith("Cornering threshold")) return "sharp_cornering";
        if (message.startsWith("Attention pattern recorded.")) return "heading_drift";
        if (message.startsWith("GPS heading pattern")) return "heading_drift";
        if (
            message.startsWith("Phone use detected.") ||
            message.startsWith("Phone-use window") ||
            message.startsWith("Phone activity detected.") ||
            message.startsWith("Foreground phone activity")
        ) return "phone_use";
        if (message.startsWith("Possible incident signal recorded.")) return "possible_incident";
        return "native_voice_alert";
    }

    private boolean isTechnicalVoiceAlertStyle() {
        String style = getSettingString("voice_alert_style", "mode_default");
        if ("technical".equals(style)) return true;
        if ("coaching".equals(style)) return false;
        return "tracking".equals(getSettingString("experience_mode", "coaching"));
    }

    private String nativeAlertMessage(String key) {
        boolean technical = isTechnicalVoiceAlertStyle();
        switch (key) {
            case "tracking_ready":
                return technical
                    ? "Recording active. Voice alert delivery ready."
                    : "Road Sage is tracking and voice alerts are ready.";
            case "fatigue":
                return technical
                    ? "Drive duration threshold exceeded."
                    : "Long drive reminder. Plan a break soon when it is safe.";
            case "idle":
                return technical
                    ? "Idle duration threshold exceeded."
                    : "Idling reminder. Keep the trip moving when conditions allow.";
            case "close_manoeuvre":
                return technical
                    ? "Brake-turn manoeuvre pattern recorded."
                    : "Close manoeuvre detected. Create space, then review conditions when safe.";
            case "stop_start_pattern":
                return technical
                    ? "Stop-start pattern recorded."
                    : "Repeated stop-start pattern recorded. Add space ahead and keep inputs smooth.";
            case "harsh_brake":
                return technical
                    ? "Hard braking event recorded."
                    : "Hard braking detected. Open your following space and brake earlier.";
            case "rapid_accel":
                return technical
                    ? "Acceleration threshold exceeded."
                    : "Rapid acceleration detected. Ease into the throttle.";
            case "sharp_cornering":
                return technical
                    ? "Cornering threshold exceeded."
                    : "Sharp cornering detected. Slow before the turn and steer smoothly.";
            case "heading_drift":
                return technical
                    ? "GPS heading pattern recorded."
                    : "Attention pattern recorded. Keep your eyes up and plan a break if you feel tired.";
            case "phone_use":
                return technical
                    ? "Foreground phone activity detected from Android Usage Access."
                    : "Phone activity detected. Eyes on the road. Review it when parked.";
            default:
                return technical ? "Telemetry alert recorded." : "Safety alert. Check Road Sage when it is safe to do so.";
        }
    }

    @Nullable
    private String nativeActiveCoachBriefMessage() {
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(COACH_PROGRAM_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return null;
            JSONObject active = new JSONObject(raw).optJSONObject("active");
            if (active == null || !"active".equals(active.optString("status", ""))) return null;
            switch (active.optString("focusId", "")) {
                case "harsh_brakes":
                    return "Today's focus is progressive braking. Lift early and build pressure smoothly.";
                case "rapid_accel":
                    return "Today's focus is smooth acceleration. Build throttle over three seconds.";
                case "sharp_turns":
                    return "Today's focus is cleaner turns. Set speed before steering.";
                case "speeding":
                    return "Today's focus is speed discipline. Settle below the alert threshold.";
                case "phone_use":
                    return "Today's focus is a phone-clear drive. Keep the phone out of reach.";
                case "fatigue":
                    return "Today's focus is alertness. Take a break before fatigue builds.";
                case "consistency":
                    return "Today's focus is repeating your strongest measured drive setup.";
                default:
                    return null;
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private void speakNativeCoachBriefOnce(long now, boolean voiceAlertsEnabled) {
        if (
            coachBriefAlertSpoken ||
            coachBriefAlertPending ||
            !voiceAlertsEnabled ||
            !isNativeVoiceAlertTypeEnabled("coach_program_brief") ||
            !isSettingEnabled("live_coaching_enabled", true) ||
            activeStartMs <= 0L
        ) {
            return;
        }
        long tripAgeMs = now - activeStartMs;
        if (tripAgeMs < COACH_BRIEF_MIN_DELAY_MS || tripAgeMs > COACH_BRIEF_MAX_DELAY_MS) return;
        String message = nativeActiveCoachBriefMessage();
        if (message == null || message.trim().isEmpty()) return;
        coachBriefAlertPending = true;
        speakNativeAlert(
            message,
            false,
            () -> {
                coachBriefAlertSpoken = true;
                coachBriefAlertPending = false;
            },
            () -> coachBriefAlertPending = false
        );
    }

    private String nativeRepeatedEventAreaMessage(String dominantType, double distanceM) {
        String eventType = dominantType == null || dominantType.trim().isEmpty()
            ? "risk event"
            : dominantType.trim().replace('_', ' ');
        if (isTechnicalVoiceAlertStyle()) {
            return String.format(
                Locale.US,
                "Repeated event area ahead: %s, %d meters.",
                eventType,
                Math.round(distanceM)
            );
        }
        return String.format(
            Locale.US,
            "Repeated %s area %d meters ahead. Ease off and leave extra room.",
            eventType,
            Math.round(distanceM)
        );
    }

    private void evaluateRepeatedEventAreaAlert(Location location, long now, boolean voiceAlertsEnabled) {
        if (
            !voiceAlertsEnabled ||
            !isNativeVoiceAlertTypeEnabled("repeated_event_area") ||
            !isSettingEnabled("danger_zone_alerts_enabled", true) ||
            now - lastDangerZoneAlertMs < DANGER_ZONE_ALERT_COOLDOWN_MS ||
            PrivacyZoneChecker.isInsidePrivacyZone(this, location.getLatitude(), location.getLongitude())
        ) {
            return;
        }
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(DANGER_ZONES_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return;
            JSONArray zones;
            String trimmed = raw.trim();
            if (trimmed.startsWith("{")) {
                JSONObject encrypted = new JSONObject(trimmed);
                if (!encrypted.optBoolean("encrypted", false)) return;
                String ciphertext = encrypted.optString("ciphertext", "");
                int keyVersion = encrypted.optInt("key_version", 0);
                if (ciphertext.isEmpty() || keyVersion <= 0) return;
                String plaintext = DriveSensePayloadCrypto.decrypt(
                    ciphertext,
                    "storage:" + DANGER_ZONES_KEY,
                    keyVersion
                );
                zones = new JSONArray(plaintext);
            } else {
                // Legacy plaintext is accepted until the JS lazy migration rewrites it.
                zones = new JSONArray(trimmed);
            }
            JSONObject nearest = null;
            double nearestDistanceM = Double.POSITIVE_INFINITY;
            for (int i = 0; i < zones.length(); i++) {
                JSONObject zone = zones.optJSONObject(i);
                if (zone == null) continue;
                double zoneLat = zone.optDouble("lat", Double.NaN);
                double zoneLng = zone.optDouble("lng", Double.NaN);
                if (!Double.isFinite(zoneLat) || !Double.isFinite(zoneLng)) continue;
                double distanceM = haversineKm(
                    location.getLatitude(),
                    location.getLongitude(),
                    zoneLat,
                    zoneLng
                ) * 1000d;
                if (distanceM <= DANGER_ZONE_ALERT_RADIUS_M && distanceM < nearestDistanceM) {
                    nearest = zone;
                    nearestDistanceM = distanceM;
                }
            }
            if (nearest == null) return;
            String dominantType = nearest.optString("dominantType", "risk event");
            String message = nativeRepeatedEventAreaMessage(dominantType, nearestDistanceM);
            recordLiveTelemetryEvent(
                "repeated_event_area",
                "Repeated event area approached",
                nearestDistanceM,
                "m",
                now
            );
            lastDangerZoneAlertMs = now;
            speakNativeAlert(message, false, () -> lastDangerZoneAlertMs = now);
        } catch (Exception error) {
            recordDiagnostic(
                "danger_zone_alert_failed",
                "Repeated event area data could not be evaluated.",
                error.getMessage() == null ? "invalid_danger_zone_data" : error.getMessage(),
                lastKnownSpeedKmh,
                0L,
                0d
            );
        }
    }

    private String nativeSpeedAlertMessage(double speedKmh, double speedLimitKmh, boolean postedLimit, boolean estimatedLimit) {
        return nativeSpeedAlertMessage(
            speedKmh,
            speedLimitKmh,
            postedLimit,
            estimatedLimit,
            isTechnicalVoiceAlertStyle(),
            getSettingString("units", "metric")
        );
    }

    static String nativeSpeedAlertMessage(
        double speedKmh,
        double speedLimitKmh,
        boolean postedLimit,
        boolean estimatedLimit,
        boolean technical,
        String units
    ) {
        boolean imperial = "imperial".equalsIgnoreCase(units == null ? "" : units.trim());
        long displaySpeed = Math.round(imperial ? speedKmh * 0.621371d : speedKmh);
        long displayLimit = Math.round(imperial ? speedLimitKmh * 0.621371d : speedLimitKmh);
        String technicalUnit = imperial ? "mph" : "km/h";
        String spokenUnit = imperial ? "miles per hour" : "kilometers per hour";
        if (technical) {
            if (postedLimit || estimatedLimit) {
                return String.format(
                    Locale.US,
                    "Speed threshold exceeded: %d %s in %s %d %s zone.",
                    displaySpeed,
                    technicalUnit,
                    postedLimit ? "posted" : "estimated",
                    displayLimit,
                    technicalUnit
                );
            }
            return String.format(
                Locale.US,
                "Speed threshold exceeded: %d %s.",
                displaySpeed,
                technicalUnit
            );
        }
        if (postedLimit) {
            return String.format(
                Locale.US,
                "Speed warning. You are at %d in a posted %d %s zone. Ease off smoothly.",
                displaySpeed,
                displayLimit,
                spokenUnit
            );
        }
        if (estimatedLimit) {
            return String.format(
                Locale.US,
                "Speed check. You are at %d in an estimated %d %s zone. Check posted signs.",
                displaySpeed,
                displayLimit,
                spokenUnit
            );
        }
        return String.format(
            Locale.US,
            "Speed check. You are driving %d %s. Ease off and check posted signs.",
            displaySpeed,
            spokenUnit
        );
    }

    private void speakTrackingReadyOnce() {
        if (trackingReadyAlertSpoken || !isSettingEnabled("trip_start_voice_alert_enabled", true)) return;
        long now = System.currentTimeMillis();
        if (trackingReadyAlertPending || now - lastTrackingReadyAlertAttemptMs < TRACKING_READY_ALERT_RETRY_MS) return;
        trackingReadyAlertPending = true;
        lastTrackingReadyAlertAttemptMs = now;
        speakNativeAlert(
            nativeAlertMessage("tracking_ready"),
            true,
            () -> {
                trackingReadyAlertSpoken = true;
                trackingReadyAlertPending = false;
                recordDiagnostic(
                    "voice_alert_tracking_ready",
                    "Tracking ready voice alert accepted.",
                    nativeTripStartSource,
                    lastKnownSpeedKmh,
                    0L,
                    maxDriftSinceStopM
                );
            },
            () -> trackingReadyAlertPending = false
        );
    }

    private void evaluateNativeLiveAlerts(
        @Nullable Location priorLocation,
        Location location,
        double priorSpeedKmh,
        double speedKmh
    ) {
        boolean voiceAlertsEnabled = isSettingEnabled("voice_alerts_enabled", true);

        long now = System.currentTimeMillis();
        recordRecentSpeedSample(speedKmh);
        NativeSpeedLimit localSpeedLimit = resolveLocalSpeedLimit(
            location.getLatitude(),
            location.getLongitude(),
            location.hasBearing() ? location.getBearing() : Double.NaN,
            now
        );
        double speedingFallbackKmh = getSettingDouble("threshold_speeding_kmh", DetectionConstants.SPEEDING_FALLBACK_KMH);
        // With nothing saved for this road, a flat 100 km/h was assumed everywhere,
        // so a background drive through a 50 zone recorded nothing until 112. The
        // webview instead estimates from the region and the road context it infers
        // from recent speeds, which is what this mirrors.
        double regionDefaultKmh = localSpeedLimit != null
            ? Double.NaN
            : SpeedRegionDefaults.fallbackLimitKmh(
                speedDefaultRegionSetting(),
                recentSpeedP85Kmh(),
                speedingFallbackKmh
            );
        boolean regionDefaultLimit = Double.isFinite(regionDefaultKmh);
        double speedLimitKmh = localSpeedLimit != null
            ? localSpeedLimit.limitKmh
            : regionDefaultLimit ? regionDefaultKmh : speedingFallbackKmh;
        boolean postedLimit = localSpeedLimit != null &&
            "user_confirmed_posted_sign".equals(localSpeedLimit.source);
        boolean estimatedLimit = localSpeedLimit != null && !postedLimit;
        double speedMarginKmh = estimatedLimit
            ? getSettingDouble("estimated_voice_margin_kmh", 12.0d)
            : postedLimit
                ? getSettingDouble("threshold_speed_over_kmh", DetectionConstants.SPEED_OVER_KMH)
                : getSettingDouble("estimated_voice_margin_kmh", 12.0d);
        // Every limit that resolveLocalSpeedLimit returns has already cleared the
        // floor where it was resolved: corrections are user-authored, road-memory
        // candidates need 0.64, learned cells need SPEED_ALERT_MIN_CONFIDENCE. A
        // regional default (0.40) and the flat threshold do not, so they are the
        // only ones re-checked here. Those two resolution bars are still fixed, so
        // a floor raised past 0.64 does not yet silence a road-memory limit here.
        double confidenceFloor = getSettingDouble(
            "speed_alert_min_confidence",
            DetectionConstants.SPEED_ALERT_MIN_CONFIDENCE
        );
        boolean meetsConfidenceFloor = localSpeedLimit != null || (
            regionDefaultLimit && SpeedRegionDefaults.REGION_DEFAULT_CONFIDENCE >= confidenceFloor
        );
        // Anything that is not a posted sign is an estimate, including the fallback,
        // so it answers to both estimate switches — speedAlertPolicy's
        // estimateGuidanceAllowed and speechAllowedForTier read the same pair.
        boolean sourceVoiceAllowed = meetsConfidenceFloor && (postedLimit
            ? isSettingEnabled("speak_posted_speed_warnings", true)
            : isSettingEnabled("speed_estimates_enabled", true) &&
                isSettingEnabled("speak_estimated_speed_checks", true));
        if (isSettingEnabled("speed_warning_enabled", true) &&
            shouldTriggerSpeedAlert(speedKmh, speedLimitKmh, speedMarginKmh)) {
            if (speedingSinceMs == 0L) speedingSinceMs = now;
            long speedAlertCooldownMs = postedLimit
                ? SPEED_ALERT_COOLDOWN_MS
                : estimatedLimit
                    ? SPEED_ALERT_ESTIMATED_COOLDOWN_MS
                    : SPEED_ALERT_INFERRED_COOLDOWN_MS;
            if (now - speedingSinceMs >= SPEED_ALERT_SUSTAINED_MS &&
                now - lastSpeedAlertMs >= speedAlertCooldownMs) {
                String message = nativeSpeedAlertMessage(speedKmh, speedLimitKmh, postedLimit, estimatedLimit);
                recordLiveTelemetryEvent("speed_threshold", "Speed threshold exceeded", speedKmh - speedLimitKmh, "km/h", now);
                lastSpeedAlertMs = now;
                if (voiceAlertsEnabled && sourceVoiceAllowed && isNativeVoiceAlertTypeEnabled("speeding")) {
                    speakNativeAlert(message, true, () -> lastSpeedAlertMs = now);
                }
            }
        } else if (speedingSinceMs == 0L ||
            speedKmh <= speedLimitKmh + speedMarginKmh - SPEED_ALERT_RELEASE_KMH) {
            // Hysteresis, matching speedAlertGate.js: the over-limit state clears
            // only once speed drops clear of the band. Resetting the moment speed
            // dipped below the threshold restarted the sustained window on every
            // fix while hovering on the line, so a driver sitting just over the
            // limit could be alerted repeatedly.
            speedingSinceMs = 0L;
        }

        long fatigueThresholdMs = Math.max(
            1L,
            Math.round(getSettingDouble("threshold_long_drive_minutes", DetectionConstants.LONG_DRIVE_MINUTES))
        ) * 60_000L;
        if (activeStartMs > 0L && now - activeStartMs >= fatigueThresholdMs &&
            now - lastFatigueAlertMs >= FATIGUE_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("long_drive", "Long-drive threshold exceeded", (now - activeStartMs) / 60_000d, "min", now);
            lastFatigueAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("fatigue")) {
                speakNativeAlert(nativeAlertMessage("fatigue"), false, () -> lastFatigueAlertMs = now);
            }
        }

        if (stillSinceMs > 0L && now - stillSinceMs >= 5 * 60_000L &&
            now - lastIdleAlertMs >= IDLE_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("extended_stop", "Extended stop recorded", (now - stillSinceMs) / 1000d, "s", now);
            lastIdleAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("idle")) {
                speakNativeAlert(nativeAlertMessage("idle"), false, () -> lastIdleAlertMs = now);
            }
        }

        speakNativeCoachBriefOnce(now, voiceAlertsEnabled);
        evaluateRepeatedEventAreaAlert(location, now, voiceAlertsEnabled);

        if (priorLocation == null) return;
        long priorMs = priorLocation.getTime();
        long currentMs = location.getTime();
        long dtMs = currentMs - priorMs;
        if (dtMs <= 0L || dtMs > LIVE_EVENT_MAX_SAMPLE_GAP_MS) return;
        if (accuracyOf(priorLocation) > LIVE_EVENT_MAX_ACCURACY_M ||
            accuracyOf(location) > LIVE_EVENT_MAX_ACCURACY_M) return;

        double accelerationMs2 = calculateLongitudinalAccelerationMs2(priorSpeedKmh, speedKmh, dtMs);
        lastLongitudinalAccelerationMs2 = accelerationMs2;
        double harshBrakeThreshold = getSettingDouble("threshold_harsh_brake_ms2", DetectionConstants.HARSH_BRAKE_MS2);
        double rapidAccelThreshold = getSettingDouble("threshold_rapid_accel_ms2", DetectionConstants.RAPID_ACCEL_MS2);
        double priorBearing = priorLocation.hasBearing()
            ? priorLocation.getBearing()
            : priorLocation.bearingTo(location);
        double currentBearing = location.hasBearing() ? location.getBearing() : priorBearing;
        double headingChange = Math.abs(signedHeadingDiff(priorBearing, currentBearing));
        double headingRateDegS = headingChange / (dtMs / 1000d);
        lastHeadingRateDegS = headingRateDegS;
        double manoeuvreBrakeThreshold = getSettingDouble("threshold_manoeuvre_alert_brake_ms2", DetectionConstants.MANOEUVRE_ALERT_BRAKE_MS2);
        double manoeuvreTurnThreshold = getSettingDouble("threshold_manoeuvre_alert_turn_degs", DetectionConstants.MANOEUVRE_ALERT_TURN_DEG_S);
        if (speedKmh >= 30.0d &&
            accelerationMs2 <= -Math.abs(manoeuvreBrakeThreshold) &&
            headingRateDegS >= manoeuvreTurnThreshold &&
            now - lastCloseManoeuvreAlertMs >= CLOSE_MANOEUVRE_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("close_manoeuvre", "Combined braking and steering event recorded", accelerationMs2, "m/s²", now);
            lastCloseManoeuvreAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("close_manoeuvre")) {
                speakNativeAlert(nativeAlertMessage("close_manoeuvre"), false, () -> lastCloseManoeuvreAlertMs = now);
            }
            return;
        }
        if (recordStopStartCycle(now, priorSpeedKmh, speedKmh, accelerationMs2) &&
            now - lastStopStartAlertMs >= STOP_START_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("stop_start_pattern", "Stop/start pattern recorded", stopStartCycleCount, "cycles", now);
            lastStopStartAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("stop_start_pattern")) {
                speakNativeAlert(nativeAlertMessage("stop_start_pattern"), false, () -> lastStopStartAlertMs = now);
            }
            stopStartCycleCount = 0;
            stopStartWindowStartMs = now;
            return;
        }
        if (accelerationMs2 <= -harshBrakeThreshold &&
            priorSpeedKmh >= DetectionConstants.MIN_SPEED_HARSH_BRAKE_KMH &&
            now - lastHarshBrakeAlertMs >= MANOEUVRE_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("harsh_brake", "Braking threshold exceeded", accelerationMs2, "m/s²", now);
            lastHarshBrakeAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("harsh_brake")) {
                speakNativeAlert(nativeAlertMessage("harsh_brake"), false, () -> lastHarshBrakeAlertMs = now);
            }
            return;
        }
        if (accelerationMs2 >= rapidAccelThreshold &&
            speedKmh >= DetectionConstants.MIN_SPEED_RAPID_ACCEL_KMH &&
            now - lastRapidAccelAlertMs >= MANOEUVRE_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("rapid_acceleration", "Acceleration threshold exceeded", accelerationMs2, "m/s²", now);
            lastRapidAccelAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("rapid_accel")) {
                speakNativeAlert(nativeAlertMessage("rapid_accel"), false, () -> lastRapidAccelAlertMs = now);
            }
            return;
        }

        double lateralG = calculateLateralG(speedKmh, headingChange, dtMs);
        lastLateralG = lateralG;
        double sharpTurnThreshold = getSettingDouble("threshold_sharp_turn_g_low", DetectionConstants.SHARP_TURN_G_LOW);
        if (headingChange >= SHARP_TURN_MIN_HEADING_CHANGE_DEG &&
            speedKmh >= DetectionConstants.CORNERING_MIN_SPEED_KMH &&
            lateralG >= sharpTurnThreshold &&
            now - lastCorneringAlertMs >= MANOEUVRE_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("sharp_cornering", "Cornering threshold exceeded", lateralG, "g", now);
            lastCorneringAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("sharp_cornering")) {
                speakNativeAlert(nativeAlertMessage("sharp_cornering"), false, () -> lastCorneringAlertMs = now);
            }
            return;
        }

        double headingDriftThreshold = getSettingDouble("threshold_heading_drift_std_degs", DetectionConstants.HEADING_DRIFT_STD_DEG);
        if (shouldAlertHeadingDrift(headingDriftThreshold) &&
            now - lastHeadingDriftAlertMs >= HEADING_DRIFT_ALERT_COOLDOWN_MS) {
            recordLiveTelemetryEvent("heading_pattern", "Heading pattern recorded", headingDriftThreshold, "°", now);
            lastHeadingDriftAlertMs = now;
            if (isNativeVoiceAlertTypeEnabled("heading_drift")) {
                speakNativeAlert(nativeAlertMessage("heading_drift"), false, () -> lastHeadingDriftAlertMs = now);
            }
        }
    }

    private void recordRecentSpeedSample(double speedKmh) {
        if (!Double.isFinite(speedKmh) || speedKmh < 0d) return;
        recentSpeedsKmh.addLast(speedKmh);
        while (recentSpeedsKmh.size() > RECENT_SPEED_WINDOW) recentSpeedsKmh.pollFirst();
    }

    /**
     * 85th percentile of the recent speeds, or NaN before there are enough of them.
     *
     * The minimum matters: two or three fixes out of a car park would read as an
     * urban road and pull the assumed limit down to 50 on a motorway slip road.
     */
    private double recentSpeedP85Kmh() {
        if (recentSpeedsKmh.size() < MIN_RECENT_SPEED_SAMPLES) return Double.NaN;
        double[] values = new double[recentSpeedsKmh.size()];
        int index = 0;
        for (Double sample : recentSpeedsKmh) values[index++] = sample;
        Arrays.sort(values);
        return SpeedRegionDefaults.percentileFromSorted(values, 85d);
    }

    /** Matches speedDefaultRegionFromSettings: the configured region, else the country. */
    private String speedDefaultRegionSetting() {
        String configured = getSettingString("configurable_country_defaults", "");
        if (!configured.isEmpty()) return configured;
        return getSettingString("country_code", "");
    }

    @Nullable
    private NativeSpeedLimit resolveLocalSpeedLimit(double lat, double lng, double headingDeg, long nowMs) {
        try {
            SharedPreferences preferences = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
            String mirrorRaw = preferences.getString(SPEED_KNOWLEDGE_KEY, null);
            boolean mirrorPresent = preferences.contains(SPEED_KNOWLEDGE_KEY);
            // This is a one-way migration marker. Presence alone is enough to
            // block legacy fallback, even if its stored value is damaged.
            boolean mirrorInitialized = preferences.contains(SPEED_KNOWLEDGE_MIRROR_INITIALIZED_KEY);
            // Package replacement can restart this service before the WebView has
            // migrated the previous release's mirror. Read the old key only when
            // the new mirror is genuinely absent; a present but malformed mirror
            // must fail closed instead of silently falling back to stale data.
            String legacyRaw = mirrorPresent || mirrorInitialized
                ? null
                : preferences.getString(LEGACY_SPEED_KNOWLEDGE_KEY, null);
            StoredSpeedKnowledgeSelection selected = selectStoredSpeedKnowledgePayload(
                mirrorRaw,
                legacyRaw,
                mirrorInitialized
            );
            if (selected == null) return null;
            JSONObject data = parseStoredSpeedKnowledge(selected.raw, selected.storageKey);
            if (data == null) return null;
            return findLocalSpeedLimit(data, lat, lng, headingDeg, nowMs);
        } catch (Exception error) {
            recordDiagnostic(
                "local_speed_lookup_failed",
                "Saved road speed could not be read for a background voice check.",
                error.getMessage() == null ? "invalid_speed_knowledge" : error.getMessage(),
                lastKnownSpeedKmh,
                0L,
                0d
            );
            return null;
        }
    }

    @Nullable
    static NativeSpeedLimit findLocalSpeedLimit(JSONObject data, double lat, double lng, long nowMs) {
        return findLocalSpeedLimit(data, lat, lng, Double.NaN, nowMs);
    }

    @Nullable
    static NativeSpeedLimit findLocalSpeedLimit(JSONObject data, double lat, double lng, double headingDeg, long nowMs) {
        return findLocalSpeedLimit(data, lat, lng, headingDeg, nowMs, null);
    }

    @Nullable
    static NativeSpeedLimit findLocalSpeedLimit(
        JSONObject data,
        double lat,
        double lng,
        double headingDeg,
        long nowMs,
        @Nullable Integer utcOffsetMinutes
    ) {
        if (data == null || !Double.isFinite(lat) || !Double.isFinite(lng)) return null;
        if (matchesExcludedSpeedSection(data, lat, lng, headingDeg, nowMs, utcOffsetMinutes)) return null;
        JSONArray corrections = data.optJSONArray("corrections");
        if (corrections == null) corrections = new JSONArray();

        NativeSpeedLimitMatch bestMatch = null;
        long bestAppliedAtMs = Long.MIN_VALUE;
        int bestAuthority = Integer.MAX_VALUE;
        int bestSpecificity = Integer.MIN_VALUE;
        for (int index = 0; index < corrections.length(); index++) {
            JSONObject correction = corrections.optJSONObject(index);
            if (correction == null) continue;
            double limitKmh = correction.optDouble("limitKmh", Double.NaN);
            String geohash = correction.optString("geohash", "");
            JSONArray sectionPoints = correction.optJSONArray("sectionPoints");
            boolean hasSection = hasUsableTracedSection(sectionPoints);
            if (!plausibleSavedSpeedLimit(limitKmh) || !hasSection) continue;

            if (!correctionEffectiveAt(correction, nowMs)) continue;
            NativeSpeedLimitMatch match = correctionLocationMatch(
                correction,
                geohash,
                lat,
                lng,
                headingDeg,
                nowMs,
                utcOffsetMinutes
            );
            if (match == null) continue;

            long appliedAtMs = parseIsoEpochMs(correction.optString("appliedAt", ""));
            int authority = correctionAuthorityRank(correction);
            int specificity = correctionSpecificity(correction);
            if (bestMatch != null) {
                int comparison = compareSpeedLimitMatches(
                    match,
                    authority,
                    specificity,
                    appliedAtMs,
                    bestMatch,
                    bestAuthority,
                    bestSpecificity,
                    bestAppliedAtMs
                );
                if (comparison >= 0) continue;
            }
            String source = "user_confirmed_posted_sign".equals(correction.optString("source", ""))
                ? "user_confirmed_posted_sign"
                : "user_entered_estimate";
            match.speedLimit = new NativeSpeedLimit(limitKmh, source);
            bestMatch = match;
            bestAppliedAtMs = appliedAtMs;
            bestAuthority = authority;
            bestSpecificity = specificity;
        }
        if (bestMatch != null) return bestMatch.speedLimit;

        JSONObject roadMemory = data.optJSONObject("roadMemory");
        JSONArray candidates = roadMemory == null ? null : roadMemory.optJSONArray("candidates");
        NativeSpeedLimitMatch bestCandidateMatch = null;
        double bestCandidateConfidence = Double.NEGATIVE_INFINITY;
        int bestCandidateTripCount = -1;
        if (candidates != null) {
            for (int index = 0; index < candidates.length(); index++) {
                JSONObject candidate = candidates.optJSONObject(index);
                if (candidate == null || !roadMemoryCandidateEligible(candidate, nowMs)) continue;
                double limitKmh = roadMemoryLimitAt(candidate, nowMs, utcOffsetMinutes);
                String geohash = candidate.optString("geohash", "");
                JSONArray sectionPoints = candidate.optJSONArray("sectionPoints");
                boolean hasSection = hasUsableTracedSection(sectionPoints);
                if (!plausibleSavedSpeedLimit(limitKmh) || !hasSection) continue;
                NativeSpeedLimitMatch match = correctionLocationMatch(
                    candidate,
                    geohash,
                    lat,
                    lng,
                    headingDeg,
                    nowMs,
                    utcOffsetMinutes
                );
                if (match == null) continue;
                double confidence = roadMemoryCandidateCurrentConfidence(candidate, nowMs);
                int tripCount = candidate.optInt("tripCount", 0);
                if (bestCandidateMatch == null ||
                    confidence > bestCandidateConfidence ||
                    (confidence == bestCandidateConfidence && tripCount > bestCandidateTripCount) ||
                    (confidence == bestCandidateConfidence && tripCount == bestCandidateTripCount &&
                        match.distanceKm < bestCandidateMatch.distanceKm)) {
                    match.speedLimit = new NativeSpeedLimit(limitKmh, "local_road_memory");
                    bestCandidateMatch = match;
                    bestCandidateConfidence = confidence;
                    bestCandidateTripCount = tripCount;
                }
            }
        }
        if (bestCandidateMatch != null) return bestCandidateMatch.speedLimit;

        // Road Memory carries corridor geometry and direction evidence, while
        // a learned cell is only a coarse fallback. This ordering prevents a
        // cell learned on a parallel road from overriding a matched corridor.
        return findEligibleLocalSpeedCell(data, lat, lng, nowMs);
    }

    @Nullable
    private static NativeSpeedLimit findEligibleLocalSpeedCell(
        JSONObject data,
        double lat,
        double lng,
        long timestampMs
    ) {
        JSONObject cells = data == null ? null : data.optJSONObject("cells");
        if (cells == null) return null;
        int[] precisions = {
            SPEED_KNOWLEDGE_GEOHASH_PRECISION,
            SPEED_KNOWLEDGE_FALLBACK_GEOHASH_PRECISION,
        };
        for (int precision : precisions) {
            String geohash = geohashEncode(lat, lng, precision);
            JSONObject cell = cells.optJSONObject(geohash);
            if (!nativeSpeedCellEligible(cell, timestampMs)) continue;
            return new NativeSpeedLimit(
                cell.optDouble("limitKmh", Double.NaN),
                cell.optString("source", "trip_consensus")
            );
        }
        return null;
    }

    private static boolean nativeSpeedCellEligible(@Nullable JSONObject cell, long timestampMs) {
        if (cell == null || timestampMs < 0L) return false;
        double limitKmh = cell.optDouble("limitKmh", Double.NaN);
        String source = cell.optString("source", "");
        if (!plausibleSavedSpeedLimit(limitKmh) || !nativeSpeedCellSourceAllowed(source)) return false;
        if (
            "trip_consensus".equals(source) &&
            nativeSpeedCellIndependentTripCount(cell) < SPEED_KNOWLEDGE_MIN_TRIP_CONSENSUS_EVIDENCE
        ) return false;
        if (cell.optBoolean("conflict", false)) return false;
        Object conflictDetails = cell.opt("conflictDetails");
        if (conflictDetails != null && conflictDetails != JSONObject.NULL &&
            !(conflictDetails instanceof String && ((String) conflictDetails).isEmpty())) return false;

        double confidence = cell.has("confidence")
            ? cell.optDouble("confidence", Double.NaN)
            : nativeSpeedCellDefaultConfidence(source);
        if (!Double.isFinite(confidence) || confidence < DetectionConstants.SPEED_ALERT_MIN_CONFIDENCE) return false;

        Object rawExpiry = cell.opt("expiresAt");
        Long expiresAtMs = parseFlexibleEpochMsOrNull(rawExpiry);
        if (expiresAtMs != null && expiresAtMs <= timestampMs) return false;

        Object rawVerifiedAt = firstPresentJsonValue(
            cell,
            "verifiedAt",
            "lastVerifiedAt",
            "appliedAt",
            "lastUpdatedAt",
            "speed_limit_verified_at"
        );
        Long verifiedAtMs = parseFlexibleEpochMsOrNull(rawVerifiedAt);
        if (verifiedAtMs != null) {
            long ageMs = Math.max(0L, timestampMs - verifiedAtMs);
            long ageDays = (long) Math.floor(ageMs / (24d * 60d * 60d * 1000d));
            if (ageDays > nativeSpeedCellReviewDays(source)) return false;
        }
        return true;
    }

    private static int nativeSpeedCellIndependentTripCount(JSONObject cell) {
        Set<String> independentIds = new HashSet<>();
        JSONArray rawIds = cell.optJSONArray("tripEvidenceIds");
        if (rawIds != null) {
            for (int index = 0; index < rawIds.length(); index++) {
                String value = rawIds.optString(index, "").trim();
                if (!value.isEmpty()) independentIds.add(value);
            }
        }
        int tripCount = Math.max(0, cell.optInt("tripCount", 0));
        int evidenceCount = Math.max(0, cell.optInt("evidenceCount", 0));
        return Math.max(independentIds.size(), Math.min(tripCount, evidenceCount));
    }

    private static boolean nativeSpeedCellSourceAllowed(String source) {
        return "trip_consensus".equals(source) ||
            "user_confirmed_posted_sign".equals(source) ||
            "user_entered_estimate".equals(source) ||
            "user_correction".equals(source) ||
            "openstreetmap".equals(source);
    }

    private static double nativeSpeedCellDefaultConfidence(String source) {
        if ("user_confirmed_posted_sign".equals(source)) return 0.92d;
        if ("openstreetmap".equals(source)) return 0.90d;
        if ("user_entered_estimate".equals(source) || "user_correction".equals(source)) return 0.75d;
        if ("trip_consensus".equals(source)) return 0.68d;
        return 0d;
    }

    private static int nativeSpeedCellReviewDays(String source) {
        if ("user_confirmed_posted_sign".equals(source)) return 365;
        if ("openstreetmap".equals(source)) return 270;
        if ("user_entered_estimate".equals(source) || "user_correction".equals(source)) return 120;
        if ("trip_consensus".equals(source)) return 90;
        return 0;
    }

    @Nullable
    private static Object firstPresentJsonValue(JSONObject value, String... keys) {
        if (value == null || keys == null) return null;
        for (String key : keys) {
            Object candidate = value.opt(key);
            if (candidate != null && candidate != JSONObject.NULL) return candidate;
        }
        return null;
    }

    private static boolean matchesExcludedSpeedSection(
        JSONObject data,
        double lat,
        double lng,
        double headingDeg,
        long timestampMs,
        @Nullable Integer utcOffsetMinutes
    ) {
        JSONArray exclusions = data == null ? null : data.optJSONArray("excludedSections");
        if (exclusions == null) return false;
        for (int index = 0; index < exclusions.length(); index++) {
            JSONObject exclusion = exclusions.optJSONObject(index);
            if (exclusion == null || exclusion.optBoolean("active", true) == false) continue;
            String geohash = exclusion.optString("geohash", "");
            JSONArray sectionPoints = exclusion.optJSONArray("sectionPoints");
            boolean hasSection = sectionPoints != null && sectionPoints.length() >= 2;
            if (geohash.isEmpty() && !hasSection) continue;
            NativeSpeedLimitMatch match = correctionLocationMatch(
                exclusion,
                geohash,
                lat,
                lng,
                headingDeg,
                timestampMs,
                utcOffsetMinutes
            );
            if (match != null) return true;
        }
        return false;
    }

    private static boolean roadMemoryCandidateEligible(JSONObject candidate, long nowMs) {
        if (candidate == null || nowMs <= 0L) return false;
        boolean hasResolverContract = candidate.has("canAffectScoreAndAlerts") || candidate.has("evidenceConfidence");
        if (hasResolverContract) {
            if (!candidate.optBoolean("canAffectScoreAndAlerts", false) ||
                !candidate.optBoolean("active", true) ||
                candidate.optInt("tripCount", 0) < 4 ||
                !"operational".equals(candidate.optString("stage", "operational"))) return false;
            return roadMemoryCandidateEffectiveConfidence(candidate, nowMs) >= 0.64d;
        }

        // Backward compatibility for mirrors written by pre-contract builds.
        if (!candidate.optBoolean("intelligenceValidated", false) ||
            !candidate.optBoolean("active", true) ||
            candidate.optInt("tripCount", 0) < 3 ||
            !"operational".equals(candidate.optString("stage", "operational"))) return false;
        return roadMemoryCandidateCurrentConfidence(candidate, nowMs) >= 0.62d;
    }

    private static double roadMemoryCandidateEffectiveConfidence(JSONObject candidate, long nowMs) {
        long observedAtMs = latestRoadMemoryObservationMs(candidate);
        if (observedAtMs <= 0L) return 0d;
        long ageMs = Math.max(0L, nowMs - observedAtMs);
        if (ageMs > 120L * 24L * 60L * 60L * 1000L) return 0d;
        double ageDays = ageMs / (24d * 60d * 60d * 1000d);
        double confidenceDecay = ageDays <= 45d ? 0d : Math.min(0.24d, (ageDays - 45d) * 0.0025d);
        double evidenceConfidence = candidate.has("evidenceConfidence")
            ? candidate.optDouble("evidenceConfidence", 0d)
            : candidate.optDouble("confidence", 0d);
        double effective = Math.max(0d, Math.min(1d, evidenceConfidence - confidenceDecay));
        return Math.round(effective * 100d) / 100d;
    }

    private static double roadMemoryCandidateCurrentConfidence(JSONObject candidate, long nowMs) {
        double effectiveConfidence = roadMemoryCandidateEffectiveConfidence(candidate, nowMs);
        if (candidate.has("confidenceCalibrationFactor")) {
            double factor = Math.max(0d, Math.min(1d, candidate.optDouble("confidenceCalibrationFactor", 1d)));
            double calibrated = Math.round(effectiveConfidence * factor * 100d) / 100d;
            return Math.min(effectiveConfidence, calibrated);
        }
        if (candidate.has("evidenceConfidence")) {
            double storedEvidence = Math.max(0.0001d, candidate.optDouble("evidenceConfidence", 0d));
            double storedCalibrated = Math.max(0d, candidate.optDouble("confidence", storedEvidence));
            double inferredFactor = Math.max(0d, Math.min(1d, storedCalibrated / storedEvidence));
            double calibrated = Math.round(effectiveConfidence * inferredFactor * 100d) / 100d;
            return Math.min(effectiveConfidence, calibrated);
        }
        return effectiveConfidence;
    }

    private static long latestRoadMemoryObservationMs(JSONObject candidate) {
        long observedAtMs = Math.max(
            parseIsoEpochMs(candidate.optString("firstObservedAt", "")),
            parseIsoEpochMs(candidate.optString("lastObservedAt", ""))
        );
        JSONArray recent = candidate.optJSONArray("recentObservations");
        if (recent != null) {
            for (int index = 0; index < recent.length(); index++) {
                JSONObject observation = recent.optJSONObject(index);
                if (observation == null) continue;
                observedAtMs = Math.max(
                    observedAtMs,
                    parseIsoEpochMs(observation.optString("observedAt", ""))
                );
            }
        }
        return observedAtMs;
    }

    private static double roadMemoryLimitAt(JSONObject candidate, long nowMs, @Nullable Integer utcOffsetMinutes) {
        double fallback = candidate == null ? Double.NaN : candidate.optDouble("limitKmh", Double.NaN);
        if (candidate == null || nowMs <= 0L) return fallback;
        JSONArray profiles = candidate.optJSONArray("timeProfiles");
        boolean profilesAccepted = !candidate.optString("timeProfilesAcceptedAt", "").trim().isEmpty() ||
            "time_profiles_accepted".equals(candidate.optString("reviewState", ""));
        if (!profilesAccepted || profiles == null) return fallback;
        String bucket = roadMemoryTimeBucket(nowMs, utcOffsetMinutes);
        for (int index = 0; index < profiles.length(); index++) {
            JSONObject profile = profiles.optJSONObject(index);
            if (profile == null ||
                !profile.optBoolean("eligible", false) ||
                !bucket.equals(profile.optString("bucket", ""))) continue;
            double limitKmh = profile.optDouble("limitKmh", Double.NaN);
            if (plausibleSavedSpeedLimit(limitKmh)) return limitKmh;
        }
        return fallback;
    }

    private static boolean plausibleSavedSpeedLimit(double limitKmh) {
        return Double.isFinite(limitKmh) && limitKmh > 0d && limitKmh <= SPEED_KNOWLEDGE_MAX_LIMIT_KMH;
    }

    private static String roadMemoryTimeBucket(long nowMs, @Nullable Integer utcOffsetMinutes) {
        LocalDateTime date = localDateTimeAt(nowMs, utcOffsetMinutes);
        int hour = date.getHour();
        boolean weekday = date.getDayOfWeek().getValue() >= 1 && date.getDayOfWeek().getValue() <= 5;
        if (hour < 5) return "overnight";
        if (weekday && hour >= 6 && hour < 10) return "weekday_morning";
        if (weekday && hour >= 15 && hour < 19) return "weekday_evening";
        return "other_times";
    }

    static boolean correctionMatchesLocation(JSONObject correction, String geohash, double lat, double lng, double headingDeg, long nowMs) {
        return correctionEffectiveAt(correction, nowMs) &&
            correctionLocationMatch(correction, geohash, lat, lng, headingDeg, nowMs, null) != null;
    }

    @Nullable
    private static NativeSpeedLimitMatch correctionLocationMatch(
        JSONObject correction,
        String geohash,
        double lat,
        double lng,
        double headingDeg,
        long nowMs,
        @Nullable Integer utcOffsetMinutes
    ) {
        if (!correctionQualifierSemanticsValid(correction)) return null;
        if (!correctionActiveAt(correction, nowMs, utcOffsetMinutes)) return null;
        if (!correctionMatchesDirection(correction, headingDeg)) return null;
        JSONArray sectionPoints = correction == null ? null : correction.optJSONArray("sectionPoints");
        double headingDeltaDeg = correctionHeadingDelta(correction, headingDeg);
        if (sectionPoints != null && sectionPoints.length() >= 2) {
            JSONObject previous = null;
            double bestDistanceKm = Double.POSITIVE_INFINITY;
            for (int index = 0; index < sectionPoints.length(); index++) {
                JSONObject current = sectionPoints.optJSONObject(index);
                if (!isUsableCoordinate(current)) continue;
                if (previous != null) {
                    bestDistanceKm = Math.min(bestDistanceKm, pointToSegmentDistanceKm(lat, lng, previous, current));
                }
                previous = current;
            }
            return bestDistanceKm <= SPEED_KNOWLEDGE_SECTION_MATCH_RADIUS_KM
                ? new NativeSpeedLimitMatch(bestDistanceKm, headingDeltaDeg)
                : null;
        }

        double[] center = geohashCenter(geohash);
        if (center == null) return null;
        double distanceKm = haversineKm(center[0], center[1], lat, lng);
        return distanceKm <= SPEED_KNOWLEDGE_MATCH_RADIUS_KM
            ? new NativeSpeedLimitMatch(distanceKm, headingDeltaDeg)
            : null;
    }

    private static int compareSpeedLimitMatches(
        NativeSpeedLimitMatch candidate,
        int candidateAuthority,
        int candidateSpecificity,
        long candidateAppliedAtMs,
        NativeSpeedLimitMatch current,
        int currentAuthority,
        int currentSpecificity,
        long currentAppliedAtMs
    ) {
        int authorityComparison = Integer.compare(candidateAuthority, currentAuthority);
        if (authorityComparison != 0) return authorityComparison;
        int specificityComparison = Integer.compare(currentSpecificity, candidateSpecificity);
        if (specificityComparison != 0) return specificityComparison;
        int headingComparison = Double.compare(sortableMatchValue(candidate.headingDeltaDeg), sortableMatchValue(current.headingDeltaDeg));
        if (headingComparison != 0) return headingComparison;
        int distanceComparison = Double.compare(sortableMatchValue(candidate.distanceKm), sortableMatchValue(current.distanceKm));
        if (distanceComparison != 0) return distanceComparison;
        return Long.compare(currentAppliedAtMs, candidateAppliedAtMs);
    }

    private static double sortableMatchValue(double value) {
        return Double.isFinite(value) ? value : Double.MAX_VALUE;
    }

    private static int correctionAuthorityRank(@Nullable JSONObject correction) {
        return correction != null && "user_confirmed_posted_sign".equals(correction.optString("source", "")) ? 0 : 1;
    }

    private static int correctionSpecificity(@Nullable JSONObject correction) {
        if (correction == null) return 0;
        String mode = correction.optString("directionMode", "both");
        int directionScore = "forward".equals(mode) || "reverse".equals(mode) ? 2 : 0;
        JSONObject rule = correction.optJSONObject("timeRule");
        return directionScore + (rule != null && rule.optBoolean("enabled", false) ? 1 : 0);
    }

    private static boolean correctionEffectiveAt(@Nullable JSONObject correction, long timestampMs) {
        if (correction == null || timestampMs < 0L) return false;
        Object rawValidFrom = correction.has("validFrom")
            ? correction.opt("validFrom")
            : correction.opt("valid_from");
        Object rawExpiresAt = correction.opt("expiresAt");
        boolean hasValidFrom = hasTimestampValue(rawValidFrom);
        boolean hasExpiresAt = hasTimestampValue(rawExpiresAt);
        Long validFromMs = parseFlexibleEpochMsOrNull(rawValidFrom);
        Long expiresAtMs = parseFlexibleEpochMsOrNull(rawExpiresAt);
        // A malformed validity boundary must fail closed instead of silently
        // turning a temporary rule into an all-time rule.
        if (hasValidFrom && validFromMs == null) return false;
        if (hasExpiresAt && expiresAtMs == null) return false;
        if (validFromMs != null && timestampMs < validFromMs) return false;
        return expiresAtMs == null || timestampMs < expiresAtMs;
    }

    private static boolean correctionActiveAt(
        @Nullable JSONObject correction,
        long nowMs,
        @Nullable Integer utcOffsetMinutes
    ) {
        Object rawRule = correction == null ? null : correction.opt("timeRule");
        if (rawRule == null || rawRule == JSONObject.NULL) return true;
        if (!(rawRule instanceof JSONObject)) return false;
        JSONObject rule = (JSONObject) rawRule;
        Object rawEnabled = rule.opt("enabled");
        if (!(rawEnabled instanceof Boolean)) return false;
        if (!((Boolean) rawEnabled)) return true;
        if (nowMs < 0L) return false;
        Object rawStartMinutes = rule.opt("startMinutes");
        Object rawEndMinutes = rule.opt("endMinutes");
        if (!(rawStartMinutes instanceof Number) || !(rawEndMinutes instanceof Number)) return false;
        double rawStart = ((Number) rawStartMinutes).doubleValue();
        double rawEnd = ((Number) rawEndMinutes).doubleValue();
        if (!Double.isFinite(rawStart) || !Double.isFinite(rawEnd) ||
            rawStart != Math.rint(rawStart) || rawEnd != Math.rint(rawEnd) ||
            rawStart < 0d || rawStart > 1439d || rawEnd < 0d || rawEnd > 1439d) return false;
        JSONArray days = rule.optJSONArray("days");
        if (!validTimeRuleDays(days)) return false;

        LocalDateTime date = localDateTimeAt(nowMs, utcOffsetMinutes);
        int jsDay = date.getDayOfWeek().getValue() % 7;
        int startMinutes = (int) rawStart;
        int endMinutes = (int) rawEnd;
        int minutes = date.getHour() * 60 + date.getMinute();
        int scheduleDay = startMinutes > endMinutes && minutes <= endMinutes
            ? (jsDay + 6) % 7
            : jsDay;
        boolean dayAllowed = timeRuleContainsDay(days, scheduleDay);
        if (!dayAllowed) return false;
        if (startMinutes == endMinutes) return true;
        return startMinutes < endMinutes
            ? minutes >= startMinutes && minutes <= endMinutes
            : minutes >= startMinutes || minutes <= endMinutes;
    }

    private static boolean correctionQualifierSemanticsValid(@Nullable JSONObject correction) {
        if (correction == null || !correction.has("qualifierStatus") || correction.isNull("qualifierStatus")) {
            return true;
        }
        Object rawQualifier = correction.opt("qualifierStatus");
        if (!(rawQualifier instanceof String)) return false;
        String qualifier = (String) rawQualifier;
        if ("regulatory_text_no_qualifiers".equals(qualifier)) return true;
        if ("conditional_temporary_work_zone".equals(qualifier)) {
            return parseFlexibleEpochMsOrNull(correction.opt("expiresAt")) != null;
        }
        if (!"conditional_school_when_flashing".equals(qualifier) &&
            !"conditional_school".equals(qualifier) &&
            !"conditional_daytime".equals(qualifier) &&
            !"conditional_night".equals(qualifier)) return false;
        JSONObject rule = correction.optJSONObject("timeRule");
        return rule != null && rule.opt("enabled") instanceof Boolean && rule.optBoolean("enabled", false);
    }

    private static boolean validTimeRuleDays(@Nullable JSONArray days) {
        if (days == null || days.length() == 0 || days.length() > 7) return false;
        boolean[] seen = new boolean[7];
        for (int index = 0; index < days.length(); index++) {
            Object raw = days.opt(index);
            if (!(raw instanceof Number)) return false;
            double numeric = ((Number) raw).doubleValue();
            if (!Double.isFinite(numeric) || numeric != Math.rint(numeric) || numeric < 0d || numeric > 6d) {
                return false;
            }
            int day = (int) numeric;
            if (seen[day]) return false;
            seen[day] = true;
        }
        return true;
    }

    private static boolean timeRuleContainsDay(@Nullable JSONArray days, int expectedDay) {
        if (days == null) return false;
        for (int index = 0; index < days.length(); index++) {
            Object raw = days.opt(index);
            if (raw == null || raw == JSONObject.NULL) continue;
            try {
                double numeric = raw instanceof Number
                    ? ((Number) raw).doubleValue()
                    : Double.parseDouble(String.valueOf(raw));
                if (Double.isFinite(numeric) && numeric == Math.rint(numeric) &&
                    numeric >= 0d && numeric <= 6d && (int) numeric == expectedDay) return true;
            } catch (NumberFormatException ignored) {
                // Invalid days are ignored exactly like the web normalizer.
            }
        }
        return false;
    }

    private static LocalDateTime localDateTimeAt(long timestampMs, @Nullable Integer utcOffsetMinutes) {
        if (utcOffsetMinutes != null && utcOffsetMinutes >= -18 * 60 && utcOffsetMinutes <= 18 * 60) {
            ZoneOffset offset = ZoneOffset.ofTotalSeconds(utcOffsetMinutes * 60);
            return LocalDateTime.ofInstant(Instant.ofEpochMilli(timestampMs), offset);
        }
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(timestampMs), ZoneId.systemDefault());
    }

    private static boolean correctionMatchesDirection(@Nullable JSONObject correction, double headingDeg) {
        String mode = "both";
        if (correction != null && correction.has("directionMode")) {
            Object rawMode = correction.opt("directionMode");
            if (!(rawMode instanceof String)) return false;
            mode = (String) rawMode;
            if (!"both".equals(mode) && !"forward".equals(mode) && !"reverse".equals(mode)) return false;
        }
        if ("both".equals(mode)) return true;
        if (!Double.isFinite(headingDeg)) return false;
        double bearing = correction.optDouble("directionBearing", Double.NaN);
        if (!Double.isFinite(bearing)) {
            bearing = sectionBearing(correction.optJSONArray("sectionPoints"));
        }
        if (!Double.isFinite(bearing)) return false;
        double expected = "reverse".equals(mode) ? normalizeBearing(bearing + 180d) : normalizeBearing(bearing);
        return angleDiffDeg(headingDeg, expected) <= SPEED_KNOWLEDGE_DIRECTION_TOLERANCE_DEG;
    }

    private static double correctionHeadingDelta(@Nullable JSONObject correction, double headingDeg) {
        if (!Double.isFinite(headingDeg) || correction == null) return Double.POSITIVE_INFINITY;
        double bearing = correction.optDouble("directionBearing", Double.NaN);
        if (!Double.isFinite(bearing)) {
            bearing = sectionBearing(correction.optJSONArray("sectionPoints"));
        }
        if (!Double.isFinite(bearing)) return Double.POSITIVE_INFINITY;
        String mode = correction.optString("directionMode", "both");
        double forwardDelta = angleDiffDeg(headingDeg, bearing);
        double reverseDelta = angleDiffDeg(headingDeg, normalizeBearing(bearing + 180d));
        if ("forward".equals(mode)) return forwardDelta;
        if ("reverse".equals(mode)) return reverseDelta;
        return Math.min(forwardDelta, reverseDelta);
    }

    private static double sectionBearing(@Nullable JSONArray points) {
        if (points == null || points.length() < 2) return Double.NaN;
        JSONObject first = null;
        JSONObject last = null;
        for (int index = 0; index < points.length(); index++) {
            JSONObject point = points.optJSONObject(index);
            if (!isUsableCoordinate(point)) continue;
            if (first == null) first = point;
            last = point;
        }
        if (first == null || last == null || first == last) return Double.NaN;
        return bearingDeg(
            first.optDouble("lat", Double.NaN),
            first.optDouble("lng", Double.NaN),
            last.optDouble("lat", Double.NaN),
            last.optDouble("lng", Double.NaN)
        );
    }

    private static double bearingDeg(double startLat, double startLng, double endLat, double endLng) {
        if (!Double.isFinite(startLat) || !Double.isFinite(startLng) || !Double.isFinite(endLat) || !Double.isFinite(endLng)) {
            return Double.NaN;
        }
        double startLatRad = Math.toRadians(startLat);
        double endLatRad = Math.toRadians(endLat);
        double deltaLngRad = Math.toRadians(endLng - startLng);
        double y = Math.sin(deltaLngRad) * Math.cos(endLatRad);
        double x = Math.cos(startLatRad) * Math.sin(endLatRad) -
            Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLngRad);
        return normalizeBearing(Math.toDegrees(Math.atan2(y, x)));
    }

    private static double normalizeBearing(double value) {
        return ((value % 360d) + 360d) % 360d;
    }

    private static double angleDiffDeg(double a, double b) {
        if (!Double.isFinite(a) || !Double.isFinite(b)) return Double.POSITIVE_INFINITY;
        return Math.abs((((a - b) + 540d) % 360d) - 180d);
    }

    private static boolean isUsableCoordinate(@Nullable JSONObject point) {
        if (point == null) return false;
        double lat = point.optDouble("lat", Double.NaN);
        double lng = point.optDouble("lng", Double.NaN);
        return Double.isFinite(lat) &&
            Double.isFinite(lng) &&
            lat >= -90d &&
            lat <= 90d &&
            lng >= -180d &&
            lng <= 180d &&
            !(Math.abs(lat) < 0.001d && Math.abs(lng) < 0.001d);
    }

    private static boolean hasUsableTracedSection(@Nullable JSONArray sectionPoints) {
        if (sectionPoints == null || sectionPoints.length() < 2) return false;
        int usableCount = 0;
        for (int index = 0; index < sectionPoints.length(); index++) {
            if (isUsableCoordinate(sectionPoints.optJSONObject(index)) && ++usableCount >= 2) return true;
        }
        return false;
    }

    private static double pointToSegmentDistanceKm(double lat, double lng, JSONObject start, JSONObject end) {
        double startLat = start.optDouble("lat", Double.NaN);
        double startLng = start.optDouble("lng", Double.NaN);
        double endLat = end.optDouble("lat", Double.NaN);
        double endLng = end.optDouble("lng", Double.NaN);
        if (!Double.isFinite(lat) ||
            !Double.isFinite(lng) ||
            !Double.isFinite(startLat) ||
            !Double.isFinite(startLng) ||
            !Double.isFinite(endLat) ||
            !Double.isFinite(endLng)) {
            return Double.POSITIVE_INFINITY;
        }

        double meanLat = Math.toRadians((lat + startLat + endLat) / 3d);
        double kmPerLatDegree = 111.32d;
        double kmPerLngDegree = Math.max(1d, 111.32d * Math.cos(meanLat));
        double px = (lng - startLng) * kmPerLngDegree;
        double py = (lat - startLat) * kmPerLatDegree;
        double vx = (endLng - startLng) * kmPerLngDegree;
        double vy = (endLat - startLat) * kmPerLatDegree;
        double lengthSquared = vx * vx + vy * vy;
        if (lengthSquared <= 0d) return Math.hypot(px, py);
        double projection = Math.max(0d, Math.min(1d, (px * vx + py * vy) / lengthSquared));
        return Math.hypot(px - projection * vx, py - projection * vy);
    }

    static String geohashEncode(double lat, double lng, int precision) {
        double[] latitude = new double[]{ -90d, 90d };
        double[] longitude = new double[]{ -180d, 180d };
        StringBuilder hash = new StringBuilder();
        int bit = 0;
        int character = 0;
        boolean even = true;

        while (hash.length() < precision) {
            double[] range = even ? longitude : latitude;
            double value = even ? lng : lat;
            double midpoint = (range[0] + range[1]) / 2d;
            if (value >= midpoint) {
                character |= 1 << (4 - bit);
                range[0] = midpoint;
            } else {
                range[1] = midpoint;
            }
            even = !even;
            if (bit < 4) {
                bit++;
            } else {
                hash.append(GEOHASH_BASE32.charAt(character));
                bit = 0;
                character = 0;
            }
        }
        return hash.toString();
    }

    @Nullable
    static double[] geohashCenter(String hash) {
        if (hash == null || hash.trim().isEmpty()) return null;
        double[] latitude = new double[]{ -90d, 90d };
        double[] longitude = new double[]{ -180d, 180d };
        boolean even = true;
        for (int index = 0; index < hash.length(); index++) {
            int value = GEOHASH_BASE32.indexOf(hash.charAt(index));
            if (value < 0) return null;
            for (int mask : new int[]{ 16, 8, 4, 2, 1 }) {
                double[] range = even ? longitude : latitude;
                double midpoint = (range[0] + range[1]) / 2d;
                if ((value & mask) != 0) range[0] = midpoint;
                else range[1] = midpoint;
                even = !even;
            }
        }
        return new double[]{
            (latitude[0] + latitude[1]) / 2d,
            (longitude[0] + longitude[1]) / 2d,
        };
    }

    private static long parseIsoEpochMs(String value) {
        if (value == null || value.trim().isEmpty()) return 0L;
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return 0L;
        }
    }

    @Nullable
    static JSONObject parseStoredSpeedKnowledge(@Nullable String raw) throws Exception {
        return parseStoredSpeedKnowledge(raw, SPEED_KNOWLEDGE_KEY);
    }

    @Nullable
    static JSONObject parseStoredSpeedKnowledge(@Nullable String raw, String storageKey) throws Exception {
        if (raw == null || raw.trim().isEmpty()) return null;
        if (!SPEED_KNOWLEDGE_KEY.equals(storageKey) && !LEGACY_SPEED_KNOWLEDGE_KEY.equals(storageKey)) {
            throw new IllegalArgumentException("Unsupported saved-speed storage key.");
        }
        String trimmed = raw.trim();
        JSONObject parsed = new JSONObject(trimmed);
        if (!parsed.optBoolean("encrypted", false)) {
            // One-release compatibility for the old minimal native mirror. The
            // next JS sync rewrites it with Android-Keystore-backed AES-GCM.
            return parsed;
        }
        if (parsed.optInt("version", 0) != 1) {
            throw new IllegalArgumentException("Unsupported saved-speed encryption envelope.");
        }
        String ciphertext = parsed.optString("ciphertext", "");
        int keyVersion = parsed.optInt("key_version", 0);
        if (ciphertext.isEmpty() || keyVersion <= 0) {
            throw new IllegalArgumentException("Invalid saved-speed encryption envelope.");
        }
        String plaintext = DriveSensePayloadCrypto.decrypt(
            ciphertext,
            "storage:" + storageKey,
            keyVersion
        );
        return new JSONObject(plaintext);
    }

    private static boolean hasStoredSpeedKnowledgePayload(@Nullable String raw) {
        return raw != null && !raw.trim().isEmpty();
    }

    @Nullable
    static StoredSpeedKnowledgeSelection selectStoredSpeedKnowledgePayload(
        @Nullable String mirrorRaw,
        @Nullable String legacyRaw,
        boolean mirrorInitialized
    ) {
        // A non-null value means the mirror key exists. Empty or whitespace
        // content is malformed, not absent, and must still suppress fallback.
        if (mirrorRaw != null) {
            return new StoredSpeedKnowledgeSelection(mirrorRaw, SPEED_KNOWLEDGE_KEY);
        }
        if (!mirrorInitialized && hasStoredSpeedKnowledgePayload(legacyRaw)) {
            return new StoredSpeedKnowledgeSelection(legacyRaw, LEGACY_SPEED_KNOWLEDGE_KEY);
        }
        return null;
    }

    @Nullable
    private static Long parseIsoEpochMsOrNull(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return null;
        }
    }

    private static boolean hasTimestampValue(@Nullable Object value) {
        return value != null && value != JSONObject.NULL && !String.valueOf(value).trim().isEmpty();
    }

    @Nullable
    private static Long parseFlexibleEpochMsOrNull(@Nullable Object value) {
        if (!hasTimestampValue(value)) return null;
        if (value instanceof Number) {
            double numeric = ((Number) value).doubleValue();
            if (!Double.isFinite(numeric)) return null;
            return Math.round(numeric < 1_000_000_000_000d ? numeric * 1000d : numeric);
        }
        String text = String.valueOf(value).trim();
        try {
            double numeric = Double.parseDouble(text);
            if (!Double.isFinite(numeric)) return null;
            return Math.round(numeric < 1_000_000_000_000d ? numeric * 1000d : numeric);
        } catch (NumberFormatException ignored) {
            return parseIsoEpochMsOrNull(text);
        }
    }

    static final class NativeSpeedLimit {
        final double limitKmh;
        final String source;

        NativeSpeedLimit(double limitKmh, String source) {
            this.limitKmh = limitKmh;
            this.source = source;
        }
    }

    private static final class NativeSpeedLimitMatch {
        final double distanceKm;
        final double headingDeltaDeg;
        NativeSpeedLimit speedLimit;

        NativeSpeedLimitMatch(double distanceKm, double headingDeltaDeg) {
            this.distanceKm = distanceKm;
            this.headingDeltaDeg = headingDeltaDeg;
        }
    }

    static boolean shouldTriggerSpeedAlert(double speedKmh, double limitKmh, double marginKmh) {
        return Double.isFinite(speedKmh) &&
            Double.isFinite(limitKmh) &&
            Double.isFinite(marginKmh) &&
            limitKmh > 0d &&
            speedKmh > limitKmh + Math.max(0d, marginKmh);
    }

    static double calculateLongitudinalAccelerationMs2(double previousSpeedKmh, double speedKmh, long dtMs) {
        if (dtMs <= 0L) return 0d;
        return ((speedKmh - previousSpeedKmh) / 3.6d) / (dtMs / 1000d);
    }

    static double calculateLateralG(double speedKmh, double headingChangeDeg, long dtMs) {
        if (dtMs <= 0L || speedKmh <= 0d || headingChangeDeg <= 0d) return 0d;
        double speedMs = speedKmh / 3.6d;
        double angularVelocityRadS = Math.toRadians(headingChangeDeg) / (dtMs / 1000d);
        return Math.abs(speedMs * angularVelocityRadS) / STANDARD_GRAVITY_MS2;
    }

    static double calculateAngularStdDev(double[] headings) {
        if (headings == null || headings.length < 2) return 0d;
        double sinSum = 0d;
        double cosSum = 0d;
        int count = 0;
        for (double heading : headings) {
            if (!Double.isFinite(heading)) continue;
            double radians = Math.toRadians(heading);
            sinSum += Math.sin(radians);
            cosSum += Math.cos(radians);
            count++;
        }
        if (count < 2) return 0d;
        double mean = Math.atan2(sinSum / count, cosSum / count);
        double variance = 0d;
        for (double heading : headings) {
            if (!Double.isFinite(heading)) continue;
            double delta = Math.atan2(
                Math.sin(Math.toRadians(heading) - mean),
                Math.cos(Math.toRadians(heading) - mean)
            );
            variance += Math.toDegrees(delta) * Math.toDegrees(delta);
        }
        return Math.sqrt(variance / count);
    }

    private void resetNativeAlertState() {
        speedingSinceMs = 0L;
        lastSpeedAlertMs = 0L;
        lastHarshBrakeAlertMs = 0L;
        lastRapidAccelAlertMs = 0L;
        lastCorneringAlertMs = 0L;
        lastCloseManoeuvreAlertMs = 0L;
        lastStopStartAlertMs = 0L;
        lastHeadingDriftAlertMs = 0L;
        lastIdleAlertMs = 0L;
        lastFatigueAlertMs = 0L;
        lastPossibleIncidentAlertMs = 0L;
        nativeHeadingDriftWindow.clear();
        stopStartWindowStartMs = 0L;
        stopStartCycleCount = 0;
        trackingReadyAlertSpoken = false;
        trackingReadyAlertPending = false;
        lastTrackingReadyAlertAttemptMs = 0L;
        coachBriefAlertSpoken = false;
        coachBriefAlertPending = false;
        lastDangerZoneAlertMs = 0L;
    }

    static final class StoredSpeedKnowledgeSelection {
        final String raw;
        final String storageKey;

        StoredSpeedKnowledgeSelection(String raw, String storageKey) {
            this.raw = raw;
            this.storageKey = storageKey;
        }
    }

    private double signedHeadingDiff(double h1, double h2) {
        double diff = h2 - h1;
        while (diff > 180d) diff -= 360d;
        while (diff <= -180d) diff += 360d;
        return diff;
    }

    private void sendPossibleIncidentNotification(boolean emergencyWorkflow) {
        if (!isSettingEnabled("notifications_enabled", true) ||
            !isSettingEnabled("notif_safety_alerts_enabled", true)) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        ensureSafetyAlertsChannel();
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("deeplink", "drivesense://dashboard");
        intent.setData(Uri.parse("drivesense://dashboard"));
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            2,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );
        Intent okIntent = new Intent(this, DriveSenseAutoTrackingService.class);
        okIntent.setAction(ACTION_ACKNOWLEDGE_INCIDENT);
        PendingIntent okPendingIntent = PendingIntent.getService(
            this,
            3,
            okIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        String body = emergencyWorkflow
            ? "Impact-like motion and little movement were recorded. Open Road Sage to check in."
            : "Road Sage recorded impact-like motion followed by little movement.";
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, SAFETY_ALERTS_CHANNEL_ID)
            .setSmallIcon(getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()))
            .setContentTitle("Possible Incident Signal")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setOnlyAlertOnce(true)
            .setVibrate(new long[]{ 0, 500, 150, 500, 150, 500 });
        if (emergencyWorkflow) {
            builder.addAction(
                getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()),
                "I'm OK",
                okPendingIntent
            );
        }

        NotificationManagerCompat.from(this).notify(NOTIF_ID_POSSIBLE_INCIDENT, builder.build());
    }

    private void sendPhoneUseWarningNotification() {
        if (!isSettingEnabled("notifications_enabled", true) ||
            !isSettingEnabled("notif_safety_alerts_enabled", true) ||
            !isSettingEnabled("notif_phone_use_alert_enabled", true) ||
            !isSettingEnabled("phone_use_live_alert_enabled", true)) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - notificationPrefs().getLong(KEY_LAST_PHONE_USE_NOTIFICATION_MS, 0L) < PHONE_NOTIFY_COOLDOWN_MS) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        ensureSafetyAlertsChannel();
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("deeplink", "drivesense://dashboard");
        intent.setData(Uri.parse("drivesense://dashboard"));
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, SAFETY_ALERTS_CHANNEL_ID)
            .setSmallIcon(getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()))
            .setContentTitle("Eyes on the Road")
            .setContentText("Foreground phone activity detected while moving. Stay focused.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setOnlyAlertOnce(true)
            .setVibrate(new long[]{ 0, 300, 100, 300 });

        NotificationManagerCompat.from(this).notify(PHONE_USE_NOTIFICATION_ID, builder.build());
        notificationPrefs().edit().putLong(KEY_LAST_PHONE_USE_NOTIFICATION_MS, now).apply();
    }

    private void sendTripCompletedNotification(JSONObject trip, TripStats stats) {
        if (!isSettingEnabled("notifications_enabled", true) ||
            !isSettingEnabled("trip_end_notification", true)) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        String tripId = trip.optString("id", "");
        if (!tripId.isEmpty() && tripId.equals(notificationPrefs().getString(KEY_LAST_TRIP_COMPLETED_NOTIFICATION_ID, ""))) {
            return;
        }

        ensureSummaryChannel();
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("deeplink", "drivesense://trips/" + tripId);
        intent.setData(Uri.parse("drivesense://trips/" + Uri.encode(tripId)));
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            1,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        String body = String.format(
            Locale.US,
            isParkedStopReason(lastNativeAutoStopReason)
                ? "%.1f km recorded in %d min. Trip ended parked."
                : "%.1f km recorded in %d min. Open Road Sage to review events and score.",
            stats.distanceKm,
            Math.max(1L, stats.durationSeconds / 60L)
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, SUMMARY_CHANNEL_ID)
            .setSmallIcon(getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()))
            .setContentTitle("Trip saved")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        NotificationManagerCompat.from(this).notify(TRIP_COMPLETED_NOTIFICATION_ID, builder.build());
        if (!tripId.isEmpty()) {
            notificationPrefs().edit().putString(KEY_LAST_TRIP_COMPLETED_NOTIFICATION_ID, tripId).apply();
        }
    }

    private void ensureSafetyAlertsChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            SAFETY_ALERTS_CHANNEL_ID,
            "Safety Alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Urgent warnings while driving");
        channel.enableVibration(true);
        channel.setLightColor(Color.RED);
        channel.enableLights(true);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void ensureSummaryChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            SUMMARY_CHANNEL_ID,
            "Trip Summaries",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Trip completion and driving summary notifications.");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void stopEverything() {
        explicitStopRequested = true;
        DriveSenseTrackingWatchdog.cancel(this);
        finishTrip("service_stopped_by_user", false);
        removeActivityUpdates();
        stopLocationUpdates();
        DriveSenseNativeTripStore.setServiceEnabled(this, false);
        removeTrackingNotification();
    }

    private void removeTrackingNotification() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        cancelTrackingNotification(this);
    }

    private Notification buildNotification(String text) {
        ensureChannel();
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()))
            .setContentTitle("Road Sage ready")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        if (isTripActive() && candidateTrip) {
            builder
                .setContentTitle("Road Sage checking movement")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text));
        } else if (isTripActive()) {
            Intent stopIntent = new Intent(this, DriveSenseAutoTrackingService.class);
            stopIntent.setAction(ACTION_END_TRIP);
            PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                2,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
            );
            builder
                .setContentTitle("Road Sage trip live")
                .setUsesChronometer(true)
                .setWhen(activeStartMs > 0L ? activeStartMs : System.currentTimeMillis())
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .addAction(
                    getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()),
                    "End trip",
                    stopPendingIntent
                );
        }

        return builder.build();
    }

    private void restoreActiveTripCheckpointIfAvailable() {
        long nowMs = System.currentTimeMillis();
        JSONObject checkpoint = DriveSenseActiveTripCheckpointStore.load(this, nowMs);
        if (checkpoint == null) return;

        String checkpointTripId = checkpoint.optString("trip_id", "").trim();
        if (DriveSenseNativeTripStore.hasCompletedTrip(this, checkpointTripId)) {
            DriveSenseActiveTripCheckpointStore.clear(this);
            return;
        }

        JSONArray checkpointPoints = checkpoint.optJSONArray("route_points");
        if (checkpointPoints == null || checkpointPoints.length() < 2) {
            DriveSenseActiveTripCheckpointStore.clear(this);
            return;
        }

        activeStartMs = checkpoint.optLong("start_time_ms", 0L);
        activePoints = checkpointPoints;
        activeTimeline = checkpoint.optJSONArray("timeline");
        if (activeTimeline == null) activeTimeline = new JSONArray();
        activeMotionSamples = new JSONArray();
        activeMotionSamplesDropped = 0;
        activeCaptureProfile = resolveCaptureProfile();
        activeMotionSampleBytes = 0L;
        activeCaptureTier = null;
        activeCaptureTierSinceMs = 0L;
        lastCaptureTierEvalMs = 0L;
        activeCaptureTierSeconds.clear();
        activeIncidentEvents = checkpoint.optJSONArray("incident_events");
        if (activeIncidentEvents == null) activeIncidentEvents = new JSONArray();
        activeTelemetryEvents = new JSONArray();
        hasPermissionLoss = checkpoint.optBoolean("permission_loss", false);
        previousLocation = null;
        armedPreviousLocation = null;
        armedMovingSinceMs = 0L;
        stillSinceMs = checkpoint.optLong("still_since_ms", 0L);
        if (stillSinceMs < activeStartMs || stillSinceMs > nowMs) stillSinceMs = 0L;
        nonVehicleSinceMs = 0L;
        lastKnownSpeedKmh = Math.max(0d, checkpoint.optDouble("last_speed_kmh", 0d));
        lastLocationMs = checkpoint.optLong("last_location_ms", 0L);
        stoppedAnchorLat = Double.NaN;
        stoppedAnchorLng = Double.NaN;
        maxDriftSinceStopM = 0.0d;
        nativeMicroSteerCount = Math.max(0, checkpoint.optInt("native_phone_proxy_count", 0));
        lastNativeProxyWindowMs = 0L;
        lastNativePhoneWindowMs = 0L;
        lastLiveNotificationMs = 0L;
        lastLiveStatusMs = 0L;
        lastActiveCheckpointMs = checkpoint.optLong("updated_at_ms", nowMs);
        nativeAutoStartReason = checkpoint.optString("native_auto_start_reason", "checkpoint_recovery");
        lastNativeAutoStopReason = "";
        nativeTripStartSource = checkpoint.optString("start_source", "native_auto");
        nativeManualTripId = checkpoint.optString("manual_trip_id", "");
        nativeRecoveryTripId = checkpointTripId;
        nativeManualTrip = checkpoint.optBoolean("manual", false);
        candidateTrip = checkpoint.optBoolean("candidate", false);
        candidateNearParked = checkpoint.optBoolean("candidate_near_parked", false);
        candidateConfirmedMs = candidateTrip
            ? 0L
            : checkpoint.optLong("candidate_confirmed_ms", activeStartMs);
        recentHeadings.clear();
        recentSpeedsKmh.clear();
        nativeHeadingDriftWindow.clear();
        resetNativeAlertState();
        resetMotionState();
        recordTimeline(
            "checkpoint_recovered",
            candidateTrip
                ? "Early trip candidate recovered after Android restarted tracking."
                : "Active trip recovered after Android restarted tracking.",
            candidateTrip ? "encrypted_candidate_checkpoint" : "encrypted_active_trip_checkpoint",
            lastKnownSpeedKmh,
            0L,
            0d
        );
        recordDiagnostic(
            "checkpoint_recovered",
            candidateTrip
                ? "Early trip candidate recovered after Android restarted tracking."
                : "Active trip recovered after Android restarted tracking.",
            candidateTrip ? "encrypted_candidate_checkpoint" : "encrypted_active_trip_checkpoint",
            lastKnownSpeedKmh,
            0L,
            0d
        );
        long checkpointAgeMs = Math.max(0L, nowMs - lastActiveCheckpointMs);
        if (checkpointAgeMs > ACTIVE_CHECKPOINT_RESUME_WINDOW_MS) {
            checkpointRecoveryEndOverrideMs = lastActiveCheckpointMs;
            if (candidateTrip) {
                reviewCandidate(true);
                if (!isTripActive()) return;
                if (candidateTrip) {
                    discardCandidate(
                        "stale_candidate_checkpoint",
                        "Candidate discarded: recovery evidence was insufficient",
                        true
                    );
                    return;
                }
                candidateConfirmedMs = Math.max(activeStartMs, lastActiveCheckpointMs);
            }
            finishTrip("checkpoint_recovery_finalize", true);
            return;
        }
        startMotionSensors();
        startTripLocationUpdates();
        persistActiveTripStatus(nowMs);
    }

    private void persistActiveTripCheckpoint(long nowMs, boolean force) {
        if (
            !isTripActive() ||
            activePoints == null ||
            activePoints.length() < 2
        ) {
            return;
        }
        if (!force && nowMs - lastActiveCheckpointMs < ACTIVE_CHECKPOINT_INTERVAL_MS) return;
        if (nativeRecoveryTripId == null || nativeRecoveryTripId.trim().isEmpty()) {
            nativeRecoveryTripId = nativeManualTrip && nativeManualTripId != null && !nativeManualTripId.trim().isEmpty()
                ? nativeManualTripId.trim()
                : DriveSenseNativeTripStore.newTripId();
        }

        JSONObject checkpoint = new JSONObject();
        try {
            checkpoint.put("version", DriveSenseActiveTripCheckpointStore.VERSION);
            checkpoint.put("trip_id", nativeRecoveryTripId);
            checkpoint.put("start_time_ms", activeStartMs);
            checkpoint.put("updated_at_ms", nowMs);
            checkpoint.put("start_source", nativeTripStartSource);
            checkpoint.put("manual", nativeManualTrip);
            checkpoint.put("manual_trip_id", nativeManualTripId);
            checkpoint.put("candidate", candidateTrip);
            checkpoint.put("candidate_near_parked", candidateNearParked);
            checkpoint.put("candidate_confirmed_ms", candidateConfirmedMs);
            checkpoint.put("native_auto_start_reason", nativeAutoStartReason);
            checkpoint.put("permission_loss", hasPermissionLoss);
            checkpoint.put("last_speed_kmh", lastKnownSpeedKmh);
            checkpoint.put("last_location_ms", lastLocationMs);
            checkpoint.put("still_since_ms", stillSinceMs);
            checkpoint.put("native_phone_proxy_count", nativeMicroSteerCount);
            checkpoint.put("route_point_count_original", activePoints.length());
            // The checkpoint outlives a crash or process kill, so in-zone
            // coordinates must be redacted here rather than only at trip finalize.
            checkpoint.put(
                "route_points",
                PrivacyZoneChecker.redactRoutePoints(
                    this,
                    DriveSenseActiveTripCheckpointStore.compactRoutePoints(activePoints)
                )
            );
            checkpoint.put(
                "timeline",
                DriveSenseActiveTripCheckpointStore.compactTail(
                    activeTimeline,
                    DriveSenseActiveTripCheckpointStore.MAX_TIMELINE_EVENTS
                )
            );
            checkpoint.put(
                "incident_events",
                DriveSenseActiveTripCheckpointStore.compactTail(
                    activeIncidentEvents,
                    DriveSenseActiveTripCheckpointStore.MAX_INCIDENT_EVENTS
                )
            );
            checkpoint.put("motion_samples_omitted", true);
        } catch (JSONException error) {
            recordDiagnostic(
                "checkpoint_save_failed",
                "Active trip recovery checkpoint could not be prepared.",
                "checkpoint_json_error",
                lastKnownSpeedKmh,
                0L,
                0d
            );
            return;
        }

        // Teardown paths must finish the write before the process dies, so they stay
        // synchronous. The periodic save runs on every location fix and does encryption plus a
        // hard fsync, which can stall the service main thread for hundreds of milliseconds on
        // a busy device, so it goes to a background thread instead.
        if (force) {
            recordCheckpointSaveResult(DriveSenseActiveTripCheckpointStore.save(this, checkpoint), nowMs);
            return;
        }

        lastActiveCheckpointMs = nowMs;
        final JSONObject pendingCheckpoint = checkpoint;
        final ExecutorService executor = checkpointExecutor;
        if (executor == null || executor.isShutdown()) {
            recordCheckpointSaveResult(DriveSenseActiveTripCheckpointStore.save(this, pendingCheckpoint), nowMs);
            return;
        }
        try {
            executor.execute(() -> {
                boolean saved = DriveSenseActiveTripCheckpointStore.save(this, pendingCheckpoint);
                if (saved) return;
                mainHandler().post(() -> recordCheckpointSaveResult(false, nowMs));
            });
        } catch (RejectedExecutionException error) {
            recordCheckpointSaveResult(DriveSenseActiveTripCheckpointStore.save(this, pendingCheckpoint), nowMs);
        }
    }

    private void recordCheckpointSaveResult(boolean saved, long nowMs) {
        if (saved) {
            lastActiveCheckpointMs = nowMs;
            return;
        }
        recordDiagnostic(
            "checkpoint_save_failed",
            "Active trip recovery checkpoint could not be saved.",
            "checkpoint_storage_error",
            lastKnownSpeedKmh,
            0L,
            0d
        );
    }

    private void persistActiveTripStatus(long nowMs) {
        if (!isTripActive()) {
            DriveSenseNativeTripStore.clearActiveTripStatus(this);
            return;
        }
        TripStats stats = calculateStats(activePoints, activeStartMs, nowMs);
        JSONObject latestPoint = activePoints.length() > 0 ? activePoints.optJSONObject(activePoints.length() - 1) : null;
        JSONObject latestMotion = activeMotionSamples != null && activeMotionSamples.length() > 0
            ? activeMotionSamples.optJSONObject(activeMotionSamples.length() - 1)
            : null;
        NativeSpeedLimit localSpeedLimit = latestPoint != null &&
            Double.isFinite(latestPoint.optDouble("lat", Double.NaN)) &&
            Double.isFinite(latestPoint.optDouble("lng", Double.NaN))
            ? resolveLocalSpeedLimit(
                latestPoint.optDouble("lat"),
                latestPoint.optDouble("lng"),
                latestPoint.optDouble("heading", Double.NaN),
                nowMs
            )
            : null;
        JSONArray routePreview = buildLiveRoutePreview();
        long stoppedSeconds = stillSinceMs > 0L ? Math.max(0L, (nowMs - stillSinceMs) / 1000L) : 0L;
        long lastFixAgeSeconds = lastLocationMs > 0L ? Math.max(0L, (nowMs - lastLocationMs) / 1000L) : -1L;
        JSONObject status = new JSONObject();
        try {
            status.put("active", true);
            status.put("state", candidateTrip ? "candidate" : "recording");
            status.put("candidate", candidateTrip);
            status.put("candidate_near_parked", candidateNearParked);
            status.put("manual", nativeManualTrip);
            status.put("id", nativeRecoveryTripId.isEmpty() ? "native_active_trip" : nativeRecoveryTripId);
            status.put("start_time", iso(activeStartMs));
            status.put("start_time_ms", activeStartMs);
            status.put("start_source", nativeTripStartSource);
            status.put("distance_km", round(stats.distanceKm, 3));
            status.put("duration_seconds", stats.durationSeconds);
            status.put("wall_clock_duration_seconds", stats.wallClockDurationSeconds);
            status.put("speed_kmh", Math.round(lastKnownSpeedKmh));
            status.put("avg_speed_kmh", round(stats.avgSpeedKmh, 1));
            status.put("avg_running_speed_kmh", round(stats.avgRunningSpeedKmh, 1));
            status.put("max_speed_kmh", round(stats.maxSpeedKmh, 1));
            status.put("moving_seconds", stats.movingSeconds);
            status.put("idle_seconds", stats.idleSeconds);
            status.put("stopped_seconds", stoppedSeconds);
            status.put("gap_seconds", stats.gapSeconds);
            status.put("route_gap_count", stats.gapCount);
            status.put("route_point_count", activePoints.length());
            status.put("route_preview", routePreview);
            status.put("route_preview_point_count", routePreview.length());
            status.put("privacy_masked_point_count", countPrivacyMaskedPoints(routePreview));
            status.put("last_location_at", lastLocationMs > 0L ? iso(lastLocationMs) : JSONObject.NULL);
            status.put("last_fix_age_seconds", lastFixAgeSeconds >= 0L ? lastFixAgeSeconds : JSONObject.NULL);
            status.put("updated_at", iso(nowMs));
            status.put("permission_loss", hasPermissionLoss);
            status.put("gps_fix_ready", latestPoint != null && lastFixAgeSeconds >= 0L && lastFixAgeSeconds <= 15L);
            status.put("gps_accuracy_m", jsonFiniteOrNull(latestPoint, "accuracy"));
            status.put("heading_deg", jsonFiniteOrNull(latestPoint, "heading"));
            status.put("altitude_m", jsonFiniteOrNull(latestPoint, "altitude"));
            status.put("speed_limit_kmh", localSpeedLimit != null ? round(localSpeedLimit.limitKmh, 1) : JSONObject.NULL);
            status.put("speed_limit_source", localSpeedLimit != null ? localSpeedLimit.source : JSONObject.NULL);
            status.put("speed_delta_kmh", localSpeedLimit != null ? round(lastKnownSpeedKmh - localSpeedLimit.limitKmh, 1) : JSONObject.NULL);
            status.put("longitudinal_acceleration_ms2", round(lastLongitudinalAccelerationMs2, 2));
            status.put("lateral_g", round(lastLateralG, 3));
            status.put("heading_rate_deg_s", round(lastHeadingRateDegS, 1));
            status.put("motion_sample_count", activeMotionSamples != null ? activeMotionSamples.length() : 0);
            status.put("motion_sensor_ready", linearAccelerationSensor != null || gyroscopeSensor != null);
            status.put("linear_acceleration_sensor_ready", linearAccelerationSensor != null);
            status.put("gyroscope_sensor_ready", gyroscopeSensor != null);
            status.put("linear_motion_magnitude_ms2", jsonFiniteOrNull(latestMotion, "linear_magnitude_ms2"));
            status.put("rotation_magnitude_deg_s", jsonFiniteOrNull(latestMotion, "rotation_magnitude_deg_s"));
            status.put("last_motion_at", lastMotionSampleMs > 0L ? iso(lastMotionSampleMs) : JSONObject.NULL);
            status.put("activity_type", activityTypeName(lastActivityType));
            status.put("activity_confidence", lastActivityConfidence);
            status.put("activity_updated_at", lastActivityUpdateMs > 0L ? iso(lastActivityUpdateMs) : JSONObject.NULL);
            status.put("max_drift_since_stop_m", round(maxDriftSinceStopM, 1));
            status.put("live_events", latestLiveTelemetryEvents(12));
            status.put("live_event_counts", liveTelemetryEventCounts());
            status.put("possible_incident_active", activeIncidentEvents != null && activeIncidentEvents.length() > 0);
            DriveSenseNativeTripStore.setActiveTripStatus(this, status);
            lastLiveStatusMs = nowMs;
        } catch (JSONException error) {
            Log.w(TAG, "Could not persist active trip status", error);
        }
    }

    private void updateNotification(String text) {
        persistActiveTripStatus(System.currentTimeMillis());
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        // Guarded like every other call site in this file: this runs on every notification
        // refresh, so an NPE here would take down the whole tracking service.
        if (manager != null) manager.notify(NOTIF_ID_TRACKING_START, buildNotification(text));
    }

    private boolean isParkedStopReason(String reason) {
        if (reason == null) return false;
        return reason.contains("parked") || reason.contains("still") || reason.contains("on_foot");
    }

    static boolean isAdministrativeStopReason(String reason) {
        return "service_stopped_by_user".equals(reason) ||
            "service_destroyed".equals(reason) ||
            "manual_trip_replaced_existing_native_trip".equals(reason);
    }

    private void updateLiveTripNotification(boolean force) {
        if (!isTripActive()) return;
        long now = System.currentTimeMillis();
        if (!force && now - lastLiveNotificationMs < LIVE_NOTIFICATION_MIN_INTERVAL_MS) return;
        lastLiveNotificationMs = now;
        if (!candidateTrip) checkAndroidUsageAccessPhoneUse(now);
        updateNotification(buildLiveTripStatus(now));
    }

    private void persistActiveTripStatusIfDue() {
        long now = System.currentTimeMillis();
        if (now - lastLiveStatusMs >= LIVE_STATUS_MIN_INTERVAL_MS) {
            persistActiveTripStatus(now);
        }
        persistActiveTripCheckpoint(now, false);
    }

    private void checkAndroidUsageAccessPhoneUse(long nowMs) {
        if (!isSettingEnabled("phone_use_detection_enabled", true) || !isSettingEnabled("phone_use_live_alert_enabled", true)) return;
        if (activeStartMs <= 0L || !DriveSensePhoneUsageTracker.hasUsageAccess(this)) return;
        long queryStartMs = lastNativePhoneWindowMs > 0L
            ? Math.max(activeStartMs, lastNativePhoneWindowMs - 1_000L)
            : activeStartMs;
        JSONObject usage = DriveSensePhoneUsageTracker.queryTripUsage(this, queryStartMs, nowMs);
        JSONArray sessions = usage.optJSONArray("events");
        if (sessions == null || sessions.length() == 0) return;

        JSONObject latest = sessions.optJSONObject(sessions.length() - 1);
        if (latest == null) return;
        long startMs = latest.optLong("start_ms", 0L);
        long durationSeconds = latest.optLong("duration_seconds", 0L);
        if (startMs <= lastNativePhoneWindowMs || durationSeconds < 5L || lastKnownSpeedKmh < 15d) return;

        lastNativePhoneWindowMs = startMs;
        if (nowMs - lastPhoneUseNotifyMs > PHONE_NOTIFY_COOLDOWN_MS) {
            sendPhoneUseWarningNotification();
            if (isNativeVoiceAlertTypeEnabled("phone_use")) {
                speakNativeAlert(nativeAlertMessage("phone_use"), true);
            }
            lastPhoneUseNotifyMs = nowMs;
        }
    }

    private boolean isSettingEnabled(String key, boolean defaultValue) {
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString(SETTINGS_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return defaultValue;
            JSONObject settings = new JSONObject(raw);
            if (!settings.has(key) || settings.isNull(key)) return defaultValue;
            return settings.optBoolean(key, defaultValue);
        } catch (Exception ignored) {
            return defaultValue;
        }
    }

    private double getSettingDouble(String key, double defaultValue) {
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString(SETTINGS_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return defaultValue;
            JSONObject settings = new JSONObject(raw);
            if (!settings.has(key) || settings.isNull(key)) return defaultValue;
            double value = settings.optDouble(key, defaultValue);
            return Double.isFinite(value) ? value : defaultValue;
        } catch (Exception ignored) {
            return defaultValue;
        }
    }

    private String getSettingString(String key, String defaultValue) {
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString(SETTINGS_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return defaultValue;
            JSONObject settings = new JSONObject(raw);
            if (!settings.has(key) || settings.isNull(key)) return defaultValue;
            String value = settings.optString(key, defaultValue);
            return value == null || value.trim().isEmpty() ? defaultValue : value.trim();
        } catch (Exception ignored) {
            return defaultValue;
        }
    }

    private SharedPreferences notificationPrefs() {
        return getSharedPreferences(NOTIFICATION_PREFS, Context.MODE_PRIVATE);
    }

    private String buildLiveTripStatus(long nowMs) {
        if (candidateTrip) {
            TripStats stats = calculateStats(activePoints, activeStartMs, nowMs);
            return String.format(
                Locale.US,
                "Checking movement - %.1f km - %.0f km/h",
                stats.distanceKm,
                lastKnownSpeedKmh
            );
        }
        TripStats stats = calculateStats(activePoints, activeStartMs, nowMs);
        long durationMinutes = Math.max(0L, stats.durationSeconds / 60L);
        String base = String.format(
            Locale.US,
            "%.1f km - %.0f km/h - %d min",
            stats.distanceKm,
            lastKnownSpeedKmh,
            durationMinutes
        );

        if (lastKnownSpeedKmh < STATIONARY_SPEED_KMH && stillSinceMs > 0L) {
            long stoppedSeconds = Math.max(0L, (nowMs - stillSinceMs) / 1000L);
            String stoppedText = String.format(Locale.US, "Stopped %d:%02d", stoppedSeconds / 60L, stoppedSeconds % 60L);
            if (stoppedSeconds >= AUTO_STOP_PARKED_GPS_STABLE_MS / 1000L && maxDriftSinceStopM < GPS_VEHICLE_DRIFT_RELAXED_M) {
                return base + " - " + stoppedText + " - will end if parked";
            }
            return base + " - " + stoppedText;
        }

        return base + " - recording";
    }

    private void recordTimeline(String type, String title, String reason, double speedKmh, long stoppedSeconds, double driftM) {
        if (activeTimeline == null) return;
        activeTimeline.put(diagnosticEvent(type, title, reason, speedKmh, stoppedSeconds, driftM));
    }

    private void recordLiveTelemetryEvent(String type, String title, double value, String unit, long timestampMs) {
        if (activeTelemetryEvents == null) activeTelemetryEvents = new JSONArray();
        JSONObject event = new JSONObject();
        try {
            event.put("id", "live_" + timestampMs + "_" + Integer.toHexString(type.hashCode()));
            event.put("timestamp", iso(timestampMs));
            event.put("type", type);
            event.put("title", title);
            event.put("value", round(value, 2));
            event.put("unit", unit);
            event.put("speed_kmh", Math.round(lastKnownSpeedKmh));
            activeTelemetryEvents.put(event);
            while (activeTelemetryEvents.length() > MAX_LIVE_TELEMETRY_EVENTS) activeTelemetryEvents.remove(0);
        } catch (JSONException error) {
            Log.w(TAG, "Could not record live telemetry event", error);
        }
    }

    private JSONArray latestLiveTelemetryEvents(int limit) {
        JSONArray result = new JSONArray();
        if (activeTelemetryEvents == null || activeTelemetryEvents.length() == 0) return result;
        int start = Math.max(0, activeTelemetryEvents.length() - Math.max(1, limit));
        for (int index = start; index < activeTelemetryEvents.length(); index++) {
            JSONObject event = activeTelemetryEvents.optJSONObject(index);
            if (event != null) result.put(event);
        }
        return result;
    }

    private JSONObject liveTelemetryEventCounts() {
        JSONObject counts = new JSONObject();
        if (activeTelemetryEvents == null) return counts;
        for (int index = 0; index < activeTelemetryEvents.length(); index++) {
            JSONObject event = activeTelemetryEvents.optJSONObject(index);
            if (event == null) continue;
            String type = event.optString("type", "observation");
            try {
                counts.put(type, counts.optInt(type, 0) + 1);
            } catch (JSONException error) {
                Log.w(TAG, "Could not live telemetry event counts", error);
            }
        }
        return counts;
    }

    private JSONArray buildLiveRoutePreview() {
        JSONArray sampled = new JSONArray();
        if (activePoints == null || activePoints.length() == 0) return sampled;
        int count = activePoints.length();
        int outputCount = Math.min(count, MAX_LIVE_ROUTE_PREVIEW_POINTS);
        for (int index = 0; index < outputCount; index++) {
            int sourceIndex = outputCount == 1
                ? count - 1
                : (int) Math.round(index * (count - 1d) / (outputCount - 1d));
            JSONObject point = activePoints.optJSONObject(sourceIndex);
            if (point != null) sampled.put(point);
        }
        return PrivacyZoneChecker.redactRoutePoints(this, sampled);
    }

    private static int countPrivacyMaskedPoints(JSONArray points) {
        if (points == null) return 0;
        int count = 0;
        for (int index = 0; index < points.length(); index++) {
            JSONObject point = points.optJSONObject(index);
            if (point != null && (point.optBoolean("masked_for_privacy", false) || point.isNull("lat") || point.isNull("lng"))) count++;
        }
        return count;
    }

    private static String activityTypeName(int activityType) {
        switch (activityType) {
            case DetectedActivity.IN_VEHICLE: return "in_vehicle";
            case DetectedActivity.ON_BICYCLE: return "on_bicycle";
            case DetectedActivity.ON_FOOT: return "on_foot";
            case DetectedActivity.RUNNING: return "running";
            case DetectedActivity.STILL: return "still";
            case DetectedActivity.TILTING: return "tilting";
            case DetectedActivity.WALKING: return "walking";
            default: return "unknown";
        }
    }

    private static Object jsonFiniteOrNull(@Nullable JSONObject object, String key) {
        if (object == null || key == null || !object.has(key) || object.isNull(key)) return JSONObject.NULL;
        double value = object.optDouble(key, Double.NaN);
        return Double.isFinite(value) ? value : JSONObject.NULL;
    }

    private void recordDiagnostic(String type, String title, String reason, double speedKmh, long stoppedSeconds, double driftM) {
        DriveSenseNativeTripStore.addDiagnosticEvent(this, diagnosticEvent(type, title, reason, speedKmh, stoppedSeconds, driftM));
    }

    private JSONObject diagnosticEvent(String type, String title, String reason, double speedKmh, long stoppedSeconds, double driftM) {
        JSONObject event = new JSONObject();
        try {
            long typeHash = ((long) type.hashCode()) & 0xFFFFFFFFL;
            event.put("id", "native_" + System.currentTimeMillis() + "_" + Long.toHexString(typeHash));
            event.put("timestamp", iso(System.currentTimeMillis()));
            event.put("type", type);
            event.put("title", title);
            event.put("reason", reason);
            event.put("detail", reason == null ? "" : reason.replace('_', ' '));
            event.put("speed_kmh", Math.round(speedKmh));
            event.put("stopped_seconds", stoppedSeconds);
            event.put("drift_m", Math.round(driftM));
        } catch (JSONException error) {
            Log.w(TAG, "Could not diagnostic event", error);
        }
        return event;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Native Auto Tracking",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps Road Sage ready to detect and record driving trips.");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    static String iso(long timeMs) {
        return Instant.ofEpochMilli(timeMs).toString();
    }

    static boolean isNightDrivingEpochMs(long timeMs) {
        return isNightDrivingEpochMs(
            timeMs,
            NIGHT_START_HOUR * 60,
            NIGHT_END_HOUR * 60
        );
    }

    static boolean isNightDrivingEpochMs(long timeMs, int startMinutes, int endMinutes) {
        ZonedDateTime localTime = Instant.ofEpochMilli(timeMs).atZone(ZoneId.systemDefault());
        int minutes = localTime.getHour() * 60 + localTime.getMinute();
        return isWithinClockWindow(minutes, startMinutes, endMinutes);
    }

    private NightSettings readNightSettings() {
        String mode = getSettingString("night_detection_mode", NIGHT_DETECTION_MODE_SUNSET);
        int startMinutes = parseClockMinutes(
            getSettingString("night_start_time", DEFAULT_NIGHT_START_TIME),
            NIGHT_START_HOUR * 60
        );
        int endMinutes = parseClockMinutes(
            getSettingString("night_end_time", DEFAULT_NIGHT_END_TIME),
            NIGHT_END_HOUR * 60
        );
        double sunsetOffset = getSettingDouble("night_sunset_offset_minutes", 0d);
        double sunriseOffset = getSettingDouble("night_sunrise_offset_minutes", 0d);
        int boundaryTolerance = (int) Math.max(
            0d,
            Math.min(30d, getSettingDouble("night_boundary_tolerance_minutes", DEFAULT_NIGHT_BOUNDARY_TOLERANCE_MINUTES))
        );
        String resolvedMode = NIGHT_DETECTION_MODE_CUSTOM.equals(mode)
            ? NIGHT_DETECTION_MODE_CUSTOM
            : NIGHT_DETECTION_MODE_CIVIL_TWILIGHT.equals(mode)
                ? NIGHT_DETECTION_MODE_CIVIL_TWILIGHT
                : NIGHT_DETECTION_MODE_SUNSET;
        return new NightSettings(
            resolvedMode,
            startMinutes,
            endMinutes,
            sunsetOffset,
            sunriseOffset,
            boundaryTolerance
        );
    }

    private static int parseClockMinutes(String value, int fallbackMinutes) {
        if (value == null) return fallbackMinutes;
        try {
            String[] parts = value.trim().split(":");
            if (parts.length < 2) return fallbackMinutes;
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallbackMinutes;
            return hour * 60 + minute;
        } catch (NumberFormatException ignored) {
            return fallbackMinutes;
        }
    }

    static boolean isNightDrivingPoint(long timeMs, double lat, double lng, NightSettings settings) {
        NightSettings resolvedSettings = resolvedNightSettings(settings);
        ZonedDateTime localTime = Instant.ofEpochMilli(timeMs).atZone(ZoneId.systemDefault());
        return evaluateNightPoint(timeMs, lat, lng, localTime, localTime.getZone().getId(), resolvedSettings).isNight;
    }

    private static NightSettings resolvedNightSettings(NightSettings settings) {
        return settings != null
            ? settings
            : new NightSettings(
                NIGHT_DETECTION_MODE_SUNSET,
                NIGHT_START_HOUR * 60,
                NIGHT_END_HOUR * 60,
                0d,
                0d,
                DEFAULT_NIGHT_BOUNDARY_TOLERANCE_MINUTES
            );
    }

    private static PointNightResult evaluateNightPoint(JSONObject point, long timeMs, NightSettings settings) {
        double lat = point != null ? point.optDouble("lat", Double.NaN) : Double.NaN;
        double lng = point != null ? point.optDouble("lng", Double.NaN) : Double.NaN;
        int storedOffsetMinutes = point != null ? point.optInt("utc_offset_minutes", Integer.MIN_VALUE) : Integer.MIN_VALUE;
        boolean validStoredOffset = storedOffsetMinutes >= -14 * 60 && storedOffsetMinutes <= 14 * 60;
        ZonedDateTime localTime = validStoredOffset
            ? Instant.ofEpochMilli(timeMs).atZone(ZoneOffset.ofTotalSeconds(storedOffsetMinutes * 60))
            : Instant.ofEpochMilli(timeMs).atZone(ZoneId.systemDefault());
        String timezoneId = point != null
            ? point.optString("timezone_id", localTime.getZone().getId())
            : localTime.getZone().getId();
        return evaluateNightPoint(timeMs, lat, lng, localTime, timezoneId, resolvedNightSettings(settings));
    }

    private static PointNightResult evaluateNightPoint(
        long timeMs,
        double lat,
        double lng,
        ZonedDateTime localTime,
        String timezoneId,
        NightSettings settings
    ) {
        int minutes = localTime.getHour() * 60 + localTime.getMinute();
        boolean solarMode = NIGHT_DETECTION_MODE_SUNSET.equals(settings.mode) ||
            NIGHT_DETECTION_MODE_CIVIL_TWILIGHT.equals(settings.mode);
        if (!solarMode) {
            boolean isNight = isWithinClockWindow(minutes, settings.startMinutes, settings.endMinutes);
            return new PointNightResult(
                isNight,
                "custom",
                isNight ? "inside_custom_window" : "outside_custom_window",
                null,
                timeMs,
                localTime,
                timezoneId,
                Double.NaN,
                Double.NaN,
                settings.startMinutes,
                settings.endMinutes
            );
        }

        double zenith = NIGHT_DETECTION_MODE_CIVIL_TWILIGHT.equals(settings.mode)
            ? CIVIL_TWILIGHT_ZENITH_DEGREES
            : SUN_ZENITH_DEGREES;
        Double eveningEvent = sunEventMinutes(localTime, lat, lng, false, zenith);
        Double morningEvent = sunEventMinutes(localTime, lat, lng, true, zenith);
        boolean coordinatesAvailable = Double.isFinite(lat) && Double.isFinite(lng) &&
            Math.abs(lat) <= 89.8d && Math.abs(lng) <= 180d;
        String fallbackReason = null;
        double start = settings.startMinutes;
        double end = settings.endMinutes;
        if (eveningEvent != null && morningEvent != null) {
            start = eveningEvent + settings.sunsetOffsetMinutes + settings.boundaryToleranceMinutes;
            end = morningEvent + settings.sunriseOffsetMinutes - settings.boundaryToleranceMinutes;
        } else {
            fallbackReason = coordinatesAvailable ? "solar_event_unavailable" : "gps_coordinates_unavailable";
        }
        boolean isNight = isWithinClockWindow(minutes, start, end);
        boolean fallbackUsed = fallbackReason != null;
        return new PointNightResult(
            isNight,
            fallbackUsed ? "custom_fallback" : settings.mode,
            fallbackUsed
                ? isNight ? "inside_fallback_window" : "outside_fallback_window"
                : isNight ? "inside_solar_window" : "outside_solar_window",
            fallbackReason,
            timeMs,
            localTime,
            timezoneId,
            eveningEvent != null ? eveningEvent : Double.NaN,
            morningEvent != null ? morningEvent : Double.NaN,
            start,
            end
        );
    }

    static boolean isTripNightDriving(JSONArray points, NightSettings settings) {
        return classifyTripNightDriving(points, settings).isNight;
    }

    static NightClassificationResult classifyTripNightDriving(JSONArray points, NightSettings settings) {
        NightSettings resolvedSettings = resolvedNightSettings(settings);
        PointNightResult first = null;
        PointNightResult firstNight = null;
        int evaluatedPointCount = 0;
        int fallbackPointCount = 0;
        String fallbackReason = null;
        if (points == null) return new NightClassificationResult(false, buildNightMetadata(null, null, resolvedSettings, 0, 0, null));
        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;
            long timeMs = parseIsoOrDefault(point.optString("timestamp"), Long.MIN_VALUE);
            if (timeMs == Long.MIN_VALUE) continue;
            PointNightResult result = evaluateNightPoint(point, timeMs, resolvedSettings);
            evaluatedPointCount += 1;
            if (first == null) first = result;
            if (result.fallbackReason != null) {
                fallbackPointCount += 1;
                if (fallbackReason == null) fallbackReason = result.fallbackReason;
                else if (!fallbackReason.contains(result.fallbackReason)) fallbackReason += "," + result.fallbackReason;
            }
            if (firstNight == null && result.isNight) firstNight = result;
        }
        PointNightResult decision = firstNight != null ? firstNight : first;
        return new NightClassificationResult(
            firstNight != null,
            buildNightMetadata(first, decision, resolvedSettings, evaluatedPointCount, fallbackPointCount, fallbackReason)
        );
    }

    private static JSONObject buildNightMetadata(
        PointNightResult first,
        PointNightResult decision,
        NightSettings settings,
        int evaluatedPointCount,
        int fallbackPointCount,
        String fallbackReason
    ) {
        JSONObject metadata = new JSONObject();
        try {
            boolean isNight = decision != null && decision.isNight;
            metadata.put("version", 1);
            metadata.put("is_night", isNight);
            metadata.put("mode", settings.mode);
            metadata.put("method", decision != null ? decision.method : "unavailable");
            metadata.put("reason", decision != null ? decision.reason : "no_timestamped_points");
            metadata.put(
                "solar_event_type",
                NIGHT_DETECTION_MODE_CIVIL_TWILIGHT.equals(settings.mode)
                    ? "civil_twilight"
                    : NIGHT_DETECTION_MODE_SUNSET.equals(settings.mode)
                        ? "sunrise_sunset"
                        : JSONObject.NULL
            );
            metadata.put("boundary_tolerance_minutes", settings.boundaryToleranceMinutes);
            metadata.put("sunset_offset_minutes", settings.sunsetOffsetMinutes);
            metadata.put("sunrise_offset_minutes", settings.sunriseOffsetMinutes);
            metadata.put("custom_start_time", formatClockMinutes(settings.startMinutes));
            metadata.put("custom_end_time", formatClockMinutes(settings.endMinutes));
            metadata.put("custom_fallback_used", fallbackPointCount > 0);
            metadata.put("fallback_reason", fallbackReason != null ? fallbackReason : JSONObject.NULL);
            metadata.put("fallback_point_count", fallbackPointCount);
            metadata.put("evaluated_point_count", evaluatedPointCount);
            metadata.put("trip_started_in_night", first != null && first.isNight);
            metadata.put("trip_start_local_time", first != null ? formatClockMinutes(first.localMinutes()) : JSONObject.NULL);
            metadata.put("decision_point_at", decision != null ? iso(decision.timeMs) : JSONObject.NULL);
            metadata.put("decision_local_time", decision != null ? formatClockMinutes(decision.localMinutes()) : JSONObject.NULL);
            metadata.put("local_date", decision != null ? decision.localTime.toLocalDate().toString() : JSONObject.NULL);
            metadata.put("timezone_id", first != null ? first.timezoneId : ZoneId.systemDefault().getId());
            metadata.put(
                "utc_offset_minutes",
                first != null ? first.localTime.getOffset().getTotalSeconds() / 60 : 0
            );
            metadata.put("evening_event_local_time", decision != null && Double.isFinite(decision.eveningEventMinutes)
                ? formatClockMinutes(decision.eveningEventMinutes)
                : JSONObject.NULL);
            metadata.put("morning_event_local_time", decision != null && Double.isFinite(decision.morningEventMinutes)
                ? formatClockMinutes(decision.morningEventMinutes)
                : JSONObject.NULL);
            metadata.put("night_window_start_local_time", decision != null
                ? formatClockMinutes(decision.windowStartMinutes)
                : JSONObject.NULL);
            metadata.put("night_window_end_local_time", decision != null
                ? formatClockMinutes(decision.windowEndMinutes)
                : JSONObject.NULL);
        } catch (JSONException error) {
            Log.w(TAG, "Could not classify trip night driving", error);
        }
        return metadata;
    }

    private static String formatClockMinutes(double minutes) {
        int normalized = (int) Math.round(positiveModulo(minutes, 24d * 60d));
        if (normalized >= 24 * 60) normalized = 0;
        return String.format(Locale.US, "%02d:%02d", normalized / 60, normalized % 60);
    }

    private static Double sunEventMinutes(ZonedDateTime localTime, double lat, double lng, boolean sunrise, double zenith) {
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 89.8d || Math.abs(lng) > 180d) {
            return null;
        }

        int dayOfYear = localTime.getDayOfYear();
        double lngHour = lng / 15d;
        double t = dayOfYear + (((sunrise ? 6d : 18d) - lngHour) / 24d);
        double meanAnomaly = (0.9856d * t) - 3.289d;
        double trueLongitude = meanAnomaly
            + (1.916d * Math.sin(toRadians(meanAnomaly)))
            + (0.020d * Math.sin(toRadians(2d * meanAnomaly)))
            + 282.634d;
        trueLongitude = normalizeDegrees(trueLongitude);

        double rightAscension = Math.toDegrees(Math.atan(0.91764d * Math.tan(toRadians(trueLongitude))));
        rightAscension = normalizeDegrees(rightAscension);
        double longitudeQuadrant = Math.floor(trueLongitude / 90d) * 90d;
        double ascensionQuadrant = Math.floor(rightAscension / 90d) * 90d;
        rightAscension = (rightAscension + longitudeQuadrant - ascensionQuadrant) / 15d;

        double sinDec = 0.39782d * Math.sin(toRadians(trueLongitude));
        double cosDec = Math.cos(Math.asin(sinDec));
        double cosHour = (
            Math.cos(toRadians(zenith)) - (sinDec * Math.sin(toRadians(lat)))
        ) / (cosDec * Math.cos(toRadians(lat)));
        if (cosHour > 1d || cosHour < -1d) return null;

        double hourAngle = sunrise
            ? 360d - Math.toDegrees(Math.acos(cosHour))
            : Math.toDegrees(Math.acos(cosHour));
        double localMeanTime = (hourAngle / 15d) + rightAscension - (0.06571d * t) - 6.622d;
        double utcMinutes = positiveModulo((localMeanTime - lngHour) * 60d, 24d * 60d);
        double offsetMinutes = localTime.getOffset().getTotalSeconds() / 60d;
        return positiveModulo(utcMinutes + offsetMinutes, 24d * 60d);
    }

    private static boolean isWithinClockWindow(double minutes, double startMinutes, double endMinutes) {
        double dayMinutes = 24d * 60d;
        double normalized = positiveModulo(minutes, dayMinutes);
        double start = positiveModulo(startMinutes, dayMinutes);
        double end = positiveModulo(endMinutes, dayMinutes);
        if (start == end) return false;
        return start < end
            ? normalized >= start && normalized < end
            : normalized >= start || normalized < end;
    }

    private static double normalizeDegrees(double value) {
        return positiveModulo(value, 360d);
    }

    private static double positiveModulo(double value, double modulo) {
        return ((value % modulo) + modulo) % modulo;
    }

    private static double toRadians(double value) {
        return value * Math.PI / 180d;
    }

    private static long parseIso(String value) {
        return parseIsoOrDefault(value, System.currentTimeMillis());
    }

    private static long parseIsoOrDefault(String value, long defaultValue) {
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (DateTimeParseException | NullPointerException e) {
            try {
                return LocalDateTime.parse(value)
                    .atZone(ZoneId.systemDefault())
                    .toInstant()
                    .toEpochMilli();
            } catch (DateTimeParseException | NullPointerException ignored) {
                return defaultValue;
            }
        }
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10d, digits);
        return Math.round(value * factor) / factor;
    }

    private static int mutableFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
    }

    private static int immutableFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
    }

    private static class TripStats {
        double distanceKm = 0d;
        double avgSpeedKmh = 0d;
        double avgRunningSpeedKmh = 0d;
        double maxSpeedKmh = 0d;
        long idleSeconds = 0L;
        long movingSeconds = 0L;
        long wallClockDurationSeconds = 0L;
        long gapSeconds = 0L;
        int gapCount = 0;
        long durationSeconds = 0L;
        int speedSamples = 0;
        boolean nightDriving = false;
        JSONObject nightClassification = null;
    }

    static class NightSettings {
        final String mode;
        final int startMinutes;
        final int endMinutes;
        final double sunsetOffsetMinutes;
        final double sunriseOffsetMinutes;
        final int boundaryToleranceMinutes;

        NightSettings(
            String mode,
            int startMinutes,
            int endMinutes,
            double sunsetOffsetMinutes,
            double sunriseOffsetMinutes
        ) {
            this(
                mode,
                startMinutes,
                endMinutes,
                sunsetOffsetMinutes,
                sunriseOffsetMinutes,
                DEFAULT_NIGHT_BOUNDARY_TOLERANCE_MINUTES
            );
        }

        NightSettings(
            String mode,
            int startMinutes,
            int endMinutes,
            double sunsetOffsetMinutes,
            double sunriseOffsetMinutes,
            int boundaryToleranceMinutes
        ) {
            this.mode = mode;
            this.startMinutes = startMinutes;
            this.endMinutes = endMinutes;
            this.sunsetOffsetMinutes = sunsetOffsetMinutes;
            this.sunriseOffsetMinutes = sunriseOffsetMinutes;
            this.boundaryToleranceMinutes = Math.max(0, Math.min(30, boundaryToleranceMinutes));
        }
    }

    static class NightClassificationResult {
        final boolean isNight;
        final JSONObject metadata;

        NightClassificationResult(boolean isNight, JSONObject metadata) {
            this.isNight = isNight;
            this.metadata = metadata;
        }
    }

    private static class PointNightResult {
        final boolean isNight;
        final String method;
        final String reason;
        final String fallbackReason;
        final long timeMs;
        final ZonedDateTime localTime;
        final String timezoneId;
        final double eveningEventMinutes;
        final double morningEventMinutes;
        final double windowStartMinutes;
        final double windowEndMinutes;

        PointNightResult(
            boolean isNight,
            String method,
            String reason,
            String fallbackReason,
            long timeMs,
            ZonedDateTime localTime,
            String timezoneId,
            double eveningEventMinutes,
            double morningEventMinutes,
            double windowStartMinutes,
            double windowEndMinutes
        ) {
            this.isNight = isNight;
            this.method = method;
            this.reason = reason;
            this.fallbackReason = fallbackReason;
            this.timeMs = timeMs;
            this.localTime = localTime;
            this.timezoneId = timezoneId;
            this.eveningEventMinutes = eveningEventMinutes;
            this.morningEventMinutes = morningEventMinutes;
            this.windowStartMinutes = windowStartMinutes;
            this.windowEndMinutes = windowEndMinutes;
        }

        int localMinutes() {
            return localTime.getHour() * 60 + localTime.getMinute();
        }
    }

    private static class TailTrimResult {
        JSONArray points = new JSONArray();
        long endMs = 0L;
        int removedPoints = 0;
    }
}
