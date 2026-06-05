package com.roadsage.app.uitest.seed

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.UUID
import kotlin.math.max

object FakeTripFactory {
    fun buildBackupJson(): String {
        val exportedAt = Instant.now()
        val trips = JSONArray()

        trips.put(trip(1, "Clean highway commute", 95, 48.0, 42, 3_000, 58.0, 112.0, "work", "morning", 0, 7, events = emptyList()))
        trips.put(trip(2, "Aggressive city driving", 42, 15.4, 44, 1_920, 29.0, 84.0, "personal", "afternoon", 14, 13, events = eventPlan(2, listOf("harsh_brake" to 5, "rapid_acceleration" to 4, "speeding" to 3, "sharp_turn" to 2))))
        trips.put(trip(3, "Night drive", 71, 18.0, 34, 1_600, 40.0, 76.0, "personal", "night", 2, 16, startHour = 23, startMinute = 30, events = eventPlan(3, listOf("harsh_brake" to 2))))
        trips.put(trip(4, "High-risk drive", 35, 22.0, 52, 2_400, 33.0, 101.0, "other", "evening", 12, 19, events = eventPlan(4, listOf("possible_crash" to 1, "harsh_brake" to 6, "speeding" to 3, "erratic_speed" to 1, "stop_start_pattern" to 1))))
        trips.put(trip(5, "Favorite perfect score", 98, 30.0, 38, 2_100, 51.0, 94.0, "personal", "morning", 0, 22, favorite = true, nickname = "Sunday Drive", notes = "Great conditions!", events = emptyList()))
        trips.put(trip(6, "Phone use", 61, 12.7, 32, 1_350, 34.0, 67.0, "errand", "afternoon", 5, 25, phoneUseScore = 48, events = eventPlan(6, listOf("phone_use" to 3, "harsh_brake" to 2))))
        trips.put(trip(7, "With nickname and notes", 77, 9.8, 28, 1_180, 30.0, 61.0, "errand", "afternoon", 1, 28, nickname = "Grocery run", notes = "Heavy traffic on King St", events = eventPlan(7, listOf("idle" to 1))))
        trips.put(trip(8, "Short errand", 88, 3.2, 20, 420, 27.0, 48.0, "errand", "morning", 0, 31, events = emptyList()))
        trips.put(trip(9, "Long highway", 83, 88.0, 60, 4_800, 66.0, 118.0, "work", "morning", 1, 34, events = eventPlan(9, listOf("speeding" to 1))))
        trips.put(trip(10, "Heading deviation beta", 68, 16.5, 36, 1_500, 39.0, 72.0, "work", "evening", 4, 37, events = eventPlan(10, listOf("heading_deviation" to 4), diagnostic = true), headingDriftScore = 65))
        trips.put(trip(11, "Lane change detected", 74, 21.0, 40, 1_700, 44.0, 80.0, "personal", "afternoon", 3, 40, events = eventPlan(11, listOf("lane_change_detected" to 3), label = "Lane Change with simultaneous braking"), laneChangingScore = 62))
        trips.put(trip(12, "Stop-start pattern", 58, 7.6, 25, 1_150, 24.0, 52.0, "other", "afternoon", 7, 43, events = eventPlan(12, listOf("stop_start_pattern" to 5, "tailgate_cycle" to 2)), stopStartScore = 45))
        trips.put(trip(13, "Eco score focus", 85, 33.5, 45, 2_300, 52.0, 89.0, "work", "morning", 0, 46, ecoDrivingScore = 95, fuelBandScore = 92, events = emptyList()))
        trips.put(trip(14, "Worst score of all", 28, 19.7, 55, 2_100, 31.0, 105.0, "personal", "evening", 23, 49, events = eventPlan(14, listOf("possible_crash" to 1, "harsh_brake" to 8, "speeding" to 6, "rapid_acceleration" to 5, "idle" to 3))))
        trips.put(trip(15, "Best score of all", 99, 44.0, 50, 2_750, 57.0, 106.0, "work", "morning", 0, 52, favorite = true, allComponentsOver90 = true, events = emptyList()))
        trips.put(trip(16, "Rain weather context", 72, 14.3, 34, 1_360, 38.0, 70.0, "personal", "morning", 2, 55, weather = true, events = eventPlan(16, listOf("harsh_brake" to 1, "sharp_turn" to 1))))
        trips.put(trip(17, "Vehicle assigned", 80, 27.6, 42, 1_980, 48.0, 87.0, "work", "afternoon", 1, 58, vehicleId = "vehicle-001", events = eventPlan(17, listOf("speeding" to 1))))
        trips.put(trip(18, "Feedback-reviewed events", 69, 13.8, 30, 1_300, 36.0, 74.0, "errand", "evening", 5, 61, feedbackReviewed = true, events = eventPlan(18, listOf("harsh_brake" to 3, "rapid_acceleration" to 2))))
        trips.put(trip(19, "This week yesterday", 76, 24.2, 36, 1_840, 47.0, 82.0, "work", "morning", 1, 1, dynamicDaysAgo = 1, startHour = 9, startMinute = 15, events = eventPlan(19, listOf("harsh_brake" to 1))))
        trips.put(trip(20, "This month five days ago", 81, 17.9, 32, 1_520, 43.0, 78.0, "personal", "evening", 0, 5, dynamicDaysAgo = 5, startHour = 17, startMinute = 30, events = emptyList()))

        return JSONObject()
            .put("app", "Road Sage")
            .put("version", 5)
            .put("exported_at", exportedAt.toString())
            .put("trips", trips)
            .put("vehicles", vehicles(exportedAt))
            .put("settings", JSONObject())
            .put("saved_filters", JSONArray())
            .put("ui", JSONObject().put("saved_trip_filters", JSONArray()))
            .toString(2)
    }

