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
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.speech.tts.TextToSpeech;

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
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;

public class DriveSenseAutoTrackingService extends Service {
    static final String ACTION_START = "com.drivesense.app.action.START_NATIVE_AUTO";
    static final String ACTION_STOP = "com.drivesense.app.action.STOP_NATIVE_AUTO";
    static final String ACTION_END_TRIP = "com.drivesense.app.action.END_NATIVE_TRIP";
    static final String ACTION_ACTIVITY = "com.drivesense.app.action.ACTIVITY_UPDATE";
    static final String EXTRA_ACTIVITY_TYPE = "activityType";
    static final String EXTRA_ACTIVITY_CONFIDENCE = "activityConfidence";

    private static final int NOTIFICATION_ID = 4101;
    private static final int ACTIVITY_REQUEST_CODE = 4102;
    private static final int AUTO_STATUS_NOTIFICATION_ID = 4103;
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
    private static final String NOTIFICATION_PREFS = "drivesense_native_notification_state";
    private static final String KEY_LAST_PHONE_USE_NOTIFICATION_MS = "last_phone_use_notification_ms";
    private static final String KEY_LAST_TRIP_COMPLETED_NOTIFICATION_ID = "last_trip_completed_notification_id";
    private static final int PHONE_USE_NOTIFICATION_ID = 4001;
    private static final int TRIP_COMPLETED_NOTIFICATION_ID = 2002;
    private static final int PHONE_MICRO_STEER_WINDOW_MS = 10_000;
    private static final int PHONE_MICRO_STEER_MIN_COUNT = 4;
    private static final double PHONE_MICRO_STEER_MIN_DEG = 3.0d;
    private static final double PHONE_MICRO_STEER_MAX_DEG = 18.0d;
    private static final double PHONE_DETECT_MIN_SPEED_KMH = 30.0d;
    private static final long PHONE_NOTIFY_COOLDOWN_MS = 120_000L;
    private static final long PHONE_WINDOW_COUNT_COOLDOWN_MS = 15_000L;
    private static final long LIVE_NOTIFICATION_MIN_INTERVAL_MS = 10_000L;

