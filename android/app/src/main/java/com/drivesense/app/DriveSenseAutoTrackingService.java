package com.drivesense.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
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
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;

public class DriveSenseAutoTrackingService extends Service implements SensorEventListener {
    static final String ACTION_START = "com.drivesense.app.action.START_NATIVE_AUTO";
    static final String ACTION_START_MANUAL_TRIP = "com.drivesense.app.action.START_NATIVE_MANUAL_TRIP";
    static final String ACTION_STOP = "com.drivesense.app.action.STOP_NATIVE_AUTO";
    static final String ACTION_STOP_SPEECH = "com.drivesense.app.action.STOP_NATIVE_SPEECH";
    static final String ACTION_END_TRIP = "com.drivesense.app.action.END_NATIVE_TRIP";
    static final String ACTION_DISCARD_MANUAL_TRIP = "com.drivesense.app.action.DISCARD_NATIVE_MANUAL_TRIP";
    static final String ACTION_ACTIVITY = "com.drivesense.app.action.ACTIVITY_UPDATE";
    static final String EXTRA_ACTIVITY_TYPE = "activityType";
    static final String EXTRA_ACTIVITY_CONFIDENCE = "activityConfidence";
    static final String EXTRA_START_TIME_MS = "startTimeMs";
    static final String EXTRA_TRIP_ID = "tripId";
    static final String EXTRA_KEEP_ARMED = "keepArmed";

