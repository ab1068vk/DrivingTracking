package com.drivesense.app;

import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import android.util.Log;

/** Selects a robust, recorded GPS fix from the terminal stop rather than trusting one noisy point. */
final class DriveSenseParkingResolver {
    private static final String TAG = "ParkingResolver";
    private static final long MAX_WINDOW_MS = 5 * 60_000L;
    private static final int MAX_POINTS = 32;
    private static final double VEHICLE_SPEED_KMH = 12d;
    private static final double STOP_SPEED_KMH = 8d;
    private static final double MAX_CLUSTER_RADIUS_M = 60d;
    private static final double MAX_PARKING_ACCURACY_M = 75d;
    private static final long MAX_ENDPOINT_AGE_MS = 2 * 60_000L;
    private static final int HIGH_CONFIDENCE_SCORE = 75;
    private static final int MEDIUM_CONFIDENCE_SCORE = 50;

    private DriveSenseParkingResolver() {}

    static JSONObject resolve(JSONArray points, long endMs) {
        return resolve(points, endMs, null);
    }

    static JSONObject resolve(JSONArray points, long endMs, JSONObject signals) {
        if (points == null || points.length() == 0) return null;
        JSONObject rawEndpoint = points.optJSONObject(points.length() - 1);
        if (!isUsableEndpoint(rawEndpoint)) return null;
        long endpointMs = timestampMs(rawEndpoint);
        if (endpointMs > 0L && endMs > endpointMs && endMs - endpointMs > MAX_ENDPOINT_AGE_MS) {
            return null;
        }
        String transientStopReason = transientStopReason(points, signals);
        if (transientStopReason != null) {
            JSONObject ignored = new JSONObject();
            try {
                ignored.put("ignored_reason", transientStopReason);
            } catch (Exception error) {
                Log.w(TAG, "Could not resolve", error);
            }
            return ignored;
        }

        List<JSONObject> window = terminalWindow(points);
        if (window.isEmpty()) return null;
        List<JSONObject> cluster = terminalStopCluster(window);
        if (cluster.isEmpty()) cluster.add(rawEndpoint);
        JSONObject selected = recordedMedoid(cluster);
        if (selected == null) return null;

        double spreadM = 0d;
        for (JSONObject point : cluster) spreadM = Math.max(spreadM, distanceM(selected, point));
        long firstMs = timestampMs(cluster.get(0));
        long lastMs = timestampMs(cluster.get(cluster.size() - 1));
        long durationSeconds = firstMs > 0L && lastMs > 0L ? Math.max(0L, (lastMs - firstMs) / 1000L) : 0L;
        double accuracyM = accuracyM(selected);
        if (accuracyM > MAX_PARKING_ACCURACY_M) return null;
        double meanClusterAccuracyM = 0d;
        for (JSONObject point : cluster) meanClusterAccuracyM += accuracyM(point);
        meanClusterAccuracyM /= Math.max(1, cluster.size());
        boolean indoorEstimated = (signals != null && signals.optBoolean("indoor_mode", false)) ||
            accuracyM >= 30d ||
            meanClusterAccuracyM >= 35d;
        JSONObject scoringSignals;
        try {
            scoringSignals = signals != null ? new JSONObject(signals.toString()) : new JSONObject();
            scoringSignals.put("indoor_estimated", indoorEstimated);
        } catch (Exception ignored) {
            scoringSignals = signals;
        }
        JSONObject confidenceResult = scoreConfidence(
            points,
            cluster,
            selected,
            spreadM,
            durationSeconds,
            scoringSignals
        );
        JSONObject learningProfile = parkingLearningProfile(signals);
        if (
            signals != null &&
            !signals.optBoolean("manual_end", false) &&
            learningProfile.optInt("feedback_count", 0) > 0 &&
            !confirmedParkingExit(points, signals) &&
            confidenceResult.optInt("confidence_score", 0) <
                learningProfile.optInt("minimum_automatic_confidence", 40)
        ) {
            JSONObject ignored = new JSONObject();
            try {
                ignored.put("ignored_reason", "learned_low_confidence_stop");
                ignored.put("confidence_score", confidenceResult.optInt("confidence_score", 0));
                ignored.put(
                    "required_score",
                    learningProfile.optInt("minimum_automatic_confidence", 40)
                );
            } catch (Exception error) {
                Log.w(TAG, "Could not resolve", error);
            }
            return ignored;
        }

        JSONObject result = new JSONObject();
        try {
            result.put("lat", selected.optDouble("lat"));
            result.put("lng", selected.optDouble("lng"));
            result.put("timestamp_ms", endMs > 0L ? endMs : timestampMs(selected));
            result.put("accuracy_m", Math.round(accuracyM));
            result.put("confidence", confidenceResult.optString("confidence", "estimated"));
            result.put("confidence_score", confidenceResult.optInt("confidence_score", 0));
            result.put("evidence", confidenceResult.optJSONArray("evidence"));
            int refinementCount = confidenceResult.optInt("refinement_count", 0);
            result.put("strategy", refinementCount >= 3
                ? "post_stop_refinement"
                : cluster.size() > 1 ? "terminal_stop_cluster" : "last_trip_point");
            result.put("sample_count", cluster.size());
            result.put("refinement_count", refinementCount);
            result.put("spread_m", Math.round(spreadM));
            result.put("indoor_estimated", indoorEstimated);
            JSONObject garageEntrance = indoorEstimated
                ? findGarageEntrance(points, selected, cluster)
                : null;
            if (garageEntrance != null) result.put("garage_entrance", garageEntrance);
        } catch (Exception ignored) {
            return null;
        }
        return result;
    }

