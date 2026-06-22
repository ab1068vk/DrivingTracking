import { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { tripService, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { useQuery } from '@tanstack/react-query';
import {
  Car, Play, Square, Navigation, Gauge,
  AlertTriangle, Zap, TrendingDown, CornerUpRight, RefreshCw, MapPin, Target, Flame, TrafficCone, X,
  ParkingSquare, CheckCircle2, PhoneCall, Shield, Trash2
} from 'lucide-react';
import {
  DEFAULT_THRESHOLDS,
  TRIP_STATES,
  buildDrivingThresholds,
  calculateAngularStdDev,
  calculateSegmentMetrics,
  cleanRoutePoints,
  calculateTripStats, detectDrivingEvents, calculateTripScores,
  inferSpeedZones,
  prefetchLocalKnowledge,
  resolveEffectiveSpeedLimitForIndex,
  getTripComponentScore,
  getScoreProvenanceStatus,
  formatDistance, formatDuration, formatSpeed,
  isNearRecentParkedLocation,
  reviewManualTripSave,
  trimParkedTail,
  validateCandidateTrip
} from '@/lib/tripEngine';
import { activeTripStore, getLastParkedLocation, localSettings, saveLastParkedLocation, SETTINGS_CHANGED_EVENT } from '@/lib/trackingStore';
import { createDrivingTrackingService } from '@/lib/trackingService';
import {
  scheduleLongTripReminder,
  cancelLongTripReminder,
  notifyStayAlert,
  notifyTripStarted,
  notifyForegroundManualTrackingWarning,
  syncAchievementNotifications,
  dispatchTripCompletedNotification,
  checkAndNotifyPhoneUsePattern,
  notifyStyleShift,
  notifyDailyFatigueWarning,
} from '@/lib/notificationService';
import { getPermissionStatus, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission } from '@/lib/permissions';
import {
  startActivityRecognition,
  startNativeAutoTracking,
  startNativeManualTrip,
  discardNativeManualTrip,
  endNativeActiveTrip,
  getAndroidBatteryOptimizationStatus,
  getNativeAutoTrackingStatus,
  openAndroidBatteryOptimizationSettings,
  computeGpsPositionDrift,
  shouldAutoStartTracking,
  shouldAutoStopTracking,
  getAndroidUsageAccessStatus,
  getAndroidPhoneUsageSummary,
} from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import {
  buildPhoneUseFromAndroidUsage,
  mergePhoneUseEventsIntoDrivingEvents,
  mergePhoneUseSignals,
} from '@/lib/phoneUsageAccess';
import { isDriverMetricEligible } from '@/lib/phoneUseSummary';
import ScoreRing from '@/components/ScoreRing';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import StatCard from '@/components/StatCard';
import TripCard from '@/components/TripCard';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
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
import { buildHabitProfile } from '@/lib/habitProfile';
import { computePreTripRisk } from '@/lib/preTripRisk';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import {
  buildDashboardTrackingExplanation,
  getTrackingDiagnostics,
  recordTrackingDiagnostic,
} from '@/lib/trackingDiagnostics';
import { logError } from '@/lib/errorReporting';
import { calculateRecentBrakingImprovement, formatParkingReminder } from '@/lib/tripMetadata';
import {
  alertMarginForConfidence,
  annotateRouteSpeedLimits,
  shouldWarnForSpeed,
  speedLimitDefaultCountryKey,
  VOICE_COOLDOWNS_BY_TIER,
} from '@/lib/speedLimitSource';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { getJson, setJson } from '@/lib/mobileStorage';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import {
  DASHBOARD_SPEED_LIMIT_REVIEW_DISMISSAL_KEY,
  buildDashboardSpeedLimitReviewFingerprint,
  buildTripSpeedLimitReviewCells,
  speedLimitReviewNeededForTrip,
} from '@/lib/speedLimitReview';
import {
  DASHBOARD_SCORE_REVIEW_DISMISSAL_KEY,
  buildDashboardScoreReviewFingerprint,
} from '@/lib/dashboardScoreReview';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import {
  getVoiceAlertDeliveryStatus,
  shouldMuteWebViewVoiceForTrip,
  speakSafetyAlert,
  speakSafetyAlertOnce,
  stopSafetyAlerts,
} from '@/lib/voiceAlerts';
import { buildSpeedingMessage, buildVoiceAlertMessage } from '@/lib/voiceAlertMessages';
import {
  buildSensorFusionSummary,
  createMotionSensorFusion,
  detectCrashIncident,
  enrichEventsWithSensorContext,
} from '@/lib/sensorFusionModel';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';
import { isExternalContextAutoFetchEnabled } from '@/lib/openSourceTripContext';
import { hasProvisionalCalibration } from '@/lib/scoringConstants';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { injectTimestampGapMarkers, prepareMapRoutePoints, selectMapRoutePoints } from '@/lib/mapPlaybackInsights';
import {
  getPrivacyZones,
  isInsidePrivacyZone,
  maskEventsForPrivacy,
  redactRoutePointForPrivacyStorage,
} from '@/lib/privacyZones';
import { appendPrivacyEvent } from '@/lib/hashChainLog';
import {
  PRIVATE_TRIP_MODE,
  buildPrivateTripRecord,
  createPrivateTripRuntime,
  isPrivateTrip,
  processPrivateTripPoint,
} from '@/lib/privateTripMode';
import { syncNativeCompletedTrips } from '@/lib/localTripRepository';
import {
  NATIVE_MANUAL_TRIP_FINALIZED_EVENT,
  createNativeManualTripId,
  findNativeManualCompletion,
  isNativeManualCompletionForActiveTrip,
} from '@/lib/nativeManualTripIdentity';

const TripMap = lazy(() => import('@/components/TripMap'));

const RECOVERABLE_TRIP_STATES = new Set([TRIP_STATES.CANDIDATE, TRIP_STATES.CONFIRMED]);
const AUTO_START_TRIGGER_SECONDS = 2;
const OVERALL_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['score_overall']);
const ROUTE_RISK_IS_APPROXIMATE = hasProvisionalCalibration(['route_risk_score']);
const READINESS_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['pre_trip_readiness_score']);
const LIVE_SPEED_ALERT_MIN_SECONDS = 30;
const LIVE_SPEED_ALERT_MIN_POINTS = 3;

function tripElapsedSeconds(trip, nowValue = Date.now()) {
  const startMs = new Date(trip?.start_time || 0).getTime();
  const nowMs = typeof nowValue === 'number' ? nowValue : new Date(nowValue || Date.now()).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs < startMs) return 0;
  return Math.round((nowMs - startMs) / 1000);
}

function isFreshTripPoint(point, trip) {
  const pointMs = new Date(point?.timestamp || 0).getTime();
  const startMs = new Date(trip?.start_time || 0).getTime();
  if (!Number.isFinite(pointMs) || !Number.isFinite(startMs)) return true;
  return pointMs >= startMs - 5000;
}

function hasLiveSpeedEvidence(trip, routePoints = [], point = null, nowValue = Date.now()) {
  if (!trip) return false;
  if (!isFreshTripPoint(point, trip)) return false;
  if ((Array.isArray(routePoints) ? routePoints.length : 0) < LIVE_SPEED_ALERT_MIN_POINTS) return false;
  return tripElapsedSeconds(trip, nowValue) >= LIVE_SPEED_ALERT_MIN_SECONDS;
}

function shouldMuteDashboardWebViewVoice(trip) {
  return shouldMuteWebViewVoiceForTrip(trip, { isAndroidPlatform: isAndroid() });
}

function createTierAwareSpeedLimitContext(context, settings = {}) {
  const limitKmh = context?.limitKmh ?? context?.effectiveLimitKmh ?? null;
  const confidence = Number(context?.confidence) || 0;
  const margin = alertMarginForConfidence(confidence, settings.threshold_speed_over_kmh ?? 5);
  const tier = context?.tier || 'UNKNOWN';
  const estimateGuidanceAllowed = settings.speed_estimates_enabled !== false || tier === 'POSTED';
  if (!estimateGuidanceAllowed) {
    return {
      ...context,
      limitKmh: null,
      tier: 'UNKNOWN',
      confidence: 0,
      alertMarginKmh: Infinity,
      shouldAlert: () => false,
    };
  }
  return {
    ...context,
    limitKmh,
    alertMarginKmh: margin,
    shouldAlert: (speedKmh) => (
      settings.speed_warning_enabled !== false &&
      estimateGuidanceAllowed &&
      Number.isFinite(Number(speedKmh)) &&
      Number.isFinite(Number(limitKmh)) &&
      Number(speedKmh) > Number(limitKmh) + margin
    ),
  };
}

function speedLimitBadgeForResolved(resolved) {
  const tier = resolved?.tier || 'UNKNOWN';
  const limit = Number(resolved?.limitKmh);
  const roundedLimit = Number.isFinite(limit) ? Math.round(limit) : null;
  const badgeByTier = {
    POSTED: {
      text: roundedLimit == null ? '— km/h' : `${roundedLimit}`,
      className: 'border-emerald-200/70 bg-emerald-400/20 text-emerald-50',
    },
    MAP_ESTIMATED: {
      text: roundedLimit == null ? '— km/h' : `~${roundedLimit} (road type)`,
      className: 'border-amber-200/70 bg-amber-400/20 text-amber-50',
    },
    LEARNED_LOCAL: {
      text: roundedLimit == null ? '— km/h' : `${roundedLimit} (this road)`,
      className: 'border-amber-200/70 bg-amber-300/15 text-amber-50',
    },
    REGION_DEFAULT: {
      text: roundedLimit == null ? '— km/h' : `~${roundedLimit} (regional estimate)`,
      className: 'border-dashed border-amber-200/70 bg-amber-400/15 text-amber-50',
    },
    GPS_INFERRED: {
      text: roundedLimit == null ? '— km/h' : `~${roundedLimit} (estimated)`,
      className: 'border-dashed border-slate-200/60 bg-slate-400/15 text-slate-50',
    },
    UNKNOWN: {
      text: '— km/h',
      className: 'border-slate-200/40 bg-slate-500/20 text-slate-100',
    },
  };
  return badgeByTier[tier] || badgeByTier.UNKNOWN;
}

function checkAndSpeakSpeedAlert(speed, resolved, settings, onAlert, { voiceMuted = false } = {}) {
  if (speed < 1) return;
  const warning = shouldWarnForSpeed({ speedKmh: speed, candidate: resolved, settings });
  if (!warning) return;

  if (warning.visual) {
    onAlert?.();
  }
  if (voiceMuted || !warning.voice) return;

  const message = buildSpeedingMessage({
    speedKmh: speed,
    speedLimitKmh: resolved.limitKmh,
    tier: resolved.tier,
  });
  if (!message) return;

  speakSafetyAlertOnce(
    `speeding_${resolved.tier}`,
    message,
    settings,
    VOICE_COOLDOWNS_BY_TIER[resolved.tier] ?? 60000
  ).catch((error) => {
    logError('speed_alert_voice', error, {
      tier: resolved.tier,
      speed_kmh: Math.round(speed),
      speed_limit_kmh: resolved.limitKmh,
    });
  });
}

function isRecoverableActiveTrip(trip) {
  if (!trip || typeof trip !== 'object') return false;
  if (trip.status !== 'active') return false;
  if (trip.end_time) return false;
  return RECOVERABLE_TRIP_STATES.has(trip.trip_state);
}

function waitForTripEndingFeedbackPaint() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

