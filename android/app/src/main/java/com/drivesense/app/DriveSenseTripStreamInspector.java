package com.drivesense.app;

import android.content.Context;
import android.util.JsonReader;
import android.util.JsonToken;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

/**
 * Extracts bounded catalog/display metadata and a privacy-safe overview without
 * materialising the full trip document. The original admitted spool remains
 * the canonical plaintext byte stream; this reader is validation/derivation.
 */
final class DriveSenseTripStreamInspector {
    private static final int INPUT_BUFFER_BYTES = 64 * 1024;
    private static final int DISPLAY_BYTES = 96 * 1024;
    private static final int FIELD_BYTES = 8 * 1024;
    private static final int MAX_DEPTH = 12;
    private static final Set<String> PAYLOAD_FIELDS = new HashSet<>();
    static {
        String[] names = {"route_points", "points", "driving_events", "sensor_samples",
            "motion_samples", "obd_samples", "raw_gps", "route_geometry",
            "accelerometer_samples", "gyroscope_samples"};
        java.util.Collections.addAll(PAYLOAD_FIELDS, names);
    }

    private DriveSenseTripStreamInspector() {}

    static Result inspect(Context context, File source, String expectedTripId) throws Exception {
        JSONObject display = new JSONObject();
        OverviewAccumulator overview = new OverviewAccumulator(context);
        long routeCount = 0L;
        // AUD-005 restart discovery. Whether this trip carries an unacknowledged emergency
        // workflow is derived HERE, from the trip bytes being written, so the manifest and
        // the durable index can answer "is any emergency work outstanding" boundedly at
        // startup. It is not a second source of truth: it is derived from the same bytes
        // at the same moment, and the acknowledgement rewrite re-derives it.
        boolean[] emergencyPending = { false };
        try (JsonReader reader = new JsonReader(new InputStreamReader(
            new BufferedInputStream(new FileInputStream(source), INPUT_BUFFER_BYTES),
            StandardCharsets.UTF_8))) {
            reader.setLenient(false);
            reader.beginObject();
            while (reader.hasNext()) {
                String name = reader.nextName();
                if ("route_points".equals(name) || "points".equals(name)) {
                    routeCount += readRoute(reader, overview);
                } else if ("driving_events".equals(name)) {
                    // Streamed, never materialised: one pass that only looks for the flag.
                    scanDrivingEventsForEmergency(reader, emergencyPending);
                } else if (isPayloadField(name)) {
                    reader.skipValue();
                } else {
                    Object value = readBoundedValue(reader, 0, new Budget(FIELD_BYTES));
                    if (value != Omitted.VALUE && display.toString().getBytes(StandardCharsets.UTF_8).length < DISPLAY_BYTES) {
                        display.put(name, value);
                    }
                }
            }
            reader.endObject();
            if (reader.peek() != JsonToken.END_DOCUMENT) throw new IllegalArgumentException("Trailing trip JSON content");
        }

        String tripId = String.valueOf(display.opt("id") == null ? "" : display.opt("id")).trim();
        if (tripId.isEmpty() || !tripId.equals(expectedTripId)) throw new SecurityException("Trip identity mismatch");
        normalize(display, routeCount);
        // A trip-level pending flag counts the same as an event-level one.
        if (display.optBoolean("emergency_workflow_pending", false)) emergencyPending[0] = true;
        byte[] overviewBytes = overview.finish(tripId);
        return new Result(display, overviewBytes, overview.pointCount(), routeCount,
            INPUT_BUFFER_BYTES, FIELD_BYTES, DISPLAY_BYTES, emergencyPending[0]);
    }

    /**
     * One streaming pass over `driving_events` looking only for an unacknowledged
     * emergency workflow. Nothing is retained: the reader walks the array and the only
     * state kept is one boolean.
     */
    private static void scanDrivingEventsForEmergency(JsonReader reader, boolean[] pending) throws Exception {
        if (reader.peek() == JsonToken.NULL) { reader.nextNull(); return; }
        if (reader.peek() != JsonToken.BEGIN_ARRAY) { reader.skipValue(); return; }
        reader.beginArray();
        while (reader.hasNext()) {
            if (reader.peek() != JsonToken.BEGIN_OBJECT) { reader.skipValue(); continue; }
            reader.beginObject();
            while (reader.hasNext()) {
                String field = reader.nextName();
                if (!"emergency_workflow_pending".equals(field)) { reader.skipValue(); continue; }
                if (reader.peek() == JsonToken.BOOLEAN) {
                    if (reader.nextBoolean()) pending[0] = true;
                } else {
                    reader.skipValue();
                }
            }
            reader.endObject();
        }
        reader.endArray();
    }

