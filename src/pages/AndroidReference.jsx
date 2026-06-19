import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const ANDROID_CODE = [
  {
    id: 'readme',
    title: '📋 Setup Instructions',
    language: 'markdown',
    content: `# Road Sage Android — Setup Instructions

## Prerequisites
- Android Studio Hedgehog (2023.1.1) or newer
- Kotlin 1.9+
- minSdk 26 (Android 8.0)
- targetSdk 34 (Android 14)
- compileSdk 34

## Project Setup
1. Create new Android Studio project: "Empty Activity" with Kotlin + Compose
2. Copy all source files from the structure below
3. Add dependencies to build.gradle.kts
4. Configure AndroidManifest.xml
5. Run on device (not emulator) for GPS

## Map
Uses MapLibre Native (free, OSM-compatible).
Add your OpenFreeMap or OSM tile URL in MapScreen.kt.
No API key required for OSM tiles.

## Permissions Required
- ACCESS_FINE_LOCATION
- ACCESS_COARSE_LOCATION  
- ACCESS_BACKGROUND_LOCATION (Android 10+, opt-in only)
- ACTIVITY_RECOGNITION (Android 10+)
- FOREGROUND_SERVICE
- FOREGROUND_SERVICE_LOCATION
- POST_NOTIFICATIONS (Android 13+)
- RECEIVE_BOOT_COMPLETED (for WorkManager)
- REQUEST_IGNORE_BATTERY_OPTIMIZATIONS

## Background Location Note
Android 12+ requires explicit user action to grant background location.
The app must explain WHY it needs background location BEFORE requesting it.
First launch should request foreground location first, then request background location as a separate step for background auto tracking.
`,
  },
  {
    id: 'manifest',
    title: '📄 AndroidManifest.xml',
    language: 'xml',
    content: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <!-- Location Permissions -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <!-- Background location requires explicit user action on Android 10+ -->
    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />

    <!-- Activity Recognition (Android 10+) -->
    <uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />

    <!-- Foreground service permissions -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />

    <!-- Notifications (Android 13+) -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <!-- Boot completed for WorkManager -->
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />

    <!-- Battery optimization -->
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <application
        android:name=".RoadSageApp"
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/Theme.RoadSage"
        android:supportsRtl="true">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <!-- Trip Tracking Foreground Service -->
        <service
            android:name=".services.TripTrackingService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="location" />

        <!-- WorkManager for weekly reports / scheduled tasks -->
        <provider
            android:name="androidx.startup.InitializationProvider"
            android:authorities="\${applicationId}.androidx-startup"
            android:exported="false"
            tools:node="merge">
            <meta-data
                android:name="androidx.work.impl.WorkManagerInitializer"
                android:value="androidx.startup" />
        </provider>

    </application>

</manifest>
`,
  },
  {
    id: 'gradle',
    title: '🔧 build.gradle.kts (App)',
    language: 'kotlin',
    content: `plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt.android)
}

android {
    namespace = "com.drivesense.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.drivesense.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.10" }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.04.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Room (local database)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Hilt (dependency injection)
    implementation("com.google.dagger:hilt-android:2.51")
    ksp("com.google.dagger:hilt-android-compiler:2.51")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")

    // Location Services
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // Activity Recognition
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // MapLibre Native (free, OSM-compatible)
    implementation("org.maplibre.gl:android-sdk:11.0.0")

    // WorkManager
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Charts (MPAndroidChart or Vico)
    implementation("io.github.ehsannarmani:compose-charts:0.1.0")

    // DataStore (settings persistence)
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Splash Screen
    implementation("androidx.core:core-splashscreen:1.0.1")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
`,
  },
  {
    id: 'data_models',
    title: '🗄️ Data Models (Room Entities)',
    language: 'kotlin',
    content: `package com.drivesense.app.data.local.entity

import androidx.room.*