    private ActivityRecognitionClient activityClient;
    private FusedLocationProviderClient locationClient;
    private PendingIntent activityIntent;
    private LocationCallback locationCallback;
    private JSONArray activePoints;
    private JSONArray activeTimeline;
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
    private int nativeMicroSteerCount = 0;
    private long lastPhoneUseNotifyMs = 0L;
    private long lastNativePhoneWindowMs = 0L;
    private long lastLiveNotificationMs = 0L;
    private TextToSpeech textToSpeech;
    private boolean textToSpeechReady = false;
    private String nativeAutoStartReason = "";
    private String lastNativeAutoStopReason = "";
    private boolean candidateTrip = false;
    private boolean candidateNearParked = false;
    private long candidateConfirmedMs = 0L;
    private int lastActivityType = DetectedActivity.UNKNOWN;
    private int lastActivityConfidence = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIFICATION_ID, buildNotification("Ready when you start moving"));
        ensureSafetyAlertsChannel();
        activityClient = ActivityRecognition.getClient(this);
        locationClient = LocationServices.getFusedLocationProviderClient(this);
        activityIntent = PendingIntent.getBroadcast(
            this,
            ACTIVITY_REQUEST_CODE,
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
            NOTIFICATION_ID,
            buildNotification(isTripActive() ? buildLiveTripStatus(System.currentTimeMillis()) : "Ready when you start moving")
        );

        if (ACTION_STOP.equals(action)) {
            stopEverything();
            stopSelf();
            return START_NOT_STICKY;
        }

        DriveSenseNativeTripStore.setServiceEnabled(this, true);
        if (ACTION_END_TRIP.equals(action)) {
            finishTrip("notification_end_trip", true);
            recordDiagnostic("service_armed", "Native service is armed for auto tracking.", "notification_end_trip", 0d, 0L, 0d);
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
        DriveSenseNativeTripStore.setServiceEnabled(this, false);
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
            textToSpeechReady = false;
        }
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

        NotificationManagerCompat.from(context).notify(AUTO_STATUS_NOTIFICATION_ID, builder.build());
    }

    private static void cancelAutoTrackingOffNotification(Context context) {
        NotificationManagerCompat.from(context).cancel(AUTO_STATUS_NOTIFICATION_ID);
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

    private void startCandidateTrip(String reason, @Nullable Location triggerLocation) {
        if (isTripActive()) return;
        long triggerMs = triggerLocation != null && triggerLocation.getTime() > 0L
            ? triggerLocation.getTime()
            : System.currentTimeMillis();
        activeStartMs = triggerMs;
        activePoints = new JSONArray();
        activeTimeline = new JSONArray();
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
        lastNativePhoneWindowMs = 0L;
        lastLiveNotificationMs = 0L;
        nativeAutoStartReason = reason;
        lastNativeAutoStopReason = "";
        candidateTrip = true;
        candidateNearParked = isInParkingCooldown(triggerLocation);
        candidateConfirmedMs = 0L;
        recentHeadings.clear();
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
        startTripLocationUpdates();
    }

    private boolean isTripActive() {
        return activeStartMs > 0L && activePoints != null;
    }

    private void startTripLocationUpdates() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        stopLocationUpdates();
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2_000L)
            .setMinUpdateIntervalMillis(1_000L)
            .setMinUpdateDistanceMeters(5f)
            .build();

        locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
        recordDiagnostic("armed_location_watch", "Waiting for movement after a parked or ended trip.", "armed_gps_backup", lastKnownSpeedKmh, 0L, 0d);
    }

    private void startArmedLocationUpdates() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        stopLocationUpdates();
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5_000L)
            .setMinUpdateIntervalMillis(2_000L)
            .setMinUpdateDistanceMeters(5f)
            .build();

        locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
    }

    private void stopLocationUpdates() {
        if (locationClient != null && locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback);
        }
    }

    private void recordLocation(Location location) {
        if (location == null) return;
        if (location.hasAccuracy() && location.getAccuracy() > MAX_ACCURACY_M) return;

        if (!isTripActive()) {
            handleArmedLocation(location);
            return;
        }

        double speedKmh = location.hasSpeed() ? Math.max(0d, location.getSpeed() * 3.6d) : 0d;
        if (previousLocation != null) {
            long dtMs = Math.max(1L, location.getTime() - previousLocation.getTime());
            double distanceKm = previousLocation.distanceTo(location) / 1000d;
            double distanceM = distanceKm * 1000d;
            double impliedSpeed = distanceKm / (dtMs / 3_600_000d);
            double reportedSpeed = location.hasSpeed() ? speedKmh : impliedSpeed;
            if (isNoise(distanceM, impliedSpeed, reportedSpeed, accuracyOf(previousLocation), accuracyOf(location)) && dtMs < 45_000L) return;
            if (impliedSpeed > MAX_SPEED_KMH || reportedSpeed > MAX_SPEED_KMH) return;
            if (!location.hasSpeed()) speedKmh = reliableSpeed(impliedSpeed, reportedSpeed);
        }
        lastKnownSpeedKmh = speedKmh;
        lastLocationMs = location.getTime() > 0L ? location.getTime() : System.currentTimeMillis();

        double bearing = Double.NaN;
        if (location.hasBearing()) bearing = location.getBearing();
        else if (previousLocation != null) bearing = previousLocation.bearingTo(location);
        if (!candidateTrip && !Double.isNaN(bearing)) updatePhoneUseProxy(bearing, speedKmh, location.getTime() > 0L ? location.getTime() : System.currentTimeMillis());

        activePoints.put(locationToJson(location, speedKmh));
        previousLocation = location;
        if (candidateTrip) {
            reviewCandidate(false);
            if (!isTripActive()) return;
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
        return (lastActivityType == DetectedActivity.WALKING ||
            lastActivityType == DetectedActivity.RUNNING ||
            lastActivityType == DetectedActivity.ON_BICYCLE) &&
            lastActivityConfidence >= 75;
    }

    private boolean isVehicleSignal() {
        return lastActivityType == DetectedActivity.IN_VEHICLE && lastActivityConfidence >= MIN_VEHICLE_CONFIDENCE;
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
        activePoints = null;
        activeTimeline = null;
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
        candidateConfirmedMs = 0L;
        lastLiveNotificationMs = 0L;
        recentHeadings.clear();
        stopLocationUpdates();
        if (keepArmed && DriveSenseNativeTripStore.isServiceEnabled(this)) {
            startArmedLocationUpdates();
        }
        updateNotification("Ready when you start moving");
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
        long startMs = activeStartMs;
        boolean startedNearParked = candidateNearParked;
        long confirmedMs = candidateConfirmedMs;
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
        lastLiveNotificationMs = 0L;
        recentHeadings.clear();
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
        String tripId = DriveSenseNativeTripStore.newTripId();
        try {
            JSONObject phoneUsage = DriveSensePhoneUsageTracker.queryTripUsage(this, startMs, endMs);
            trip.put("id", tripId);
            trip.put("start_time", iso(startMs));
            trip.put("end_time", iso(endMs));
            trip.put("duration_seconds", stats.durationSeconds);
            trip.put("distance_km", round(stats.distanceKm, 3));
            trip.put("avg_speed_kmh", round(stats.avgSpeedKmh, 1));
            trip.put("avg_running_speed_kmh", round(stats.avgRunningSpeedKmh, 1));
            trip.put("max_speed_kmh", round(stats.maxSpeedKmh, 1));
            trip.put("idle_time_seconds", stats.idleSeconds);
            trip.put("night_driving", stats.nightDriving);
            trip.put("route_points", points);
            trip.put("driving_events", new JSONArray());
            trip.put("score_overall", 100);
            trip.put("score_safety", 100);
            trip.put("score_smoothness", 100);
            trip.put("score_eco", 100);
            trip.put("harsh_brakes_count", 0);
            trip.put("rapid_accel_count", 0);
            trip.put("sharp_turns_count", 0);
            trip.put("speeding_events_count", 0);
            trip.put("status", "completed");
            trip.put("background_tracking", true);
            trip.put("start_source", "native_auto");
            trip.put("native_trip_state", "confirmed");
            trip.put("native_candidate_started_at", iso(startMs));
            if (confirmedMs > 0L) trip.put("native_candidate_confirmed_at", iso(confirmedMs));
            trip.put("native_candidate_near_parked", startedNearParked);
            trip.put("native_tail_trimmed_points", tailTrim.removedPoints);
            trip.put("native_auto_start_reason", nativeAutoStartReason);
            trip.put("native_auto_stop_reason", lastNativeAutoStopReason);
            trip.put("native_tracking_timeline", timeline);
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
        stats.durationSeconds = Math.max(0L, (endMs - startMs) / 1000L);
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
            long dt = Math.max(0L, (currMs - prevMs) / 1000L);
            if (dt == 0L) continue;
            if (dt <= 0L || dt >= 120L) continue;

            double impliedSpeed = distance / (dt / 3600d);
            double reportedSpeed = curr.optDouble("speed_kmh", impliedSpeed);
            double distanceM = distance * 1000d;
            if (isNoise(distanceM, impliedSpeed, reportedSpeed, prev.optDouble("accuracy", 0d), curr.optDouble("accuracy", 0d))) {
                continue;
            }

            double speed = reliableSpeed(impliedSpeed, reportedSpeed);
            stats.distanceKm += distance;
            stats.speedSamples += 1;
            stats.maxSpeedKmh = Math.max(stats.maxSpeedKmh, speed);

            if (speed >= STATIONARY_SPEED_KMH) stats.movingSeconds += dt;
            if (speed < STATIONARY_SPEED_KMH) stats.idleSeconds += dt;

            int hour = Instant.ofEpochMilli(currMs).atZone(ZoneOffset.UTC).getHour();
            if (hour >= 22 || hour < 6) stats.nightDriving = true;
        }

        JSONObject last = points.optJSONObject(points.length() - 1);
        if (last != null) {
            long lastMs = parseIso(last.optString("timestamp"));
            long terminalIdleSeconds = Math.max(0L, (endMs - lastMs) / 1000L);
            double lastSpeed = last.optDouble("speed_kmh", 0d);
            if (lastSpeed < STATIONARY_SPEED_KMH && terminalIdleSeconds > 0L) {
                stats.idleSeconds += Math.min(terminalIdleSeconds, 1800L);
            }
        }

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
        double bestAccuracy = (previousAccuracy > 0d && currentAccuracy > 0d)
            ? Math.min(previousAccuracy, currentAccuracy)
            : Math.max(previousAccuracy, currentAccuracy);
        return Math.max(MIN_POINT_DISTANCE_M, Math.min(25d, bestAccuracy * 0.6d));
    }

    private boolean isNoise(double distanceM, double impliedSpeedKmh, double reportedSpeedKmh, double previousAccuracy, double currentAccuracy) {
        double floor = noiseFloor(previousAccuracy, currentAccuracy);
        boolean tinyMovement = distanceM < floor;
        boolean displacementSaysStill = impliedSpeedKmh < STATIONARY_SPEED_KMH && distanceM < floor * 1.5d;
        boolean reportedDisagrees = reportedSpeedKmh < MIN_TRUSTED_SPEED_KMH && displacementSaysStill;
        return tinyMovement || reportedDisagrees;
    }

    private double reliableSpeed(double impliedSpeedKmh, double reportedSpeedKmh) {
        boolean reportedCloseToImplied = impliedSpeedKmh >= STATIONARY_SPEED_KMH ||
            reportedSpeedKmh >= MIN_TRUSTED_SPEED_KMH ||
            Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= 12d;
        return Math.max(0d, reportedCloseToImplied ? reportedSpeedKmh : impliedSpeedKmh);
    }

    private double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double earthKm = 6371d;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.pow(Math.sin(dLat / 2d), 2d) +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
            Math.pow(Math.sin(dLng / 2d), 2d);
        double c = 2d * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0d, 1d - a)));
        return earthKm * c;
    }

    private void updatePhoneUseProxy(double bearing, double speedKmh, long timestampMs) {
        if (!isSettingEnabled("phone_use_detection_enabled", true) || !isSettingEnabled("phone_use_live_alert_enabled", true)) return;
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
        boolean sustainedTurnLike = netHeadingChange >= 35.0d && oscillations < PHONE_MICRO_STEER_MIN_COUNT;
        if (sustainedTurnLike) return;

        if (oscillations >= PHONE_MICRO_STEER_MIN_COUNT) {
            if (timestampMs - lastNativePhoneWindowMs < PHONE_WINDOW_COUNT_COOLDOWN_MS) return;
            lastNativePhoneWindowMs = timestampMs;
            nativeMicroSteerCount++;
            long now = System.currentTimeMillis();
            if (now - lastPhoneUseNotifyMs > PHONE_NOTIFY_COOLDOWN_MS) {
                sendPhoneUseWarningNotification();
                if (isSettingEnabled("voice_alerts_enabled", true)) {
                    speakNativeAlert("Put your phone down. Keep your eyes on the road.");
                }
                lastPhoneUseNotifyMs = now;
            }
        }
    }

    private void speakNativeAlert(String text) {
        if (text == null || text.trim().isEmpty()) return;
        if (textToSpeech != null && textToSpeechReady) {
            speakNativeAlertNow(text);
            return;
        }
        if (textToSpeech == null) {
            textToSpeech = new TextToSpeech(this, status -> {
                if (status == TextToSpeech.SUCCESS && textToSpeech != null) {
                    textToSpeech.setLanguage(Locale.getDefault());
                    textToSpeech.setSpeechRate(0.95f);
                    textToSpeechReady = true;
                    speakNativeAlertNow(text);
                }
            });
        }
    }

    private void speakNativeAlertNow(String text) {
        if (textToSpeech == null) return;
        String utteranceId = "drivesense_phone_use_" + System.currentTimeMillis();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        } else {
            textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null);
        }
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
        manager.notify(NOTIFICATION_ID, buildNotification(text));
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
        JSONObject usage = DriveSensePhoneUsageTracker.queryTripUsage(this, Math.max(activeStartMs, nowMs - 120_000L), nowMs);
        JSONArray sessions = usage.optJSONArray("events");
        if (sessions == null || sessions.length() == 0) return;

        JSONObject latest = sessions.optJSONObject(sessions.length() - 1);
        if (latest == null) return;
        long startMs = latest.optLong("start_ms", 0L);
        long durationSeconds = latest.optLong("duration_seconds", 0L);
        if (startMs <= lastNativePhoneWindowMs || durationSeconds < 5L || lastKnownSpeedKmh < 15d) return;

        lastNativePhoneWindowMs = startMs;
        nativeMicroSteerCount++;
        if (nowMs - lastPhoneUseNotifyMs > PHONE_NOTIFY_COOLDOWN_MS) {
            sendPhoneUseWarningNotification();
            if (isSettingEnabled("voice_alerts_enabled", true)) {
                speakNativeAlert("Put your phone down. Keep your eyes on the road.");
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

    private static long parseIso(String value) {
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (DateTimeParseException | NullPointerException e) {
            return System.currentTimeMillis();
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
