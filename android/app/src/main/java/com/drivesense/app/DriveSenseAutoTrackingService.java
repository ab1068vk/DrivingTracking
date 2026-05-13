package com.drivesense.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
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

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public class DriveSenseAutoTrackingService extends Service {
    static final String ACTION_START = "com.drivesense.app.action.START_NATIVE_AUTO";
    static final String ACTION_STOP = "com.drivesense.app.action.STOP_NATIVE_AUTO";
    static final String ACTION_ACTIVITY = "com.drivesense.app.action.ACTIVITY_UPDATE";
    static final String EXTRA_ACTIVITY_TYPE = "activityType";
    static final String EXTRA_ACTIVITY_CONFIDENCE = "activityConfidence";

    private static final int NOTIFICATION_ID = 4101;
    private static final int ACTIVITY_REQUEST_CODE = 4102;
    private static final String CHANNEL_ID = "drivesense_native_auto_tracking";
    private static final int MIN_VEHICLE_CONFIDENCE = 70;
    private static final int MIN_STILL_CONFIDENCE = 70;
    private static final int MIN_POINTS_TO_SAVE = 2;
    private static final long MIN_TRIP_MS = 30_000L;
    private static final double MIN_TRIP_KM = 0.1d;
    private static final long AUTO_STOP_STILL_MS = 180_000L;
    private static final float MAX_ACCURACY_M = 75f;
    private static final double MIN_POINT_DISTANCE_M = 8d;
    private static final double STATIONARY_SPEED_KMH = 5d;
    private static final double MIN_TRUSTED_SPEED_KMH = 18d;
    private static final double MAX_SPEED_KMH = 220d;

    private ActivityRecognitionClient activityClient;
    private FusedLocationProviderClient locationClient;
    private PendingIntent activityIntent;
    private LocationCallback locationCallback;
    private JSONArray activePoints;
    private long activeStartMs = 0L;
    private long stillSinceMs = 0L;
    private Location previousLocation;

    @Override
    public void onCreate() {
        super.onCreate();
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
        startForeground(NOTIFICATION_ID, buildNotification("Ready to detect driving"));

        if (ACTION_STOP.equals(action)) {
            stopEverything();
            stopSelf();
            return START_NOT_STICKY;
        }

        DriveSenseNativeTripStore.setServiceEnabled(this, true);
        requestActivityUpdates();

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
        stopLocationUpdates();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void start(Context context) {
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_START);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_STOP);
        ContextCompat.startForegroundService(context, intent);
    }

    static void handleActivityBroadcast(Context context, DetectedActivity activity) {
        if (activity == null) return;
        if (!DriveSenseNativeTripStore.isServiceEnabled(context)) return;

        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class);
        intent.setAction(ACTION_ACTIVITY);
        intent.putExtra(EXTRA_ACTIVITY_TYPE, activity.getType());
        intent.putExtra(EXTRA_ACTIVITY_CONFIDENCE, activity.getConfidence());
        ContextCompat.startForegroundService(context, intent);
    }

    private void handleActivity(int type, int confidence) {
        if (type == DetectedActivity.IN_VEHICLE && confidence >= MIN_VEHICLE_CONFIDENCE) {
            stillSinceMs = 0L;
            startTripIfNeeded();
            return;
        }

        boolean still = type == DetectedActivity.STILL && confidence >= MIN_STILL_CONFIDENCE;
        boolean clearlyNotVehicle = type != DetectedActivity.IN_VEHICLE && confidence >= 80;
        if (isTripActive() && (still || clearlyNotVehicle)) {
            if (stillSinceMs == 0L) stillSinceMs = System.currentTimeMillis();
            if (System.currentTimeMillis() - stillSinceMs >= AUTO_STOP_STILL_MS) {
                finishTrip();
            }
        } else if (!still) {
            stillSinceMs = 0L;
        }
    }

    private void requestActivityUpdates() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        activityClient.requestActivityUpdates(15_000L, activityIntent);
    }

    private void removeActivityUpdates() {
        activityClient.removeActivityUpdates(activityIntent);
    }

    private void startTripIfNeeded() {
        if (isTripActive()) return;
        activeStartMs = System.currentTimeMillis();
        activePoints = new JSONArray();
        previousLocation = null;
        stillSinceMs = 0L;
        updateNotification("Trip recording active");
        startLocationUpdates();
    }

    private boolean isTripActive() {
        return activeStartMs > 0L && activePoints != null;
    }

    private void startLocationUpdates() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5_000L)
            .setMinUpdateIntervalMillis(3_000L)
            .setMinUpdateDistanceMeters(10f)
            .build();

        locationClient.requestLocationUpdates(request, locationCallback, getMainLooper());
    }

    private void stopLocationUpdates() {
        if (locationClient != null && locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback);
        }
    }

    private void recordLocation(Location location) {
        if (!isTripActive() || location == null) return;
        if (location.hasAccuracy() && location.getAccuracy() > MAX_ACCURACY_M) return;

        if (previousLocation != null) {
            long dtMs = Math.max(1L, location.getTime() - previousLocation.getTime());
            double distanceKm = previousLocation.distanceTo(location) / 1000d;
            double distanceM = distanceKm * 1000d;
            double impliedSpeed = distanceKm / (dtMs / 3_600_000d);
            double reportedSpeed = location.hasSpeed() ? Math.max(0d, location.getSpeed() * 3.6d) : impliedSpeed;
            if (isNoise(distanceM, impliedSpeed, reportedSpeed, accuracyOf(previousLocation), accuracyOf(location)) && dtMs < 45_000L) return;
            if (impliedSpeed > MAX_SPEED_KMH || reportedSpeed > MAX_SPEED_KMH) return;
        }

        activePoints.put(locationToJson(location));
        previousLocation = location;

        double speedKmh = location.hasSpeed() ? Math.max(0d, location.getSpeed() * 3.6d) : 0d;
        if (speedKmh < 5d) {
            if (stillSinceMs == 0L) stillSinceMs = System.currentTimeMillis();
            if (System.currentTimeMillis() - stillSinceMs >= AUTO_STOP_STILL_MS) {
                finishTrip();
            }
        } else {
            stillSinceMs = 0L;
        }
    }

    private JSONObject locationToJson(Location location) {
        JSONObject point = new JSONObject();
        try {
            point.put("lat", location.getLatitude());
            point.put("lng", location.getLongitude());
            if (location.hasSpeed()) point.put("speed_kmh", Math.max(0d, location.getSpeed() * 3.6d));
            else point.put("speed_kmh", JSONObject.NULL);
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

    private void finishTrip() {
        if (!isTripActive()) return;

        long endMs = System.currentTimeMillis();
        JSONArray points = activePoints;
        long startMs = activeStartMs;
        activePoints = null;
        activeStartMs = 0L;
        previousLocation = null;
        stillSinceMs = 0L;
        stopLocationUpdates();
        updateNotification("Ready to detect driving");

        TripStats stats = calculateStats(points, startMs, endMs);
        if (points.length() < MIN_POINTS_TO_SAVE || stats.durationSeconds < MIN_TRIP_MS / 1000L || stats.distanceKm < MIN_TRIP_KM) {
            return;
        }

        JSONObject trip = new JSONObject();
        try {
            trip.put("id", DriveSenseNativeTripStore.newTripId());
            trip.put("start_time", iso(startMs));
            trip.put("end_time", iso(endMs));
            trip.put("duration_seconds", stats.durationSeconds);
            trip.put("distance_km", round(stats.distanceKm, 3));
            trip.put("avg_speed_kmh", round(stats.avgSpeedKmh, 1));
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
            trip.put("created_at", iso(endMs));
            trip.put("updated_at", iso(endMs));
        } catch (JSONException ignored) {}

        DriveSenseNativeTripStore.addCompletedTrip(this, trip);
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
            long prevMs = parseIso(prev.optString("timestamp"));
            long currMs = parseIso(curr.optString("timestamp"));
            long dt = Math.max(0L, (currMs - prevMs) / 1000L);
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

            if (speed < STATIONARY_SPEED_KMH) stats.idleSeconds += dt;

            int hour = Integer.parseInt(new SimpleDateFormat("H", Locale.US).format(new Date(currMs)));
            if (hour >= 22 || hour < 6) stats.nightDriving = true;
        }

        stats.avgSpeedKmh = stats.durationSeconds > 0L && stats.distanceKm > 0d
            ? stats.distanceKm / (stats.durationSeconds / 3600d)
            : 0d;
        if (stats.speedSamples == 0) stats.maxSpeedKmh = 0d;
        return stats;
    }

    private double accuracyOf(Location location) {
        return location != null && location.hasAccuracy() ? location.getAccuracy() : 0d;
    }

    private double noiseFloor(double previousAccuracy, double currentAccuracy) {
        double bestAccuracy = Math.max(Math.max(0d, previousAccuracy), Math.max(0d, currentAccuracy));
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
        double c = 2d * Math.atan2(Math.sqrt(a), Math.sqrt(1d - a));
        return earthKm * c;
    }

    private void stopEverything() {
        finishTrip();
        removeActivityUpdates();
        stopLocationUpdates();
        DriveSenseNativeTripStore.setServiceEnabled(this, false);
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private Notification buildNotification(String text) {
        ensureChannel();
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getResources().getIdentifier("ic_stat_drivesense", "drawable", getPackageName()))
            .setContentTitle("DriveSense auto tracking")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Native Auto Tracking",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps DriveSense ready to detect and record driving trips.");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private static String iso(long timeMs) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timeMs));
    }

    private static long parseIso(String value) {
        try {
            SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
            return formatter.parse(value).getTime();
        } catch (Exception e) {
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
        double maxSpeedKmh = 0d;
        long idleSeconds = 0L;
        long durationSeconds = 0L;
        int speedSamples = 0;
        boolean nightDriving = false;
    }
}