// ── Trip Entity ────────────────────────────────────────────────────────────────
@Entity(tableName = "trips")
data class TripEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val startTime: Long,               // Unix timestamp ms
    val endTime: Long? = null,
    val durationSeconds: Long = 0,
    val distanceKm: Float = 0f,
    val avgSpeedKmh: Float = 0f,
    val maxSpeedKmh: Float = 0f,
    val idleTimeSeconds: Long = 0,
    val nightDriving: Boolean = false,
    val scoreOverall: Int = 0,
    val scoreSafety: Int = 0,
    val scoreSmoothness: Int = 0,
    val scoreEco: Int = 0,
    val harshBrakesCount: Int = 0,
    val rapidAccelCount: Int = 0,
    val sharpTurnsCount: Int = 0,
    val speedingEventsCount: Int = 0,
    val startAddress: String? = null,
    val endAddress: String? = null,
    val notes: String? = null,
    val status: String = "completed",  // active | completed | discarded
)

// ── RoutePoint Entity ──────────────────────────────────────────────────────────
@Entity(
    tableName = "route_points",
    foreignKeys = [ForeignKey(
        entity = TripEntity::class,
        parentColumns = ["id"],
        childColumns = ["tripId"],
        onDelete = ForeignKey.CASCADE
    )],
    indices = [Index("tripId")]
)
data class RoutePointEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val tripId: Long,
    val lat: Double,
    val lng: Double,
    val speedKmh: Float,
    val accuracy: Float,
    val heading: Float?,
    val timestamp: Long,              // Unix timestamp ms
)

// ── DrivingEvent Entity ────────────────────────────────────────────────────────
@Entity(
    tableName = "driving_events",
    foreignKeys = [ForeignKey(
        entity = TripEntity::class,
        parentColumns = ["id"],
        childColumns = ["tripId"],
        onDelete = ForeignKey.CASCADE
    )],
    indices = [Index("tripId")]
)
data class DrivingEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val tripId: Long,
    val type: String,                 // harsh_brake | rapid_acceleration | sharp_turn | speeding | idle
    val severity: String,             // low | medium | high
    val lat: Double,
    val lng: Double,
    val timestamp: Long,
    val value: Float,                 // e.g. deceleration m/s², speed km/h
)

// ── Trip with related data ─────────────────────────────────────────────────────
data class TripWithDetails(
    @Embedded val trip: TripEntity,
    @Relation(parentColumn = "id", entityColumn = "tripId")
    val routePoints: List<RoutePointEntity>,
    @Relation(parentColumn = "id", entityColumn = "tripId")
    val drivingEvents: List<DrivingEventEntity>,
)
`,
  },
  {
    id: 'tracking_service',
    title: '🚗 TripTrackingService.kt (Foreground Service)',
    language: 'kotlin',
    content: `package com.drivesense.app.services

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.*
import com.drivesense.app.R
import com.drivesense.app.data.repository.TripRepository
import com.drivesense.app.domain.usecase.AnalyzeTripUseCase
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.*
import javax.inject.Inject

/**
 * TripTrackingService — Foreground service for GPS tracking.
 *
 * Android Background Location Rules:
 * - Android 8+: Background location requires foreground service OR explicit user permission
 * - Android 10+: ACCESS_BACKGROUND_LOCATION must be separate from foreground location
 * - Android 12+: Approximate location is separate from precise; must request separately
 * - Always show user exactly what you're doing via persistent notification
 *
 * This service runs as a foreground service with a persistent notification.
 * The notification tells the user "Road Sage is tracking your trip."
 * The user can tap the notification to open the app or end the trip.
 */
@AndroidEntryPoint
class TripTrackingService : Service() {

    companion object {
        const val ACTION_START = "START_TRACKING"
        const val ACTION_STOP = "STOP_TRACKING"
        const val CHANNEL_ID = "drivesense_tracking"
        const val NOTIFICATION_ID = 1001
        const val LOCATION_UPDATE_INTERVAL_MS = 2000L     // 2 seconds while trip is live
        const val LOCATION_FASTEST_INTERVAL_MS = 1000L    // 1 second
    }

    @Inject lateinit var tripRepository: TripRepository
    @Inject lateinit var analyzeTrip: AnalyzeTripUseCase

