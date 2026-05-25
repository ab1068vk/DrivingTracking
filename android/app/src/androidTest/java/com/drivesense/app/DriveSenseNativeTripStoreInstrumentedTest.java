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
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @After
    public void tearDown() {
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
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
        assertEquals("2.1.0", fixture.getString("scoring_version"));
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
}