    private static JSONObject scoreConfidence(
        JSONArray sourcePoints,
        List<JSONObject> candidates,
        JSONObject selected,
        double spreadM,
        long durationSeconds,
        JSONObject signals
    ) {
        int score = 0;
        JSONArray evidence = new JSONArray();
        double accuracyM = accuracyM(selected);
        JSONObject endpoint = candidates.isEmpty() ? selected : candidates.get(candidates.size() - 1);
        double endpointSpeedKmh = endpoint != null
            ? endpoint.optDouble("speed_kmh", Double.NaN)
            : Double.NaN;
        int refinementCount = 0;
        for (JSONObject point : candidates) {
            if (point.optBoolean("parking_refinement", false)) refinementCount++;
        }

        if (accuracyM <= 10d) {
            score += 25;
            evidence.put("gps_accuracy_excellent");
        } else if (accuracyM <= 20d) {
            score += 20;
            evidence.put("gps_accuracy_good");
        } else if (accuracyM <= 40d) {
            score += 12;
            evidence.put("gps_accuracy_fair");
        } else {
            score += 4;
            evidence.put("gps_accuracy_weak");
        }

        if (candidates.size() >= 5) {
            score += 15;
            evidence.put("stable_fix_cluster");
        } else if (candidates.size() >= 3) {
            score += 12;
            evidence.put("multi_fix_cluster");
        } else if (candidates.size() >= 2) {
            score += 6;
            evidence.put("two_fix_cluster");
        } else {
            evidence.put("single_fix_only");
        }

        if (durationSeconds >= 20L) {
            score += 10;
            evidence.put("stop_observed_20s");
        } else if (durationSeconds >= 8L) {
            score += 5;
            evidence.put("stop_observed_8s");
        }

        if (spreadM <= 10d) {
            score += 15;
            evidence.put("gps_cluster_tight");
        } else if (spreadM <= 25d) {
            score += 10;
            evidence.put("gps_cluster_stable");
        } else if (spreadM <= 60d) {
            score += 3;
            evidence.put("gps_cluster_wide");
        } else {
            score -= 15;
            evidence.put("gps_cluster_unstable");
        }

        if (Double.isFinite(endpointSpeedKmh) && endpointSpeedKmh <= 2d) {
            score += 10;
            evidence.put("near_zero_speed");
        } else if (Double.isFinite(endpointSpeedKmh) && endpointSpeedKmh <= 5d) {
            score += 5;
            evidence.put("low_speed");
        } else if (Double.isFinite(endpointSpeedKmh) && endpointSpeedKmh > STOP_SPEED_KMH) {
            score -= 25;
            evidence.put("endpoint_still_moving");
        }

        long stoppedSeconds = signals != null ? Math.max(0L, signals.optLong("stopped_seconds", 0L)) : 0L;
        if (stoppedSeconds >= 90L) {
            score += 10;
            evidence.put("sustained_stop");
        } else if (stoppedSeconds >= 30L) {
            score += 5;
            evidence.put("stop_duration_support");
        }

        double observedMovingSpeedKmh = 0d;
        boolean obdWasRunning = false;
        double lastObdRpm = Double.NaN;
        for (int index = 0; index < sourcePoints.length(); index++) {
            JSONObject point = sourcePoints.optJSONObject(index);
            if (point == null) continue;
            observedMovingSpeedKmh = Math.max(
                observedMovingSpeedKmh,
                point.optDouble("speed_kmh", 0d)
            );
            if (point.has("obd_rpm") && !point.isNull("obd_rpm")) {
                lastObdRpm = point.optDouble("obd_rpm", Double.NaN);
                if (lastObdRpm >= 500d) obdWasRunning = true;
            }
        }
        double signalMovingSpeedKmh = signals != null
            ? signals.optDouble("last_moving_speed_kmh", 0d)
            : 0d;
        if (Math.max(observedMovingSpeedKmh, signalMovingSpeedKmh) >= VEHICLE_SPEED_KMH) {
            score += 5;
            evidence.put("vehicle_movement_before_stop");
        }

        String activityType = signals != null
            ? signals.optString("activity_type", "").toLowerCase()
            : "";
        int activityConfidence = signals != null
            ? Math.max(0, Math.min(100, signals.optInt("activity_confidence", 0)))
            : 0;
        if ("still".equals(activityType) && activityConfidence >= 70) {
            score += 10;
            evidence.put("activity_still");
        } else if (
            ("walking".equals(activityType) ||
                "running".equals(activityType) ||
                "on_foot".equals(activityType)) &&
            activityConfidence >= 75
        ) {
            score += 15;
            evidence.put("left_vehicle_on_foot");
        } else if ("in_vehicle".equals(activityType) && activityConfidence >= 65) {
            score += 4;
            evidence.put("activity_in_vehicle");
        }

        double gpsDriftM = signals != null
            ? signals.optDouble("gps_drift_m", Double.NaN)
            : Double.NaN;
        if (Double.isFinite(gpsDriftM) && gpsDriftM <= 8d) {
            score += 5;
            evidence.put("stop_drift_stable");
        }
        if (obdWasRunning && Double.isFinite(lastObdRpm) && lastObdRpm < 200d) {
            score += 15;
            evidence.put("obd_ignition_off");
        } else if (Double.isFinite(lastObdRpm) && lastObdRpm >= 500d) {
            evidence.put("obd_engine_running");
        }
        if (signals != null && signals.optBoolean("vehicle_disconnected", false)) {
            score += 15;
            evidence.put("vehicle_connection_disconnected");
        }
        if (signals != null && signals.optBoolean("vehicle_exit_transition", false)) {
            score += 15;
            evidence.put("activity_vehicle_exit_transition");
        }
        JSONObject learningProfile = parkingLearningProfile(signals);
        if (learningProfile.optInt("feedback_count", 0) > 0) {
            evidence.put("personalized_parking_learning");
            int strictness = learningProfile.optInt("strictness_level", 0);
            if (strictness > 0 && !confirmedParkingExit(sourcePoints, signals)) {
                score -= strictness * 4;
            }
        }
        if (signals != null && signals.optBoolean("indoor_estimated", false)) {
            score -= 8;
            evidence.put("indoor_location_estimated");
        }
        if (refinementCount >= 3) {
            score += 10;
            evidence.put("post_stop_refinement");
        } else if (refinementCount > 0) {
            score += 4;
            evidence.put("post_stop_refinement_partial");
        }
        if (signals != null && signals.optBoolean("manual_end", false)) {
            evidence.put("manual_trip_end");
        } else if (signals != null && !signals.optString("stop_reason", "").trim().isEmpty()) {
            String reason = signals.optString("stop_reason", "").toLowerCase();
            evidence.put(reason.contains("park") || reason.contains("still")
                ? "trip_end_parking_stop"
                : "trip_end_reason_observed");
        }

        int normalizedScore = Math.max(0, Math.min(100, score));
        String confidence = normalizedScore >= HIGH_CONFIDENCE_SCORE
            ? "high"
            : normalizedScore >= MEDIUM_CONFIDENCE_SCORE ? "medium" : "estimated";
        JSONObject result = new JSONObject();
        try {
            result.put("confidence", confidence);
            result.put("confidence_score", normalizedScore);
            result.put("evidence", evidence);
            result.put("refinement_count", refinementCount);
        } catch (Exception error) {
            Log.w(TAG, "Could not resolve", error);
        }
        return result;
    }