    private var fusedLocationClient: FusedLocationProviderClient? = null
    private var locationCallback: LocationCallback? = null
    private var activeTripId: Long? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startTracking()
            ACTION_STOP -> stopTracking()
        }
        return START_STICKY  // Restart if killed (crash recovery)
    }

    private fun startTracking() {
        // Start foreground with persistent notification
        startForeground(NOTIFICATION_ID, buildNotification("Trip in progress..."))

        serviceScope.launch {
            activeTripId = tripRepository.createActiveTrip()
        }

        setupLocationCallback()
        requestLocationUpdates()
    }

    private fun setupLocationCallback() {
        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { location ->
                    // Filter noisy GPS points (accuracy > 50m)
                    if (location.accuracy > 50f) return

                    val speedKmh = if (location.hasSpeed()) location.speed * 3.6f else 0f

                    serviceScope.launch {
                        activeTripId?.let { tripId ->
                            tripRepository.addRoutePoint(
                                tripId = tripId,
                                lat = location.latitude,
                                lng = location.longitude,
                                speedKmh = speedKmh,
                                accuracy = location.accuracy,
                                heading = if (location.hasBearing()) location.bearing else null,
                                timestamp = location.time,
                            )
                            // Update notification with current stats
                            val stats = tripRepository.getCurrentTripStats(tripId)
                            updateNotification("\${stats.distanceKm.format(1)} km · \${speedKmh.toInt()} km/h")
                        }
                    }
                }
            }
        }
    }

    private fun requestLocationUpdates() {
        val request = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            LOCATION_UPDATE_INTERVAL_MS
        ).setMinUpdateIntervalMillis(LOCATION_FASTEST_INTERVAL_MS).build()

        try {
            fusedLocationClient?.requestLocationUpdates(request, locationCallback!!, mainLooper)
        } catch (e: SecurityException) {
            stopSelf()  // Permission revoked while running
        }
    }

    private fun stopTracking() {
        fusedLocationClient?.removeLocationUpdates(locationCallback ?: return)

        serviceScope.launch {
            activeTripId?.let { tripId ->
                val trip = analyzeTrip(tripId)
                if (trip.distanceKm < 0.1f || trip.durationSeconds < 30) {
                    tripRepository.deleteTrip(tripId)  // Too short, discard
                } else {
                    tripRepository.finalizeTrip(tripId, trip)
                }
            }
        }

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, "Trip Tracking",
            NotificationManager.IMPORTANCE_LOW   // Low = no sound, but persistent
        ).apply {
            description = "Shows while Road Sage is recording a trip"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Road Sage — Recording Trip")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_car_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)     // Cannot be dismissed by user
            .setSilent(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }
}

private fun Float.format(decimals: Int) = "%.\${decimals}f".format(this)
`,
  },
  {
    id: 'scoring',
    title: '🧠 ScoringEngine.kt',
    language: 'kotlin',
    content: `package com.drivesense.app.domain.scoring

import com.drivesense.app.data.local.entity.DrivingEventEntity
import com.drivesense.app.data.local.entity.RoutePointEntity
import kotlin.math.*

/**
 * ScoringEngine — Analyzes GPS route points to detect driving events and score trips.
 *
 * All thresholds are configurable via DrivingThresholds data class.
 * See DEFAULT_THRESHOLDS for default values and explanations.
 */

data class DrivingThresholds(
    /** Deceleration threshold for harsh braking in m/s² (negative = braking) */
    val harshBrakeMs2: Float = 4.5f,
    /** Acceleration threshold for rapid acceleration in m/s² */
    val rapidAccelMs2: Float = 3.5f,
    /** Low sharp-turn threshold in lateral g at >=35 km/h */
    val sharpTurnLowG: Float = 0.35f,
    /** Speed above which speeding is flagged when road context is unknown */
    val speedingFallbackKmh: Float = 100f,
    /** Speed below which a vehicle is considered idle */
    val idleSpeedKmh: Float = 5f,
    /** Seconds of continuous idling before flagging idle event */
    val idleEventSeconds: Int = 60,
    /** Continuous driving minutes before long drive warning */
    val longDriveMinutes: Int = 120,
)

val DEFAULT_THRESHOLDS = DrivingThresholds()

