package com.roadsage.app;

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
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
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

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        clearTrackingPrefs();
    }

    @After
    public void tearDown() {
        clearTrackingPrefs();
    }

    @Test
    public void packageNameMatchesConfiguredApplicationId() {
        assertEquals("com.roadsage.app", context.getPackageName());
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
    public void lastParkedLocationUsesEncryptedNativeStorageOnly() throws Exception {
        JSONObject parked = parkedLocation(43.67, -79.40, 3_000L);
        DriveSenseNativeTripStore.saveLastParkedLocation(context, parked);

        JSONObject restored = DriveSenseNativeTripStore.getLastParkedLocation(context);

        assertNotNull(restored);
        assertEquals(43.67, restored.getDouble("lat"), 0.0001);
        assertEquals(3_000L, restored.getLong("timestamp_ms"));
    }

    @Test
    public void plaintextLegacyPreferenceFilesAreDeleteOnlyCleanupTargets() {
        context.getSharedPreferences("road_sage_native_tracking", Context.MODE_PRIVATE)
            .edit()
            .putString("legacy", "value")
            .commit();
        context.getSharedPreferences("drivesense_native_tracking", Context.MODE_PRIVATE)
            .edit()
            .putString("legacy", "value")
            .commit();

        DriveSenseNativeTripStore.prefs(context);

        assertFalse(sharedPrefsFile("road_sage_native_tracking").exists());
        assertFalse(sharedPrefsFile("drivesense_native_tracking").exists());
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

            RoadSageAutoTrackingService service = new RoadSageAutoTrackingService();
            Method calculateStats = RoadSageAutoTrackingService.class.getDeclaredMethod(
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
            Method noiseFloor = RoadSageAutoTrackingService.class.getDeclaredMethod(
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
        assertFalse(scoringVersion.isEmpty());
        assertEquals(
            scoringVersion,
            fixture.getJSONObject("expected")
                .getJSONObject("score_provenance")
                .getString("scoring_version")
        );
        assertTrue(fixture.getBoolean("human_verified"));
        assertTrue(fixture.getJSONArray("points").length() > 1);
        assertTrue(fixture.getJSONObject("expected").getJSONObject("scores").has("score_overall"));
        assertTrue(fixture.getJSONObject("expected").getJSONObject("score_provenance").has("components"));
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

    private void clearTrackingPrefs() {
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.deleteSharedPreferences("road_sage_native_tracking");
        context.deleteSharedPreferences("drivesense_native_tracking");
        context.deleteSharedPreferences("CapacitorStorage");
    }

    private File sharedPrefsFile(String prefsName) {
        return new File(context.getApplicationInfo().dataDir, "shared_prefs/" + prefsName + ".xml");
    }

    private static JSONObject parkedLocation(double lat, double lng, long timestampMs) throws Exception {
        JSONObject parked = new JSONObject();
        parked.put("lat", lat);
        parked.put("lng", lng);
        parked.put("timestamp_ms", timestampMs);
        parked.put("timestamp", Instant.ofEpochMilli(timestampMs).toString());
        return parked;
    }

    private static long longConstant(String name) throws Exception {
        Field field = RoadSageAutoTrackingService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.getLong(null);
    }

    private static double doubleConstant(String name) throws Exception {
        Field field = RoadSageAutoTrackingService.class.getDeclaredField(name);
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
}