    private fun trip(
        number: Int,
        scenario: String,
        score: Int,
        distanceKm: Double,
        pointCount: Int,
        durationSeconds: Int,
        avgSpeedKmh: Double,
        maxSpeedKmh: Double,
        tag: String,
        timeOfDay: String,
        eventCount: Int,
        daysAgo: Long,
        dynamicDaysAgo: Long? = null,
        startHour: Int = when (timeOfDay) {
            "night" -> 23
            "evening" -> 18
            "afternoon" -> 14
            else -> 8
        },
        startMinute: Int = 10,
        favorite: Boolean = false,
        nickname: String = "",
        notes: String = "",
        vehicleId: String? = null,
        phoneUseScore: Int? = null,
        stopStartScore: Int? = null,
        ecoDrivingScore: Int? = null,
        fuelBandScore: Int? = null,
        headingDriftScore: Int? = null,
        laneChangingScore: Int? = null,
        weather: Boolean = false,
        feedbackReviewed: Boolean = false,
        allComponentsOver90: Boolean = false,
        events: List<JSONObject>
    ): JSONObject {
        val start = startInstant(dynamicDaysAgo ?: daysAgo, startHour, startMinute)
        val end = start.plusSeconds(durationSeconds.toLong())
        val points = routePoints(number, start, durationSeconds, pointCount, avgSpeedKmh)
        val eventsWithPositions = positionEvents(events, points, start, durationSeconds)
        val eventFeedback = if (feedbackReviewed) reviewedFeedback(eventsWithPositions) else JSONObject()
        val componentScores = componentScores(
            score = score,
            eventCount = eventCount,
            phoneUseScore = phoneUseScore,
            stopStartScore = stopStartScore,
            ecoDrivingScore = ecoDrivingScore,
            fuelBandScore = fuelBandScore,
            headingDriftScore = headingDriftScore,
            laneChangingScore = laneChangingScore,
            allComponentsOver90 = allComponentsOver90
        )
        val dayName = ZonedDateTime.ofInstant(start, ZoneOffset.UTC)
            .dayOfWeek
            .getDisplayName(TextStyle.FULL, Locale.US)

        return JSONObject()
            .put("id", uuid("trip-$number"))
            .put("status", "completed")
            .put("scenario", scenario)
            .put("start_time", start.toString())
            .put("end_time", end.toString())
            .put("created_at", start.minusSeconds(120).toString())
            .put("updated_at", end.plusSeconds(30).toString())
            .put("distance_km", distanceKm)
            .put("duration_seconds", durationSeconds)
            .put("avg_speed_kmh", avgSpeedKmh)
            .put("max_speed_kmh", maxSpeedKmh)
            .put("score_overall", score)
            .put("score_safety", (score - if (eventCount > 8) 8 else 2).coerceIn(0, 100))
            .put("score_smoothness", (score + if (eventCount == 0) 2 else -3).coerceIn(0, 100))
            .put("score_eco", (ecoDrivingScore ?: (score + 3)).coerceIn(0, 100))
            .put("score_confidence", "high")
            .put("score_confidence_label", "high")
            .put("score_status", "scored")
            .put("tag", tag)
            .put("tag_reviewed", true)
            .put("is_favorite", favorite)
            .put("nickname", nickname)
            .put("notes", notes)
            .put("vehicle_id", vehicleId ?: JSONObject.NULL)
            .put("route_points", points)
            .put("gps_points", points)
            .put("route_points_raw_count", points.length())
            .put("route_points_map_count", points.length())
            .put("driving_events", eventsWithPositions)
            .put("events", eventsWithPositions)
            .put("event_feedback", eventFeedback)
            .put("component_scores", componentScores)
            .put("score_provenance", JSONObject()
                .put("scoring_version", "test-seed-v1")
                .put("scored_at", end.plusSeconds(5).toString())
                .put("reason", "initial_score")
                .put("provenance_source", "javascript"))
            .put("score_explanation", JSONArray())
            .put("economics", JSONObject()
                .put("fuel_cost", JSONObject.NULL)
                .put("fuel_saved_liters", JSONObject.NULL)
                .put("co2_kg", JSONObject.NULL)
                .put("co2_saved_kg", JSONObject.NULL)
                .put("estimate_label", "Assign a vehicle to replace default fuel assumptions.")
                .put("actual_l_per_100km", JSONObject.NULL)
                .put("fuel_price_per_liter", JSONObject.NULL))
            .put("time_of_day", timeOfDay)
            .put("day_of_week", dayName)
            .put("night_driving", timeOfDay == "night")
            .put("route_summary", JSONObject()
                .put("start_address", "123 Main St, Kitchener")
                .put("end_address", "456 Elm Ave, Waterloo"))
            .put("weather_context", if (weather) rainWeatherContext() else JSONObject.NULL)
            .put("speed_limit_coverage", JSONObject.NULL)
            .put("fatigue_data", JSONObject.NULL)
            .put("feedback_adjusted_events_count", if (feedbackReviewed) 3 else 0)
            .put("harsh_brakes_count", count(eventsWithPositions, "harsh_brake"))
            .put("rapid_accel_count", count(eventsWithPositions, "rapid_acceleration"))
            .put("sharp_turns_count", count(eventsWithPositions, "sharp_turn"))
            .put("speeding_events_count", count(eventsWithPositions, "speeding"))
            .put("stop_start_pattern_count", count(eventsWithPositions, "stop_start_pattern"))
            .put("tailgate_cycle_count", count(eventsWithPositions, "tailgate_cycle"))
            .put("phone_use_events", JSONArray())
            .put("phone_use_window_count", count(eventsWithPositions, "phone_use"))
            .put("phone_use_score", phoneUseScore ?: JSONObject.NULL)
            .put("phone_use_score_confidence", if (phoneUseScore != null) "high" else "unavailable")
            .put("native_phone_usage_access_granted", false)
            .put("heading_deviation_count", count(eventsWithPositions, "heading_deviation"))
            .put("heading_drift_beta_score", headingDriftScore ?: JSONObject.NULL)
            .put("heading_drift_beta_confidence", if (headingDriftScore != null) "developing" else "unavailable")
            .put("lane_change_count", count(eventsWithPositions, "lane_change_detected"))
            .put("lane_changing_score", laneChangingScore ?: JSONObject.NULL)
            .put("lane_changing_score_confidence", if (laneChangingScore != null) "developing" else "unavailable")
            .put("stop_start_pattern_score", stopStartScore ?: JSONObject.NULL)
            .put("stop_start_pattern_score_confidence", if (stopStartScore != null) "high" else "unavailable")
            .put("eco_driving_score", ecoDrivingScore ?: (score + 2).coerceIn(0, 100))
            .put("eco_driving_score_confidence", "high")
            .put("fuel_band_score", fuelBandScore ?: (score + 1).coerceIn(0, 100))
            .put("fuel_band_score_confidence", "high")
            .put("braking_efficiency_score", (score - 4).coerceIn(0, 100))
            .put("braking_efficiency_score_confidence", "high")
            .put("cornering_consistency_score", (score + 5).coerceIn(0, 100))
            .put("cornering_consistency_score_confidence", "high")
            .put("aggressive_driving_score", (100 - eventCount * 4).coerceIn(0, 100))
            .put("aggressive_driving_score_confidence", "high")
            .put("defensive_driving_score", (score - 1).coerceIn(0, 100))
            .put("defensive_driving_score_confidence", "high")
    }