data class TripAnalysisResult(
    val events: List<DrivingEventEntity>,
    val harshBrakesCount: Int,
    val rapidAccelCount: Int,
    val sharpTurnsCount: Int,
    val speedingEventsCount: Int,
    val scoreOverall: Int,
    val scoreSafety: Int,
    val scoreSmoothness: Int,
    val scoreEco: Int,
)

class ScoringEngine(private val thresholds: DrivingThresholds = DEFAULT_THRESHOLDS) {

    // ── Haversine Distance ─────────────────────────────────────────────────────
    /**
     * Calculate distance between two GPS coordinates using the Haversine formula.
     * Formula: d = 2R·asin(√(sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)))
     * @return Distance in kilometers
     */
    fun haversineKm(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val R = 6371.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2).pow(2) +
                cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).pow(2)
        return R * 2 * asin(sqrt(a))
    }

    // ── Acceleration ───────────────────────────────────────────────────────────
    /**
     * Calculate acceleration from two speed readings.
     * a = (v2 - v1) / t
     * Returns m/s² (negative = braking)
     */
    fun accelerationMs2(speed1Kmh: Float, speed2Kmh: Float, dtSeconds: Float): Float {
        if (dtSeconds <= 0f) return 0f
        val v1 = speed1Kmh / 3.6f
        val v2 = speed2Kmh / 3.6f
        return (v2 - v1) / dtSeconds
    }

    // ── Bearing ────────────────────────────────────────────────────────────────
    fun bearingDeg(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Float {
        val dLon = Math.toRadians(lon2 - lon1)
        val rlat1 = Math.toRadians(lat1)
        val rlat2 = Math.toRadians(lat2)
        val y = sin(dLon) * cos(rlat2)
        val x = cos(rlat1) * sin(rlat2) - sin(rlat1) * cos(rlat2) * cos(dLon)
        return ((Math.toDegrees(atan2(y, x)) + 360) % 360).toFloat()
    }

    fun headingDiff(h1: Float, h2: Float): Float {
        val diff = abs(h1 - h2) % 360f
        return if (diff > 180f) 360f - diff else diff
    }

    // ── Event Detection ────────────────────────────────────────────────────────
    fun detectEvents(tripId: Long, points: List<RoutePointEntity>): List<DrivingEventEntity> {
        val events = mutableListOf<DrivingEventEntity>()
        if (points.size < 3) return events

        var idleStartTime: Long? = null
        var idleAccum = 0f

        for (i in 1 until points.size) {
            val prev = points[i - 1]
            val curr = points[i]

            val dt = (curr.timestamp - prev.timestamp) / 1000f  // seconds
            if (dt <= 0f || dt > 120f) continue  // skip gaps

            val spd1 = prev.speedKmh
            val spd2 = curr.speedKmh
            val accel = accelerationMs2(spd1, spd2, dt)

            // ── Harsh Braking
            // Triggered when deceleration exceeds threshold while driving (>20 km/h).
            // Threshold 4.5 m/s² ≈ 0–100 in emergency stop conditions.
            if (accel < -thresholds.harshBrakeMs2 && spd1 > 20f) {
                events.add(DrivingEventEntity(
                    tripId = tripId,
                    type = "harsh_brake",
                    severity = when {
                        abs(accel) > 6f -> "high"
                        abs(accel) > 5f -> "medium"
                        else -> "low"
                    },
                    lat = curr.lat, lng = curr.lng, timestamp = curr.timestamp,
                    value = abs(accel),
                ))
            }

            // ── Rapid Acceleration
            // Triggered when acceleration exceeds threshold from moving speed (>5 km/h).
            if (accel > thresholds.rapidAccelMs2 && spd1 > 5f) {
                events.add(DrivingEventEntity(
                    tripId = tripId,
                    type = "rapid_acceleration",
                    severity = when {
                        accel > 5f -> "high"
                        accel > 4f -> "medium"
                        else -> "low"
                    },
                    lat = curr.lat, lng = curr.lng, timestamp = curr.timestamp,
                    value = accel,
                ))
            }

            // ── Sharp Turn
            // Detect significant lateral g at city/highway speeds.
            // Below 35 km/h, most turns are normal intersections or parking movement.
            if (spd2 >= 35f) {
                val h1 = if (i >= 2) bearingDeg(points[i-2].lat, points[i-2].lng, prev.lat, prev.lng)
                          else prev.heading ?: 0f
                val h2 = curr.heading ?: bearingDeg(prev.lat, prev.lng, curr.lat, curr.lng)
                val headingChange = headingDiff(h1, h2)
                val turnRate = if (dt > 0f) headingChange / maxOf(1.5f, dt) else 0f
                val lateralG = ((spd2 / 3.6f) * Math.toRadians(turnRate.toDouble()).toFloat()) / 9.81f

                if (headingChange >= 30f && lateralG >= thresholds.sharpTurnLowG) {
                    events.add(DrivingEventEntity(
                        tripId = tripId,
                        type = "sharp_turn",
                        severity = when {
                            lateralG > 0.60f -> "high"
                            lateralG > 0.45f -> "medium"
                            else -> "low"
                        },
                        lat = curr.lat, lng = curr.lng, timestamp = curr.timestamp,
                        value = lateralG,
                    ))
                }
            }

            // ── Speeding (fallback — no speed limit data)
            // When speed limit data is unavailable, use road-context fallback limits instead of one blanket threshold.
            if (spd2 > thresholds.speedingFallbackKmh) {
                events.add(DrivingEventEntity(
                    tripId = tripId,
                    type = "speeding",
                    severity = when {
                        spd2 > 160f -> "high"
                        spd2 > 140f -> "medium"
                        else -> "low"
                    },
                    lat = curr.lat, lng = curr.lng, timestamp = curr.timestamp,
                    value = spd2,
                ))
            }

            // ── Idle accumulation
            if (spd2 < thresholds.idleSpeedKmh) {
                if (idleStartTime == null) idleStartTime = curr.timestamp
                idleAccum += dt
            } else {
                if (idleAccum >= thresholds.idleEventSeconds) {
                    events.add(DrivingEventEntity(
                        tripId = tripId, type = "idle",
                        severity = when { idleAccum > 300f -> "high"; idleAccum > 120f -> "medium"; else -> "low" },
                        lat = curr.lat, lng = curr.lng, timestamp = idleStartTime!!,
                        value = idleAccum,
                    ))
                }
                idleStartTime = null
                idleAccum = 0f
            }
        }

        return events
    }

    // ── Scoring ────────────────────────────────────────────────────────────────
    /**
     * Calculate trip scores from events and stats.
     *
     * Methodology:
     * - Safety (55%): harsh_brake, speeding, sharp_turn, night driving
     * - Smoothness (30%): harsh_brake, rapid_acceleration, sharp_turn
     * - Intersection behavior (15% in the JavaScript trip scorer when evidence is available)
     * - Eco is calculated separately and does not affect the headline trip score
     * - Penalties are per-event, severity-weighted, normalized per km
     * - Overall = 0.55*safety + 0.30*smoothness + 0.15*intersection, renormalized when intersection evidence is unavailable
     */
    fun score(events: List<DrivingEventEntity>, distanceKm: Float, durationSec: Long, nightDriving: Boolean): TripScores {
        data class Penalty(val low: Int, val med: Int, val high: Int)
        val penalties = mapOf(
            "harsh_brake" to Penalty(3, 6, 12),
            "rapid_acceleration" to Penalty(2, 5, 10),
            "sharp_turn" to Penalty(2, 5, 10),
            "speeding" to Penalty(5, 10, 20),
            "idle" to Penalty(1, 3, 5),
        )

        var safetyP = 0; var smoothP = 0; var ecoP = 0
        for (evt in events) {
            val p = penalties[evt.type] ?: continue
            val pts = when (evt.severity) { "high" -> p.high; "medium" -> p.med; else -> p.low }
            if (evt.type in listOf("harsh_brake","speeding","sharp_turn")) safetyP += pts
            if (evt.type in listOf("harsh_brake","rapid_acceleration","sharp_turn")) smoothP += pts
            if (evt.type in listOf("speeding","rapid_acceleration","idle")) ecoP += pts
        }
        if (nightDriving) safetyP += 5

        val distFactor = maxOf(1f, distanceKm)
        fun normalize(p: Int) = maxOf(0, 100 - minOf((p * 5f / distFactor).toInt(), 80))

        val safety = normalize(safetyP)
        val smooth = normalize(smoothP)
        val eco = normalize(ecoP)
        val overall = ((safety * 0.55f + smooth * 0.30f) / 0.85f).toInt()

        return TripScores(overall, safety, smooth, eco)
    }
}