    private static String transientStopReason(JSONArray points, JSONObject signals) {
        if (signals == null || signals.optBoolean("manual_end", false)) return null;
        String activityType = signals.optString("activity_type", "").toLowerCase();
        int activityConfidence = Math.max(0, Math.min(100, signals.optInt("activity_confidence", 0)));
        long stoppedSeconds = Math.max(0L, signals.optLong("stopped_seconds", 0L));
        JSONObject learningProfile = parkingLearningProfile(signals);

        boolean obdWasRunning = false;
        double lastObdRpm = Double.NaN;
        int stopped = 0;
        int creeping = 0;
        int transitions = 0;
        String previousBand = "";
        int start = Math.max(0, points.length() - 20);
        for (int index = 0; index < points.length(); index++) {
            JSONObject point = points.optJSONObject(index);
            if (point == null) continue;
            if (point.has("obd_rpm") && !point.isNull("obd_rpm")) {
                lastObdRpm = point.optDouble("obd_rpm", Double.NaN);
                if (lastObdRpm >= 500d) obdWasRunning = true;
            }
            if (index < start) continue;
            double speed = point.optDouble("speed_kmh", Double.NaN);
            if (!Double.isFinite(speed)) continue;
            String band = speed <= 0.8d ? "stopped" : speed <= 8d ? "creeping" : "moving";
            if ("stopped".equals(band)) stopped++;
            if ("creeping".equals(band)) creeping++;
            if (!previousBand.isEmpty() && !previousBand.equals(band)) transitions++;
            previousBand = band;
        }
        boolean ignitionOff = obdWasRunning && Double.isFinite(lastObdRpm) && lastObdRpm < 200d;
        if (confirmedParkingExit(points, signals) || ignitionOff) return null;
        if (stopped >= 2 && creeping >= 3 && transitions >= 4 && stoppedSeconds > 0L && stoppedSeconds < 300L) {
            return "possible_drive_through";
        }
        if (Double.isFinite(lastObdRpm) && lastObdRpm >= 500d && stoppedSeconds >= 30L && stoppedSeconds < 900L) {
            return "possible_fuel_or_engine_on_stop";
        }
        if (
            "in_vehicle".equals(activityType) &&
            activityConfidence >= 70 &&
            stoppedSeconds > 0L &&
            stoppedSeconds < learningProfile.optLong("in_vehicle_stop_max_seconds", 120L)
        ) {
            return "possible_traffic_or_dropoff_stop";
        }
        if (
            stoppedSeconds > 0L &&
            stoppedSeconds < learningProfile.optLong("short_stop_max_seconds", 45L)
        ) return "short_stop";
        return null;
    }