    private fun componentScores(
        score: Int,
        eventCount: Int,
        phoneUseScore: Int?,
        stopStartScore: Int?,
        ecoDrivingScore: Int?,
        fuelBandScore: Int?,
        headingDriftScore: Int?,
        laneChangingScore: Int?,
        allComponentsOver90: Boolean
    ): JSONObject {
        val base = if (allComponentsOver90) max(score, 94) else score
        return JSONObject()
            .put("overall", component(base, "high"))
            .put("safety", component((base - if (eventCount > 0) 4 else 0).coerceIn(0, 100), "high"))
            .put("smoothness", component((base + 2).coerceIn(0, 100), "high"))
            .put("eco", component((ecoDrivingScore ?: base).coerceIn(0, 100), "high"))
            .put("aggressive_driving", component((100 - eventCount * 4).coerceIn(0, 100), "high"))
            .put("aggressive_driving_score", component((100 - eventCount * 4).coerceIn(0, 100), "high"))
            .put("defensive_driving", component((base - 1).coerceIn(0, 100), "high"))
            .put("defensive_driving_score", component((base - 1).coerceIn(0, 100), "high"))
            .put("smoothness_index", component((base + 4).coerceIn(0, 100), "high"))
            .put("jerk_score", component((base + 4).coerceIn(0, 100), "high"))
            .put("speed_variability", component((base - 2).coerceIn(0, 100), "high"))
            .put("fuel_band", component(fuelBandScore ?: (base + 1).coerceIn(0, 100), "high"))
            .put("stop_start_pattern", scoreOrUnavailable(stopStartScore))
            .put("phone_use", scoreOrUnavailable(phoneUseScore))
            .put("approach_stop", component((base - 5).coerceIn(0, 100), "developing", 6))
            .put("heading_drift_beta", scoreOrUnavailable(headingDriftScore, "developing"))
            .put("braking_efficiency", component((base - 4).coerceIn(0, 100), "high", 10))
            .put("cornering_consistency", component((base + 5).coerceIn(0, 100), "high", 15))
            .put("eco_driving", component(ecoDrivingScore ?: (base + 2).coerceIn(0, 100), "high"))
            .put("eco_driving_score", component(ecoDrivingScore ?: (base + 2).coerceIn(0, 100), "high"))
            .put("lane_changing", scoreOrUnavailable(laneChangingScore, "developing"))
            .put("lane_changing_score", scoreOrUnavailable(laneChangingScore, "developing"))
            .put("parking_approach", component((base + 6).coerceIn(0, 100), "developing", 3))
    }