    private static final int NOTIF_ID_TRACKING_START = 4101;
    private static final int ACTIVITY_RECOGNITION_REQUEST_CODE = 4102;
    private static final int NOTIF_ID_AUTO_STATUS = 4103;
    private static final int NIGHT_START_HOUR = 22;
    private static final int NIGHT_END_HOUR = 5;
    private static final String CHANNEL_ID = "drivesense_native_auto_tracking";
    private static final String AUTO_STATUS_CHANNEL_ID = "drivesense_auto_status";
    private static final int MIN_VEHICLE_CONFIDENCE = 65;
    private static final int MIN_STILL_CONFIDENCE = 70;
    private static final int MIN_POINTS_TO_SAVE = 2;
    private static final long MIN_TRIP_MS = 30_000L;
    private static final double MIN_TRIP_KM = 0.1d;
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
    private static final float MAX_ACCURACY_M = 75f;
    private static final double MIN_POINT_DISTANCE_M = 8d;
    private static final double STATIONARY_SPEED_KMH = 5d;
    private static final double MIN_TRUSTED_SPEED_KMH = 18d;
    private static final double MAX_SPEED_KMH = 220d;
    private static final double AUTO_START_SPEED_KMH = 5d;
    private static final long AUTO_START_MOVING_MS = 2_000L;
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
    private static final String SPEED_KNOWLEDGE_KEY = "speed_knowledge_v1";
    private static final String GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
    private static final int SPEED_KNOWLEDGE_GEOHASH_PRECISION = 6;
    private static final double SPEED_KNOWLEDGE_MATCH_RADIUS_KM = 0.8d;
    private static final double SPEED_KNOWLEDGE_SECTION_MATCH_RADIUS_KM = 0.08d;
    private static final double SPEED_KNOWLEDGE_DIRECTION_TOLERANCE_DEG = 100.0d;
    private static final String NOTIFICATION_PREFS = "drivesense_native_notification_state";
    private static final String KEY_LAST_PHONE_USE_NOTIFICATION_MS = "last_phone_use_notification_ms";
    private static final String KEY_LAST_TRIP_COMPLETED_NOTIFICATION_ID = "last_trip_completed_notification_id";
    private static final int PHONE_USE_NOTIFICATION_ID = 4001;
    private static final int TRIP_COMPLETED_NOTIFICATION_ID = 2002;
    private static final int PHONE_MICRO_STEER_WINDOW_MS = 15_000;
    private static final int PHONE_MICRO_STEER_MIN_COUNT = 6;
    private static final float PHONE_PROXY_MAX_ACCURACY_M = 20f;
    private static final double PHONE_MICRO_STEER_MIN_DEG = 3.0d;
    private static final double PHONE_MICRO_STEER_MAX_DEG = 18.0d;
    private static final double PHONE_DETECT_MIN_SPEED_KMH = 30.0d;
    private static final long PHONE_NOTIFY_COOLDOWN_MS = 120_000L;
    private static final long PHONE_WINDOW_COUNT_COOLDOWN_MS = 15_000L;
    private static final long LIVE_NOTIFICATION_MIN_INTERVAL_MS = 10_000L;
    private static final long STATS_MAX_SAMPLE_GAP_SECONDS = 120L;
    private static final double SUSTAINED_TURN_HEADING_CHANGE_DEG = 35.0d;
    private static final float TTS_SPEECH_RATE = 0.95f;
    private static final float TTS_VOLUME = 0.95f;
    private static final long SPEED_ALERT_SUSTAINED_MS = 5_000L;
    private static final long SPEED_ALERT_COOLDOWN_MS = 60_000L;
    private static final long SPEED_ALERT_ESTIMATED_COOLDOWN_MS = 90_000L;
    private static final long SPEED_ALERT_INFERRED_COOLDOWN_MS = 180_000L;
    private static final long TRACKING_READY_ALERT_RETRY_MS = 10_000L;
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
    private static final double HEADING_DRIFT_HIGHWAY_SPEED_KMH = 80.0d;
    private static final double HEADING_DRIFT_HIGHWAY_SHARE = 0.80d;
    private static final long LIVE_EVENT_MAX_SAMPLE_GAP_MS = 6_000L;
    private static final double LIVE_EVENT_MAX_ACCURACY_M = 25.0d;
    private static final double LIVE_EVENT_MIN_SPEED_KMH = 15.0d;
    private static final double SHARP_TURN_MIN_HEADING_CHANGE_DEG = 12.0d;
    private static final double STANDARD_GRAVITY_MS2 = 9.80665d;
    private static final long MAX_TERMINAL_IDLE_SECONDS = 1800L;
    private static final int MAX_NATIVE_MOTION_SAMPLES = 5000;
    private static final long MOTION_SAMPLE_MIN_INTERVAL_MS = 100L;
    private static final long MOTION_AXIS_FRESH_MS = 500L;

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
    private long activeStartMs = 0L;
    private long stillSinceMs = 0L;
    private long nonVehicleSinceMs = 0L;
    private Location previousLocation;
    private Location armedPreviousLocation;
    private long lastLocationMs = 0L;
    private long armedMovingSinceMs = 0L;
    private double lastKnownSpeedKmh = 0.0d;
    private double stoppedAnchorLat = Double.NaN;
    private double stoppedAnchorLng = Double.NaN;
    private double maxDriftSinceStopM = 0.0d;
    private final Deque<double[]> recentHeadings = new ArrayDeque<>();
    private final Deque<double[]> nativeHeadingDriftWindow = new ArrayDeque<>();
    private int nativeMicroSteerCount = 0;
    private long lastPhoneUseNotifyMs = 0L;
    private long lastNativeProxyWindowMs = 0L;
    private long lastNativePhoneWindowMs = 0L;
    private long lastLiveNotificationMs = 0L;
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
    private String nativeAutoStartReason = "";
    private String lastNativeAutoStopReason = "";
    private String nativeTripStartSource = "native_auto";
    private String nativeManualTripId = "";
    private boolean candidateTrip = false;
    private boolean candidateNearParked = false;
    private boolean nativeManualTrip = false;
    private boolean hasPermissionLoss = false;
    private long candidateConfirmedMs = 0L;
    private int lastActivityType = DetectedActivity.UNKNOWN;
    private int lastActivityConfidence = 0;
    private long lastActivityUpdateMs = 0L;
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

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIF_ID_TRACKING_START, buildNotification("Ready when you start moving"));
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
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        startForeground(
            NOTIF_ID_TRACKING_START,
            buildNotification(isTripActive() ? buildLiveTripStatus(System.currentTimeMillis()) : "Ready when you start moving")
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
                DriveSenseNativeTripStore.setServiceEnabled(this, false);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (ACTION_START.equals(action) || action == null) {
            recordDiagnostic("service_armed", "Native service is armed for auto tracking.", "service_start", 0d, 0L, 0d);
        }
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

    @Override
    public void onDestroy() {
        finishTrip("service_destroyed", false);
        removeActivityUpdates();
        stopLocationUpdates();
        stopMotionSensors();
        DriveSenseNativeTripStore.setServiceEnabled(this, false);
        if (speechController != null) speechController.shutdown();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void start(Context context) {
        cancelAutoTrackingOffNotification(context);
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_START);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ignored) {}
    }

    static void startManualTrip(Context context, long startTimeMs, String tripId) {
        cancelAutoTrackingOffNotification(context);
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_START_MANUAL_TRIP);
        intent.putExtra(EXTRA_START_TIME_MS, startTimeMs > 0L ? startTimeMs : System.currentTimeMillis());
        intent.putExtra(EXTRA_TRIP_ID, tripId == null ? "" : tripId);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ignored) {}
    }

    static void discardManualTrip(Context context, boolean keepArmed) {
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_DISCARD_MANUAL_TRIP);
        intent.putExtra(EXTRA_KEEP_ARMED, keepArmed);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ignored) {}
    }

    static void endActiveTrip(Context context, boolean keepArmed) {
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_END_TRIP);
        intent.putExtra(EXTRA_KEEP_ARMED, keepArmed);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ignored) {}
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
        showAutoTrackingOffNotification(context);
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
        } catch (Exception ignored) {}
    }

    private void handleActivity(int type, int confidence) {
        long now = System.currentTimeMillis();
        lastActivityType = type;
        lastActivityConfidence = confidence;
        lastActivityUpdateMs = now;
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
        long normalizedStartMs = startTimeMs > 0L ? startTimeMs : System.currentTimeMillis();
        if (isTripActive()) {
            if (nativeManualTrip) {
                recordDiagnostic("manual_native_trip_already_active", "Native manual trip already active.", "manual_start_ignored", lastKnownSpeedKmh, 0L, maxDriftSinceStopM);
                return;
            }
            finishTrip("manual_trip_replaced_existing_native_trip", true);
        }
        activeStartMs = normalizedStartMs;
        activePoints = new JSONArray();
        activeTimeline = new JSONArray();
        activeMotionSamples = new JSONArray();
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
        resetNativeAlertState();
        nativeAutoStartReason = "manual_button";
        lastNativeAutoStopReason = "";
        nativeTripStartSource = "native_manual";
        nativeManualTripId = tripId == null ? "" : tripId.trim();
        nativeManualTrip = true;
        candidateTrip = false;
        candidateNearParked = false;
        candidateConfirmedMs = normalizedStartMs;
        recentHeadings.clear();
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
        long triggerMs = triggerLocation != null && triggerLocation.getTime() > 0L
            ? triggerLocation.getTime()
            : System.currentTimeMillis();
        activeStartMs = triggerMs;
        activePoints = new JSONArray();
        activeTimeline = new JSONArray();
        activeMotionSamples = new JSONArray();
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
        resetNativeAlertState();
        nativeAutoStartReason = reason;
        lastNativeAutoStopReason = "";
        nativeTripStartSource = "native_auto";
        nativeManualTripId = "";
        nativeManualTrip = false;
        candidateTrip = true;
        candidateNearParked = isInParkingCooldown(triggerLocation);
        candidateConfirmedMs = 0L;
        recentHeadings.clear();
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

        stopLocationUpdates();
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2_000L)
            .setMinUpdateIntervalMillis(1_000L)
            .setMinUpdateDistanceMeters(5f)
            .build();

        try {
            locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
        } catch (SecurityException exception) {
            handleLocationPermissionLost("trip_location_permission_security_exception");
        }
        recordDiagnostic("armed_location_watch", "Waiting for movement after a parked or ended trip.", "armed_gps_backup", lastKnownSpeedKmh, 0L, 0d);
    }

    private void startArmedLocationUpdates() {
        if (!hasLocationPermission()) {
            return;
        }

        stopLocationUpdates();
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5_000L)
            .setMinUpdateIntervalMillis(2_000L)
            .setMinUpdateDistanceMeters(5f)
            .build();

        try {
            locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
        } catch (SecurityException ignored) {}
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
            point.put("timestamp", iso(location.getTime() > 0L ? location.getTime() : System.currentTimeMillis()));
        } catch (JSONException ignored) {}
        return point;
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
        candidateConfirmedMs = 0L;
        lastLiveNotificationMs = 0L;
        resetNativeAlertState();
        recentHeadings.clear();
        nativeHeadingDriftWindow.clear();
        resetMotionState();
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

        long endMs = System.currentTimeMillis();
        JSONArray points = activePoints;
        JSONArray timeline = activeTimeline != null ? activeTimeline : new JSONArray();
        JSONArray motionSamples = activeMotionSamples != null ? activeMotionSamples : new JSONArray();
        long startMs = activeStartMs;
        boolean startedNearParked = candidateNearParked;
        long confirmedMs = candidateConfirmedMs;
        boolean permissionLoss = hasPermissionLoss;
        String completedStartSource = nativeTripStartSource == null || nativeTripStartSource.trim().isEmpty()
            ? "native_auto"
            : nativeTripStartSource;
        boolean completedManualTrip = nativeManualTrip;
        String completedManualTripId = nativeManualTripId == null ? "" : nativeManualTripId;
        long stoppedSeconds = stillSinceMs > 0L ? Math.max(0L, (endMs - stillSinceMs) / 1000L) : 0L;
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
        lastLiveNotificationMs = 0L;
        resetNativeAlertState();
        recentHeadings.clear();
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
            recordDiagnostic("trip_discarded", "Native trip was too short to save.", reason, 0d, stoppedSeconds, 0d);
            return;
        }

        JSONObject trip = new JSONObject();
        String tripId = completedManualTrip && !completedManualTripId.trim().isEmpty()
            ? completedManualTripId
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
            trip.put("route_points", PrivacyZoneChecker.redactRoutePoints(this, points));
            trip.put("motion_samples", motionSamples);
            trip.put("native_motion_sample_count", motionSamples.length());
            trip.put("driving_events", new JSONArray());
            trip.put("score_overall", JSONObject.NULL);
            trip.put("score_safety", JSONObject.NULL);
            trip.put("score_smoothness", JSONObject.NULL);
            trip.put("score_eco", JSONObject.NULL);
            trip.put("score_confidence_label", "unavailable");
            trip.put("score_safety_confidence", "unavailable");
            trip.put("score_smoothness_confidence", "unavailable");
            trip.put("score_eco_confidence", "unavailable");
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
            if (permissionLoss) {
                JSONArray flags = new JSONArray();
                flags.put("location_permission_loss");
                trip.put("data_quality_flags", flags);
                trip.put("score_confidence_flag", "data_gap_detected");
            }
            trip.put("native_phone_proxy_count", nativeMicroSteerCount);
            trip.put("native_phone_usage_access_granted", phoneUsage.optBoolean("usage_access_granted", false));
            trip.put("native_phone_usage_events", phoneUsage.optJSONArray("events") != null ? phoneUsage.optJSONArray("events") : new JSONArray());
            trip.put("native_phone_usage_event_count", phoneUsage.optInt("event_count", 0));
            trip.put("native_phone_usage_total_seconds", phoneUsage.optLong("total_seconds", 0L));
            trip.put("created_at", iso(endMs));
            trip.put("updated_at", iso(endMs));
        } catch (JSONException ignored) {}

        DriveSenseNativeTripStore.addCompletedTrip(this, trip);
        JSONObject finalPoint = points.optJSONObject(points.length() - 1);
        if (finalPoint != null && isParkedStopReason(reason)) {
            DriveSenseNativeTripStore.saveLastParkedLocation(
                this,
                finalPoint.optDouble("lat"),
                finalPoint.optDouble("lng"),
                endMs,
                tripId,
                tailTrim.removedPoints > 0 ? "native_trimmed_parked_tail" : "native_parking_stop"
            );
        }
        candidateConfirmedMs = 0L;
        candidateNearParked = false;
        sendTripCompletedNotification(trip, stats);
    }

    private TripStats calculateStats(JSONArray points, long startMs, long endMs) {
        TripStats stats = new TripStats();
        stats.wallClockDurationSeconds = Math.max(0L, (endMs - startMs) / 1000L);
        stats.durationSeconds = stats.wallClockDurationSeconds;
        if (points == null || points.length() < 2) return stats;

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
            long dt = (currMs - prevMs) / 1000L;
            if (dt <= 0L) continue;
            double impliedSpeed = distance / (dt / 3600d);
            double reportedSpeed = curr.optDouble("speed_kmh", impliedSpeed);
            if (dt > STATS_MAX_SAMPLE_GAP_SECONDS) {
                stats.gapSeconds += dt;
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

            if (speed >= STATIONARY_SPEED_KMH) stats.movingSeconds += dt;
            else stats.idleSeconds += dt;

            if (isNightDrivingEpochMs(currMs)) stats.nightDriving = true;
        }

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
        boolean tinyMovement = distanceM < floor;
        boolean displacementSaysStill = impliedSpeedKmh < STATIONARY_SPEED_KMH && distanceM < floor * 1.5d;
        boolean reportedDisagrees = reportedSpeedKmh < MIN_TRUSTED_SPEED_KMH && displacementSaysStill;
        return tinyMovement || reportedDisagrees;
    }

    private double reliableSpeed(double impliedSpeedKmh, double reportedSpeedKmh) {
        boolean reportedCloseToImplied = Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= 12d;
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

    private void appendMotionSample(long timestampMs) {
        if (activeMotionSamples == null || timestampMs - lastMotionSampleMs < MOTION_SAMPLE_MIN_INTERVAL_MS) return;
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
            while (activeMotionSamples.length() > MAX_NATIVE_MOTION_SAMPLES) {
                activeMotionSamples.remove(0);
            }
            lastMotionSampleMs = timestampMs;
        } catch (JSONException ignored) {}
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
        if (!isSettingEnabled("phone_use_detection_enabled", true) || accuracyM > PHONE_PROXY_MAX_ACCURACY_M) return;
        while (!recentHeadings.isEmpty() && timestampMs - recentHeadings.peekFirst()[1] > PHONE_MICRO_STEER_WINDOW_MS) {
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
        boolean sustainedTurnLike = netHeadingChange >= SUSTAINED_TURN_HEADING_CHANGE_DEG && oscillations < PHONE_MICRO_STEER_MIN_COUNT;
        if (sustainedTurnLike) return;

        if (oscillations >= PHONE_MICRO_STEER_MIN_COUNT) {
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
        double decelThreshold = getSettingDouble("threshold_stop_start_decel_ms2", 2.5d);
        double urbanDecelThreshold = getSettingDouble("threshold_stop_start_urban_decel_ms2", 1.4d);
        double minSpeedKmh = getSettingDouble("threshold_stop_start_min_speed_kmh", 25.0d);
        double speedDropKmh = getSettingDouble("threshold_stop_start_speed_drop_kmh", 6.0d);
        boolean citySpeedPattern = priorSpeedKmh < 55.0d;
        double requiredDecel = citySpeedPattern ? urbanDecelThreshold : decelThreshold;
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
        if (message.startsWith("Road Sage is tracking")) return "tracking_ready";
        if (message.startsWith("Speed warning.")) return "posted_speed_warning";
        if (message.startsWith("Speed check.")) return "estimated_speed_check";
        if (message.startsWith("Long drive reminder.")) return "long_drive";
        if (message.startsWith("Idling reminder.")) return "idle";
        if (message.startsWith("Close manoeuvre detected.")) return "close_manoeuvre";
        if (message.startsWith("Repeated stop-start pattern")) return "stop_start_pattern";
        if (message.startsWith("Hard braking detected.")) return "harsh_brake";
        if (message.startsWith("Rapid acceleration detected.")) return "rapid_accel";
        if (message.startsWith("Sharp cornering detected.")) return "sharp_cornering";
        if (message.startsWith("Attention pattern recorded.")) return "heading_drift";
        if (message.startsWith("Phone use detected.")) return "phone_use";
        return "native_voice_alert";
    }

    private void speakTrackingReadyOnce() {
        if (trackingReadyAlertSpoken || !isSettingEnabled("voice_alerts_enabled", true)) return;
        long now = System.currentTimeMillis();
        if (trackingReadyAlertPending || now - lastTrackingReadyAlertAttemptMs < TRACKING_READY_ALERT_RETRY_MS) return;
        trackingReadyAlertPending = true;
        lastTrackingReadyAlertAttemptMs = now;
        speakNativeAlert(
            "Road Sage is tracking and voice alerts are ready.",
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
        if (!isSettingEnabled("voice_alerts_enabled", true)) {
            speedingSinceMs = 0L;
            if (speechController != null) speechController.stop();
            return;
        }

        long now = System.currentTimeMillis();
        NativeSpeedLimit localSpeedLimit = resolveLocalSpeedLimit(
            location.getLatitude(),
            location.getLongitude(),
            location.hasBearing() ? location.getBearing() : Double.NaN,
            now
        );
        double speedLimitKmh = localSpeedLimit != null
            ? localSpeedLimit.limitKmh
            : getSettingDouble("threshold_speeding_kmh", 100.0d);
        boolean postedLimit = localSpeedLimit != null &&
            "user_confirmed_posted_sign".equals(localSpeedLimit.source);
        boolean estimatedLimit = localSpeedLimit != null && !postedLimit;
        double speedMarginKmh = estimatedLimit
            ? getSettingDouble("estimated_voice_margin_kmh", 12.0d)
            : postedLimit
                ? getSettingDouble("threshold_speed_over_kmh", 5.0d)
                : getSettingDouble("inferred_voice_margin_kmh", 20.0d);
        boolean sourceVoiceAllowed = postedLimit
            ? isSettingEnabled("speak_posted_speed_warnings", true)
            : estimatedLimit
                ? isSettingEnabled("speed_estimates_enabled", true) &&
                    isSettingEnabled("speak_estimated_speed_checks", true)
                : isSettingEnabled("speak_estimated_speed_checks", true);
        if (isSettingEnabled("speed_warning_enabled", true) &&
            sourceVoiceAllowed &&
            shouldTriggerSpeedAlert(speedKmh, speedLimitKmh, speedMarginKmh)) {
            if (speedingSinceMs == 0L) speedingSinceMs = now;
            long speedAlertCooldownMs = postedLimit
                ? SPEED_ALERT_COOLDOWN_MS
                : estimatedLimit
                    ? SPEED_ALERT_ESTIMATED_COOLDOWN_MS
                    : SPEED_ALERT_INFERRED_COOLDOWN_MS;
            if (now - speedingSinceMs >= SPEED_ALERT_SUSTAINED_MS &&
                now - lastSpeedAlertMs >= speedAlertCooldownMs) {
                String message = postedLimit
                    ? String.format(
                        Locale.US,
                        "Speed warning. You are at %d in a posted %d kilometer per hour zone. Ease off smoothly.",
                        Math.round(speedKmh),
                        Math.round(speedLimitKmh)
                    )
                    : estimatedLimit
                        ? String.format(
                            Locale.US,
                            "Speed check. You are at %d in an estimated %d kilometer per hour zone. Check posted signs.",
                            Math.round(speedKmh),
                            Math.round(speedLimitKmh)
                        )
                        : String.format(
                            Locale.US,
                            "Speed check. You are driving %d kilometers per hour. Ease off and check posted signs.",
                            Math.round(speedKmh)
                        );
                speakNativeAlert(
                    message,
                    true,
                    () -> lastSpeedAlertMs = now
                );
            }
        } else {
            speedingSinceMs = 0L;
        }

        long fatigueThresholdMs = Math.max(
            1L,
            Math.round(getSettingDouble("threshold_long_drive_minutes", 120.0d))
        ) * 60_000L;
        if (activeStartMs > 0L && now - activeStartMs >= fatigueThresholdMs &&
            now - lastFatigueAlertMs >= FATIGUE_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Long drive reminder. Plan a break soon when it is safe.",
                false,
                () -> lastFatigueAlertMs = now
            );
        }

        if (stillSinceMs > 0L && now - stillSinceMs >= 5 * 60_000L &&
            now - lastIdleAlertMs >= IDLE_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Idling reminder. Keep the trip moving when conditions allow.",
                false,
                () -> lastIdleAlertMs = now
            );
        }

        if (priorLocation == null) return;
        long priorMs = priorLocation.getTime();
        long currentMs = location.getTime();
        long dtMs = currentMs - priorMs;
        if (dtMs <= 0L || dtMs > LIVE_EVENT_MAX_SAMPLE_GAP_MS) return;
        if (accuracyOf(priorLocation) > LIVE_EVENT_MAX_ACCURACY_M ||
            accuracyOf(location) > LIVE_EVENT_MAX_ACCURACY_M) return;

        double accelerationMs2 = calculateLongitudinalAccelerationMs2(priorSpeedKmh, speedKmh, dtMs);
        double harshBrakeThreshold = getSettingDouble("threshold_harsh_brake_ms2", 3.5d);
        double rapidAccelThreshold = getSettingDouble("threshold_rapid_accel_ms2", 3.0d);
        double priorBearing = priorLocation.hasBearing()
            ? priorLocation.getBearing()
            : priorLocation.bearingTo(location);
        double currentBearing = location.hasBearing() ? location.getBearing() : priorBearing;
        double headingChange = Math.abs(signedHeadingDiff(priorBearing, currentBearing));
        double headingRateDegS = headingChange / (dtMs / 1000d);
        double manoeuvreBrakeThreshold = getSettingDouble("threshold_manoeuvre_alert_brake_ms2", 4.0d);
        double manoeuvreTurnThreshold = getSettingDouble("threshold_manoeuvre_alert_turn_degs", 25.0d);
        if (speedKmh >= 30.0d &&
            accelerationMs2 <= -Math.abs(manoeuvreBrakeThreshold) &&
            headingRateDegS >= manoeuvreTurnThreshold &&
            now - lastCloseManoeuvreAlertMs >= CLOSE_MANOEUVRE_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Close manoeuvre detected. Create space, then review conditions when safe.",
                false,
                () -> lastCloseManoeuvreAlertMs = now
            );
            return;
        }
        if (recordStopStartCycle(now, priorSpeedKmh, speedKmh, accelerationMs2) &&
            now - lastStopStartAlertMs >= STOP_START_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Repeated stop-start pattern recorded. Add space ahead and keep inputs smooth.",
                false,
                () -> lastStopStartAlertMs = now
            );
            stopStartCycleCount = 0;
            stopStartWindowStartMs = now;
            return;
        }
        if (accelerationMs2 <= -harshBrakeThreshold &&
            priorSpeedKmh >= LIVE_EVENT_MIN_SPEED_KMH &&
            now - lastHarshBrakeAlertMs >= MANOEUVRE_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Hard braking detected. Open your following space and brake earlier.",
                false,
                () -> lastHarshBrakeAlertMs = now
            );
            return;
        }
        if (accelerationMs2 >= rapidAccelThreshold &&
            speedKmh >= LIVE_EVENT_MIN_SPEED_KMH &&
            now - lastRapidAccelAlertMs >= MANOEUVRE_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Rapid acceleration detected. Ease into the throttle.",
                false,
                () -> lastRapidAccelAlertMs = now
            );
            return;
        }

        double lateralG = calculateLateralG(speedKmh, headingChange, dtMs);
        double sharpTurnThreshold = getSettingDouble("threshold_sharp_turn_g_low", 0.35d);
        if (headingChange >= SHARP_TURN_MIN_HEADING_CHANGE_DEG &&
            speedKmh >= LIVE_EVENT_MIN_SPEED_KMH &&
            lateralG >= sharpTurnThreshold &&
            now - lastCorneringAlertMs >= MANOEUVRE_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Sharp cornering detected. Slow before the turn and steer smoothly.",
                false,
                () -> lastCorneringAlertMs = now
            );
            return;
        }

        double headingDriftThreshold = getSettingDouble("threshold_heading_drift_std_degs", 8.0d);
        if (shouldAlertHeadingDrift(headingDriftThreshold) &&
            now - lastHeadingDriftAlertMs >= HEADING_DRIFT_ALERT_COOLDOWN_MS) {
            speakNativeAlert(
                "Attention pattern recorded. Keep your eyes up and plan a break if you feel tired.",
                false,
                () -> lastHeadingDriftAlertMs = now
            );
        }
    }

    @Nullable
    private NativeSpeedLimit resolveLocalSpeedLimit(double lat, double lng, double headingDeg, long nowMs) {
        try {
            String raw = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(SPEED_KNOWLEDGE_KEY, null);
            if (raw == null || raw.trim().isEmpty()) return null;
            return findLocalSpeedLimit(new JSONObject(raw), lat, lng, headingDeg, nowMs);
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
        if (data == null || !Double.isFinite(lat) || !Double.isFinite(lng)) return null;
        JSONArray corrections = data.optJSONArray("corrections");
        if (corrections == null) return null;

        NativeSpeedLimit best = null;
        long bestAppliedAtMs = Long.MIN_VALUE;
        for (int index = 0; index < corrections.length(); index++) {
            JSONObject correction = corrections.optJSONObject(index);
            if (correction == null) continue;
            double limitKmh = correction.optDouble("limitKmh", Double.NaN);
            String geohash = correction.optString("geohash", "");
            if (!Double.isFinite(limitKmh) || limitKmh <= 0d || geohash.isEmpty()) continue;

            long expiresAtMs = parseIsoEpochMs(correction.optString("expiresAt", ""));
            if (expiresAtMs > 0L && expiresAtMs <= nowMs) continue;
            if (!correctionMatchesLocation(correction, geohash, lat, lng, headingDeg, nowMs)) continue;

            long appliedAtMs = parseIsoEpochMs(correction.optString("appliedAt", ""));
            if (best != null && appliedAtMs < bestAppliedAtMs) continue;
            String source = "user_confirmed_posted_sign".equals(correction.optString("source", ""))
                ? "user_confirmed_posted_sign"
                : "user_entered_estimate";
            best = new NativeSpeedLimit(limitKmh, source);
            bestAppliedAtMs = appliedAtMs;
        }
        return best;
    }

    static boolean correctionMatchesLocation(JSONObject correction, String geohash, double lat, double lng, double headingDeg, long nowMs) {
        if (!correctionActiveAt(correction, nowMs)) return false;
        if (!correctionMatchesDirection(correction, headingDeg)) return false;
        JSONArray sectionPoints = correction == null ? null : correction.optJSONArray("sectionPoints");
        if (sectionPoints != null && sectionPoints.length() >= 2) {
            JSONObject previous = null;
            for (int index = 0; index < sectionPoints.length(); index++) {
                JSONObject current = sectionPoints.optJSONObject(index);
                if (!isUsableCoordinate(current)) continue;
                if (previous != null &&
                    pointToSegmentDistanceKm(lat, lng, previous, current) <= SPEED_KNOWLEDGE_SECTION_MATCH_RADIUS_KM) {
                    return true;
                }
                previous = current;
            }
            return false;
        }

        double[] center = geohashCenter(geohash);
        return center != null && haversineKm(center[0], center[1], lat, lng) <= SPEED_KNOWLEDGE_MATCH_RADIUS_KM;
    }

    private static boolean correctionActiveAt(@Nullable JSONObject correction, long nowMs) {
        JSONObject rule = correction == null ? null : correction.optJSONObject("timeRule");
        if (rule == null || !rule.optBoolean("enabled", false)) return true;
        if (nowMs <= 0L) return false;
        LocalDateTime date = LocalDateTime.ofInstant(Instant.ofEpochMilli(nowMs), ZoneId.systemDefault());
        int jsDay = date.getDayOfWeek().getValue() % 7;
        JSONArray days = rule.optJSONArray("days");
        boolean dayAllowed = false;
        if (days != null) {
            for (int index = 0; index < days.length(); index++) {
                if (days.optInt(index, -1) == jsDay) {
                    dayAllowed = true;
                    break;
                }
            }
        }
        if (!dayAllowed) return false;
        int startMinutes = rule.optInt("startMinutes", -1);
        int endMinutes = rule.optInt("endMinutes", -1);
        if (startMinutes < 0 || endMinutes < 0) return false;
        int minutes = date.getHour() * 60 + date.getMinute();
        if (startMinutes == endMinutes) return true;
        return startMinutes < endMinutes
            ? minutes >= startMinutes && minutes <= endMinutes
            : minutes >= startMinutes || minutes <= endMinutes;
    }

    private static boolean correctionMatchesDirection(@Nullable JSONObject correction, double headingDeg) {
        String mode = correction == null ? "both" : correction.optString("directionMode", "both");
        if (!"forward".equals(mode) && !"reverse".equals(mode)) return true;
        if (!Double.isFinite(headingDeg)) return false;
        double bearing = correction.optDouble("directionBearing", Double.NaN);
        if (!Double.isFinite(bearing)) {
            bearing = sectionBearing(correction.optJSONArray("sectionPoints"));
        }
        if (!Double.isFinite(bearing)) return false;
        double expected = "reverse".equals(mode) ? normalizeBearing(bearing + 180d) : normalizeBearing(bearing);
        return angleDiffDeg(headingDeg, expected) <= SPEED_KNOWLEDGE_DIRECTION_TOLERANCE_DEG;
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
    private static double[] geohashCenter(String hash) {
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

    static final class NativeSpeedLimit {
        final double limitKmh;
        final String source;

        NativeSpeedLimit(double limitKmh, String source) {
            this.limitKmh = limitKmh;
            this.source = source;
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
        nativeHeadingDriftWindow.clear();
        stopStartWindowStartMs = 0L;
        stopStartCycleCount = 0;
        trackingReadyAlertSpoken = false;
        trackingReadyAlertPending = false;
        lastTrackingReadyAlertAttemptMs = 0L;
    }

    private double signedHeadingDiff(double h1, double h2) {
        double diff = h2 - h1;
        while (diff > 180d) diff -= 360d;
        while (diff <= -180d) diff += 360d;
        return diff;
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
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, SAFETY_ALERTS_CHANNEL_ID)
            .setSmallIcon(getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()))
            .setContentTitle("Eyes on the Road")
            .setContentText("Possible distracted driving detected. Stay focused.")
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
        finishTrip("service_stopped_by_user", false);
        removeActivityUpdates();
        stopLocationUpdates();
        DriveSenseNativeTripStore.setServiceEnabled(this, false);
        stopForeground(STOP_FOREGROUND_REMOVE);
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

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIF_ID_TRACKING_START, buildNotification(text));
    }

    private boolean isParkedStopReason(String reason) {
        if (reason == null) return false;
        return reason.contains("parked") || reason.contains("still") || reason.contains("on_foot");
    }

    private void updateLiveTripNotification(boolean force) {
        if (!isTripActive()) return;
        long now = System.currentTimeMillis();
        if (!force && now - lastLiveNotificationMs < LIVE_NOTIFICATION_MIN_INTERVAL_MS) return;
        lastLiveNotificationMs = now;
        if (!candidateTrip) checkAndroidUsageAccessPhoneUse(now);
        updateNotification(buildLiveTripStatus(now));
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
            if (isSettingEnabled("voice_alerts_enabled", true)) {
                speakNativeAlert("Phone use detected. Keep your eyes up. Handle the phone only when parked.", true);
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
        } catch (JSONException ignored) {}
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
        manager.createNotificationChannel(channel);
    }

    static String iso(long timeMs) {
        return Instant.ofEpochMilli(timeMs).toString();
    }

    static boolean isNightDrivingEpochMs(long timeMs) {
        int hour = Instant.ofEpochMilli(timeMs).atZone(ZoneId.systemDefault()).getHour();
        return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
    }

    private static long parseIso(String value) {
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (DateTimeParseException | NullPointerException e) {
            try {
                return LocalDateTime.parse(value)
                    .atZone(ZoneId.systemDefault())
                    .toInstant()
                    .toEpochMilli();
            } catch (DateTimeParseException | NullPointerException ignored) {
                return System.currentTimeMillis();
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
        long durationSeconds = 0L;
        int speedSamples = 0;
        boolean nightDriving = false;
    }

    private static class TailTrimResult {
        JSONArray points = new JSONArray();
        long endMs = 0L;
        int removedPoints = 0;
    }
}