    private static JSONObject parkingLearningProfile(JSONObject signals) {
        JSONObject profile = signals != null ? signals.optJSONObject("parking_learning_profile") : null;
        return profile != null ? profile : new JSONObject();
    }

    private static boolean confirmedParkingExit(JSONArray points, JSONObject signals) {
        if (signals == null) return false;
        if (
            signals.optBoolean("vehicle_exit_transition", false) ||
            signals.optBoolean("vehicle_disconnected", false)
        ) return true;
        String activityType = signals.optString("activity_type", "").toLowerCase();
        int activityConfidence = Math.max(0, Math.min(100, signals.optInt("activity_confidence", 0)));
        if (
            ("walking".equals(activityType) ||
                "running".equals(activityType) ||
                "on_foot".equals(activityType)) &&
            activityConfidence >= 75
        ) return true;
        boolean obdWasRunning = false;
        double lastObdRpm = Double.NaN;
        for (int index = 0; index < points.length(); index++) {
            JSONObject point = points.optJSONObject(index);
            if (point == null || !point.has("obd_rpm") || point.isNull("obd_rpm")) continue;
            lastObdRpm = point.optDouble("obd_rpm", Double.NaN);
            if (lastObdRpm >= 500d) obdWasRunning = true;
        }
        return obdWasRunning && Double.isFinite(lastObdRpm) && lastObdRpm < 200d;
    }

    private static JSONObject findGarageEntrance(
        JSONArray sourcePoints,
        JSONObject selected,
        List<JSONObject> candidates
    ) {
        long clusterStartMs = candidates.isEmpty() ? 0L : timestampMs(candidates.get(0));
        JSONObject entrance = null;
        for (int index = 0; index < sourcePoints.length(); index++) {
            JSONObject point = sourcePoints.optJSONObject(index);
            if (!isValidCoordinate(point) ||
                point.optBoolean("masked_for_privacy", false) ||
                point.optBoolean("privacy_gap", false) ||
                point.optBoolean("privacy_live_redacted", false) ||
                accuracyM(point) > 20d ||
                (clusterStartMs > 0L && timestampMs(point) > clusterStartMs) ||
                distanceM(point, selected) > 300d) {
                continue;
            }
            entrance = point;
        }
        if (entrance == null) return null;
        JSONObject result = new JSONObject();
        try {
            result.put("lat", entrance.optDouble("lat"));
            result.put("lng", entrance.optDouble("lng"));
            result.put("accuracy_m", Math.round(accuracyM(entrance)));
        } catch (Exception ignored) {
            return null;
        }
        return result;
    }

