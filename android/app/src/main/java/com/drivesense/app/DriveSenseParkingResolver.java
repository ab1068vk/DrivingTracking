package com.drivesense.app;

import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Selects a robust, recorded GPS fix from the terminal stop rather than trusting one noisy point. */
final class DriveSenseParkingResolver {
    private static final long MAX_WINDOW_MS = 5 * 60_000L;
    private static final int MAX_POINTS = 32;
    private static final double VEHICLE_SPEED_KMH = 12d;
    private static final double STOP_SPEED_KMH = 8d;
    private static final double MAX_CLUSTER_RADIUS_M = 60d;

    private DriveSenseParkingResolver() {}

    static JSONObject resolve(JSONArray points, long endMs) {
        if (points == null || points.length() == 0) return null;
        JSONObject rawEndpoint = points.optJSONObject(points.length() - 1);
        if (!isUsableEndpoint(rawEndpoint)) return null;

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
        String confidence = cluster.size() >= 3 && durationSeconds >= 20L && spreadM <= 25d && accuracyM <= 20d
            ? "high"
            : cluster.size() >= 2 && spreadM <= 60d && accuracyM <= 40d ? "medium" : "estimated";

        JSONObject result = new JSONObject();
        try {
            result.put("lat", selected.optDouble("lat"));
            result.put("lng", selected.optDouble("lng"));
            result.put("timestamp_ms", endMs > 0L ? endMs : timestampMs(selected));
            result.put("accuracy_m", Math.round(accuracyM));
            result.put("confidence", confidence);
            result.put("strategy", cluster.size() > 1 ? "terminal_stop_cluster" : "last_trip_point");
            result.put("sample_count", cluster.size());
            result.put("spread_m", Math.round(spreadM));
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

