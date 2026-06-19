package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DriveSenseNativeTripStoreInstrumentedTest {
    private Context context;
    private Map<String, Object> nativePrefsSnapshot;
    private Map<String, Object> capacitorPrefsSnapshot;
    private Map<String, Object> driveSenseSettingsPrefsSnapshot;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        nativePrefsSnapshot = snapshotPrefs(DriveSenseNativeTripStore.prefs(context));
        capacitorPrefsSnapshot = snapshotPrefs(context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE));
        driveSenseSettingsPrefsSnapshot = snapshotPrefs(context.getSharedPreferences("DriveSenseSettings", Context.MODE_PRIVATE));
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("DriveSenseSettings", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @After
    public void tearDown() {
        restorePrefs(DriveSenseNativeTripStore.prefs(context), nativePrefsSnapshot);
        restorePrefs(context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE), capacitorPrefsSnapshot);
        restorePrefs(context.getSharedPreferences("DriveSenseSettings", Context.MODE_PRIVATE), driveSenseSettingsPrefsSnapshot);
    }

    @Test
    public void packageNameMatchesConfiguredApplicationId() {
        assertEquals("com.drivesense.app", context.getPackageName());
    }

    @Test
    public void serviceEnabledFlagPersists() {
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));

        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    @Test
    public void completedTripsRecoverFromMalformedStorage() throws Exception {
        SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
        prefs.edit().putString("completed_trips", "{not-json").commit();

        assertEquals(0, DriveSenseNativeTripStore.getCompletedTrips(context).length());

        JSONObject trip = new JSONObject();
        trip.put("id", "native-trip-1");
        DriveSenseNativeTripStore.addCompletedTrip(context, trip);

        JSONArray trips = DriveSenseNativeTripStore.getCompletedTrips(context);
        assertEquals(1, trips.length());
        assertEquals("native-trip-1", trips.getJSONObject(0).getString("id"));
        String stored = prefs.getString("completed_trips", "");
        assertTrue(stored.startsWith("enc:v1:"));
        assertFalse(stored.contains("native-trip-1"));
    }

    @Test
    public void completedTripsAreRemovedAfterBestEffortOverwrite() throws Exception {
        JSONObject trip = new JSONObject();
        trip.put("id", "native-trip-delete");
        DriveSenseNativeTripStore.addCompletedTrip(context, trip);

        DriveSenseNativeTripStore.clearCompletedTrips(context);

        assertFalse(DriveSenseNativeTripStore.prefs(context).contains("completed_trips"));
        assertEquals(0, DriveSenseNativeTripStore.getCompletedTrips(context).length());
    }

    @Test
    public void completedTripsUpsertBySharedManualTripId() throws Exception {
        JSONObject first = new JSONObject();
        first.put("id", "manual-trip-shared");
        first.put("route_points", new JSONArray().put(new JSONObject().put("sample", 1)));
        DriveSenseNativeTripStore.addCompletedTrip(context, first);

        JSONObject richer = new JSONObject();
        richer.put("id", "manual-trip-shared");
        richer.put("route_points", new JSONArray()
            .put(new JSONObject().put("sample", 1))
            .put(new JSONObject().put("sample", 2)));
        DriveSenseNativeTripStore.addCompletedTrip(context, richer);

        JSONArray trips = DriveSenseNativeTripStore.getCompletedTrips(context);
        assertEquals(1, trips.length());
        assertEquals(2, trips.getJSONObject(0).getJSONArray("route_points").length());
    }

    @Test
    public void diagnosticEventsArePrependedAndCapped() throws Exception {
        for (int i = 0; i < 125; i++) {
            JSONObject event = new JSONObject();
            event.put("type", "event_" + i);
            DriveSenseNativeTripStore.addDiagnosticEvent(context, event);
        }

        JSONArray events = DriveSenseNativeTripStore.getDiagnosticEvents(context);
        assertEquals(120, events.length());
        assertEquals("event_124", events.getJSONObject(0).getString("type"));
    }

    @Test
    public void lastParkedLocationFallsBackToSharedCapacitorStorage() throws Exception {
        JSONObject parked = new JSONObject();
        parked.put("lat", 43.65);
        parked.put("lng", -79.38);
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("drivesense_last_parked", parked.toString())
            .commit();

        JSONObject restored = DriveSenseNativeTripStore.getLastParkedLocation(context);

        assertNotNull(restored);
        assertEquals(43.65, restored.getDouble("lat"), 0.0001);
        assertEquals(-79.38, restored.getDouble("lng"), 0.0001);
    }

    @Test
    public void invalidLastParkedPayloadReturnsNull() {
        DriveSenseNativeTripStore.prefs(context)
            .edit()
            .putString("last_parked_location", "not-json")
            .commit();

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
    }

    @Test
    public void nativeParkedLocationIsEncryptedAtRest() {
        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "trip-secure",
            "test"
        );

        String stored = DriveSenseNativeTripStore.prefs(context).getString("last_parked_location", "");
        assertTrue(stored.startsWith("enc:v1:"));
        assertFalse(stored.contains("43.6532"));
        assertFalse(stored.contains("-79.3832"));

        JSONObject restored = DriveSenseNativeTripStore.getLastParkedLocation(context);
        assertNotNull(restored);
        assertEquals(43.6532, restored.optDouble("lat"), 0.0001);
        assertEquals(-79.3832, restored.optDouble("lng"), 0.0001);
    }

    @Test
    public void nativeParkedLocationInsideMirroredPrivacyZoneIsNotStored() throws Exception {
        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "previous-park",
            "test"
        );
        assertNotNull(DriveSenseNativeTripStore.getLastParkedLocation(context));

        JSONArray zones = new JSONArray();
        JSONObject zone = new JSONObject();
        zone.put("id", "home");
        zone.put("label", "Home");
        zone.put("lat", 43.6532);
        zone.put("lng", -79.3832);
        zone.put("radius_m", 100);
        zones.put(zone);
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("privacy_zones_v1", zones.toString())
            .commit();

        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "private-park",
            "test"
        );

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
        assertFalse(DriveSenseNativeTripStore.prefs(context).contains("last_parked_location"));
    }

    @Test
    public void nativeParkedLocationInsideEncryptedMirroredPrivacyZoneIsNotStored() throws Exception {
        JSONArray zones = new JSONArray();
        JSONObject zone = new JSONObject();
        zone.put("id", "home");
        zone.put("label", "Home");
        zone.put("lat", 43.6532);
        zone.put("lng", -79.3832);
        zone.put("radius_m", 100);
        zones.put(zone);

        JSONObject encrypted = new JSONObject();
        encrypted.put("encrypted", true);
        encrypted.put("version", 1);
        encrypted.put("algorithm", "AES-256-GCM");
        encrypted.put("key_provider", "android-keystore");
        encrypted.put("ciphertext", DriveSensePayloadCrypto.encrypt(zones.toString(), "native:privacy_zones_v1"));
        String storedZones = encrypted.toString();

        assertFalse(storedZones.contains("43.6532"));
        assertFalse(storedZones.contains("-79.3832"));
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("privacy_zones_v1", storedZones)
            .commit();

        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "encrypted-private-park",
            "test"
        );

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
        assertFalse(DriveSenseNativeTripStore.prefs(context).contains("last_parked_location"));
    }

    @Test
    public void nativeParkedLocationUsesPrivacyZonesFromSyncedSettingsFallback() throws Exception {
        JSONObject settings = new JSONObject();
        JSONArray zones = new JSONArray();
        JSONObject zone = new JSONObject();
        zone.put("id", "work");
        zone.put("label", "Work");
        zone.put("latitude", 43.6532);
        zone.put("longitude", -79.3832);
        zone.put("radius", 100);
        zones.put(zone);
        settings.put("privacy_zones", zones);
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("drivesense_settings", settings.toString())
            .commit();

        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "settings-private-park",
            "test"
        );

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
        assertFalse(DriveSenseNativeTripStore.prefs(context).contains("last_parked_location"));
    }

    @Test
    public void nativeParkedLocationInsideCellOnlyPrivacyZoneIsNotStored() throws Exception {
        JSONArray zones = new JSONArray();
        JSONObject zone = new JSONObject();
        zone.put("id", "home-cell");
        zone.put("label", "Home");
        zone.put("radius_m", 100);
        zone.put("privacy_cell_schema", "global_grid_v1");
        zone.put("privacy_cell_size_m", 100);
        JSONArray hashes = new JSONArray();
        hashes.put(privacyCellHashFor(43.6532, -79.3832));
        zone.put("privacy_cell_hashes", hashes);
        zones.put(zone);

        String storedZones = zones.toString();
        assertFalse(storedZones.contains("43.6532"));
        assertFalse(storedZones.contains("-79.3832"));
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("privacy_zones_v1", storedZones)
            .commit();

        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "cell-private-park",
            "test"
        );

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
        assertFalse(DriveSenseNativeTripStore.prefs(context).contains("last_parked_location"));

        JSONArray points = new JSONArray();
        JSONObject point = new JSONObject();
        point.put("lat", 43.6532);
        point.put("lng", -79.3832);
        point.put("timestamp", "2026-06-08T12:00:00.000Z");
        points.put(point);

        JSONArray redacted = PrivacyZoneChecker.redactRoutePoints(context, points);
        assertTrue(redacted.getJSONObject(0).isNull("lat"));
        assertTrue(redacted.getJSONObject(0).isNull("lng"));
        assertEquals("home-cell", redacted.getJSONObject(0).getString("privacy_zone_id"));
    }

    @Test
    public void nativePrivacyCheckerFailsClosedWhenSettingsOnlyContainRedactedZones() throws Exception {
        JSONObject settings = new JSONObject();
        JSONArray zones = new JSONArray();
        JSONObject zone = new JSONObject();
        zone.put("id", "home");
        zone.put("label", "Home");
        zone.put("radius_m", 100);
        zone.put("masked_for_privacy", true);
        zones.put(zone);
        settings.put("privacy_zones", zones);
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("drivesense_settings", settings.toString())
            .commit();

        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.6532,
            -79.3832,
            System.currentTimeMillis(),
            "redacted-settings-private-park",
            "test"
        );

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
        assertFalse(DriveSenseNativeTripStore.prefs(context).contains("last_parked_location"));

        JSONArray points = new JSONArray();
        JSONObject point = new JSONObject();
        point.put("lat", 43.6532);
        point.put("lng", -79.3832);
        point.put("timestamp", "2026-06-08T12:00:00.000Z");
        points.put(point);

        JSONArray redacted = PrivacyZoneChecker.redactRoutePoints(context, points);
        assertTrue(redacted.getJSONObject(0).isNull("lat"));
        assertTrue(redacted.getJSONObject(0).isNull("lng"));
        assertTrue(redacted.getJSONObject(0).getBoolean("masked_for_privacy"));
        assertEquals("native_privacy_sync_unavailable", redacted.getJSONObject(0).getString("privacy_zone_id"));
    }

    @Test
    public void goldenScoringFixturesArePackagedForInstrumentation() throws Exception {
        assertGoldenScoringAsset("urban_smooth_v2_1_0.json");
        assertGoldenScoringAsset("eventful_speeding_v2_1_0.json");
    }

    @Test
    public void sharedJsAndroidParityFixtureMatchesNativeStatsAndNoiseFloor() throws Exception {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/Toronto"));

            JSONObject fixture = loadInstrumentationAsset("androidTripStatsParityFixture.json");
            JSONObject thresholds = fixture.getJSONObject("thresholds");
            JSONObject expected = fixture.getJSONObject("expectedParityResult");

            assertEquals(thresholds.getLong("STATS_MAX_SAMPLE_GAP_SECONDS"), longConstant("STATS_MAX_SAMPLE_GAP_SECONDS"));
            assertEquals(thresholds.getDouble("MIN_POINT_DISTANCE_M"), doubleConstant("MIN_POINT_DISTANCE_M"), 0.0d);
            assertEquals(thresholds.getDouble("STATIONARY_SPEED_KMH"), doubleConstant("STATIONARY_SPEED_KMH"), 0.0d);
            assertEquals(thresholds.getDouble("MIN_TRUSTED_SPEED_KMH"), doubleConstant("MIN_TRUSTED_SPEED_KMH"), 0.0d);

            DriveSenseAutoTrackingService service = new DriveSenseAutoTrackingService();
            Method calculateStats = DriveSenseAutoTrackingService.class.getDeclaredMethod(
                "calculateStats",
                JSONArray.class,
                long.class,
                long.class
            );
            calculateStats.setAccessible(true);

            JSONArray points = fixture.getJSONArray("points");
            long startMs = Instant.parse(fixture.getString("startTime")).toEpochMilli();
            long endMs = Instant.parse(fixture.getString("endTime")).toEpochMilli();
            Object stats = calculateStats.invoke(service, points, startMs, endMs);

            assertEquals(expected.getDouble("distanceKm"), round(doubleField(stats, "distanceKm"), 3), 0.0d);
            assertEquals(expected.getLong("durationSeconds"), longField(stats, "durationSeconds"));
            assertEquals(expected.getDouble("avgSpeedKmh"), round(doubleField(stats, "avgSpeedKmh"), 1), 0.0d);
            assertEquals(expected.getBoolean("nightDriving"), booleanField(stats, "nightDriving"));

            JSONObject noiseFloorCase = fixture.getJSONArray("noiseFloorCases").getJSONObject(0);
            Method noiseFloor = DriveSenseAutoTrackingService.class.getDeclaredMethod(
                "noiseFloor",
                double.class,
                double.class
            );
            noiseFloor.setAccessible(true);
            double actualNoiseFloorM = (double) noiseFloor.invoke(
                service,
                noiseFloorCase.getDouble("previousAccuracy"),
                noiseFloorCase.getDouble("currentAccuracy")
            );
            assertEquals(expected.getDouble("noiseFloorM"), actualNoiseFloorM, 0.0d);
        } finally {
            TimeZone.setDefault(original);
        }
    }

    private void assertGoldenScoringAsset(String name) throws Exception {
        JSONObject fixture = loadInstrumentationAsset(name);
        String scoringVersion = fixture.getString("scoring_version");
        assertTrue(scoringVersion.matches("^[a-f0-9]{8}$"));
        assertTrue(fixture.getBoolean("human_verified"));
        assertTrue(fixture.getJSONArray("points").length() > 1);
        assertTrue(fixture.getJSONObject("expected").getJSONObject("scores").has("score_overall"));
        JSONObject provenance = fixture.getJSONObject("expected").getJSONObject("score_provenance");
        assertEquals(scoringVersion, provenance.getString("scoring_version"));
        assertTrue(provenance.has("components"));
    }

    private JSONObject loadInstrumentationAsset(String name) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation()
            .getContext()
            .getAssets()
            .open(name)) {
            assertNotNull(stream);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static long longConstant(String name) throws Exception {
        Field field = DriveSenseAutoTrackingService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.getLong(null);
    }

    private static double doubleConstant(String name) throws Exception {
        Field field = DriveSenseAutoTrackingService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.getDouble(null);
    }

    private static long longField(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.getLong(target);
    }

    private static double doubleField(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.getDouble(target);
    }

    private static boolean booleanField(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.getBoolean(target);
    }

    private static double round(double value, int decimals) {
        double factor = Math.pow(10d, decimals);
        return Math.round(value * factor) / factor;
    }

    private static String privacyCellHashFor(double lat, double lng) throws Exception {
        double cellSizeM = 100.0d;
        double latStep = cellSizeM / 111320.0d;
        double lngStep = cellSizeM / 111320.0d;
        long y = (long) Math.floor((lat + 90.0d) / latStep);
        long x = (long) Math.floor((lng + 180.0d) / lngStep);
        Method hash = PrivacyZoneChecker.class.getDeclaredMethod(
            "privacyCellHash",
            long.class,
            long.class,
            double.class
        );
        hash.setAccessible(true);
        return (String) hash.invoke(null, y, x, cellSizeM);
    }

    private static Map<String, Object> snapshotPrefs(SharedPreferences prefs) {
        Map<String, Object> snapshot = new HashMap<>();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Set<?>) {
                snapshot.put(entry.getKey(), new HashSet<>((Set<String>) value));
            } else {
                snapshot.put(entry.getKey(), value);
            }
        }
        return snapshot;
    }

    private static void restorePrefs(SharedPreferences prefs, Map<String, Object> snapshot) {
        SharedPreferences.Editor editor = prefs.edit().clear();
        for (Map.Entry<String, Object> entry : snapshot.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof String) {
                editor.putString(entry.getKey(), (String) value);
            } else if (value instanceof Boolean) {
                editor.putBoolean(entry.getKey(), (Boolean) value);
            } else if (value instanceof Integer) {
                editor.putInt(entry.getKey(), (Integer) value);
            } else if (value instanceof Long) {
                editor.putLong(entry.getKey(), (Long) value);
            } else if (value instanceof Float) {
                editor.putFloat(entry.getKey(), (Float) value);
            } else if (value instanceof Set<?>) {
                editor.putStringSet(entry.getKey(), (Set<String>) value);
            }
        }
        editor.commit();
    }
}