    private static List<JSONObject> terminalWindow(JSONArray points) {
        List<JSONObject> valid = new ArrayList<>();
        for (int index = 0; index < points.length(); index++) {
            JSONObject point = points.optJSONObject(index);
            if (isValidCoordinate(point)) valid.add(point);
        }
        if (valid.isEmpty()) return valid;
        long endpointMs = timestampMs(valid.get(valid.size() - 1));
        List<JSONObject> recent = new ArrayList<>();
        for (JSONObject point : valid) {
            long pointMs = timestampMs(point);
            if (endpointMs <= 0L || pointMs <= 0L || endpointMs - pointMs <= MAX_WINDOW_MS) recent.add(point);
        }
        if (recent.size() <= MAX_POINTS) return recent;
        return new ArrayList<>(recent.subList(recent.size() - MAX_POINTS, recent.size()));
    }

    private static List<JSONObject> terminalStopCluster(List<JSONObject> window) {
        int lastVehicleIndex = -1;
        for (int index = 0; index < window.size(); index++) {
            JSONObject point = window.get(index);
            if (point.optDouble("speed_kmh", 0d) >= VEHICLE_SPEED_KMH && accuracyM(point) <= 60d) {
                lastVehicleIndex = index;
            }
        }

        List<JSONObject> cluster = new ArrayList<>();
        if (lastVehicleIndex >= 0 && lastVehicleIndex < window.size() - 1) {
            JSONObject anchor = null;
            for (int index = lastVehicleIndex + 1; index < window.size(); index++) {
                JSONObject point = window.get(index);
                if (accuracyM(point) > 50d) continue;
                double speed = point.optDouble("speed_kmh", 0d);
                if (speed > STOP_SPEED_KMH) {
                    if (!cluster.isEmpty()) break;
                    continue;
                }
                if (anchor == null) anchor = point;
                if (distanceM(anchor, point) > MAX_CLUSTER_RADIUS_M) break;
                cluster.add(point);
            }
            if (!cluster.isEmpty()) return cluster;
        }

        JSONObject endpoint = window.get(window.size() - 1);
        for (int index = Math.max(0, window.size() - 8); index < window.size(); index++) {
            JSONObject point = window.get(index);
            if (point.optDouble("speed_kmh", 0d) <= STOP_SPEED_KMH && distanceM(endpoint, point) <= MAX_CLUSTER_RADIUS_M) {
                cluster.add(point);
            }
        }
        return cluster;
    }

    private static JSONObject recordedMedoid(List<JSONObject> points) {
        JSONObject best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (JSONObject candidate : points) {
            double score = accuracyM(candidate) * 0.35d;
            for (JSONObject point : points) score += Math.min(200d, distanceM(candidate, point));
            if (score < bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        return best;
    }

    private static boolean isUsableEndpoint(JSONObject point) {
        return point != null &&
            !point.optBoolean("masked_for_privacy", false) &&
            !point.optBoolean("privacy_gap", false) &&
            !point.optBoolean("privacy_live_redacted", false) &&
            isValidCoordinate(point);
    }

    private static boolean isValidCoordinate(JSONObject point) {
        if (point == null || point.isNull("lat") || point.isNull("lng")) return false;
        double lat = point.optDouble("lat", Double.NaN);
        double lng = point.optDouble("lng", Double.NaN);
        return Double.isFinite(lat) && Double.isFinite(lng) &&
            Math.abs(lat) <= 90d && Math.abs(lng) <= 180d &&
            !(lat == 0d && lng == 0d);
    }

    private static double accuracyM(JSONObject point) {
        double value = point != null ? point.optDouble("accuracy", 100d) : 100d;
        return Double.isFinite(value) && value >= 0d ? value : 100d;
    }

    private static long timestampMs(JSONObject point) {
        try {
            return Instant.parse(point != null ? point.optString("timestamp", "") : "").toEpochMilli();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static double distanceM(JSONObject first, JSONObject second) {
        float[] result = new float[1];
        Location.distanceBetween(
            first.optDouble("lat"), first.optDouble("lng"),
            second.optDouble("lat"), second.optDouble("lng"),
            result
        );
        return result[0];
    }
}