    private static boolean isPayloadField(String name) {
        String normalized = name == null ? "" : name.toLowerCase(java.util.Locale.ROOT);
        if (PAYLOAD_FIELDS.contains(normalized)) return true;
        return normalized.contains("sensor_samples") || normalized.contains("obd_samples") ||
            normalized.contains("raw_gps") || normalized.contains("route_geometry");
    }

    private static long readRoute(JsonReader reader, OverviewAccumulator overview) throws Exception {
        if (reader.peek() == JsonToken.NULL) { reader.nextNull(); return 0L; }
        if (reader.peek() != JsonToken.BEGIN_ARRAY) { reader.skipValue(); return 0L; }
        long count = 0L;
        reader.beginArray();
        while (reader.hasNext()) {
            count += 1L;
            if (reader.peek() != JsonToken.BEGIN_OBJECT) { reader.skipValue(); continue; }
            double lat = Double.NaN, lng = Double.NaN;
            Object timestamp = null, time = null;
            reader.beginObject();
            while (reader.hasNext()) {
                String name = reader.nextName();
                if ("lat".equals(name) || "latitude".equals(name)) lat = readDouble(reader);
                else if ("lng".equals(name) || "longitude".equals(name)) lng = readDouble(reader);
                else if ("timestamp".equals(name)) timestamp = readScalar(reader);
                else if ("time".equals(name)) time = readScalar(reader);
                else reader.skipValue();
            }
            reader.endObject();
            overview.accept(lat, lng, timestamp, time);
        }
        reader.endArray();
        return count;
    }

    private static Object readBoundedValue(JsonReader reader, int depth, Budget budget) throws Exception {
        if (depth > MAX_DEPTH || budget.exhausted()) { reader.skipValue(); return Omitted.VALUE; }
        JsonToken token = reader.peek();
        switch (token) {
            case NULL: reader.nextNull(); budget.add(4); return JSONObject.NULL;
            case BOOLEAN: boolean bool = reader.nextBoolean(); budget.add(5); return bool;
            case NUMBER:
                String number = reader.nextString(); budget.add(number.length());
                try { return Long.valueOf(number); } catch (Exception ignored) {
                    try { return Double.valueOf(number); } catch (Exception invalid) { return number; }
                }
            case STRING:
                String text = reader.nextString(); budget.add(text.getBytes(StandardCharsets.UTF_8).length);
                return budget.exhausted() ? Omitted.VALUE : text;
            case BEGIN_ARRAY:
                JSONArray array = new JSONArray(); reader.beginArray();
                while (reader.hasNext()) {
                    Object value = readBoundedValue(reader, depth + 1, budget);
                    if (value != Omitted.VALUE && !budget.exhausted()) array.put(value);
                }
                reader.endArray(); return budget.exhausted() ? Omitted.VALUE : array;
            case BEGIN_OBJECT:
                JSONObject object = new JSONObject(); reader.beginObject();
                while (reader.hasNext()) {
                    String name = reader.nextName(); budget.add(name.length());
                    Object value = readBoundedValue(reader, depth + 1, budget);
                    if (value != Omitted.VALUE && !budget.exhausted()) object.put(name, value);
                }
                reader.endObject(); return budget.exhausted() ? Omitted.VALUE : object;
            default: reader.skipValue(); return Omitted.VALUE;
        }
    }

    private static Object readScalar(JsonReader reader) throws Exception {
        JsonToken token = reader.peek();
        if (token == JsonToken.NULL) { reader.nextNull(); return null; }
        if (token == JsonToken.BOOLEAN) return reader.nextBoolean();
        if (token == JsonToken.NUMBER || token == JsonToken.STRING) return reader.nextString();
        reader.skipValue(); return null;
    }

    private static double readDouble(JsonReader reader) throws Exception {
        JsonToken token = reader.peek();
        if (token == JsonToken.NUMBER || token == JsonToken.STRING) {
            try { return Double.parseDouble(reader.nextString()); } catch (Exception ignored) { return Double.NaN; }
        }
        reader.skipValue(); return Double.NaN;
    }

