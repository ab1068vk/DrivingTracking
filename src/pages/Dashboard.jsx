import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { useQuery } from '@tanstack/react-query';
import {
  Car, Play, Square, Navigation, Gauge,
  AlertTriangle, Zap, TrendingDown, CornerUpRight, RefreshCw, MapPin, Target, Flame, TrafficCone, X,
  ParkingSquare, CheckCircle2, PhoneCall
} from 'lucide-react';
import {
  DEFAULT_THRESHOLDS,
  buildDrivingThresholds,
  calculateAngularStdDev,
  cleanRoutePoints,
  calculateTripStats, detectDrivingEvents, calculateTripScores,
  formatDistance, formatDuration, formatSpeed
} from '@/lib/tripEngine';
import { activeTripStore, getLastParkedLocation, localSettings, saveLastParkedLocation } from '@/lib/trackingStore';
import { createDrivingTrackingService } from '@/lib/trackingService';
import {
  scheduleLongTripReminder,
  cancelLongTripReminder,
  notifyTripCompleted,
  notifyStayAlert,
  notifyTripStarted,
  syncAchievementNotifications,
  dispatchPostTripNotification,
  checkAndNotifyPhoneUsePattern,
  notifyStyleShift,
  notifyDailyFatigueWarning,
} from '@/lib/notificationService';
import { requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission } from '@/lib/permissions';
import {
  startActivityRecognition,
  startNativeAutoTracking,
  stopNativeAutoTracking,
  computeGpsPositionDrift,
  shouldAutoStartTracking,
  shouldAutoStopTracking,
  getAndroidPhoneUsageSummary,
} from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import {
  buildPhoneUseFromAndroidUsage,
  mergePhoneUseEventsIntoDrivingEvents,
  mergePhoneUseSignals,
} from '@/lib/phoneUsageAccess';
import ScoreRing from '@/components/ScoreRing';
import StatCard from '@/components/StatCard';
import TripCard from '@/components/TripCard';
import LiveCoachOverlay from '@/components/LiveCoachOverlay';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import {
  buildScoreTips,
  calculateAchievementBadges,
  calculateFatigueRisk,
  calculateNoHarshBrakeStreak,
  computePersonalBaseline,
  calculatePeakHourStress,
  estimateTripEconomics,
  calculateWeeklyDrivingGoals,
  buildDriverSignature,
} from '@/lib/tripInsights';
import { checkDangerZoneProximity, invalidateDangerZoneCache, loadDangerZones } from '@/lib/dangerZoneEngine';
import { computeDailyFatigue, getTodayTrips } from '@/lib/dailyFatigueEngine';
import { computePreTripRisk } from '@/lib/preTripRisk';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import { recordTrackingDiagnostic } from '@/lib/trackingDiagnostics';
import { calculateRecentBrakingImprovement, formatParkingReminder } from '@/lib/tripMetadata';
import { annotateRouteSpeedLimits } from '@/lib/speedLimitSource';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { mapMatchRoute } from '@/lib/mapMatching';
import { speakSafetyAlert } from '@/lib/voiceAlerts';
import {
  buildSensorFusionSummary,
  createMotionSensorFusion,
  detectCrashIncident,
  enrichEventsWithSensorContext,
} from '@/lib/sensorFusionModel';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';

const MIN_MANUAL_SAVE_SECONDS = 5;