export default function Dashboard() {
  const [activeTrip, setActiveTrip] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [endingTrip, setEndingTrip] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [locationError, setLocationError] = useState(null);
  const [manualForegroundWarning, setManualForegroundWarning] = useState(false);
  const [gpsPointWarning, setGpsPointWarning] = useState(false);
  const [trackingServiceMode, setTrackingServiceMode] = useState(null);
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
  const endingTripRef = useRef(false);
  const locationPermissionEndingRef = useRef(false);
  const endTripRef = useRef(null);
  const timerRef = useRef(null);
  const sensorFusionRef = useRef(null);
  const incidentAlertRef = useRef(0);
  const stayAlertSentRef = useRef(false);
  const lastStayAlertAtRef = useRef(0);
  const lastProximityAlertRef = useRef(0);
  const inferredSpeedZonesRef = useRef([]);
  const privateTripRuntimeRef = useRef(null);
  const gpsPointWarningLoggedRef = useRef(false);
  const localSpeedKnowledgeRef = useRef(null);
  const nativeManualReconcileInFlightRef = useRef(false);
  const [settings, setSettings] = useState(() => localSettings.get());
  const [fatigueDialogOpen, setFatigueDialogOpen] = useState(false);
  const [speedLimitConflictReview, setSpeedLimitConflictReview] = useState(null);
  const [speedLimitReviewSummary, setSpeedLimitReviewSummary] = useState(null);
  const [pendingStartOptions, setPendingStartOptions] = useState(null);
  const [manualForegroundConfirmOpen, setManualForegroundConfirmOpen] = useState(false);
  const [pendingManualForegroundStartOptions, setPendingManualForegroundStartOptions] = useState(null);
  const [hazardMessage, setHazardMessage] = useState(null);
  const [readinessDismissed, setReadinessDismissed] = useState(false);
  const [dismissedScoreReviewFingerprint, setDismissedScoreReviewFingerprint] = useState('');
  const [scoreReviewDismissalLoaded, setScoreReviewDismissalLoaded] = useState(false);
  const [dismissedSpeedLimitReviewFingerprint, setDismissedSpeedLimitReviewFingerprint] = useState('');
  const [speedLimitReviewDismissalLoaded, setSpeedLimitReviewDismissalLoaded] = useState(false);
  const [speedKnowledgeRevision, setSpeedKnowledgeRevision] = useState(0);
  const [parkedLocation, setParkedLocation] = useState(null);
  const [dangerZones, setDangerZones] = useState([]);
  const [trackingStatusContext, setTrackingStatusContext] = useState({
    permissionStatus: null,
    nativeStatus: null,
    batteryStatus: null,
    diagnostics: getTrackingDiagnostics(),
  });
  const privacyZones = getPrivacyZones(settings);
  const currentLocationInPrivacyZone = currentLocation
    ? isInsidePrivacyZone(currentLocation.lat, currentLocation.lng, privacyZones)
    : false;
  const dangerZoneCurrentLocation = currentLocationInPrivacyZone ? null : currentLocation;

  const refreshTrackingStatusContext = useCallback(async () => {
    const latestSettings = await localSettings.hydrateFromNative();
    const diagnostics = getTrackingDiagnostics();
    const [permissionStatus, nativeStatus, batteryStatus] = await Promise.all([
      getPermissionStatus().catch(() => null),
      isAndroid() ? getNativeAutoTrackingStatus().catch(() => null) : Promise.resolve(null),
      isAndroid() ? getAndroidBatteryOptimizationStatus().catch(() => null) : Promise.resolve(null),
    ]);
    setSettings((current) => (
      JSON.stringify(current) === JSON.stringify(latestSettings) ? current : latestSettings
    ));
    setTrackingStatusContext({
      permissionStatus,
      nativeStatus,
      batteryStatus,
      diagnostics,
    });
  }, []);

  const getLocalSpeedKnowledge = useCallback(() => {
    if (!localSpeedKnowledgeRef.current) {
      localSpeedKnowledgeRef.current = new LocalSpeedKnowledge(speedKnowledgeStore);
    }
    return localSpeedKnowledgeRef.current;
  }, []);

  useEffect(() => {
    activeTripRef.current = activeTrip;
  }, [activeTrip]);

  useEffect(() => {
    refreshTrackingStatusContext();
    const handleFocus = () => refreshTrackingStatusContext();
    const handleSettingsChanged = (event) => {
      setSettings(event?.detail?.settings || localSettings.get());
      refreshTrackingStatusContext();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshTrackingStatusContext();
    };
    const interval = isAndroid()
      ? window.setInterval(refreshTrackingStatusContext, tracking ? 10_000 : 60_000)
      : null;
    window.addEventListener('focus', handleFocus);
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (interval) window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refreshTrackingStatusContext, tracking]);

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
      endingTripRef.current = false;
      incidentAlertRef.current = 0;
      inferredSpeedZonesRef.current = [];
      gpsPointWarningLoggedRef.current = false;
      setGpsPointWarning(false);
      setManualForegroundWarning(false);
      setTrackingServiceMode(null);
      setHazardMessage(null);
      sensorFusionRef.current?.stop();
    }
  }, [tracking]);

  useEffect(() => {
    if (!tracking || !activeTrip || isPrivateTrip(activeTrip) || activeTrip.trip_state === TRIP_STATES.CANDIDATE) {
      setGpsPointWarning(false);
      return;
    }
    const rawPointCount = Array.isArray(activeTrip.route_points) ? activeTrip.route_points.length : 0;
    const tooFewPoints = elapsed >= 90 && rawPointCount <= 1;
    setGpsPointWarning(tooFewPoints);
    if (tooFewPoints && !gpsPointWarningLoggedRef.current) {
      gpsPointWarningLoggedRef.current = true;
      recordTrackingDiagnostic({
        type: 'gps_points_not_arriving',
        title: 'GPS points are not arriving',
        reason: 'too_few_points_after_start',
        elapsed_seconds: elapsed,
        route_points_raw_count: rawPointCount,
        background_tracking: activeTrip.background_tracking === true,
        start_source: activeTrip.start_source || 'unknown',
      });
    }
  }, [activeTrip, elapsed, tracking]);

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
    const headingDriftBetaThreshold = cfg.threshold_heading_drift_std_degs ?? 8;
    if (lastFiveMinutes.length >= 8 && headings.length >= 5 && highwayShare >= 0.8 && calculateAngularStdDev(headings) > headingDriftBetaThreshold) {
      stayAlertSentRef.current = true;
      lastStayAlertAtRef.current = Date.now();
      notifyStayAlert().catch((error) => {
        logError('heading_drift_notification', error);
      });
      if (!shouldMuteDashboardWebViewVoice(activeTripRef.current || activeTrip)) {
        speakSafetyAlert(buildVoiceAlertMessage('heading_drift_beta'), cfg).catch((error) => {
          logError('heading_drift_voice_alert', error);
        });
      }
    }
  }, [activeTrip, tracking]);

  // Load recent trips
  const { data: recentTrips = [], refetch } = useQuery({
    ...tripSummaryQueryOptions(),
  });

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 50 }),
  });

  const completedTrips = useMemo(() => recentTrips.filter(t => t.status === 'completed'), [recentTrips]);
  const driverCompletedTrips = useMemo(
    () => completedTrips.filter(isDriverMetricEligible),
    [completedTrips]
  );
  useEffect(() => {
    const onSpeedKnowledgeChanged = () => setSpeedKnowledgeRevision((value) => value + 1);
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadSpeedLimitReviewSummary = async () => {
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const conflictedCells = await knowledge.getConflictedCells().catch(() => []);
      const reviewTrip = completedTrips.find((trip) => speedLimitReviewNeededForTrip(trip));
      const tripReviewCount = reviewTrip
        ? Math.max(1, buildTripSpeedLimitReviewCells(reviewTrip, { maxCells: 8 }).length)
        : 0;
      const count = conflictedCells.length + tripReviewCount;
      const fingerprint = buildDashboardSpeedLimitReviewFingerprint({
        conflictedCells,
        reviewTrip,
        reviewCellCount: tripReviewCount,
      });
      if (cancelled) return;
      setSpeedLimitReviewSummary(count > 0 ? {
        count,
        tripId: reviewTrip?.id || null,
        hasConflicts: conflictedCells.length > 0,
        fingerprint,
      } : null);
    };
    loadSpeedLimitReviewSummary();
    return () => {
      cancelled = true;
    };
  }, [completedTrips, speedKnowledgeRevision]);

  const scoreModelMismatchTrips = useMemo(() => {
    const thresholds = buildDrivingThresholds(settings);
    return completedTrips.filter((trip) => getScoreProvenanceStatus(trip, thresholds).needsRescore);
  }, [completedTrips, settings]);
  const unavailableScoreTrips = useMemo(
    () => completedTrips.filter((trip) => getTripComponentScore(trip, 'overall').value == null),
    [completedTrips]
  );
  const scoreReviewFingerprint = useMemo(
    () => buildDashboardScoreReviewFingerprint({
      mismatchTrips: scoreModelMismatchTrips,
      unavailableTrips: unavailableScoreTrips,
    }),
    [scoreModelMismatchTrips, unavailableScoreTrips]
  );
  const showScoreReviewWarning = scoreReviewDismissalLoaded
    && scoreReviewFingerprint
    && dismissedScoreReviewFingerprint !== scoreReviewFingerprint;

  useEffect(() => {
    let cancelled = false;
    getJson(DASHBOARD_SCORE_REVIEW_DISMISSAL_KEY, '').then((fingerprint) => {
      if (cancelled) return;
      setDismissedScoreReviewFingerprint(typeof fingerprint === 'string' ? fingerprint : '');
      setScoreReviewDismissalLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissScoreReviewWarning = useCallback(() => {
    setDismissedScoreReviewFingerprint(scoreReviewFingerprint);
    setJson(DASHBOARD_SCORE_REVIEW_DISMISSAL_KEY, scoreReviewFingerprint).catch((error) => {
      logError('dashboard_score_review_dismissal_save', error);
    });
  }, [scoreReviewFingerprint]);

  useEffect(() => {
    let cancelled = false;
    getJson(DASHBOARD_SPEED_LIMIT_REVIEW_DISMISSAL_KEY, '').then((fingerprint) => {
      if (cancelled) return;
      setDismissedSpeedLimitReviewFingerprint(typeof fingerprint === 'string' ? fingerprint : '');
      setSpeedLimitReviewDismissalLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissSpeedLimitReviewWarning = useCallback((fingerprint) => {
    if (!fingerprint) return;
    setDismissedSpeedLimitReviewFingerprint(fingerprint);
    setJson(DASHBOARD_SPEED_LIMIT_REVIEW_DISMISSAL_KEY, fingerprint).catch((error) => {
      logError('dashboard_speed_limit_review_dismissal_save', error);
    });
  }, []);
  const habitProfile = useMemo(
    () => (completedTrips.length >= 5 ? buildHabitProfile(completedTrips) : null),
    [completedTrips.length, completedTrips[completedTrips.length - 1]?.id]
  );
  const dailyFatigue = useMemo(() => {
    const todayTrips = getTodayTrips(completedTrips);
    return computeDailyFatigue(todayTrips, settings, habitProfile?.fatigueOnsetMinutes);
  }, [completedTrips, habitProfile?.fatigueOnsetMinutes, settings]);

  useEffect(() => {
    getLastParkedLocation().then(setParkedLocation).catch((error) => {
      logError('dashboard_last_parked_location_load', error);
    });
  }, [completedTrips[0]?.id]);

  useEffect(() => {
    loadDangerZones().then(setDangerZones).catch((error) => {
      logError('dashboard_danger_zones_load', error);
    });
  }, [completedTrips[0]?.id]);

  useEffect(() => {
    setReadinessDismissed(false);
  }, [completedTrips[0]?.id]);

  // Resume active trip from session (crash recovery)
  useEffect(() => {
    const recovered = activeTripStore.get();
    if (isRecoverableActiveTrip(recovered)) {
      if (isPrivateTrip(recovered)) {
        privateTripRuntimeRef.current = createPrivateTripRuntime(recovered.private_trip_summary);
      }
      activeTripRef.current = recovered;
      trackingRef.current = true;
      setActiveTrip(recovered);
      setTracking(true);
      startTimer(new Date(recovered.start_time));
      // Re-attach GPS
      startGPS();
    } else if (recovered) {
      recordTrackingDiagnostic({
        type: 'trip_recovery_ignored',
        title: 'Stored active trip ignored on startup',
        reason: 'not_recoverable_active_trip',
        trip_state: recovered.trip_state || null,
      });
      activeTripStore.clear();
      activeTripStore.flush().catch((error) => {
        logError('active_trip_recovery_clear_flush', error, {
          reason: 'not_recoverable_active_trip',
          trip_state: recovered.trip_state || null,
        });
      });
    }
    return () => {
      stopTimer();
      locationService.current?.stop();
      activityStopRef.current?.();
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

  const clearNativeManualTripUi = useCallback(async (trip, completedTrip = null) => {
    trackingRef.current = false;
    await stopSafetyAlerts().catch((error) => {
      logError('native_manual_trip_completion_stop_voice_alerts', error, {
        tripId: completedTrip?.id || trip?.id || null,
      });
    });
    await locationService.current?.stop();
    locationService.current = null;
    sensorFusionRef.current?.stop();
    sensorFusionRef.current = null;
    await activityStopRef.current?.();
    activityStopRef.current = null;
    latestActivityRef.current = null;
    stopTimer();
    await cancelLongTripReminder();

    const storedActiveTrip = activeTripStore.get();
    if (
      !storedActiveTrip ||
      !completedTrip ||
      isNativeManualCompletionForActiveTrip(completedTrip, storedActiveTrip)
    ) {
      activeTripStore.clear();
      await activeTripStore.flush();
    }
    activeTripRef.current = null;
    autoEndingTripRef.current = false;
    endingTripRef.current = false;
    locationPermissionEndingRef.current = false;
    setEndingTrip(false);
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    setCurrentLocation(null);
    refreshTrackingStatusContext();
    refetch();
  }, [refreshTrackingStatusContext, refetch]);

  const reconcileNativeManualTripCompletion = useCallback(async (reason = 'dashboard_native_manual_reconcile') => {
    const trip = activeTripRef.current;
    if (!isAndroid() || !trip || trip.native_manual_background !== true) return false;
    if (endingTripRef.current || nativeManualReconcileInFlightRef.current) return false;

    nativeManualReconcileInFlightRef.current = true;
    try {
      const syncResult = await syncNativeCompletedTrips();
      let completedNativeTrip = syncResult.matchedActiveTrip ||
        findNativeManualCompletion(syncResult.importedTrips, trip);
      if (!completedNativeTrip && trip.id) {
        completedNativeTrip = await tripService.getById(trip.id).catch(() => null);
        if (
          completedNativeTrip &&
          !isNativeManualCompletionForActiveTrip(completedNativeTrip, trip)
        ) {
          completedNativeTrip = null;
        }
      }
      if (!completedNativeTrip && !activeTripStore.get()) {
        const storedTrips = await tripService.listAllSummaries({ sort: '-start_time' }).catch(() => []);
        completedNativeTrip = findNativeManualCompletion(storedTrips, trip);
      }
      if (!completedNativeTrip) return false;

      endingTripRef.current = true;
      setEndingTrip(true);
      recordTrackingDiagnostic({
        type: 'trip_ended',
        title: 'Native manual trip saved',
        reason,
        tripId: completedNativeTrip.id,
        duration_seconds: Math.round(completedNativeTrip.duration_seconds || 0),
        distance_km: completedNativeTrip.distance_km || 0,
        route_points_raw_count: Array.isArray(completedNativeTrip.route_points)
          ? completedNativeTrip.route_points.length
          : 0,
      });
      await clearNativeManualTripUi(trip, completedNativeTrip);
      return true;
    } catch (error) {
      logError('native_manual_trip_dashboard_reconcile', error, {
        tripId: trip.id || null,
        start_source: trip.start_source || null,
      });
      return false;
    } finally {
      nativeManualReconcileInFlightRef.current = false;
    }
  }, [clearNativeManualTripUi]);

  useEffect(() => {
    const onNativeManualTripFinalized = (event) => {
      if (endingTripRef.current) return;
      const trip = activeTripRef.current;
      const completedTrip = event.detail?.completedTrip;
      if (!trip || !isNativeManualCompletionForActiveTrip(completedTrip, trip)) return;
      endingTripRef.current = true;
      void clearNativeManualTripUi(trip, completedTrip);
    };
    window.addEventListener(NATIVE_MANUAL_TRIP_FINALIZED_EVENT, onNativeManualTripFinalized);
    return () => window.removeEventListener(NATIVE_MANUAL_TRIP_FINALIZED_EVENT, onNativeManualTripFinalized);
  }, [clearNativeManualTripUi]);

  useEffect(() => {
    if (!isAndroid() || activeTrip?.native_manual_background !== true) return undefined;

    const reconcile = (reason) => {
      reconcileNativeManualTripCompletion(reason).catch((error) => {
        logError('native_manual_trip_dashboard_reconcile_schedule', error, { reason });
      });
    };
    const handleFocus = () => reconcile('dashboard_focus_native_manual_reconcile');
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        reconcile('dashboard_visibility_native_manual_reconcile');
      }
    };

    reconcile('dashboard_mount_native_manual_reconcile');
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    const interval = window.setInterval(
      () => reconcile('dashboard_poll_native_manual_reconcile'),
      5000
    );

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(interval);
    };
  }, [activeTrip?.id, activeTrip?.native_manual_background, reconcileNativeManualTripCompletion]);

  const discardCandidateTrip = useCallback(async (trip, decision) => {
    const cfg = localSettings.get();
    endingTripRef.current = true;
    trackingRef.current = false;
    await stopSafetyAlerts().catch((error) => {
      logError('trip_end_stop_voice_alerts', error, {
        start_source: trip?.start_source || null,
        native_manual_background: trip?.native_manual_background === true,
      });
    });
    await locationService.current?.stop();
    locationService.current = null;
    sensorFusionRef.current?.stop();
    await activityStopRef.current?.();
    activityStopRef.current = null;
    latestActivityRef.current = null;
    stopTimer();
    await cancelLongTripReminder();
    recordTrackingDiagnostic({
      type: 'trip_discarded',
      title: decision?.title || 'Candidate discarded',
      reason: decision?.reason || 'candidate_not_confirmed',
      trip_state: TRIP_STATES.DISCARDED,
      duration_seconds: Math.round((decision?.metrics?.candidate_age_ms || 0) / 1000),
      distance_m: decision?.metrics?.distance_m ?? null,
      max_speed_kmh: Math.round(decision?.metrics?.max_speed_kmh || 0),
      stable_points: decision?.metrics?.stable_points ?? null,
      near_parked_location: trip?.candidate_near_parked === true,
    });
    activeTripStore.clear();
    await activeTripStore.flush();
    activeTripRef.current = null;
    trackingRef.current = false;
    autoEndingTripRef.current = false;
    endingTripRef.current = false;
    locationPermissionEndingRef.current = false;
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    if (isAndroid() && !cfg.tracking_paused && (trip?.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
      await startNativeAutoTracking().catch((error) => {
        logError('native_auto_tracking_resume_after_discard', error, {
          trip_state: trip?.trip_state || null,
          resume_native_auto: trip?.resume_native_auto === true,
        });
      });
    }
    refreshTrackingStatusContext();
    setLocationError('Auto-detected movement was ignored because it did not prove vehicle-like.');
  }, [refreshTrackingStatusContext]);

  const markActiveTripLocationPermissionLoss = useCallback((reason = 'web_geolocation_permission_denied') => {
    const current = activeTripRef.current;
    if (!current) return null;
    const flags = new Set(Array.isArray(current.data_quality_flags) ? current.data_quality_flags : []);
    flags.add('location_permission_loss');
    const timeline = Array.isArray(current.timeline) ? current.timeline : [];
    const updated = {
      ...current,
      data_quality_flags: Array.from(flags),
      score_confidence_flag: 'data_gap_detected',
      timeline: [
        ...timeline,
        {
          type: 'location_permission_lost',
          timestamp: new Date().toISOString(),
          reason,
        },
      ],
    };
    activeTripStore.set(updated);
    activeTripRef.current = updated;
    setActiveTrip(updated);
    return updated;
  }, []);

  const handleLocationTrackingError = useCallback(async (err) => {
    if (err?.type !== 'permission_denied') {
      setLocationError(err?.message || 'Location tracking failed.');
      return;
    }

    setLocationError(err.message || 'Location permission was denied.');
    if (!trackingRef.current || !activeTripRef.current || locationPermissionEndingRef.current) return;

    const updated = markActiveTripLocationPermissionLoss('web_geolocation_permission_denied');
    recordTrackingDiagnostic({
      type: 'location_permission_lost',
      title: 'Location permission lost during trip',
      reason: 'web_geolocation_permission_denied',
      trip_state: updated?.trip_state || null,
      speed_kmh: Math.round(currentLocation?.speed_kmh || 0),
    });
    locationPermissionEndingRef.current = true;
    await endTripRef.current?.();
  }, [currentLocation?.speed_kmh, markActiveTripLocationPermissionLoss]);

  const promoteCandidateTrip = useCallback((trip, decision) => {
    const promoted = {
      ...trip,
      trip_state: TRIP_STATES.CONFIRMED,
      candidate_confirmed_at: new Date().toISOString(),
      candidate_confirmation_reason: decision?.reason || 'vehicle_like_movement',
      candidate_validation: decision?.metrics || null,
      route_points: decision?.cleanPoints?.length ? decision.cleanPoints : trip.route_points,
    };
    activeTripStore.set(promoted);
    activeTripRef.current = promoted;
    setActiveTrip(promoted);
    recordTrackingDiagnostic({
      type: 'candidate_confirmed',
      title: 'Candidate confirmed: vehicle-like movement detected',
      reason: decision?.reason || 'vehicle_like_movement',
      trip_state: TRIP_STATES.CONFIRMED,
      distance_m: decision?.metrics?.distance_m ?? null,
      max_speed_kmh: Math.round(decision?.metrics?.max_speed_kmh || 0),
      stable_points: decision?.metrics?.stable_points ?? null,
      near_parked_location: promoted.candidate_near_parked === true,
    });
    recordTrackingDiagnostic({
      type: 'auto_start',
      title: 'In-app auto trip confirmed',
      reason: decision?.reason || 'vehicle_like_movement',
      speed_kmh: Math.round(decision?.metrics?.max_speed_kmh || 0),
    });
    refreshTrackingStatusContext();
    notifyTripStarted(promoted).catch((error) => {
      logError('candidate_trip_started_notification', error, {
        trip_state: promoted.trip_state,
        start_source: promoted.start_source,
      });
    });
    Promise.resolve(scheduleLongTripReminder(promoted.start_time)).catch((error) => {
      logError('candidate_long_trip_reminder_schedule', error, {
        trip_state: promoted.trip_state,
        start_source: promoted.start_source,
      });
    });
  }, [refreshTrackingStatusContext]);

  const startGPS = useCallback(async ({ forceForeground = false } = {}) => {
    const cfg = localSettings.get();
    const useBackground = !forceForeground && (
      activeTripRef.current?.background_tracking === true ||
      cfg.background_tracking_enabled ||
      cfg.tracking_mode === 'background_auto'
    );
    if (forceForeground && locationService.current?.isActive?.()) {
      await locationService.current.stop().catch((error) => {
        logError('tracking_service_foreground_restart', error, {
          reason: 'manual_background_fallback',
        });
      });
      locationService.current = null;
    }
    if (!locationService.current) {
      locationService.current = createDrivingTrackingService({
        background: useBackground,
        privateMode: isPrivateTrip(activeTripRef.current),
      });
    }
    const status = await locationService.current.start(
      async (point) => {
        setCurrentLocation(point);
        setLocationError(null);
        if (endingTripRef.current || !trackingRef.current || !activeTripRef.current) return;
        const latestSettings = localSettings.get();
        const tripBeforePoint = activeTripRef.current;
        if (isPrivateTrip(tripBeforePoint)) {
          privateTripRuntimeRef.current ||= createPrivateTripRuntime(tripBeforePoint.private_trip_summary);
          const privateSummary = processPrivateTripPoint(
            privateTripRuntimeRef.current,
            point,
            tripBeforePoint.start_time
          );
          const updated = {
            ...tripBeforePoint,
            private_trip_summary: privateSummary,
          };
          if (endingTripRef.current || !trackingRef.current) return;
          activeTripStore.set(updated);
          activeTripRef.current = updated;
          setActiveTrip(updated);

          const speed = Number(point.speed_kmh) || 0;
          const nowMs = Date.now();
          if (speed >= 15) {
            lastMovingSpeedRef.current = speed;
            stillSinceRef.current = null;
            stoppedAnchorRef.current = null;
            return;
          }
          if (speed >= 5) lastMovingSpeedRef.current = speed;

          stillSinceRef.current ??= nowMs;
          stoppedAnchorRef.current ??= { lat: point.lat, lng: point.lng };
          const stillSeconds = (nowMs - stillSinceRef.current) / 1000;
          const recentPoints = privateTripRuntimeRef.current.recentPoints.filter((routePoint) => (
            new Date(routePoint.timestamp).getTime() >= stillSinceRef.current - 5000
          ));
          const gpsPositionDriftM = computeGpsPositionDrift(
            stoppedAnchorRef.current.lat,
            stoppedAnchorRef.current.lng,
            recentPoints
          );
          const activityStopDecision = shouldAutoStopTracking({
            activity: latestActivityRef.current,
            currentSpeedKmh: speed,
            stillSeconds,
            gpsPositionDriftM,
            lastMovingSpeedKmh: lastMovingSpeedRef.current,
            nowMs,
            returnReason: true,
          });
          const gpsParked = speed < 2 && (
            (stillSeconds >= 90 && gpsPositionDriftM < 5) ||
            (stillSeconds >= 180 && gpsPositionDriftM < 20) ||
            stillSeconds >= 300
          );
          if (activityStopDecision.shouldStop || gpsParked) {
            recordTrackingDiagnostic({
              type: 'auto_stop',
              title: 'Private trip auto-ended',
              reason: activityStopDecision.shouldStop
                ? activityStopDecision.reason || 'activity_parked'
                : 'gps_parked',
              speed_kmh: Math.round(speed),
              stopped_seconds: Math.round(stillSeconds),
              drift_m: Math.round(gpsPositionDriftM),
            });
            autoEndingTripRef.current = true;
            endTripRef.current?.();
          }
          return;
        }
        const isCandidateTrip = tripBeforePoint?.trip_state === TRIP_STATES.CANDIDATE;
        const webViewVoiceMuted = shouldMuteDashboardWebViewVoice(tripBeforePoint);
        const latestPrivacyZones = getPrivacyZones(latestSettings);
        const pointInPrivacyZone = isInsidePrivacyZone(point.lat, point.lng, latestPrivacyZones);
        const storedPoint = redactRoutePointForPrivacyStorage(point, latestPrivacyZones);
        if (!isCandidateTrip && !pointInPrivacyZone && latestSettings.danger_zone_alerts_enabled !== false) {
          const zones = await loadDangerZones();
          const nearby = checkDangerZoneProximity(point.lat, point.lng, zones, 300);
          if (nearby.length > 0 && Date.now() - lastProximityAlertRef.current > 60 * 1000) {
            const zone = nearby[0];
            lastProximityAlertRef.current = Date.now();
            const typeLabel = String(zone.dominantType || 'risk event').replace(/_/g, ' ');
            const body = `${typeLabel} repeated-event area ${Math.round(zone.distanceM || 0)} m ahead`;
            setHazardMessage({ body, at: Date.now() });
            notifyStayAlert({
              id: 4007,
              title: 'Repeated event area ahead',
              body,
              extra: { type: 'repeated_event_area', zoneId: zone.id },
            }).catch((error) => {
              logError('repeated_event_area_notification', error, {
                zone_id: zone.id,
                distance_m: Math.round(zone.distanceM || 0),
              });
            });
            if (!webViewVoiceMuted) {
              speakSafetyAlert(buildVoiceAlertMessage('repeated_event_area', {
                dominantType: typeLabel,
                distanceM: zone.distanceM,
              }), latestSettings).catch((error) => {
                logError('repeated_event_area_voice_alert', error, {
                  zone_id: zone.id,
                  distance_m: Math.round(zone.distanceM || 0),
                });
              });
            }
          }
        }
        const routePointsWithLatest = [...(tripBeforePoint?.route_points || []), storedPoint];
        const routePointsForLiveContext = [
          ...(tripBeforePoint?.route_points || []).filter((routePoint) => (
            Number.isFinite(Number(routePoint?.lat)) && Number.isFinite(Number(routePoint?.lng))
          )),
          point,
        ];
        const speed = Number(point.speed_kmh) || 0;
        const thresholds = buildDrivingThresholds(latestSettings);
        inferredSpeedZonesRef.current = inferSpeedZones(routePointsForLiveContext, thresholds);
        const pointTimestampMs = new Date(point.timestamp || Date.now()).getTime();
        const localKnowledge = pointInPrivacyZone
          ? null
          : await getLocalSpeedKnowledge().getForPoint(
            point.lat,
            point.lng,
            Number.isFinite(pointTimestampMs) ? pointTimestampMs : Date.now(),
            { headingDeg: point.heading ?? point.bearing ?? point.course ?? null }
          ).catch(() => null);
        const speedLimitContext = resolveEffectiveSpeedLimitForIndex(
          routePointsForLiveContext,
          routePointsForLiveContext.length - 1,
          thresholds,
          { inferredZones: inferredSpeedZonesRef.current, localKnowledge, settings: latestSettings }
        );
        const resolved = createTierAwareSpeedLimitContext(speedLimitContext, latestSettings);
        if (!isCandidateTrip && hasLiveSpeedEvidence(tripBeforePoint, routePointsForLiveContext, point)) {
          checkAndSpeakSpeedAlert(speed, resolved, latestSettings, () => {
            const badge = speedLimitBadgeForResolved(resolved);
            const alertLabel = resolved?.tier === 'POSTED' ? 'Speed warning' : 'Speed check';
            setHazardMessage({
              body: `${alertLabel}: ${Math.round(speed)} km/h over ${badge.text}`,
              at: Date.now(),
            });
          }, { voiceMuted: webViewVoiceMuted });
        }
        if (tripBeforePoint) {
          const updated = { ...tripBeforePoint, route_points: routePointsWithLatest };
          if (endingTripRef.current || !trackingRef.current) return;
          activeTripStore.set(updated);
          activeTripRef.current = updated;
          setActiveTrip(updated);
        }
        const trip = activeTripRef.current;
        if (!trip || !trackingRef.current || autoEndingTripRef.current) return;
        if (trip.trip_state === TRIP_STATES.CANDIDATE) {
          const decision = validateCandidateTrip({
            points: trip.route_points || [],
            startTime: trip.start_time,
            now: point.timestamp || new Date().toISOString(),
            activity: latestActivityRef.current,
            nearParkedLocation: trip.candidate_near_parked === true,
            thresholds: buildDrivingThresholds(latestSettings),
          });
          if (decision.confirmed) {
            promoteCandidateTrip(trip, decision);
          } else if (decision.discarded) {
            await discardCandidateTrip(trip, decision);
          }
          return;
        }
        const incident = detectCrashIncident({
          routePoints: trip.route_points || [],
          motionSamples: sensorFusionRef.current?.getSamples?.() || [],
          activity: latestActivityRef.current,
          settings: latestSettings,
        });
        if (incident && Date.now() - incidentAlertRef.current > 5 * 60 * 1000) {
          incidentAlertRef.current = Date.now();
          const emergencyWorkflow = latestSettings.emergency_workflow_enabled === true;
          const workflowBody = emergencyWorkflow
            ? 'Possible incident signal recorded. Emergency check-in is active until you end or review the trip.'
            : 'Possible incident signal recorded. Check in now.';
          const incidentEvent = {
            ...incident,
            emergency_workflow_pending: emergencyWorkflow,
          };
          setHazardMessage({ body: workflowBody, at: Date.now(), persistent: emergencyWorkflow });
          notifyStayAlert({
            id: 4011,
            title: 'Possible Incident Signal',
            body: emergencyWorkflow
              ? 'Impact-like motion and little movement were recorded. Open Road Sage to check in.'
              : 'Road Sage recorded impact-like motion followed by little movement.',
            extra: { type: 'possible_crash', severity: incident.severity, emergencyWorkflow },
          }).catch((error) => {
            logError('possible_incident_notification', error, {
              severity: incident.severity,
              emergency_workflow: emergencyWorkflow,
            });
          });
          if (!webViewVoiceMuted) {
            speakSafetyAlert(buildVoiceAlertMessage('possible_incident', {
              emergencyWorkflow,
            }), latestSettings, { interrupt: true }).catch((error) => {
              logError('possible_incident_voice_alert', error, {
                severity: incident.severity,
                emergency_workflow: emergencyWorkflow,
              });
            });
          }
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
        const recentPoints = (trip.route_points || []).filter((routePoint) => (
          Number.isFinite(Number(routePoint?.lat)) &&
          Number.isFinite(Number(routePoint?.lng)) &&
          new Date(routePoint.timestamp).getTime() >= stillSinceRef.current - 5000
        ));
        const gpsPositionDriftM = computeGpsPositionDrift(
          stoppedAnchorRef.current.lat,
          stoppedAnchorRef.current.lng,
          recentPoints
        );
        const activity = latestActivityRef.current;
        const activityStopDecision = shouldAutoStopTracking({
          activity,
          currentSpeedKmh: speed,
          stillSeconds,
          gpsPositionDriftM,
          lastMovingSpeedKmh: lastMovingSpeedRef.current,
          nowMs,
          returnReason: true,
        });
        const activityParked = activityStopDecision.shouldStop;
        const gpsParked = speed < 2 && (
          (stillSeconds >= 90 && gpsPositionDriftM < 5) ||
          (stillSeconds >= 180 && gpsPositionDriftM < 20) ||
          stillSeconds >= 300
        );

        if (activityParked || gpsParked) {
          if (activityStopDecision.reason === 'activity_recognition_stale') {
            recordTrackingDiagnostic({
              type: 'activity_recognition_stale',
              title: 'Activity recognition stale; GPS-only stop fallback used',
              reason: 'activity_state_stale',
              speed_kmh: Math.round(speed),
              stopped_seconds: Math.round(stillSeconds),
              drift_m: Math.round(gpsPositionDriftM),
            });
          }
          recordTrackingDiagnostic({
            type: 'auto_stop',
            title: 'In-app trip auto-ended',
            reason: activityParked ? activityStopDecision.reason || 'activity_parked' : 'gps_parked',
            speed_kmh: Math.round(speed),
            stopped_seconds: Math.round(stillSeconds),
            drift_m: Math.round(gpsPositionDriftM),
          });
          autoEndingTripRef.current = true;
          endTripRef.current?.().catch((error) => {
            logError('auto_stop_end_trip', error, {
              reason: activityParked ? activityStopDecision.reason || 'activity_parked' : 'gps_parked',
              speed_kmh: Math.round(speed),
            });
          });
        }
      },
      handleLocationTrackingError
    );
    setTrackingServiceMode(status || null);
    return status || null;
  }, [discardCandidateTrip, getLocalSpeedKnowledge, handleLocationTrackingError, promoteCandidateTrip]);

  const handleStartTrip = useCallback(async ({
    autoStarted = false,
    bypassFatigueWarning = false,
    bypassManualForegroundWarning = false,
    forceBackgroundTracking = false,
    candidate = false,
    privateTrip = false,
    initialPoint = null,
    nearParkedLocation = false,
    triggerReason = null,
  } = {}) => {
    if (trackingRef.current || endingTripRef.current) return;
    autoEndingTripRef.current = false;
    endingTripRef.current = false;
    locationPermissionEndingRef.current = false;
    setCurrentLocation(null);
    setHazardMessage(null);
    setGpsPointWarning(false);
    gpsPointWarningLoggedRef.current = false;

    const cfg = localSettings.get();
    if (!autoStarted && !bypassFatigueWarning && dailyFatigue.shouldWarnBeforeTrip) {
      setPendingStartOptions({
        autoStarted,
        bypassManualForegroundWarning,
        forceBackgroundTracking,
        candidate,
        privateTrip,
        initialPoint,
        nearParkedLocation,
        triggerReason,
      });
      setFatigueDialogOpen(true);
      return;
    }
    if (cfg.tracking_paused) {
      recordTrackingDiagnostic({
        type: 'auto_blocked',
        title: autoStarted ? 'Auto tracking blocked' : 'Trip start blocked',
        reason: 'tracking_paused',
      });
      refreshTrackingStatusContext();
      setLocationError('Tracking is paused in Settings.');
      return;
    }

    const summaryOnlyPrivateTrip = privateTrip === true && !autoStarted && !candidate;
    const configuredBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
    const manualAndroidTrip = !autoStarted && !candidate && !summaryOnlyPrivateTrip && isAndroid();
    const manualBackgroundReady = manualAndroidTrip &&
      cfg.background_location_granted === true &&
      cfg.notification_permission_granted === true;
    const useBackground = manualAndroidTrip || forceBackgroundTracking || configuredBackground || manualBackgroundReady;
    const needsManualForegroundConfirmation = false;
    if (manualBackgroundReady && !forceBackgroundTracking && !configuredBackground) {
      recordTrackingDiagnostic({
        type: 'manual_background_tracking_auto_selected',
        title: 'Manual trip using available background tracking',
        reason: 'android_background_permissions_ready',
        background_tracking: true,
      });
    }
    if (needsManualForegroundConfirmation && !bypassManualForegroundWarning) {
      setPendingManualForegroundStartOptions({
        autoStarted,
        bypassFatigueWarning,
        forceBackgroundTracking,
        candidate,
        privateTrip,
        initialPoint,
        nearParkedLocation,
        triggerReason,
      });
      setManualForegroundConfirmOpen(true);
      recordTrackingDiagnostic({
        type: 'manual_foreground_confirmation_required',
        title: 'Manual foreground tracking confirmation required',
        reason: 'android_background_tracking_recommended',
        background_tracking: false,
      });
      return;
    }

    let pausedNativeAuto = false;
    pausedNativeAuto = false;

    if ((autoStarted || cfg.auto_tracking_enabled || cfg.tracking_mode !== 'manual') && isAndroid()) {
      const activityGranted = await requestActivityRecognitionPermission();
      if (!activityGranted) {
        if (pausedNativeAuto) {
          await startNativeAutoTracking().catch((error) => {
            logError('native_auto_tracking_resume_after_activity_denied', error, {
              tracking_mode: cfg.tracking_mode,
            });
          });
        }
        recordTrackingDiagnostic({
          type: 'auto_blocked',
          title: autoStarted ? 'Auto tracking blocked' : 'Trip start blocked',
          reason: 'activity_permission_denied',
        });
        refreshTrackingStatusContext();
        setLocationError('Physical activity permission is required for auto trip detection.');
        return;
      }
    }

    const granted = useBackground
      ? await requestBackgroundLocationPermission()
      : await requestForegroundLocationPermission();

    if (!granted) {
      if (pausedNativeAuto) {
        await startNativeAutoTracking().catch((error) => {
          logError('native_auto_tracking_resume_after_location_denied', error, {
            tracking_mode: cfg.tracking_mode,
            requested_background: useBackground,
          });
        });
      }
      recordTrackingDiagnostic({
        type: 'auto_blocked',
        title: autoStarted ? 'Auto tracking blocked' : 'Trip start blocked',
        reason: useBackground ? 'background_location_or_notification_denied' : 'location_permission_denied',
      });
      refreshTrackingStatusContext();
      setLocationError(useBackground
        ? 'Background tracking needs location and notification permission before a trip can start.'
        : 'Location permission denied. Please enable location to start a trip.');
      return;
    }

    if (manualAndroidTrip) {
      const notificationGranted = await requestNotificationPermission();
      if (!notificationGranted) {
        recordTrackingDiagnostic({
          type: 'manual_background_tracking_blocked',
          title: 'Manual background trip blocked',
          reason: 'notification_permission_denied',
          background_tracking: true,
        });
        refreshTrackingStatusContext();
        setLocationError('Android manual trips need notification permission so Road Sage can keep background voice alerts running.');
        return;
      }
    }

    const startTime = initialPoint?.timestamp || new Date().toISOString();
    const nativeManualBackground = manualAndroidTrip;
    const nativeManualTripId = nativeManualBackground
      ? createNativeManualTripId(new Date(startTime).getTime())
      : null;
    if (nativeManualBackground) {
      try {
        await startNativeManualTrip({ startTime, tripId: nativeManualTripId });
        recordTrackingDiagnostic({
          type: 'manual_native_background_started',
          title: 'Native manual background tracking started',
          reason: 'manual_button',
          background_tracking: true,
        });
      } catch (error) {
        logError('native_manual_background_start', error, {
          tracking_mode: cfg.tracking_mode,
        });
        recordTrackingDiagnostic({
          type: 'manual_background_tracking_blocked',
          title: 'Manual background trip blocked',
          reason: 'native_manual_service_failed',
          error: error?.message || 'Native manual service failed to start',
          background_tracking: true,
        });
        refreshTrackingStatusContext();
        setLocationError(error?.message || 'Android background manual tracking could not start. Check background location and notification permission.');
        return;
      }
    }
    const storedInitialPoint = initialPoint && !summaryOnlyPrivateTrip
      ? redactRoutePointForPrivacyStorage(initialPoint, getPrivacyZones(cfg))
      : null;
    const phoneUsageAccessStatus = !summaryOnlyPrivateTrip && isAndroid()
      ? await getAndroidUsageAccessStatus().catch(() => null)
      : null;
    const phoneUsageAccessGrantedAtStart = phoneUsageAccessStatus?.usageAccessGranted === true;
    const tripData = {
      ...(nativeManualTripId ? {
        id: nativeManualTripId,
        manual_session_id: nativeManualTripId,
      } : {}),
      start_time: startTime,
      status: 'active',
      trip_state: candidate ? TRIP_STATES.CANDIDATE : TRIP_STATES.CONFIRMED,
      route_points: storedInitialPoint ? [storedInitialPoint] : [],
      driving_events: [],
      ...(summaryOnlyPrivateTrip ? {
        privacy_mode: PRIVATE_TRIP_MODE,
        private_trip_summary: {
          distance_m: 0,
          duration_seconds: 0,
          avg_speed_kmh: 0,
          avg_running_speed_kmh: 0,
          max_speed_kmh: 0,
          gps_points_processed: 0,
          gps_points_stored: 0,
        },
      } : {}),
      background_tracking: useBackground,
      start_source: autoStarted ? 'auto' : 'manual',
      native_manual_background: nativeManualBackground,
      voice_alert_owner: nativeManualBackground ? 'native_android' : 'webview',
      resume_native_auto: !autoStarted && configuredBackground && isAndroid(),
      candidate_started_at: candidate ? startTime : null,
      candidate_first_point: candidate && storedInitialPoint ? storedInitialPoint : null,
      candidate_near_parked: candidate ? nearParkedLocation === true : false,
      candidate_trigger_reason: triggerReason,
      ...(!summaryOnlyPrivateTrip ? {
        native_phone_usage_access_granted: phoneUsageAccessGrantedAtStart,
        native_phone_usage_access_checked_at: phoneUsageAccessStatus ? new Date().toISOString() : null,
      } : {}),
    };

    privateTripRuntimeRef.current = summaryOnlyPrivateTrip ? createPrivateTripRuntime() : null;
    activeTripStore.set(tripData);
    if (candidate) {
      recordTrackingDiagnostic({
        type: 'candidate_started',
        title: 'Candidate started: speed >= 5 km/h for 2 seconds',
        reason: triggerReason || 'sustained_gps_movement',
        trip_state: TRIP_STATES.CANDIDATE,
        speed_kmh: Math.round(initialPoint?.speed_kmh || 0),
        background_tracking: useBackground,
      });
      if (nearParkedLocation) {
        recordTrackingDiagnostic({
          type: 'candidate_hidden_parking_cooldown',
          title: 'Candidate hidden due to parking cooldown zone',
          reason: 'near_last_parked_location',
          trip_state: TRIP_STATES.CANDIDATE,
          speed_kmh: Math.round(initialPoint?.speed_kmh || 0),
        });
      }
    } else {
      recordTrackingDiagnostic({
        type: 'trip_started',
        title: autoStarted ? 'In-app auto trip started' : 'Manual trip started',
        reason: autoStarted ? 'auto_detection' : 'manual_button',
        trip_state: TRIP_STATES.CONFIRMED,
        background_tracking: useBackground,
      });
    }
    refreshTrackingStatusContext();
    activeTripRef.current = tripData;
    trackingRef.current = true;
    setActiveTrip(tripData);
    setTracking(true);
    if (!summaryOnlyPrivateTrip && cfg.sensor_fusion_enabled !== false) {
      sensorFusionRef.current = createMotionSensorFusion();
      sensorFusionRef.current.start().catch((error) => {
        logError('sensor_fusion_start', error, {
          start_source: tripData.start_source,
          background_tracking: tripData.background_tracking,
        });
      });
    }
    if (isAndroid() && !activityStopRef.current && (candidate || autoStarted || cfg.auto_tracking_enabled || cfg.tracking_mode !== 'manual')) {
      activityStopRef.current = await startActivityRecognition(
        (activity) => {
          latestActivityRef.current = activity;
        },
        (err) => setLocationError(err.message)
      );
    }
    startTimer(new Date(startTime));
    let tripForNotifications = tripData;
    let trackingStartStatus = null;
    try {
      trackingStartStatus = await startGPS();
    } catch (error) {
      if (!nativeManualBackground) throw error;
      logError('manual_web_background_watcher_start', error, {
        background_tracking: true,
        native_manual_background: true,
      });
      recordTrackingDiagnostic({
        type: 'manual_web_background_watcher_unavailable',
        title: 'Manual WebView background watcher failed; native service remains active',
        reason: error?.message || 'webview_background_watcher_failed',
        background_tracking: true,
      });
      setTrackingServiceMode({
        mode: 'background',
        watcher_type: 'native_android_service',
        reason: 'native_manual_trip_service',
      });
    }
    if (
      manualAndroidTrip &&
      useBackground &&
      !summaryOnlyPrivateTrip &&
      trackingStartStatus?.mode !== 'background'
    ) {
      recordTrackingDiagnostic({
        type: 'manual_web_background_watcher_unavailable',
        title: 'Manual WebView background watcher unavailable; native service remains active',
        reason: trackingStartStatus?.reason || 'background_watcher_not_started',
        expected_mode: 'background',
        actual_mode: trackingStartStatus?.mode || 'not_started',
        watcher_type: trackingStartStatus?.watcher_type || null,
        background_tracking: true,
      });
      setTrackingServiceMode({
        mode: 'background',
        watcher_type: 'native_android_service',
        reason: 'native_manual_trip_service',
      });
      const foregroundStatus = await startGPS({ forceForeground: true });
      trackingStartStatus = foregroundStatus || trackingStartStatus;
      recordTrackingDiagnostic({
        type: 'manual_background_tracking_fallback_foreground',
        title: 'Manual trip fell back to foreground GPS',
        reason: foregroundStatus?.reason || trackingStartStatus?.reason || 'background_watcher_not_started',
        expected_mode: 'background',
        actual_mode: foregroundStatus?.mode || 'not_started',
        background_tracking: true,
      });
    }
    if (needsManualForegroundConfirmation && !useBackground) {
      setManualForegroundWarning(true);
      notifyForegroundManualTrackingWarning(tripForNotifications).catch((error) => {
        logError('manual_foreground_tracking_warning_notification', error, {
          start_source: tripForNotifications.start_source,
          background_tracking: tripForNotifications.background_tracking,
        });
      });
    } else {
      setManualForegroundWarning(false);
    }
    if (!candidate) {
      notifyTripStarted(tripForNotifications).catch((error) => {
        logError('manual_trip_started_notification', error, {
          start_source: tripForNotifications.start_source,
          background_tracking: tripForNotifications.background_tracking,
        });
      });
      if (!shouldMuteDashboardWebViewVoice(tripForNotifications)) {
        speakSafetyAlertOnce(
          'tracking_ready',
          buildVoiceAlertMessage('tracking_ready'),
          cfg,
          5 * 60 * 1000,
          undefined,
          { interrupt: true }
        ).catch((error) => {
          logError('tracking_ready_voice_alert', error, {
            start_source: tripForNotifications.start_source,
            background_tracking: tripForNotifications.background_tracking,
          });
        });
      }
      Promise.resolve(scheduleLongTripReminder(tripForNotifications.start_time)).catch((error) => {
        logError('long_trip_reminder_schedule', error, {
          start_source: tripForNotifications.start_source,
        });
      });
    }
    if (summaryOnlyPrivateTrip) {
      void appendPrivacyEvent({
        op: 'PRIVATE_TRIP_STARTED',
        details: { status: 'summary_only' },
      }).catch((error) => {
        logError('private_trip_audit_start', error);
      });
    }
  }, [dailyFatigue.shouldWarnBeforeTrip, refreshTrackingStatusContext, startGPS]);

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

  const handleDiscardPrivateTrip = async () => {
    const trip = activeTripRef.current || activeTrip;
    if (!isPrivateTrip(trip)) return;
    if (typeof window !== 'undefined' && !window.confirm('Discard this private trip? No trip summary will be saved.')) return;

    const cfg = localSettings.get();
    endingTripRef.current = true;
    trackingRef.current = false;
    await locationService.current?.stop();
    locationService.current = null;
    sensorFusionRef.current?.stop();
    sensorFusionRef.current = null;
    await activityStopRef.current?.();
    activityStopRef.current = null;
    latestActivityRef.current = null;
    stopTimer();
    await cancelLongTripReminder();

    void appendPrivacyEvent({
      op: 'PRIVATE_TRIP_DISCARDED',
      hiddenCount: trip.private_trip_summary?.gps_points_processed || 0,
      details: {
        point_count: trip.private_trip_summary?.gps_points_processed || 0,
        status: 'discarded',
      },
    }).catch((error) => {
      logError('private_trip_audit_discard', error);
    });

    activeTripStore.clear();
    await activeTripStore.flush();
    privateTripRuntimeRef.current = null;
    activeTripRef.current = null;
    trackingRef.current = false;
    autoEndingTripRef.current = false;
    endingTripRef.current = false;
    locationPermissionEndingRef.current = false;
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    setLocationError('Private trip discarded. No trip summary was saved.');
    if (isAndroid() && !cfg.tracking_paused && (trip.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
      await startNativeAutoTracking().catch((error) => {
        logError('native_auto_tracking_resume_after_private_discard', error, {
          resume_native_auto: trip.resume_native_auto === true,
        });
      });
    }
    refreshTrackingStatusContext();
  };

  const handleEndTrip = async () => {
    let tripToEnd = activeTripRef.current || activeTrip;
    if (!tripToEnd || endingTripRef.current) return;
    const endingForLocationPermissionLoss = locationPermissionEndingRef.current;

    endingTripRef.current = true;
    setEndingTrip(true);
    await waitForTripEndingFeedbackPaint();

    try {
    trackingRef.current = false;
    await locationService.current?.stop();
    locationService.current = null;
    sensorFusionRef.current?.stop();
    stopTimer();
    await cancelLongTripReminder();

    let endTime = new Date().toISOString();
    const cfg = localSettings.get();
    let nativeManualEndRequested = false;
    if (tripToEnd.native_manual_background === true) {
      let completedNativeTrip = null;
      try {
        await endNativeActiveTrip({ keepArmed: false });
        nativeManualEndRequested = true;
        for (let attempt = 0; attempt < 30 && !completedNativeTrip; attempt += 1) {
          const syncResult = await syncNativeCompletedTrips();
          completedNativeTrip = syncResult.matchedActiveTrip ||
            findNativeManualCompletion(syncResult.importedTrips, tripToEnd);
          if (!completedNativeTrip && tripToEnd.id) {
            completedNativeTrip = await tripService.getById(tripToEnd.id).catch(() => null);
            if (
              completedNativeTrip &&
              !isNativeManualCompletionForActiveTrip(completedNativeTrip, tripToEnd)
            ) {
              completedNativeTrip = null;
            }
          }
          if (!completedNativeTrip) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
        }
        if (!completedNativeTrip && !tripToEnd.id) {
          const storedTrips = await tripService.listAllSummaries({ sort: '-start_time' }).catch(() => []);
          completedNativeTrip = findNativeManualCompletion(storedTrips, tripToEnd);
        }
      } catch (error) {
        logError('native_manual_trip_dashboard_end', error, {
          tripId: tripToEnd.id || null,
          route_point_count: Array.isArray(tripToEnd.route_points) ? tripToEnd.route_points.length : 0,
        });
      }

      if (completedNativeTrip) {
        recordTrackingDiagnostic({
          type: 'trip_ended',
          title: 'Native manual trip saved',
          reason: 'dashboard_end_native_authoritative',
          tripId: completedNativeTrip.id,
          duration_seconds: Math.round(completedNativeTrip.duration_seconds || 0),
          distance_km: completedNativeTrip.distance_km || 0,
          route_points_raw_count: Array.isArray(completedNativeTrip.route_points)
            ? completedNativeTrip.route_points.length
            : 0,
        });
        await clearNativeManualTripUi(tripToEnd, completedNativeTrip);
        return;
      }

      recordTrackingDiagnostic({
        type: 'native_manual_trip_fallback',
        title: 'Native manual completion was not available in time',
        reason: nativeManualEndRequested ? 'native_completion_import_timeout' : 'native_end_request_failed',
        tripId: tripToEnd.id || null,
        route_points_raw_count: Array.isArray(tripToEnd.route_points) ? tripToEnd.route_points.length : 0,
      });
    }
    if (isPrivateTrip(tripToEnd)) {
      const completedTrip = buildPrivateTripRecord(tripToEnd, endTime);
      const savedTrip = await tripService.create(completedTrip);
      activeTripStore.clear();
      await activeTripStore.flush();
      privateTripRuntimeRef.current = null;
      activeTripRef.current = null;
      trackingRef.current = false;
      setActiveTrip(null);
      setTracking(false);
      setElapsed(0);
      recordTrackingDiagnostic({
        type: 'trip_ended',
        title: 'Private trip summary saved',
        reason: autoEndingTripRef.current ? 'private_trip_auto_stop' : 'private_trip_manual_end',
        tripId: savedTrip?.id,
        duration_seconds: completedTrip.duration_seconds,
        distance_km: completedTrip.distance_km,
        route_points_raw_count: 0,
        route_points_clean_count: 0,
      });
      await appendPrivacyEvent({
        op: 'PRIVATE_TRIP_SAVED',
        tripId: savedTrip?.id,
        hiddenCount: tripToEnd.private_trip_summary?.gps_points_processed || 0,
        details: {
          point_count: tripToEnd.private_trip_summary?.gps_points_processed || 0,
          status: 'summary_only',
        },
      }).catch((error) => {
        logError('private_trip_audit_save', error, { tripId: savedTrip?.id });
      });

      await activityStopRef.current?.();
      activityStopRef.current = null;
      latestActivityRef.current = null;
      trackingRef.current = false;
      autoEndingTripRef.current = false;
      endingTripRef.current = false;
      locationPermissionEndingRef.current = false;
      setActiveTrip(null);
      setTracking(false);
      setElapsed(0);
      if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
        await startNativeAutoTracking().catch((error) => {
          logError('native_auto_tracking_resume_after_private_save', error, {
            tripId: savedTrip?.id,
            resume_native_auto: tripToEnd.resume_native_auto === true,
          });
        });
      }
      refreshTrackingStatusContext();
      refetch();
      return;
    }
    const thresholds = buildDrivingThresholds(cfg);
    const rawPoints = tripToEnd.route_points || [];
    let cleanedPoints = cleanRoutePoints(rawPoints, thresholds);

    if (tripToEnd.trip_state === TRIP_STATES.CANDIDATE) {
      const decision = validateCandidateTrip({
        points: cleanedPoints,
        startTime: tripToEnd.start_time,
        now: endTime,
        activity: latestActivityRef.current,
        nearParkedLocation: tripToEnd.candidate_near_parked === true,
        forceFinal: true,
        thresholds,
      });
      if (!decision.confirmed) {
        recordTrackingDiagnostic({
          type: 'trip_discarded',
          title: decision.title || 'Candidate discarded',
          reason: decision.reason || 'candidate_not_confirmed',
          trip_state: TRIP_STATES.DISCARDED,
          duration_seconds: Math.round((decision.metrics?.candidate_age_ms || 0) / 1000),
          distance_m: decision.metrics?.distance_m ?? null,
          max_speed_kmh: Math.round(decision.metrics?.max_speed_kmh || 0),
          stable_points: decision.metrics?.stable_points ?? null,
          near_parked_location: tripToEnd.candidate_near_parked === true,
        });
        await activityStopRef.current?.();
        activityStopRef.current = null;
        latestActivityRef.current = null;
        activeTripStore.clear();
        await activeTripStore.flush();
        activeTripRef.current = null;
        trackingRef.current = false;
        autoEndingTripRef.current = false;
        endingTripRef.current = false;
        locationPermissionEndingRef.current = false;
        setActiveTrip(null);
        setTracking(false);
        setElapsed(0);
        if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
          await startNativeAutoTracking().catch((error) => {
            logError('native_auto_tracking_resume_after_candidate_discard', error, {
              reason: decision.reason || 'candidate_not_confirmed',
              resume_native_auto: tripToEnd.resume_native_auto === true,
            });
          });
        }
        refreshTrackingStatusContext();
        setLocationError('Auto-detected movement was ignored because it did not prove vehicle-like.');
        return;
      }
      tripToEnd = {
        ...tripToEnd,
        trip_state: TRIP_STATES.CONFIRMED,
        candidate_confirmed_at: new Date().toISOString(),
        candidate_confirmation_reason: decision.reason,
        candidate_validation: decision.metrics,
        route_points: decision.cleanPoints,
      };
      cleanedPoints = decision.cleanPoints;
      recordTrackingDiagnostic({
        type: 'candidate_confirmed',
        title: 'Candidate confirmed: vehicle-like movement detected',
        reason: decision.reason || 'vehicle_speed_distance',
        trip_state: TRIP_STATES.CONFIRMED,
        distance_m: decision.metrics?.distance_m ?? null,
        max_speed_kmh: Math.round(decision.metrics?.max_speed_kmh || 0),
        stable_points: decision.metrics?.stable_points ?? null,
      });
    }

    recordTrackingDiagnostic({
      type: 'ending_review',
      title: 'Ending review started',
      reason: endingForLocationPermissionLoss ? 'location_permission_lost_review' : autoEndingTripRef.current ? 'auto_stop_review' : 'manual_end_review',
      trip_state: TRIP_STATES.ENDING_REVIEW,
      route_points_raw_count: rawPoints.length,
      route_points_clean_count: cleanedPoints.length,
    });

    const tailTrim = trimParkedTail(cleanedPoints, {
      endTime,
      reason: endingForLocationPermissionLoss ? 'location_permission_lost_review' : autoEndingTripRef.current ? 'auto_stop_parked_review' : 'manual_end_review',
      activity: latestActivityRef.current,
      thresholds,
    });
    if (tailTrim.trimmed) {
      cleanedPoints = tailTrim.points;
      endTime = tailTrim.endTime;
      recordTrackingDiagnostic({
        type: 'tail_trimmed',
        title: 'Trip tail trimmed: walking detected after parking',
        reason: tailTrim.reason,
        trip_state: TRIP_STATES.ENDING_REVIEW,
        trimmed_points: tailTrim.removedPoints,
      });
    }

    let pts = cleanedPoints;
    const preliminaryStats = calculateTripStats(cleanedPoints, tripToEnd.start_time, endTime, thresholds);

    const isManualTrip = tripToEnd.start_source !== 'auto';
    const manualRawStats = isManualTrip
      ? calculateTripStats(rawPoints, tripToEnd.start_time, endTime, thresholds)
      : null;
    const manualSaveReview = isManualTrip
      ? reviewManualTripSave({
        points: rawPoints,
        stats: {
          duration_seconds: Math.max(preliminaryStats.duration_seconds || 0, manualRawStats?.duration_seconds || 0),
          distance_km: Math.max(preliminaryStats.distance_km || 0, manualRawStats?.distance_km || 0),
          max_speed_kmh: Math.max(preliminaryStats.max_speed_kmh || 0, manualRawStats?.max_speed_kmh || 0),
        },
        startTime: tripToEnd.start_time,
        endTime,
        thresholds,
      })
      : null;
    if (isManualTrip && manualSaveReview) {
      const startMs = new Date(tripToEnd.start_time).getTime();
      const endMs = new Date(endTime).getTime();
      const wallClockDurationSeconds = Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0, Math.round((endMs - startMs) / 1000))
        : 0;
      recordTrackingDiagnostic({
        type: 'manual_save_review',
        title: 'Manual save review completed',
        should_save: manualSaveReview.shouldSave,
        reason: manualSaveReview.reason,
        duration_seconds: Math.round(manualSaveReview.durationSeconds ?? preliminaryStats.duration_seconds ?? 0),
        wall_clock_duration_seconds: wallClockDurationSeconds,
        distance_km: Number(Number(manualSaveReview.distanceKm ?? preliminaryStats.distance_km ?? 0).toFixed(3)),
        max_speed_kmh: Math.round(manualSaveReview.maxSpeedKmh ?? preliminaryStats.max_speed_kmh ?? 0),
        route_points_raw_count: rawPoints.length,
        route_points_clean_count: cleanedPoints.length,
        coordinate_point_count: manualSaveReview.coordinatePointCount ?? 0,
        cumulative_coord_km: Number(Number(manualSaveReview.cumulativeCoordKm ?? 0).toFixed(3)),
        moving_speed_sample_count: manualSaveReview.movingSpeedSampleCount ?? 0,
        start_source: tripToEnd.start_source ?? 'unknown',
        background_tracking: tripToEnd.background_tracking ?? false,
      });
    }
    const shouldDiscard = isManualTrip
      ? !manualSaveReview.shouldSave
      : preliminaryStats.distance_km < DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM ||
        preliminaryStats.duration_seconds < DEFAULT_THRESHOLDS.MIN_TRIP_DURATION_SECONDS;
    let nativeManualMirrorReleased = false;

    if (manualSaveReview?.shouldSave && manualSaveReview.reason !== 'manual_distance_confirmed') {
      recordTrackingDiagnostic({
        type: 'ending_review',
        title: 'Manual trip kept with sparse GPS movement evidence',
        reason: manualSaveReview.reason,
        trip_state: TRIP_STATES.ENDING_REVIEW,
        duration_seconds: Math.round(preliminaryStats.duration_seconds || 0),
        distance_km: preliminaryStats.distance_km || 0,
        max_speed_kmh: Math.round(preliminaryStats.max_speed_kmh || 0),
        route_points_clean_count: cleanedPoints.length,
      });
    }

    if (shouldDiscard) {
      recordTrackingDiagnostic({
        type: 'trip_discarded',
        title: 'Trip discarded',
        reason: isManualTrip ? manualSaveReview?.reason : 'auto_too_short',
        duration_seconds: Math.round(preliminaryStats.duration_seconds || 0),
        distance_km: Number((preliminaryStats.distance_km || 0).toFixed(3)),
        max_speed_kmh: Math.round(preliminaryStats.max_speed_kmh || 0),
        route_points_raw_count: rawPoints.length,
        route_points_clean_count: cleanedPoints.length,
        start_source: tripToEnd.start_source ?? 'unknown',
        background_tracking: tripToEnd.background_tracking ?? false,
      });
      if (tripToEnd.native_manual_background === true) {
        await endNativeActiveTrip({ keepArmed: false }).catch((error) => {
          logError('native_manual_trip_end_after_js_discard', error, {
            reason: isManualTrip ? manualSaveReview?.reason : 'auto_too_short',
          });
        });
      }
      await activityStopRef.current?.();
      activityStopRef.current = null;
      latestActivityRef.current = null;
      activeTripStore.clear();
      await activeTripStore.flush();
      activeTripRef.current = null;
      trackingRef.current = false;
      autoEndingTripRef.current = false;
      endingTripRef.current = false;
      locationPermissionEndingRef.current = false;
      setActiveTrip(null);
      setTracking(false);
      setElapsed(0);
      if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
        await startNativeAutoTracking().catch((error) => {
          logError('native_auto_tracking_resume_after_trip_discard', error, {
            reason: isManualTrip ? manualSaveReview?.reason : 'auto_too_short',
            resume_native_auto: tripToEnd.resume_native_auto === true,
          });
        });
      }
      refreshTrackingStatusContext();
      setLocationError(isManualTrip
        ? tripToEnd.native_manual_background === true
          ? 'The foreground trip had too little WebView GPS data, so Road Sage asked the native background service to finish and save its recording.'
          : 'Trip was not saved because Road Sage did not detect real movement. Start again when you begin driving.'
        : 'Auto-detected trip was ignored because it was too short.');
      return;
    }

    if (tripToEnd.native_manual_background === true && !nativeManualEndRequested) {
      await discardNativeManualTrip({ keepArmed: false }).then(() => {
        nativeManualMirrorReleased = true;
        recordTrackingDiagnostic({
          type: 'manual_native_background_released',
          title: 'Native manual mirror stopped before JavaScript save',
          reason: 'javascript_trip_save_confirmed',
          background_tracking: true,
        });
      }).catch((error) => {
        logError('native_manual_trip_mirror_release_before_js_save', error, {
          route_points_raw_count: rawPoints.length,
          route_points_clean_count: cleanedPoints.length,
        });
      });
    }

    const shouldAutoFetchExternalContext = isExternalContextAutoFetchEnabled(cfg);
    const mapMatchingContext = {
      provider: 'osrm',
      status: cfg.map_matching_enabled !== false && cfg.osrm_map_matching_url && cfg.osrm_data_sharing_consented === true ? 'manual_required' : 'disabled',
      confidence: null,
      snapped_coverage: 0,
      isOsrmDemoUrl: isPublicOsrmDemoUrl(cfg.osrm_map_matching_url),
    };
    const speedLimitContext = shouldAutoFetchExternalContext
      ? await annotateRouteSpeedLimits(pts, cfg).catch((error) => ({
          routePoints: pts,
          coverage: 0,
          status: 'unavailable',
          source: 'openstreetmap_overpass',
          query_count: 0,
          fallback_country: speedLimitDefaultCountryKey(cfg),
          error: error?.message || 'Speed limit lookup unavailable',
        }))
      : {
          routePoints: pts,
          coverage: 0,
          status: 'manual_required',
          source: 'openstreetmap_overpass',
          query_count: 0,
          fallback_country: speedLimitDefaultCountryKey(cfg),
          error: null,
    };
    pts = speedLimitContext.routePoints || pts;
    const speedKnowledge = getLocalSpeedKnowledge();
    const localKnowledgeResults = await prefetchLocalKnowledge(pts, speedKnowledge);
    let stats = calculateTripStats(pts, tripToEnd.start_time, endTime, thresholds, {
      ...tripToEnd,
      raw_route_points: cleanedPoints,
    });
    const manualSparseDistanceKm = manualSaveReview?.shouldSave
      ? Number(manualSaveReview.cumulativeCoordKm) || 0
      : 0;
    if (isManualTrip && manualSparseDistanceKm > (stats.distance_km || 0)) {
      stats = {
        ...stats,
        distance_km: manualSparseDistanceKm,
        avg_speed_kmh: stats.duration_seconds > 0
          ? manualSparseDistanceKm / (stats.duration_seconds / 3600)
          : stats.avg_speed_kmh,
        manual_sparse_distance_estimate: true,
      };
    }
    const weatherContext = shouldAutoFetchExternalContext
      ? await fetchWeatherContextForTrip(pts, tripToEnd.start_time, endTime, cfg).catch((error) => ({
          provider: 'open-meteo',
          status: 'unavailable',
          riskLevel: null,
          riskScore: null,
          riskMultiplier: 1,
          error: error?.message || 'Weather lookup unavailable',
        }))
      : {
          provider: 'open-meteo',
          status: 'manual_required',
          riskLevel: null,
          riskScore: null,
          riskMultiplier: 1,
        };

    const tripPrivacyZones = getPrivacyZones(cfg);
    const { events: detectedEvents, phoneUse: gpsPhoneUse } = detectDrivingEvents(pts, thresholds, endTime, tripPrivacyZones, {
      localKnowledgeResults,
      settings: cfg,
    });
    const activeIncidentEvents = (tripToEnd.driving_events || []).filter((event) => event.type === 'possible_crash');
    const events = enrichEventsWithSensorContext([...detectedEvents, ...activeIncidentEvents], sensorFusionRef.current?.getSamples?.() || []);
    const startMs = new Date(tripToEnd.start_time).getTime();
    const endMs = new Date(endTime).getTime();
    let nativePhoneUsageSummary = null;
    if (isAndroid() && Number.isFinite(startMs) && Number.isFinite(endMs)) {
      nativePhoneUsageSummary = await getAndroidPhoneUsageSummary(startMs, endMs).catch(() => null);
    }
    const nativePhoneUsageAccessGranted = nativePhoneUsageSummary?.usage_access_granted === true ||
      tripToEnd.native_phone_usage_access_granted === true;
    const usagePhoneUse = buildPhoneUseFromAndroidUsage(nativePhoneUsageSummary || {}, pts, stats.duration_seconds);
    const phoneUse = mergePhoneUseSignals(gpsPhoneUse, usagePhoneUse, stats.duration_seconds);
    const motionSamples = sensorFusionRef.current?.getSamples?.() || [];
    const sensorFusionSummary = buildSensorFusionSummary(motionSamples, pts, latestActivityRef.current, events);
    let scores = calculateTripScores(events, stats, pts, thresholds, stats.duration_seconds, phoneUse, {
      endTime,
      privacyZones: tripPrivacyZones,
      motionSamples,
      orientationCalibration: sensorFusionSummary.phone_orientation,
      localKnowledgeResults,
      settings: cfg,
    });
    scores = applyWeatherRiskToScores(scores, weatherContext);
    const tripEvents = maskEventsForPrivacy(
      mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || events, phoneUse),
      { privacy_zones: tripPrivacyZones }
    );
    const completedVehicle = vehicles.find((vehicle) => vehicle.is_default) || vehicles[0] || null;
    const economics = estimateTripEconomics({ ...stats, ...scores }, completedVehicle, settings);
    const driverModel = buildOnDeviceDriverModel(completedTrips);
    const anomaly = scoreTripAnomaly({ ...stats, ...scores }, driverModel);
    const dataQualityFlags = Array.from(new Set(Array.isArray(tripToEnd.data_quality_flags) ? tripToEnd.data_quality_flags : []));
    if (stats.manual_sparse_distance_estimate === true) {
      dataQualityFlags.push('manual_sparse_gps_distance_estimate');
    }
    const uniqueDataQualityFlags = Array.from(new Set(dataQualityFlags));
    const statsRecord = /** @type {Record<string, any>} */ (stats);
    const weatherContextRecord = /** @type {Record<string, any> | null} */ (weatherContext || null);
    const scoreConfidenceFlag = tripToEnd.score_confidence_flag ||
      statsRecord.score_confidence_flag ||
      (uniqueDataQualityFlags.includes('location_permission_loss') || uniqueDataQualityFlags.includes('manual_sparse_gps_distance_estimate') ? 'data_gap_detected' : null);

    const mapRouteSelection = selectMapRoutePoints(pts, rawPoints);
    if (mapRouteSelection.usedRecordedFallback) {
      uniqueDataQualityFlags.push('map_used_recorded_gps_fallback');
      recordTrackingDiagnostic({
        type: 'manual_route_geometry_review',
        title: 'Recorded GPS retained for map geometry',
        reason: 'scoring_cleaner_collapsed_route',
        route_points_raw_count: rawPoints.length,
        route_points_clean_count: mapRouteSelection.strictPointCount,
        route_points_visual_count: mapRouteSelection.recordedVisualPointCount,
      });
    }
    const mapRoutePoints = mapRouteSelection.points;

    const completedTrip = {
      ...stats,
      ...(tripToEnd.id ? { id: tripToEnd.id } : {}),
      ...(tripToEnd.manual_session_id ? { manual_session_id: tripToEnd.manual_session_id } : {}),
      start_time: tripToEnd.start_time,
      end_time: endTime,
      vehicle_id: completedVehicle?.id || null,
      route_points: mapRoutePoints,
      route_points_raw_count: rawPoints.length,
      route_points_map_count: mapRoutePoints.length,
      ...scores,
      driving_events: tripEvents,
      speed_limit_context: {
        provider: 'openstreetmap_overpass',
        status: speedLimitContext.status,
        coverage: speedLimitContext.coverage,
        source: speedLimitContext.source,
        fallback_country: speedLimitContext.fallback_country,
        error: speedLimitContext.error,
      },
      map_matching_context: {
        provider: mapMatchingContext.provider,
        status: mapMatchingContext.status,
        confidence: mapMatchingContext.confidence ?? null,
        snapped_coverage: mapMatchingContext.snapped_coverage ?? 0,
        isOsrmDemoUrl: mapMatchingContext.isOsrmDemoUrl,
      },
      weather_context: weatherContextRecord?.weather_skipped_reason ? null : weatherContext,
      weather_skipped_reason: weatherContextRecord?.weather_skipped_reason || null,
      sensor_fusion_summary: sensorFusionSummary,
      driver_anomaly: anomaly,
      anomaly_score: anomaly.anomaly_score,
      anomaly_level: anomaly.anomaly_level,
      co2_saved_kg: economics.co2_saved_kg,
      status: 'completed',
      trip_state: TRIP_STATES.SAVED,
      background_tracking: tripToEnd.background_tracking,
      start_source: tripToEnd.start_source || 'manual',
      native_manual_background: tripToEnd.native_manual_background === true,
      candidate_started_at: tripToEnd.candidate_started_at || null,
      candidate_confirmed_at: tripToEnd.candidate_confirmed_at || null,
      candidate_first_point: tripToEnd.candidate_first_point || null,
      candidate_near_parked: tripToEnd.candidate_near_parked === true,
      candidate_confirmation_reason: tripToEnd.candidate_confirmation_reason || null,
      candidate_validation: tripToEnd.candidate_validation || null,
      ending_review: {
        status: 'cleaned',
        tail_trimmed: tailTrim.trimmed === true,
        trimmed_points: tailTrim.removedPoints || 0,
        reason: tailTrim.reason || null,
      },
      emergency_workflow_pending: tripToEnd.emergency_workflow_pending === true,
      emergency_workflow_acknowledged_at: tripToEnd.emergency_workflow_acknowledged_at || null,
      emergency_workflow_acknowledged_action: tripToEnd.emergency_workflow_acknowledged_action || null,
      native_phone_usage_access_granted: nativePhoneUsageAccessGranted,
      native_phone_usage_access_checked_at: tripToEnd.native_phone_usage_access_checked_at || null,
      native_phone_usage_events: nativePhoneUsageSummary?.events || [],
      native_phone_usage_event_count: nativePhoneUsageSummary?.event_count || 0,
      native_phone_usage_total_seconds: nativePhoneUsageSummary?.total_seconds || 0,
      data_quality_flags: uniqueDataQualityFlags,
      score_confidence_flag: scoreConfidenceFlag,
      tracking_timeline: Array.isArray(tripToEnd.timeline) ? tripToEnd.timeline : [],
    };
    const savedTrip = await tripService.create(completedTrip);
    if (
      tripToEnd.native_manual_background === true &&
      !nativeManualMirrorReleased &&
      !nativeManualEndRequested
    ) {
      await discardNativeManualTrip({ keepArmed: false }).catch((error) => {
        logError('native_manual_trip_mirror_discard_after_js_save', error, {
          tripId: savedTrip?.id || completedTrip.id,
        });
      });
    }
    const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
    const conflictedCells = await knowledge.getConflictedCells().catch(() => []);
    const reviewCellCount = speedLimitReviewNeededForTrip(completedTrip)
      ? Math.max(1, buildTripSpeedLimitReviewCells(completedTrip, { maxCells: 8 }).length)
      : 0;
    if (conflictedCells.length || reviewCellCount) {
      const reviewTrip = reviewCellCount
        ? { ...completedTrip, id: savedTrip?.id || completedTrip.id }
        : null;
      const fingerprint = buildDashboardSpeedLimitReviewFingerprint({
        conflictedCells,
        reviewTrip,
        reviewCellCount,
      });
      setSpeedLimitConflictReview({
        count: conflictedCells.length + reviewCellCount,
        tripId: savedTrip?.id || completedTrip.id || null,
        hasConflicts: conflictedCells.length > 0,
        fingerprint,
      });
    }
    activeTripStore.clear();
    await activeTripStore.flush();
    activeTripRef.current = null;
    trackingRef.current = false;
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    recordTrackingDiagnostic({
      type: 'trip_ended',
      title: 'Trip saved',
      reason: completedTrip.parking_stop_detected ? 'ended_parked' : 'ended_manual_or_moving',
      tripId: savedTrip?.id || completedTrip.id,
      duration_seconds: Math.round(completedTrip.duration_seconds || 0),
      distance_km: completedTrip.distance_km || 0,
      parking_stop_duration_seconds: completedTrip.parking_stop_duration_seconds || 0,
    });
    if (isManualTrip) {
      const visualPoints = prepareMapRoutePoints(cleanedPoints, { maxPoints: null, smooth: false });
      const visualPointsWithGaps = injectTimestampGapMarkers(visualPoints);
      const segmentSpeeds = [];
      for (let i = 1; i < visualPoints.length; i++) {
        const segment = calculateSegmentMetrics(visualPoints[i - 1], visualPoints[i], thresholds);
        if (segment.impliedSpeedKmh > 0) segmentSpeeds.push(segment.impliedSpeedKmh);
      }
      recordTrackingDiagnostic({
        type: 'manual_route_geometry_review',
        title: 'Manual route geometry reviewed',
        tripId: savedTrip?.id || completedTrip.id,
        route_points_raw_count: rawPoints.length,
        route_points_clean_count: cleanedPoints.length,
        route_points_visual_count: visualPoints.length,
        tracking_gap_count: visualPointsWithGaps.filter((point) => point.tracking_gap === true).length,
        highest_visual_implied_speed_kmh: segmentSpeeds.length ? Math.round(Math.max(...segmentSpeeds)) : 0,
        likely_straight_line: visualPoints.length < 3,
        map_matching_status: mapMatchingContext.status,
      });
    }
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
    await dispatchTripCompletedNotification(completedTrip, completedTrips, settings).catch((err) => {
      logError('post_trip_completed_notification', err, { tripId: savedTrip?.id || completedTrip.id });
    });
    checkAndNotifyPhoneUsePattern([completedTrip, ...completedTrips], settings).catch((err) => {
      logError('post_trip_phone_use_pattern_notification', err, { tripId: savedTrip?.id || completedTrip.id });
    });
    const driverSignature = buildDriverSignature([completedTrip, ...completedTrips].slice(0, 20));
    if (driverSignature?.style_shifts?.length > 0) {
      notifyStyleShift(driverSignature.style_shifts, settings).catch((err) => {
        logError('post_trip_style_shift_notification', err, {
          tripId: savedTrip?.id || completedTrip.id,
          shift_count: driverSignature.style_shifts.length,
        });
      });
    }
    await syncAchievementNotifications(calculateAchievementBadges([completedTrip, ...completedTrips], settings, vehicles)).catch((err) => {
      logError('post_trip_achievement_notification_sync', err, { tripId: savedTrip?.id || completedTrip.id });
    });
    const newDailyFatigue = computeDailyFatigue(
      getTodayTrips([completedTrip, ...completedTrips]),
      settings,
      habitProfile?.fatigueOnsetMinutes
    );
    if (newDailyFatigue.fatigueLevel === 'high' || newDailyFatigue.fatigueLevel === 'critical') {
      notifyDailyFatigueWarning(newDailyFatigue).catch((err) => {
        logError('post_trip_daily_fatigue_warning', err, {
          tripId: savedTrip?.id || completedTrip.id,
          fatigue_level: newDailyFatigue.fatigueLevel,
        });
      });
    }
    await activityStopRef.current?.();
    activityStopRef.current = null;
    latestActivityRef.current = null;
    activeTripStore.clear();
    await activeTripStore.flush();
    activeTripRef.current = null;
    trackingRef.current = false;
    autoEndingTripRef.current = false;
    endingTripRef.current = false;
    locationPermissionEndingRef.current = false;
    setActiveTrip(null);
    setTracking(false);
    setElapsed(0);
    if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
      await startNativeAutoTracking().catch((error) => {
        logError('native_auto_tracking_resume_after_trip_end', error, {
          resume_native_auto: tripToEnd.resume_native_auto === true,
        });
      });
    }
    refreshTrackingStatusContext();
    refetch();
    } catch (error) {
      const currentActiveTrip = activeTripRef.current || activeTripStore.get();
      const hasActiveTrip = Boolean(currentActiveTrip);
      logError('dashboard_end_trip', error, {
        tripId: tripToEnd?.id || null,
        start_source: tripToEnd?.start_source || null,
        native_manual_background: tripToEnd?.native_manual_background === true,
        active_trip_still_present: hasActiveTrip,
      });
      endingTripRef.current = false;
      locationPermissionEndingRef.current = false;
      trackingRef.current = hasActiveTrip;
      if (hasActiveTrip && !activeTripRef.current) {
        activeTripRef.current = currentActiveTrip;
        setActiveTrip(currentActiveTrip);
      }
      setTracking(hasActiveTrip);
      setLocationError(hasActiveTrip
        ? 'Trip ending hit a problem. Your trip data is still on this device; try End Trip again.'
        : 'Trip ending finished, but cleanup hit a problem. Check Trip History if the trip does not appear right away.');
      refreshTrackingStatusContext();
    } finally {
      setEndingTrip(false);
    }
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
      const speedTriggerDrive = speed >= 5 && recentMovingSeconds >= AUTO_START_TRIGGER_SECONDS;

      if (activitySaysDrive || speedTriggerDrive) {
        const gpsFallback = activitySaysDrive && (!activity || activity.type === 'unknown' || activity.confidence < 65);
        const lastParked = await getLastParkedLocation().catch(() => null);
        const nearParkedLocation = isNearRecentParkedLocation(point, lastParked);
        const triggerReason = gpsFallback || !activitySaysDrive ? 'sustained_gps_movement' : 'activity_in_vehicle';
        refreshTrackingStatusContext();
        await stopAutoWatchers();
        latestActivityRef.current = activity || null;
        await handleStartTrip({
          autoStarted: true,
          candidate: true,
          initialPoint: point,
          nearParkedLocation,
          triggerReason,
        });
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
          recordTrackingDiagnostic({
            type: 'auto_blocked',
            title: 'Auto tracking blocked',
            reason: 'activity_permission_denied',
          });
          refreshTrackingStatusContext();
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
        recordTrackingDiagnostic({
          type: 'auto_blocked',
          title: 'Auto tracking blocked',
          reason: useBackground ? 'background_location_or_notification_denied' : 'location_permission_denied',
        });
        refreshTrackingStatusContext();
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
          maybeAutoStart(point).catch((error) => {
            logError('auto_tracking_maybe_start', error, {
              speed_kmh: Math.round(point?.speed_kmh || 0),
              background_tracking: useBackground,
            });
            setLocationError(error?.message || 'Automatic trip start failed.');
          });
        },
        (err) => {
          if (err?.type === 'permission_denied') {
            autoLocationService.current = null;
            recordTrackingDiagnostic({
              type: 'auto_blocked',
              title: 'Auto tracking blocked',
              reason: 'web_geolocation_permission_denied',
            });
            refreshTrackingStatusContext();
          }
          setLocationError(err?.message || 'Location tracking failed.');
        }
      );
    };

    startAutoWatchers().catch((error) => {
      logError('auto_tracking_watchers_start', error, {
        tracking_mode: cfg.tracking_mode,
        background_tracking: cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto',
      });
      setLocationError(error?.message || 'Automatic tracking could not start.');
      refreshTrackingStatusContext();
    });

    return () => {
      cancelled = true;
      stopAutoWatchers().catch((error) => {
        logError('auto_tracking_watchers_stop', error, {
          tracking_mode: cfg.tracking_mode,
        });
      });
    };
  }, [tracking, handleStartTrip, refreshTrackingStatusContext]);

  // Stats
  const totalTrips = completedTrips.length;
  const {
    avgScore,
    avgScoreEvidence,
    baseline,
    baselineRangeLabel,
    baselineText,
    brakingImprovement,
    fatigueRisk,
    noHarshBrakeStreak,
    parkingReminder,
    peakStress,
    scoreTrend,
    tips,
    weekDistance,
    weeklyGoals,
  } = useMemo(() => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const weekTrips = driverCompletedTrips.filter(t => new Date(t.start_time) >= weekAgo);
    const weekDistance = weekTrips.reduce((s, t) => s + (t.distance_km || 0), 0);
    const scoredTrips = driverCompletedTrips.slice(0, 10)
      .map((trip) => ({ trip, component: getTripComponentScore(trip, 'overall') }))
      .filter(({ component }) => component.value != null);
    const totalScoredKm = scoredTrips.reduce((sum, { trip }) => sum + (Number(trip.distance_km) || 0), 0);
    const avgScore = scoredTrips.length && totalScoredKm > 0
      ? Math.round(scoredTrips.reduce((sum, { trip, component }) => sum + component.value * (Number(trip.distance_km) || 0), 0) / totalScoredKm)
      : null;
    const avgScoreEvidence = scoredTrips.length === 0
      ? 'unavailable'
      : scoredTrips.some(({ component }) => component.evidence === 'low')
        ? 'low'
        : scoredTrips.some(({ component }) => component.evidence === 'developing')
          ? 'developing'
          : 'high';
    const baseline = computePersonalBaseline(driverCompletedTrips);
    const baselineRangeLabel = baseline.baseline_includes_older_scores
      ? baseline.baseline_label
      : baseline.baseline_confidence_interval_label;
    const baselineText = baseline.baseline_avg == null
      ? `Record at least 10 trips in 4 weeks to unlock your baseline (${baseline.baseline_trip_count}/10 recorded).`
      : baseline.baseline_includes_older_scores
        ? `Approximate baseline: ${baseline.baseline_avg}. ${baseline.baseline_label}. Re-score older trips in Settings for a comparable interval.`
        : baseline.delta == null
          ? `Approximate baseline: ${baseline.baseline_avg} (${baseline.baseline_confidence_interval_label} percentile range). Record a trip this week for a comparison.`
          : `Approximate baseline: ${baseline.baseline_avg} (${baseline.baseline_confidence_interval_label} percentile range). This week is ${baseline.delta >= 0 ? '+' : ''}${baseline.delta}.`;

    return {
      avgScore,
      avgScoreEvidence,
      baseline,
      baselineRangeLabel,
      baselineText,
      brakingImprovement: calculateRecentBrakingImprovement(driverCompletedTrips),
      fatigueRisk: calculateFatigueRisk(weekTrips, settings),
      noHarshBrakeStreak: calculateNoHarshBrakeStreak(driverCompletedTrips),
      parkingReminder: formatParkingReminder(parkedLocation),
      peakStress: calculatePeakHourStress(driverCompletedTrips),
      scoreTrend: driverCompletedTrips.slice(0, 10).reverse().map((t, i) => ({ i, score: getTripComponentScore(t, 'overall').value })),
      tips: buildScoreTips(driverCompletedTrips),
      weekDistance,
      weeklyGoals: calculateWeeklyDrivingGoals(driverCompletedTrips, settings),
    };
  }, [driverCompletedTrips, parkedLocation, settings]);
  const latestTrip = completedTrips[0];
  const activeSpeedLimitReview = speedLimitReviewSummary || speedLimitConflictReview;
  const activeSpeedLimitReviewFingerprint = activeSpeedLimitReview?.fingerprint || '';
  const showSpeedLimitReviewWarning = speedLimitReviewDismissalLoaded
    && activeSpeedLimitReview
    && activeSpeedLimitReviewFingerprint
    && dismissedSpeedLimitReviewFingerprint !== activeSpeedLimitReviewFingerprint;
  const activeFatigueAlert = tracking && elapsed > 90 * 60 && (() => {
    const points = activeTrip?.route_points || [];
    if (points.length < 12) return false;
    const firstWindowEnd = new Date(activeTrip.start_time).getTime() + 10 * 60 * 1000;
    const lastWindowStart = Date.now() - 10 * 60 * 1000;
    const firstPoints = points.filter((point) => new Date(point.timestamp).getTime() <= firstWindowEnd);
    const lastPoints = points.filter((point) => new Date(point.timestamp).getTime() >= lastWindowStart);
    if (firstPoints.length < 3 || lastPoints.length < 3) return false;
    const { events: firstEvents, phoneUse: firstPhoneUse } = detectDrivingEvents(firstPoints);
    const { events: lastEvents, phoneUse: lastPhoneUse } = detectDrivingEvents(lastPoints);
    const firstStats = calculateTripStats(firstPoints, firstPoints[0].timestamp, firstPoints[firstPoints.length - 1].timestamp);
    const lastStats = calculateTripStats(lastPoints, lastPoints[0].timestamp, lastPoints[lastPoints.length - 1].timestamp);
    const lastScore = calculateTripScores(lastEvents, lastStats, lastPoints, DEFAULT_THRESHOLDS, lastStats.duration_seconds, lastPhoneUse).component_scores.overall.value;
    const firstScore = calculateTripScores(firstEvents, firstStats, firstPoints, DEFAULT_THRESHOLDS, firstStats.duration_seconds, firstPhoneUse).component_scores.overall.value;
    return lastScore != null && firstScore != null && lastScore < firstScore - 15;
  })();

  const units = settings.units || 'metric';
  const activeTripIsCandidate = activeTrip?.trip_state === TRIP_STATES.CANDIDATE;
  const activeTripIsPrivate = isPrivateTrip(activeTrip);
  const trackingMode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');
  const isAndroidManualMode = isAndroid() && trackingMode === 'manual' && !settings.tracking_paused;
  const permissionStatus = trackingStatusContext.permissionStatus || {};
  const foregroundLocationReady = permissionStatus.foregroundLocation === 'granted' || settings.location_permission_granted === true;
  const backgroundLocationReady = permissionStatus.backgroundLocation === 'granted' || settings.background_location_granted === true;
  const notificationsReady = permissionStatus.notifications === 'granted' || settings.notification_permission_granted === true;
  const androidManualBackgroundReady = isAndroidManualMode && foregroundLocationReady && backgroundLocationReady && notificationsReady;
  const activeTripExpectedBackground = tracking &&
    isAndroid() &&
    !activeTripIsPrivate &&
    activeTrip?.background_tracking === true;
  const activeTripIsManualForeground = tracking &&
    isAndroid() &&
    !activeTripIsPrivate &&
    activeTrip?.start_source === 'manual' &&
    (activeTrip?.background_tracking !== true || trackingServiceMode?.mode === 'foreground');
  const activeTripIsBackgroundTracking = tracking &&
    isAndroid() &&
    !activeTripIsPrivate &&
    trackingServiceMode?.mode === 'background';
  const activeTripIsStartingBackground = activeTripExpectedBackground && !trackingServiceMode;
  const showManualForegroundWarning = manualForegroundWarning || activeTripIsManualForeground;
  const handleTrackingSetupAction = async (action) => {
    try {
      if (action === 'location') await requestForegroundLocationPermission();
      if (action === 'activity') await requestActivityRecognitionPermission();
      if (action === 'background') await requestBackgroundLocationPermission();
      if (action === 'notifications') await requestNotificationPermission();
      if (action === 'battery') await openAndroidBatteryOptimizationSettings();
      if (action === 'native') await startNativeAutoTracking();
      await refreshTrackingStatusContext();
    } catch (error) {
      logError('tracking_setup_action', error, { action });
      setLocationError(error?.message || 'Tracking setup action failed.');
      await refreshTrackingStatusContext();
    }
  };
  const trackingReadiness = (() => {
    const mode = trackingMode;
    const checks = [
      {
        label: 'Tracking mode',
        ready: mode !== 'paused',
        action: null,
        detail: mode === 'paused'
          ? 'All tracking is paused in Settings.'
          : mode === 'manual'
            ? 'Manual start is available.'
            : mode === 'background_auto'
              ? 'Background auto is selected.'
              : 'Foreground auto-detect is selected.',
      },
      {
        label: 'Location',
        ready: settings.location_permission_granted === true,
        action: 'location',
        detail: settings.location_permission_granted
          ? 'Location permission is recorded as granted.'
          : mode === 'manual'
            ? 'Location permission is needed before a manual trip can record GPS.'
            : 'Location permission is needed before automatic tracking can start.',
      },
      {
        label: 'Activity',
        ready: !isAndroid() || settings.activity_permission_granted === true,
        action: 'activity',
        detail: isAndroid()
          ? settings.activity_permission_granted
            ? 'Physical Activity is ready.'
            : mode === 'manual'
              ? 'Physical Activity improves trip context and keeps setup honest for switching to auto later.'
              : 'Physical Activity helps auto tracking tell driving from walking or still time.'
          : 'Activity permission is not required on this platform.',
      },
      {
        label: 'Background',
        ready: !isAndroid() || (mode !== 'background_auto' && mode !== 'manual') || settings.background_location_granted === true,
        action: 'background',
        detail: mode === 'background_auto'
          ? settings.background_location_granted ? 'Background location is ready.' : 'Allow all-the-time location for background auto tracking.'
          : isAndroid() && mode === 'manual'
            ? settings.background_location_granted ? 'Background location is ready for reliable manual trips.' : 'Recommended for Android manual trips so recording can continue if the app is minimized.'
            : 'Background location is not needed for this mode.',
      },
      {
        label: 'Notifications',
        ready: !isAndroid() || (mode !== 'background_auto' && mode !== 'manual') || settings.notification_permission_granted === true,
        action: 'notifications',
        detail: mode === 'background_auto'
          ? settings.notification_permission_granted ? 'Foreground service notifications are ready.' : 'Android background tracking needs notifications for its persistent status.'
          : isAndroid() && mode === 'manual'
            ? settings.notification_permission_granted ? 'Notifications are ready for tracking status.' : 'Recommended for Android manual background tracking and foreground warnings.'
            : 'Notifications improve trip summaries and safety alerts.',
      },
      {
        label: 'Battery',
        ready: !isAndroid() || mode !== 'background_auto' || trackingStatusContext.batteryStatus?.batteryOptimizationIgnored === true,
        action: 'battery',
        detail: isAndroid() && mode === 'background_auto'
          ? trackingStatusContext.batteryStatus?.batteryOptimizationIgnored ? 'Battery optimization is unrestricted.' : 'Unrestricted battery helps Android keep background auto tracking alive.'
          : 'Battery setup is only needed for Android background auto.',
      },
      {
        label: 'Native service',
        ready: !isAndroid() || (mode !== 'background_auto' && mode !== 'manual') || trackingStatusContext.nativeStatus?.enabled === true || tracking,
        action: 'native',
        detail: isAndroid() && mode === 'background_auto'
          ? trackingStatusContext.nativeStatus?.enabled ? 'Native auto tracking is armed.' : 'Start the native service so Android can detect drives while the app sleeps.'
          : isAndroid() && mode === 'manual'
            ? tracking ? 'Native manual background tracking is active.' : 'Manual trips start the native background service when you press Start Trip.'
            : 'Native service is only used for Android background tracking.',
      },
    ];
    const blockers = checks.filter((item) => !item.ready);
    return {
      mode,
      checks,
      ready: blockers.length === 0,
      headline: blockers.length === 0 ? 'Tracking is ready' : `${blockers.length} tracking setup item${blockers.length === 1 ? '' : 's'} need attention`,
      detail: blockers.length === 0
        ? mode === 'manual' ? 'Manual trips can start with GPS recording.' : 'Auto tracking has the recorded permissions it needs.'
        : blockers[0].detail,
    };
  })();
  const trackingExplanation = buildDashboardTrackingExplanation({
    settings,
    permissionStatus: trackingStatusContext.permissionStatus,
    nativeStatus: trackingStatusContext.nativeStatus,
    batteryStatus: trackingStatusContext.batteryStatus,
    diagnostics: trackingStatusContext.diagnostics,
    latestTrip,
    tracking,
    currentSpeedKmh: currentLocation?.speed_kmh,
    currentActivity: latestActivityRef.current,
    isAndroidPlatform: isAndroid(),
  });
  const voiceDeliveryStatus = getVoiceAlertDeliveryStatus({
    settings,
    trip: activeTrip,
    isAndroidPlatform: isAndroid(),
    nativeStatus: trackingStatusContext.nativeStatus,
    tracking,
  });
  const voiceDeliveryTone = {
    disabled: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200',
    native: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200',
    armed: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-200',
    webview: 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900/50 dark:bg-cyan-950/20 dark:text-cyan-200',
    ready: 'border-border bg-background/70 text-muted-foreground',
  }[voiceDeliveryStatus.status] || 'border-border bg-background/70 text-muted-foreground';
  const explanationTone = {
    good: 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/20',
    warn: 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20',
    bad: 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20',
  }[trackingExplanation.status] || 'border-border bg-card';
  const explanationIconTone = {
    good: 'text-emerald-600 dark:text-emerald-300',
    warn: 'text-amber-600 dark:text-amber-300',
    bad: 'text-red-600 dark:text-red-300',
  }[trackingExplanation.status] || 'text-primary';
  const trackingExplanationPanel = (
    <div className={`rounded-3xl border p-4 shadow-sm ${explanationTone}`}>
      <div className="flex items-start gap-3">
        {trackingExplanation.status === 'good' ? (
          <CheckCircle2 className={`mt-0.5 h-5 w-5 flex-shrink-0 ${explanationIconTone}`} />
        ) : (
          <AlertTriangle className={`mt-0.5 h-5 w-5 flex-shrink-0 ${explanationIconTone}`} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Why tracking did or did not start</div>
              <div className="mt-1 text-sm font-semibold">{trackingExplanation.headline}</div>
            </div>
            <button
              type="button"
              onClick={refreshTrackingStatusContext}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-xs font-semibold hover:bg-background"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{trackingExplanation.detail}</div>
          {trackingExplanation.lastDecision && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Last decision: {trackingExplanation.lastDecision.title || trackingExplanation.lastDecision.type}
              {trackingExplanation.lastDecision.reason ? ` - ${String(trackingExplanation.lastDecision.reason).replace(/_/g, ' ')}` : ''}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {trackingExplanation.facts.slice(0, 9).map((fact) => (
              <span key={fact} className="rounded-full border border-border bg-background/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {fact}
              </span>
            ))}
          </div>
          <div className={`mt-3 rounded-xl border px-3 py-2 text-xs ${voiceDeliveryTone}`}>
            <div className="font-semibold">{voiceDeliveryStatus.label}</div>
            <div className="mt-0.5 opacity-90">{voiceDeliveryStatus.detail}</div>
          </div>
        </div>
      </div>
    </div>
  );
  const trackingReadinessPanel = !tracking ? (
    <div className={`rounded-3xl border p-4 shadow-sm ${
      trackingReadiness.ready
        ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/20'
        : 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20'
    }`}>
      <div className="flex items-start gap-3">
        {trackingReadiness.ready ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-300" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{trackingReadiness.headline}</div>
          <div className="mt-1 text-xs text-muted-foreground">{trackingReadiness.detail}</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {trackingReadiness.checks.map((item) => (
              <div key={item.label} className="rounded-xl bg-background/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{item.label}</span>
                  <span className={`h-2 w-2 rounded-full ${item.ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.detail}</div>
                {!item.ready && item.action && (
                  <button
                    type="button"
                    onClick={() => handleTrackingSetupAction(item.action)}
                    aria-label={`Fix ${item.label} tracking setup`}
                    className="mt-2 rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground"
                  >
                    Fix
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  ) : null;

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

      {showScoreReviewWarning && (
        <div className="flex items-start rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
          <a
            href="/settings?section=settings-detection-thresholds"
            className="flex min-w-0 flex-1 items-start gap-3 rounded-l-2xl p-4 transition-colors hover:bg-amber-100 dark:hover:bg-amber-950/50"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <div className="text-sm font-semibold">Trip scores need review</div>
              <div className="mt-0.5 text-xs">
                {scoreModelMismatchTrips.length > 0
                  ? `${scoreModelMismatchTrips.length} completed trip${scoreModelMismatchTrips.length === 1 ? '' : 's'} used an older scoring model. Tap to open re-scoring.`
                  : `${unavailableScoreTrips.length} trip${unavailableScoreTrips.length === 1 ? ' has' : 's have'} unavailable scores. Tap to re-score from Settings.`}
              </div>
            </div>
          </a>
          <button
            type="button"
            onClick={dismissScoreReviewWarning}
            aria-label="Dismiss trip score review warning"
            title="Dismiss"
            className="m-2 rounded-full p-2 transition-colors hover:bg-amber-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:hover:bg-amber-900/60"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {showSpeedLimitReviewWarning && (
        <div className="flex overflow-hidden rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
          <a
            href={activeSpeedLimitReview.tripId ? `/trips/${activeSpeedLimitReview.tripId}?review=speed-limit-conflicts` : '/trips?review=speed-limit-conflicts'}
            className="flex flex-1 items-start gap-3 p-4 transition-colors hover:bg-amber-100 dark:hover:bg-amber-950/50"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <div className="text-sm font-semibold">Review speed limits while parked</div>
              <div className="mt-0.5 text-xs">
                {activeSpeedLimitReview.count} local speed {activeSpeedLimitReview.count === 1 ? 'area needs' : 'areas need'} parked confirmation before any posted-sign correction is saved.
              </div>
            </div>
          </a>
          <button
            type="button"
            onClick={() => dismissSpeedLimitReviewWarning(activeSpeedLimitReviewFingerprint)}
            aria-label="Dismiss parked speed-limit review warning"
            title="Dismiss"
            className="m-2 self-start rounded-full p-2 transition-colors hover:bg-amber-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:hover:bg-amber-900/60"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {(brakingImprovement || parkingReminder) && (
        <div className="grid gap-3 md:grid-cols-2">
          {brakingImprovement && (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
              <TrendingDown className="h-5 w-5" />
              <div>
                <div className="text-sm font-semibold">{brakingImprovement.message}</div>
                <div className="text-xs opacity-80">Braking score {formatEstimatedScore(brakingImprovement.previous)} to {formatEstimatedScore(brakingImprovement.current)}</div>
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
                  <h2 className="font-semibold">High fatigue exposure estimate</h2>
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

      <AnimatePresence>
        {manualForegroundConfirmOpen && (
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
              className="w-full max-w-sm rounded-3xl border border-amber-200 bg-card p-5 shadow-2xl dark:border-amber-800/50"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-1 h-5 w-5 text-amber-500" />
                <div>
                  <h2 className="font-semibold">Keep the app open for this trip</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Foreground GPS only records reliably while Road Sage stays open onscreen. Background GPS lets you minimize the app while its recording notification is visible, but fully closing or force-stopping the app can still stop recording on Android. If Road Sage is force-stopped, GPS may pause.
                  </p>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextOptions = pendingManualForegroundStartOptions || {};
                    setManualForegroundConfirmOpen(false);
                    setPendingManualForegroundStartOptions(null);
                    recordTrackingDiagnostic({
                      type: 'manual_background_tracking_selected',
                      title: 'Manual trip background tracking selected',
                      reason: 'user_selected_background_tracking',
                      background_tracking: true,
                    });
                    handleStartTrip({
                      ...nextOptions,
                      bypassManualForegroundWarning: true,
                      forceBackgroundTracking: true,
                    });
                  }}
                  className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Use Background GPS
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextOptions = pendingManualForegroundStartOptions || {};
                    setManualForegroundConfirmOpen(false);
                    setPendingManualForegroundStartOptions(null);
                    recordTrackingDiagnostic({
                      type: 'manual_foreground_confirmation_accepted',
                      title: 'Manual foreground tracking accepted',
                      reason: 'user_will_keep_app_open',
                      background_tracking: false,
                    });
                    handleStartTrip({ ...nextOptions, bypassManualForegroundWarning: true });
                  }}
                  className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100"
                >
                  Start Foreground Only - keep app open
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setManualForegroundConfirmOpen(false);
                    setPendingManualForegroundStartOptions(null);
                    recordTrackingDiagnostic({
                      type: 'manual_foreground_confirmation_cancelled',
                      title: 'Manual foreground tracking cancelled',
                      reason: 'user_cancelled_before_start',
                      background_tracking: false,
                    });
                  }}
                  className="rounded-xl border border-border px-3 py-2 text-sm font-semibold hover:bg-secondary"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showManualForegroundWarning && tracking && (
        <div
          role="alert"
          style={{
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 13,
            color: '#92400e',
            marginBottom: 8,
          }}
        >
          Background GPS is required for Android manual trips. Minimize only after Background GPS is active; fully closing or force-stopping the app can stop recording.
        </div>
      )}

      {gpsPointWarning && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <div className="text-sm font-semibold">GPS points are not arriving</div>
            <div className="mt-0.5 text-xs">
              Keep Road Sage open and check location permission. Background GPS can record while minimized, but fully closing or force-stopping the app is not guaranteed.
            </div>
          </div>
        </div>
      )}

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
                  <span className="text-white/80 text-sm font-medium">
                    {endingTrip ? 'Saving Trip' : activeTripIsCandidate ? 'Checking Movement' : activeTripIsPrivate ? 'Private Trip Active' : 'Trip Active'}
                  </span>
                  {activeTripIsBackgroundTracking && (
                    <span className="rounded-full border border-emerald-200/50 bg-emerald-300/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                      Background GPS active
                    </span>
                  )}
                  {activeTripIsStartingBackground && (
                    <span className="rounded-full border border-emerald-200/50 bg-emerald-300/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                      Starting background GPS
                    </span>
                  )}
                  {showManualForegroundWarning && (
                    <span className="rounded-full border border-amber-200/50 bg-amber-300/20 px-2 py-0.5 text-[11px] font-semibold text-amber-100">
                      Foreground GPS - keep app open
                    </span>
                  )}
                </div>
                <div className="font-grotesk font-bold text-4xl">{formatDuration(elapsed)}</div>
                <div className="text-white/70 text-sm mt-1">
                  {activeTripIsCandidate ? (
                    activeTrip?.candidate_near_parked
                      ? 'Hidden candidate near parked car'
                      : 'Hidden candidate validating movement'
                  ) : activeTripIsPrivate ? (
                    `${formatDistance((activeTrip?.private_trip_summary?.distance_m || 0) / 1000, units)} \u00b7 ${formatSpeed(activeTrip?.private_trip_summary?.avg_running_speed_kmh || 0, units)} avg`
                  ) : activeTrip?.route_points?.length ? (
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
              const thresholds = buildDrivingThresholds(settings);
              const routePointsForBadge = [
                ...(activeTrip?.route_points || []),
                currentLocation,
              ].filter((routePoint) => (
                Number.isFinite(Number(routePoint?.lat)) && Number.isFinite(Number(routePoint?.lng))
              ));
              const speedLimitContext = routePointsForBadge.length
                ? resolveEffectiveSpeedLimitForIndex(routePointsForBadge, routePointsForBadge.length - 1, thresholds, { settings })
                : null;
              const resolved = createTierAwareSpeedLimitContext(speedLimitContext, settings);
              const badge = speedLimitBadgeForResolved(resolved);
              const liveSpeedReady = hasLiveSpeedEvidence(activeTrip, routePointsForBadge, currentLocation);
              const speedWarning = liveSpeedReady
                ? shouldWarnForSpeed({ speedKmh: spd, candidate: resolved, settings })
                : null;
              const isOverWarn = speedWarning?.visual === true;
              const reviewAfterTrip = liveSpeedReady && resolved?.tier && resolved.tier !== 'POSTED' && resolved.tier !== 'UNKNOWN';
              return (
                <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                  <MapPin className="w-3.5 h-3.5 text-white/70" />
                  <span className={`font-semibold ${isOverWarn ? 'text-red-300 animate-pulse' : 'text-white/70'}`}>
                    {!liveSpeedReady && 'GPS settling'}
                    {liveSpeedReady && (
                      <>
                    {formatSpeed(spd, units)}{isOverWarn ? ' ⚠️ Over limit!' : ''}
                      </>
                    )}
                  </span>
                  <span className="opacity-50 text-white/70">·</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}
                    title="Speed-limit source for live coaching"
                  >
                    {badge.text}
                  </span>
                  {reviewAfterTrip && (
                    <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/80">
                      Review after trip
                    </span>
                  )}
                  <span className="opacity-50 text-white/70">{'\u00b7'}</span>
                  <span className="text-white/70">Acc: {Math.round(currentLocation.accuracy || 0)}m</span>
                </div>
              );
            })()}

            {activeTripIsPrivate && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-white/20 bg-slate-950/30 px-3 py-2 text-sm text-white/90">
                <Shield className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Summary only</div>
                  <div className="mt-0.5 text-xs text-white/70">
                    GPS is used temporarily for live distance and position. Route coordinates, addresses, driving events, and scores are not saved.
                  </div>
                </div>
              </div>
            )}

            {endingTrip && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-white/20 bg-white/15 px-3 py-2 text-sm text-white/90">
                <RefreshCw className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
                <div>
                  <div className="font-semibold">Saving your trip</div>
                  <div className="mt-0.5 text-xs text-white/70">
                    This can take a few seconds while Road Sage finishes GPS sync and scoring.
                  </div>
                </div>
              </div>
            )}

            {activeTrip?.start_source === 'manual' && !activeTripIsPrivate && (
              <div className={`mb-4 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                activeTripIsBackgroundTracking
                  ? 'border-emerald-200/40 bg-emerald-400/15 text-emerald-50'
                  : 'border-amber-200/40 bg-amber-400/15 text-amber-50'
              }`}>
                {activeTripIsBackgroundTracking ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                )}
                <div>
                  <div className="font-semibold">
                    {activeTripIsBackgroundTracking
                      ? 'Background GPS active'
                      : activeTripIsStartingBackground
                        ? 'Waiting for Background GPS'
                        : 'Background GPS not active'}
                  </div>
                  <div className="mt-0.5 text-xs opacity-85">
                    {activeTripIsBackgroundTracking
                      ? 'You can minimize Road Sage while the recording notification is visible. Do not fully close or force-stop the app; Android may stop recording.'
                      : activeTripIsStartingBackground
                        ? 'Keep Road Sage open until Background GPS active appears. Do not minimize, close, or force-stop yet.'
                        : 'Background GPS is required for Android manual trips. Check permissions before driving.'}
                  </div>
                </div>
              </div>
            )}

            {!activeTripIsPrivate && (activeTrip?.route_points?.length > 0 || currentLocation) && (
              <div className="mb-4 overflow-hidden rounded-2xl border border-white/15 bg-white/10">
                <Suspense fallback={<div className="h-[220px] animate-pulse bg-white/10" />}>
                  <TripMap
                    routePoints={activeTrip?.route_points || []}
                    currentLocation={currentLocation}
                    showCurrentLocation
                    parkedLocation={activeTripIsCandidate ? parkedLocation : null}
                    smoothRoute={false}
                    showIncompleteRouteWarning={false}
                    height="220px"
                  />
                </Suspense>
              </div>
            )}

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

            <div className={activeTripIsPrivate ? 'grid grid-cols-2 gap-3' : ''}>
              {activeTripIsPrivate && (
                <button
                  onClick={handleDiscardPrivateTrip}
                  disabled={endingTrip}
                  className="flex min-w-0 items-center justify-center gap-2 rounded-xl border border-white/20 bg-slate-950/25 px-3 py-3 font-semibold text-white/85 transition-colors hover:bg-slate-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4 flex-shrink-0" />
                  <span className="min-w-0 truncate">Discard</span>
                </button>
              )}
              <button
                onClick={handleEndTrip}
                disabled={endingTrip}
                className={`${activeTripIsPrivate ? 'px-3 text-sm leading-tight sm:text-base' : ''} flex w-full min-w-0 items-center justify-center gap-2 rounded-xl bg-white/15 py-3 font-semibold transition-colors hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-75`}
              >
                {endingTrip ? (
                  <RefreshCw className="h-4 w-4 flex-shrink-0 animate-spin" />
                ) : (
                  <Square className="h-4 w-4 flex-shrink-0" />
                )}
                <span className={activeTripIsPrivate ? 'min-w-0 whitespace-nowrap' : ''}>
                  {endingTrip ? (activeTripIsPrivate ? 'Saving...' : 'Saving Trip...') : activeTripIsPrivate ? 'Save Summary' : 'End Trip'}
                </span>
              </button>
            </div>
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
              <div className="flex-1 min-w-0">
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
            {isAndroidManualMode && (
              <div className={`mt-4 rounded-2xl border p-3 ${
                androidManualBackgroundReady
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-100'
                  : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100'
              }`}>
                <div className="flex items-start gap-3">
                  {androidManualBackgroundReady ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">
                      {androidManualBackgroundReady
                        ? 'Manual trips will use Background GPS'
                        : 'Manual background setup needed'}
                    </div>
                    <div className="mt-0.5 text-xs opacity-85">
                      {androidManualBackgroundReady
                        ? 'You can minimize Road Sage after starting while the recording notification is visible. Do not fully close or force-stop the app.'
                        : 'Enable Background Tracking before you start. Manual Android trips are intended to run through the native background service.'}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-medium">
                      <span className="rounded-full bg-background/60 px-2 py-1">Location: {foregroundLocationReady ? 'ready' : 'needed'}</span>
                      <span className="rounded-full bg-background/60 px-2 py-1">Background: {backgroundLocationReady ? 'ready' : 'needed'}</span>
                      <span className="rounded-full bg-background/60 px-2 py-1">Notifications: {notificationsReady ? 'ready' : 'needed'}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!androidManualBackgroundReady && (
                        <button
                          type="button"
                          onClick={() => handleTrackingSetupAction('background')}
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                        >
                          Enable Background Tracking
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={refreshTrackingStatusContext}
                        className="rounded-lg border border-border bg-background/70 px-3 py-1.5 text-xs font-semibold"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => handleStartTrip({ privateTrip: true })}
              className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-border bg-secondary/50 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary"
            >
              <div className="rounded-xl bg-slate-900 p-2 text-white dark:bg-slate-700">
                <Shield className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Start Private Trip</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Save distance and duration only. No route, addresses, events, or score.</div>
              </div>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {!tracking && completedTrips.length >= 5 && !readinessDismissed && (
        <SectionErrorBoundary
          context="dashboard_risk_panel"
          title="Trip readiness unavailable"
          message="Something went wrong while preparing the readiness score. Reload to try again."
          resetKey={`${completedTrips[0]?.id || 'none'}:${dangerZones.length}:${currentLocation?.timestamp || 'no-location'}`}
        >
          <DashboardRiskPanel
            completedTrips={completedTrips}
            currentLocation={dangerZoneCurrentLocation}
            dailyFatigue={dailyFatigue}
            dangerZones={dangerZones}
            habitProfile={habitProfile}
            onDismiss={() => setReadinessDismissed(true)}
            settings={settings}
          />
        </SectionErrorBoundary>
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
                {baselineText}
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
              <div className="font-grotesk font-bold text-xl">{baseline.baseline_avg == null ? '-' : baselineRangeLabel ? `${baseline.baseline_avg} (${baselineRangeLabel})` : baseline.baseline_avg}</div>
              <div className="text-xs text-muted-foreground">approx baseline (recent trips)</div>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="font-grotesk font-bold text-xl">{baseline.percentile == null ? '-' : `${baseline.percentile}%`}</div>
              <div className="text-xs text-muted-foreground">percentile among your recorded weeks</div>
              {baseline.percentile == null && (
                <div className="mt-1 text-[11px] text-muted-foreground">Needs {baseline.percentile_min_weeks} scored weeks</div>
              )}
            </div>
            <div className="bg-secondary/50 rounded-xl p-3">
              <div className="flex items-center gap-2">
                <TrafficCone className={`w-4 h-4 ${
                  peakStress.insufficient_data ? 'text-muted-foreground' :
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
            <div className="text-xs text-muted-foreground">estimated fatigue risk (driving-time proxy) - {fatigueRisk.long_trip_count} long drives this week</div>
          </div>
        </div>
      )}

      {dailyFatigue.tripCount >= 1 && (
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-base capitalize">Driving-time exposure estimate · {dailyFatigue.fatigueLevel}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {dailyFatigue.totalDrivingMinutes} min driven today across {dailyFatigue.tripCount} trips
              </p>
              {dailyFatigue.minutesSinceLastTrip != null && (
                <p className="mt-1 text-xs text-muted-foreground">Resting {dailyFatigue.minutesSinceLastTrip} min</p>
              )}
            </div>
            <div className="font-grotesk text-2xl font-bold">~{dailyFatigue.cumulativeFatigueScore}/10</div>
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
              Consider a {dailyFatigue.recommendedBreakMinutes}-min break before your next trip
            </div>
          )}
        </div>
      )}

      {/* Score & Trend */}
      <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-base">Driving Score</h2>
              {OVERALL_SCORE_IS_APPROXIMATE && <CalibrationStatusTag />}
            </div>
            <p className="text-muted-foreground text-xs mt-0.5">Last {Math.min(10, completedTrips.length)} trips</p>
          </div>
          {completedTrips.length > 0 && (
            <ScoreRing score={avgScore} evidence={avgScoreEvidence} size={72} strokeWidth={6} sublabel="avg" />
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
                formatter={(v) => [formatEstimatedScore(v), 'Score']}
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
      <div className="space-y-3">
        {trackingExplanationPanel}
        {trackingReadinessPanel}
      </div>
      {tracking && !activeTripIsCandidate && !activeTripIsPrivate && settings.live_coaching_enabled !== false && (
        <LiveCoachOverlay
          currentRoutePoints={activeTrip?.route_points || []}
          currentEvents={activeTrip?.driving_events || []}
          tripStartTime={activeTrip?.start_time}
          voiceMuted={shouldMuteDashboardWebViewVoice(activeTrip)}
        />
      )}
    </div>
  );
}

function DashboardRiskPanel({
  completedTrips,
  currentLocation,
  dailyFatigue,
  dangerZones,
  habitProfile,
  onDismiss,
  settings,
}) {
  const predictiveRouteRisk = useMemo(() => estimatePredictiveRouteRisk({
    trips: completedTrips,
    dangerZones,
    weatherRiskScore: null,
    currentLocation,
    habitProfile,
  }), [completedTrips, currentLocation, dangerZones, habitProfile]);

  const preTripRisk = useMemo(() => computePreTripRisk(completedTrips, settings, dailyFatigue, {
    nearbyDangerZoneCount: predictiveRouteRisk.nearbyDangerZoneCount,
    predictiveRouteRisk,
  }, habitProfile), [completedTrips, dailyFatigue, habitProfile, predictiveRouteRisk, settings]);
  const readinessEvidence = preTripRisk.dataQuality?.readinessEvidence || 'unavailable';
  const showReadinessNumber = readinessEvidence === 'high' && preTripRisk.readinessScore != null;
  const readinessSummary = preTripRisk.readinessScore == null
    ? 'Not enough data yet'
    : showReadinessNumber
      ? `Estimated ${formatEstimatedScore(preTripRisk.readinessScore)}/100 - ${preTripRisk.riskLevel} risk`
      : 'Limited-data readiness estimate';

  return (
    <div className="bg-card border border-border rounded-3xl p-4 shadow-sm">
      <div className="flex items-start gap-4">
        <div
          className="grid h-14 w-14 flex-shrink-0 place-items-center rounded-full text-sm font-bold text-white"
          style={{
            background: preTripRisk.riskLevel === 'low'
              ? '#22c55e'
              : preTripRisk.riskLevel === 'moderate'
                ? '#eab308'
                : preTripRisk.riskLevel === 'high'
                  ? '#ef4444'
                  : 'hsl(var(--muted-foreground))',
          }}
        >
          {showReadinessNumber ? formatEstimatedScore(preTripRisk.readinessScore) : '-'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 break-words font-semibold">Trip readiness estimate</h2>
              {READINESS_SCORE_IS_APPROXIMATE && <CalibrationStatusTag />}
            </span>
            <button
              onClick={onDismiss}
              className="flex-shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-secondary"
              aria-label="Dismiss readiness card"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="break-words text-sm font-medium capitalize">
            {readinessSummary}
          </div>
          <div className="mt-0.5 break-words text-xs capitalize text-muted-foreground">
            {readinessEvidence} evidence
          </div>
          {preTripRisk.dataQuality?.personalised === false && (
            <div className="mt-1 break-words text-xs text-muted-foreground">
              Learning your habits - a precise readiness number stays hidden until enough signals are available.
            </div>
          )}
          {preTripRisk.dataQuality?.personalised && preTripRisk.dataQuality.confidence < 1 && (
            <div className="mt-1 break-words text-xs text-muted-foreground">
              Readiness is personalising ({completedTrips.length} trips recorded).
            </div>
          )}
          {preTripRisk.riskLevel !== 'low' && (
            <>
              <div className="mt-1 break-words text-xs text-muted-foreground">{preTripRisk.primaryConcern}</div>
              <div className="mt-1 break-words text-xs italic text-muted-foreground">{preTripRisk.tipText}</div>
            </>
          )}
          <div className="mt-3 rounded-xl border border-border bg-secondary/40 p-3 text-xs">
            <div className="font-semibold">Recommended before starting</div>
            <div className="mt-1 text-muted-foreground">
              {preTripRisk.riskLevel === 'low'
                ? 'Conditions look steady. Start when your phone is mounted and GPS has a clear signal.'
                : preTripRisk.tipText || 'Take a short reset before driving, then start when you feel focused.'}
            </div>
          </div>
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
            predictiveRouteRisk.insufficientHistory ? (
              <div className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs">
                <div className="font-semibold">Historical context</div>
                <div className="mt-1 font-medium text-muted-foreground">Not enough driving history</div>
                <p className="mt-1 text-muted-foreground">
                  Complete a scored trip with recorded distance before a historical-context estimate is shown.
                </p>
              </div>
            ) : (
              <div className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2 break-words font-semibold">
                    Estimated historical context
                    {ROUTE_RISK_IS_APPROXIMATE && <CalibrationStatusTag />}
                  </span>
                  <span className={`flex-shrink-0 font-bold capitalize ${
                    predictiveRouteRisk.riskLevel === 'high' ? 'text-red-500' : predictiveRouteRisk.riskLevel === 'moderate' ? 'text-orange-500' : 'text-emerald-500'
                  }`}>
                    {predictiveRouteRisk.riskScore}/100
                  </span>
                </div>
                <div className="mt-1 break-words text-muted-foreground">{predictiveRouteRisk.primaryFactor}</div>
                <div className="mt-1 break-words text-muted-foreground">{predictiveRouteRisk.safestWindow}</div>
                {predictiveRouteRisk.nearbyDangerZoneCount > 0 && (
                  <div className="mt-1 font-semibold text-orange-600 dark:text-orange-300">
                    {predictiveRouteRisk.nearbyDangerZoneCount} repeated event area{predictiveRouteRisk.nearbyDangerZoneCount === 1 ? '' : 's'} from your history nearby
                  </div>
                )}
                <div className="mt-3 border-t border-border pt-2" aria-label="Estimated historical context component breakdown">
                  <div className="mb-2 font-semibold text-muted-foreground">Signal contributions</div>
                  {predictiveRouteRisk.componentBreakdown.map((component) => (
                    <div key={component.key} className="mb-1.5 flex items-start justify-between gap-3 last:mb-0">
                      <div className="min-w-0">
                        <div className="break-words font-medium">{component.label}</div>
                        <div className="break-words text-muted-foreground">{component.detail}</div>
                      </div>
                      <span className="flex-shrink-0 font-semibold">+{component.contribution}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 border-t border-border pt-2 text-muted-foreground">
                  Internal historical-context estimate only. No planned route is known, and signal thresholds are not validated against collision or casualty outcomes.
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
