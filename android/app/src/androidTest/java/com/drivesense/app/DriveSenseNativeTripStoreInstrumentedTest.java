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

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
    private Map<String, byte[]> completedTripJournalSnapshot;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        nativePrefsSnapshot = snapshotPrefs(DriveSenseNativeTripStore.prefs(context));
        capacitorPrefsSnapshot = snapshotPrefs(context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE));
        driveSenseSettingsPrefsSnapshot = snapshotPrefs(context.getSharedPreferences("DriveSenseSettings", Context.MODE_PRIVATE));
        completedTripJournalSnapshot = snapshotJournal(context);
        DriveSenseCompletedTripJournal.clear(context);
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("DriveSenseSettings", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @After
    public void tearDown() {
        DriveSenseCompletedTripJournal.clear(context);
        restoreJournal(context, completedTripJournalSnapshot);
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
    public void activeTripStatusPersistsAndClearsWithoutCoordinates() throws Exception {
        JSONObject status = new JSONObject();
        status.put("active", true);
        status.put("state", "recording");
        status.put("distance_km", 2.5d);
        status.put("route_point_count", 42);

        DriveSenseNativeTripStore.setActiveTripStatus(context, status);

        JSONObject restored = DriveSenseNativeTripStore.getActiveTripStatus(context);
        assertNotNull(restored);
        assertTrue(restored.getBoolean("active"));
        assertEquals(2.5d, restored.getDouble("distance_km"), 0.001d);
        String stored = DriveSenseNativeTripStore.prefs(context).getString("active_trip_status", "");
        assertTrue(stored.startsWith("enc:v1:"));
        assertFalse(stored.contains("distance_km"));
        assertFalse(stored.contains("lat"));

        DriveSenseNativeTripStore.clearActiveTripStatus(context);
        assertNull(DriveSenseNativeTripStore.getActiveTripStatus(context));
    }

    @Test
    public void malformedLegacyCompletedTripsArePreservedAndReported() throws Exception {
        SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
        prefs.edit().putString("completed_trips", "{not-json").commit();

        assertEquals(0, DriveSenseNativeTripStore.getCompletedTrips(context).length());
        assertFalse(DriveSenseNativeTripStore.getCompletedTripJournalStatus(context).getBoolean("queueReadable"));

        JSONObject trip = new JSONObject();
        trip.put("id", "native-trip-1");
        assertTrue(DriveSenseNativeTripStore.addCompletedTrip(context, trip));

        JSONArray trips = DriveSenseNativeTripStore.getCompletedTrips(context);
        assertEquals(1, trips.length());
        assertEquals("native-trip-1", trips.getJSONObject(0).getString("id"));
        String stored = prefs.getString("completed_trips", "");
        assertEquals("{not-json", stored);
        assertFalse(DriveSenseNativeTripStore.getCompletedTripJournalStatus(context).getBoolean("queueReadable"));
    }

    @Test
    public void completedTripsAreAcknowledgedIndividually() throws Exception {
        assertTrue(DriveSenseNativeTripStore.addCompletedTrip(
            context,
            new JSONObject().put("id", "native-trip-a")
        ));
        assertTrue(DriveSenseNativeTripStore.addCompletedTrip(
            context,
            new JSONObject().put("id", "native-trip-b")
        ));

        JSONObject result = DriveSenseNativeTripStore.acknowledgeCompletedTrips(
            context,
            new JSONArray().put("native-trip-a")
        );

        assertTrue(result.getBoolean("success"));
        assertEquals(1, result.getInt("removed"));
        JSONArray remaining = DriveSenseNativeTripStore.getCompletedTrips(context);
        assertEquals(1, remaining.length());
        assertEquals("native-trip-b", remaining.getJSONObject(0).getString("id"));
    }

    @Test
    public void largeCompletedTripsUseBoundedEncryptedChunks() throws Exception {
        StringBuilder padding = new StringBuilder();
        for (int index = 0; index < 700_000; index++) padding.append((char) ('a' + (index % 26)));
        JSONObject trip = new JSONObject()
            .put("id", "native-trip-large")
            .put("route_points", new JSONArray()
                .put(new JSONObject().put("lat", 43.65).put("lng", -79.38))
                .put(new JSONObject().put("lat", 44.65).put("lng", -80.38)))
            .put("test_padding", padding.toString());

        assertTrue(DriveSenseNativeTripStore.addCompletedTrip(context, trip));
        assertEquals(
            padding.length(),
            DriveSenseNativeTripStore.getCompletedTrips(context)
                .getJSONObject(0)
                .getString("test_padding")
                .length()
        );
        JSONObject status = DriveSenseNativeTripStore.getCompletedTripJournalStatus(context);
        assertTrue(status.getBoolean("queueReadable"));
        assertTrue(status.getLong("largestFileBytes") <= status.getLong("maxFileBytes"));
        assertTrue(status.getLong("encryptedBytes") <= status.getLong("maxTotalBytes"));
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
    public void newerSharedParkedLocationWinsOverStaleNativeLocation() throws Exception {
        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.65,
            -79.38,
            Instant.parse("2026-07-17T18:00:00Z").toEpochMilli(),
            "july-17-trip",
            "native_parking_stop"
        );
        JSONObject newer = new JSONObject();
        newer.put("lat", 43.7001);
        newer.put("lng", -79.4101);
        newer.put("timestamp", "2026-07-18T18:00:00Z");
        newer.put("tripId", "july-18-trip");
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("drivesense_last_parked", newer.toString())
            .commit();

        JSONObject restored = DriveSenseNativeTripStore.getLastParkedLocation(context);

        assertNotNull(restored);
        assertEquals("july-18-trip", restored.getString("tripId"));
        assertEquals(43.7001, restored.getDouble("lat"), 0.0001);
        assertEquals(-79.4101, restored.getDouble("lng"), 0.0001);
    }

    @Test
    public void newerSharedPrivacySuppressionHidesStaleNativeLocation() throws Exception {
        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.65,
            -79.38,
            Instant.parse("2026-07-17T18:00:00Z").toEpochMilli(),
            "july-17-trip",
            "native_parking_stop"
        );
        JSONObject suppression = new JSONObject();
        suppression.put("suppressed", true);
        suppression.put("timestamp", "2026-07-18T18:00:00Z");
        suppression.put("source", "privacy_zone");
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("drivesense_last_parked", suppression.toString())
            .commit();

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
    }

    @Test
    public void privateReturnKeepsSafePublicRecordButReportsProtectedParkingState() throws Exception {
        long shopMs = Instant.parse("2026-07-18T17:00:00Z").toEpochMilli();
        long homeMs = Instant.parse("2026-07-18T18:00:00Z").toEpochMilli();
        DriveSenseNativeTripStore.saveLastParkedLocation(
            context,
            43.7001,
            -79.4101,
            shopMs,
            "shop-trip",
            "native_parking_stop"
        );

        DriveSenseNativeTripStore.suppressLastParkedLocation(
            context,
            homeMs,
            "home-trip",
            "privacy_zone"
        );

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
        JSONObject state = DriveSenseNativeTripStore.getLastParkingState(context);
        assertNotNull(state);
        assertEquals("private", state.getString("status"));
        assertEquals("home-trip", state.getString("tripId"));
        assertTrue(DriveSenseNativeTripStore.prefs(context).contains("last_parked_location"));
        assertTrue(DriveSenseNativeTripStore.prefs(context).contains("last_parking_state"));
    }

    @Test
    public void parkingResolverUsesStableStopInsteadOfNoisyFinalFix() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(43.6500, -79.3800, "2026-07-18T18:00:00Z", 35d, 8d))
            .put(parkingPoint(43.6510, -79.3800, "2026-07-18T18:00:10Z", 18d, 8d))
            .put(parkingPoint(43.65120, -79.38000, "2026-07-18T18:00:20Z", 4d, 7d))
            .put(parkingPoint(43.65121, -79.38001, "2026-07-18T18:00:35Z", 0d, 6d))
            .put(parkingPoint(43.65119, -79.38000, "2026-07-18T18:00:50Z", 0d, 8d))
            .put(parkingPoint(43.65155, -79.38030, "2026-07-18T18:01:05Z", 0d, 55d));

        JSONObject resolved = DriveSenseParkingResolver.resolve(
            points,
            Instant.parse("2026-07-18T18:01:05Z").toEpochMilli()
        );

        assertNotNull(resolved);
        assertEquals("terminal_stop_cluster", resolved.getString("strategy"));
        assertEquals("high", resolved.getString("confidence"));
        assertTrue(resolved.getInt("confidence_score") >= 75);
        assertTrue(resolved.getJSONArray("evidence").length() > 0);
        assertTrue(Math.abs(resolved.getDouble("lat") - 43.6512) < 0.0001);
        assertTrue(Math.abs(resolved.getDouble("lat") - 43.65155) > 0.0001);
    }

    @Test
    public void parkingResolverScoresPostStopRefinementAndActivityEvidence() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(43.6500, -79.3800, "2026-07-18T18:00:00Z", 30d, 8d))
            .put(parkingPoint(43.65120, -79.38000, "2026-07-18T18:00:20Z", 0d, 7d))
            .put(parkingPoint(43.65121, -79.38001, "2026-07-18T18:00:25Z", 0d, 6d).put("parking_refinement", true))
            .put(parkingPoint(43.65119, -79.38000, "2026-07-18T18:00:30Z", 0d, 7d).put("parking_refinement", true))
            .put(parkingPoint(43.65120, -79.38001, "2026-07-18T18:00:35Z", 0d, 6d).put("parking_refinement", true));
        JSONObject signals = new JSONObject()
            .put("stopped_seconds", 35)
            .put("last_moving_speed_kmh", 30)
            .put("activity_type", "still")
            .put("activity_confidence", 90)
            .put("gps_drift_m", 4);

        JSONObject resolved = DriveSenseParkingResolver.resolve(
            points,
            Instant.parse("2026-07-18T18:00:35Z").toEpochMilli(),
            signals
        );

        assertNotNull(resolved);
        assertEquals("post_stop_refinement", resolved.getString("strategy"));
        assertEquals(3, resolved.getInt("refinement_count"));
        assertTrue(resolved.getInt("confidence_score") >= 90);
        assertTrue(resolved.getJSONArray("evidence").toString().contains("post_stop_refinement"));
        assertTrue(resolved.getJSONArray("evidence").toString().contains("activity_still"));
    }

    @Test
    public void parkingResolverKeepsExistingParkingForDriveThroughPattern() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(43.6500, -79.3800, "2026-07-18T18:00:00Z", 25d, 7d))
            .put(parkingPoint(43.6502, -79.3800, "2026-07-18T18:00:10Z", 0d, 7d))
            .put(parkingPoint(43.6503, -79.3800, "2026-07-18T18:00:20Z", 4d, 7d))
            .put(parkingPoint(43.6504, -79.3800, "2026-07-18T18:00:30Z", 0d, 7d))
            .put(parkingPoint(43.6505, -79.3800, "2026-07-18T18:00:40Z", 3d, 7d))
            .put(parkingPoint(43.6506, -79.3800, "2026-07-18T18:00:50Z", 0d, 7d))
            .put(parkingPoint(43.6507, -79.3800, "2026-07-18T18:01:00Z", 2d, 7d));
        JSONObject signals = new JSONObject()
            .put("stopped_seconds", 60)
            .put("activity_type", "in_vehicle")
            .put("activity_confidence", 90);

        JSONObject resolved = DriveSenseParkingResolver.resolve(
            points,
            Instant.parse("2026-07-18T18:01:00Z").toEpochMilli(),
            signals
        );

        assertNotNull(resolved);
        assertEquals("possible_drive_through", resolved.getString("ignored_reason"));
        assertFalse(resolved.has("lat"));
    }

    @Test
    public void parkingResolverRetainsGarageEntranceAndExitEvidence() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(43.6500, -79.3800, "2026-07-18T18:00:00Z", 30d, 8d))
            .put(parkingPoint(43.6510, -79.3800, "2026-07-18T18:00:10Z", 10d, 12d))
            .put(parkingPoint(43.6512, -79.3800, "2026-07-18T18:00:20Z", 0d, 42d))
            .put(parkingPoint(43.6512, -79.3801, "2026-07-18T18:00:30Z", 0d, 38d))
            .put(parkingPoint(43.6511, -79.3800, "2026-07-18T18:00:40Z", 0d, 40d));
        JSONObject signals = new JSONObject()
            .put("stopped_seconds", 40)
            .put("vehicle_exit_transition", true);

        JSONObject resolved = DriveSenseParkingResolver.resolve(
            points,
            Instant.parse("2026-07-18T18:00:40Z").toEpochMilli(),
            signals
        );

        assertNotNull(resolved);
        assertTrue(resolved.getBoolean("indoor_estimated"));
        assertTrue(resolved.has("garage_entrance"));
        assertTrue(resolved.getJSONArray("evidence").toString().contains("activity_vehicle_exit_transition"));
    }

    @Test
    public void parkingResolverUsesLocalLearningForWeakAutomaticStops() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(43.6500, -79.3800, "2026-07-18T18:00:00Z", 25d, 8d))
            .put(parkingPoint(43.6501, -79.3800, "2026-07-18T18:00:20Z", 0d, 50d));
        JSONObject profile = new JSONObject()
            .put("feedback_count", 2)
            .put("strictness_level", 2)
            .put("short_stop_max_seconds", 65)
            .put("in_vehicle_stop_max_seconds", 180)
            .put("minimum_automatic_confidence", 60);
        JSONObject signals = new JSONObject()
            .put("stopped_seconds", 70)
            .put("activity_type", "still")
            .put("activity_confidence", 85)
            .put("parking_learning_profile", profile);

        JSONObject resolved = DriveSenseParkingResolver.resolve(
            points,
            Instant.parse("2026-07-18T18:00:20Z").toEpochMilli(),
            signals
        );

        assertNotNull(resolved);
        assertEquals("learned_low_confidence_stop", resolved.getString("ignored_reason"));
    }

    @Test
    public void parkingResolverKeepsStrongExitEvidenceDespiteLocalLearning() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(43.6500, -79.3800, "2026-07-18T18:00:00Z", 25d, 8d))
            .put(parkingPoint(43.6501, -79.3800, "2026-07-18T18:00:20Z", 0d, 50d));
        JSONObject profile = new JSONObject()
            .put("feedback_count", 2)
            .put("strictness_level", 2)
            .put("minimum_automatic_confidence", 60);
        JSONObject signals = new JSONObject()
            .put("stopped_seconds", 70)
            .put("activity_type", "still")
            .put("activity_confidence", 85)
            .put("vehicle_exit_transition", true)
            .put("parking_learning_profile", profile);

        JSONObject resolved = DriveSenseParkingResolver.resolve(
            points,
            Instant.parse("2026-07-18T18:00:20Z").toEpochMilli(),
            signals
        );

        assertNotNull(resolved);
        assertTrue(resolved.has("lat"));
        assertTrue(resolved.getJSONArray("evidence").toString().contains("personalized_parking_learning"));
    }

    @Test
    public void parkingResolverRejectsNullIsland() throws Exception {
        JSONArray points = new JSONArray()
            .put(parkingPoint(0d, 0d, "2026-07-18T18:00:00Z", 0d, 5d));

        assertNull(DriveSenseParkingResolver.resolve(points, System.currentTimeMillis()));
    }

    @Test
    public void parkingResolverRejectsStaleOrVeryInaccurateEndpoints() throws Exception {
        long recordedMs = Instant.parse("2026-07-18T18:00:00Z").toEpochMilli();
        JSONArray stale = new JSONArray()
            .put(parkingPoint(43.65, -79.38, "2026-07-18T18:00:00Z", 0d, 8d));
        JSONArray inaccurate = new JSONArray()
            .put(parkingPoint(43.65, -79.38, "2026-07-18T18:00:00Z", 0d, 120d));

        assertNull(DriveSenseParkingResolver.resolve(stale, recordedMs + 3 * 60_000L));
        assertNull(DriveSenseParkingResolver.resolve(inaccurate, recordedMs));
    }

    private static JSONObject parkingPoint(
        double lat,
        double lng,
        String timestamp,
        double speedKmh,
        double accuracyM
    ) throws Exception {
        return new JSONObject()
            .put("lat", lat)
            .put("lng", lng)
            .put("timestamp", timestamp)
            .put("speed_kmh", speedKmh)
            .put("accuracy", accuracyM);
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
        point.put("speed_kmh", 64);
        point.put("heading", 92);
        point.put("accuracy", 4);
        point.put("acceleration_x", 1.2);
        points.put(point);

        JSONArray redacted = PrivacyZoneChecker.redactRoutePoints(context, points);
        assertTrue(redacted.getJSONObject(0).isNull("lat"));
        assertTrue(redacted.getJSONObject(0).isNull("lng"));
        assertTrue(redacted.getJSONObject(0).isNull("speed_kmh"));
        assertTrue(redacted.getJSONObject(0).isNull("heading"));
        assertTrue(redacted.getJSONObject(0).isNull("accuracy"));
        assertTrue(redacted.getJSONObject(0).isNull("acceleration_x"));
        assertEquals("home-cell", redacted.getJSONObject(0).getString("privacy_zone_id"));
    }

    @Test
    public void nativePrivacyCheckerHonorsTemporaryZoneExpiry() throws Exception {
        JSONArray zones = new JSONArray();
        JSONObject expiredZone = new JSONObject();
        expiredZone.put("id", "expired-home");
        expiredZone.put("label", "Expired home");
        expiredZone.put("lat", 43.6532);
        expiredZone.put("lng", -79.3832);
        expiredZone.put("radius_m", 100);
        expiredZone.put("expiresAt", Instant.now().minusSeconds(60).toString());
        zones.put(expiredZone);

        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("privacy_zones_v1", zones.toString())
            .commit();

        JSONArray points = new JSONArray();
        JSONObject point = new JSONObject();
        point.put("lat", 43.6532);
        point.put("lng", -79.3832);
        point.put("speed_kmh", 45);
        points.put(point);

        JSONArray expiredResult = PrivacyZoneChecker.redactRoutePoints(context, points);
        assertEquals(43.6532, expiredResult.getJSONObject(0).getDouble("lat"), 0.000001);
        assertEquals(45, expiredResult.getJSONObject(0).getDouble("speed_kmh"), 0.001);

        expiredZone.put("expiresAt", Instant.now().plusSeconds(3600).toString());
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("privacy_zones_v1", zones.toString())
            .commit();

        JSONArray activeResult = PrivacyZoneChecker.redactRoutePoints(context, points);
        assertTrue(activeResult.getJSONObject(0).isNull("lat"));
        assertTrue(activeResult.getJSONObject(0).isNull("speed_kmh"));
        assertEquals("expired-home", activeResult.getJSONObject(0).getString("privacy_zone_id"));
    }

    @Test
    public void nativeCorridorProtectionMatchesJavaScriptCoverageCellHashes() throws Exception {
        JSONArray zones = new JSONArray();
        JSONObject corridor = new JSONObject();
        corridor.put("id", "commute-corridor");
        corridor.put("label", "Private commute");
        corridor.put("type", "corridor");
        corridor.put("radius_m", 80);
        corridor.put("width_m", 80);
        corridor.put("privacy_cell_size_m", 50);
        corridor.put("privacy_cell_hashes", new JSONArray()
            // Static outputs from the JavaScript privacy-cell hash algorithm.
            .put("pzc_1d8k9eb")
            .put("pzc_712ohe"));
        zones.put(corridor);

        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("privacy_zones_v1", zones.toString())
            .commit();

        JSONArray points = new JSONArray()
            .put(new JSONObject().put("lat", 43.6532).put("lng", -79.3840).put("speed_kmh", 50))
            .put(new JSONObject().put("lat", 43.6537).put("lng", -79.3840).put("speed_kmh", 45))
            .put(new JSONObject().put("lat", 43.6555).put("lng", -79.3840).put("speed_kmh", 40));

        JSONArray redacted = PrivacyZoneChecker.redactRoutePoints(context, points);
        assertTrue(redacted.getJSONObject(0).isNull("lat"));
        assertTrue(redacted.getJSONObject(0).isNull("speed_kmh"));
        assertTrue(redacted.getJSONObject(1).isNull("lat"));
        assertTrue(redacted.getJSONObject(1).isNull("speed_kmh"));
        assertEquals(43.6555, redacted.getJSONObject(2).getDouble("lat"), 0.000001);
        assertEquals(40, redacted.getJSONObject(2).getDouble("speed_kmh"), 0.001);
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

    private static Map<String, byte[]> snapshotJournal(Context context) {
        Map<String, byte[]> snapshot = new HashMap<>();
        File directory = new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1");
        File[] files = directory.listFiles();
        if (files == null) return snapshot;
        for (File file : files) {
            if (!file.isFile()) continue;
            try (FileInputStream input = new FileInputStream(file)) {
                snapshot.put(file.getName(), input.readAllBytes());
            } catch (Exception ignored) {}
        }
        return snapshot;
    }

    private static void restoreJournal(Context context, Map<String, byte[]> snapshot) {
        if (snapshot == null || snapshot.isEmpty()) return;
        File directory = new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1");
        if (!directory.exists() && !directory.mkdirs()) return;
        for (Map.Entry<String, byte[]> entry : snapshot.entrySet()) {
            File file = new File(directory, entry.getKey());
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(entry.getValue());
                output.flush();
                output.getFD().sync();
            } catch (Exception ignored) {}
        }
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
