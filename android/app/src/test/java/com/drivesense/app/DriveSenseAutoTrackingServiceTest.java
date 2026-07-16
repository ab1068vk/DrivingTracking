package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.TimeZone;

import com.google.android.gms.location.DetectedActivity;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class DriveSenseAutoTrackingServiceTest {

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

            assertTrue(DriveSenseAutoTrackingService.isNightDrivingEpochMs(localEvening));
            assertTrue(DriveSenseAutoTrackingService.isNightDrivingEpochMs(beforeLocalEnd));
            assertFalse(DriveSenseAutoTrackingService.isNightDrivingEpochMs(atLocalEnd));
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

        DriveSenseAutoTrackingService service = new DriveSenseAutoTrackingService();
        Method calculateStats = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "calculateStats",
            JSONArray.class,
            long.class,
            long.class
        );
        calculateStats.setAccessible(true);

        JSONArray points = fixture.getJSONArray("points");
        long startMs = parseFixtureTimestamp(fixture.getString("startTime"));
        long endMs = parseFixtureTimestamp(fixture.getString("endTime"));
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

        DriveSenseAutoTrackingService service = new DriveSenseAutoTrackingService();
        Method noiseFloor = DriveSenseAutoTrackingService.class.getDeclaredMethod(
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
    public void nativeStatsInferSpeedFromMovingCoordinatesWhenReportedSpeedIsZero() throws Exception {
        JSONArray points = new JSONArray();
        long startMs = Instant.parse("2026-01-01T12:00:00Z").toEpochMilli();
        points.put(routePoint(43.650, -79.380, startMs, 0d));
        points.put(routePoint(43.651, -79.380, startMs + 10_000L, 0d));
        points.put(routePoint(43.652, -79.380, startMs + 20_000L, 0d));
        points.put(routePoint(43.653, -79.380, startMs + 30_000L, 0d));
        points.put(routePoint(43.654, -79.380, startMs + 40_000L, 0d));
        points.put(routePoint(43.655, -79.380, startMs + 50_000L, 0d));

        Object stats = calculateStats(points, startMs, startMs + 50_000L);

        assertTrue(doubleField(stats, "distanceKm") > 0.5d);
        assertTrue(doubleField(stats, "maxSpeedKmh") > 35d);
        assertTrue(doubleField(stats, "avgRunningSpeedKmh") > 35d);
    }

    @Test
    public void nativeStatsCountFrequentVehicleSpeedSamplesBelowNoiseFloor() throws Exception {
        JSONArray points = new JSONArray();
        long startMs = Instant.parse("2026-01-01T12:00:00Z").toEpochMilli();
        for (int index = 0; index <= 10; index++) {
            JSONObject point = routePoint(
                43.650 + index * 0.000135,
                -79.380,
                startMs + index * 1_000L,
                54d
            );
            point.put("accuracy", 30d);
            points.put(point);
        }

        Object stats = calculateStats(points, startMs, startMs + 10_000L);

        assertTrue(doubleField(stats, "distanceKm") > 0.14d);
        assertTrue(doubleField(stats, "distanceKm") < 0.17d);
    }

    @Test
    public void nativeStatsIgnoreLongGpsGapDistance() throws Exception {
        JSONArray points = new JSONArray();
        long startMs = Instant.parse("2026-01-01T12:00:00Z").toEpochMilli();
        points.put(routePoint(43.650, -79.380, startMs, 40d));
        points.put(routePoint(43.651, -79.380, startMs + 10_000L, 40d));
        points.put(routePoint(45.900, -79.380, startMs + 3 * 60 * 60 * 1000L, 0d));
        points.put(routePoint(45.901, -79.380, startMs + 3 * 60 * 60 * 1000L + 10_000L, 40d));

        Object stats = calculateStats(points, startMs, startMs + 3 * 60 * 60 * 1000L + 10_000L);

        assertTrue(doubleField(stats, "distanceKm") < 0.3d);
        assertTrue(longField(stats, "gapSeconds") > 120L);
        assertTrue(doubleField(stats, "maxSpeedKmh") < 80d);
    }

    @Test
    public void nativeLiveAlertMathUsesConfiguredThresholds() {
        assertFalse(DriveSenseAutoTrackingService.shouldTriggerSpeedAlert(105d, 100d, 5d));
        assertTrue(DriveSenseAutoTrackingService.shouldTriggerSpeedAlert(106d, 100d, 5d));

        assertEquals(
            -5d,
            DriveSenseAutoTrackingService.calculateLongitudinalAccelerationMs2(72d, 36d, 2_000L),
            0.0001d
        );
        assertEquals(
            0.4944d,
            DriveSenseAutoTrackingService.calculateLateralG(40d, 50d, 2_000L),
            0.001d
        );
        assertEquals(
            0d,
            DriveSenseAutoTrackingService.calculateAngularStdDev(new double[]{ 358d, 0d, 2d }),
            2.0d
        );
        assertTrue(DriveSenseAutoTrackingService.calculateAngularStdDev(new double[]{ 350d, 10d, 40d }) > 15d);
    }

    @Test
    public void nativePossibleIncidentDetectorMatchesBackgroundWorkflowGate() throws Exception {
        long now = Instant.parse("2026-01-01T12:00:20Z").toEpochMilli();
        JSONArray points = new JSONArray()
            .put(routePoint(43.6500d, -79.3800d, now - 12_000L, 45d))
            .put(routePoint(43.6501d, -79.3800d, now - 10_000L, 0d))
            .put(routePoint(43.6501d, -79.3800d, now, 0d));
        JSONArray samples = new JSONArray()
            .put(motionSample(now - 2_000L, 0d, 0d))
            .put(motionSample(now - 1_000L, 26d, 120d))
            .put(motionSample(now, 0d, 0d));

        JSONObject incident = DriveSenseAutoTrackingService.detectNativePossibleIncident(
            points,
            samples,
            DetectedActivity.STILL,
            80,
            true
        );

        assertNotNull(incident);
        assertEquals("possible_crash", incident.getString("type"));
        assertEquals("medium", incident.getString("severity"));
        assertEquals(45L, incident.getLong("speed_before_kmh"));
        assertEquals(10L, incident.getLong("stopped_seconds"));
        assertEquals("still", incident.getString("activity_type"));
        assertNull(DriveSenseAutoTrackingService.detectNativePossibleIncident(
            points,
            samples,
            DetectedActivity.STILL,
            80,
            false
        ));
    }

    @Test
    public void nativeBackgroundSpeedLookupUsesLatestMatchingUserCorrection() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        String geohash = DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6);
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", geohash)
                    .put("limitKmh", 50d)
                    .put("source", "user_entered_estimate")
                    .put("appliedAt", "2026-06-16T12:00:00Z"))
                .put(new JSONObject()
                    .put("geohash", geohash)
                    .put("limitKmh", 70d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("appliedAt", "2026-06-17T12:00:00Z")));

        DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, Instant.parse("2026-06-17T13:00:00Z").toEpochMilli());

        assertNotNull(resolved);
        assertEquals(70d, resolved.limitKmh, 0.0d);
        assertEquals("user_confirmed_posted_sign", resolved.source);
    }

    @Test
    public void nativeBackgroundSpeedLookupIgnoresExpiredOrDifferentRoadCells() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6))
                    .put("limitKmh", 70d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("expiresAt", "2026-06-17T11:00:00Z"))
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(45.4215d, -75.6972d, 6))
                    .put("limitKmh", 40d)
                    .put("source", "user_confirmed_posted_sign")));

        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(
            data,
            lat,
            lng,
            Instant.parse("2026-06-17T13:00:00Z").toEpochMilli()
        ));
    }

    @Test
    public void nativeBackgroundSpeedLookupMatchesTracedCurvedRoadSections() throws Exception {
        double sectionLat = 43.65320d;
        double sectionLng = -79.38320d;
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(sectionLat, sectionLng, 6))
                    .put("limitKmh", 40d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("appliedAt", "2026-06-17T12:00:00Z")
                    .put("sectionPoints", new JSONArray()
                        .put(new JSONObject().put("lat", 43.65300d).put("lng", -79.38400d))
                        .put(new JSONObject().put("lat", 43.65335d).put("lng", -79.38335d))
                        .put(new JSONObject().put("lat", 43.65385d).put("lng", -79.38295d)))));

        DriveSenseAutoTrackingService.NativeSpeedLimit nearCurve =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(
                data,
                43.65339d,
                -79.38332d,
                Instant.parse("2026-06-17T13:00:00Z").toEpochMilli()
            );

        assertNotNull(nearCurve);
        assertEquals(40d, nearCurve.limitKmh, 0.0d);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(
            data,
            43.66100d,
            -79.38320d,
            Instant.parse("2026-06-17T13:00:00Z").toEpochMilli()
        ));
    }

    @Test
    public void nativeBackgroundSpeedLookupRespectsAdjacentUserLabeledSections() throws Exception {
        double lat = 43.65320d;
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(lat, -79.3857d, 6))
                    .put("limitKmh", 50d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("appliedAt", "2026-06-23T12:00:00Z")
                    .put("sectionPoints", new JSONArray()
                        .put(new JSONObject().put("lat", lat).put("lng", -79.3860d))
                        .put(new JSONObject().put("lat", lat).put("lng", -79.3852d))))
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(lat, -79.3827d, 6))
                    .put("limitKmh", 60d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("appliedAt", "2026-06-23T12:01:00Z")
                    .put("sectionPoints", new JSONArray()
                        .put(new JSONObject().put("lat", lat).put("lng", -79.3830d))
                        .put(new JSONObject().put("lat", lat).put("lng", -79.3822d)))));
        long activeTime = Instant.parse("2026-06-23T12:05:00Z").toEpochMilli();

        DriveSenseAutoTrackingService.NativeSpeedLimit firstHalf =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, -79.38555d, activeTime);
        DriveSenseAutoTrackingService.NativeSpeedLimit secondHalf =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, -79.38255d, activeTime);

        assertNotNull(firstHalf);
        assertEquals(50d, firstHalf.limitKmh, 0.0d);
        assertEquals("user_confirmed_posted_sign", firstHalf.source);
        assertNotNull(secondHalf);
        assertEquals(60d, secondHalf.limitKmh, 0.0d);
        assertEquals("user_confirmed_posted_sign", secondHalf.source);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, -79.38410d, activeTime));
    }

    @Test
    public void nativeBackgroundSpeedLookupPrefersHeadingAlignedSectionAtIntersection() throws Exception {
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(43.6500d, -79.3800d, 6))
                    .put("limitKmh", 50d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("appliedAt", "2026-06-23T12:00:00Z")
                    .put("sectionPoints", new JSONArray()
                        .put(new JSONObject().put("lat", 43.6490d).put("lng", -79.3800d))
                        .put(new JSONObject().put("lat", 43.6510d).put("lng", -79.3800d))))
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(43.6500d, -79.3800d, 6))
                    .put("limitKmh", 40d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("appliedAt", "2026-06-23T12:01:00Z")
                    .put("sectionPoints", new JSONArray()
                        .put(new JSONObject().put("lat", 43.6500d).put("lng", -79.3810d))
                        .put(new JSONObject().put("lat", 43.6500d).put("lng", -79.3790d)))));
        long activeTime = Instant.parse("2026-06-23T12:05:00Z").toEpochMilli();

        DriveSenseAutoTrackingService.NativeSpeedLimit northbound =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, 43.6500d, -79.3800d, 0d, activeTime);
        DriveSenseAutoTrackingService.NativeSpeedLimit eastbound =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, 43.6500d, -79.3800d, 90d, activeTime);

        assertNotNull(northbound);
        assertEquals(50d, northbound.limitKmh, 0.0d);
        assertNotNull(eastbound);
        assertEquals(40d, eastbound.limitKmh, 0.0d);
    }

    @Test
    public void nativeBackgroundSpeedLookupHonorsDirectionAndTimeRules() throws Exception {
        double sectionLat = 43.65320d;
        double sectionLng = -79.38320d;
        JSONObject timeRule = new JSONObject()
            .put("enabled", true)
            .put("days", new JSONArray().put(1).put(2).put(3).put(4).put(5))
            .put("startMinutes", 7 * 60)
            .put("endMinutes", 9 * 60);
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", DriveSenseAutoTrackingService.geohashEncode(sectionLat, sectionLng, 6))
                    .put("limitKmh", 30d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("directionMode", "forward")
                    .put("timeRule", timeRule)
                    .put("sectionPoints", new JSONArray()
                        .put(new JSONObject().put("lat", 43.65320d).put("lng", -79.38400d))
                        .put(new JSONObject().put("lat", 43.65320d).put("lng", -79.38200d)))));
        long mondayMorning = LocalDateTime.of(2026, 1, 5, 8, 0)
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli();
        long mondayLate = LocalDateTime.of(2026, 1, 5, 10, 0)
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli();

        DriveSenseAutoTrackingService.NativeSpeedLimit matching =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, sectionLat, sectionLng, 90d, mondayMorning);

        assertNotNull(matching);
        assertEquals(30d, matching.limitKmh, 0.0d);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, sectionLat, sectionLng, 270d, mondayMorning));
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, sectionLat, sectionLng, 90d, mondayLate));
    }

    private static JSONObject loadParityFixture() throws Exception {
        try (InputStream stream = DriveSenseAutoTrackingServiceTest.class
            .getClassLoader()
            .getResourceAsStream("androidTripStatsParityFixture.json")) {
            assertNotNull("Missing shared Android/JS parity fixture", stream);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static JSONObject loadGoldenScoringFixture(String name) throws Exception {
        try (InputStream stream = DriveSenseAutoTrackingServiceTest.class
            .getClassLoader()
            .getResourceAsStream(name)) {
            assertNotNull("Missing shared golden scoring fixture " + name, stream);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertGoldenScoringFixtureStats(String name) throws Exception {
        JSONObject fixture = loadGoldenScoringFixture(name);

        String scoringVersion = fixture.getString("scoring_version");
        assertTrue(scoringVersion.matches("^[a-f0-9]{8}$"));
        assertTrue(fixture.getBoolean("human_verified"));
        assertTrue(fixture.getJSONArray("points").length() > 1);
        assertTrue(fixture.getJSONObject("expected").getJSONObject("scores").has("score_overall"));
        assertEquals(
            scoringVersion,
            fixture.getJSONObject("expected").getJSONObject("score_provenance").getString("scoring_version")
        );

        DriveSenseAutoTrackingService service = new DriveSenseAutoTrackingService();
        Method calculateStats = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "calculateStats",
            JSONArray.class,
            long.class,
            long.class
        );
        calculateStats.setAccessible(true);

        JSONArray points = fixture.getJSONArray("points");
        long startMs = parseFixtureTimestamp(fixture.getString("startTime"));
        long endMs = parseFixtureTimestamp(fixture.getString("endTime"));
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

    private static Object calculateStats(JSONArray points, long startMs, long endMs) throws Exception {
        DriveSenseAutoTrackingService service = new DriveSenseAutoTrackingService();
        Method calculateStats = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "calculateStats",
            JSONArray.class,
            long.class,
            long.class
        );
        calculateStats.setAccessible(true);
        return calculateStats.invoke(service, points, startMs, endMs);
    }

    private static JSONObject routePoint(double lat, double lng, long timestampMs, double speedKmh) throws Exception {
        JSONObject point = new JSONObject();
        point.put("lat", lat);
        point.put("lng", lng);
        point.put("timestamp", Instant.ofEpochMilli(timestampMs).toString());
        point.put("timestamp_ms", timestampMs);
        point.put("speed_kmh", speedKmh);
        point.put("accuracy", 5d);
        return point;
    }

    private static JSONObject motionSample(long timestampMs, double linearMs2, double rotationDegS) throws Exception {
        JSONObject sample = new JSONObject();
        sample.put("timestamp", Instant.ofEpochMilli(timestampMs).toString());
        sample.put("timestamp_ms", timestampMs);
        sample.put("linear_magnitude_ms2", linearMs2);
        sample.put("rotation_magnitude_deg_s", rotationDegS);
        return sample;
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

    private static long parseFixtureTimestamp(String value) {
        if (value.endsWith("Z")) {
            return Instant.parse(value).toEpochMilli();
        }
        return LocalDateTime.parse(value)
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli();
    }

    private static double round(double value, int decimals) {
        double factor = Math.pow(10d, decimals);
        return Math.round(value * factor) / factor;
    }
}