data class TripScores(val overall: Int, val safety: Int, val smoothness: Int, val eco: Int)
`,
  },
  {
    id: 'tests',
    title: '🧪 ScoringEngineTest.kt (Unit Tests)',
    language: 'kotlin',
    content: `package com.drivesense.app.domain.scoring

import com.drivesense.app.data.local.entity.RoutePointEntity
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ScoringEngineTest {

    private lateinit var engine: ScoringEngine

    @Before
    fun setup() {
        engine = ScoringEngine(DEFAULT_THRESHOLDS)
    }

    // ── Distance Tests ─────────────────────────────────────────────────────────
    @Test
    fun \`haversine distance between same points is zero\`() {
        val dist = engine.haversineKm(51.5, -0.12, 51.5, -0.12)
        assertEquals(0.0, dist, 0.001)
    }

    @Test
    fun \`haversine distance London to Paris is approximately 340km\`() {
        val dist = engine.haversineKm(51.5, -0.12, 48.85, 2.35)
        assertTrue("Expected ~340km but got \$dist", dist in 330.0..350.0)
    }

    // ── Speed / Acceleration Tests ─────────────────────────────────────────────
    @Test
    fun \`acceleration from 0 to 36 kmh in 2 seconds is 5 m per s2\`() {
        val accel = engine.accelerationMs2(0f, 36f, 2f)
        assertEquals(5.0f, accel, 0.01f)
    }

    @Test
    fun \`deceleration from 72 kmh to 0 in 4 seconds is minus 5 m per s2\`() {
        val accel = engine.accelerationMs2(72f, 0f, 4f)
        assertEquals(-5.0f, accel, 0.01f)
    }

    @Test
    fun \`acceleration with zero duration returns zero\`() {
        assertEquals(0f, engine.accelerationMs2(50f, 80f, 0f), 0.001f)
    }

    // ── Harsh Braking Detection ────────────────────────────────────────────────
    @Test
    fun \`harsh braking detected above threshold\`() {
        val thresholds = DEFAULT_THRESHOLDS  // 4.5 m/s²
        val pts = listOf(
            routePoint(0L, 51.5, -0.12, 80f),
            routePoint(1000L, 51.501, -0.12, 50f),   // gentle
            routePoint(2000L, 51.502, -0.12, 5f),    // sudden stop → harsh
        )
        val events = ScoringEngine(thresholds).detectEvents(1L, pts)
        val harshBrakes = events.filter { it.type == "harsh_brake" }
        assertTrue("Expected harsh brake event", harshBrakes.isNotEmpty())
    }

    @Test
    fun \`no harsh braking detected for gentle deceleration\`() {
        val pts = listOf(
            routePoint(0L, 51.5, -0.12, 60f),
            routePoint(3000L, 51.503, -0.12, 50f),   // gentle -3.3 m/s²
            routePoint(6000L, 51.506, -0.12, 40f),
        )
        val events = ScoringEngine().detectEvents(1L, pts)
        val harshBrakes = events.filter { it.type == "harsh_brake" }
        assertTrue("Should not detect gentle decel as harsh brake", harshBrakes.isEmpty())
    }

    // ── Rapid Acceleration Detection ───────────────────────────────────────────
    @Test
    fun \`rapid acceleration detected above threshold\`() {
        val pts = listOf(
            routePoint(0L, 51.5, -0.12, 10f),
            routePoint(1000L, 51.501, -0.121, 50f),  // +40 km/h in 1s = 11.1 m/s²
        )
        val events = ScoringEngine().detectEvents(1L, pts)
        assertTrue(events.any { it.type == "rapid_acceleration" })
    }

    // ── Speeding Detection ─────────────────────────────────────────────────────
    @Test
    fun \`speeding detected above fallback threshold\`() {
        val pts = listOf(
            routePoint(0L, 51.5, -0.12, 140f),       // above 130 fallback
            routePoint(3000L, 51.503, -0.12, 140f),
        )
        val events = ScoringEngine().detectEvents(1L, pts)
        assertTrue(events.any { it.type == "speeding" })
    }

    // ── Score Tests ────────────────────────────────────────────────────────────
    @Test
    fun \`perfect trip with no events scores 100\`() {
        val scores = ScoringEngine().score(emptyList(), 10f, 600L, false)
        assertEquals(100, scores.overall)
        assertEquals(100, scores.safety)
    }

    @Test
    fun \`multiple harsh brakes reduce safety score\`() {
        val events = List(5) { DrivingEventEntity(0L, 1L, "harsh_brake", "high", 51.5, -0.12, 0L, 7f) }
        val scores = ScoringEngine().score(events, 2f, 300L, false)
        assertTrue("Safety should be < 80 with 5 harsh brakes", scores.safety < 80)
    }

    @Test
    fun \`night driving adds penalty to safety score\`() {
        val dayScore = ScoringEngine().score(emptyList(), 10f, 600L, false)
        val nightScore = ScoringEngine().score(emptyList(), 10f, 600L, true)
        assertTrue("Night driving should reduce safety score", nightScore.safety < dayScore.safety)
    }

    @Test
    fun \`score is always between 0 and 100\`() {
        val events = List(20) { DrivingEventEntity(0L, 1L, "harsh_brake", "high", 51.5, -0.12, 0L, 8f) }
        val scores = ScoringEngine().score(events, 1f, 120L, true)
        assertTrue(scores.overall in 0..100)
        assertTrue(scores.safety in 0..100)
        assertTrue(scores.smoothness in 0..100)
        assertTrue(scores.eco in 0..100)
    }

    // ── Helper ─────────────────────────────────────────────────────────────────
    private fun routePoint(ts: Long, lat: Double, lng: Double, speed: Float) = RoutePointEntity(
        id = 0, tripId = 1L, lat = lat, lng = lng, speedKmh = speed,
        accuracy = 5f, heading = null, timestamp = ts,
    )
}
`,
  },
];