    private static void normalize(JSONObject display, long routeCount) throws Exception {
        display.put("start_time_ms", timeMs(display.opt("start_time")));
        display.put("end_time_ms", timeMs(display.opt("end_time")));
        display.put("status", display.optString("status", "completed"));
        display.put("vehicle_id", display.optString("vehicle_id", display.optString("vehicleId", "")));
        display.put("point_count", routeCount > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int)routeCount);
        display.put("distance", display.optDouble("distance", display.optDouble("distance_km", 0)));
        display.put("duration", display.optDouble("duration", display.optDouble("duration_seconds", 0)));
        if (display.has("score_overall")) display.put("score", display.opt("score_overall"));
        display.put("score_status", display.optString("score_status", ""));
        display.put("needs_rescore", display.optBoolean("needs_rescore", false));
    }

    private static long timeMs(Object value) {
        if (value instanceof Number) return ((Number)value).longValue();
        String text = value == null ? "" : String.valueOf(value);
        if (text.isEmpty()) return 0L;
        try { return Instant.parse(text).toEpochMilli(); }
        catch (Exception ignored) { try { return Long.parseLong(text); } catch (Exception invalid) { return 0L; } }
    }

    private enum Omitted { VALUE }
    private static final class Budget {
        final int maximum; int used;
        Budget(int maximum) { this.maximum = maximum; }
        void add(int bytes) { used += Math.max(0, bytes); }
        boolean exhausted() { return used > maximum; }
    }

    private static final class OverviewAccumulator {
        private final Context context;
        private final java.util.ArrayList<JSONObject> points = new java.util.ArrayList<>(DriveSenseTripOverviewBuilder.MAX_POINTS);
        private long eligible;
        private int stride = 1;
        private boolean privacyGap;
        OverviewAccumulator(Context context) { this.context = context.getApplicationContext(); }
        void accept(double lat, double lng, Object timestamp, Object time) throws Exception {
            if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
            if (PrivacyZoneChecker.isInsidePrivacyZone(context, lat, lng)) { privacyGap = true; return; }
            long index = eligible++;
            if (index % stride != 0) return;
            JSONObject point = new JSONObject(); point.put("lat", lat); point.put("lng", lng);
            if (timestamp != null) point.put("timestamp", timestamp);
            if (time != null) point.put("time", time);
            if (privacyGap) { point.put("privacy_gap_before", true); privacyGap = false; }
            points.add(point);
            if (points.size() >= DriveSenseTripOverviewBuilder.MAX_POINTS) compact();
        }
        private void compact() {
            for (int write = 1, read = 2; read < points.size(); write += 1, read += 2) points.set(write, points.get(read));
            int keep = (points.size() + 1) / 2;
            while (points.size() > keep) points.remove(points.size() - 1);
            stride = Math.min(Integer.MAX_VALUE / 2, stride * 2);
        }
        byte[] finish(String tripId) throws Exception {
            JSONArray array = new JSONArray(); for (JSONObject point : points) array.put(point);
            JSONObject envelope = new JSONObject(); envelope.put("schemaVersion", 1); envelope.put("tripId", tripId); envelope.put("points", array);
            byte[] bytes = envelope.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > DriveSenseTripOverviewBuilder.MAX_PLAINTEXT_BYTES) throw new IllegalStateException("Overview exceeds frozen byte ceiling");
            return bytes;
        }
        int pointCount() { return points.size(); }
    }

    static final class Result {
        final JSONObject display; final byte[] overviewBytes; final int overviewPoints;
        final long routePointCount; final int sourceBufferBytes, fieldBufferBytes, displayBufferBytes;
        /** AUD-005: this trip carries an unacknowledged emergency workflow. */
        final boolean emergencyPending;
        Result(JSONObject display, byte[] overviewBytes, int overviewPoints, long routePointCount,
               int sourceBufferBytes, int fieldBufferBytes, int displayBufferBytes,
               boolean emergencyPending) {
            this.display=display; this.overviewBytes=overviewBytes; this.overviewPoints=overviewPoints;
            this.routePointCount=routePointCount; this.sourceBufferBytes=sourceBufferBytes;
            this.fieldBufferBytes=fieldBufferBytes; this.displayBufferBytes=displayBufferBytes;
            this.emergencyPending=emergencyPending;
        }
    }
}
