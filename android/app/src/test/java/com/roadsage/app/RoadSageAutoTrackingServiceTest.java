package com.roadsage.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Map;
import java.util.TimeZone;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class RoadSageAutoTrackingServiceTest {

    @Test
    public void nightDrivingUsesDeviceLocalTimeAcrossMidnight() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"));
            ZoneId deviceZone = ZoneId.systemDefault();

            long localEvening = LocalDateTime.of(2026, 1, 1, 23, 0)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long beforeLocalEnd = LocalDateTime.of(2026, 1, 2, 4, 59)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long atLocalEnd = LocalDateTime.of(2026, 1, 2, 5, 0)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();

            assertTrue(RoadSageAutoTrackingService.isNightDrivingEpochMs(localEvening));
            assertTrue(RoadSageAutoTrackingService.isNightDrivingEpochMs(beforeLocalEnd));
            assertFalse(RoadSageAutoTrackingService.isNightDrivingEpochMs(atLocalEnd));
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    public void statsConstantsAndGoldenFixtureMatchJavaScriptTripEngine() throws Exception {
        JSONObject fixture = loadParityFixture();
        JSONObject thresholds = fixture.getJSONObject("thresholds");

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

        JSONArray points = normalizeFixturePoints(fixture.getJSONArray("points"));
        long startMs = parseFixtureTimeMs(fixture.getString("startTime"));
        long endMs = parseFixtureTimeMs(fixture.getString("endTime"));
        Object stats = calculateStats.invoke(service, points, startMs, endMs);
        JSONObject expected = fixture.getJSONObject("expectedStats");

        assertEquals(expected.getDouble("distance_km"), round(doubleField(stats, "distanceKm"), 3), 0.0d);
        assertEquals(expected.getDouble("avg_speed_kmh"), round(doubleField(stats, "avgSpeedKmh"), 1), 0.0d);
        assertEquals(expected.getDouble("avg_running_speed_kmh"), round(doubleField(stats, "avgRunningSpeedKmh"), 1), 0.0d);
        assertEquals(expected.getDouble("max_speed_kmh"), round(doubleField(stats, "maxSpeedKmh"), 1), 0.0d);
        assertEquals(expected.getLong("idle_time_seconds"), longField(stats, "idleSeconds"));
        assertEquals(expected.getLong("gap_seconds"), longField(stats, "gapSeconds"));
        assertEquals(expected.getLong("wall_clock_duration_seconds"), longField(stats, "wallClockDurationSeconds"));
        assertEquals(expected.getLong("duration_seconds"), longField(stats, "durationSeconds"));
        assertEquals(expected.getBoolean("night_driving"), booleanField(stats, "nightDriving"));
    }

    @Test
    public void goldenScoringFixturesKeepNativeStatsAlignedWithJavaScript() throws Exception {
        assertGoldenScoringFixtureStats("urban_smooth_v2_1_0.json");
        assertGoldenScoringFixtureStats("eventful_speeding_v2_1_0.json");
    }

    @Test
    public void noiseFloorFormulaMatchesJavaScriptTripEngine() throws Exception {
        JSONObject fixture = loadParityFixture();
        JSONObject noiseFloorCase = fixture.getJSONArray("noiseFloorCases").getJSONObject(0);

        RoadSageAutoTrackingService service = new RoadSageAutoTrackingService();
        Method noiseFloor = RoadSageAutoTrackingService.class.getDeclaredMethod(
            "noiseFloor",
            double.class,
            double.class
        );
        noiseFloor.setAccessible(true);

        double actual = (double) noiseFloor.invoke(
            service,
            noiseFloorCase.getDouble("previousAccuracy"),
            noiseFloorCase.getDouble("currentAccuracy")
        );
        assertEquals(noiseFloorCase.getDouble("expectedNoiseFloorM"), actual, 0.0d);
    }

    @Test
    public void parkedCarWidgetFormatsAgeAndReadsNativeTimestamp() throws Exception {
        assertEquals("just now", ParkedCarWidgetProvider.formatAge(59_000L));
        assertEquals("10m ago", ParkedCarWidgetProvider.formatAge(10 * 60_000L));
        assertEquals("2h ago", ParkedCarWidgetProvider.formatAge(2 * 60 * 60_000L));
        assertEquals("2h 15m ago", ParkedCarWidgetProvider.formatAge((2 * 60 + 15) * 60_000L));

        JSONObject numericTimestamp = new JSONObject().put("timestamp_ms", 1_700_000_000_000L);
        assertEquals(1_700_000_000_000L, ParkedCarWidgetProvider.parkedTimestampMs(numericTimestamp, 42L));

        JSONObject isoTimestamp = new JSONObject().put("timestamp", "2026-05-31T04:00:00Z");
        assertEquals(Instant.parse("2026-05-31T04:00:00Z").toEpochMilli(), ParkedCarWidgetProvider.parkedTimestampMs(isoTimestamp, 42L));
    }

    @Test
    public void nativeSettingsFieldUpdatesIncrementRevisionAndTimestamp() throws Exception {
        JSONObject current = new JSONObject()
            .put("_settings_revision", 7)
            .put("_settings_updated_at", "2026-01-01T00:00:00.000Z")
            .put("tracking_paused", false);
        Map<String, Object> updates = new HashMap<>();
        updates.put("tracking_paused", true);
        updates.put("background_tracking_enabled", true);

        JSONObject stamped = new JSONObject(NativeSettingsStore.stampedSettingsJson(current.toString(), updates));

        assertEquals(8, stamped.getInt("_settings_revision"));
        assertTrue(stamped.getBoolean("tracking_paused"));
        assertTrue(stamped.getBoolean("background_tracking_enabled"));
        assertTrue(stamped.getString("_settings_updated_at").endsWith("Z"));
        assertFalse("timestamp should be refreshed", "2026-01-01T00:00:00.000Z".equals(stamped.getString("_settings_updated_at")));
    }

    private static JSONObject loadParityFixture() throws Exception {
        try (InputStream stream = RoadSageAutoTrackingServiceTest.class
            .getClassLoader()
            .getResourceAsStream("androidTripStatsParityFixture.json")) {
            assertNotNull("Missing shared Android/JS parity fixture", stream);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static JSONObject loadGoldenScoringFixture(String name) throws Exception {
        try (InputStream stream = RoadSageAutoTrackingServiceTest.class
            .getClassLoader()
            .getResourceAsStream(name)) {
            assertNotNull("Missing shared golden scoring fixture " + name, stream);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertGoldenScoringFixtureStats(String name) throws Exception {
        JSONObject fixture = loadGoldenScoringFixture(name);

        assertEquals(
            fixture.getString("scoring_version"),
            fixture.getJSONObject("expected").getJSONObject("score_provenance").getString("scoring_version")
        );
        assertTrue(fixture.getBoolean("human_verified"));
        assertTrue(fixture.getJSONArray("points").length() > 1);
        assertTrue(fixture.getJSONObject("expected").getJSONObject("scores").has("score_overall"));

        RoadSageAutoTrackingService service = new RoadSageAutoTrackingService();
        Method calculateStats = RoadSageAutoTrackingService.class.getDeclaredMethod(
            "calculateStats",
            JSONArray.class,
            long.class,
            long.class
        );
        calculateStats.setAccessible(true);

        JSONArray points = normalizeFixturePoints(fixture.getJSONArray("points"));
        long startMs = parseFixtureTimeMs(fixture.getString("startTime"));
        long endMs = parseFixtureTimeMs(fixture.getString("endTime"));
        Object stats = calculateStats.invoke(service, points, startMs, endMs);
        JSONObject expected = fixture.getJSONObject("expected").getJSONObject("stats");

        assertEquals(expected.getDouble("distance_km"), round(doubleField(stats, "distanceKm"), 3), 0.0d);
        assertEquals(expected.getDouble("avg_speed_kmh"), round(doubleField(stats, "avgSpeedKmh"), 1), 0.0d);
        assertEquals(expected.getDouble("avg_running_speed_kmh"), round(doubleField(stats, "avgRunningSpeedKmh"), 1), 0.0d);
        assertEquals(expected.getDouble("max_speed_kmh"), round(doubleField(stats, "maxSpeedKmh"), 1), 0.0d);
        assertEquals(expected.getLong("idle_time_seconds"), longField(stats, "idleSeconds"));
        assertEquals(expected.getLong("duration_seconds"), longField(stats, "durationSeconds"));
        assertEquals(expected.getBoolean("night_driving"), booleanField(stats, "nightDriving"));
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

    private static long parseFixtureTimeMs(String value) {
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (Exception ignored) {
            return LocalDateTime.parse(value)
                .atZone(ZoneId.systemDefault())
                .toInstant()
                .toEpochMilli();
        }
    }

    private static JSONArray normalizeFixturePoints(JSONArray points) throws Exception {
        JSONArray normalized = new JSONArray(points.toString());
        for (int i = 0; i < normalized.length(); i++) {
            JSONObject point = normalized.getJSONObject(i);
            String timestamp = point.optString("timestamp", "");
            if (!timestamp.isEmpty()) {
                point.put("timestamp", Instant.ofEpochMilli(parseFixtureTimeMs(timestamp)).toString());
            }
        }
        return normalized;
    }
}