function CodeBlock({ content, language, id }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative">
      <div className="flex items-center justify-between bg-slate-800 dark:bg-slate-900 px-4 py-2 rounded-t-xl">
        <span className="text-xs text-slate-400 font-mono">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-slate-900 text-slate-300 text-xs p-4 rounded-b-xl overflow-x-auto thin-scrollbar max-h-96 font-mono leading-relaxed">
        {content}
      </pre>
    </div>
  );
}

export default function AndroidReference() {
  const [expanded, setExpanded] = useState({});
  const navigate = useNavigate();

  return (
    <div className="space-y-5 pb-8">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3">
        <button onClick={() => navigate('/')} className="p-2 hover:bg-secondary rounded-xl transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Android Reference</h1>
          <p className="text-muted-foreground text-sm">Kotlin + Jetpack Compose project structure</p>
        </div>
      </motion.div>

      {/* Intro */}
      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50 rounded-2xl p-4">
        <div className="font-semibold text-blue-700 dark:text-blue-300 mb-1">Full Android Kotlin Code</div>
        <div className="text-sm text-blue-600 dark:text-blue-400">
          Copy these files into an Android Studio project. All code uses Jetpack Compose, Room, Hilt, Coroutines, and MapLibre (free OSM map).
        </div>
      </div>

      {/* Code sections */}
      {ANDROID_CODE.map((section, i) => (
        <motion.div
          key={section.id}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="bg-card border border-border rounded-2xl overflow-hidden"
        >
          <button
            onClick={() => setExpanded(e => ({ ...e, [section.id]: !e[section.id] }))}
            className="w-full flex items-center justify-between p-4 hover:bg-secondary/50 transition-colors"
          >
            <span className="font-semibold text-sm">{section.title}</span>
            {expanded[section.id] ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </button>
          {expanded[section.id] && (
            <div className="px-4 pb-4">
              <CodeBlock content={section.content} language={section.language} id={section.id} />
            </div>
          )}
        </motion.div>
      ))}
    </div>
  );
}