    private fun component(value: Int, evidence: String, sampleCount: Int = 42): JSONObject =
        JSONObject()
            .put("value", value.coerceIn(0, 100))
            .put("evidence", evidence)
            .put("dataSource", JSONArray().put("gps"))
            .put("sources", JSONArray().put("gps"))
            .put("sampleCount", sampleCount)
            .put("sample_count", sampleCount)

    private fun scoreOrUnavailable(value: Int?, evidence: String = "high"): JSONObject =
        if (value == null) {
            JSONObject()
                .put("value", JSONObject.NULL)
                .put("evidence", "unavailable")
                .put("dataSource", JSONArray())
                .put("sources", JSONArray())
                .put("sampleCount", 0)
                .put("sample_count", 0)
        } else {
            component(value, evidence)
        }

    private fun eventPlan(
        tripNumber: Int,
        plan: List<Pair<String, Int>>,
        diagnostic: Boolean = false,
        label: String? = null
    ): List<JSONObject> {
        val events = mutableListOf<JSONObject>()
        var eventIndex = 0
        plan.forEach { (type, count) ->
            repeat(count) {
                eventIndex += 1
                events += JSONObject()
                    .put("id", uuid("trip-$tripNumber-event-$eventIndex-$type"))
                    .put("type", type)
                    .put("value", when (type) {
                        "speeding" -> 92 + it
                        "idle" -> 70 + it * 10
                        "possible_crash" -> 12.0
                        else -> 4.5 + (it % 4)
                    })
                    .put("severity", when {
                        type == "possible_crash" -> "high"
                        it % 3 == 0 -> "high"
                        it % 3 == 1 -> "medium"
                        else -> "low"
                    })
                    .put("status", if (diagnostic) "diagnostic" else "scored")
                    .put("confidence", "high")
                    .put("speed_before_kmh", 48.0 + it)
                    .put("label", label ?: eventLabel(type, diagnostic))
                    .put("simultaneous_braking", type == "lane_change_detected")
                    .put("feedback_verdict", JSONObject.NULL)
            }
        }
        return events
    }