export default function Dashboard() {
  const [activeTrip, setActiveTrip] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [locationError, setLocationError] = useState(null);
  const locationService = useRef(null);
  const autoLocationService = useRef(null);
  const activityStopRef = useRef(null);
  const activeTripRef = useRef(null);
  const trackingRef = useRef(false);
  const latestActivityRef = useRef(null);
  const recentMovingSinceRef = useRef(null);
  const stillSinceRef = useRef(null);
  const stoppedAnchorRef = useRef(null);
  const lastMovingSpeedRef = useRef(0);
  const autoEndingTripRef = useRef(false);
  const endTripRef = useRef(null);
  const timerRef = useRef(null);
  const sensorFusionRef = useRef(null);
  const incidentAlertRef = useRef(0);
  const stayAlertSentRef = useRef(false);
  const lastStayAlertAtRef = useRef(0);
  const lastProximityAlertRef = useRef(0);
  const settings = localSettings.get();
  const [fatigueDialogOpen, setFatigueDialogOpen] = useState(false);
  const [pendingStartOptions, setPendingStartOptions] = useState(null);
  const [hazardMessage, setHazardMessage] = useState(null);
  const [readinessDismissed, setReadinessDismissed] = useState(false);
  const [parkedLocation, setParkedLocation] = useState(null);
  const [dangerZones, setDangerZones] = useState([]);

  useEffect(() => {
    activeTripRef.current = activeTrip;
  }, [activeTrip]);

  useEffect(() => {
    trackingRef.current = tracking;
    if (!tracking) {
      stayAlertSentRef.current = false;
      lastStayAlertAtRef.current = 0;
      lastProximityAlertRef.current = 0;
      stillSinceRef.current = null;
      stoppedAnchorRef.current = null;
      lastMovingSpeedRef.current = 0;
      autoEndingTripRef.current = false;
      incidentAlertRef.current = 0;
      setHazardMessage(null);
      sensorFusionRef.current?.stop();
    }
  }, [tracking]);

  useEffect(() => {
    if (!tracking || Date.now() - lastStayAlertAtRef.current < 10 * 60 * 1000) return;
    const cfg = localSettings.get();
    if (cfg.advanced_safety_detection_enabled === false) return;
    const points = activeTrip?.route_points || [];
    const lastFiveMinutes = points.filter((point) => new Date(point.timestamp).getTime() >= Date.now() - 5 * 60 * 1000);
    const headings = lastFiveMinutes
      .map((point) => Number(point.heading))
      .filter((heading) => Number.isFinite(heading));
    const highwayShare = lastFiveMinutes.length
      ? lastFiveMinutes.filter((point) => (point.speed_kmh || 0) > 80).length / lastFiveMinutes.length
      : 0;
    const drowsyHeadingThreshold = cfg.threshold_drowsy_heading_std ?? 8;
    if (lastFiveMinutes.length >= 8 && headings.length >= 5 && highwayShare >= 0.8 && calculateAngularStdDev(headings) > drowsyHeadingThreshold) {
      stayAlertSentRef.current = true;
      lastStayAlertAtRef.current = Date.now();
      notifyStayAlert().catch(() => {});
      speakSafetyAlert('Heading drift detected. Take a break when it is safe.', cfg).catch(() => {});
    }
  }, [activeTrip, tracking]);

  // Load recent trips
  const { data: recentTrips = [], refetch } = useQuery({
    queryKey: ['recent-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 500 }),
  });

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 50 }),
  });

  const completedTrips = recentTrips.filter(t => t.status === 'completed');
  const todayTrips = getTodayTrips(completedTrips);
  const dailyFatigue = computeDailyFatigue(todayTrips, settings);
  const predictiveRouteRisk = estimatePredictiveRouteRisk({
    trips: completedTrips,
    dangerZones,
    weatherRiskScore: 0,
    currentLocation,
  });
  const preTripRisk = computePreTripRisk(completedTrips, settings, dailyFatigue, {
    nearbyDangerZoneCount: predictiveRouteRisk.nearbyDangerZoneCount,
    predictiveRouteRisk,
  });

  useEffect(() => {
    getLastParkedLocation().then(setParkedLocation).catch(() => {});
  }, [completedTrips[0]?.id]);

  useEffect(() => {
    loadDangerZones().then(setDangerZones).catch(() => {});
  }, [completedTrips[0]?.id]);

  useEffect(() => {
    setReadinessDismissed(false);
  }, [completedTrips[0]?.id]);

  // Resume active trip from session (crash recovery)
  useEffect(() => {
    const recovered = activeTripStore.get();
    if (recovered) {
      activeTripRef.current = recovered;
      trackingRef.current = true;
      setActiveTrip(recovered);
      setTracking(true);
      startTimer(new Date(recovered.start_time));
      // Re-attach GPS
      startGPS();
    }
    return () => {
      stopTimer();
      locationService.current?.stop();
    };
  }, []);

  const startTimer = (startTime) => {
    stopTimer();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000));
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startGPS = useCallback(() => {
    const cfg = localSettings.get();
    const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
    if (!locationService.current) {
      locationService.current = createDrivingTrackingService({ background: useBackground });
    }
    locationService.current.start(
      async (point) => {
        setCurrentLocation(point);
        setLocationError(null);
        const latestSettings = localSettings.get();
        if (latestSettings.danger_zone_alerts_enabled !== false) {
          const zones = await loadDangerZones();
          const nearby = checkDangerZoneProximity(point.lat, point.lng, zones, 300);
          if (nearby.length > 0 && Date.now() - lastProximityAlertRef.current > 60 * 1000) {
            const zone = nearby[0];
            lastProximityAlertRef.current = Date.now();
            const typeLabel = String(zone.dominantType || 'risk event').replace(/_/g, ' ');
            const body = `${typeLabel} reported ${Math.round(zone.distanceM || 0)} m ahead`;
            setHazardMessage({ body, at: Date.now() });
            notifyStayAlert({
              id: 4007,
              title: 'Danger zone ahead',
              body,
              extra: { type: 'danger_zone', zoneId: zone.id },
            }).catch(() => {});
            speakSafetyAlert(`Danger zone ahead. ${typeLabel} reported nearby.`, latestSettings).catch(() => {});
          }
        }
        activeTripStore.addPoint(point);
        const speed = Number(point.speed_kmh) || 0;
        setActiveTrip(prev => {
          if (!prev) return prev;
          const updated = { ...prev, route_points: [...(prev.route_points || []), point] };
          activeTripStore.set(updated);
          activeTripRef.current = updated;
          return updated;
        });
        const trip = activeTripRef.current;
        if (!trip || !trackingRef.current || autoEndingTripRef.current) return;
        const incident = detectCrashIncident({
          routePoints: [...(trip.route_points || []), point],
          motionSamples: sensorFusionRef.current?.getSamples?.() || [],
          activity: latestActivityRef.current,
          settings: latestSettings,
        });
        if (incident && Date.now() - incidentAlertRef.current > 5 * 60 * 1000) {
          incidentAlertRef.current = Date.now();
          const emergencyWorkflow = latestSettings.emergency_workflow_enabled === true;
          const workflowBody = emergencyWorkflow
            ? 'Possible crash detected. Emergency check-in is active until you end or review the trip.'
            : 'Possible crash or incident detected. Check in now.';
          const incidentEvent = {
            ...incident,
            emergency_workflow_pending: emergencyWorkflow,
          };
          setHazardMessage({ body: workflowBody, at: Date.now(), persistent: emergencyWorkflow });
          notifyStayAlert({
            id: 4011,
            title: 'Possible Incident Detected',
            body: emergencyWorkflow
              ? 'Impact-like motion and little movement detected. Open Road Sage to check in.'
              : 'Road Sage detected impact-like motion followed by little movement.',
            extra: { type: 'possible_crash', severity: incident.severity, emergencyWorkflow },
          }).catch(() => {});
          speakSafetyAlert(workflowBody, latestSettings).catch(() => {});
          setActiveTrip(prev => {
            if (!prev) return prev;
            const updated = {
              ...prev,
              driving_events: [...(prev.driving_events || []), incidentEvent],
              emergency_workflow_pending: emergencyWorkflow,
            };
            activeTripStore.set(updated);
            activeTripRef.current = updated;
            return updated;
          });
        }

        const nowMs = Date.now();
        if (speed >= 15) {
          lastMovingSpeedRef.current = speed;
          stillSinceRef.current = null;
          stoppedAnchorRef.current = null;
          return;
        }
        if (speed >= 5) {
          lastMovingSpeedRef.current = speed;
        }

        stillSinceRef.current ??= nowMs;
        stoppedAnchorRef.current ??= { lat: point.lat, lng: point.lng };
        const stillSeconds = (nowMs - stillSinceRef.current) / 1000;
        const recentPoints = [...(trip.route_points || []), point].filter((routePoint) => (
          new Date(routePoint.timestamp).getTime() >= stillSinceRef.current - 5000
        ));
        const gpsPositionDriftM = computeGpsPositionDrift(
          stoppedAnchorRef.current.lat,
          stoppedAnchorRef.current.lng,
          recentPoints
        );
        const activity = latestActivityRef.current;
        const activityParked = shouldAutoStopTracking({
          activity,
          currentSpeedKmh: speed,
          stillSeconds,
          gpsPositionDriftM,
          lastMovingSpeedKmh: lastMovingSpeedRef.current,
        });
        const gpsParked = speed < 2 && (
          (stillSeconds >= 90 && gpsPositionDriftM < 5) ||
          (stillSeconds >= 180 && gpsPositionDriftM < 20) ||
          stillSeconds >= 300
        );

        if (activityParked || gpsParked) {
          recordTrackingDiagnostic({
            type: 'auto_stop',
            title: 'In-app trip auto-ended',
            reason: activityParked ? 'activity_parked' : 'gps_parked',
            speed_kmh: Math.round(speed),
            stopped_seconds: Math.round(stillSeconds),
            drift_m: Math.round(gpsPositionDriftM),
          });
          autoEndingTripRef.current = true;
          endTripRef.current?.();
        }
      },
      (err) => setLocationError(err.message)
    );
  }, []);

  const handleStartTrip = useCallback(async ({ autoStarted = false, bypassFatigueWarning = false } = {}) => {
    if (trackingRef.current) return;
    autoEndingTripRef.current = false;

    const cfg = localSettings.get();
    if (!autoStarted && !bypassFatigueWarning && dailyFatigue.shouldWarnBeforeTrip) {
      setPendingStartOptions({ autoStarted });
      setFatigueDialogOpen(true);
      return;
    }
    if (cfg.tracking_paused) {
      setLocationError('Tracking is paused in Settings.');
      return;
    }

    const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
    let pausedNativeAuto = false;
    if (!autoStarted && useBackground && isAndroid()) {
      await stopNativeAutoTracking().catch(() => {});
      pausedNativeAuto = true;
    }

    if ((autoStarted || cfg.auto_tracking_enabled || cfg.tracking_mode !== 'manual') && isAndroid()) {
      const activityGranted = await requestActivityRecognitionPermission();
      if (!activityGranted) {
        if (pausedNativeAuto) await startNativeAutoTracking().catch(() => {});
        setLocationError('Physical activity permission is required for auto trip detection.');
        return;
      }
    }

    const granted = useBackground
      ? await requestBackgroundLocationPermission()
      : await requestForegroundLocationPermission();

    if (!granted) {
      if (pausedNativeAuto) await startNativeAutoTracking().catch(() => {});
      setLocationError(useBackground
        ? 'Background tracking needs location and notification permission before a trip can start.'
        : 'Location permission denied. Please enable location to start a trip.');
      return;
    }

    const tripData = {
      start_time: new Date().toISOString(),
      status: 'active',
      route_points: [],
      driving_events: [],
      background_tracking: useBackground,
      start_source: autoStarted ? 'auto' : 'manual',
      resume_native_auto: !autoStarted && useBackground && isAndroid(),
    };

    activeTripStore.set(tripData);
    recordTrackingDiagnostic({
      type: 'trip_started',
      title: autoStarted ? 'In-app auto trip started' : 'Manual trip started',
      reason: autoStarted ? 'auto_detection' : 'manual_button',
      background_tracking: useBackground,
    });
    activeTripRef.current = tripData;
    trackingRef.current = true;
    setActiveTrip(tripData);
    setTracking(true);
    if (cfg.sensor_fusion_enabled !== false) {
      sensorFusionRef.current = createMotionSensorFusion();
      sensorFusionRef.current.start().catch(() => {});
    }
    startTimer(new Date());
    startGPS();
    notifyTripStarted();
    scheduleLongTripReminder(tripData.start_time);
  }, [dailyFatigue.shouldWarnBeforeTrip, startGPS]);

  const acknowledgeEmergencyWorkflow = (action = 'ok') => {
    const current = activeTripRef.current || activeTrip;
    if (!current) return;
    const updated = {
      ...current,
      emergency_workflow_pending: false,
      emergency_workflow_acknowledged_at: new Date().toISOString(),
      emergency_workflow_acknowledged_action: action,
      driving_events: (current.driving_events || []).map((event) => (
        event.type === 'possible_crash'
          ? { ...event, emergency_workflow_pending: false, emergency_workflow_acknowledged: action }
          : event
      )),
    };
    activeTripStore.set(updated);
    activeTripRef.current = updated;
    setActiveTrip(updated);
    setHazardMessage(null);
    recordTrackingDiagnostic({
      type: 'emergency_check_in',
      title: action === 'call' ? 'Emergency call opened' : 'Driver checked in OK',
      reason: action,
      speed_kmh: Math.round(currentLocation?.speed_kmh || 0),
      stopped_seconds: 0,
      drift_m: 0,
    });
    if (action === 'call' && typeof window !== 'undefined') {
      window.location.href = 'tel:911';
    }
  };

  const handleEndTrip = async () => {
    const tripToEnd = activeTripRef.current || activeTrip;
    if (!tripToEnd) return;

    locationService.current?.stop();
    locationService.current = null;
    sensorFusionRef.current?.stop();
    stopTimer();
    await cancelLongTripReminder();

    const endTime = new Date().toISOString();
    const cfg = localSettings.get();
    const thresholds = buildDrivingThresholds(cfg);
    const rawPoints = tripToEnd.route_points || [];
    const cleanedPoints = cleanRoutePoints(rawPoints, thresholds);
    let pts = cleanedPoints;
    const preliminaryStats = calculateTripStats(cleanedPoints, tripToEnd.start_time, endTime, thresholds);

    const isManualTrip = tripToEnd.start_source !== 'auto';
    const shouldDiscard = isManualTrip
      ? pts.length < 2 ||
        preliminaryStats.duration_seconds < MIN_MANUAL_SAVE_SECONDS ||
        preliminaryStats.distance_km < DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM
      : preliminaryStats.distance_km < DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM ||
        preliminaryStats.duration_seconds < DEFAULT_THRESHOLDS.MIN_TRIP_DURATION_SECONDS;

    if (shouldDiscard) {
      recordTrackingDiagnostic({
        type: 'trip_discarded',
        title: 'Trip discarded',
        reason: isManualTrip ? 'manual_too_short' : 'auto_too_short',
        duration_seconds: Math.round(preliminaryStats.duration_seconds || 0),
        distance_km: preliminaryStats.distance_km || 0,
      });
      activeTripStore.clear();
      activeTripRef.current = null;
      trackingRef.current = false;
      autoEndingTripRef.current = false;
      setActiveTrip(null);
      setTracking(false);
      setElapsed(0);
      if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
        await startNativeAutoTracking().catch(() => {});
      }
      setLocationError(isManualTrip
        ? 'Trip was not saved because Road Sage did not detect real movement. Start again when you begin driving.'
        : 'Auto-detected trip was ignored because it was too short.');
      return;
    }

    const mapMatchingContext = await mapMatchRoute(cleanedPoints, cfg);
    pts = mapMatchingContext.routePoints || cleanedPoints;
    const speedLimitContext = await annotateRouteSpeedLimits(pts, cfg);
    pts = speedLimitContext.routePoints || pts;
    const stats = calculateTripStats(pts, tripToEnd.start_time, endTime, thresholds);
    const weatherContext = await fetchWeatherContextForTrip(pts, tripToEnd.start_time, endTime, cfg).catch((error) => ({
      provider: 'open-meteo',
      status: 'unavailable',
      riskLevel: 'low',
      riskScore: 0,
      riskMultiplier: 1,
      error: error?.message || 'Weather lookup unavailable',
    }));

    const detection = detectDrivingEvents(pts, thresholds, endTime);
    const detectedEvents = Reflect.get(detection, 'events') ?? detection;
    const activeIncidentEvents = (tripToEnd.driving_events || []).filter((event) => event.type === 'possible_crash');
    const events = enrichEventsWithSensorContext([...detectedEvents, ...activeIncidentEvents], sensorFusionRef.current?.getSamples?.() || []);
    const gpsPhoneUse = Reflect.get(detection, 'phoneUse') ?? {};
    const startMs = new Date(tripToEnd.start_time).getTime();
    const endMs = new Date(endTime).getTime();
    let nativePhoneUsageSummary = null;
    if (isAndroid() && Number.isFinite(startMs) && Number.isFinite(endMs)) {
      nativePhoneUsageSummary = await getAndroidPhoneUsageSummary(startMs, endMs).catch(() => null);
    }
    const usagePhoneUse = buildPhoneUseFromAndroidUsage(nativePhoneUsageSummary || {}, pts, stats.duration_seconds);
    const phoneUse = mergePhoneUseSignals(gpsPhoneUse, usagePhoneUse, stats.duration_seconds);
    let scores = calculateTripScores(events, stats, pts, thresholds, stats.duration_seconds, phoneUse, { endTime });
    scores = applyWeatherRiskToScores(scores, weatherContext);
    const tripEvents = mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || events, phoneUse);
    const completedVehicle = vehicles.find((vehicle) => vehicle.is_default) || vehicles[0] || null;
    const economics = estimateTripEconomics({ ...stats, ...scores }, completedVehicle, settings);
    const sensorFusionSummary = buildSensorFusionSummary(sensorFusionRef.current?.getSamples?.() || [], pts, latestActivityRef.current);
    const driverModel = buildOnDeviceDriverModel(completedTrips);
    const anomaly = scoreTripAnomaly({ ...stats, ...scores }, driverModel);

    const completedTrip = {
      ...stats,
      start_time: tripToEnd.start_time,
      end_time: endTime,
      vehicle_id: completedVehicle?.id || null,
      route_points: pts,
      route_points_raw_count: rawPoints.length,
      route_points_map_count: pts.length,
      ...scores,
      driving_events: tripEvents,
      speed_limit_context: {
        provider: 'openstreetmap_overpass',
        status: speedLimitContext.status,
        coverage: speedLimitContext.coverage,
        source: speedLimitContext.source,
        error: speedLimitContext.error,
      },
      map_matching_context: {
        provider: mapMatchingContext.provider,
        status: mapMatchingContext.status,
        confidence: mapMatchingContext.confidence ?? null,
        snapped_coverage: mapMatchingContext.snapped_coverage ?? 0,
      },
      weather_context: weatherContext,
      sensor_fusion_summary: sensorFusionSummary,
      driver_anomaly: anomaly,
      anomaly_score: anomaly.anomaly_score,
      anomaly_level: anomaly.anomaly_level,
      co2_saved_kg: economics.co2_saved_kg,
      status: 'completed',
      background_tracking: tripToEnd.background_tracking,
      start_source: tripToEnd.start_source || 'manual',
      emergency_workflow_pending: tripToEnd.emergency_workflow_pending === true,
      emergency_workflow_acknowledged_at: tripToEnd.emergency_workflow_acknowledged_at || null,
      emergency_workflow_acknowledged_action: tripToEnd.emergency_workflow_acknowledged_action || null,
      native_phone_usage_access_granted: nativePhoneUsageSummary?.usage_access_granted === true,
      native_phone_usage_events: nativePhoneUsageSummary?.events || [],
      native_phone_usage_event_count: nativePhoneUsageSummary?.event_count || 0,
      native_phone_usage_total_seconds: nativePhoneUsageSummary?.total_seconds || 0,
    };

    const savedTrip = await tripService.create(completedTrip);
    recordTrackingDiagnostic({
      type: 'trip_ended',
      title: 'Trip saved',
      reason: completedTrip.parking_stop_detected ? 'ended_parked' : 'ended_manual_or_moving',
      tripId: savedTrip?.id || completedTrip.id,
      duration_seconds: Math.round(completedTrip.duration_seconds || 0),
      distance_km: completedTrip.distance_km || 0,
      parking_stop_duration_seconds: completedTrip.parking_stop_duration_seconds || 0,
    });
    await invalidateDangerZoneCache();
    await invalidateRouteRiskIndex();
    const parkedPoint = pts[pts.length - 1];
    const endedStopped = completedTrip.parking_stop_detected ||
      Number(completedTrip.parking_stop_duration_seconds || 0) > 0 ||
      Number(parkedPoint?.speed_kmh || 0) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH);
    if (parkedPoint && endedStopped) {
      const savedParkedLocation = await saveLastParkedLocation({
        lat: parkedPoint.lat,
        lng: parkedPoint.lng,
        timestamp: parkedPoint.timestamp || endTime,
        tripId: savedTrip?.id || completedTrip.id,
        source: completedTrip.parking_stop_detected ? 'parking_stop' : 'stopped_trip_end',
      });
      setParkedLocation(savedParkedLocation);
    }
    if (settings.trip_end_notification) await notifyTripCompleted(completedTrip);
    await dispatchPostTripNotification(completedTrip, completedTrips, settings).catch(() => {});
    checkAndNotifyPhoneUsePattern([completedTrip, ...completedTrips], settings).catch(() => {});
    const driverSignature = buildDriverSignature([completedTrip, ...completedTrips].slice(0, 20));
    if (driverSignature?.style_shifts?.length > 0) {
      notifyStyleShift(driverSignature.style_shifts, settings).catch(() => {});
    }
    await syncAchievementNotifications(calculateAchievementBadges([completedTrip, ...completedTrips])).catch(() => {});
    const newDailyFatigue = computeDailyFatigue(getTodayTrips([completedTrip, ...completedTrips]), settings);
    if (newDailyFatigue.fatigueLevel === 'high' || newDailyFatigue.fatigueLevel === 'critical') {
      notifyDailyFatigueWarning(newDailyFatigue).catch(() => {});
    }
    activeTripStore.clear();
    activeTripRef.current = null;
    trackingRef.current = false;
    autoEndingTripRef.current = false;
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
      await startNativeAutoTracking().catch(() => {});
    }
    refetch();
  };

  useEffect(() => {
    endTripRef.current = handleEndTrip;
  });

  useEffect(() => {
    const cfg = localSettings.get();
    const autoEnabled = (
      cfg.auto_tracking_enabled ||
      cfg.tracking_mode === 'auto_detect' ||
      cfg.tracking_mode === 'background_auto'
    ) && !cfg.tracking_paused;

    if (isAndroid() && cfg.tracking_mode === 'background_auto') return undefined;
    if (!autoEnabled || tracking) return undefined;

    let cancelled = false;

    const stopAutoWatchers = async () => {
      await autoLocationService.current?.stop();
      autoLocationService.current = null;
      await activityStopRef.current?.();
      activityStopRef.current = null;
      latestActivityRef.current = null;
      recentMovingSinceRef.current = null;
      stillSinceRef.current = null;
    };

    const maybeAutoStart = async (point) => {
      if (cancelled || trackingRef.current) return;

      const speed = point.speed_kmh || 0;
      if (speed >= 5) {
        recentMovingSinceRef.current ??= Date.now();
      } else {
        recentMovingSinceRef.current = null;
      }

      if (speed < 5) {
        stillSinceRef.current ??= Date.now();
      } else {
        stillSinceRef.current = null;
      }

      const recentMovingSeconds = recentMovingSinceRef.current
        ? (Date.now() - recentMovingSinceRef.current) / 1000
        : 0;
      const stillSeconds = stillSinceRef.current
        ? (Date.now() - stillSinceRef.current) / 1000
        : 0;
      const activity = latestActivityRef.current;
      const activitySaysDrive = shouldAutoStartTracking({ activity, currentSpeedKmh: speed, recentMovingSeconds });
      const speedOnlyDrive = !isAndroid() && speed >= 5 && recentMovingSeconds >= 1;

      if (activitySaysDrive || speedOnlyDrive) {
        recordTrackingDiagnostic({
          type: 'auto_start',
          title: 'In-app auto-start triggered',
          reason: activitySaysDrive ? 'activity_in_vehicle' : 'speed_only_drive',
          speed_kmh: Math.round(speed),
          recent_moving_seconds: Math.round(recentMovingSeconds),
        });
        await stopAutoWatchers();
        await handleStartTrip({ autoStarted: true });
      } else if (shouldAutoStopTracking({ activity, currentSpeedKmh: speed, stillSeconds })) {
        recentMovingSinceRef.current = null;
      }
    };

    const startAutoWatchers = async () => {
      const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';

      if (isAndroid()) {
        const activityGranted = await requestActivityRecognitionPermission();
        if (cancelled) return;
        if (!activityGranted) {
          setLocationError('Physical activity permission is required for auto trip detection.');
          return;
        }

        activityStopRef.current = await startActivityRecognition(
          (activity) => {
            latestActivityRef.current = activity;
          },
          (err) => setLocationError(err.message)
        );
      }

      const locationGranted = useBackground
        ? await requestBackgroundLocationPermission()
        : await requestForegroundLocationPermission();
      if (cancelled) return;

      if (!locationGranted) {
        setLocationError(useBackground
          ? 'Background auto tracking needs background location and notification permission.'
          : 'Auto tracking needs location permission.');
        return;
      }

      autoLocationService.current = createDrivingTrackingService({ background: useBackground });
      await autoLocationService.current.start(
        (point) => {
          setCurrentLocation(point);
          setLocationError(null);
          maybeAutoStart(point);
        },
        (err) => setLocationError(err.message)
      );
    };

    startAutoWatchers();

    return () => {
      cancelled = true;
      stopAutoWatchers();
    };
  }, [tracking, handleStartTrip]);

  // Stats
  const totalTrips = completedTrips.length;
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const weekTrips = completedTrips.filter(t => new Date(t.start_time) >= weekAgo);
  const weekDistance = weekTrips.reduce((s, t) => s + (t.distance_km || 0), 0);
  const avgScore = completedTrips.length
    ? Math.round(completedTrips.reduce((s, t) => s + (t.score_overall || 0), 0) / completedTrips.length)
    : 0;
  const latestTrip = completedTrips[0];
  const scoreTrend = completedTrips.slice(0, 10).reverse().map((t, i) => ({ i, score: t.score_overall || 0 }));
  const tips = buildScoreTips(completedTrips);
  const weeklyGoals = calculateWeeklyDrivingGoals(completedTrips, settings);
  const brakingImprovement = calculateRecentBrakingImprovement(completedTrips);
  const parkingReminder = formatParkingReminder(parkedLocation);
  const noHarshBrakeStreak = calculateNoHarshBrakeStreak(completedTrips);
  const fatigueRisk = calculateFatigueRisk(weekTrips, settings);
  const baseline = computePersonalBaseline(completedTrips);
  const peakStress = calculatePeakHourStress(completedTrips);
  const activeFatigueAlert = tracking && elapsed > 90 * 60 && (() => {
    const points = activeTrip?.route_points || [];
    if (points.length < 12) return false;
    const firstWindowEnd = new Date(activeTrip.start_time).getTime() + 10 * 60 * 1000;
    const lastWindowStart = Date.now() - 10 * 60 * 1000;
    const firstPoints = points.filter((point) => new Date(point.timestamp).getTime() <= firstWindowEnd);
    const lastPoints = points.filter((point) => new Date(point.timestamp).getTime() >= lastWindowStart);
    if (firstPoints.length < 3 || lastPoints.length < 3) return false;
    const firstDetection = detectDrivingEvents(firstPoints);
    const lastDetection = detectDrivingEvents(lastPoints);
    const firstEvents = Reflect.get(firstDetection, 'events') ?? firstDetection;
    const lastEvents = Reflect.get(lastDetection, 'events') ?? lastDetection;
    const firstStats = calculateTripStats(firstPoints, firstPoints[0].timestamp, firstPoints[firstPoints.length - 1].timestamp);
    const lastStats = calculateTripStats(lastPoints, lastPoints[0].timestamp, lastPoints[lastPoints.length - 1].timestamp);
    return calculateTripScores(lastEvents, lastStats, lastPoints, DEFAULT_THRESHOLDS, lastStats.duration_seconds, Reflect.get(lastDetection, 'phoneUse') ?? {}).score_overall <
      calculateTripScores(firstEvents, firstStats, firstPoints, DEFAULT_THRESHOLDS, firstStats.duration_seconds, Reflect.get(firstDetection, 'phoneUse') ?? {}).score_overall - 15;
  })();

  const units = settings.units || 'metric';

  return (
    <div className="space-y-6 pb-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-grotesk font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </motion.div>

      {/* Location Error */}
      <AnimatePresence>
        {locationError && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-2xl"
          >
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-red-700 dark:text-red-400">Location Error</div>
              <div className="text-xs text-red-600 dark:text-red-500 mt-0.5">{locationError}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {(brakingImprovement || parkingReminder) && (
        <div className="grid gap-3 md:grid-cols-2">
          {brakingImprovement && (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
              <TrendingDown className="h-5 w-5" />
              <div>
                <div className="text-sm font-semibold">{brakingImprovement.message}</div>
                <div className="text-xs opacity-80">Braking score {brakingImprovement.previous} to {brakingImprovement.current}</div>
              </div>
            </div>
          )}
          {parkingReminder && (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
              <ParkingSquare className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-semibold">Parking reminder</div>
                <div className="text-xs text-muted-foreground">{parkingReminder}</div>
              </div>
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {fatigueDialogOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          >
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 12 }}
              className="w-full max-w-sm rounded-3xl border border-border bg-card p-5 shadow-2xl"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-1 h-5 w-5 text-orange-500" />
                <div>
                  <h2 className="font-semibold">High fatigue detected</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    You've driven {dailyFatigue.totalDrivingMinutes} min today. Consider a {dailyFatigue.recommendedBreakMinutes}-min break first.
                  </p>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    setFatigueDialogOpen(false);
                    setPendingStartOptions(null);
                  }}
                  className="rounded-xl border border-border px-3 py-2 text-sm font-semibold hover:bg-secondary"
                >
                  Take a break
                </button>
                <button
                  onClick={() => {
                    const nextOptions = pendingStartOptions || {};
                    setFatigueDialogOpen(false);
                    setPendingStartOptions(null);
                    handleStartTrip({ ...nextOptions, bypassFatigueWarning: true });
                  }}
                  className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Continue anyway
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active Trip Card */}
      <AnimatePresence mode="wait">
        {tracking ? (
          <motion.div
            key="active"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-3xl p-6 text-white shadow-2xl"
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2.5 h-2.5 bg-red-400 rounded-full animate-pulse" />
                  <span className="text-white/80 text-sm font-medium">Trip Active</span>
                </div>
                <div className="font-grotesk font-bold text-4xl">{formatDuration(elapsed)}</div>
                <div className="text-white/70 text-sm mt-1">
                  {activeTrip?.route_points?.length ? (
                    (() => {
                      const stats = calculateTripStats(
                        activeTrip.route_points,
                        activeTrip.start_time,
                        new Date().toISOString(),
                        buildDrivingThresholds(localSettings.get())
                      );
                      return `${formatDistance(stats.distance_km, units)} · ${formatSpeed(stats.avg_speed_kmh, units)} avg`;
                    })()
                  ) : 'Getting GPS signal...'}
                </div>
              </div>
              <div className="p-3 bg-white/10 rounded-2xl">
                <Car className="w-8 h-8" />
              </div>
            </div>

            {currentLocation && (() => {
              const spd = currentLocation.speed_kmh || 0;
              const overLimit = settings.threshold_speeding_kmh || 100;
              const warnOffset = settings.threshold_speed_over_kmh ?? 5;
              const speedWarningsEnabled = settings.speed_warning_enabled !== false;
              const isOverWarn = speedWarningsEnabled && spd > overLimit + warnOffset;
              return (
                <div className="flex items-center gap-2 text-sm mb-4">
                  <MapPin className="w-3.5 h-3.5 text-white/70" />
                  <span className={`font-semibold ${isOverWarn ? 'text-red-300 animate-pulse' : 'text-white/70'}`}>
                    {formatSpeed(spd, units)}{isOverWarn ? ' ⚠️ Over limit!' : ''}
                  </span>
                  <span className="opacity-50 text-white/70">·</span>
                  <span className="text-white/70">Acc: {Math.round(currentLocation.accuracy || 0)}m</span>
                </div>
              );
            })()}

            {activeFatigueAlert && (
              <div className="mb-4 rounded-xl bg-white/15 px-3 py-2 text-sm font-medium text-red-100">
                Driving quality has dipped during this long trip. Take a break soon.
              </div>
            )}

            {hazardMessage && (hazardMessage.persistent || Date.now() - hazardMessage.at < 2 * 60 * 1000) && (
              <div className="mb-4 rounded-xl bg-red-500/25 px-3 py-2 text-sm font-medium text-red-50">
                {hazardMessage.body}
              </div>
            )}

            {activeTrip?.emergency_workflow_pending && (
              <div className="mb-4 rounded-2xl border border-red-200/30 bg-red-600/30 p-3 text-red-50 shadow-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold">Emergency check-in</div>
                    <div className="mt-1 text-xs text-red-50/85">
                      Possible incident detected. Confirm you are OK or call emergency services.
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => acknowledgeEmergencyWorkflow('ok')}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white/90 px-3 py-2 text-xs font-bold text-red-700"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    I'm OK
                  </button>
                  <button
                    type="button"
                    onClick={() => acknowledgeEmergencyWorkflow('call')}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-900 px-3 py-2 text-xs font-bold text-white"
                  >
                    <PhoneCall className="h-3.5 w-3.5" />
                    Call 911
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={handleEndTrip}
              className="w-full py-3 bg-white/15 hover:bg-white/25 backdrop-blur rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
            >
              <Square className="w-4 h-4" />
              End Trip
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="bg-card border border-border rounded-3xl p-6 shadow-sm"
          >
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="text-muted-foreground text-sm mb-1">Ready to drive?</div>
                <div className="font-grotesk font-bold text-xl">Start a new trip</div>
                <div className="text-muted-foreground text-xs mt-1">Tap to begin tracking your route</div>
              </div>
              <button
                onClick={() => handleStartTrip()}
                className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg hover:opacity-90 transition-opacity"
              >
                <Play className="w-7 h-7 text-white ml-0.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!tracking && completedTrips.length >= 5 && !readinessDismissed && (
        <div className="bg-card border border-border rounded-3xl p-4 shadow-sm">
          <div className="flex items-start gap-4">
            <div
              className="grid h-14 w-14 flex-shrink-0 place-items-center rounded-full text-sm font-bold text-white"
              style={{
                background: preTripRisk.readinessScore >= 70
                  ? '#22c55e'
                  : preTripRisk.readinessScore >= 45
                    ? '#eab308'
                    : '#ef4444',
              }}
            >
              {preTripRisk.readinessScore}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <h2 className="min-w-0 break-words font-semibold">Trip readiness</h2>
                <button
                  onClick={() => setReadinessDismissed(true)}
                  className="flex-shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-secondary"
                  aria-label="Dismiss readiness card"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="break-words text-sm font-medium capitalize">
                {preTripRisk.readinessScore}/100 · {preTripRisk.riskLevel} risk
              </div>
              {preTripRisk.riskLevel !== 'low' && (
                <>
                  <div className="mt-1 break-words text-xs text-muted-foreground">{preTripRisk.primaryConcern}</div>
                  <div className="mt-1 break-words text-xs italic text-muted-foreground">{preTripRisk.tipText}</div>
                </>
              )}
              {preTripRisk.topSignals?.length > 0 && (
                <div className="mt-3 space-y-2">
                  {preTripRisk.topSignals.map((signal) => (
                    <div key={signal.key} className="flex items-start gap-2 text-xs">
                      <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                      <span className="min-w-0 flex-1 break-words leading-snug text-muted-foreground">{signal.label}</span>
                      <span className="max-w-[45%] break-words text-right font-semibold leading-snug">{signal.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {settings.predictive_route_risk_enabled !== false && (
                <div className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-semibold">Predictive route risk</span>
                    <span className={`flex-shrink-0 font-bold capitalize ${
                      predictiveRouteRisk.riskLevel === 'high' ? 'text-red-500' : predictiveRouteRisk.riskLevel === 'moderate' ? 'text-orange-500' : 'text-emerald-500'
                    }`}>
                      {predictiveRouteRisk.riskScore}/100
                    </span>
                  </div>
                  <div className="mt-1 break-words text-muted-foreground">{predictiveRouteRisk.primaryFactor}</div>
                  <div className="mt-1 break-words text-muted-foreground">{predictiveRouteRisk.safestWindow}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={Navigation}
          label="This Week"
          value={formatDistance(weekDistance, units)}
          gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
          index={0}
        />
        <StatCard
          icon={Car}
          label="Total Trips"
          value={totalTrips}
          gradient="bg-gradient-to-br from-emerald-400 to-green-600"
          index={1}
        />
      </div>

      {completedTrips.length > 0 && (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold text-base">Personal Baseline</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {baseline.baseline_avg == null
                  ? 'Record at least 3 trips in 4 weeks to unlock your baseline.'
                  : `This week is ${baseline.delta >= 0 ? '+' : ''}${baseline.delta} vs your 4-week average.`}
              </p>
            </div>
            <div className={`text-sm font-bold capitalize ${
              baseline.trend === 'improving' ? 'text-emerald-500' : baseline.trend === 'declining' ? 'text-red-500' : 'text-muted-foreground'
            }`}>
              {baseline.trend}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.this_week_avg ?? '-'}</div>
              <div className="text-xs text-muted-foreground">this week</div>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.baseline_avg ?? '-'}</div>
              <div className="text-xs text-muted-foreground">baseline</div>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.percentile ?? 0}%</div>
              <div className="text-xs text-muted-foreground">percentile</div>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="flex items-center gap-2">
                <TrafficCone className={`w-4 h-4 ${
                  peakStress.peak_stress_label === 'consistent' ? 'text-emerald-500' :
                    peakStress.peak_stress_label === 'slightly stressed' ? 'text-yellow-500' :
                      peakStress.peak_stress_label === 'traffic-affected' ? 'text-orange-500' : 'text-red-500'
                }`} />
                <div className="font-grotesk font-bold text-sm capitalize">{peakStress.peak_stress_label}</div>
              </div>
              <div className="text-xs text-muted-foreground mt-1">rush hour behaviour</div>
            </div>
          </div>
        </div>
      )}

      {/* Driver goals */}
      {completedTrips.length > 0 && (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-base">Weekly Driver Goals</h2>
            <Target className="w-4 h-4 text-primary" />
          </div>
          <div className="space-y-2">
            {weeklyGoals.map((goal) => {
              const pct = goal.direction === 'under'
                ? Math.min(100, goal.target > 0 ? (goal.value / goal.target) * 100 : 100)
                : Math.min(100, goal.target > 0 ? (goal.value / goal.target) * 100 : 0);
              return (
                <div key={goal.id}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium">{goal.label}</span>
                    <span className={goal.met ? 'text-emerald-500 font-semibold' : 'text-orange-500 font-semibold'}>
                      {goal.value}/{goal.target}{goal.unit ? ` ${goal.unit}` : goal.direction === 'over' ? '+' : ''}
                    </span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${goal.met ? 'bg-emerald-500' : 'bg-orange-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Driver streak and fatigue */}
      {completedTrips.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-card border border-border rounded-2xl p-4">
            <Flame className="w-5 h-5 text-orange-500 mb-2" />
            <div className="font-grotesk font-bold text-2xl">{noHarshBrakeStreak}</div>
            <div className="text-xs text-muted-foreground">days without harsh braking</div>
          </div>
          <div className="bg-card border border-border rounded-2xl p-4">
            <AlertTriangle className={`w-5 h-5 mb-2 ${fatigueRisk.level === 'high' ? 'text-red-500' : fatigueRisk.level === 'medium' ? 'text-orange-500' : 'text-emerald-500'}`} />
            <div className="font-grotesk font-bold text-2xl capitalize">{fatigueRisk.level}</div>
            <div className="text-xs text-muted-foreground">{fatigueRisk.long_trip_count} long drives this week</div>
          </div>
        </div>
      )}

      {dailyFatigue.tripCount >= 1 && (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-base capitalize">Daily fatigue · {dailyFatigue.fatigueLevel}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {dailyFatigue.totalDrivingMinutes} min driven today across {dailyFatigue.tripCount} trips
              </p>
              {dailyFatigue.minutesSinceLastTrip != null && (
                <p className="mt-1 text-xs text-muted-foreground">Resting {dailyFatigue.minutesSinceLastTrip} min</p>
              )}
            </div>
            <div className="font-grotesk text-2xl font-bold">{dailyFatigue.cumulativeFatigueScore}/10</div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, dailyFatigue.cumulativeFatigueScore * 10)}%`,
                background: dailyFatigue.fatigueLevel === 'critical'
                  ? '#ef4444'
                  : dailyFatigue.fatigueLevel === 'high'
                    ? '#f97316'
                    : dailyFatigue.fatigueLevel === 'moderate'
                      ? '#eab308'
                      : '#22c55e',
              }}
            />
          </div>
          {dailyFatigue.recommendedBreakMinutes > 0 && (
            <div className="mt-3 text-xs font-semibold text-orange-500">
              Take a {dailyFatigue.recommendedBreakMinutes}-min break before your next trip
            </div>
          )}
        </div>
      )}

      {/* Score & Trend */}
      <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="font-semibold text-base">Driving Score</h2>
            <p className="text-muted-foreground text-xs mt-0.5">Last {Math.min(10, completedTrips.length)} trips</p>
          </div>
          {avgScore > 0 && (
            <ScoreRing score={avgScore} size={72} strokeWidth={6} sublabel="avg" />
          )}
        </div>

        {scoreTrend.length > 2 ? (
          <ResponsiveContainer width="100%" height={60}>
            <LineChart data={scoreTrend}>
              <Line
                type="monotone"
                dataKey="score"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
              />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                formatter={(v) => [v, 'Score']}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-12 flex items-center justify-center text-muted-foreground text-xs">
            Complete more trips to see trend
          </div>
        )}
      </div>

      {/* Coaching tips */}
      {completedTrips.length > 0 && (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <h2 className="font-semibold text-base mb-3">Score Tips</h2>
          <div className="space-y-2">
            {tips.map((tip) => (
              <div key={tip} className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
                {tip}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick event stats */}
      {completedTrips.length > 0 && (() => {
        const hb = completedTrips.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
        const ra = completedTrips.reduce((s, t) => s + (t.rapid_accel_count || 0), 0);
        const st = completedTrips.reduce((s, t) => s + (t.sharp_turns_count || 0), 0);
        const sp = completedTrips.reduce((s, t) => s + (t.speeding_events_count || 0), 0);
        return (
          <div>
            <h2 className="font-semibold text-base mb-3">Event Summary</h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Harsh Brakes', value: hb, icon: TrendingDown, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
                { label: 'Rapid Accel', value: ra, icon: Zap, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
                { label: 'Sharp Turns', value: st, icon: CornerUpRight, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
                { label: 'Speeding', value: sp, icon: Gauge, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
              ].map(({ label, value, icon: Icon, color, bg }) => (
                <div key={label} className={`${bg} rounded-2xl p-4 border border-border/50`}>
                  <Icon className={`w-5 h-5 ${color} mb-2`} />
                  <div className={`font-grotesk font-bold text-2xl ${color}`}>{value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Recent Trips */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-base">Recent Trips</h2>
          <button onClick={() => refetch()} className="p-1.5 hover:bg-secondary rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {completedTrips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 bg-secondary rounded-3xl flex items-center justify-center mb-4">
              <Car className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="font-semibold text-foreground mb-1">No trips yet</div>
            <div className="text-muted-foreground text-sm">Start your first trip to see it here</div>
          </div>
        ) : (
          <div className="space-y-3">
            {completedTrips.slice(0, 5).map((trip, i) => (
              <TripCard key={trip.id} trip={trip} units={units} index={i} />
            ))}
          </div>
        )}
      </div>
      {tracking && settings.live_coaching_enabled !== false && (
        <LiveCoachOverlay
          currentRoutePoints={activeTrip?.route_points || []}
          currentEvents={activeTrip?.driving_events || []}
          tripStartTime={activeTrip?.start_time}
        />
      )}
    </div>
  );
}
