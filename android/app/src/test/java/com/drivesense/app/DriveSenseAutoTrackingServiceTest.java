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
import java.time.ZoneOffset;
import java.util.TimeZone;

import com.google.android.gms.location.DetectedActivity;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class DriveSenseAutoTrackingServiceTest {

    @Test
    public void verifiedParkingCannotBeDowngradedBySameTripCandidate() throws Exception {
        JSONObject existing = new JSONObject()
            .put("tripId", "trip-42")
            .put("confidence_score", 100)
            .put("verified", true);
        JSONObject walkingCandidate = new JSONObject()
            .put("tripId", "trip-42")
            .put("confidence_score", 50)
            .put("verified", false);
        JSONObject verifiedCorrection = new JSONObject()
            .put("tripId", "trip-42")
            .put("confidence_score", 50)
            .put("verified", true);
        JSONObject anotherTrip = new JSONObject()
            .put("tripId", "trip-43")
            .put("confidence_score", 25)
            .put("verified", false);

        assertTrue(DriveSenseNativeTripStore.shouldPreserveHigherConfidence(existing, walkingCandidate));
        assertFalse(DriveSenseNativeTripStore.shouldPreserveHigherConfidence(existing, verifiedCorrection));
        assertFalse(DriveSenseNativeTripStore.shouldPreserveHigherConfidence(existing, anotherTrip));
    }

    @Test
    public void administrativeTrackingStopsAreNotParkingEvents() {
        assertTrue(DriveSenseAutoTrackingService.isAdministrativeStopReason("service_stopped_by_user"));
        assertTrue(DriveSenseAutoTrackingService.isAdministrativeStopReason("service_destroyed"));
        assertTrue(DriveSenseAutoTrackingService.isAdministrativeStopReason("manual_trip_replaced_existing_native_trip"));
        assertFalse(DriveSenseAutoTrackingService.isAdministrativeStopReason("notification_end_trip"));
        assertFalse(DriveSenseAutoTrackingService.isAdministrativeStopReason("parked_gps_stable"));
    }

    @Test
    public void activeTripCheckpointCompactsLongRoutesWithinHardLimit() throws Exception {
        JSONArray points = new JSONArray();
        long startMs = Instant.parse("2026-07-22T17:17:00Z").toEpochMilli();
        for (int index = 0; index < 12_000; index++) {
            JSONObject point = routePoint(
                43.65d + index * 0.000001d,
                -79.38d,
                startMs + index * 2_000L,
                54d
            );
            point.put("unbounded_debug_field", "must-not-enter-checkpoint");
            points.put(point);
        }

        JSONArray compacted = DriveSenseActiveTripCheckpointStore.compactRoutePoints(points);
        JSONObject payload = new JSONObject()
            .put("version", DriveSenseActiveTripCheckpointStore.VERSION)
            .put("trip_id", "native-trip-size-test")
            .put("start_time_ms", startMs)
            .put("updated_at_ms", startMs + 24_000_000L)
            .put("route_points", compacted)
            .put("timeline", new JSONArray())
            .put("incident_events", new JSONArray());

        assertEquals(DriveSenseActiveTripCheckpointStore.MAX_ROUTE_POINTS, compacted.length());
        assertEquals(points.getJSONObject(0).getDouble("lat"), compacted.getJSONObject(0).getDouble("lat"), 0d);
        assertEquals(
            points.getJSONObject(points.length() - 1).getDouble("lat"),
            compacted.getJSONObject(compacted.length() - 1).getDouble("lat"),
            0d
        );
        assertFalse(compacted.getJSONObject(0).has("unbounded_debug_field"));
        assertTrue(
            DriveSenseActiveTripCheckpointStore.utf8Size(payload) <
                DriveSenseActiveTripCheckpointStore.MAX_PLAINTEXT_BYTES
        );
    }

    @Test
    public void activeTripCheckpointBoundsTimelineAndIncidentHistory() throws Exception {
        JSONArray events = new JSONArray();
        for (int index = 0; index < 100; index++) {
            events.put(new JSONObject().put("id", index));
        }

        JSONArray timeline = DriveSenseActiveTripCheckpointStore.compactTail(
            events,
            DriveSenseActiveTripCheckpointStore.MAX_TIMELINE_EVENTS
        );
        JSONArray incidents = DriveSenseActiveTripCheckpointStore.compactTail(
            events,
            DriveSenseActiveTripCheckpointStore.MAX_INCIDENT_EVENTS
        );

        assertEquals(DriveSenseActiveTripCheckpointStore.MAX_TIMELINE_EVENTS, timeline.length());
        assertEquals(60, timeline.getJSONObject(0).optInt("id"));
        assertEquals(DriveSenseActiveTripCheckpointStore.MAX_INCIDENT_EVENTS, incidents.length());
        assertEquals(96, incidents.getJSONObject(0).optInt("id"));
    }

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
    public void nightDrivingUsesGpsSunsetModeWhenCoordinatesExist() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/Toronto"));
            ZoneId deviceZone = ZoneId.systemDefault();
            DriveSenseAutoTrackingService.NightSettings sunsetSettings =
                new DriveSenseAutoTrackingService.NightSettings("sunset", 22 * 60, 5 * 60, 0d, 0d);

            long winterEvening = LocalDateTime.of(2026, 1, 1, 17, 30)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long winterNoon = LocalDateTime.of(2026, 1, 1, 12, 0)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();

            assertTrue(DriveSenseAutoTrackingService.isNightDrivingPoint(
                winterEvening,
                43.6532d,
                -79.3832d,
                sunsetSettings
            ));
            assertFalse(DriveSenseAutoTrackingService.isNightDrivingPoint(
                winterNoon,
                43.6532d,
                -79.3832d,
                sunsetSettings
            ));
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    public void nightDrivingFallsBackToCustomWindowWhenGpsCoordinatesAreMissing() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/Toronto"));
            ZoneId deviceZone = ZoneId.systemDefault();
            DriveSenseAutoTrackingService.NightSettings sunsetSettings =
                new DriveSenseAutoTrackingService.NightSettings("sunset", 21 * 60, 4 * 60, 0d, 0d);

            long insideCustomFallback = LocalDateTime.of(2026, 7, 1, 21, 30)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long outsideCustomFallback = LocalDateTime.of(2026, 7, 1, 20, 30)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();

            assertTrue(DriveSenseAutoTrackingService.isNightDrivingPoint(
                insideCustomFallback,
                Double.NaN,
                Double.NaN,
                sunsetSettings
            ));
            assertFalse(DriveSenseAutoTrackingService.isNightDrivingPoint(
                outsideCustomFallback,
                Double.NaN,
                Double.NaN,
                sunsetSettings
            ));
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    public void tripNightDrivingIncludesFirstPointAndIgnoresInvalidTimestamps() throws Exception {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/Toronto"));
            ZoneId deviceZone = ZoneId.systemDefault();
            DriveSenseAutoTrackingService.NightSettings customSettings =
                new DriveSenseAutoTrackingService.NightSettings("custom", 22 * 60, 5 * 60, 0d, 0d);
            long beforeNightWindowEnds = LocalDateTime.of(2026, 1, 2, 4, 59)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long afterNightWindowEnds = LocalDateTime.of(2026, 1, 2, 5, 1)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            JSONArray points = new JSONArray()
                .put(routePoint(43.6532d, -79.3832d, beforeNightWindowEnds, 30d))
                .put(new JSONObject().put("timestamp", "invalid"))
                .put(routePoint(43.6542d, -79.3832d, afterNightWindowEnds, 30d));

            assertTrue(DriveSenseAutoTrackingService.isTripNightDriving(points, customSettings));

            JSONArray daytimeOnly = new JSONArray()
                .put(new JSONObject().put("timestamp", "invalid"))
                .put(routePoint(43.6542d, -79.3832d, afterNightWindowEnds, 30d));
            assertFalse(DriveSenseAutoTrackingService.isTripNightDriving(daytimeOnly, customSettings));
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    public void nightClassificationSupportsCivilTwilightAndBufferedBoundaryCrossings() throws Exception {
        DriveSenseAutoTrackingService.NightSettings unbufferedSunset =
            new DriveSenseAutoTrackingService.NightSettings("sunset", 22 * 60, 5 * 60, 0d, 0d, 0);
        DriveSenseAutoTrackingService.NightSettings civil =
            new DriveSenseAutoTrackingService.NightSettings("civil_twilight", 22 * 60, 5 * 60, 0d, 0d, 0);
        JSONObject twilightPoint = routePoint(
            43.6532d,
            -79.3832d,
            Instant.parse("2026-01-01T22:05:00Z").toEpochMilli(),
            30d
        ).put("timezone_id", "America/Toronto").put("utc_offset_minutes", -300);

        DriveSenseAutoTrackingService.NightClassificationResult sunsetResult =
            DriveSenseAutoTrackingService.classifyTripNightDriving(
                new JSONArray().put(twilightPoint),
                unbufferedSunset
            );
        DriveSenseAutoTrackingService.NightClassificationResult civilResult =
            DriveSenseAutoTrackingService.classifyTripNightDriving(
                new JSONArray().put(twilightPoint),
                civil
            );

        assertTrue(sunsetResult.isNight);
        assertFalse(civilResult.isNight);
        assertEquals("civil_twilight", civilResult.metadata.getString("solar_event_type"));
        assertTrue(
            civilResult.metadata.getString("evening_event_local_time").compareTo(
                sunsetResult.metadata.getString("evening_event_local_time")
            ) > 0
        );

        String[] sunsetParts = sunsetResult.metadata.getString("evening_event_local_time").split(":");
        int sunsetHour = Integer.parseInt(sunsetParts[0]);
        int sunsetMinute = Integer.parseInt(sunsetParts[1]);
        long beforeBufferedBoundary = LocalDateTime.of(2026, 1, 1, sunsetHour, sunsetMinute)
            .plusMinutes(3)
            .toInstant(ZoneOffset.ofHours(-5))
            .toEpochMilli();
        long afterBufferedBoundary = LocalDateTime.of(2026, 1, 1, sunsetHour, sunsetMinute)
            .plusMinutes(7)
            .toInstant(ZoneOffset.ofHours(-5))
            .toEpochMilli();
        JSONArray crossingPoints = new JSONArray()
            .put(routePoint(43.6532d, -79.3832d, beforeBufferedBoundary, 30d)
                .put("timezone_id", "America/Toronto").put("utc_offset_minutes", -300))
            .put(routePoint(43.6532d, -79.3832d, afterBufferedBoundary, 30d)
                .put("timezone_id", "America/Toronto").put("utc_offset_minutes", -300));
        DriveSenseAutoTrackingService.NightClassificationResult crossing =
            DriveSenseAutoTrackingService.classifyTripNightDriving(
                crossingPoints,
                new DriveSenseAutoTrackingService.NightSettings("sunset", 22 * 60, 5 * 60, 0d, 0d, 5)
            );

        assertTrue(crossing.isNight);
        assertFalse(crossing.metadata.getBoolean("trip_started_in_night"));
        assertEquals(5, crossing.metadata.getInt("boundary_tolerance_minutes"));
        assertEquals(crossingPoints.getJSONObject(1).getString("timestamp"), crossing.metadata.getString("decision_point_at"));
    }

    @Test
    public void nightClassificationPersistsDstAndTripTimezoneContext() throws Exception {
        DriveSenseAutoTrackingService.NightSettings custom =
            new DriveSenseAutoTrackingService.NightSettings("custom", 22 * 60, 5 * 60, 0d, 0d, 5);
        JSONObject winterPoint = new JSONObject()
            .put("timestamp", "2026-03-08T04:30:00Z")
            .put("timezone_id", "America/Toronto")
            .put("utc_offset_minutes", -300);
        JSONObject summerPoint = new JSONObject()
            .put("timestamp", "2026-03-09T03:30:00Z")
            .put("timezone_id", "America/Toronto")
            .put("utc_offset_minutes", -240);

        DriveSenseAutoTrackingService.NightClassificationResult winter =
            DriveSenseAutoTrackingService.classifyTripNightDriving(new JSONArray().put(winterPoint), custom);
        DriveSenseAutoTrackingService.NightClassificationResult summer =
            DriveSenseAutoTrackingService.classifyTripNightDriving(new JSONArray().put(summerPoint), custom);
        JSONArray timezoneCrossing = new JSONArray()
            .put(new JSONObject()
                .put("timestamp", "2026-07-01T19:00:00Z")
                .put("timezone_id", "Europe/London")
                .put("utc_offset_minutes", 60))
            .put(new JSONObject()
                .put("timestamp", "2026-07-02T03:30:00Z")
                .put("timezone_id", "America/Toronto")
                .put("utc_offset_minutes", -240));
        DriveSenseAutoTrackingService.NightClassificationResult crossing =
            DriveSenseAutoTrackingService.classifyTripNightDriving(timezoneCrossing, custom);

        assertEquals("23:30", winter.metadata.getString("trip_start_local_time"));
        assertEquals(-300, winter.metadata.getInt("utc_offset_minutes"));
        assertEquals("23:30", summer.metadata.getString("trip_start_local_time"));
        assertEquals(-240, summer.metadata.getInt("utc_offset_minutes"));
        assertEquals("Europe/London", crossing.metadata.getString("timezone_id"));
        assertEquals(60, crossing.metadata.getInt("utc_offset_minutes"));
        assertEquals(2, crossing.metadata.getInt("evaluated_point_count"));
        assertFalse(crossing.metadata.getBoolean("trip_started_in_night"));
        assertEquals("2026-07-02T03:30:00Z", crossing.metadata.getString("decision_point_at"));
    }

    @Test
    public void nightClassificationRecordsGpsAndPolarFallbackDiagnostics() throws Exception {
        DriveSenseAutoTrackingService.NightSettings civil =
            new DriveSenseAutoTrackingService.NightSettings("civil_twilight", 22 * 60, 5 * 60, 0d, 0d, 5);
        JSONObject missingGps = new JSONObject()
            .put("timestamp", "2026-01-01T23:30:00Z")
            .put("timezone_id", "UTC")
            .put("utc_offset_minutes", 0);
        JSONObject polarSummer = routePoint(
            69.6492d,
            18.9553d,
            Instant.parse("2026-06-21T10:00:00Z").toEpochMilli(),
            30d
        ).put("timezone_id", "Europe/Oslo").put("utc_offset_minutes", 120);

        DriveSenseAutoTrackingService.NightClassificationResult missing =
            DriveSenseAutoTrackingService.classifyTripNightDriving(new JSONArray().put(missingGps), civil);
        DriveSenseAutoTrackingService.NightClassificationResult polar =
            DriveSenseAutoTrackingService.classifyTripNightDriving(new JSONArray().put(polarSummer), civil);

        assertTrue(missing.metadata.getBoolean("custom_fallback_used"));
        assertEquals("gps_coordinates_unavailable", missing.metadata.getString("fallback_reason"));
        assertEquals("custom_fallback", missing.metadata.getString("method"));
        assertTrue(polar.metadata.getBoolean("custom_fallback_used"));
        assertEquals("solar_event_unavailable", polar.metadata.getString("fallback_reason"));
        assertEquals(1, polar.metadata.getInt("fallback_point_count"));
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
        JSONArray section = new JSONArray()
            .put(new JSONObject().put("lat", lat).put("lng", lng - 0.001d))
            .put(new JSONObject().put("lat", lat).put("lng", lng + 0.001d));
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray()
                .put(new JSONObject()
                    .put("geohash", geohash)
                    .put("limitKmh", 50d)
                    .put("source", "user_entered_estimate")
                    .put("sectionPoints", section)
                    .put("appliedAt", "2026-06-16T12:00:00Z"))
                .put(new JSONObject()
                    .put("geohash", geohash)
                    .put("limitKmh", 70d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("sectionPoints", section)
                    .put("appliedAt", "2026-06-17T12:00:00Z"))
                .put(new JSONObject()
                    .put("geohash", geohash)
                    .put("limitKmh", 250d)
                    .put("source", "user_confirmed_posted_sign")
                    .put("sectionPoints", section)
                    .put("appliedAt", "2026-06-17T12:30:00Z")));

        DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, Instant.parse("2026-06-17T13:00:00Z").toEpochMilli());

        assertNotNull(resolved);
        assertEquals(70d, resolved.limitKmh, 0.0d);
        assertEquals("user_confirmed_posted_sign", resolved.source);
    }

    @Test
    public void nativeBackgroundSpeedLookupUsesActiveRoadMemoryCandidateAsEstimate() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        String geohash = DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6);
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray())
            .put("roadMemory", new JSONObject()
                .put("candidates", new JSONArray()
                    .put(new JSONObject()
                        .put("id", "road-memory-test")
                        .put("geohash", geohash)
                        .put("limitKmh", 50d)
                        .put("source", "local_road_memory")
                        .put("intelligenceValidated", true)
                        .put("active", true)
                        .put("confidence", 0.66d)
                        .put("tripCount", 3)
                        .put("lastObservedAt", "2026-07-28T12:00:00Z")
                        .put("directionMode", "forward")
                        .put("directionBearing", 90d)
                        .put("sectionPoints", new JSONArray()
                            .put(new JSONObject().put("lat", lat).put("lng", lng - 0.001d))
                            .put(new JSONObject().put("lat", lat).put("lng", lng + 0.001d))))));

        DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(
                data,
                lat,
                lng,
                90d,
                Instant.parse("2026-07-29T12:00:00Z").toEpochMilli()
            );

        assertNotNull(resolved);
        assertEquals(50d, resolved.limitKmh, 0.0d);
        assertEquals("local_road_memory", resolved.source);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(
            data,
            lat,
            lng,
            270d,
            Instant.parse("2026-07-29T12:00:00Z").toEpochMilli()
        ));
    }

    @Test
    public void nativeBackgroundSpeedLookupRejectsUnvalidatedRoadMemoryCandidate() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        JSONObject candidate = new JSONObject()
            .put("id", "road-memory-shadow")
            .put("geohash", DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6))
            .put("limitKmh", 50d)
            .put("active", true)
            .put("stage", "operational")
            .put("confidence", 0.72d)
            .put("tripCount", 8)
            .put("lastObservedAt", "2026-07-28T12:00:00Z")
            .put("sectionPoints", new JSONArray()
                .put(new JSONObject().put("lat", lat).put("lng", lng - 0.001d))
                .put(new JSONObject().put("lat", lat).put("lng", lng + 0.001d)));
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray())
            .put("roadMemory", new JSONObject()
                .put("candidates", new JSONArray().put(candidate)));

        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(
            data,
            lat,
            lng,
            90d,
            Instant.parse("2026-07-29T12:00:00Z").toEpochMilli()
        ));
    }

    @Test
    public void nativeBackgroundSpeedLookupAppliesEligibleRoadMemoryTimeProfile() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        String geohash = DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6);
        long localMorningMs = LocalDateTime.of(2026, 7, 29, 8, 0)
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli();
        JSONObject candidate = new JSONObject()
            .put("id", "road-memory-time-profile")
            .put("geohash", geohash)
            .put("limitKmh", 50d)
            .put("intelligenceValidated", true)
            .put("active", true)
            .put("stage", "operational")
            .put("confidence", 0.68d)
            .put("tripCount", 6)
            .put("lastObservedAt", Instant.ofEpochMilli(localMorningMs - 86400000L).toString())
            .put("timeProfilesAcceptedAt", Instant.ofEpochMilli(localMorningMs - 43200000L).toString())
            .put("directionMode", "forward")
            .put("directionBearing", 90d)
            .put("sectionPoints", new JSONArray()
                .put(new JSONObject().put("lat", lat).put("lng", lng - 0.001d))
                .put(new JSONObject().put("lat", lat).put("lng", lng + 0.001d)))
            .put("timeProfiles", new JSONArray()
                .put(new JSONObject()
                    .put("bucket", "weekday_morning")
                    .put("limitKmh", 250d)
                    .put("tripCount", 4)
                    .put("agreement", 1d)
                    .put("eligible", true))
                .put(new JSONObject()
                    .put("bucket", "weekday_morning")
                    .put("limitKmh", 40d)
                    .put("tripCount", 3)
                    .put("agreement", 1d)
                    .put("eligible", true)));
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray())
            .put("roadMemory", new JSONObject()
                .put("candidates", new JSONArray().put(candidate)));

        DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(
                data,
                lat,
                lng,
                90d,
                localMorningMs
            );

        assertNotNull(resolved);
        assertEquals(40d, resolved.limitKmh, 0.0d);
        assertEquals("local_road_memory", resolved.source);

        candidate.remove("timeProfilesAcceptedAt");
        resolved = DriveSenseAutoTrackingService.findLocalSpeedLimit(
            data,
            lat,
            lng,
            90d,
            localMorningMs
        );
        assertNotNull(resolved);
        assertEquals(50d, resolved.limitKmh, 0.0d);
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
    public void nativeBackgroundSpeedLookupUsesOnlyEligibleLearnedCells() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        String exactCell = DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6);
        String fallbackCell = DriveSenseAutoTrackingService.geohashEncode(lat, lng, 5);
        long queryTime = Instant.parse("2026-07-29T12:00:00Z").toEpochMilli();
        JSONObject exact = new JSONObject()
            .put("limitKmh", 80d)
            .put("source", "trip_consensus")
            .put("confidence", 0.68d)
            .put("tripCount", 1)
            .put("evidenceCount", 1)
            .put("tripEvidenceIds", new JSONArray().put("exact-trip-1"))
            .put("lastUpdatedAt", "2026-07-28T12:00:00Z");
        JSONObject fallback = new JSONObject()
            .put("limitKmh", 50d)
            .put("source", "trip_consensus")
            .put("confidence", 0.68d)
            .put("tripCount", 3)
            .put("evidenceCount", 3)
            .put("tripEvidenceIds", new JSONArray()
                .put("fallback-trip-1")
                .put("fallback-trip-2")
                .put("fallback-trip-3"))
            .put("lastUpdatedAt", "2026-07-28T12:00:00Z");
        JSONObject data = new JSONObject().put("cells", new JSONObject()
            .put(exactCell, exact)
            .put(fallbackCell, fallback));

        DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime);
        assertNotNull(resolved);
        assertEquals(50d, resolved.limitKmh, 0d);
        assertEquals("trip_consensus", resolved.source);

        fallback.remove("tripEvidenceIds");
        assertNotNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime));

        fallback.put("lastUpdatedAt", "2026-04-01T12:00:00Z");
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime));

        fallback.put("lastUpdatedAt", "2026-07-28T12:00:00Z");
        fallback.put("conflict", true);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime));

        fallback.put("conflict", false);
        fallback.put("source", "inferred");
        fallback.put("confidence", 0.90d);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime));

        fallback.put("source", "trip_consensus");
        fallback.put("expiresAt", "2026-07-29T12:00:00Z");
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime));

        fallback.remove("expiresAt");
        fallback.put("limitKmh", 250d);
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, queryTime));
    }

    @Test
    public void nativeSpeedAlertMessagesHonorMetricAndImperialSettings() {
        assertEquals(
            "Speed warning. You are at 100 in a posted 80 kilometers per hour zone. Ease off smoothly.",
            DriveSenseAutoTrackingService.nativeSpeedAlertMessage(
                100d, 80d, true, false, false, "metric"
            )
        );
        assertEquals(
            "Speed warning. You are at 62 in a posted 50 miles per hour zone. Ease off smoothly.",
            DriveSenseAutoTrackingService.nativeSpeedAlertMessage(
                100d, 80d, true, false, false, "imperial"
            )
        );
        assertEquals(
            "Speed threshold exceeded: 62 mph in estimated 50 mph zone.",
            DriveSenseAutoTrackingService.nativeSpeedAlertMessage(
                100d, 80d, false, true, true, "imperial"
            )
        );
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

    @Test
    public void savedSpeedResolverMatchesSharedWebContract() throws Exception {
        JSONObject fixture = loadSavedSpeedResolverParityFixture();
        assertEquals(1, fixture.getInt("contractVersion"));
        JSONArray cases = fixture.getJSONArray("cases");

        for (int index = 0; index < cases.length(); index++) {
            JSONObject testCase = cases.getJSONObject(index);
            JSONObject query = testCase.getJSONObject("query");
            JSONObject expected = testCase.optJSONObject("expected");
            JSONObject knowledge = new JSONObject(testCase.getJSONObject("knowledge").toString());
            String supportSet = testCase.optString("roadMemorySupport", "");
            JSONObject supportSets = fixture.optJSONObject("roadMemoryValidationSupport");
            JSONArray support = supportSets == null ? null : supportSets.optJSONArray(supportSet);
            if (support != null && support.length() > 0) {
                JSONObject roadMemory = knowledge.optJSONObject("roadMemory");
                if (roadMemory == null) {
                    roadMemory = new JSONObject();
                    knowledge.put("roadMemory", roadMemory);
                }
                JSONArray candidates = roadMemory.optJSONArray("candidates");
                JSONArray mergedCandidates = new JSONArray();
                for (int supportIndex = 0; supportIndex < support.length(); supportIndex++) {
                    mergedCandidates.put(new JSONObject(support.getJSONObject(supportIndex).toString()));
                }
                if (candidates != null) {
                    for (int candidateIndex = 0; candidateIndex < candidates.length(); candidateIndex++) {
                        mergedCandidates.put(new JSONObject(candidates.getJSONObject(candidateIndex).toString()));
                    }
                }
                roadMemory.put("candidates", mergedCandidates);
            }
            DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
                DriveSenseAutoTrackingService.findLocalSpeedLimit(
                    knowledge,
                    query.getDouble("lat"),
                    query.getDouble("lng"),
                    query.optDouble("headingDeg", Double.NaN),
                    Instant.parse(query.getString("timestamp")).toEpochMilli(),
                    query.has("utcOffsetMinutes") ? query.getInt("utcOffsetMinutes") : null
                );

            if (expected == null) {
                assertNull(testCase.getString("id"), resolved);
                continue;
            }
            assertNotNull(testCase.getString("id"), resolved);
            assertEquals(testCase.getString("id"), expected.getDouble("limitKmh"), resolved.limitKmh, 0d);
            assertEquals(testCase.getString("id"), expected.getString("source"), resolved.source);
        }
    }

    @Test
    public void nativeBackgroundSpeedLookupHonorsExclusionsAndConservativeLegacyRadius() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        JSONObject correction = new JSONObject()
            .put("geohash", DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6))
            .put("limitKmh", 50d)
            .put("source", "user_confirmed_posted_sign")
            .put("sectionPoints", new JSONArray()
                .put(new JSONObject().put("lat", lat).put("lng", lng - 0.001d))
                .put(new JSONObject().put("lat", lat).put("lng", lng + 0.001d)));
        JSONObject excluded = new JSONObject()
            .put("id", "private-parking-section")
            .put("reason", "parking_private")
            .put("directionMode", "forward")
            .put("directionBearing", 90d)
            .put("sectionPoints", correction.getJSONArray("sectionPoints"));
        JSONObject data = new JSONObject()
            .put("corrections", new JSONArray().put(correction))
            .put("excludedSections", new JSONArray().put(excluded));
        long queryTime = Instant.parse("2026-07-01T12:00:00Z").toEpochMilli();

        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, 90d, queryTime));
        assertNotNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, 270d, queryTime));

        String geohash = DriveSenseAutoTrackingService.geohashEncode(lat, lng, 6);
        double[] center = DriveSenseAutoTrackingService.geohashCenter(geohash);
        JSONObject legacy = new JSONObject().put("corrections", new JSONArray().put(new JSONObject()
            .put("geohash", geohash)
            .put("limitKmh", 40d)
            .put("source", "user_confirmed_posted_sign")));
        // About 500 m north: inside the former native 800 m bleed radius but
        // outside the web/native 350 m legacy-cell contract.
        assertNull(DriveSenseAutoTrackingService.findLocalSpeedLimit(
            legacy,
            center[0] + (0.5d / 111d),
            center[1],
            queryTime
        ));
    }

    @Test
    public void nativeRoadMemoryUsesWebEligibilityAndRankingContract() throws Exception {
        double lat = 43.6532d;
        double lng = -79.3832d;
        long queryTime = Instant.parse("2026-07-29T12:00:00Z").toEpochMilli();
        JSONArray section = new JSONArray()
            .put(new JSONObject().put("lat", lat).put("lng", lng - 0.001d))
            .put(new JSONObject().put("lat", lat).put("lng", lng + 0.001d));
        JSONObject lowerConfidenceNearer = new JSONObject()
            .put("id", "nearer-lower-confidence")
            .put("limitKmh", 40d)
            .put("active", true)
            .put("canAffectScoreAndAlerts", true)
            .put("stage", "operational")
            .put("tripCount", 9)
            .put("evidenceConfidence", 0.68d)
            .put("confidence", 0.64d)
            .put("confidenceCalibrationFactor", 0.94d)
            .put("lastObservedAt", "2026-07-28T12:00:00Z")
            .put("sectionPoints", section);
        JSONObject higherConfidenceFarther = new JSONObject()
            .put("id", "farther-higher-confidence")
            .put("limitKmh", 60d)
            .put("active", true)
            .put("canAffectScoreAndAlerts", true)
            .put("stage", "operational")
            .put("tripCount", 4)
            .put("evidenceConfidence", 0.72d)
            .put("confidence", 0.70d)
            .put("confidenceCalibrationFactor", 0.97d)
            .put("lastObservedAt", "2026-07-28T12:00:00Z")
            .put("sectionPoints", new JSONArray()
                .put(new JSONObject().put("lat", lat + 0.00025d).put("lng", lng - 0.001d))
                .put(new JSONObject().put("lat", lat + 0.00025d).put("lng", lng + 0.001d)));
        JSONObject implausibleHighestConfidence = new JSONObject()
            .put("id", "implausible-limit")
            .put("limitKmh", 250d)
            .put("active", true)
            .put("canAffectScoreAndAlerts", true)
            .put("stage", "operational")
            .put("tripCount", 10)
            .put("evidenceConfidence", 0.72d)
            .put("confidence", 0.72d)
            .put("confidenceCalibrationFactor", 1d)
            .put("lastObservedAt", "2026-07-28T12:00:00Z")
            .put("sectionPoints", section);
        JSONObject data = new JSONObject()
            .put("roadMemory", new JSONObject().put("candidates", new JSONArray()
                .put(lowerConfidenceNearer)
                .put(higherConfidenceFarther)
                .put(implausibleHighestConfidence)));

        DriveSenseAutoTrackingService.NativeSpeedLimit resolved =
            DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, 90d, queryTime);
        assertNotNull(resolved);
        assertEquals(60d, resolved.limitKmh, 0d);

        higherConfidenceFarther.put("lastObservedAt", "2026-04-01T12:00:00Z");
        resolved = DriveSenseAutoTrackingService.findLocalSpeedLimit(data, lat, lng, 90d, queryTime);
        assertNotNull(resolved);
        assertEquals(40d, resolved.limitKmh, 0d);
    }

    @Test
    public void storedSpeedMirrorKeepsOneReleasePlaintextCompatibility() throws Exception {
        JSONObject parsed = DriveSenseAutoTrackingService.parseStoredSpeedKnowledge(
            new JSONObject()
                .put("schemaVersion", 2)
                .put("cells", new JSONObject())
                .put("corrections", new JSONArray())
                .toString(),
            "speed_knowledge_v1"
        );

        assertNotNull(parsed);
        assertEquals(2, parsed.getInt("schemaVersion"));
    }

    @Test
    public void storedSpeedSelectionPrefersMirrorAndUsesLegacyOnlyWhenMirrorKeyIsAbsent() throws Exception {
        String mirror = new JSONObject().put("knowledgeRevision", 8).toString();
        String legacy = new JSONObject().put("knowledgeRevision", 3).toString();

        DriveSenseAutoTrackingService.StoredSpeedKnowledgeSelection selected =
            DriveSenseAutoTrackingService.selectStoredSpeedKnowledgePayload(mirror, legacy, false);
        assertNotNull(selected);
        assertEquals(mirror, selected.raw);
        assertEquals("speed_knowledge_native_mirror_v1", selected.storageKey);

        DriveSenseAutoTrackingService.StoredSpeedKnowledgeSelection fallback =
            DriveSenseAutoTrackingService.selectStoredSpeedKnowledgePayload(null, legacy, false);
        assertNotNull(fallback);
        assertEquals(legacy, fallback.raw);
        assertEquals("speed_knowledge_v1", fallback.storageKey);

        assertNull(DriveSenseAutoTrackingService.selectStoredSpeedKnowledgePayload(null, "\n", false));
        assertNull(DriveSenseAutoTrackingService.selectStoredSpeedKnowledgePayload(null, legacy, true));
    }

    @Test
    public void storedSpeedSelectionKeepsPresentBlankMirrorFailClosed() throws Exception {
        String legacy = new JSONObject().put("knowledgeRevision", 3).toString();
        DriveSenseAutoTrackingService.StoredSpeedKnowledgeSelection selected =
            DriveSenseAutoTrackingService.selectStoredSpeedKnowledgePayload("  ", legacy, false);

        assertNotNull(selected);
        assertEquals("speed_knowledge_native_mirror_v1", selected.storageKey);
        assertNull(DriveSenseAutoTrackingService.parseStoredSpeedKnowledge(selected.raw, selected.storageKey));
    }

    @Test(expected = org.json.JSONException.class)
    public void storedSpeedSelectionKeepsPresentMalformedMirrorFailClosed() throws Exception {
        String legacy = new JSONObject().put("knowledgeRevision", 3).toString();
        DriveSenseAutoTrackingService.StoredSpeedKnowledgeSelection selected =
            DriveSenseAutoTrackingService.selectStoredSpeedKnowledgePayload("{malformed", legacy, true);

        assertNotNull(selected);
        assertEquals("speed_knowledge_native_mirror_v1", selected.storageKey);
        DriveSenseAutoTrackingService.parseStoredSpeedKnowledge(selected.raw, selected.storageKey);
    }

    @Test(expected = IllegalArgumentException.class)
    public void storedSpeedMirrorRejectsMalformedEncryptedEnvelope() throws Exception {
        DriveSenseAutoTrackingService.parseStoredSpeedKnowledge(
            new JSONObject()
                .put("encrypted", true)
                .put("version", 1)
                .put("key_version", 1)
                .put("ciphertext", "")
                .toString()
        );
    }

    @Test(expected = IllegalArgumentException.class)
    public void storedSpeedMirrorRejectsUnsupportedStorageContext() throws Exception {
        DriveSenseAutoTrackingService.parseStoredSpeedKnowledge(
            new JSONObject().put("schemaVersion", 2).toString(),
            "unexpected_speed_store"
        );
    }

    private static JSONObject loadSavedSpeedResolverParityFixture() throws Exception {
        try (InputStream stream = DriveSenseAutoTrackingServiceTest.class
            .getClassLoader()
            .getResourceAsStream("savedSpeedResolverParityFixture.json")) {
            assertNotNull("Missing shared saved-speed resolver parity fixture", stream);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
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