    private fun positionEvents(
        events: List<JSONObject>,
        points: JSONArray,
        start: Instant,
        durationSeconds: Int
    ): JSONArray {
        val result = JSONArray()
        events.forEachIndexed { index, event ->
            val pointIndex = ((index + 2) * max(1, points.length() / max(1, events.size + 2))).coerceAtMost(points.length() - 1)
            val point = points.getJSONObject(pointIndex)
            val timestamp = start.plusSeconds(((index + 1) * durationSeconds / max(1, events.size + 1)).toLong())
            result.put(JSONObject(event.toString())
                .put("timestamp", timestamp.toString())
                .put("time", timestamp.toString())
                .put("lat", point.getDouble("lat"))
                .put("lng", point.getDouble("lng"))
                .put("speed_kmh", point.getDouble("speed_kmh")))
        }
        return result
    }

    private fun reviewedFeedback(events: JSONArray): JSONObject {
        val feedback = JSONObject()
        for (index in 0 until events.length()) {
            val event = events.getJSONObject(index)
            val verdict = when (event.getString("type")) {
                "harsh_brake" -> "wrong"
                "rapid_acceleration" -> "accurate"
                else -> null
            }
            if (verdict != null) {
                feedback.put(eventFeedbackKey(event, index), JSONObject()
                    .put("verdict", verdict)
                    .put("reviewed_at", Instant.now().minusSeconds(3_600).toString())
                    .put("source", "test_seed"))
            }
        }
        return feedback
    }

    private fun eventFeedbackKey(event: JSONObject, index: Int): String {
        val value = event.optDouble("value", Double.NaN)
        val valuePart = if (value.isNaN()) "" else String.format(Locale.US, "%.2f", value)
        return listOf(event.optString("type", "event"), event.optString("timestamp", index.toString()), valuePart).joinToString("|")
    }

