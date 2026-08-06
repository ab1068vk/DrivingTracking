package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class PrivacyZoneChecker {
    static final String PRIVACY_ZONES_KEY = "privacy_zones_v1";
    private static final String TAG = "PrivacyZone";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String DRIVE_SENSE_SETTINGS_PREFS = "DriveSenseSettings";
    private static final String SETTINGS_KEY = "drivesense_settings";
    private static final String PRIVACY_ZONES_CONTEXT = "native:privacy_zones_v1";
    static final String PRIVACY_CELL_KEY_KEY = "privacy_cell_key_v1";
    private static final String PRIVACY_CELL_KEY_CONTEXT = "native:privacy_cell_key_v1";
    // Keyed cells (HMAC-SHA-256 under the device cell key) are written as pzc2_;
    // pzc_ is the older unkeyed scheme, still matched so a zone that has not been
    // re-keyed yet keeps working. Both must agree with src/lib/privacyCellKey.js.
    private static final String KEYED_CELL_HASH_PREFIX = "pzc2_";
    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final int KEYED_CELL_HASH_BYTES = 8;
    private static final double GUARD_METERS = 50.0d;
    private static final double EARTH_RADIUS_M = 6371000.0d;
    // Must match PRIVACY_CELL_SIZE_M in src/lib/privacyZones.js. A mismatch makes
    // every cell hash miss, which would fail open.
    private static final double DEFAULT_PRIVACY_CELL_SIZE_M = 50.0d;
    private static final String[] KINEMATIC_FIELDS = new String[] {
        "speed",
        "speed_kmh",
        "speedKmh",
        "speed_mps",
        "speedMps",
        "speed_accuracy",
        "speedAccuracy",
        "obd_speed_kmh",
        "heading",
        "heading_accuracy",
        "headingAccuracy",
        "bearing",
        "bearing_accuracy",
        "bearingAccuracy",
        "course",
        "altitude",
        "altitude_m",
        "altitude_accuracy",
        "altitudeAccuracy",
        "vertical_speed",
        "verticalSpeed",
        "vertical_accuracy",
        "verticalAccuracy",
        "accuracy",
        "horizontal_accuracy",
        "horizontalAccuracy",
        "accel_ms2",
        "acceleration_ms2",
        "acceleration_x",
        "acceleration_y",
        "acceleration_z",
        "accelerationX",
        "accelerationY",
        "accelerationZ"
    };

    private PrivacyZoneChecker() {}

    private static final class ZoneReadResult {
        final JSONArray zones;
        final boolean failClosed;

        ZoneReadResult(JSONArray zones, boolean failClosed) {
            this.zones = zones != null ? zones : new JSONArray();
            this.failClosed = failClosed;
        }
    }

    private static final class ZoneParseResult {
        final JSONArray zones;
        final boolean present;
        final boolean failed;

        ZoneParseResult(JSONArray zones, boolean present, boolean failed) {
            this.zones = zones != null ? zones : new JSONArray();
            this.present = present;
            this.failed = failed;
        }
    }

    static boolean isInsidePrivacyZone(Context context, double lat, double lng) {
        return findPrivacyZone(context, lat, lng) != null;
    }

    static JSONObject findPrivacyZone(Context context, double lat, double lng) {
        if (!isValidCoordinate(lat, lng)) return null;

        ZoneReadResult zoneRead = getPrivacyZoneReadResult(context);
        if (zoneRead.failClosed) return failClosedZone();

        JSONArray zones = zoneRead.zones;
        byte[] cellKey = readCellKey(context);
        for (int i = 0; i < zones.length(); i++) {
            JSONObject zone = zones.optJSONObject(i);
            if (zone == null) continue;
            if (isExpired(zone, System.currentTimeMillis())) continue;

            double zoneLat = firstFinite(zone, "lat", "latitude");
            double zoneLng = firstFinite(zone, "lng", "longitude");
            double zoneRadiusM = firstFinite(zone, "radius_m", "radius");
            if (!isValidCoordinate(zoneLat, zoneLng) || !Double.isFinite(zoneRadiusM) || zoneRadiusM <= 0d) {
                if (isInsidePrivacyCellZone(lat, lng, zone, GUARD_METERS, cellKey)) {
                    return zone;
                }
                continue;
            }

            float[] distanceM = new float[1];
            Location.distanceBetween(lat, lng, zoneLat, zoneLng, distanceM);
            if (distanceM[0] <= zoneRadiusM + GUARD_METERS) {
                return zone;
            }
        }
        return null;
    }

    static JSONArray redactRoutePoints(Context context, JSONArray points) {
        JSONArray redactedPoints = new JSONArray();
        if (points == null) return redactedPoints;

        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;

            JSONObject zone = findPrivacyZone(
                context,
                point.optDouble("lat", Double.NaN),
                point.optDouble("lng", Double.NaN)
            );
            if (zone == null) {
                redactedPoints.put(point);
                continue;
            }

            JSONObject redacted = redactCoordinates(point, zone, false);
            if (redacted != null) redactedPoints.put(redacted);
        }

        return redactedPoints;
    }

    /**
     * Redact one driving event that happened inside a privacy zone. Incident
     * events carry the coordinates of the fix that produced them, so they need
     * the same guard as route points before being checkpointed or journalled.
     */
    static JSONObject redactEvent(Context context, JSONObject event) {
        if (event == null) return null;
        JSONObject zone = findPrivacyZone(
            context,
            event.optDouble("lat", Double.NaN),
            event.optDouble("lng", Double.NaN)
        );
        if (zone == null) return event;

        JSONObject redacted = redactCoordinates(event, zone, true);
        return redacted != null ? redacted : event;
    }

    static JSONArray redactEvents(Context context, JSONArray events) {
        JSONArray redactedEvents = new JSONArray();
        if (events == null) return redactedEvents;

        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.optJSONObject(i);
            if (event == null) continue;
            JSONObject redacted = redactEvent(context, event);
            if (redacted != null) redactedEvents.put(redacted);
        }
        return redactedEvents;
    }

    private static JSONObject redactCoordinates(JSONObject source, JSONObject zone, boolean asEvent) {
        try {
            JSONObject redacted = new JSONObject(source.toString());
            redacted.remove("lat");
            redacted.remove("lng");
            redacted.remove("latitude");
            redacted.remove("longitude");
            redacted.remove("original_lat");
            redacted.remove("original_lng");
            redacted.remove("matched_lat");
            redacted.remove("matched_lng");
            redacted.put("lat", JSONObject.NULL);
            redacted.put("lng", JSONObject.NULL);
            nullKinematicFields(redacted);
            applyPrivacyMarkers(redacted, zone, asEvent);
            return redacted;
        } catch (Exception error) {
            JSONObject placeholder = new JSONObject();
            try {
                placeholder.put("lat", JSONObject.NULL);
                placeholder.put("lng", JSONObject.NULL);
                placeholder.put("timestamp", source.optString("timestamp", ""));
                if (asEvent) placeholder.put("type", source.optString("type", ""));
                nullKinematicFields(placeholder);
                applyPrivacyMarkers(placeholder, zone, asEvent);
                return placeholder;
            } catch (Exception placeholderError) {
                Log.w(TAG, "Could not build privacy placeholder", placeholderError);
                return null;
            }
        }
    }

    private static void applyPrivacyMarkers(JSONObject target, JSONObject zone, boolean asEvent)
        throws org.json.JSONException {
        target.put("masked_for_privacy", true);
        if (asEvent) {
            // Matches maskEventCoordinatesForPrivacy in src/lib/privacyZones.js.
            target.put("privacy_event_redacted", true);
        } else {
            target.put("privacy_gap", true);
            target.put("privacy_live_redacted", true);
        }
        target.put("privacy_zone_id", zone.optString("id", ""));
        target.put("privacy_zone_label", zone.optString("label", "Private place"));
    }

    private static ZoneReadResult getPrivacyZoneReadResult(Context context) {
        ZoneParseResult mirroredZones = parseZoneArray(readString(context, CAPACITOR_PREFS, PRIVACY_ZONES_KEY));
        if (mirroredZones.zones.length() > 0) return new ZoneReadResult(mirroredZones.zones, false);
        if (mirroredZones.present && mirroredZones.failed) return failClosedReadResult("Privacy zone mirror unreadable");

        ZoneParseResult legacyMirroredZones = parseZoneArray(readString(context, DRIVE_SENSE_SETTINGS_PREFS, PRIVACY_ZONES_KEY));
        if (legacyMirroredZones.zones.length() > 0) return new ZoneReadResult(legacyMirroredZones.zones, false);
        if (legacyMirroredZones.present && legacyMirroredZones.failed) return failClosedReadResult("Legacy privacy zone mirror unreadable");

        try {
            String rawSettings = readString(context, CAPACITOR_PREFS, SETTINGS_KEY);
            if (rawSettings == null || rawSettings.trim().isEmpty()) {
                return new ZoneReadResult(new JSONArray(), false);
            }
            JSONObject settings = new JSONObject(rawSettings);
            JSONArray settingsZones = settings.optJSONArray("privacy_zones");
            if (settingsZones == null || settingsZones.length() == 0) {
                return new ZoneReadResult(new JSONArray(), false);
            }
            if (hasUsableZoneGuard(settingsZones)) {
                return new ZoneReadResult(settingsZones, false);
            }
            return failClosedReadResult("Privacy zones configured without native geometry mirror");
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone settings parse failed", error);
            return failClosedReadResult("Privacy zone settings unreadable");
        }
    }

    private static ZoneParseResult parseZoneArray(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return new ZoneParseResult(new JSONArray(), false, false);
        }
        try {
            String text = raw.trim();
            if (DriveSensePayloadCrypto.isEncryptedStoredValue(text)) {
                return new ZoneParseResult(
                    new JSONArray(DriveSensePayloadCrypto.decryptStoredValue(text, PRIVACY_ZONES_CONTEXT)),
                    true,
                    false
                );
            }
            if (text.startsWith("{")) {
                JSONObject payload = new JSONObject(text);
                if (payload.optBoolean("encrypted", false) && payload.has("ciphertext")) {
                    return new ZoneParseResult(
                        new JSONArray(DriveSensePayloadCrypto.decrypt(
                            payload.getString("ciphertext"),
                            PRIVACY_ZONES_CONTEXT,
                            payload.optInt("key_version", 0)
                        )),
                        true,
                        false
                    );
                }
            }
            return new ZoneParseResult(new JSONArray(text), true, false);
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone mirror parse failed", error);
            return new ZoneParseResult(new JSONArray(), true, true);
        }
    }

    private static ZoneReadResult failClosedReadResult(String reason) {
        Log.w(TAG, reason + "; native GPS will be treated as private until zones sync.");
        return new ZoneReadResult(new JSONArray(), true);
    }

    private static JSONObject failClosedZone() {
        JSONObject zone = new JSONObject();
        try {
            zone.put("id", "native_privacy_sync_unavailable");
            zone.put("label", "Private place");
        } catch (Exception error) {
            Log.w(TAG, "Could not fail closed zone", error);
        }
        return zone;
    }

    private static boolean hasUsableZoneGuard(JSONArray zones) {
        if (zones == null) return false;
        for (int i = 0; i < zones.length(); i++) {
            JSONObject zone = zones.optJSONObject(i);
            if (zone == null) continue;
            double zoneLat = firstFinite(zone, "lat", "latitude");
            double zoneLng = firstFinite(zone, "lng", "longitude");
            double zoneRadiusM = firstFinite(zone, "radius_m", "radius");
            if (isValidCoordinate(zoneLat, zoneLng) &&
                Double.isFinite(zoneRadiusM) &&
                zoneRadiusM > 0d) {
                return true;
            }
            if (hasUsableCellGeometry(zone)) return true;
        }
        return false;
    }

    private static boolean hasUsableCellGeometry(JSONObject zone) {
        JSONArray hashes = zone.optJSONArray("privacy_cell_hashes");
        return hashes != null && hashes.length() > 0;
    }

    static boolean isInsidePrivacyCellZone(double lat, double lng, JSONObject zone, double guardMeters) {
        return isInsidePrivacyCellZone(lat, lng, zone, guardMeters, null);
    }

    static boolean isInsidePrivacyCellZone(
        double lat,
        double lng,
        JSONObject zone,
        double guardMeters,
        byte[] cellKey
    ) {
        JSONArray hashes = zone.optJSONArray("privacy_cell_hashes");
        if (hashes == null || hashes.length() == 0) return false;

        double cellSizeM = zone.optDouble("privacy_cell_size_m", DEFAULT_PRIVACY_CELL_SIZE_M);
        if (!Double.isFinite(cellSizeM) || cellSizeM < 25d) {
            cellSizeM = DEFAULT_PRIVACY_CELL_SIZE_M;
        }
        long[] cell = privacyCellCoordinate(lat, lng, cellSizeM);
        Set<String> hashSet = toHashSet(hashes);
        boolean keyed = hasKeyedHash(hashSet);
        // A keyed zone cannot be evaluated without the key. Answering "not
        // private" would silently disable the zone, so the fix is treated as
        // private instead, matching findCellPrivacyZoneForPoint in the web app.
        // readCellKey already logged why the key is missing.
        if (keyed && (cellKey == null || cellKey.length == 0)) return true;
        boolean legacy = hasLegacyHash(hashSet);
        if (matchesCell(hashSet, cell[0], cell[1], cellSizeM, legacy, keyed, cellKey)) return true;

        double guard = Double.isFinite(guardMeters) ? Math.max(0d, guardMeters) : 0d;
        if (guard <= 0d) return false;

        // A cell-only zone stores no center to measure a buffer from, so the guard
        // is applied by walking outward to the protected cells that fall inside it.
        // The half-diagonal slack keeps this fail-closed and matches the JS
        // findCellPrivacyZoneForPoint in src/lib/privacyZones.js.
        double reachM = guard + (Math.sqrt(2d) * cellSizeM) / 2d;
        long ring = (long) Math.ceil(reachM / cellSizeM) + 1L;
        double latStep = cellSizeM / 111320.0d;
        for (long y = cell[0] - ring; y <= cell[0] + ring; y++) {
            for (long x = cell[1] - ring; x <= cell[1] + ring; x++) {
                if (y == cell[0] && x == cell[1]) continue;
                if (!matchesCell(hashSet, y, x, cellSizeM, legacy, keyed, cellKey)) continue;
                double centerLat = ((y + 0.5d) * latStep) - 90.0d;
                double centerLng = ((x + 0.5d) * latStep) - 180.0d;
                if (!isValidCoordinate(centerLat, centerLng)) continue;
                if (haversineMeters(lat, lng, centerLat, centerLng) <= reachM) return true;
            }
        }
        return false;
    }

    /**
     * Same spherical formula as privacyZoneDistanceM in src/lib/privacyZones.js,
     * so the cell guard resolves identically on both sides. Kept free of
     * android.location so the parity test can run as a plain JVM unit test.
     */
    private static double haversineMeters(double lat1, double lng1, double lat2, double lng2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double h = Math.pow(Math.sin(dLat / 2d), 2d) +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.pow(Math.sin(dLng / 2d), 2d);
        return 2d * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0d, 1d - h)));
    }

    private static Set<String> toHashSet(JSONArray hashes) {
        Set<String> values = new HashSet<>(Math.max(16, hashes.length()));
        for (int i = 0; i < hashes.length(); i++) {
            String hash = hashes.optString(i, "");
            if (!hash.isEmpty()) values.add(hash);
        }
        return values;
    }

    private static long[] privacyCellCoordinate(double lat, double lng, double cellSizeM) {
        double latStep = cellSizeM / 111320.0d;
        double lngStep = cellSizeM / 111320.0d;
        long y = (long) Math.floor((lat + 90.0d) / latStep);
        long x = (long) Math.floor((lng + 180.0d) / lngStep);
        return new long[] { y, x };
    }

    private static boolean hasKeyedHash(Set<String> hashes) {
        for (String hash : hashes) {
            if (hash.startsWith(KEYED_CELL_HASH_PREFIX)) return true;
        }
        return false;
    }

    private static boolean hasLegacyHash(Set<String> hashes) {
        for (String hash : hashes) {
            if (!hash.startsWith(KEYED_CELL_HASH_PREFIX)) return true;
        }
        return false;
    }

    private static boolean matchesCell(
        Set<String> hashes,
        long y,
        long x,
        double cellSizeM,
        boolean legacy,
        boolean keyed,
        byte[] cellKey
    ) {
        if (legacy && hashes.contains(privacyCellHash(y, x, cellSizeM))) return true;
        if (!keyed) return false;
        String keyedHash = keyedPrivacyCellHash(y, x, cellSizeM, cellKey);
        return keyedHash != null && hashes.contains(keyedHash);
    }

    private static String privacyCellHash(long y, long x, double cellSizeM) {
        long unsignedHash = jsHashCodeUnsigned(Math.round(cellSizeM) + ":" + y + ":" + x);
        return "pzc_" + Long.toString(unsignedHash, 36);
    }

    private static byte[] macKeyBytes;
    private static Mac macInstance;

    /**
     * HMAC-SHA-256 over the same "cellSize:y:x" label the web app hashes, so a
     * cell hashed on either side resolves to the same string. The Mac instance is
     * reused because this runs for every neighbouring cell of every fix.
     */
    static synchronized String keyedPrivacyCellHash(long y, long x, double cellSizeM, byte[] cellKey) {
        if (cellKey == null || cellKey.length == 0) return null;
        try {
            if (macInstance == null || !java.util.Arrays.equals(macKeyBytes, cellKey)) {
                macInstance = Mac.getInstance(HMAC_ALGORITHM);
                macInstance.init(new SecretKeySpec(cellKey, HMAC_ALGORITHM));
                macKeyBytes = cellKey.clone();
            }
            String label = Math.round(cellSizeM) + ":" + y + ":" + x;
            byte[] tag = macInstance.doFinal(label.getBytes(StandardCharsets.UTF_8));
            StringBuilder hash = new StringBuilder(KEYED_CELL_HASH_PREFIX);
            for (int i = 0; i < KEYED_CELL_HASH_BYTES && i < tag.length; i++) {
                hash.append(Character.forDigit((tag[i] >> 4) & 0xf, 16));
                hash.append(Character.forDigit(tag[i] & 0xf, 16));
            }
            return hash.toString();
        } catch (Exception error) {
            macInstance = null;
            macKeyBytes = null;
            Log.w(TAG, "Keyed privacy cell hash failed", error);
            return null;
        }
    }

    private static String cachedCellKeyRaw;
    private static byte[] cachedCellKey;

    /**
     * The stored value is re-read on every fix, but decrypting it is not free, so
     * the decrypted key is reused while the stored ciphertext is unchanged.
     */
    private static synchronized byte[] readCellKey(Context context) {
        String raw = readString(context, CAPACITOR_PREFS, PRIVACY_CELL_KEY_KEY);
        String text = raw != null ? raw.trim() : "";
        if (text.isEmpty()) {
            cachedCellKeyRaw = null;
            cachedCellKey = null;
            return null;
        }
        if (text.equals(cachedCellKeyRaw)) return cachedCellKey;

        try {
            String base64 = DriveSensePayloadCrypto.isEncryptedStoredValue(text)
                ? DriveSensePayloadCrypto.decryptStoredValue(text, PRIVACY_CELL_KEY_CONTEXT)
                : text;
            byte[] key = Base64.decode(base64.trim(), Base64.DEFAULT);
            if (key == null || key.length < 16) throw new IllegalStateException("Cell key too short");
            cachedCellKeyRaw = text;
            cachedCellKey = key;
            return key;
        } catch (Exception error) {
            Log.w(TAG, "Privacy cell key unreadable; keyed zones will fail closed", error);
            cachedCellKeyRaw = null;
            cachedCellKey = null;
            return null;
        }
    }

    private static long jsHashCodeUnsigned(String value) {
        int hash = 0;
        String text = value != null ? value : "";
        for (int i = 0; i < text.length(); i++) {
            hash = ((hash << 5) - hash) + text.charAt(i);
        }
        return Integer.toUnsignedLong(hash);
    }

    private static String readString(Context context, String prefsName, String key) {
        SharedPreferences prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE);
        return prefs.getString(key, null);
    }

    private static double firstFinite(JSONObject object, String primaryKey, String fallbackKey) {
        double primary = object.optDouble(primaryKey, Double.NaN);
        if (Double.isFinite(primary)) return primary;
        return object.optDouble(fallbackKey, Double.NaN);
    }

    private static boolean isValidCoordinate(double lat, double lng) {
        return Double.isFinite(lat) &&
            Double.isFinite(lng) &&
            Math.abs(lat) <= 90d &&
            Math.abs(lng) <= 180d;
    }

    private static void nullKinematicFields(JSONObject point) {
        if (point == null) return;
        for (String field : KINEMATIC_FIELDS) {
            if (!point.has(field)) continue;
            try {
                point.put(field, JSONObject.NULL);
            } catch (Exception error) {
                Log.w(TAG, "Could not null kinematic fields", error);
            }
        }
    }

    private static boolean isExpired(JSONObject zone, long nowMs) {
        String expiresAt = zone != null ? zone.optString("expiresAt", "").trim() : "";
        if (expiresAt.isEmpty()) return false;
        try {
            return Instant.parse(expiresAt).toEpochMilli() <= nowMs;
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone expiry parse failed; keeping zone active", error);
            return false;
        }
    }
}