    private fun routePoints(
        tripNumber: Int,
        start: Instant,
        durationSeconds: Int,
        count: Int,
        speedKmh: Double
    ): JSONArray {
        val starts = arrayOf(
            43.4516 to -80.4925,
            43.4668 to -80.5164,
            43.4372 to -80.4820,
            43.4723 to -80.5449
        )
        val ends = arrayOf(
            43.4723 to -80.5449,
            43.4516 to -80.4925,
            43.4980 to -80.5290,
            43.4600 to -80.5204
        )
        val startCoord = starts[(tripNumber - 1) % starts.size]
        val endCoord = ends[(tripNumber - 1) % ends.size]
        val points = JSONArray()
        repeat(count.coerceIn(20, 60)) { index ->
            val t = if (count <= 1) 0.0 else index.toDouble() / (count - 1).toDouble()
            val wobble = ((index % 5) - 2) * 0.00008
            val timestamp = start.plusSeconds((durationSeconds.toDouble() * t).toLong())
            points.put(JSONObject()
                .put("lat", lerp(startCoord.first, endCoord.first, t) + wobble)
                .put("lng", lerp(startCoord.second, endCoord.second, t) - wobble)
                .put("timestamp", timestamp.toString())
                .put("time", timestamp.toString())
                .put("speed_kmh", (speedKmh + ((index % 7) - 3) * 1.6).coerceAtLeast(0.0))
                .put("speed", (speedKmh + ((index % 7) - 3) * 1.6).coerceAtLeast(0.0))
                .put("accuracy_m", 8)
                .put("accuracy", 8))
        }
        return points
    }

    private fun vehicles(exportedAt: Instant): JSONArray =
        JSONArray()
            .put(JSONObject()
                .put("id", "vehicle-001")
                .put("name", "Honda Civic 2019")
                .put("make", "Honda")
                .put("model", "Civic")
                .put("year", 2019)
                .put("fuel_type", "gasoline")
                .put("created_date", exportedAt.minus(90, ChronoUnit.DAYS).toString()))
            .put(JSONObject()
                .put("id", "vehicle-002")
                .put("name", "Toyota Camry 2021")
                .put("make", "Toyota")
                .put("model", "Camry")
                .put("year", 2021)
                .put("fuel_type", "gasoline")
                .put("created_date", exportedAt.minus(80, ChronoUnit.DAYS).toString()))

    private fun rainWeatherContext(): JSONObject =
        JSONObject()
            .put("weather_condition", "rain")
            .put("slippery_proxy", "likely_wet")
            .put("riskLevel", "medium")
            .put("weather_context_source", "open_meteo")
            .put("avg_temp_c", 8)
            .put("precipitation_mm", 4.2)

    private fun eventLabel(type: String, diagnostic: Boolean): String =
        when (type) {
            "harsh_brake" -> "Harsh Brake"
            "rapid_acceleration" -> "Rapid Acceleration"
            "sharp_turn" -> "Sharp Turn"
            "speeding" -> "Speeding"
            "idle" -> "Idle"
            "possible_crash" -> "Possible Incident"
            "stop_start_pattern" -> "Stop-Start Pattern"
            "tailgate_cycle" -> "Tailgate Cycle"
            "phone_use" -> "Phone Use"
            "heading_deviation" -> if (diagnostic) "Diagnostic only heading deviation" else "Heading Deviation"
            "lane_change_detected" -> "Lane Change"
            else -> type
        }

    private fun count(events: JSONArray, type: String): Int {
        var total = 0
        for (i in 0 until events.length()) {
            if (events.getJSONObject(i).optString("type") == type) total += 1
        }
        return total
    }

    private fun startInstant(daysAgo: Long, hour: Int, minute: Int): Instant =
        ZonedDateTime.now(ZoneOffset.UTC)
            .minusDays(daysAgo)
            .withHour(hour)
            .withMinute(minute)
            .withSecond(0)
            .withNano(0)
            .toInstant()

    private fun lerp(start: Double, end: Double, t: Double): Double = start + (end - start) * t

    private fun uuid(seed: String): String =
        UUID.nameUUIDFromBytes("road-sage-ui-$seed".toByteArray(StandardCharsets.UTF_8)).toString()
}
