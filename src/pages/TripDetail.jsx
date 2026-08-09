// @ts-check
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { calibrationLabelService } from '@/api/calibrationLabels';
import { tripDetailQueryOptions, tripQueryKeys, tripService, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Navigation, Clock, Gauge, TrendingDown, Zap, Car, MapPin,
  CornerUpRight, AlertTriangle, Moon, Trash2, Fuel, Leaf, Milestone,
  Building, Shuffle, Home, Waves, Shield, ShieldCheck, Focus, TimerReset, Tag,
  ParkingSquare, Droplets, GitBranch, Route, Smartphone, Pencil, Save, Star, Info,
  StickyNote, X
} from 'lucide-react';
import ScoreRing from '@/components/ScoreRing';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import DeferredRecharts from '@/components/DeferredRecharts';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import PhoneUsePermissionBanner from '@/components/PhoneUsePermissionBanner';
import PremiumMapDiagnostics, { shouldShowStandardMapRouteSummary } from '@/components/PremiumMapDiagnostics';
import PremiumTripContextCard, {
  selectPremiumSensorArtwork,
  selectPremiumSpeedArtwork,
  selectPremiumTripTagArtwork,
  selectPremiumWeatherArtwork,
} from '@/components/PremiumTripContextCard';
import SpeedLimitConflictReview from '@/components/SpeedLimitConflictReview';
import SpeedSignEvidenceReview from '@/components/SpeedSignEvidenceReview';
import { buildTripSpeedLimitReviewCells, speedLimitReviewNeededForTrip } from '@/lib/speedLimitReview';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import {
  buildDrivingThresholds,
  calculateSegmentMetrics,
  classifyRoadTypesByPoint,
  createZoneLookup,
  formatDistance,
  formatDuration,
  formatDateTime,
  formatSpeed,
  getScoreColor,
  getTripComponentScore,
  inferSpeedZones,
  PHONE_USE_SAFETY_WEIGHT,
  prefetchLocalKnowledge,
  resolveEffectiveSpeedLimitForIndex,
  splitTripAtStops,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { formatCurrencyAmount } from '@/lib/currency';
import { getJson, setJson } from '@/lib/mobileStorage';
import { DAILY_FATIGUE_THRESHOLDS } from '@/lib/dailyFatigueEngine';
import { buildFatigueHeatmapData, calculateFatigueRisk, detectTripStops, estimateTripEconomics } from '@/lib/tripInsights';
import { getPrivacyZones } from '@/lib/privacyZones';
import { getSegmentsForTrip, loadRouteRiskIndex } from '@/lib/routeRiskIndex';
import {
  buildRoadDataDisabledMessage,
  buildLocalSpeedKnowledgeScorePatch,
  buildRoadContextPrivacyMessage,
  buildWeatherContextPrivacyMessage,
  describeMapMatchingStatus,
  describeOsmSpeedLimitStatus,
  isRoadDataLookupConfigured,
  isWeatherContextLookupConfigured,
} from '@/lib/openSourceTripContext';
import { runRoadContextRefresh, runWeatherContextRefresh } from '@/lib/roadContextQueue';
import {
  USER_CONFIRMED_WEATHER_OPTIONS,
  buildUserConfirmedWeatherContext,
} from '@/lib/weatherContext';
import {
  refreshTripForLocalSpeedKnowledge,
  refreshTripsCrossingLocalSpeedCell,
  refreshTripsForLocalSpeedCorrections,
} from '@/lib/localSpeedScoreRefresh';
import {
  SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
  speedLimitDefaultCountryKey,
} from '@/lib/speedLimitSource';
import { buildPhoneUsageAccessProvenance, buildPhoneUseFromTripEvidence, mergePhoneUseEventsIntoDrivingEvents } from '@/lib/phoneUsageAccess';
import { summarizeTripPhoneUse } from '@/lib/phoneUseSummary';
import {
  TRIP_TAG_CATEGORIES,
  TRIP_TAG_OPTIONS,
  buildScoreExplanation,
  getTripDisplayName,
  getTripTagOption,
  normalizeTripTagId,
  normalizeTripTags,
} from '@/lib/tripMetadata';
import { inferTripTags } from '@/lib/tripTagIntelligence';
import { explainTripScoreDrivers, scoreFactorLabel } from '@/lib/scoring/scoreExplainer';
import { isScoreInputsSnapshotUsable } from '@/lib/scoring/scoreInputsSnapshot';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { DISMISSED_TAG_SUGGESTIONS_KEY, MAX_ROUTE_RISK_SEGMENTS_SHOWN } from '@/lib/appConstants';
import { hasProvisionalCalibration } from '@/lib/scoringConstants';
import { getAndroidUsageAccessStatus } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { requestAppAlert, requestAppConfirm } from '@/lib/appDialog';
import {
  SCORE_REVIEW_ISSUE_OPTIONS,
  SCORE_ACCURACY_OPTIONS,
  TRIP_CONTEXT_TAG_OPTIONS,
  WAS_DRIVER_OPTIONS,
} from '@/lib/calibrationLabeling';
import { formatEstimatedScore, formatScoreWithProvenance } from '@/lib/scoreDisplay';
import {
  formatConfidence,
  formatEventValue,
  formatMeasured,
  formatSpeedMeasured,
} from '@/lib/measurementDisplay';
import { eventFeedbackKey } from '@/lib/eventFeedbackKeys';
import { formatDataSourceLabel } from '@/lib/metricRegistry';
import { tripScoreDeltaSummary } from '@/lib/speedLimitDisplay';
import { summarizeTripSpeedLimitIntelligence } from '@/lib/speedLimitIntelligence';
import { getNightClassificationExplanation, getPremiumTripDetailPresentation } from '@/lib/premiumTripPresentation';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import useLocalSettings from '@/hooks/useLocalSettings';
import premiumTripPhoneRisk from '@/assets/premium-trip-phone-risk.webp';
import premiumTripPhoneSafe from '@/assets/premium-trip-phone-safe.webp';
import premiumTripPhoneNeutral from '@/assets/premium-trip-phone-neutral.webp';
import premiumTripRoadData from '@/assets/premium-trip-road-data.webp';
import premiumTripSpeedCoverage from '@/assets/premium-trip-speed-coverage.webp';

// CHANGES (session):
// - Added stronger posted-sign override wording for regional default and road-type estimates.

const TripMap = lazy(() => import('@/components/TripMap'));

const roadTypeConfig = {
  highway: { label: 'Highway', icon: Milestone, className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800/50' },
  urban: { label: 'Urban', icon: Building, className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800/50' },
  mixed: { label: 'Mixed', icon: Shuffle, className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700' },
  residential: { label: 'Residential', icon: Home, className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800/50' },
  // Rural trips previously rendered no chip at all even though the tag
  // suggester still offered a `rural` tag for them.
  rural: { label: 'Rural', icon: Milestone, className: 'bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/30 dark:text-lime-300 dark:border-lime-800/50' },
};

/**
 * `classifyRoadType` returns 'urban' as its terminal default and also when a
 * trip produced no usable speed samples at all, flagging the latter with
 * `road_type_source === 'insufficient_data'`. Rendering that as a confident
 * "Urban" chip states a road class that was never observed.
 */
const roadTypeWasMeasured = (trip = {}) => (
  trip.road_type_source !== 'insufficient_data' &&
  Number(trip.road_type_confidence) > 0
);

const roadTypeSourceLabel = {
  user_confirmed: 'Your confirmed road type',
  openstreetmap: 'OSM road class',
  gps_pattern: 'Local GPS-pattern estimate',
  insufficient_data: 'Low-evidence estimate',
};

const fatigueText = {
  significant: 'Quality dropped toward end of trip',
  moderate: 'Quality dipped; consider breaks',
  improving: 'You warmed up well',
  slight: 'Fairly consistent',
};
const CRITICAL_FATIGUE_CHART_LEVEL = DAILY_FATIGUE_THRESHOLDS.CRITICAL * 10;
const DIAGNOSTIC_EVENT_EXPLANATIONS = {
  aggressive_overtake: 'Diagnostic only because GPS can suggest an overtake pattern but cannot verify surrounding traffic, lane position, or safe re-entry.',
  heading_deviation: 'Diagnostic only because GPS heading changes cannot confirm a lane boundary crossing or driver intent.',
  heading_deviation_legacy: 'Diagnostic only because this is a migrated legacy GPS heading event, not measured lane-boundary evidence.',
  close_proximity: 'Diagnostic only because GPS brake-turn movement cannot measure object proximity, another road user, or an avoided collision.',
  phone_use_gps_proxy: 'Diagnostic only because GPS motion patterns are not confirmed phone interaction; Android Usage Access is required for scored phone-use evidence.',
};

const isGpsPhoneUseProxyEvent = (event = {}) => (
  event.type === 'phone_use' && (event.source === 'gps_proxy' || event.diagnostic_only === true)
);

const diagnosticExplanationForEvent = (event = {}) => (
  isGpsPhoneUseProxyEvent(event)
    ? DIAGNOSTIC_EVENT_EXPLANATIONS.phone_use_gps_proxy
    : DIAGNOSTIC_EVENT_EXPLANATIONS[event.type] || null
);

const isDiagnosticOnlyTripEvent = (event = {}) => Boolean(diagnosticExplanationForEvent(event));

const SCORE_AFFECTING_EVENT_FEEDBACK_TYPES = new Set([
  'harsh_brake',
  'rapid_acceleration',
  'sharp_turn',
  'speeding',
  'idle',
  'phone_use',
]);

const uniqueTripEvents = (events = []) => {
  const seen = new Set();
  return events.filter((event, index) => {
    const key = [
      event?.type || 'event',
      event?.timestamp || event?.startTime || index,
      event?.direction || '',
      event?.detection_method || '',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const speedLimitSourceFromTier = (tier) => ({
  POSTED: 'openstreetmap',
  MAP_ESTIMATED: 'osm_highway_default',
  LEARNED_LOCAL: 'learned_local',
  REGION_DEFAULT: 'region_default_estimate',
  GPS_INFERRED: 'inferred',
  UNKNOWN: 'unknown',
}[tier] || 'unknown');

const speedLimitSourceLabel = (source, countryLabel = 'Global') => {
  switch (source) {
    case 'openstreetmap':
      return 'OpenStreetMap posted maxspeed';
    case 'user_confirmed_posted_sign':
      return 'Your saved posted sign';
    case 'user_entered_estimate':
      return 'Your saved estimate';
    case 'learned_local':
    case 'local_road_memory':
    case 'trip_consensus':
    case 'time_of_day_bucket':
      return 'Learned local estimate';
    case 'osm_highway_default':
      return `OSM road-type estimate (${countryLabel} profile)`;
    case 'region_default_estimate':
      return `${countryLabel} fallback estimate`;
    case 'inferred':
      return 'GPS-inferred estimate';
    default:
      return 'Unknown speed-limit source';
  }
};

const speedLimitSourceDetail = (source) => {
  switch (source) {
    case 'openstreetmap':
    case 'user_confirmed_posted_sign':
      return 'Treated as posted speed evidence.';
    case 'user_entered_estimate':
      return 'Saved by the user, but not confirmed as a posted sign.';
    case 'osm_highway_default':
      return 'Based on OSM road type when no maxspeed tag was available.';
    case 'region_default_estimate':
      return 'Based on the selected country/region fallback profile.';
    case 'inferred':
      return 'Estimated from GPS behavior; lowest confidence.';
    default:
      return 'No usable source was recorded for these samples.';
  }
};

const speedLimitSourceTone = (source) => {
  if (source === 'openstreetmap' || source === 'user_confirmed_posted_sign') return 'bg-emerald-500';
  if (source === 'user_entered_estimate' || source === 'learned_local' || source === 'local_road_memory' || source === 'trip_consensus' || source === 'time_of_day_bucket') return 'bg-sky-500';
  if (source === 'osm_highway_default' || source === 'region_default_estimate') return 'bg-amber-500';
  return 'bg-slate-400';
};

const decorateSourceRow = (row) => ({
  ...row,
  label: speedLimitSourceLabel(row.source, row.countryLabel),
  detail: speedLimitSourceDetail(row.source),
  tone: speedLimitSourceTone(row.source),
});

/**
 * Rebuild the breakdown from the snapshot frozen when the trip was scored.
 * Percentages are derived here rather than stored, so copy and unit changes
 * never need a rescore while the counts stay fixed.
 */
function speedLimitSourceBreakdownFromSnapshot(snapshot) {
  const total = Number(snapshot.scored_sample_count) || 0;
  if (!total) return null;
  const rows = snapshot.speed_limit_sources.map((entry) => {
    const countryKey = String(entry.country_key || 'global').toLowerCase();
    const countryLabel = SPEED_LIMIT_DEFAULT_COUNTRY_LABELS[countryKey] || countryKey.toUpperCase();
    const count = Number(entry.count) || 0;
    return decorateSourceRow({
      key: entry.key,
      source: entry.source,
      countryLabel,
      count,
      percent: Math.round((count / total) * 100),
      limits: Array.isArray(entry.limits) ? entry.limits : [],
      confidence: count ? (Number(entry.confidence_sum) || 0) / count : 0,
    });
  });
  return {
    basis: 'scored',
    sampleCount: total,
    rows,
    summary: rows.map((row) => `${row.percent}% ${row.label}`).join('; '),
  };
}

function buildSpeedLimitSourceBreakdown(trip = {}, settings = {}, speedLimitContext = null, localKnowledgeResults = []) {
  // Prefer what scoring actually used. Re-resolving live reads *current*
  // settings, so a Settings change used to rewrite this panel with no rescore.
  if (isScoreInputsSnapshotUsable(trip?.score_inputs)) {
    const frozen = speedLimitSourceBreakdownFromSnapshot(trip.score_inputs);
    if (frozen) return frozen;
  }
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  const validIndexes = points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng)));
  const movingIndexes = validIndexes.filter(({ point }) => Number(point?.speed_kmh) > 1);
  const samples = movingIndexes.length ? movingIndexes : validIndexes;
  if (!samples.length) {
    return { basis: 'recomputed_now', sampleCount: 0, rows: [], summary: 'No route samples available.' };
  }

  const thresholds = buildDrivingThresholds(settings);
  const inferredZones = inferSpeedZones(points, thresholds);
  const zoneForIndex = createZoneLookup(inferredZones);
  const roadTypesByPoint = classifyRoadTypesByPoint(points);
  const fallbackCountry = speedLimitContext?.fallback_country || speedLimitDefaultCountryKey(settings);
  const buckets = new Map();

  for (const { point, index } of samples) {
    const resolved = resolveEffectiveSpeedLimitForIndex(points, index, thresholds, {
      inferredZones,
      zoneForIndex,
      roadTypesByPoint,
      settings,
      localKnowledge: localKnowledgeResults[index] ?? null,
    });
    const source = resolved.limitSource || speedLimitSourceFromTier(resolved.tier);
    const countryKey = (
      resolved.speedLimitDefaultCountry ||
      point.speed_limit_default_country ||
      point.fallback_country ||
      fallbackCountry ||
      'global'
    );
    const countryLabel = SPEED_LIMIT_DEFAULT_COUNTRY_LABELS[String(countryKey).toLowerCase()] || String(countryKey).toUpperCase();
    const key = ['osm_highway_default', 'region_default_estimate'].includes(source)
      ? `${source}:${countryLabel}`
      : source;
    const bucket = buckets.get(key) || {
      key,
      source,
      countryLabel,
      count: 0,
      limits: new Set(),
      confidenceTotal: 0,
    };
    bucket.count += 1;
    if (Number.isFinite(Number(resolved.limitKmh))) bucket.limits.add(Math.round(Number(resolved.limitKmh)));
    bucket.confidenceTotal += Number(resolved.confidence) || 0;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()]
    .map((bucket) => decorateSourceRow({
      ...bucket,
      percent: Math.round((bucket.count / samples.length) * 100),
      limits: [...bucket.limits].sort((a, b) => a - b),
      confidence: bucket.count ? bucket.confidenceTotal / bucket.count : 0,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const summary = rows.map((row) => `${row.percent}% ${row.label}`).join('; ');
  return { basis: 'recomputed_now', sampleCount: samples.length, rows, summary };
}

const resolveEventDisplayValue = (value, event) => (
  typeof value === 'function' ? value(event) : value
);

const eventDisplayConfig = (event = {}, gpsPhoneUseProxy = false) => {
  const labels = {
    harsh_brake: { label: 'Harsh Brake', icon: '!', color: 'text-red-600' },
    rapid_acceleration: { label: 'Rapid Acceleration', icon: '+', color: 'text-yellow-600' },
    sharp_turn: { label: 'Sharp Turn', icon: '<', color: 'text-blue-600' },
    speeding: { label: 'Speeding', icon: '>', color: 'text-orange-600' },
    idle: { label: 'Excessive Idle', icon: 'P', color: 'text-slate-500' },
    close_proximity: { label: 'Estimated brake-turn manoeuvre (GPS proxy)', icon: '!', color: 'text-red-700' },
    aggressive_overtake: { label: 'Overtake Pattern (Beta)', icon: '>>', color: 'text-orange-600' },
    heading_deviation: { label: 'Heading Event (Beta)', icon: '<>', color: 'text-sky-600' },
    heading_deviation_legacy: { label: 'Heading Event (Legacy)', icon: '<>', color: 'text-sky-600' },
    lane_change_detected: {
      label: (laneChange) => `Lane Change (${laneChange.direction === 'left' ? 'Left' : 'Right'})${laneChange.simultaneous_braking ? ' - Braking' : ''}`,
      icon: '<->',
      color: (laneChange) => laneChange.simultaneous_braking ? 'text-red-600' : 'text-sky-600',
      badge: (laneChange) => laneChange.confidence === 'low' ? 'GPS estimate' : null,
    },
    tailgate_cycle: { label: 'Stop-Start Pattern (Legacy)', icon: '!!', color: 'text-red-600' },
    stop_start_pattern: { label: 'Stop-Start Pattern', icon: '!!', color: 'text-red-600' },
    erratic_speed: { label: 'Erratic Speed', icon: '~', color: 'text-yellow-600' },
    possible_crash: { label: 'Possible Incident', icon: '!!', color: 'text-red-700' },
    phone_use: gpsPhoneUseProxy
      ? { label: 'GPS Phone-Use Proxy', icon: 'P', color: 'text-violet-600' }
      : { label: 'Phone Use', icon: 'P', color: 'text-red-600' },
  };
  const cfg = labels[event.type] || { label: event.type, icon: '!', color: 'text-foreground' };
  return {
    label: resolveEventDisplayValue(cfg.label, event),
    icon: resolveEventDisplayValue(cfg.icon, event),
    color: resolveEventDisplayValue(cfg.color, event),
    badge: resolveEventDisplayValue(cfg.badge, event),
  };
};
const OVERALL_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['score_overall']);
const SCORE_UNAVAILABLE_MESSAGE = 'Score unavailable for this trip – re-score to update';

export default function TripDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const qc = useQueryClient();
  const settings = useLocalSettings();
  const reviewSpeedLimitConflicts = new URLSearchParams(location.search || '').get('review') === 'speed-limit-conflicts';
  const units = settings.units || 'metric';
  // Trip Detail intentionally keeps the standard presentation in every app appearance mode.
  const premiumVisuals = false;
  const premiumMapVisuals = settings.premium_visual_experience === true;
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const [showCorneringHeatmap, setShowCorneringHeatmap] = useState(false);
  const [showSpeedLimitsOnMap, setShowSpeedLimitsOnMap] = useState(false);
  const [showPremiumRouteDiagnostics, setShowPremiumRouteDiagnostics] = useState(true);
  const [routeRiskIndex, setRouteRiskIndex] = useState(new Map());
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState({ nickname: '', notes: '', tags: [] });
  const [customTagDraft, setCustomTagDraft] = useState('');
  const [osmFetchStatus, setOsmFetchStatus] = useState('');
  const [manualWeatherCondition, setManualWeatherCondition] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState('');
  const [lastFeedbackUndo, setLastFeedbackUndo] = useState(null);
  const [showAllRouteRiskSegments, setShowAllRouteRiskSegments] = useState(false);
  const [dismissedTagsLoaded, setDismissedTagsLoaded] = useState(false);
  const [currentUsageAccessGranted, setCurrentUsageAccessGranted] = useState(null);
  const [calibrationSurveyStatus, setCalibrationSurveyStatus] = useState(null);
  const [calibrationLabelCount, setCalibrationLabelCount] = useState(null);
  const [speedLimitKnowledgeRevision, setSpeedLimitKnowledgeRevision] = useState(0);
  const [speedLimitLocalKnowledgeResults, setSpeedLimitLocalKnowledgeResults] = useState([]);
  const metadataSectionRef = useRef(null);
  const speedLimitReviewSectionRef = useRef(null);
  const trip3dAvailabilityLogRef = useRef('');
  // One owned timer for the transient feedback banner. Previously each action
  // called a bare setTimeout that was never cleared, so reviewing event A then
  // event B nine seconds later destroyed B's undo after one second, and a
  // pending timer kept firing after the page unmounted.
  const feedbackStatusTimerRef = useRef(null);
  const feedbackInFlightRef = useRef(false);
  const clearFeedbackStatusTimer = useCallback(() => {
    if (feedbackStatusTimerRef.current) {
      clearTimeout(feedbackStatusTimerRef.current);
      feedbackStatusTimerRef.current = null;
    }
  }, []);
  const showFeedbackStatus = useCallback((message, { durationMs = 6000, clearUndo = false } = {}) => {
    clearFeedbackStatusTimer();
    setFeedbackStatus(message);
    feedbackStatusTimerRef.current = setTimeout(() => {
      feedbackStatusTimerRef.current = null;
      setFeedbackStatus('');
      if (clearUndo) setLastFeedbackUndo(null);
    }, durationMs);
  }, [clearFeedbackStatusTimer]);
  useEffect(() => clearFeedbackStatusTimer, [clearFeedbackStatusTimer]);
  const invalidateTripLists = () => {
    qc.invalidateQueries({ queryKey: tripQueryKeys.summaries });
  };

  const { data: trip, isLoading } = useQuery(tripDetailQueryOptions(id));
  const { data: tagLearningHistory = [] } = useQuery({
    ...tripSummaryQueryOptions(),
    select: (trips) => trips.filter((item) => item.status === 'completed'),
  });
  const tagIntelligence = useMemo(
    () => inferTripTags(trip || {}, tagLearningHistory),
    [tagLearningHistory, trip]
  );
  const savedManualWeatherCondition = useMemo(() => {
    const source = String(trip?.weather_context?.source || '').toLowerCase();
    const condition = String(trip?.weather_context?.condition || '').toLowerCase();
    return source === 'user_confirmed' && USER_CONFIRMED_WEATHER_OPTIONS.includes(condition)
      ? condition
      : '';
  }, [trip?.weather_context?.condition, trip?.weather_context?.source]);

  useEffect(() => {
    setManualWeatherCondition(savedManualWeatherCondition);
  }, [savedManualWeatherCondition, trip?.id]);
  const showSpeedLimitReviewButton = Boolean(trip);
  const scrollToSpeedLimitReview = useCallback(() => {
    speedLimitReviewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const openSpeedLimitReview = useCallback(() => {
    if (reviewSpeedLimitConflicts) {
      scrollToSpeedLimitReview();
      return;
    }
    navigate(`/trips/${id}?review=speed-limit-conflicts`);
  }, [id, navigate, reviewSpeedLimitConflicts, scrollToSpeedLimitReview]);
  const toggleSpeedLimitReview = () => {
    navigate(reviewSpeedLimitConflicts ? `/trips/${id}` : `/trips/${id}?review=speed-limit-conflicts`);
  };

  useEffect(() => {
    if (!reviewSpeedLimitConflicts) return undefined;
    const frame = window.requestAnimationFrame(scrollToSpeedLimitReview);
    return () => window.cancelAnimationFrame(frame);
  }, [reviewSpeedLimitConflicts, scrollToSpeedLimitReview]);

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  useEffect(() => {
    let cancelled = false;
    const loadLocalSpeedKnowledge = async () => {
      const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
      if (!points.length) {
        if (!cancelled) setSpeedLimitLocalKnowledgeResults([]);
        return;
      }
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const results = await prefetchLocalKnowledge(points, knowledge).catch(() => points.map(() => null));
      if (!cancelled) setSpeedLimitLocalKnowledgeResults(results);
    };
    loadLocalSpeedKnowledge();
    return () => {
      cancelled = true;
    };
  }, [trip?.id, trip?.route_points, speedLimitKnowledgeRevision]);

  useEffect(() => {
    const onSpeedKnowledgeChanged = () => {
      setSpeedLimitKnowledgeRevision((value) => value + 1);
    };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
  }, []);

  const deleteMutation = useMutation({
    mutationFn: () => tripService.delete(id),
    onSuccess: () => {
      invalidateTripLists();
      navigate('/trips');
    },
  });
  const splitMutation = useMutation({
    mutationFn: async (/** @type {{sourceTrip:any}} */ vars) => {
      const { sourceTrip } = vars;
      const subTrips = splitTripAtStops(sourceTrip, 5);
      await Promise.all(subTrips.map((subTrip) => tripService.create(subTrip)));
      await tripService.delete(sourceTrip.id);
      return subTrips;
    },
    onSuccess: () => {
      invalidateTripLists();
      navigate('/trips');
    },
  });
  const tagMutation = useMutation({
    mutationFn: (/** @type {any} */ requestedTags) => {
      const acceptedTags = normalizeTripTags(Array.isArray(requestedTags) ? requestedTags : [requestedTags]);
      const tags = [...new Set([...normalizeTripTags(trip), ...acceptedTags])];
      const now = new Date().toISOString();
      const tagSources = { ...(trip?.tag_sources || {}) };
      acceptedTags.forEach((tag) => {
        const candidate = tagIntelligence.candidates.find((item) => item.tag === tag);
        tagSources[tag] = {
          source: 'user_confirmed',
          confidence: 1,
          reason: candidate ? `Confirmed by you. Suggested because: ${candidate.reason}` : 'Confirmed by you.',
          applied_at: now,
        };
      });
      return tripService.update(id, {
        tags,
        tag: tags[0] || null,
        tag_sources: tagSources,
        tag_reviewed: true,
        tag_intelligence_version: tagIntelligence.version,
      });
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      setMetadataDraft({
        nickname: updatedTrip?.nickname || trip?.nickname || '',
        notes: updatedTrip?.notes || trip?.notes || '',
        tags: normalizeTripTags(updatedTrip || trip || {}),
      });
    },
  });
  const metadataMutation = useMutation({
    mutationFn: (/** @type {any} */ patch) => tripService.update(id, patch),
    onSuccess: (updatedTrip) => {
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      setMetadataDraft({
        nickname: updatedTrip?.nickname || '',
        notes: updatedTrip?.notes || '',
        tags: normalizeTripTags(updatedTrip || {}),
      });
      setEditingMetadata(false);
    },
  });
  const feedbackMutation = useMutation({
    // `disabled={feedbackMutation.isPending}` only takes effect after a
    // re-render, so two fast taps both entered mutationFn and both read the
    // same pre-write feedback - leaving Undo holding a stale verdict. This ref
    // flips synchronously, before the second tap can start.
    onMutate: () => {
      if (feedbackInFlightRef.current) throw new Error('A review is already being saved.');
      feedbackInFlightRef.current = true;
    },
    onSettled: () => {
      feedbackInFlightRef.current = false;
    },
    mutationFn: async (/** @type {{eventKey:string, event:any, verdict:string|null, scoreAffecting?:boolean, isUndo?:boolean}} */ vars) => {
      const latestTrip = await tripService.getById(id);
      const existing = { ...(latestTrip?.event_feedback || {}) };
      const previousFeedback = existing[vars.eventKey] || null;
      if (vars.verdict == null) {
        delete existing[vars.eventKey];
      } else {
        existing[vars.eventKey] = {
          verdict: vars.verdict,
          type: vars.event?.type || 'unknown',
          timestamp: vars.event?.timestamp || vars.event?.startTime || null,
          value: vars.event?.value ?? null,
          reviewed_at: new Date().toISOString(),
          affects_score: vars.scoreAffecting !== false,
        };
      }
      const shouldRestorePhoneEvidence = vars.isUndo && vars.event?.type === 'phone_use';
      const currentPhoneEvents = Array.isArray(latestTrip?.phone_use_events) ? latestTrip.phone_use_events : [];
      const phoneEventAlreadyPresent = currentPhoneEvents.some((event) => (
        (event?.timestamp || event?.startTime) === (vars.event?.timestamp || vars.event?.startTime)
      ));
      const savedTrip = await tripService.update(id, {
        event_feedback: existing,
        // A detection note never triggers a rescore, but it must not clear a
        // rescore that was already pending for some other reason either.
        ...(vars.scoreAffecting === false
          ? (latestTrip?.needs_rescore ? { needs_rescore: true } : {})
          : { needs_rescore: true }),
        feedback_reviewed_at: new Date().toISOString(),
        ...(shouldRestorePhoneEvidence && !phoneEventAlreadyPresent
          ? { phone_use_events: [...currentPhoneEvents, vars.event] }
          : {}),
      });
      const rescoreResult = vars.scoreAffecting === false
        ? null
        : await tripService.rescoreById(id, { reason: vars.isUndo ? 'event_feedback_undo' : 'event_feedback' });
      return {
        previousFeedback,
        rescoreResult,
        updatedTrip: rescoreResult?.updatedTrip || savedTrip,
      };
    },
    onSuccess: (result, vars) => {
      const updatedTrip = result?.updatedTrip;
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();

      if (!vars.isUndo) {
        setLastFeedbackUndo({
          eventKey: vars.eventKey,
          event: vars.event,
          verdict: result?.previousFeedback?.verdict ?? null,
          scoreAffecting: vars.scoreAffecting !== false,
        });
      } else {
        setLastFeedbackUndo(null);
      }

      const statusMessage = (() => {
        if (vars.verdict == null) {
          return vars.scoreAffecting === false
            ? 'Detection note removed.'
            : 'Event review removed and the trip was re-scored.';
        }
        if (vars.scoreAffecting === false) {
          return vars.verdict === 'wrong'
            ? 'Detection flagged for review. This event type does not change the score.'
            : 'Detection note saved. This event type does not change the score.';
        }
        if (result?.rescoreResult?.skipped) {
          return 'Review saved, but this trip could not be re-scored (' + String(result.rescoreResult.skippedReason || 'route data unavailable').replace(/_/g, ' ') + ').';
        }
        const before = result?.rescoreResult?.before?.overall;
        const after = result?.rescoreResult?.after?.overall;
        // "Score stayed 38" is true but reads as "your correction was ignored".
        // The overall score is distance-normalized and saturates on short trips,
        // so a real change often lands only on components. Name one, so the
        // driver can see the correction was applied.
        const movedComponent = (result?.rescoreResult?.updatedTrip?.score_change_ledger?.[0]?.changes || [])
          .find((change) => change.key !== 'overall' && change.delta != null);
        const alsoChanged = movedComponent
          ? ' ' + scoreFactorLabel(movedComponent.key) + ' ' + movedComponent.from + ' → ' + movedComponent.to + '.'
          : '';
        const scoreChange = before == null || after == null
          ? 'Score remains unavailable.'
          : before === after
            ? 'Overall score stayed ' + after + '.' + (alsoChanged || ' No component changed.')
            : 'Score ' + before + ' → ' + after + '.' + alsoChanged;
        return vars.verdict === 'wrong'
          ? 'Marked wrong and removed from scoring. ' + scoreChange
          : 'Marked accurate and kept in scoring. ' + scoreChange;
      })();
      showFeedbackStatus(statusMessage, { durationMs: 10000, clearUndo: true });
    },
    onError: (error, vars) => {
      // Surface AND record it. This used to set local state only, so a failed
      // review left no trace anywhere for diagnosis.
      logSystemFailure('trip_event_feedback_save', error, {
        trip_id: id,
        event_type: vars?.event?.type || null,
        verdict: vars?.verdict ?? null,
        is_undo: vars?.isUndo === true,
      });
      showFeedbackStatus(error?.message || 'Could not save and apply this event review.', { durationMs: 8000 });
      setLastFeedbackUndo(null);
    },
  });
  const speedLimitReviewMutation = useMutation({
    mutationFn: async (/** @type {any} */ result) => {
      const latestTrip = await tripService.getById(id);
      const refreshSettings = localSettings.get();
      const reviewPatch = result.tripReviewComplete && latestTrip?.speed_limit_review_required !== false
        ? {
          speed_limit_review_required: false,
          speed_limit_review_resolved_at: new Date().toISOString(),
          speed_limit_review_reason: null,
        }
        : {};
      const corrections = Array.isArray(result?.corrections)
        ? result.corrections.filter(Boolean)
        : [];
      const geohashes = [...new Set([
        result?.geohash,
        ...(Array.isArray(result?.geohashes) ? result.geohashes : []),
      ].filter(Boolean).map(String))];
      let affectedTrips = [];
      if (corrections.length) {
        affectedTrips = await refreshTripsForLocalSpeedCorrections(corrections, refreshSettings);
      } else if (geohashes.length) {
        const batches = await Promise.all(geohashes.map((geohash) => (
          refreshTripsCrossingLocalSpeedCell(geohash, refreshSettings)
        )));
        const byId = new Map(batches.flat().filter(Boolean).map((item) => [String(item.id), item]));
        affectedTrips = [...byId.values()];
      }
      let updatedTrip = affectedTrips.find((item) => String(item?.id) === String(id)) || null;
      if (Object.keys(reviewPatch).length > 0 || !updatedTrip) {
        updatedTrip = await refreshTripForLocalSpeedKnowledge(updatedTrip || latestTrip, refreshSettings, reviewPatch);
        const nextAffectedById = new Map(affectedTrips.filter(Boolean).map((item) => [String(item.id), item]));
        nextAffectedById.set(String(updatedTrip.id), updatedTrip);
        affectedTrips = [...nextAffectedById.values()];
      }
      return { updatedTrip, beforeTrip: latestTrip, affectedTrips };
    },
    onSuccess: (result) => {
      const updatedTrip = result?.updatedTrip;
      if (updatedTrip) {
        qc.setQueryData(['trip', id], updatedTrip);
        qc.setQueriesData({ queryKey: tripQueryKeys.summaries }, (trips) => (
          Array.isArray(trips)
            ? trips.map((item) => (
              String(item?.id) === String(updatedTrip.id)
                ? {
                  ...item,
                  speed_limit_review_required: updatedTrip.speed_limit_review_required,
                  speed_limit_review_resolved_at: updatedTrip.speed_limit_review_resolved_at,
                  speed_limit_review_reason: updatedTrip.speed_limit_review_reason,
                }
                : item
            ))
            : trips
        ));
      }
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      qc.invalidateQueries({ queryKey: ['map-trips'] });
      const affectedCount = Array.isArray(result?.affectedTrips) ? result.affectedTrips.length : 0;
      // Do not floor this at 1 - claiming "Re-scored 1 matching trip" when
      // nothing was re-scored is a false report about the user's own data.
      showFeedbackStatus(affectedCount === 0
        ? `Saved road speed. No other trips were affected. ${tripScoreDeltaSummary(result?.beforeTrip, updatedTrip)}`
        : `Saved road speed. Re-scored ${affectedCount} matching trip${affectedCount === 1 ? '' : 's'} locally. ${tripScoreDeltaSummary(result?.beforeTrip, updatedTrip)}`);
    },
    onError: () => {
      showFeedbackStatus('The speed was saved, but this trip could not be re-scored right now.');
    },
  });
  const handleSpeedLimitReviewResolved = useCallback((result = {}) => {
    const hasSavedRoadChange = Boolean(
      result.geohash ||
      result.source ||
      (Array.isArray(result.geohashes) && result.geohashes.length > 0) ||
      (Array.isArray(result.corrections) && result.corrections.length > 0)
    );
    if (hasSavedRoadChange) {
      setSpeedLimitKnowledgeRevision((value) => value + 1);
    }
    if (!trip?.id || (!hasSavedRoadChange && !result.tripReviewComplete)) return;
    speedLimitReviewMutation.mutate(result);
  }, [speedLimitReviewMutation, trip?.id]);

  const feedbackRescoreMutation = useMutation({
    mutationFn: () => tripService.rescoreById(id, { reason: 'event_feedback_manual' }),
    onSuccess: (result) => {
      const updatedTrip = result?.updatedTrip;
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      showFeedbackStatus(result?.skipped
        ? 'Could not re-score this trip (' + String(result.skippedReason || 'route data unavailable').replace(/_/g, ' ') + ').'
        : result?.before?.overall === result?.after?.overall
          ? 'Trip re-scored. Score stayed ' + (result?.after?.overall ?? 'unavailable') + '.'
          : 'Trip re-scored. Score ' + (result?.before?.overall ?? 'unavailable') + ' → ' + (result?.after?.overall ?? 'unavailable') + '.');
    },
    onError: () => {
      showFeedbackStatus('Could not re-score this trip right now.');
    },
  });
  const contextMutation = useMutation({
    mutationFn: async () => {
      setOsmFetchStatus('Preparing road data');
      return runRoadContextRefresh(trip, localSettings.get(), {
        onProgress: setOsmFetchStatus,
      });
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      qc.invalidateQueries({ queryKey: ['map-trips'] });
    },
    onError: (error) => {
      setOsmFetchStatus(error?.message || 'Could not get road data');
    },
    onSettled: () => {
      setTimeout(() => setOsmFetchStatus(''), 2500);
    },
  });
  const weatherMutation = useMutation({
    mutationFn: async () => {
      setOsmFetchStatus('Preparing weather lookup');
      return runWeatherContextRefresh(trip, localSettings.get(), {
        onProgress: setOsmFetchStatus,
      });
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      qc.invalidateQueries({ queryKey: ['map-trips'] });
      const weather = updatedTrip?.weather_context;
      if (updatedTrip?.weather_lookup_kept_confirmed) {
        showFeedbackStatus('Open-Meteo had no usable observation, so the condition you confirmed locally was kept.');
      } else if (['open_meteo', 'user_confirmed'].includes(weather?.source) && weather?.condition) {
        showFeedbackStatus(`Weather updated to ${String(weather.condition).replace(/_/g, ' ')}.`);
      } else if (weather?.status === 'skipped_privacy') {
        showFeedbackStatus('No weather request was sent because every route point is inside a privacy-zone buffer.');
      } else {
        showFeedbackStatus('Weather lookup finished, but no matching weather observation was available.');
      }
    },
    onError: (error) => {
      setOsmFetchStatus(error?.message || 'Could not get weather');
      showFeedbackStatus(error?.message || 'Could not get weather. Check your connection and try again.');
    },
    onSettled: () => {
      setTimeout(() => setOsmFetchStatus(''), 2500);
    },
  });
  const manualWeatherMutation = useMutation({
    mutationFn: async (/** @type {string} */ condition) => {
      const latestTrip = await tripService.getById(id);
      const weatherContext = buildUserConfirmedWeatherContext(condition, latestTrip?.end_time || new Date().toISOString());
      const scorePatch = await buildLocalSpeedKnowledgeScorePatch({
        ...latestTrip,
        weather_context: weatherContext,
        weather_skipped_reason: null,
      }, localSettings.get());
      return tripService.update(id, {
        ...scorePatch,
        weather_context: weatherContext,
        weather_skipped_reason: null,
      });
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      invalidateTripLists();
      qc.invalidateQueries({ queryKey: ['map-trips'] });
      setManualWeatherCondition(String(updatedTrip?.weather_context?.condition || ''));
      showFeedbackStatus('Local weather condition saved and the trip was re-scored on this device.');
    },
    onError: (error) => {
      showFeedbackStatus(error?.message || 'Could not save the local weather condition.');
    },
  });
  const calibrationSurveyMutation = useMutation({
    /**
     * @param {{ surveyInput: unknown, replaceExisting?: boolean }} variables
     */
    mutationFn: ({ surveyInput, replaceExisting = false }) => (
      calibrationLabelService.submitTripSurveyLabel(trip, surveyInput, { replaceExisting })
    ),
    onSuccess: async (record, variables) => {
      const submittedSurvey = /** @type {{ wasDriver?: string } | null} */ (
        variables?.surveyInput && typeof variables.surveyInput === 'object'
          ? variables.surveyInput
          : null
      );
      const wasDriver = record?.surveyLabel?.wasDriver ?? submittedSurvey?.wasDriver ?? null;
      if (wasDriver) {
        try {
          const updatedTrip = await tripService.update(trip.id, {
            was_driver: wasDriver,
            passenger_trip: wasDriver === 'no',
            excluded_from_driver_score: wasDriver === 'no',
            updated_at: new Date().toISOString(),
          });
          if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
          invalidateTripLists();
        } catch {
          // The local calibration label remains authoritative for this detail view.
        }
      }
      const [marker, count] = await Promise.all([
        calibrationLabelService.getTripSurveyStatus(trip.id),
        calibrationLabelService.countLocalLabels(),
      ]);
      setCalibrationSurveyStatus(marker || {
        rating: record?.surveyLabel?.overallDriveRating ?? null,
        submitted_at: record?.createdAt ?? new Date().toISOString(),
      });
      setCalibrationLabelCount(count);
    },
  });
  const [dismissedTags, setDismissedTags] = useState([]);

  const confirmAndFetchRoadContext = async () => {
    const latestSettings = localSettings.get();
    if (!isRoadDataLookupConfigured(latestSettings)) {
      await requestAppAlert({
        title: 'Road data is off',
        message: buildRoadDataDisabledMessage(latestSettings),
      });
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Fetch road data?',
      message: buildRoadContextPrivacyMessage(latestSettings),
      confirmLabel: 'Fetch road data',
    });
    if (!confirmed) {
      return;
    }
    contextMutation.mutate();
  };
  const confirmAndFetchWeatherContext = async () => {
    const latestSettings = localSettings.get();
    if (!isWeatherContextLookupConfigured(latestSettings)) {
      await requestAppAlert({
        title: 'Weather lookup is off',
        message: buildWeatherContextPrivacyMessage(latestSettings),
      });
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Get weather?',
      message: buildWeatherContextPrivacyMessage(latestSettings),
      confirmLabel: 'Get weather',
    });
    if (!confirmed) return;
    weatherMutation.mutate();
  };
  const stops = useMemo(() => (
    trip ? detectTripStops(trip.route_points || []) : []
  ), [trip]);
  const parkStops = useMemo(() => (
    stops.filter((stop) => (stop.duration_seconds || 0) >= 5 * 60)
  ), [stops]);
  const splitPreviewTrips = useMemo(() => (
    trip && parkStops.length ? splitTripAtStops(trip, 5) : []
  ), [parkStops.length, trip]);
  const speedZoneSummary = useMemo(() => {
    if (!trip) return [];

    const points = trip.route_points || [];
    // Must use the same thresholds as buildSpeedLimitSourceBreakdown, or the
    // two halves of the speed-zone card describe different zone boundaries.
    const zones = inferSpeedZones(points, buildDrivingThresholds(settings));
    const zoneForIndex = createZoneLookup(zones);
    const byZone = new Map();
    for (let i = 1; i < points.length; i++) {
      const zone = zoneForIndex(i);
      if (!zone) continue;
      const segment = calculateSegmentMetrics(points[i - 1], points[i]);
      if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;
      const key = zone.inferredZone;
      const current = byZone.get(key) || {
        inferredZone: zone.inferredZone,
        inferredZoneKmh: zone.inferredZoneKmh,
        confidence: zone.confidence,
        distanceKm: 0,
      };
      current.distanceKm += segment.distanceKm;
      if (zone.confidence === 'high') current.confidence = 'high';
      else if (zone.confidence === 'medium' && current.confidence !== 'high') current.confidence = 'medium';
      byZone.set(key, current);
    }
    return [...byZone.values()].sort((a, b) => a.inferredZoneKmh - b.inferredZoneKmh);
  }, [trip, settings]);
  const fatigueHeatmapData = useMemo(() => (
    trip ? buildFatigueHeatmapData(trip) : []
  ), [trip]);
  const fatigueProgressionLevel = typeof trip?.fatigue_progression === 'object'
    ? trip.fatigue_progression.level
    : trip?.fatigue_progression;
  const routeRiskSegments = useMemo(() => (
    trip ? getSegmentsForTrip(trip, routeRiskIndex).filter((segment) => segment.riskLevel === 'high' || segment.riskLevel === 'moderate') : []
  ), [routeRiskIndex, trip]);
  const displayedRouteRiskSegments = showAllRouteRiskSegments
    ? routeRiskSegments
    : routeRiskSegments.slice(0, MAX_ROUTE_RISK_SEGMENTS_SHOWN);
  const hiddenRouteRiskSegmentCount = routeRiskSegments.length - displayedRouteRiskSegments.length;

  useEffect(() => {
    // Editing a privacy zone has to rebuild the risk index; leaving this on
    // mount-only kept scoring this open trip against the zones as they were
    // when the page was opened.
    let cancelled = false;
    loadRouteRiskIndex(privacyZones).then((index) => {
      if (!cancelled) setRouteRiskIndex(index);
    });
    return () => {
      cancelled = true;
    };
  }, [privacyZones]);

  useEffect(() => {
    let cancelled = false;
    getJson(DISMISSED_TAG_SUGGESTIONS_KEY, []).then((storedTags) => {
      if (cancelled) return;
      setDismissedTags(Array.isArray(storedTags) ? storedTags : []);
      setDismissedTagsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!trip) return;
    setShowAllRouteRiskSegments(false);
    setMetadataDraft({
      nickname: trip.nickname || '',
      notes: trip.notes || '',
      tags: normalizeTripTags(trip),
    });
  }, [trip]);

  useEffect(() => {
    if (!trip?.id) {
      setCalibrationSurveyStatus(null);
      setCalibrationLabelCount(null);
      return undefined;
    }

    let cancelled = false;
    Promise.all([
      calibrationLabelService.getTripSurveyStatus(trip.id),
      calibrationLabelService.countLocalLabels(),
    ]).then(([marker, count]) => {
      if (cancelled) return;
      setCalibrationSurveyStatus(marker);
      setCalibrationLabelCount(count);
    }).catch(() => {
      if (!cancelled) setCalibrationSurveyStatus(null);
    });
    return () => {
      cancelled = true;
    };
  }, [trip?.id]);

  useEffect(() => {
    // Depend on the trip id only, which is all this effect actually reads.
    if (!trip?.id || !isAndroid()) {
      setCurrentUsageAccessGranted(null);
      return undefined;
    }

    let cancelled = false;
    getAndroidUsageAccessStatus()
      .then((status) => {
        if (!cancelled) setCurrentUsageAccessGranted(status?.usageAccessGranted === true);
      })
      .catch(() => {
        if (!cancelled) setCurrentUsageAccessGranted(null);
      });

    return () => {
      cancelled = true;
    };
  }, [trip?.id]);

  useEffect(() => {
    if (!trip?.id || isLoading) return;
    const pointCount = Array.isArray(trip.route_points) ? trip.route_points.length : 0;
    const summaryOnly = trip.privacy_mode === 'summary_only';
    const expired = Boolean(trip.route_data_expired_at);
    const available = !summaryOnly && !expired && pointCount > 1;
    const reason = available
      ? 'available'
      : summaryOnly
        ? 'summary_only_private_trip'
        : expired
          ? 'route_data_expired'
          : 'insufficient_route_points';
    const key = `${trip.id}:${reason}:${pointCount}`;
    if (trip3dAvailabilityLogRef.current === key) return;
    trip3dAvailabilityLogRef.current = key;
    recordSystemEvent(
      available ? 'trip_3d_playback_available' : 'trip_3d_playback_unavailable',
      {
        trip_id: trip.id,
        reason,
        route_point_count: pointCount,
        route_data_expired: expired,
        summary_only_private_trip: summaryOnly,
      },
      {
        category: 'diagnostics',
        title: available ? '3D drive available' : '3D drive unavailable',
        severity: available ? 'info' : 'warn',
      }
    );
  }, [isLoading, trip?.id, trip?.privacy_mode, trip?.route_data_expired_at, trip?.route_points]);

  if (isLoading) {
    return (
      <div className="space-y-4 pb-4">
        <div className="h-8 bg-secondary/50 rounded-xl animate-pulse w-32" />
        <div className="h-64 bg-secondary/50 rounded-2xl animate-pulse" />
        <div className="h-32 bg-secondary/50 rounded-2xl animate-pulse" />
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertTriangle className="w-12 h-12 text-muted-foreground mb-4" />
        <div className="font-semibold">Trip not found</div>
        <button onClick={() => navigate('/trips')} className="mt-4 text-primary text-sm">
          Back to trips
        </button>
      </div>
    );
  }

  const tripVehicle = vehicles.find((vehicle) => String(vehicle.id) === String(trip.vehicle_id));
  const economics = estimateTripEconomics(trip, tripVehicle, settings);
  // calculateFatigueRisk is a multi-trip aggregate. Given a single trip it
  // reduces to a duration threshold and reads neither `segment_scores` nor
  // `fatigue_progression` - the very fields charted below it - so it is
  // labelled as the duration flag it actually is.
  const fatigueRisk = calculateFatigueRisk([trip], settings);
  const tripTags = normalizeTripTags(trip);
  const occupiedExclusiveTagCategories = new Set(tripTags
    .map((tag) => getTripTagOption(tag)?.category)
    .filter((category) => ['purpose', 'route'].includes(category)));
  const pendingTagCandidates = tagIntelligence.recommended.filter((candidate) => (
    !tripTags.includes(candidate.tag) &&
    (!['purpose', 'route'].includes(candidate.category) || !occupiedExclusiveTagCategories.has(candidate.category))
  ));
  const tagSuggestion = pendingTagCandidates[0] || null;
  const builtInTagIds = new Set(TRIP_TAG_OPTIONS.map((option) => option.id));
  const customTagOptions = metadataDraft.tags
    .filter((tag) => !builtInTagIds.has(tag))
    .map(getTripTagOption)
    .filter(Boolean);
  const tagEditorOptions = [...TRIP_TAG_OPTIONS, ...customTagOptions];
  const tripTitle = getTripDisplayName(trip);
  const premiumTripDetail = getPremiumTripDetailPresentation(trip, settings);
  const nightExplanation = getNightClassificationExplanation(trip);
  const showTagSuggestion = dismissedTagsLoaded && pendingTagCandidates.length > 0 &&
    trip.tag_reviewed !== true &&
    !dismissedTags.includes(String(trip.id));
  const toggleDraftTag = (tagId) => {
    setMetadataDraft((draft) => {
      const nextTags = draft.tags.includes(tagId)
        ? draft.tags.filter((item) => item !== tagId)
        : [...draft.tags, tagId];
      return { ...draft, tags: nextTags };
    });
  };
  const saveMetadata = () => {
    const tags = normalizeTripTags(metadataDraft.tags);
    const now = new Date().toISOString();
    const tagSources = Object.fromEntries(tags.map((tag) => [tag, {
      source: 'user_confirmed',
      confidence: 1,
      reason: 'Confirmed by you in the trip tag editor.',
      applied_at: now,
    }]));
    metadataMutation.mutate({
      nickname: metadataDraft.nickname.trim(),
      notes: metadataDraft.notes.trim(),
      tags,
      tag: tags[0] || null,
      tag_sources: tagSources,
      tag_reviewed: true,
      tag_intelligence_version: tagIntelligence.version,
    });
  };
  const dismissTagSuggestion = () => {
    const next = [...new Set([...dismissedTags, String(trip.id)])];
    setDismissedTags(next);
    setJson(DISMISSED_TAG_SUGGESTIONS_KEY, next).catch(() => {});
  };
  const openTagEditorWithSuggestion = () => {
    setEditingMetadata(true);
    setMetadataDraft((draft) => ({
      ...draft,
      tags: normalizeTripTags([...draft.tags, ...pendingTagCandidates.map((candidate) => candidate.tag)]),
    }));
    requestAnimationFrame(() => {
      metadataSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };
  const addCustomDraftTag = () => {
    const tag = normalizeTripTagId(customTagDraft);
    if (!tag) return;
    setMetadataDraft((draft) => ({
      ...draft,
      tags: normalizeTripTags([...draft.tags, tag]),
    }));
    setCustomTagDraft('');
  };
  const roadTypeMeasured = roadTypeWasMeasured(trip);
  const roadCfg = roadTypeMeasured ? roadTypeConfig[trip.road_type] : null;
  const dominantRoadCfg = roadTypeMeasured
    ? (roadTypeConfig[trip.dominant_road_type] || roadCfg)
    : null;
  const RoadIcon = roadCfg?.icon;
  const DominantRoadIcon = dominantRoadCfg?.icon;
  const roadTypeScores = [
    { key: 'highway', label: 'Highway', data: trip.highway_score },
    { key: 'urban', label: 'Urban', data: trip.urban_score },
    { key: 'residential', label: 'Residential', data: trip.residential_score },
  ].filter((item) => item.data && Number.isFinite(item.data.overall));
  const complianceRows = [
    { key: 'highway', label: 'Highway', data: trip.highway_compliance },
    { key: 'urban', label: 'Urban', data: trip.urban_compliance },
    { key: 'residential', label: 'Residential', data: trip.residential_compliance },
  ].filter((item) => item.data);
  const weatherContext = trip.weather_context || null;
  const weatherContextSource = String(weatherContext?.source || weatherContext?.provider || (
    !weatherContext && trip.slippery_proxy && trip.slippery_proxy !== 'insufficient_data'
      ? 'gps_inference'
      : 'unavailable'
  )).toLowerCase().replace(/-/g, '_');
  const weatherCondition = String(weatherContext?.condition || trip.slippery_proxy || '').replace(/_/g, ' ');
  const openMeteoWetCondition = ['rain', 'snow', 'storm', 'fog', 'freezing_precipitation'].includes(weatherContext?.condition);
  const weatherContextDisplayValue = weatherContextSource === 'open_meteo'
    ? openMeteoWetCondition
      ? 'Wet conditions likely (Open-Meteo API)'
      : `${weatherCondition || 'Weather checked'} (Open-Meteo API)`
    : weatherContextSource === 'user_confirmed'
      ? `${weatherCondition || 'Condition'} (confirmed by you)`
    : weatherContextSource === 'gps_inference'
      ? ['likely_wet', 'possible_wet'].includes(trip.slippery_proxy || weatherContext?.condition)
        ? 'Possible low-grip or cautious-braking pattern (GPS)'
        : trip.slippery_proxy === 'appears_dry' || weatherContext?.condition === 'appears_dry'
          ? 'No low-grip braking pattern detected (GPS)'
          : 'Weather unavailable'
      : 'Weather unavailable';
  const speedLimitContext = trip.speed_limit_context || null;
  const speedLimitLookupEnabled = settings.speed_limit_lookup_enabled !== false;
  const speedLimitSourceBreakdown = buildSpeedLimitSourceBreakdown(
    trip,
    settings,
    speedLimitContext,
    speedLimitLocalKnowledgeResults
  );
  const hasPostedSpeedLimitEvidence = speedLimitSourceBreakdown.rows.some((row) => (
    ['openstreetmap', 'user_confirmed_posted_sign'].includes(row.source)
  ));
  const onlyGpsInferredSpeedLimits = speedLimitSourceBreakdown.rows.length > 0 && speedLimitSourceBreakdown.rows.every((row) => (
    ['inferred', 'unknown'].includes(row.source)
  ));
  const speedLimitEstimateWarning = onlyGpsInferredSpeedLimits
    ? 'This entire compliance score is based on GPS-inferred limits. Enable auto-fetch in Settings, or tap Get Road Data for this trip, to use posted OpenStreetMap limits when available.'
    : 'No posted speed-limit source is available for this trip. Compliance uses the estimates shown above; check posted signs for school zones, construction zones, temporary limits, and local exceptions.';
  const mapMatchingContext = trip.map_matching_context || null;
  const mapMatchedViaPublicOsrmDemo = mapMatchingContext?.isOsrmDemoUrl === true &&
    ['matched', 'partial_matched', 'cache_hit'].includes(mapMatchingContext?.status);
  // The overlay renders from any point carrying a finite limit, so gating the
  // button on two specific sources greyed it out for trips whose limits came
  // from a regional default or learned local knowledge.
  const rawSpeedLimitPoints = (trip.route_points || []).filter((point) => (
    Number.isFinite(Number(point.speed_limit_kmh)) && Number(point.speed_limit_kmh) > 0
  ));
  const hasLocalSpeedLimitKnowledge = speedLimitLocalKnowledgeResults.some((item) => Number(item?.limitKmh) > 0);
  const hasSpeedLimitLayerData = rawSpeedLimitPoints.length > 0 || hasLocalSpeedLimitKnowledge;
  const effectiveSpeedLimits = [...new Set(
    speedLimitSourceBreakdown.rows
      .flatMap((row) => row.limits || [])
      .map(Number)
      .filter(Number.isFinite)
  )]
    .sort((a, b) => a - b);
  const speedLimitCoverage = (() => {
    const points = trip.route_points || [];
    const limitPoints = points.filter((point) => Number.isFinite(Number(point.speed_limit_kmh)));
    const posted = limitPoints.filter((point) => point.speed_limit_source === 'openstreetmap').length;
    const fallbackDefault = limitPoints.filter((point) => point.speed_limit_source === 'osm_highway_default').length;
    const mapDerived = posted + fallbackDefault;
    const inferred = limitPoints.filter((point) => point.speed_limit_source === 'inferred').length;
    const pct = (count) => points.length ? Math.round((count / points.length) * 100) : 0;
    return {
      postedPct: pct(posted),
      fallbackDefaultPct: pct(fallbackDefault),
      mapDerivedPct: pct(mapDerived),
      inferredPct: pct(inferred),
      sampleCount: points.length,
    };
  })();
  const osmCoveragePct = Number.isFinite(Number(speedLimitContext?.coverage))
    ? Number(speedLimitContext.coverage)
    : speedLimitCoverage.mapDerivedPct;
  const showLowSpeedLimitCoverageBanner = speedLimitLookupEnabled &&
    !hasLocalSpeedLimitKnowledge &&
    speedLimitCoverage.sampleCount > 0 &&
    osmCoveragePct < 20;
  const speedLimitDefaultCountries = [...new Set([
    speedLimitContext?.fallback_country,
    ...(trip.route_points || []).map((point) => point.fallback_country),
    ...(trip.route_points || []).map((point) => point.speed_limit_default_country),
    ...(trip.driving_events || []).map((event) => event.fallback_country),
    ...(trip.driving_events || []).map((event) => event.speed_limit_default_country),
  ].filter(Boolean))].map((country) => String(country).toUpperCase());
  const currentSpeedLimitFallbackCountry = speedLimitDefaultCountryKey(settings);
  const speedLimitDefaultCountryLabels = speedLimitDefaultCountries.map((country) => (
    SPEED_LIMIT_DEFAULT_COUNTRY_LABELS[String(country).toLowerCase()] || country
  ));
  const speedLimitDefaultCountryLabel = speedLimitDefaultCountryLabels.length
    ? speedLimitDefaultCountryLabels.join(', ')
    : SPEED_LIMIT_DEFAULT_COUNTRY_LABELS[currentSpeedLimitFallbackCountry] || 'Global';
  const speedLimitDefaultCountryText = speedLimitDefaultCountries.length
    ? ` Country estimate profile for missing OSM maxspeed tags: ${speedLimitDefaultCountries.join(', ')}.`
    : '';
  const legacySpeedLimitProvenanceSummary = [
    `${speedLimitCoverage.postedPct}% of this route used posted OpenStreetMap limits`,
    speedLimitCoverage.fallbackDefaultPct > 0
      ? `${speedLimitCoverage.fallbackDefaultPct}% used ${speedLimitDefaultCountryLabel} road-type estimates`
      : null,
    speedLimitCoverage.inferredPct > 0
      ? `${speedLimitCoverage.inferredPct}% used GPS-inferred limits`
      : null,
  ].filter(Boolean).join('; ') + ` (${speedLimitCoverage.sampleCount} samples).`;
  const speedLimitBreakdownIsFrozen = speedLimitSourceBreakdown.basis === 'scored';
  const speedLimitSampleBasisLabel = speedLimitBreakdownIsFrozen
    ? 'samples scored'
    : 'moving samples, recomputed now';
  const speedLimitProvenanceSummary = speedLimitSourceBreakdown.sampleCount
    ? `${speedLimitSourceBreakdown.summary} (${speedLimitSourceBreakdown.sampleCount} ${speedLimitSampleBasisLabel}).`
    : legacySpeedLimitProvenanceSummary;
  const speedLimitIntelligence = summarizeTripSpeedLimitIntelligence(
    trip,
    speedLimitLocalKnowledgeResults
  );
  const speedLimitReviewCount = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity }).length;
  // Derived once, from raw point counts, inside summarizeTripSpeedLimitIntelligence -
  // recomputing them here from already-rounded integers made the three tiles
  // sum to 99% or 101%.
  const estimatedCoveragePercent = speedLimitIntelligence.estimatedCoveragePercent;
  const missingCoveragePercent = speedLimitIntelligence.missingCoveragePercent;
  // These tiles are shares of every recorded route point, while scoring only
  // evaluated moving samples. Both are legitimate questions; the bug was that
  // neither said which it answered, so the same word meant two things on one
  // screen. Name the denominator, and name scoring's when it differs.
  const scoredSampleCount = isScoreInputsSnapshotUsable(trip?.score_inputs)
    ? Number(trip.score_inputs.scored_sample_count) || 0
    : null;
  const coverageBasisNote = [
    `Shares of ${speedLimitIntelligence.pointCount} recorded route points.`,
    scoredSampleCount != null && scoredSampleCount !== speedLimitIntelligence.pointCount
      ? `Scoring evaluated ${scoredSampleCount} moving samples.`
      : null,
  ].filter(Boolean).join(' ');
  const verifiedCoverageForChart = Math.max(
    0,
    Math.min(100, Number(speedLimitIntelligence.verifiedCoveragePercent) || 0)
  );
  const estimatedCoverageForChart = Math.max(
    0,
    Math.min(100 - verifiedCoverageForChart, Number(estimatedCoveragePercent) || 0)
  );
  const mappedCoverageForChart = verifiedCoverageForChart + estimatedCoverageForChart;
  const speedCoverageTone = verifiedCoverageForChart >= Math.max(estimatedCoverageForChart, 100 - mappedCoverageForChart)
    ? 'verified'
    : estimatedCoverageForChart >= 100 - mappedCoverageForChart
      ? 'estimated'
      : 'missing';
  const speedCoverageChartBackground = `conic-gradient(
    hsl(157 74% 43%) 0 ${verifiedCoverageForChart}%,
    hsl(39 96% 56%) ${verifiedCoverageForChart}% ${mappedCoverageForChart}%,
    hsl(215 20% 55%) ${mappedCoverageForChart}% 100%
  )`;
  const dataQualityFlags = Array.isArray(trip.data_quality_flags) ? trip.data_quality_flags : [];
  const hasLocationPermissionLoss = dataQualityFlags.includes('location_permission_loss') ||
    trip.score_confidence_flag === 'data_gap_detected' ||
    (trip.native_tracking_timeline || []).some((event) => event?.type === 'location_permission_lost');
  const sensorFusionSummary = trip.sensor_fusion_summary || null;
  const premiumTagArtwork = selectPremiumTripTagArtwork(tagSuggestion?.tag);
  const premiumWeatherArtwork = selectPremiumWeatherArtwork({
    condition: weatherContext?.condition || trip.slippery_proxy,
    displayValue: weatherContextDisplayValue,
    source: weatherContextSource,
  });
  const premiumSpeedArtwork = selectPremiumSpeedArtwork({
    coverage: osmCoveragePct,
    hasPostedEvidence: hasPostedSpeedLimitEvidence,
    lookupEnabled: speedLimitLookupEnabled,
    reviewNeeded: speedLimitReviewNeededForTrip(trip),
    status: speedLimitContext?.status,
  });
  const premiumSensorArtwork = selectPremiumSensorArtwork(sensorFusionSummary);
  const driverAnomaly = trip.driver_anomaly || null;
  const possibleIncidentEvents = (trip.driving_events || []).filter((event) => event.type === 'possible_crash');
  const displayPhoneUse = buildPhoneUseFromTripEvidence(trip, trip.route_points || [], trip.duration_seconds || 0, {});
  const livePhoneUsageAccessProvenance = buildPhoneUsageAccessProvenance(trip, currentUsageAccessGranted);
  const storedPhoneUsageAccessProvenance = trip.phone_usage_access_provenance?.changed
    ? trip.phone_usage_access_provenance
    : null;
  const phoneUsageAccessProvenance = livePhoneUsageAccessProvenance.changed
    ? livePhoneUsageAccessProvenance
    : storedPhoneUsageAccessProvenance;
  const componentScore = (key) => getTripComponentScore(trip, key);
  const brakeOnsetSequenceCount = Math.max(0, Number(trip.brake_onset_sequence_count) || 0);
  const brakeOnsetMinimumSequences = 2;
  const brakeOnsetCollectingDataText = componentScore('brake_onset_smoothness').value == null && brakeOnsetSequenceCount > 0
    ? `${brakeOnsetSequenceCount} of ${brakeOnsetMinimumSequences} qualifying brake events recorded`
    : null;
  const phoneUseWindows = displayPhoneUse.phone_use_events || [];
  const phoneUseInsights = summarizeTripPhoneUse(trip, {
    wasDriver: calibrationSurveyStatus?.wasDriver ?? calibrationSurveyStatus?.was_driver,
  });
  const phoneUseTimeline = phoneUseInsights.timeline || [];
  const phoneUseRisk = displayPhoneUse.phone_use_risk || trip.phone_use_risk || 'none';
  const hasPhoneUsageAccess = displayPhoneUse.phone_use_score_available === true;
  const phoneUsePermissionRequired = trip.phone_use_score_status === 'usage_access_required';
  const phoneUseVisualState = !hasPhoneUsageAccess || phoneUsePermissionRequired
    ? 'unmeasured'
    : phoneUseInsights.isPassenger
      ? 'passenger'
      : phoneUseRisk === 'none'
        ? 'safe'
        : 'risk';
  const premiumPhoneUseArtwork = phoneUseVisualState === 'safe'
    ? premiumTripPhoneSafe
    : phoneUseVisualState === 'risk'
      ? premiumTripPhoneRisk
      : premiumTripPhoneNeutral;
  const showPhoneUse = hasPhoneUsageAccess || phoneUseWindows.length > 0 || phoneUseRisk !== 'none' || phoneUsePermissionRequired;
  const phoneUseScoreForImpactRaw = displayPhoneUse.phone_use_score ?? trip.phone_use_score ?? null;
  const phoneUseScoreForImpact = Number.isFinite(Number(phoneUseScoreForImpactRaw)) ? Math.max(0, Math.min(100, Number(phoneUseScoreForImpactRaw))) : null;
  // Keep this estimate aligned with calculateTripScores' phoneUseScoreForSafety blend.
  const phoneUseSafetyImpactPoints = phoneUseScoreForImpact == null
    ? null
    : Math.max(1, Math.round(Math.max(0, 100 - phoneUseScoreForImpact) * PHONE_USE_SAFETY_WEIGHT));
  const avgPhoneUseSpeed = phoneUseWindows.length
    ? Math.round(phoneUseWindows.reduce((sum, event) => sum + (Number(event.speed_kmh) || 0), 0) / phoneUseWindows.length)
    : 0;
  const phoneUseRiskClass = {
    high: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/60',
    medium: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800/60',
    low: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60',
    none: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60',
  }[phoneUseRisk] || 'bg-secondary text-muted-foreground border-border';
  const premiumPhoneUseStatusLabel = phoneUseVisualState === 'unmeasured'
    ? 'unmeasured'
    : phoneUseVisualState === 'passenger'
      ? 'passenger'
      : phoneUseRisk;
  const premiumPhoneUseStatusClass = phoneUseVisualState === 'unmeasured'
    ? 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/70 dark:text-slate-200 dark:border-slate-700'
    : phoneUseVisualState === 'passenger'
      ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60'
      : phoneUseRiskClass;
  const phoneUseComparisonMax = Math.max(
    1,
    ...(phoneUseInsights.scoreComparison || []).map((row) => Number(row.referencePoints) || 0)
  );
  const laneChangeEvents = Array.isArray(trip.lane_change_events) ? trip.lane_change_events : [];
  const rawDrivingEvents = uniqueTripEvents([...(trip.driving_events || []), ...laneChangeEvents]);
  const displayEvents = mergePhoneUseEventsIntoDrivingEvents(rawDrivingEvents, displayPhoneUse)
    .filter((event) => event.type !== 'near_miss');
  const eventRows = displayEvents.map((event, index) => ({ event, originalIndex: index }));
  const phoneProxyDiagnosticRows = (displayPhoneUse.phone_proxy_events || [])
    .filter((event) => !displayEvents.some((candidate) => (
      candidate?.type === event?.type &&
      candidate?.timestamp === event?.timestamp &&
      candidate?.startTime === event?.startTime
    )))
    .map((event, index) => ({ event, originalIndex: `phone-proxy-${index}` }));
  const scoredEventRows = eventRows.filter(({ event }) => !isDiagnosticOnlyTripEvent(event));
  const diagnosticEventRows = [
    ...eventRows.filter(({ event }) => isDiagnosticOnlyTripEvent(event)),
    ...phoneProxyDiagnosticRows,
  ];
  const headingDeviationEventCount = Number.isFinite(Number(trip.heading_deviation_count))
    ? Number(trip.heading_deviation_count)
    : displayEvents.filter((event) => event.type === 'heading_deviation').length;
  const headingDeviationScoringEnabled = trip.heading_deviation_scoring_enabled != null
    ? trip.heading_deviation_scoring_enabled !== false
    : trip.heading_deviation_available !== false && settings.advanced_safety_detection_enabled !== false;
  const headingDeviationPrompt = headingDeviationScoringEnabled
    ? null
    : 'Enable Advanced Safety to include this in your score';
  const eventSummaryRows = [
    { label: 'Harsh Brakes', value: trip.harsh_brakes_count, icon: TrendingDown, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
    { label: 'Rapid Accel', value: trip.rapid_accel_count, icon: Zap, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
    { label: 'Sharp Turns', value: trip.sharp_turns_count, icon: CornerUpRight, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
    { label: 'Speeding', value: trip.speeding_events_count, icon: AlertTriangle, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
    { label: 'Heading Events (Beta)', value: headingDeviationEventCount, note: headingDeviationPrompt, icon: Shuffle, color: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800/50' },
    { label: 'Stop-Start Patterns', value: trip.stop_start_pattern_count ?? trip.tailgate_cycle_count, icon: ShieldCheck, color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
    { label: 'Erratic Speed', value: trip.distraction_events_count, icon: Focus, color: 'text-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950/30' },
  ];
  const showDrivingEventsPanel = Boolean(trip);
  const eventFeedback = trip.event_feedback || {};
  const feedbackCounts = Object.values(eventFeedback).reduce((counts, item) => {
    if (item?.verdict === 'accurate') counts.accurate += 1;
    if (item?.verdict === 'wrong') counts.wrong += 1;
    return counts;
  }, { accurate: 0, wrong: 0 });
  const mapDisplayEvents = displayEvents.filter((event) => !isGpsPhoneUseProxyEvent(event));
  const mapEvents = settings.phone_use_show_on_map === false
    ? mapDisplayEvents.filter((event) => event.type !== 'phone_use')
    : mapDisplayEvents;
  const fatigueChartData = Array.isArray(trip.segment_scores) && trip.segment_scores.length === 3
    ? [
      { label: 'First', score: trip.segment_scores[0] },
      { label: 'Middle', score: trip.segment_scores[1] },
      { label: 'Last', score: trip.segment_scores[2] },
    ]
    : [];
  const fatigueColor = fatigueProgressionLevel === 'significant'
    ? '#ef4444'
    : fatigueProgressionLevel === 'moderate'
      ? '#f59e0b'
      : '#22c55e';
  const primaryAvgSpeedKmh = trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0;
  // FIX: Use moving average speed as the primary Avg Speed metric.
  const estimatedPrivateDistanceKm = Math.max(0, Number(trip.estimated_private_distance_km) || 0);
  const dpAggregateNote = trip._dpApplied
    ? '~ Statistics are privacy-estimated for trips near protected zones'
    : null;
  const showOverallAvgSpeed = (trip.idle_time_seconds || 0) > 60;
  // FIX: Show overall average only when there was meaningful stopped time.
  const trafficIdleSeconds = trip.traffic_idle_seconds ?? Math.max(0, (trip.idle_time_seconds || 0) - (trip.sustained_idle_seconds || 0));
  const parkedIdleEstimated = trip.sustained_idle_seconds == null;
  const parkedIdleSeconds = trip.sustained_idle_seconds ?? Math.max(0, (trip.idle_time_seconds || 0) - trafficIdleSeconds);
  const terminalParkedSeconds = trip.parking_stop_duration_seconds || 0;
  const unavailableEstimate = 'Unavailable';
  const fuelSavedValue = economics.fuel_saved_available && Number.isFinite(Number(economics.fuel_saved_liters))
    ? `${Number(economics.fuel_saved_liters).toFixed(2)} L`
    : unavailableEstimate;
  const co2SavedValue = Number.isFinite(Number(economics.co2_saved_kg))
    ? `${economics.co2_saved_kg} kg`
    : unavailableEstimate;
  const fuelCostAssumptions = economics.vehicle_profile_available
    ? `Estimated from ${economics.actual_l_per_100km} L/100km and ${formatCurrencyAmount(economics.fuel_price_per_liter, settings)}/L.`
    : `${economics.estimate_label} Assign a vehicle to replace default fuel assumptions.`;
  const tripEndState = trip.parking_stop_detected
    ? 'Parked'
    : terminalParkedSeconds > 0
      ? 'Stopped'
      : 'Ended while moving';
  const tripMapPointCount = trip.route_points?.length || 0;
  const summaryOnlyPrivateTrip = trip.privacy_mode === 'summary_only';
  const tripRawPointCount = Number(trip.route_points_raw_count) || tripMapPointCount;
  const routeDataExpired = Boolean(trip.route_data_expired_at);
  const showTrip3DPage = !summaryOnlyPrivateTrip && !routeDataExpired && tripMapPointCount > 1;
  const tripPointSummary = summaryOnlyPrivateTrip
    ? 'No GPS coordinates were stored for this private trip'
    : routeDataExpired
    ? `Route data expired after ${trip.route_data_retention_days || 'the configured retention period'} days`
    : tripRawPointCount !== tripMapPointCount
    ? `${tripRawPointCount} recorded GPS readings - ${tripMapPointCount} map/playback points`
    : `${tripMapPointCount} GPS readings`;
  const speedLimitLayerEffect = hasSpeedLimitLayerData
    ? 'The speed-limit layer recolors this route using available OSM limits and any local saved limits: green is within the limit, orange is over, red is well over.'
    : !speedLimitLookupEnabled
      ? 'Speed-limit lookup is off in Settings. Get Road Data can still run other enabled lookups, but it will not add OpenStreetMap speed limits.'
    : speedLimitContext?.status === 'unavailable'
      ? speedLimitContext.error || 'The OSM speed-limit lookup failed, so this map is still using GPS speed bands and fallback scoring thresholds.'
    : speedLimitContext
      ? 'Road data was checked, but no usable speed limits are available for this trip, so the speed-limit layer cannot visibly change the map yet.'
      : 'Before getting road data, this map shows GPS speed bands and event markers only.';
  const speedReviewRows = [
    {
      // "Trusted" here counts plain OpenStreetMap maxspeed tags as well as
      // limits the driver confirmed. Say which is which rather than implying
      // the driver verified all of it.
      label: 'Trusted coverage',
      value: `${speedLimitIntelligence.verifiedCoveragePercent}%`,
      detail: speedLimitIntelligence.userConfirmedCoveragePercent > 0
        ? `${speedLimitIntelligence.userConfirmedCoveragePercent}% confirmed by you, ${speedLimitIntelligence.mappedCoveragePercent}% mapped in OpenStreetMap`
        : 'Mapped in OpenStreetMap; none confirmed by you yet',
    },
    {
      label: 'Estimated coverage',
      value: `${estimatedCoveragePercent}%`,
      detail: 'Used cautiously until confirmed',
    },
    {
      label: 'Needs review',
      value: speedLimitReviewCount,
      detail: speedLimitReviewCount > 0 ? 'Road sections awaiting a decision' : 'No unresolved road sections',
    },
    {
      label: 'Speed score',
      value: formatScoreWithProvenance(
        componentScore('speed_limit_compliance').value,
        trip.score_provenance,
        { empty: 'Learning' }
      ),
      detail: 'Recalculates after confirmed changes',
    },
  ];
  const renderEventFeedbackControls = (evt, key, feedback, { diagnostic = false } = {}) => {
    if (diagnostic) {
      return (
        <span className="rounded-full border border-border bg-secondary/50 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
          Diagnostic only — not scored
        </span>
      );
    }

    const scoreAffecting = SCORE_AFFECTING_EVENT_FEEDBACK_TYPES.has(evt?.type);
    const options = evt?.type === 'phone_use'
      ? [
        { id: 'accurate', label: 'Driver activity', className: 'border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300' },
        { id: 'wrong', label: 'Not driver use', className: 'border-red-200 text-red-700 dark:border-red-900/60 dark:text-red-300' },
      ]
      : scoreAffecting
        ? [
        { id: 'accurate', label: 'Accurate', className: 'border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300' },
        { id: 'wrong', label: 'Wrong', className: 'border-red-200 text-red-700 dark:border-red-900/60 dark:text-red-300' },
        ]
        : [
        { id: 'accurate', label: 'Looks right', className: 'border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300' },
        { id: 'wrong', label: 'Flag', className: 'border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-300' },
        ];

    return (
      <>
        {!scoreAffecting && (
          <span className="text-[11px] text-muted-foreground" title="Saved as a detection note; this event type does not change scoring.">
            Detection note
          </span>
        )}
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={feedbackMutation.isPending}
            aria-pressed={feedback === option.id}
            title={feedback === option.id
              ? 'Tap again to clear this review.'
              : scoreAffecting
                ? evt?.type === 'phone_use'
                  ? 'Confirm whether this foreground activity represented driver phone use. Rejected windows are removed when the trip is re-scored.'
                  : 'Apply this review and re-score the trip now.'
                : 'Save a detection note without changing the score.'}
            onClick={() => feedbackMutation.mutate({
              eventKey: key,
              event: evt,
              // Re-tapping the active verdict clears it. Previously it always
              // re-sent the same verdict, firing a second full rescore with no
              // way to undo a review at all.
              verdict: feedback === option.id ? null : option.id,
              scoreAffecting,
            })}
            className={'rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50 ' + (
              feedback === option.id
                ? option.className + ' bg-background'
                : 'border-border text-muted-foreground hover:bg-secondary'
            )}
          >
            {option.label}
          </button>
        ))}
      </>
    );
  };

  const renderEventRow = ({ event: evt, originalIndex }, { diagnostic = false } = {}) => {
    const key = eventFeedbackKey(evt, originalIndex);
    const feedback = eventFeedback[key]?.verdict || null;
    const cfg = eventDisplayConfig(evt, isGpsPhoneUseProxyEvent(evt));
    const timeText = evt.timestamp || evt.startTime
      ? new Date(evt.timestamp || evt.startTime).toLocaleTimeString()
      : 'Time unknown';
    // Every non-special event used to be suffixed "m/s²", including sharp
    // turns (lateral g), heading deviations (°/s) and stop-start patterns
    // (a speed drop). formatEventValue keys the unit off the event type.
    const eventValueText = evt.type === 'possible_crash'
      ? `${formatSpeedMeasured(evt.speed_before_kmh, units)} before - ${formatMeasured(evt.peak_linear_ms2, (value) => `${value.toFixed(1)} m/s²`)} peak`
      : evt.type === 'phone_use'
        ? `${Math.round(evt.durationS ?? evt.duration_seconds ?? 0)}s at ${formatSpeedMeasured(evt.speed_kmh, units)}`
        : evt.type === 'lane_change_detected'
          ? `${formatSpeedMeasured(evt.speed_kmh, units)}${Number.isFinite(Number(evt.lateral_g)) ? ` - ${Number(evt.lateral_g).toFixed(2)} g lateral` : ''}`
          : formatEventValue(evt, units) ?? 'No magnitude recorded';
    const inferredTypes = ['lane_change_detected', 'tailgate_cycle', 'stop_start_pattern', 'erratic_speed', 'phone_use'];
    const confidenceText = evt.source === 'android_usage_access'
      ? 'Measured phone activity'
          : evt.type === 'speeding' && evt.speed_limit_source
        ? evt.speed_limit_source === 'inferred'
          ? 'Inferred limit - may not reflect actual limit; half-weight score penalty'
          : evt.speed_limit_source === 'osm_highway_default'
            ? `Estimated from OSM road type${evt.speed_limit_default_country ? ` (${String(evt.speed_limit_default_country).toUpperCase()} profile)` : ''}; not proof of the posted speed limit, check posted signs`
            : evt.speed_limit_source === 'region_default_estimate'
              ? 'Regional default estimate - more reliable than GPS-only inference, but still an estimate unless confirmed by posted data'
            : `Limit from ${String(evt.speed_limit_source).replace(/_/g, ' ')}`
        : diagnostic
          ? 'Diagnostic GPS inference - not scored'
          : inferredTypes.includes(evt.type)
            // Never invent 'medium'. A numeric confidence (phone-use writes
            // 0.92) is mapped to a word; an absent one says so.
            ? (() => {
              const level = formatConfidence(evt.confidence ?? evt.confidence_level ?? evt.zone_confidence);
              return level
                ? `${level} confidence GPS inference`
                : 'GPS inference - confidence not recorded';
            })()
            : 'Measured from GPS motion';
    const diagnosticExplanation = diagnostic ? diagnosticExplanationForEvent(evt) : null;
    const severityLabel = evt.severity || evt.confidence_level ||
      (diagnostic ? 'diagnostic' : 'unrated');
    return (
      <div key={`${evt.type}-${evt.timestamp || evt.startTime || originalIndex}`} className="flex flex-col gap-2 py-2 border-b border-border/50 last:border-0 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">{cfg.icon}</span>
          <div>
            <div className={`text-sm font-medium ${cfg.color}`}>{cfg.label}</div>
            <div className="text-xs text-muted-foreground">
              {timeText} - {eventValueText}
            </div>
            {cfg.badge && (
              <div className="mt-0.5 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">{cfg.badge}</div>
            )}
            <div className="mt-0.5 text-[11px] text-muted-foreground">{confidenceText}</div>
            {diagnosticExplanation && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">{diagnosticExplanation}</div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-8 sm:pl-0">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize
            ${evt.severity === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400' :
              evt.severity === 'medium' ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400' :
              'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400'}`}>
            {severityLabel}
          </span>
          {renderEventFeedbackControls(evt, key, feedback, { diagnostic })}
        </div>
      </div>
    );
  };

  return (
    <div className={`trip-detail-page space-y-5 pb-4${premiumVisuals ? ' premium-trip-detail-on' : ''}`}>
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="trip-detail-actions space-y-2">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate('/trips')}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-transparent px-1 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back</span>
          </button>
          <div className="inline-flex items-center gap-1">
            <button
              onClick={() => metadataMutation.mutate({ is_favorite: trip.is_favorite !== true })}
              disabled={metadataMutation.isPending}
              aria-busy={metadataMutation.isPending || undefined}
              aria-label={trip.is_favorite ? 'Remove trip from favorites' : 'Add trip to favorites'}
              title={trip.is_favorite ? 'Remove favorite' : 'Favorite trip'}
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                trip.is_favorite ? 'bg-amber-500/15 text-amber-400' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              <Star className={`h-4 w-4 ${trip.is_favorite ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              aria-label="Delete trip"
              title="Delete trip"
              disabled={deleteMutation.isPending}
              aria-busy={deleteMutation.isPending || undefined}
              onClick={async () => {
                const confirmed = await requestAppConfirm({
                  title: 'Delete trip?',
                  message: 'Delete this trip? This cannot be undone.',
                  confirmLabel: 'Delete trip',
                  destructive: true,
                });
                if (confirmed) deleteMutation.mutate();
              }}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-progress disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {parkStops.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
                  <Shuffle className="h-4 w-4" />
                  Split Trip
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Split into separate trips?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Road Sage found {parkStops.length} parked stop{parkStops.length === 1 ? '' : 's'} of 5 minutes or longer. The original trip will be replaced by these segments.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-2">
                  {splitPreviewTrips.map((subTrip, index) => (
                    <div key={`${subTrip.start_time}-${index}`} className="rounded-xl border border-border bg-secondary/50 p-3 text-sm">
                      <div className="font-semibold">Trip {index + 1}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {formatDateTime(subTrip.start_time)} to {formatDateTime(subTrip.end_time)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {formatDistance(subTrip.distance_km || 0, units)} · {formatDuration(subTrip.duration_seconds || 0)}
                      </div>
                    </div>
                  ))}
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={splitMutation.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={splitMutation.isPending || splitPreviewTrips.length < 2}
                    onClick={() => splitMutation.mutate({ sourceTrip: trip })}
                  >
                    {splitMutation.isPending ? 'Splitting...' : 'Split Trip'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {showSpeedLimitReviewButton && (
            <button
              type="button"
              onClick={toggleSpeedLimitReview}
              className={`inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 min-[360px]:flex-none ${
                reviewSpeedLimitConflicts
                  ? 'bg-amber-600 text-white hover:bg-amber-700'
                  : 'border border-amber-500/35 bg-amber-500/10 text-amber-950 hover:bg-amber-500/15 dark:text-amber-100'
              }`}
            >
              <Gauge className="h-4 w-4" />
              {reviewSpeedLimitConflicts ? 'Hide speed review' : (
                speedLimitReviewNeededForTrip(trip) ? 'Review speed limits' : 'Check speed limits'
              )}
            </button>
          )}
          {showTrip3DPage && (
            <Link
              to={`/trips/${encodeURIComponent(String(id))}/3d`}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 min-[360px]:flex-none"
            >
              <Car className="h-4 w-4" />
              3D replay
            </Link>
          )}
        </div>
      </motion.div>

      {showTagSuggestion && (
        premiumVisuals ? (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
            <PremiumTripContextCard
              accent="blue"
              artwork={premiumTagArtwork}
              ariaLabel={`Suggested tags: ${pendingTagCandidates.map((candidate) => candidate.label).join(', ')}`}
              className="premium-trip-tag-card"
              eyebrow="Trip identity"
              icon={Tag}
              status={`${tagSuggestion.confidence_label} confidence`}
              title={pendingTagCandidates.length > 1
                ? `${tagSuggestion.label} +${pendingTagCandidates.length - 1}`
                : tagSuggestion.label}
            >
              <p className="premium-trip-context-summary">
                {tagSuggestion.reason}
              </p>
              <div className="premium-trip-context-actions">
                <button
                  type="button"
                  onClick={() => tagMutation.mutate(pendingTagCandidates.map((candidate) => candidate.tag))}
                  disabled={tagMutation.isPending}
                  className="premium-trip-context-primary"
                >
                  {tagMutation.isPending ? 'Saving' : `Accept ${pendingTagCandidates.length > 1 ? 'suggestions' : 'suggestion'}`}
                </button>
                <button
                  type="button"
                  onClick={openTagEditorWithSuggestion}
                  className="premium-trip-context-secondary"
                >
                  Change
                </button>
                <button
                  type="button"
                  onClick={dismissTagSuggestion}
                  className="premium-trip-context-dismiss"
                >
                  Dismiss
                </button>
              </div>
            </PremiumTripContextCard>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-primary/5 border border-primary/20 rounded-2xl p-3 flex items-center gap-3"
          >
            <Tag className="w-4 h-4 text-primary" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                Suggested: {pendingTagCandidates.map((candidate) => candidate.label).join(', ')}
              </div>
              <div className="text-xs text-muted-foreground">
                {tagSuggestion.reason} <span className="capitalize">({tagSuggestion.confidence_label} confidence)</span>
              </div>
            </div>
            <button
              onClick={() => tagMutation.mutate(pendingTagCandidates.map((candidate) => candidate.tag))}
              disabled={tagMutation.isPending}
              className="px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold"
            >
              {tagMutation.isPending ? 'Saving' : 'Accept'}
            </button>
            <button
              onClick={openTagEditorWithSuggestion}
              className="px-2.5 py-1.5 rounded-lg bg-secondary text-xs font-semibold"
            >
              Change
            </button>
            <button onClick={dismissTagSuggestion} className="px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground">
              Dismiss
            </button>
          </motion.div>
        )
      )}

      {(trip.close_proximity_count ?? 0) > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300">
          {trip.close_proximity_count} estimated brake-turn manoeuvre alert{trip.close_proximity_count === 1 ? '' : 's'} on this trip. GPS alone cannot establish object proximity or an avoided collision. This advisory does not affect your trip Safety or Overall score.
        </div>
      )}

      {possibleIncidentEvents.length > 0 && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Possible incident signal recorded
          </div>
          <div className="mt-1 text-xs">
            Impact-like motion and low movement were recorded. Road Sage cannot confirm that a crash occurred. {trip.emergency_workflow_acknowledged_at ? `Emergency check-in was acknowledged (${trip.emergency_workflow_acknowledged_action || 'ok'}).` : possibleIncidentEvents.some((event) => event.emergency_workflow_pending) ? 'Emergency check-in was active for this trip.' : 'Review the trip timeline and notes while the details are fresh.'}
          </div>
        </div>
      )}

      {['possible', 'likely'].includes(trip.phone_proxy_risk) && (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm font-medium text-yellow-700 dark:border-yellow-800/50 dark:bg-yellow-950/30 dark:text-yellow-300">
          GPS phone-use proxy diagnostic: {trip.phone_proxy_count || 0} micro-steering pattern{(trip.phone_proxy_count || 0) === 1 ? '' : 's'} recorded. This is not phone-use evidence and does not affect scores.
        </div>
      )}

      {mapMatchedViaPublicOsrmDemo && (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <Route className="h-4 w-4" />
          <span>Road-matched via public OSRM demo</span>
        </div>
      )}

      {(trip.overtake_event_count || 0) > 0 && (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-3 text-sm font-medium text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300">
          Overtake pattern (Beta): {trip.overtake_event_count} GPS pattern{trip.overtake_event_count === 1 ? '' : 's'} recorded for diagnostics only. It does not affect scores or coaching.
        </div>
      )}

      {phoneUsePermissionRequired && <PhoneUsePermissionBanner />}

      {phoneUsageAccessProvenance?.changed && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm font-medium text-blue-700 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-300">
          {phoneUsageAccessProvenance.note}
        </div>
      )}

      {premiumVisuals ? (
        <PremiumTripContextCard
          accent={weatherContextSource === 'unavailable' ? 'sky' : weatherContextDisplayValue.includes('Dry') ? 'emerald' : 'sky'}
          artwork={premiumWeatherArtwork}
          ariaLabel={`Weather Context: ${weatherContextDisplayValue}`}
          className="premium-trip-weather-card"
          eyebrow="Road conditions"
          icon={Droplets}
          status={weatherContextSource === 'open_meteo' ? 'Open-Meteo' : weatherContextSource === 'user_confirmed' ? 'You confirmed' : weatherContextSource === 'gps_inference' ? 'GPS pattern' : 'Unavailable'}
          title="Weather Context"
        >
          <p className="premium-trip-context-summary">{weatherContextDisplayValue}</p>
          {(weatherContext?.avg_temp_c != null ||
            weatherContext?.precipitation_mm != null ||
            weatherContext?.max_wind_gust_kmh != null ||
            weatherContext?.min_visibility_m != null) && (
            <div className="premium-trip-context-metrics">
              {weatherContext.avg_temp_c != null && (
                <span><strong>{weatherContext.avg_temp_c}°C</strong> Average temperature</span>
              )}
              {weatherContext.precipitation_mm != null && (
                <span><strong>{weatherContext.precipitation_mm} mm</strong> Precipitation</span>
              )}
              {weatherContext.max_wind_gust_kmh != null && (
                <span><strong>{formatSpeed(weatherContext.max_wind_gust_kmh, units)}</strong> Peak gust</span>
              )}
              {weatherContext.min_visibility_m != null && (
                <span><strong>{weatherContext.min_visibility_m} m</strong> Minimum visibility</span>
              )}
            </div>
          )}
          {(trip.safety_condition_bonus || 0) > 0 && weatherContextSource === 'gps_inference' && (
            <span className="premium-trip-context-bonus">
              +{trip.safety_condition_bonus} safety context
            </span>
          )}
        </PremiumTripContextCard>
      ) : (
        <div
          title="Weather context is sourced from Open-Meteo when available, otherwise from GPS stopping-distance patterns when enough evidence exists."
          className="flex items-center gap-2 rounded-2xl border border-border bg-card p-3 text-sm font-medium"
        >
          <Droplets className={`h-4 w-4 ${weatherContextSource === 'unavailable' ? 'text-muted-foreground' : weatherContextDisplayValue.includes('Dry') ? 'text-emerald-500' : 'text-sky-500'}`} />
          <span>Weather Context: {weatherContextDisplayValue}</span>
          {(trip.safety_condition_bonus || 0) > 0 && weatherContextSource === 'gps_inference' && (
            <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              +{trip.safety_condition_bonus} safety context
            </span>
          )}
        </div>
      )}

      {(weatherContext || speedLimitContext || mapMatchingContext || sensorFusionSummary || driverAnomaly) && (
        <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2${premiumVisuals ? ' premium-trip-context-grid' : ''}`}>
          {weatherContext && (
            premiumVisuals ? (
              <PremiumTripContextCard
                accent={weatherContextDisplayValue.includes('Dry') ? 'emerald' : 'sky'}
                artwork={premiumWeatherArtwork}
                ariaLabel={`Detailed Weather Context, ${weatherContext.riskLevel ? `${weatherContext.riskLevel} risk` : 'risk unavailable'}`}
                className="premium-trip-weather-detail"
                eyebrow="Weather evidence"
                icon={Droplets}
                status={weatherContext.riskLevel ? `${weatherContext.riskLevel} risk` : 'Risk unavailable'}
                title="Conditions"
              >
                <p className="premium-trip-context-summary">
                  {weatherContextDisplayValue}
                </p>
                {(weatherContext.avg_temp_c != null || weatherContext.precipitation_mm != null) && (
                  <div className="premium-trip-context-inline-facts">
                    {weatherContext.avg_temp_c != null && <span>{weatherContext.avg_temp_c}°C</span>}
                    {weatherContext.precipitation_mm != null && <span>{weatherContext.precipitation_mm} mm precip</span>}
                  </div>
                )}
                {trip.weather_score_adjustment < 0 && (
                  <p className="premium-trip-context-alert">
                    Score adjusted {trip.weather_score_adjustment} for harsh events in poor conditions.
                    This is a fixed provisional penalty applied after scoring, not a measured effect of the weather.
                  </p>
                )}
              </PremiumTripContextCard>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    <Droplets className="h-4 w-4 text-sky-500" />
                    Weather Context
                  </div>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize">
                    {weatherContext.riskLevel ? `${weatherContext.riskLevel} risk` : 'risk unavailable'}
                  </span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {weatherContextDisplayValue}
                  {weatherContext.avg_temp_c != null ? ` · ${weatherContext.avg_temp_c}°C` : ''}
                  {weatherContext.precipitation_mm ? ` · ${weatherContext.precipitation_mm} mm precip` : ''}
                </div>
                {trip.weather_score_adjustment < 0 && (
                  <div className="mt-2 text-xs font-semibold text-orange-600 dark:text-orange-300">
                    Score adjusted {trip.weather_score_adjustment} for harsh events in poor conditions.
                    This is a fixed provisional penalty applied after scoring, not a measured effect of the weather.
                  </div>
                )}
              </div>
            )
          )}
          {speedLimitContext && (
            premiumVisuals ? (
              <PremiumTripContextCard
                accent="emerald"
                artwork={premiumSpeedArtwork}
                ariaLabel={`Speed limits, ${speedLimitContext.status?.replace(/_/g, ' ') || 'unknown'}, ${osmCoveragePct}% map coverage`}
                className="premium-trip-speed-card"
                eyebrow="Route intelligence"
                icon={Gauge}
                status={speedLimitContext.status?.replace(/_/g, ' ') || 'Unknown'}
                title="Speed limits"
              >
                <div
                  className="premium-trip-context-progress"
                  role="progressbar"
                  aria-label="Mapped speed-limit coverage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.max(0, Math.min(100, Math.round(osmCoveragePct)))}
                >
                  <div>
                    {/* Named for its source, not "coverage": this is the OSM
                        fetch result and excludes limits confirmed since, while
                        the coverage card below counts every known limit. */}
                    <span>Mapped by OpenStreetMap</span>
                    <strong>{Math.max(0, Math.min(100, Math.round(osmCoveragePct)))}%</strong>
                  </div>
                  <span aria-hidden="true">
                    <i style={{ width: `${Math.max(0, Math.min(100, osmCoveragePct))}%` }} />
                  </span>
                </div>
                <p className="premium-trip-context-summary">
                  {describeOsmSpeedLimitStatus(speedLimitContext)}
                </p>
                <p className="premium-trip-context-detail">
                  {effectiveSpeedLimits.length
                    ? `Effective posted/estimated values: ${effectiveSpeedLimits.map((value) => formatSpeed(value, units)).join(', ')}.`
                    : 'GPS fallback thresholds fill gaps.'}
                </p>
                {speedLimitContext.error && (
                  <p className="premium-trip-context-alert">{speedLimitContext.error}</p>
                )}
              </PremiumTripContextCard>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    <Gauge className="h-4 w-4 text-emerald-500" />
                    Speed limits
                  </div>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize">
                    {speedLimitContext.status?.replace(/_/g, ' ') || 'unknown'}
                  </span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {describeOsmSpeedLimitStatus(speedLimitContext)} {effectiveSpeedLimits.length ? `Effective posted/estimated values: ${effectiveSpeedLimits.map((value) => formatSpeed(value, units)).join(', ')}.` : 'GPS fallback thresholds fill gaps.'}
                </div>
                {speedLimitContext.error && (
                  <div className="mt-1 text-xs text-orange-600 dark:text-orange-300">{speedLimitContext.error}</div>
                )}
              </div>
            )
          )}
          {mapMatchingContext && (
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold">
                  <Route className="h-4 w-4 text-blue-500" />
                  Map matching
                </div>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize">
                  {mapMatchingContext.status?.replace(/_/g, ' ') || 'unknown'}
                </span>
              </div>
              {mapMatchedViaPublicOsrmDemo && (
                <div className="mt-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  Road-matched via public OSRM demo
                </div>
              )}
              <div className="mt-2 text-xs text-muted-foreground">
                {describeMapMatchingStatus(mapMatchingContext)}
              </div>
            </div>
          )}
          {sensorFusionSummary && (
            premiumVisuals ? (
              <PremiumTripContextCard
                accent="violet"
                artwork={premiumSensorArtwork}
                ariaLabel={`Sensor fusion, ${sensorFusionSummary.quality || 'partial'}, ${sensorFusionSummary.sample_count || 0} motion samples`}
                className="premium-trip-sensor-card"
                eyebrow="Motion evidence"
                icon={Smartphone}
                status={sensorFusionSummary.quality || 'Partial'}
                title="Sensor fusion"
              >
                <div className="premium-trip-context-metrics">
                  <span>
                    <strong>{sensorFusionSummary.sample_count || 0}</strong>
                    Motion samples
                  </span>
                  <span>
                    <strong>{formatMeasured(sensorFusionSummary.peak_linear_ms2, (value) => `${value.toFixed(1)} m/s²`)}</strong>
                    Peak motion
                  </span>
                  <span>
                    <strong>{formatMeasured(sensorFusionSummary.phone_movement_score, (value) => `${Math.round(value)}/100`)}</strong>
                    Phone movement
                  </span>
                </div>
              </PremiumTripContextCard>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    <Smartphone className="h-4 w-4 text-violet-500" />
                    Sensor fusion
                  </div>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize">
                    {sensorFusionSummary.quality || 'partial'}
                  </span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {sensorFusionSummary.sample_count > 0
                    ? `${sensorFusionSummary.sample_count} motion samples · peak ${formatMeasured(sensorFusionSummary.peak_linear_ms2, (value) => `${value.toFixed(1)} m/s²`)} · phone movement ${formatMeasured(sensorFusionSummary.phone_movement_score, (value) => `${Math.round(value)}/100`)}.`
                    : 'No motion samples were recorded for this trip, so phone movement was not measured.'}
                </div>
              </div>
            )
          )}
          {driverAnomaly && (
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold">
                  <ShieldCheck className="h-4 w-4 text-emerald-500" />
                  Driver signature
                </div>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize">
                  {driverAnomaly.anomaly_level || 'unknown'}
                </span>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Anomaly score {formatEstimatedScore(driverAnomaly.anomaly_score ?? 0)}/100
                {driverAnomaly.reasons?.length ? ` · ${driverAnomaly.reasons.join(', ').replace(/_/g, ' ')}` : ''}
              </div>
            </div>
          )}
        </div>
      )}

      {showPhoneUse && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          data-phone-risk={premiumVisuals ? phoneUseRisk : undefined}
          data-phone-state={premiumVisuals ? phoneUseVisualState : undefined}
          className={premiumVisuals
            ? 'premium-phone-use-card bg-card border border-border rounded-3xl p-5 shadow-sm'
            : 'bg-card border border-border rounded-3xl p-5 shadow-sm'}
        >
          {premiumVisuals && (
            <>
              <img loading="lazy"
                className="premium-phone-use-art"
                src={premiumPhoneUseArtwork}
                alt=""
                aria-hidden="true"
              />
            </>
          )}
          <div className={premiumVisuals
            ? 'premium-phone-use-header flex items-start justify-between gap-3'
            : 'flex items-start justify-between gap-3'}
          >
            <div>
              <h2 className="font-semibold">Phone Use Analysis</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Android foreground-app evidence overlapping movement. It cannot prove who handled or looked at the phone; GPS proxy diagnostics are excluded.
              </p>
            </div>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${
              premiumVisuals ? premiumPhoneUseStatusClass : phoneUseRiskClass
            }`}>
              {premiumVisuals ? premiumPhoneUseStatusLabel : phoneUseRisk}
            </span>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-secondary/40 p-3">
              <div className="text-xs text-muted-foreground">Evidence coverage</div>
              <div className="mt-1 text-sm font-semibold capitalize">
                {phoneUseInsights.dataQuality.replace(/_/g, ' ')}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-secondary/40 p-3">
              <div className="text-xs text-muted-foreground">Detection source</div>
              <div className="mt-1 text-sm font-semibold">
                {hasPhoneUsageAccess ? 'Android Usage Access' : 'Not measured'}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-secondary/40 p-3">
              <div className="text-xs text-muted-foreground">Map display</div>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                <Smartphone className="h-4 w-4 text-red-500" />
                {settings.phone_use_show_on_map === false ? 'Hidden in Settings' : 'Phone icons enabled'}
              </div>
            </div>
          </div>

          {phoneUseInsights.isPassenger && (
            <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/30 dark:text-blue-200">
              <div className="font-semibold">Passenger trip</div>
              <div className="mt-1 text-xs">
                Phone-use evidence is retained for review, but this trip is excluded from driver phone-use trends and should not be interpreted as driver behavior.
              </div>
            </div>
          )}

          {!hasPhoneUsageAccess && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
              Foreground-app activity was not measured for this trip because Android Usage Access was unavailable.
            </div>
          )}

          {phoneUseRisk === 'none' && hasPhoneUsageAccess ? (
            <div className="mt-4 rounded-2xl bg-emerald-50 p-3 text-sm font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              No scored foreground-app activity overlapped movement on this trip.
            </div>
          ) : phoneUseInsights.hasConfirmedUse ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/30 dark:text-blue-200">
                <div className="font-semibold">Help calibrate this detection</div>
                <div className="mt-1 text-xs">
                  Review each window as driver activity or not driver use. If you were a passenger for the whole trip, mark that in the score review so the trip is excluded from driver trends.
                </div>
                <button
                  type="button"
                  onClick={() => document.getElementById('trip-score-review')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  className="mt-2 rounded-lg border border-blue-300 bg-white/70 px-2.5 py-1 text-xs font-semibold text-blue-800 hover:bg-white dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
                >
                  Confirm driver or passenger
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Smartphone className="mb-2 h-4 w-4 text-red-500" />
                  <div className="font-grotesk text-2xl font-bold">{phoneUseInsights.windowCount}</div>
                  <div className="text-xs text-muted-foreground">windows recorded</div>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Clock className="mb-2 h-4 w-4 text-orange-500" />
                  <div className="font-grotesk text-2xl font-bold">{Math.round(phoneUseInsights.totalSeconds)}s</div>
                  <div className="text-xs text-muted-foreground">estimated duration</div>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Gauge className="mb-2 h-4 w-4 text-blue-500" />
                  {/* Printed as a bare number before: no unit label, and no
                      conversion, so imperial users read a metric value. */}
                  <div className="font-grotesk text-2xl font-bold">{formatSpeedMeasured(phoneUseInsights.avgSpeedKmh || avgPhoneUseSpeed, units, '-')}</div>
                  <div className="text-xs text-muted-foreground">average speed during detection</div>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Focus className="mb-2 h-4 w-4 text-violet-500" />
                  <div className="font-grotesk text-2xl font-bold">{formatMeasured(phoneUseInsights.pctOfTrip, (value) => `${Math.round(value * 10) / 10}%`, { fallback: '-' })}</div>
                  <div className="text-xs text-muted-foreground">{phoneUseInsights.pctOfTrip == null ? 'of trip time (duration unknown)' : 'of trip time'}</div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-secondary/30 p-3">
                <div className="text-xs font-semibold uppercase text-muted-foreground">Coaching</div>
                <div className="mt-1 text-sm">{phoneUseInsights.coachingMessage}</div>
              </div>

              {phoneUseInsights.worstEvent && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-800/60 dark:bg-red-950/30">
                  <div className="text-xs font-semibold uppercase text-red-700 dark:text-red-300">Highest-risk moment</div>
                  <div className="mt-1 text-sm font-semibold text-red-800 dark:text-red-200">
                    {phoneUseInsights.worstEvent.activityLabel || 'Foreground app activity'} for {Math.round(phoneUseInsights.worstEvent.durationSeconds || 0)}s at {formatSpeed(phoneUseInsights.worstEvent.speedKmh || 0, units)}
                  </div>
                  {phoneUseInsights.worstEvent.contextLabels?.length > 0 && (
                    <div className="mt-1 text-xs text-red-700 dark:text-red-300">
                      {phoneUseInsights.worstEvent.contextLabels.join(' · ')}
                    </div>
                  )}
                </div>
              )}

              <details className="rounded-2xl bg-secondary/50 p-3">
                <summary className="cursor-pointer list-none text-sm font-semibold">Foreground-activity timeline</summary>
                <div className="mt-3 space-y-2">
                  {phoneUseTimeline.map((event, index) => (
                    <div
                      key={`${event.startTime || event.timestamp}-${index}`}
                      className="rounded-xl bg-card p-3 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold">
                          {event.activityLabel} · {event.startTime ? new Date(event.startTime).toLocaleTimeString() : 'time unknown'}
                        </div>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold uppercase">
                          {event.severity || event.confidence_level || 'medium'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {Math.round(event.durationSeconds)} seconds · {formatSpeed(event.speedKmh, units)}
                        {event.offsetSeconds != null ? ` · ${formatDuration(event.offsetSeconds)} into trip` : ''}
                      </div>
                      {event.contextLabels?.length > 0 && (
                        <div className="mt-1 text-xs text-muted-foreground">{event.contextLabels.join(' · ')}</div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => document.querySelector('.map-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                        >
                          View on map
                        </button>
                        {renderEventFeedbackControls(
                          event,
                          eventFeedbackKey(event, index),
                          eventFeedback[eventFeedbackKey(event, index)]?.verdict || null
                        )}
                      </div>
                    </div>
                  ))}
                  {phoneUseTimeline.length === 0 && (
                    <div className="rounded-xl bg-card p-3 text-xs text-muted-foreground">
                      A Usage Access summary was saved, but detailed windows are not present in this lightweight record. Open a newly recorded trip to see per-window timing and context.
                    </div>
                  )}
                </div>
              </details>

              <div className="rounded-xl border border-border p-3">
                <div className="text-sm font-semibold">Activity classification</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {phoneUseInsights.activityBreakdown.map((activity) => (
                    <div key={activity.key} className="rounded-lg bg-secondary/50 px-3 py-2">
                      <div className="text-sm font-medium">{activity.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {activity.windows} window{activity.windows === 1 ? '' : 's'} · {Math.round(activity.seconds)}s
                      </div>
                    </div>
                  ))}
                </div>
                {!phoneUseInsights.unlockClassificationAvailable && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    This trip predates privacy-preserving screen/unlock context or Android did not provide it. Foreground activity alone does not prove physical phone handling.
                  </div>
                )}
              </div>

              {phoneUseInsights.scoreComparison.length > 0 && (
                <div className="rounded-xl border border-border p-3">
                  <div className="text-sm font-semibold">Event severity comparison</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Product reference points compare event severity; the final trip score uses weighted component scoring.
                  </div>
                  <div className="mt-3 space-y-2">
                    {phoneUseInsights.scoreComparison.slice(0, 5).map((row) => (
                      <div key={row.type}>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium">{row.label} ({row.count})</span>
                          <span className="text-muted-foreground">{row.referencePoints} reference pts</span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary">
                          <div
                            className={`h-full rounded-full ${row.type === 'phone_use' ? 'bg-red-500' : 'bg-primary'}`}
                            style={{ width: `${Math.max(4, Math.round((row.referencePoints / phoneUseComparisonMax) * 100))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!phoneUseInsights.isPassenger && hasPhoneUsageAccess && settings.phone_use_affects_score !== false && phoneUseScoreForImpact != null && phoneUseScoreForImpact < 95 && (
                <div className="rounded-xl bg-red-50 p-3 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  Scored foreground-app activity reduced your Safety score by about {phoneUseSafetyImpactPoints} point{phoneUseSafetyImpactPoints === 1 ? '' : 's'}. Mark incorrect windows above to re-score.
                </div>
              )}
            </div>
          ) : null}
        </motion.div>
      )}

      {/* Map */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        {summaryOnlyPrivateTrip && (
          <div className="mb-3 rounded-2xl border border-slate-300 bg-slate-100 p-3 text-sm text-slate-800 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <div className="flex items-start gap-2">
              <Shield className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-semibold">Private trip - summary only</div>
                <div className="mt-0.5 text-xs">
                  Road Sage used GPS temporarily during the trip but never saved route coordinates, addresses, driving events, or route-based scores.
                </div>
              </div>
            </div>
          </div>
        )}
        {routeDataExpired && (
          <div className="mb-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 shadow-sm dark:border-blue-800/60 dark:bg-blue-950/30 dark:text-blue-200">
            <div className="flex items-start gap-2">
              <Shield className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-semibold">Route data expired</div>
                <div className="mt-0.5 text-xs">
                  GPS coordinates were removed on {new Date(trip.route_data_expired_at).toLocaleDateString()}. Scores and trip summaries were kept.
                </div>
              </div>
            </div>
          </div>
        )}
        {hasLocationPermissionLoss && (
          <div className="mb-3 rounded-2xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 shadow-sm dark:border-orange-800/60 dark:bg-orange-950/30 dark:text-orange-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-semibold">GPS data was unavailable for part of this trip.</div>
                <div className="mt-0.5 text-xs">Distance and scores may be underreported.</div>
              </div>
            </div>
          </div>
        )}
        {showLowSpeedLimitCoverageBanner && (
          premiumVisuals ? (
            <article
              className="premium-trip-road-data-card mb-3"
              data-road-data-status={contextMutation.isPending ? 'loading' : 'unavailable'}
              aria-label={`Speed limit data unavailable, ${osmCoveragePct}% speed-limit coverage`}
            >
              <img loading="lazy"
                className="premium-trip-road-data-art"
                src={premiumTripRoadData}
                alt=""
                aria-hidden="true"
              />
              <div className="premium-trip-road-data-content">
                <div className="premium-trip-road-data-heading">
                  <span aria-hidden="true"><AlertTriangle /></span>
                  <div>
                    <p>Route intelligence</p>
                    <h2>Speed limit data unavailable</h2>
                  </div>
                </div>
                <div className="premium-trip-road-data-meter">
                  <div>
                    {/* Named for its source, not "coverage": this is the OSM
                        fetch result and excludes limits confirmed since, while
                        the coverage card below counts every known limit. */}
                    <span>Mapped by OpenStreetMap</span>
                    <strong>{Math.max(0, Math.min(100, Math.round(osmCoveragePct)))}%</strong>
                  </div>
                  <span aria-hidden="true">
                    <i style={{ width: `${Math.max(0, Math.min(100, osmCoveragePct))}%` }} />
                  </span>
                </div>
                <p>
                  Tap Get Road Data to look for OpenStreetMap speed limits. Weather is requested separately with Get Weather.
                </p>
                <button
                  type="button"
                  onClick={confirmAndFetchRoadContext}
                  disabled={contextMutation.isPending || !trip.route_points?.length}
                >
                  <Route />
                  {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : 'Get Road Data'}
                </button>
              </div>
            </article>
          ) : (
            <div className="mb-3 rounded-2xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 shadow-sm dark:border-orange-800/60 dark:bg-orange-950/30 dark:text-orange-200">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <div className="font-semibold">Speed limit data unavailable</div>
                    <div className="mt-0.5 text-xs">
                      {osmCoveragePct}% speed-limit coverage - tap Get Road Data to look for OpenStreetMap speed limits. Weather never runs from this action.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={confirmAndFetchRoadContext}
                  disabled={contextMutation.isPending || !trip.route_points?.length}
                  className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-60"
                >
                  <Route className="h-3.5 w-3.5" />
                  {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : 'Get Road Data'}
                </button>
              </div>
            </div>
          )
        )}
        {speedLimitIntelligence.pointCount > 0 && (
          premiumVisuals ? (
            <article
              className="premium-trip-speed-coverage-card mb-3"
              data-coverage-tone={speedCoverageTone}
              aria-label={`Speed-limit coverage for this trip: ${speedLimitIntelligence.verifiedCoveragePercent}% verified, ${estimatedCoveragePercent}% estimated, ${missingCoveragePercent}% missing`}
            >
              <img loading="lazy"
                className="premium-trip-speed-coverage-art"
                src={premiumTripSpeedCoverage}
                alt=""
                aria-hidden="true"
              />
              <div className="premium-trip-speed-coverage-content">
                <header>
                  <span aria-hidden="true"><Gauge /></span>
                  <div>
                    <p>Coverage confidence</p>
                    <h2>Speed-limit coverage for this trip</h2>
                  </div>
                </header>
                <div className="premium-trip-speed-coverage-overview">
                  <div
                    className="premium-trip-speed-coverage-ring"
                    style={{ background: speedCoverageChartBackground }}
                    role="progressbar"
                    aria-label="Known speed-limit coverage"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(mappedCoverageForChart)}
                  >
                    <span>
                      <strong>{Math.round(mappedCoverageForChart)}%</strong>
                      <small>known</small>
                    </span>
                  </div>
                  <div className="premium-trip-speed-coverage-metrics">
                    <div
                      data-coverage-kind="verified"
                      title={`${speedLimitIntelligence.userConfirmedCoveragePercent}% confirmed by you, ${speedLimitIntelligence.mappedCoveragePercent}% mapped in OpenStreetMap`}
                    >
                      <strong>{speedLimitIntelligence.verifiedCoveragePercent}%</strong>
                      <span>Mapped or confirmed</span>
                    </div>
                    <div data-coverage-kind="estimated">
                      <strong>{estimatedCoveragePercent}%</strong>
                      <span>Estimated</span>
                    </div>
                    <div data-coverage-kind="missing">
                      <strong>{missingCoveragePercent}%</strong>
                      <span>Missing</span>
                    </div>
                  </div>
                </div>
                <p className="text-xs opacity-80">{coverageBasisNote}</p>
                <button
                  type="button"
                  onClick={openSpeedLimitReview}
                  data-review-needed={speedLimitReviewCount > 0}
                >
                  <MapPin />
                  {speedLimitReviewCount > 0
                    ? `Review ${speedLimitReviewCount} section${speedLimitReviewCount === 1 ? '' : 's'} on map`
                    : 'Review road speeds'}
                </button>
              </div>
            </article>
          ) : (
            <div className="mb-3 rounded-2xl border border-border bg-card p-3 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Gauge className="h-4 w-4 text-primary" />
                    <div className="font-semibold">Speed-limit coverage for this trip</div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <div
                      className="rounded-xl bg-emerald-50 px-2 py-2 dark:bg-emerald-950/30"
                      title={`${speedLimitIntelligence.userConfirmedCoveragePercent}% confirmed by you, ${speedLimitIntelligence.mappedCoveragePercent}% mapped in OpenStreetMap`}
                    >
                      <div className="text-lg font-bold text-emerald-700 dark:text-emerald-300">{speedLimitIntelligence.verifiedCoveragePercent}%</div>
                      <div className="text-[10px] font-semibold text-emerald-800/80 dark:text-emerald-200/80">Mapped or confirmed</div>
                    </div>
                    <div className="rounded-xl bg-amber-50 px-2 py-2 dark:bg-amber-950/30">
                      <div className="text-lg font-bold text-amber-700 dark:text-amber-300">{estimatedCoveragePercent}%</div>
                      <div className="text-[10px] font-semibold text-amber-800/80 dark:text-amber-200/80">Estimated</div>
                    </div>
                    <div className="rounded-xl bg-slate-100 px-2 py-2 dark:bg-slate-800">
                      <div className="text-lg font-bold">{missingCoveragePercent}%</div>
                      <div className="text-[10px] font-semibold text-muted-foreground">Missing</div>
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-muted-foreground">{coverageBasisNote}</div>
                </div>
                <button
                  type="button"
                  onClick={openSpeedLimitReview}
                  className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
                    speedLimitReviewCount > 0
                      ? 'bg-amber-600 text-white hover:bg-amber-700'
                      : 'border border-border bg-secondary text-foreground hover:bg-secondary/80'
                  }`}
                >
                  <MapPin className="h-3.5 w-3.5" />
                  {speedLimitReviewCount > 0
                    ? `Review ${speedLimitReviewCount} section${speedLimitReviewCount === 1 ? '' : 's'} on map`
                    : 'Review road speeds'}
                </button>
              </div>
            </div>
          )
        )}
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          <div className="flex min-w-[260px] flex-1 items-center gap-2 rounded-xl border border-border bg-card p-1.5">
            <select
              value={manualWeatherCondition}
              onChange={(event) => setManualWeatherCondition(event.target.value)}
              disabled={manualWeatherMutation.isPending}
              aria-label="Confirm trip weather locally"
              className="min-w-0 flex-1 rounded-lg bg-background px-2 py-1 text-xs text-foreground"
            >
              <option value="">{savedManualWeatherCondition ? 'Change confirmed condition…' : 'Confirm condition locally…'}</option>
              <option value="clear">Clear / dry</option>
              <option value="rain">Rain</option>
              <option value="snow">Snow</option>
              <option value="fog">Fog</option>
              <option value="freezing_precipitation">Ice / freezing rain</option>
              <option value="storm">Thunderstorm</option>
            </select>
            <button
              type="button"
              onClick={() => manualWeatherMutation.mutate(manualWeatherCondition)}
              disabled={
                !manualWeatherCondition ||
                manualWeatherMutation.isPending ||
                manualWeatherCondition === savedManualWeatherCondition
              }
              className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-semibold text-foreground disabled:opacity-50"
            >
              {manualWeatherMutation.isPending
                ? 'Saving…'
                : manualWeatherCondition && manualWeatherCondition === savedManualWeatherCondition
                  ? 'Saved locally'
                  : 'Save locally'}
            </button>
          </div>
          <button
            onClick={confirmAndFetchWeatherContext}
            disabled={weatherMutation.isPending || contextMutation.isPending || !trip.route_points?.length}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors disabled:opacity-60"
          >
            <Droplets className="h-3.5 w-3.5" />
            {weatherMutation.isPending ? osmFetchStatus || 'Getting weather...' : 'Get Weather'}
          </button>
          <button
            onClick={confirmAndFetchRoadContext}
            disabled={contextMutation.isPending || weatherMutation.isPending || !trip.route_points?.length}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors disabled:opacity-60"
          >
            <Route className="h-3.5 w-3.5" />
            {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : 'Get Road Data'}
          </button>
          <button
            onClick={() => setShowSpeedLimitsOnMap((value) => !value)}
            disabled={!hasSpeedLimitLayerData}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
              showSpeedLimitsOnMap ? 'bg-emerald-600 text-white' : 'bg-card border border-border text-muted-foreground'
            }`}
          >
            <Gauge className="h-3.5 w-3.5" />
            {showSpeedLimitsOnMap ? 'Hide Speed-Limit Layer' : 'Show Speed-Limit Layer'}
          </button>
          <button
            onClick={() => setShowCorneringHeatmap((value) => !value)}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
              showCorneringHeatmap ? 'bg-primary text-primary-foreground' : 'bg-card border border-border text-muted-foreground'
            }`}
          >
            <Route className="h-3.5 w-3.5" />
            Cornering Heatmap
          </button>
        </div>
        {!speedLimitContext && (
          <div className="mb-2 rounded-2xl border border-dashed border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            {describeOsmSpeedLimitStatus(speedLimitContext)} {speedLimitLookupEnabled ? 'Tap Get Road Data to look for speed limits.' : 'Speed-limit lookup is off in Settings.'} Get Weather is independent and never contacts OpenStreetMap or OSRM.
          </div>
        )}
        <div className="mb-2 rounded-2xl bg-secondary/40 p-3 text-xs text-muted-foreground">
          <div className="font-semibold text-foreground">What these buttons do</div>
          <div className="mt-1 break-words">
            {tripPointSummary}. Get Weather contacts only Open-Meteo. Get Road Data can contact only OpenStreetMap and an approved OSRM endpoint. Privacy-zone coordinates are excluded before anything leaves the app.
          </div>
          <div className="mt-2 grid gap-1">
            <div>Confirm locally: stores only your selected condition on this device and makes no network request.</div>
            <div>Speed limits {settings.speed_limit_lookup_enabled === false ? 'OFF' : 'ON'}: {settings.speed_limit_lookup_enabled === false ? 'OpenStreetMap speed-limit lookup is skipped; route colors use GPS bands or any speed-limit data already saved on the trip.' : 'sends privacy-filtered public road boxes to OpenStreetMap for road names and posted maxspeed limits; missing tags may use labeled estimates.'}</div>
            <div>Weather {settings.weather_context_enabled === false ? 'OFF' : 'ON'}: {settings.weather_context_enabled === false ? 'Open-Meteo is skipped; scores get no weather adjustment.' : 'Get Weather sends one rounded, privacy-safe route point and trip date to Open-Meteo without contacting OSM or OSRM.'}</div>
            <div>Snap to roads {settings.map_matching_enabled === false ? 'OFF' : settings.osrm_map_matching_url && settings.osrm_data_sharing_consented === true ? 'ON' : 'NEEDS CONSENT'}: {settings.map_matching_enabled === false ? 'OSRM is skipped; map/playback keep the GPS line.' : settings.osrm_map_matching_url && settings.osrm_data_sharing_consented === true ? 'sends sampled public GPS segments to your OSRM endpoint to clean up the route line.' : 'OSRM is skipped until a trusted endpoint and consent are saved in Settings.'}</div>
            <div>Show Speed-Limit Layer: only changes colors after speed limits are available.</div>
            <div>Cornering Heatmap: local-only visual overlay for sharper turns.</div>
          </div>
          <div className="mt-2 rounded-xl bg-background/60 px-3 py-2 font-medium text-foreground">
            {contextMutation.isPending || weatherMutation.isPending ? osmFetchStatus || 'Getting context...' : speedLimitLayerEffect}
          </div>
          {mapMatchingContext?.status === 'disabled' && (
            <div className="mt-2 rounded-xl bg-background/60 px-3 py-2">
              {describeMapMatchingStatus(mapMatchingContext)}
            </div>
          )}
        </div>
        {contextMutation.isError && (
          <div className="mb-2 rounded-2xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300">
            {contextMutation.error?.message || 'Could not get road data.'}
          </div>
        )}
        {summaryOnlyPrivateTrip ? (
          <div className="flex h-[180px] items-center justify-center rounded-2xl border border-dashed border-border bg-secondary/30 px-6 text-center text-sm text-muted-foreground">
            Map and playback are unavailable because this trip was recorded in summary-only private mode.
          </div>
        ) : routeDataExpired ? (
          <div className="flex h-[180px] items-center justify-center rounded-2xl border border-dashed border-border bg-secondary/30 px-6 text-center text-sm text-muted-foreground">
            Map and playback are unavailable because this trip's route coordinates reached their retention limit.
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-2xl border border-border shadow-sm">
            <Suspense fallback={<div className="flex h-[300px] items-center justify-center animate-pulse bg-secondary/50 text-sm text-muted-foreground">Loading trip map...</div>}>
              <TripMap
                routePoints={trip.route_points || []}
                events={mapEvents}
                showCorneringHeatmap={showCorneringHeatmap}
                showSpeedLimits={showSpeedLimitsOnMap}
                speedLimitKnowledgeResults={speedLimitLocalKnowledgeResults}
                showRouteRisk={routeRiskSegments.length > 0}
                routeRiskSegments={routeRiskSegments}
                rawPointCount={trip.route_points_raw_count}
                showRouteSummary={shouldShowStandardMapRouteSummary(premiumMapVisuals)}
                height="300px"
              />
            </Suspense>
            {premiumMapVisuals && (
              showPremiumRouteDiagnostics ? (
                <div className="premium-map-diagnostics-overlay">
                  <PremiumMapDiagnostics
                    trip={trip}
                    units={units}
                    onShowAll={() => navigate('/map')}
                    onDismiss={() => setShowPremiumRouteDiagnostics(false)}
                    overlay
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowPremiumRouteDiagnostics(true)}
                  className="absolute bottom-3 left-3 z-10 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground shadow"
                  aria-label="Show route diagnostics"
                >
                  Route diagnostics
                </button>
              )
            )}
          </div>
        )}
        {weatherMutation.isError && (
          <div className="mb-2 rounded-2xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300">
            {weatherMutation.error?.message || 'Could not get weather.'}
          </div>
        )}
      </motion.div>

      <motion.div
        ref={metadataSectionRef}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="trip-detail-identity trip-detail-premium-card rounded-3xl border border-border bg-card p-5 shadow-sm"
        data-premium-card="identity"
        data-premium-scene={premiumVisuals ? premiumTripDetail.scene : undefined}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-grotesk font-bold">{tripTitle}</h1>
            <div className="mt-1 text-sm text-muted-foreground">{formatDateTime(trip.start_time)}</div>
          </div>
          <button
            onClick={() => setEditingMetadata((value) => !value)}
            className="rounded-xl border border-border p-2 text-muted-foreground hover:bg-secondary"
            title={editingMetadata ? 'Close editor' : 'Edit trip details'}
          >
            {editingMetadata ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </button>
        </div>

        {editingMetadata ? (
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Nickname</label>
              <input
                value={metadataDraft.nickname}
                onChange={(event) => setMetadataDraft((draft) => ({ ...draft, nickname: event.target.value }))}
                placeholder="Work commute"
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes</label>
              <textarea
                value={metadataDraft.notes}
                onChange={(event) => setMetadataDraft((draft) => ({ ...draft, notes: event.target.value }))}
                placeholder="Heavy rain, construction, passenger in car..."
                rows={3}
                className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Smart tags</div>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Pick every label that applies. Your choices teach repeated-route suggestions on this device.
              </p>
              <div className="space-y-3">
                {TRIP_TAG_CATEGORIES.map((category) => {
                  const options = tagEditorOptions.filter((option) => option.category === category.id);
                  if (!options.length) return null;
                  return (
                    <div key={category.id}>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {category.label}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {options.map((option) => (
                          <button
                            type="button"
                            key={option.id}
                            onClick={() => toggleDraftTag(option.id)}
                            title={option.description}
                            aria-pressed={metadataDraft.tags.includes(option.id)}
                            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                              metadataDraft.tags.includes(option.id)
                                ? 'border-primary bg-primary text-primary-foreground'
                                : option.className
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div className="flex gap-2">
                  <input
                    value={customTagDraft}
                    onChange={(event) => setCustomTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      addCustomDraftTag();
                    }}
                    maxLength={40}
                    placeholder="Add your own tag"
                    aria-label="Custom trip tag"
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={addCustomDraftTag}
                    disabled={!normalizeTripTagId(customTagDraft)}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
            <button
              onClick={saveMetadata}
              disabled={metadataMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              {metadataMutation.isPending ? 'Saving...' : 'Save trip details'}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {tripTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tripTags.map((tagId) => {
                  const option = getTripTagOption(tagId);
                  const source = trip.tag_sources?.[tagId];
                  return (
                    <span
                      key={tagId}
                      title={source?.reason || option?.description}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${option?.className || 'bg-secondary text-muted-foreground border-border'}`}
                    >
                      {option?.label || tagId}
                    </span>
                  );
                })}
              </div>
            )}
            {trip.notes ? (
              <div className="flex gap-2 rounded-2xl bg-secondary/50 p-3 text-sm">
                <StickyNote className="mt-0.5 h-4 w-4 text-muted-foreground" />
                <div>{trip.notes}</div>
              </div>
            ) : (
              <button onClick={() => setEditingMetadata(true)} className="text-sm font-medium text-primary">
                Add notes for this trip
              </button>
            )}
          </div>
        )}
      </motion.div>

      {routeRiskSegments.length > 0 && (
        <div
          className="trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm"
          data-premium-card="behavior"
          data-premium-behavior={premiumVisuals ? premiumTripDetail.behaviorTone : undefined}
        >
          <h2 className="font-semibold mb-3">Route history</h2>
          <div className="space-y-2">
            {displayedRouteRiskSegments.map((segment, index) => {
              const perPass = segment.tripCount ? segment.totalEvents / segment.tripCount : 0;
              return (
                <div key={`${segment.from.lat}-${segment.to.lat}-${index}`} className="flex gap-3 rounded-2xl bg-secondary/50 p-3">
                  <span className={`mt-1 h-3 w-3 rounded-full ${segment.riskLevel === 'high' ? 'bg-red-500' : 'bg-orange-500'}`} />
                  <div className="text-sm">
                    <div className="font-semibold capitalize">{segment.riskLevel} event-density stretch</div>
                    <div className="text-xs text-muted-foreground">
                      You've driven through this area {segment.tripCount} times. Average {perPass.toFixed(1)} recorded events per pass · mostly {(segment.dominantEventType || 'driving events').replace(/_/g, ' ')}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {routeRiskSegments.length > MAX_ROUTE_RISK_SEGMENTS_SHOWN && (
            <button
              type="button"
              onClick={() => setShowAllRouteRiskSegments((value) => !value)}
              className="mt-3 text-xs font-semibold text-primary"
            >
              {showAllRouteRiskSegments ? 'Show fewer stretches' : `Show all stretches (${hiddenRouteRiskSegmentCount} hidden)`}
            </button>
          )}
        </div>
      )}

      {/* Score overview */}
      <SectionErrorBoundary
        context="trip_detail_score_overview"
        title="Score summary unavailable"
        message="Something went wrong while preparing this trip's score summary. Reload to try again."
        resetKey={trip.id}
      >
        <TripScoreOverview
          trip={trip}
          speedLimitSourceBreakdown={speedLimitSourceBreakdown}
          units={units}
          premium={premiumVisuals}
          nightSettings={settings}
        />
      </SectionErrorBoundary>
      <motion.section
        ref={speedLimitReviewSectionRef}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.165 }}
        className="trip-detail-premium-card scroll-mt-24 rounded-3xl border border-border bg-card p-5 shadow-sm"
        data-premium-card="score"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Gauge className="h-5 w-5 text-primary" />
              <h2 className="font-semibold">Speed Review</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              See which road speeds were trusted, what still needs your decision, and exactly when a confirmed change reaches this trip.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/speed-limits?tripId=${encodeURIComponent(String(trip.id))}&view=review`}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2 text-sm font-semibold hover:bg-secondary"
            >
              <MapPin className="h-4 w-4" />
              Road memory
            </Link>
            <Link
              to={`/trips/${trip.id}/speed`}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <Gauge className="h-4 w-4" />
              Speed Analysis
            </Link>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {speedReviewRows.map((row) => (
            <div key={row.label} className="rounded-2xl bg-secondary/50 p-3">
              <div className="text-xs font-medium text-muted-foreground">{row.label}</div>
              <div className="mt-1 font-grotesk text-xl font-bold">{row.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{row.detail}</div>
            </div>
          ))}
        </div>
        <div className={`mt-4 rounded-2xl border p-4 ${
          speedLimitReviewCount > 0
            ? 'border-amber-300 bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/25'
            : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/20'
        }`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold">
                {speedLimitReviewCount > 0
                  ? `${speedLimitReviewCount} road section${speedLimitReviewCount === 1 ? '' : 's'} need your decision`
                  : 'Road-speed evidence is up to date for this trip'}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {speedLimitReviewCount > 0
                  ? 'Unconfirmed sections remain estimates. Confirming a posted limit immediately recalculates affected completed trips and is reused by future scores, voice warnings, and live alerts.'
                  : 'Confirmed saved limits are reused automatically. Camera candidates remain inactive until you review their retained sign crop.'}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleSpeedLimitReview}
              className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold ${
                speedLimitReviewCount > 0
                  ? 'bg-amber-600 text-white hover:bg-amber-700'
                  : 'border border-border bg-background hover:bg-secondary'
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              {reviewSpeedLimitConflicts
                ? 'Close road review'
                : speedLimitReviewCount > 0
                  ? `Review ${speedLimitReviewCount} now`
                  : 'Check road evidence'}
            </button>
          </div>
        </div>

        <SpeedSignEvidenceReview trip={trip} className="mt-4" />

        {reviewSpeedLimitConflicts && (
          <div className="mt-4">
            <SpeedLimitConflictReview
              trip={trip}
              reviewMode
              onResolved={handleSpeedLimitReviewResolved}
            />
          </div>
        )}
      </motion.section>
      <div id="trip-score-review" className="scroll-mt-24">
        <PostTripCalibrationSurvey
          trip={trip}
          status={calibrationSurveyStatus}
          labelCount={calibrationLabelCount}
          isPending={calibrationSurveyMutation.isPending}
          error={calibrationSurveyMutation.error}
          onSubmit={(surveyInput, options) => calibrationSurveyMutation.mutate({ surveyInput, ...options })}
        />
      </div>
      {roadTypeScores.length > 0 && (
        <motion.details
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          className="trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm"
          data-premium-card="score"
          open
        >
          <summary className="cursor-pointer list-none font-semibold">By Road Type</summary>
          <div className="mt-4 space-y-3">
            {roadTypeScores.map(({ key, label, data }) => {
              const { color: scoreColor } = getScoreColor(data.overall || 0);
              return (
                <div key={key} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{label}</span>
                    <span className={`font-semibold ${scoreColor}`} title={buildScoreExplanation(trip, 'score_overall')}>{formatScoreWithProvenance(data.overall, trip.score_provenance)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(0, Math.min(100, data.overall || 0))}%` }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDistance(data.distance_km || 0, units)} analyzed, {data.event_count || 0} event{(data.event_count || 0) === 1 ? '' : 's'}
                    {data.road_type_source && (
                      <> · {roadTypeSourceLabel[data.road_type_source] || 'Estimated road type'}
                        {/* A missing confidence rendered as a definite "0% confidence". */}
                        {Number(data.road_type_confidence) > 0
                          ? ` (${Math.round(Number(data.road_type_confidence) * 100)}% confidence)`
                          : ' (confidence not recorded)'}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.details>
      )}

      {/* Trip metadata */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm space-y-4"
        data-premium-card="facts"
      >
        <h2 className="font-semibold">Trip Details</h2>

        <div className="grid grid-cols-2 gap-4">
          {[
            {
              icon: Navigation,
              label: 'Distance',
              value: formatDistance(trip.distance_km || 0, units),
              subValue: [
                estimatedPrivateDistanceKm > 0
                  ? `~${formatDistance(estimatedPrivateDistanceKm, units)} traveled within privacy zones (estimated)`
                  : null,
                dpAggregateNote,
              ].filter(Boolean).join(' · ') || null,
            },
            { icon: Clock, label: 'Duration', value: formatDuration(trip.duration_seconds) },
            {
              icon: Gauge,
              label: 'Average moving speed',
              value: formatSpeed(primaryAvgSpeedKmh, units),
              subValue: showOverallAvgSpeed ? `Average speed (incl. stops): ${formatSpeed(trip.avg_speed_kmh || 0, units)}` : null,
            },
            // FIX: Add overall average as a secondary line while keeping moving speed primary.
            { icon: Gauge, label: 'Max Speed', value: formatSpeed(trip.max_speed_kmh || 0, units) },
            { icon: Fuel, label: 'Estimated Fuel Cost', value: formatCurrencyAmount(economics.cost, settings), subValue: fuelCostAssumptions },
            { icon: Leaf, label: 'Estimated Fuel Saved', value: fuelSavedValue, subValue: economics.fuel_saved_available ? 'Assigned-vehicle baseline; driving-efficiency adjustment capped at 8%.' : 'Assign a vehicle to estimate savings.' },
            { icon: Leaf, label: 'CO2', value: `${economics.co2_kg.toFixed(1)} kg`, subValue: economics.estimate_label },
            { icon: Leaf, label: 'CO2 Saved vs Average', value: co2SavedValue, subValue: economics.co2_saved_label },
            { icon: ParkingSquare, label: 'Parking', value: formatScoreWithProvenance(componentScore('parking_approach').value, trip.score_provenance, { empty: 'Unavailable' }) },
            { icon: TimerReset, label: 'Traffic Stops', value: formatDuration(trafficIdleSeconds) },
            { icon: ParkingSquare, label: 'Parked Idle', value: formatDuration(parkedIdleSeconds), subValue: parkedIdleEstimated ? 'Estimated from idle and traffic-stop time' : null },
            { icon: MapPin, label: 'Trip End', value: tripEndState, subValue: terminalParkedSeconds > 0 ? `${formatDuration(terminalParkedSeconds)} at final stop` : trip.parking_stop_detected ? 'Trip ended from a stopped state' : null },
          ].map(({ icon: Icon, label, value, subValue }) => (
            <div key={label} className="flex items-start gap-3 p-3 bg-secondary/50 rounded-xl">
              <Icon className="w-4 h-4 text-muted-foreground mt-0.5" />
              <div>
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="font-semibold text-sm">{value}</div>
                {subValue && <div className="text-[11px] text-muted-foreground mt-0.5">{subValue}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <div className="w-2.5 h-2.5 bg-green-500 rounded-full" />
            <span className="text-muted-foreground">Start:</span>
            <span className="font-medium">{formatDateTime(trip.start_time)}</span>
          </div>
          {trip.end_time && (
            <div className="flex items-center gap-2 text-sm">
              <div className="w-2.5 h-2.5 bg-red-500 rounded-full" />
              <span className="text-muted-foreground">End:</span>
              <span className="font-medium">{formatDateTime(trip.end_time)}</span>
            </div>
          )}
          {nightExplanation && (
            <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
              trip.night_driving
                ? 'border-purple-500/30 bg-purple-500/5 text-purple-700 dark:text-purple-300'
                : 'border-border bg-secondary/30 text-foreground'
            }`}>
              <Moon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-medium">{nightExplanation.headline}</div>
                <div className="text-xs text-muted-foreground">{nightExplanation.detail}</div>
                {nightExplanation.timezone && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{nightExplanation.timezone}</div>
                )}
              </div>
            </div>
          )}
          {roadCfg ? (
            <div className={`inline-flex w-fit items-center gap-2 text-sm border rounded-full px-3 py-1 ${roadCfg.className}`}>
              <RoadIcon className="w-4 h-4" />
              <span>{roadCfg.label} route</span>
            </div>
          ) : (
            <div className="inline-flex w-fit items-center gap-2 text-sm border rounded-full px-3 py-1 bg-muted text-muted-foreground border-border">
              <Shuffle className="w-4 h-4" />
              <span>Road type not measured</span>
            </div>
          )}
          {dominantRoadCfg && trip.dominant_road_type && (
            <div className={`inline-flex w-fit items-center gap-2 text-sm border rounded-full px-3 py-1 ${dominantRoadCfg.className}`}>
              <DominantRoadIcon className="w-4 h-4" />
              <span>Dominant: {dominantRoadCfg.label}</span>
            </div>
          )}
          {tripVehicle && (
            <div className="flex items-center gap-2 text-sm">
              <Car className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">Vehicle:</span>
              <span className="font-medium">{tripVehicle.name}</span>
            </div>
          )}
        </div>
      </motion.div>

      {speedZoneSummary.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.21 }}
          className="trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm"
          data-premium-card="score"
        >
          <h2 className="font-semibold mb-3">Speed Zones</h2>
          <div className="mb-3 rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
            <div>{speedLimitProvenanceSummary}</div>
            {speedLimitSourceBreakdown.rows.length > 0 && (
              <div className="mt-3 space-y-2">
                {speedLimitSourceBreakdown.rows.map((row) => (
                  <div key={row.key} className="rounded-lg border border-border bg-background/60 p-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-foreground">{row.label}</div>
                        <div className="mt-0.5">{row.detail}</div>
                        {row.limits.length > 0 && (
                          <div className="mt-0.5">
                            Limits used: {row.limits.map((value) => formatSpeed(value, units)).join(', ')}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right font-semibold text-foreground">
                        {row.percent}%
                        <div className="text-[10px] font-medium text-muted-foreground">
                          {row.count} sample{row.count === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={`h-full rounded-full ${row.tone}`}
                        style={{ width: `${Math.max(2, Math.min(100, row.percent))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!hasPostedSpeedLimitEvidence && speedLimitSourceBreakdown.rows.length > 0 && (
              <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                {speedLimitEstimateWarning}
              </div>
            )}
          </div>
          <div className="space-y-2">
            {speedZoneSummary.map((zone) => (
              <div key={zone.inferredZone} className="flex items-center justify-between rounded-xl bg-secondary/50 p-3">
                <div>
                  <div className="text-sm font-semibold">{formatSpeed(zone.inferredZoneKmh, units)} inferred</div>
                  {/* This is speed consistency within the window, not
                      confidence that the inferred limit is right. */}
                  <div className="text-xs text-muted-foreground capitalize">{zone.confidence} speed consistency</div>
                </div>
                <div className="text-sm font-semibold">{formatDistance(zone.distanceKm, units)}</div>
              </div>
            ))}
            {complianceRows.map(({ key, label, data }) => (
              <div key={`compliance-${key}`} className="rounded-xl bg-secondary/50 p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <div className="font-semibold">{label} compliance</div>
                  <div className="font-semibold">{Math.round((data.rate || 0) * 100)}%</div>
                </div>
                <div className="h-2 rounded-full bg-background">
                  <div
                    className={`h-full rounded-full ${getScoreColor(data.score || 0).fill}`}
                    style={{ width: `${Math.max(0, Math.min(100, (data.rate || 0) * 100))}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {data.limit_source === 'openstreetmap' ? 'OSM maxspeed' : data.limit_source === 'osm_highway_default' ? `OSM road-type estimate${speedLimitDefaultCountryText ? ` (${speedLimitDefaultCountries.join(', ')} profile)` : ''} - not proof of the posted speed limit` : data.limit_source === 'region_default_estimate' ? 'Regional default estimate - not proof of the posted speed limit; check posted signs' : 'Inferred - may not reflect actual limit'} {formatSpeedMeasured(data.inferred_limit_kmh, units)}, max excess {formatSpeedMeasured(data.max_excess_kmh, units)}, score {formatScoreWithProvenance(data.score, trip.score_provenance)}{data.limit_source === 'inferred' ? ' (half-weight penalty)' : ''}
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Driving behavior detail */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22 }}
        className="trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm"
        data-premium-card="behavior"
        data-premium-behavior={premiumVisuals ? premiumTripDetail.behaviorTone : undefined}
      >
        <h2 className="font-semibold mb-4">Driving Pattern</h2>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[
            { icon: MapPin, label: 'traffic stops', value: trip.traffic_stop_count ?? trip.stop_count ?? 0, color: 'text-primary' },
            { icon: AlertTriangle, label: 'long-drive flag (from trip duration only)', value: fatigueRisk.level, color: fatigueRisk.level === 'high' ? 'text-red-500' : fatigueRisk.level === 'medium' ? 'text-orange-500' : 'text-emerald-500', capitalize: true },
            { icon: Waves, label: 'smoothness index', componentKey: 'smoothness_index', color: 'text-sky-500' },
            { icon: GitBranch, label: 'brake onset smoothness', componentKey: 'brake_onset_smoothness', value: brakeOnsetCollectingDataText, show: Boolean(brakeOnsetCollectingDataText), color: ['abrupt', 'very_abrupt'].includes(trip.brake_onset_smoothness_grade) ? 'text-red-500' : brakeOnsetCollectingDataText ? 'text-amber-500' : 'text-emerald-500' },
            { icon: Shuffle, label: 'lane changing', componentKey: 'lane_changing', value: trip.lane_changing_grade ?? 'unavailable', useComponentValue: false, color: ['frequent', 'erratic'].includes(trip.lane_changing_grade) ? 'text-red-500' : trip.lane_changing_grade === 'acceptable' ? 'text-sky-500' : 'text-emerald-500', capitalize: true, badge: trip.lane_changing_confidence !== 'imu_calibrated' ? 'GPS estimate' : null },
            { icon: ShieldCheck, label: 'stop-start pattern estimate', componentKey: 'stop_start_pattern', color: 'text-blue-500' },
            { icon: Focus, label: 'attention-pattern estimate', componentKey: 'distraction', color: 'text-violet-500' },
            { icon: TimerReset, label: 'approach-stop estimate', componentKey: 'intersection', color: 'text-amber-500' },
            { icon: Gauge, label: 'SVI', componentKey: 'speed_variability', color: 'text-indigo-500' },
            { icon: Fuel, label: 'efficient cruising', value: trip.optimal_band_ratio == null ? 'unavailable' : `${trip.optimal_band_ratio}%`, color: 'text-lime-500' },
            { icon: Car, label: 'engine stress', componentKey: 'engine_stress', color: 'text-orange-500' },
            { icon: ParkingSquare, label: 'parking', value: trip.parking_approach_grade ?? '-', color: 'text-slate-500', capitalize: true },
            { icon: AlertTriangle, label: 'attention pattern (GPS beta)', value: trip.heading_drift_beta_level ?? 'none', componentKey: 'heading_drift_beta', useComponentValue: false, color: trip.heading_drift_beta_level === 'high' ? 'text-red-500' : trip.heading_drift_beta_level === 'medium' ? 'text-orange-500' : 'text-emerald-500', capitalize: true, show: trip.heading_drift_beta_available === true },
            { icon: Milestone, label: 'gradient driving estimate (GPS speed proxy)', componentKey: 'hill_driving', color: 'text-emerald-500' },
          ].map((item) => {
            const evidenceScore = item.componentKey ? componentScore(item.componentKey) : null;
            const value = evidenceScore && item.useComponentValue !== false && evidenceScore.value != null
              ? evidenceScore.value
              : item.value;
            return { ...item, evidenceScore, value, show: item.show ?? (!evidenceScore || evidenceScore.value != null) };
          }).filter(({ show = true }) => show).map(({ icon: Icon, label, value, color, capitalize, evidenceScore, useComponentValue, badge }) => (
            <div key={label} className="bg-secondary/50 rounded-xl p-3" title={evidenceScore?.note}>
              <Icon className={`w-4 h-4 mb-2 ${color}`} />
              <div className={`font-grotesk font-bold text-xl ${value === brakeOnsetCollectingDataText ? 'text-sm leading-snug' : ''} ${capitalize ? 'capitalize' : ''}`}>{evidenceScore && useComponentValue !== false && evidenceScore.value != null ? formatScoreWithProvenance(value, trip.score_provenance) : value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
              {badge && (
                <div className="mt-0.5 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">{badge}</div>
              )}
              {evidenceScore && shouldShowComponentEvidenceBadge(evidenceScore.evidence) && (
                <div className="mt-0.5 text-[11px] capitalize text-muted-foreground">{componentEvidenceText(evidenceScore.evidence)}</div>
              )}
            </div>
          ))}
        </div>

        <div className="mb-4 rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
          <p>Brake onset smoothness measures how smoothly brakes were applied during detected braking events, not human neurological reaction time.</p>
          {brakeOnsetCollectingDataText && (
            <p className="mt-1 font-medium text-foreground">Brake onset smoothness: {brakeOnsetCollectingDataText}.</p>
          )}
          <p className="mt-1">Stop-start pattern and attention-pattern values are low-confidence GPS-only estimates; they cannot measure following distance, lane position, object proximity, or drowsiness.</p>
          {componentScore('intersection').value == null && (
            <p className="mt-1">Approach-stop estimate is unavailable for this trip.</p>
          )}
        </div>

        {fatigueHeatmapData.length > 0 ? (
          <div className="mb-4 bg-secondary/50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Fatigue exposure progression</div>
              <span className="text-xs text-muted-foreground">fatigue level 0-100</span>
            </div>
            <DeferredRecharts height={140}>
              {({ ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip }) => (
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={fatigueHeatmapData} margin={{ top: 5, right: 0, bottom: 0, left: -28 }}>
                    <defs>
                      <linearGradient id="fatigueLevelFill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity={0.25} />
                        <stop offset="55%" stopColor="#f97316" stopOpacity={0.18} />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0.10} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="minuteOffset" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                    <Area
                      type="monotone"
                      dataKey="fatigueLevel"
                      stroke="#f97316"
                      fill="url(#fatigueLevelFill)"
                      strokeWidth={2}
                      dot={(props) => {
                        const { cx, cy, payload } = props;
                        return payload.fatigueLevel >= CRITICAL_FATIGUE_CHART_LEVEL
                          ? <circle cx={cx} cy={cy} r={4} fill="#ef4444" stroke="white" strokeWidth={1.5} />
                          : null;
                      }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </DeferredRecharts>
          </div>
        ) : fatigueChartData.length === 3 && (
          <div className="mb-4 bg-secondary/50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Driving quality over trip</div>
              <span className="text-xs text-muted-foreground">{fatigueText[fatigueProgressionLevel] || fatigueProgressionLevel}</span>
            </div>
            <DeferredRecharts height={120}>
              {({ ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip }) => (
                <ResponsiveContainer width="100%" height={120}>
                  <AreaChart data={fatigueChartData} margin={{ top: 5, right: 0, bottom: 0, left: -28 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                    <Area type="monotone" dataKey="score" stroke={fatigueColor} fill={fatigueColor} fillOpacity={0.18} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </DeferredRecharts>
          </div>
        )}

        {(componentScore('braking_efficiency').value != null || componentScore('smooth_braking').value != null) && (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium">Braking Efficiency</span>
              <span className="font-semibold capitalize">
                {trip.braking_efficiency_grade?.replace('_', ' ') ||
                  formatMeasured(trip.smooth_braking_ratio, (value) => `${Math.round(value)}% smooth`)}
              </span>
            </div>
            {trip.braking_context && (
              <div className="mb-2 text-xs text-muted-foreground">
                Graded for {trip.braking_context} driving conditions - {componentEvidenceText(componentScore('braking_efficiency').evidence)} - GPS speed estimate.
              </div>
            )}
            {componentScore('braking_efficiency').value != null && (
              <div className="mb-2 flex items-baseline gap-2">
                <span className="font-grotesk text-2xl font-bold">{formatScoreWithProvenance(componentScore('braking_efficiency').value, trip.score_provenance)}</span>
                <span className="text-xs text-muted-foreground">
                  {trip.braking_sequence_count || 0} stop sequence{(trip.braking_sequence_count || 0) === 1 ? '' : 's'}, smoothness {Math.round((trip.avg_braking_smoothness || 0) * 100)}%
                </span>
              </div>
            )}
            <div className="h-2 overflow-hidden rounded-full bg-background">
              <div
                className={`h-full rounded-full ${
                  (componentScore('braking_efficiency').value ?? componentScore('smooth_braking').value) >= 80 ? 'bg-emerald-500' : (componentScore('braking_efficiency').value ?? componentScore('smooth_braking').value) >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                }`}
                style={{ width: `${Math.max(0, Math.min(100, componentScore('braking_efficiency').value ?? componentScore('smooth_braking').value))}%` }}
              />
            </div>
          </div>
        )}

        {componentScore('hill_driving').value != null ? (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3 text-sm">
            <div className="flex items-center gap-2">
              <div className="font-medium">Hill Control</div>
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                GPS altitude estimate
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatMeasured(trip.climb_distance_km, (value) => formatDistance(value, units))} climbing, {formatMeasured(trip.descent_distance_km, (value) => formatDistance(value, units))} descending. Use engine braking on descents rather than braking repeatedly.
            </div>
            <div role="alert" className="mt-2 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>Hill-driving limitation: GPS and altitude-derived estimate only. A legitimate uphill manoeuvre can trigger an inferred infraction.</span>
            </div>
          </div>
        ) : (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3 text-sm">
            <div className="flex items-center gap-2">
              <div className="font-medium">Hill Control</div>
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                GPS altitude estimate
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">Not applicable (flat route or insufficient altitude evidence).</div>
            <div role="alert" className="mt-2 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>Hill-driving limitation: GPS altitude evidence can be noisy, so hill control is withheld unless enough route evidence is available.</span>
            </div>
          </div>
        )}

        {componentScore('cornering_consistency').value != null && (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium">Cornering</div>
              <span className="rounded-full bg-card px-2 py-0.5 text-xs font-semibold capitalize">
                {trip.cornering_grade}
              </span>
            </div>
            <div className="mb-2 text-xs text-muted-foreground">
              {componentEvidenceText(componentScore('cornering_consistency').evidence)} - GPS heading estimate.
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-card p-2">
                <div className="font-grotesk text-lg font-bold">{formatScoreWithProvenance(componentScore('cornering_consistency').value, trip.score_provenance)}</div>
                <div className="text-[11px] text-muted-foreground">score</div>
              </div>
              <div className="rounded-lg bg-card p-2">
                <div className="font-grotesk text-lg font-bold">{formatMeasured(trip.mean_lateral_g, (value) => value.toFixed(2), { fallback: '-' })}</div>
                <div className="text-[11px] text-muted-foreground">mean g</div>
              </div>
              <div className="rounded-lg bg-card p-2">
                <div className="font-grotesk text-lg font-bold">{formatMeasured(trip.peak_lateral_g, (value) => value.toFixed(2), { fallback: '-' })}</div>
                <div className="text-[11px] text-muted-foreground">peak g</div>
              </div>
            </div>
          </div>
        )}

        {stops.length > 0 ? (
          <div className="space-y-2 max-h-44 overflow-y-auto thin-scrollbar">
            {stops.slice(0, 8).map((stop, index) => (
              <div key={`${stop.start_time}-${index}`} className="flex items-center justify-between border border-border rounded-xl p-2 text-sm">
                <div>
                  <div className="font-medium">Extended stop {index + 1}</div>
                  <div className="text-xs text-muted-foreground">{new Date(stop.start_time).toLocaleTimeString()}</div>
                </div>
                <div className="text-xs font-semibold text-primary">{formatDuration(stop.duration_seconds)}</div>
              </div>
            ))}
          </div>
        ) : (trip.traffic_stop_count ?? trip.stop_count ?? 0) > 0 ? (
          <div className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
            {trip.traffic_stop_count ?? trip.stop_count} estimated traffic stops recorded. No extended stopped periods were recorded.
          </div>
        ) : (
          <div className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
            No estimated traffic stops or extended stopped periods were recorded on this trip.
          </div>
        )}
      </motion.div>

      {/* Driving Events */}
      {showDrivingEventsPanel && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm"
          data-premium-card="behavior"
          data-premium-behavior={premiumVisuals ? premiumTripDetail.behaviorTone : undefined}
        >
          <h2 className="font-semibold mb-4">
            Driving Events
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {scoredEventRows.length} scored / {diagnosticEventRows.length} diagnostic
            </span>
          </h2>
          {(feedbackCounts.accurate > 0 || feedbackCounts.wrong > 0) && (
            <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div>
                Detection feedback: <span className="font-semibold text-emerald-600 dark:text-emerald-300">{feedbackCounts.accurate} accurate</span>
                <span className="mx-1">/</span>
                <span className="font-semibold text-red-600 dark:text-red-300">{feedbackCounts.wrong} needs review</span>
                {trip.feedback_adjusted_events_count > 0 && (
                  <span className="ml-1">/ {trip.feedback_adjusted_events_count} removed from scoring</span>
                )}
              </div>
              {trip.needs_rescore && (
                <button
                  type="button"
                  onClick={() => feedbackRescoreMutation.mutate()}
                  disabled={feedbackRescoreMutation.isPending}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  <TimerReset className="h-3.5 w-3.5" />
                  {feedbackRescoreMutation.isPending ? 'Re-scoring...' : 'Re-score now'}
                </button>
              )}
            </div>
          )}
          {feedbackStatus && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card p-3 text-xs font-medium text-muted-foreground">
              <span>{feedbackStatus}</span>
              {lastFeedbackUndo && (
                <button
                  type="button"
                  disabled={feedbackMutation.isPending}
                  onClick={() => feedbackMutation.mutate({
                    ...lastFeedbackUndo,
                    isUndo: true,
                  })}
                  className="rounded-lg border border-border bg-background px-2.5 py-1 font-semibold text-foreground disabled:opacity-50"
                >
                  Undo
                </button>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            {eventSummaryRows.map(({ label, value, note, icon: Icon, color, bg }) => (
              <div key={label} className={`${bg} rounded-xl p-3 flex items-center gap-3`}>
                <Icon className={`w-5 h-5 ${color}`} />
                <div>
                  <div className={`font-grotesk font-bold text-xl ${color}`}>{value || 0}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                  {note && <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{note}</div>}
                </div>
              </div>
            ))}
          </div>

          {scoredEventRows.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto thin-scrollbar">
              {scoredEventRows.map((row) => renderEventRow(row))}
            </div>
          ) : (
            <div className="rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground">
              No scored driving events were recorded on this trip.
            </div>
          )}

          {diagnosticEventRows.length > 0 && (
            <details className="mt-4 rounded-2xl border border-border bg-secondary/30 p-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
                <span>Diagnostic-Only Events (Not Scored)</span>
                <span className="rounded-full bg-card px-2 py-0.5 text-xs text-muted-foreground">
                  {diagnosticEventRows.length}
                </span>
              </summary>
              <div className="mt-3 space-y-2 max-h-64 overflow-y-auto thin-scrollbar">
                {diagnosticEventRows.map((row) => renderEventRow(row, { diagnostic: true }))}
              </div>
            </details>
          )}
        </motion.div>
      )}

      {/* Route Points summary */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="bg-secondary/50 rounded-2xl px-5 py-3 flex items-center justify-between"
      >
        <span className="text-sm text-muted-foreground">Route Points</span>
        <span className="text-right text-sm font-semibold">{tripPointSummary}</span>
      </motion.div>
    </div>
  );
}

function componentEvidenceText(evidence) {
  if (evidence === 'developing') return 'limited evidence';
  if (typeof evidence === 'string' && ['high', 'low', 'unavailable'].includes(evidence)) {
    return `${evidence} evidence`;
  }
  const numeric = Number(evidence);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 0) return 'unavailable evidence';
  if (numeric < 0.5) return 'low evidence';
  if (numeric < 0.8) return 'limited evidence';
  return 'high evidence';
}

function scoreConfidenceMeta(component = {}) {
  const evidence = component?.evidence;
  const sampleCount = Number(component?.sampleCount);
  const sampleText = Number.isFinite(sampleCount) && sampleCount > 0
    ? `${sampleCount.toLocaleString()} route sample${sampleCount === 1 ? '' : 's'}`
    : null;

  if (component?.value == null || evidence === 'unavailable') {
    return {
      label: 'Score unavailable',
      description: 'Not enough reliable evidence was stored to score this trip.',
      sampleText,
      className: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
    };
  }

  if (evidence === 'high') {
    return {
      label: 'High confidence',
      description: 'Score is based on enough stored route evidence and supporting signals.',
      sampleText,
      className: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
    };
  }

  if (evidence === 'developing') {
    return {
      label: 'Developing confidence',
      description: 'Score is usable, but some supporting signals are missing or still collecting.',
      sampleText,
      className: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
    };
  }

  return {
    label: componentEvidenceText(evidence) || 'Limited confidence',
    description: 'Treat this score as directional because the evidence is limited.',
    sampleText,
    className: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
  };
}

/**
 * Describe one component's movement across a re-score. A component that gained
 * or lost a value has no delta, so it is stated as such rather than being shown
 * as a change from zero.
 */
function scoreChangeText(change = {}) {
  const label = scoreFactorLabel(change.key);
  if (change.from == null) return `${label}: now scored ${change.to}`;
  if (change.to == null) return `${label}: no longer scored (was ${change.from})`;
  const direction = change.delta > 0 ? '+' : '';
  return `${label}: ${change.from} to ${change.to} (${direction}${change.delta})`;
}

const scoreChangeReasonText = (reason) => {
  switch (reason) {
    case 'scoring_version_changed':
      return 'the scoring model was updated';
    case 'scoring_inputs_changed':
      return 'scoring inputs you changed were applied';
    case 'provenance_added':
      return 'this trip was refreshed';
    default:
      return 'you asked for a re-score';
  }
};

function scoreDriverReason(driver = {}) {
  if (driver.kind === 'event') {
    const category = String(driver.category || 'score').toLowerCase();
    return `${driver.count} recorded event${driver.count === 1 ? '' : 's'} affected the ${category} part of the score.`;
  }

  const scoreText = Number.isFinite(Number(driver.score)) ? `${driver.score}/100` : 'below full credit';
  // `deficit` is simply 100 minus this component's own score. Phrasing it as
  // "N points below perfect" alongside the overall score read as "this factor
  // cost you N points off your overall", which it is not.
  const deficitText = Number.isFinite(Number(driver.deficit)) && driver.deficit > 0
    ? `, ${driver.deficit} short of this component's maximum`
    : '';
  const prefix = `This scored ${scoreText}${deficitText}.`;

  switch (driver.factor) {
    case 'speed_limit_compliance':
      return `${prefix} Speeding penalties depend on the limit source shown for this trip.`;
    case 'braking_efficiency':
      return `${prefix} Abrupt or uneven full-stop braking lowered Safety.`;
    case 'lane_changing':
      return `${prefix} Frequent lane changes or braking during lane changes lowered Safety.`;
    case 'phone_use':
      return `${prefix} Confirmed Android Usage Access phone-use evidence lowered Safety.`;
    case 'smoothness_index':
      return `${prefix} Sudden acceleration or braking changes lowered Smoothness.`;
    case 'speed_variability':
      return `${prefix} Uneven moving speed lowered Smoothness.`;
    case 'brake_onset_smoothness':
      return `${prefix} Abrupt brake application lowered Smoothness.`;
    case 'cornering_consistency':
      return `${prefix} Variable or high-G cornering lowered Smoothness.`;
    default:
      return prefix;
  }
}

function shouldShowComponentEvidenceBadge(evidence) {
  return Boolean(evidence) && evidence !== 'high';
}

function componentDataSources(component = {}) {
  const sources = Array.isArray(component.dataSource)
    ? component.dataSource
    : Array.isArray(component.data_sources)
      ? component.data_sources
      : [];
  return [...new Set(sources.filter(Boolean).map(String))];
}

function componentSourceDetails(component = {}) {
  const sources = componentDataSources(component);
  const sourceLabels = sources.length ? sources.map(formatDataSourceLabel) : ['No source recorded'];
  const sampleCount = Number(component.sampleCount ?? component.sample_count);
  const sampleText = Number.isFinite(sampleCount)
    ? `${Math.max(0, Math.round(sampleCount))} sample${Math.round(sampleCount) === 1 ? '' : 's'}`
    : 'Sample count unavailable';
  return {
    sourceText: sourceLabels.join(', '),
    sampleText,
    title: `Sources: ${sourceLabels.join(', ')}. ${sampleText}.`,
  };
}

function usesInferredSpeedLimitScoring(trip = {}) {
  const scoreSources = ['overall', 'safety', 'speed_limit_compliance'].some((key) => (
    Array.isArray(trip.component_scores?.[key]?.dataSource) &&
    trip.component_scores[key].dataSource.includes('gps_inferred_speed_limit')
  ));
  if (scoreSources) return true;

  return [trip.highway_compliance, trip.urban_compliance, trip.residential_compliance]
    .filter(Boolean)
    .some((bucket) => bucket.limit_source === 'inferred');
}

const SCORE_ACCURACY_LABELS = {
  accurate: 'Yes, it looks fair',
  too_low: 'No, the score is too harsh',
  too_high: 'No, the score is too generous',
};

const SCORE_REVIEW_ISSUE_LABELS = {
  harsh_brake: 'Braking',
  rapid_acceleration: 'Acceleration',
  sharp_turn: 'Cornering',
  speeding: 'Speeding',
  phone_use: 'Phone use',
  other: 'Something else',
};

const WAS_DRIVER_LABELS = {
  yes: 'Yes',
  no: 'No',
  unsure: 'Unsure',
};

const CONTEXT_TAG_LABELS = {
  traffic: 'Traffic',
  weather: 'Weather',
  construction: 'Construction',
  fatigue: 'Fatigue',
  aggressive_drivers: 'Aggressive drivers',
  bad_road: 'Bad road',
  gps_issue: 'GPS issue',
  passenger: 'Passenger',
  other: 'Other',
};

const shouldPromptForCalibrationSurvey = (tripId, labelCount, status) => {
  if (status?.rating || status?.skipped) return true;
  const count = Number(labelCount);
  if (!Number.isFinite(count) || count < 20) return true;
  const input = String(tripId || '');
  // A plain sum of character codes clusters badly for sequential or
  // timestamp-like ids: neighbouring ids land in neighbouring buckets, so
  // whole runs of trips are prompted or skipped together. FNV-1a spreads them.
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 3 === 0;
};

function PostTripCalibrationSurvey({ trip, status, labelCount, isPending, error, onSubmit }) {
  const tripScore = Number.isFinite(Number(trip?.score_overall)) ? Number(trip.score_overall) : null;
  const [draft, setDraft] = useState({
    scoreAccuracy: '',
    scoreIssueTypes: [],
    targetScore: '',
    wasDriver: 'yes',
    contextTags: [],
    freeTextNote: '',
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dismissedForSession, setDismissedForSession] = useState(false);
  const submitted = Boolean(status?.score_accuracy || status?.rating);
  const skipped = status?.skipped === true;
  const shouldPrompt = shouldPromptForCalibrationSurvey(status?.trip_id || trip?.id, labelCount, status);

  useEffect(() => {
    if (!submitted || editing) return;
    setDraft({
      scoreAccuracy: status?.score_accuracy || '',
      scoreIssueTypes: Array.isArray(status?.score_issue_types) ? status.score_issue_types : [],
      targetScore: Number.isFinite(Number(status?.target_score)) ? String(Number(status.target_score)) : '',
      wasDriver: status?.wasDriver || status?.was_driver || 'yes',
      contextTags: Array.isArray(status?.context_tags) ? status.context_tags : [],
      freeTextNote: status?.free_text_note || '',
    });
  }, [editing, status, submitted]);

  // These reviews feed personal detection thresholds only. They are never
  // uploaded, so they cannot count toward the global 2,000-label penalty-scale
  // fit - do not present them as progress toward it.
  const progressText = Number.isFinite(Number(labelCount))
    ? Number(labelCount).toLocaleString() + ' local score review' + (Number(labelCount) === 1 ? '' : 's') +
      ' - used for your own detection thresholds, never uploaded'
    : 'Saved only on this device';
  const savedAnswer = SCORE_ACCURACY_LABELS[status?.score_accuracy] || null;
  const statusText = submitted
    ? 'Saved locally for personal calibration. This trip is not silently rewritten.'
    : isPending
      ? 'Saving score review...'
      : 'Tell Road Sage what it got right or wrong about this trip.';
  const disabled = isPending || (submitted && !editing) || skipped;
  const needsIssue = draft.scoreAccuracy === 'too_low' || draft.scoreAccuracy === 'too_high';
  const fairScore = draft.targetScore === '' ? null : Number(draft.targetScore);
  const fairScoreInRange = Number.isInteger(fairScore) && fairScore >= 0 && fairScore <= 100;
  const fairScoreDirectionValid = draft.scoreAccuracy === 'accurate'
    ? tripScore == null || fairScore === tripScore
    : draft.scoreAccuracy === 'too_low'
      ? tripScore == null || (fairScore != null && fairScore > tripScore)
      : draft.scoreAccuracy === 'too_high'
        ? tripScore == null || (fairScore != null && fairScore < tripScore)
        : false;
  const canSubmit = SCORE_ACCURACY_OPTIONS.includes(draft.scoreAccuracy) &&
    fairScoreInRange &&
    fairScoreDirectionValid &&
    (!needsIssue || draft.scoreIssueTypes.length > 0) &&
    WAS_DRIVER_OPTIONS.includes(draft.wasDriver) &&
    !disabled;

  const toggleScoreIssue = (type) => {
    setDraft((current) => ({
      ...current,
      scoreIssueTypes: current.scoreIssueTypes.includes(type)
        ? current.scoreIssueTypes.filter((item) => item !== type)
        : [...current.scoreIssueTypes, type],
    }));
  };
  const toggleContextTag = (tag) => {
    setDraft((current) => ({
      ...current,
      contextTags: current.contextTags.includes(tag)
        ? current.contextTags.filter((item) => item !== tag)
        : [...current.contextTags, tag],
    }));
  };
  const chooseAccuracy = (option) => {
    setDraft((current) => ({
      ...current,
      scoreAccuracy: option,
      scoreIssueTypes: option === 'accurate' ? [] : current.scoreIssueTypes,
      targetScore: option === 'accurate' && tripScore != null
        ? String(tripScore)
        : current.scoreAccuracy === option
          ? current.targetScore
          : '',
    }));
  };
  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      scoreAccuracy: draft.scoreAccuracy,
      scoreIssueTypes: draft.scoreIssueTypes,
      targetScore: fairScore,
      wasDriver: draft.wasDriver,
      contextTags: draft.contextTags,
      freeTextNote: draft.freeTextNote,
    }, {
      replaceExisting: submitted && editing,
    });
    setEditing(false);
    setReviewOpen(false);
  };

  if (skipped || dismissedForSession || !shouldPrompt) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.16 }}
      className={'trip-score-review-card rounded-xl border transition-colors ' + (
        reviewOpen || editing
          ? 'border-border bg-card p-3 shadow-sm'
          : 'border-border/60 bg-secondary/20 px-3 py-2'
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold">
              {/* Every other score on this page carries the approximate-score
                  prefix via formatScoreWithProvenance; this one showed the raw
                  number, implying it was exact. */}
              Score {formatScoreWithProvenance(tripScore, trip?.score_provenance, { empty: '—' })}
            </span>
            <h2 className="min-w-0 text-sm font-semibold leading-tight">
              {submitted ? 'Your score review is saved' : 'Does this trip score look fair?'}
            </h2>
            {savedAnswer && (
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {savedAnswer}
              </span>
            )}
          </div>
          {(reviewOpen || editing) && (
            <div className="mt-1 text-xs text-muted-foreground">{statusText}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
          {(reviewOpen || editing) && (
            <span className="text-[11px] text-muted-foreground">{progressText}</span>
          )}
          {!editing && (
            <button
              type="button"
              onClick={() => setReviewOpen((open) => !open)}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold"
            >
              {reviewOpen ? 'Close' : submitted ? 'View' : 'Review'}
            </button>
          )}
        </div>
      </div>

      {(reviewOpen || editing) && (
        <>
          <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="grid gap-2 sm:grid-cols-3 sm:max-w-3xl">
              {SCORE_ACCURACY_OPTIONS.map((option) => {
                const selected = draft.scoreAccuracy === option;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => chooseAccuracy(option)}
                    className={'min-h-12 rounded-lg border px-3 py-2 text-left text-xs font-semibold transition-colors ' + (
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-secondary/50 hover:bg-secondary disabled:opacity-60'
                    )}
                  >
                    {SCORE_ACCURACY_LABELS[option]}
                  </button>
                );
              })}
            </div>

            {submitted && !editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setReviewOpen(true);
                }}
                className="self-start rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
              >
                Edit review
              </button>
            )}

            {(!submitted || editing) && (
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setDetailsOpen((open) => !open)}
                  className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
                >
                  {detailsOpen ? 'Hide context' : 'Add context'}
                </button>
                {!submitted && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setDismissedForSession(true)}
                    className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
                  >
                    Dismiss for now
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canSubmit}
                  onClick={submit}
                  className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  Save score review
                </button>
              </div>
            )}
          </div>

          {submitted && !editing && (
            <div className="mt-3 grid gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-xs text-muted-foreground sm:grid-cols-3">
              <div><span className="font-semibold text-foreground">Fair score:</span> {status?.target_score ?? 'Not recorded'}</div>
              <div><span className="font-semibold text-foreground">Driver:</span> {WAS_DRIVER_LABELS[status?.wasDriver || status?.was_driver] || 'Unsure'}</div>
              <div><span className="font-semibold text-foreground">Context:</span> {status?.context_tags?.length ? status.context_tags.map((tag) => CONTEXT_TAG_LABELS[tag] || tag).join(', ') : 'None added'}</div>
              {status?.free_text_note && (
                <div className="sm:col-span-3"><span className="font-semibold text-foreground">Note:</span> {status.free_text_note}</div>
              )}
            </div>
          )}

          {(!submitted || editing) && draft.scoreAccuracy && (
            <label className="mt-4 block max-w-xs text-xs font-semibold">
              What score would feel fair?
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={draft.targetScore}
                disabled={disabled || draft.scoreAccuracy === 'accurate'}
                onChange={(event) => setDraft((current) => ({ ...current, targetScore: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground"
                placeholder={tripScore == null ? '0–100' : draft.scoreAccuracy === 'too_low' ? 'Higher than ' + tripScore : 'Lower than ' + tripScore}
              />
              {!fairScoreDirectionValid && fairScoreInRange && (
                <span className="mt-1 block font-normal text-red-600 dark:text-red-400">
                  Choose a score {draft.scoreAccuracy === 'too_low' ? 'higher' : 'lower'} than {tripScore}.
                </span>
              )}
            </label>
          )}

          {(!submitted || editing) && needsIssue && (
            <div className="mt-4">
              <div className="text-xs font-semibold">
                {draft.scoreAccuracy === 'too_low'
                  ? 'What made the score seem too harsh?'
                  : 'What risk or problem did the score seem to miss?'}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {SCORE_REVIEW_ISSUE_OPTIONS.map((type) => {
                  const selected = draft.scoreIssueTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => toggleScoreIssue(type)}
                      className={'rounded-full border px-2.5 py-1 text-xs font-semibold ' + (
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary'
                      )}
                    >
                      {SCORE_REVIEW_ISSUE_LABELS[type]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {(!submitted || editing) && (
            <div className="mt-4 rounded-xl border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
              Saved locally. Three consistent eligible reviews can influence a suggested personal threshold in Settings. Applying that suggestion is always your choice.
            </div>
          )}

          {(!submitted || editing) && detailsOpen && (
            <div className="mt-4 space-y-4">
              <label className="block max-w-sm text-xs font-medium text-muted-foreground">
                Were you the driver?
                <select
                  value={draft.wasDriver}
                  disabled={disabled}
                  onChange={(event) => setDraft((current) => ({ ...current, wasDriver: event.target.value }))}
                  className="mt-1 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground"
                >
                  {WAS_DRIVER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{WAS_DRIVER_LABELS[option]}</option>
                  ))}
                </select>
              </label>

              <div>
                <div className="text-xs font-medium text-muted-foreground">Did any context affect this trip?</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {TRIP_CONTEXT_TAG_OPTIONS.map((tag) => {
                    const selected = draft.contextTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        disabled={disabled}
                        aria-pressed={selected}
                        onClick={() => toggleContextTag(tag)}
                        className={'rounded-full border px-2.5 py-1 text-xs font-semibold ' + (
                          selected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary'
                        )}
                      >
                        {CONTEXT_TAG_LABELS[tag]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="block text-xs font-medium text-muted-foreground">
                What did Road Sage misunderstand?
                <textarea
                  value={draft.freeTextNote}
                  disabled={disabled}
                  onChange={(event) => setDraft((current) => ({ ...current, freeTextNote: event.target.value }))}
                  className="mt-1 min-h-20 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground"
                  placeholder="Optional. Stored locally only."
                />
              </label>
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">
              {error.message || 'Could not save this score review.'}
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}

function TripScoreOverview({
  trip,
  speedLimitSourceBreakdown = null,
  units = 'metric',
  premium = false,
  nightSettings = {},
}) {
  const overallScore = getTripComponentScore(trip, 'overall');
  const premiumTripDetail = getPremiumTripDetailPresentation(trip, nightSettings);
  const unavailableOverallScore = overallScore.value == null;
  const scoreProvenance = trip.score_provenance;
  const provenanceChange = trip.score_provenance_change;
  const changedConstants = Array.isArray(provenanceChange?.changed_constants)
    ? provenanceChange.changed_constants
    : [];
  const headlineScores = [
    { label: 'Safety', key: 'safety' },
    { label: 'Smooth', key: 'smoothness' },
  ].map((item) => ({ ...item, component: getTripComponentScore(trip, item.key) }));
  const lowScoreConfidence = !unavailableOverallScore && overallScore.evidence !== 'high';
  const inferredSpeedLimitScoring = usesInferredSpeedLimitScoring(trip);
  const phoneUsePermissionRequired = trip.phone_use_score_status === 'usage_access_required';
  const scoreDrivers = explainTripScoreDrivers(trip);
  // Newest first; only the most recent re-score is shown so the panel stays a
  // "did my correction do anything?" answer rather than a changelog.
  const latestScoreChange = Array.isArray(trip.score_change_ledger)
    ? trip.score_change_ledger[0]
    : null;
  const scoreConfidence = scoreConfidenceMeta(overallScore);
  // 'scored' means these rows came from the snapshot frozen when the trip was
  // scored, so the heading may claim they describe the stored score.
  const speedLimitSourcesAreFrozen = speedLimitSourceBreakdown?.basis === 'scored';
  const speedLimitSourceRows = Array.isArray(speedLimitSourceBreakdown?.rows)
    ? speedLimitSourceBreakdown.rows
    : [];
  const topSpeedLimitSourceRows = speedLimitSourceRows.slice(0, 3);
  const componentSummaryRows = [
    { label: 'Aggression', metricKey: 'aggressive_driving_score', component: getTripComponentScore(trip, 'aggressive_driving'), grade: trip.aggressive_grade },
    { label: 'Defensive Driving Estimate', metricKey: 'defensive_driving_score', component: getTripComponentScore(trip, 'defensive_driving'), grade: trip.defensive_grade, qualifier: 'GPS + stop-behaviour proxy' },
    {
      label: 'Lane Changing',
      metricKey: 'lane_changing_score',
      component: getTripComponentScore(trip, 'lane_changing'),
      grade: trip.lane_changing_grade,
      badge: trip.lane_changing_confidence !== 'imu_calibrated' ? 'GPS estimate' : null,
    },
  ].filter(({ component }) => component.value != null);
  const confidenceTitle = lowScoreConfidence
    ? 'Score based on limited available evidence.'
    : unavailableOverallScore
      ? SCORE_UNAVAILABLE_MESSAGE
      : buildScoreExplanation(trip, 'score_overall');
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className={`trip-score-overview trip-detail-premium-card bg-card border border-border rounded-3xl p-5 shadow-sm${premium ? ' premium-trip-score-overview' : ''}`}
      data-premium-card={premium ? 'score' : undefined}
      data-premium-scene={premium ? premiumTripDetail.scene : undefined}
      data-premium-score={premium ? premiumTripDetail.scoreTone : undefined}
    >
      {premium && (
        <div className="premium-trip-score-kicker" aria-hidden="true">
          <ShieldCheck />
          <span>Drive intelligence</span>
        </div>
      )}
      <div className="trip-score-overview-head flex items-center gap-6">
        <div className="trip-score-overall shrink-0 text-center">
          <ScoreRing
            score={overallScore.value}
            size={100}
            strokeWidth={8}
            sublabel="overall"
            title={confidenceTitle}
            evidence={overallScore.evidence}
            scoreProvenance={scoreProvenance}
          />
          <div
            title={scoreConfidence.description}
            className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${scoreConfidence.className}`}
          >
            {scoreConfidence.label}
          </div>
          {scoreConfidence.sampleText && (
            <div className="mt-1 text-[10px] text-muted-foreground">{scoreConfidence.sampleText}</div>
          )}
        </div>
        {/* Column count must match the number of headline scores; a fixed
            grid-cols-3 left a permanent empty third column. Full class names
            are written out so Tailwind can still see them statically. */}
        <div className={`trip-score-headlines grid flex-1 gap-3 ${headlineScores.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {headlineScores.map(({ label, key, component }) => {
            const unavailable = component.value == null || component.evidence === 'unavailable';
            const { color: c } = unavailable ? { color: 'text-muted-foreground' } : getScoreColor(component.value || 0);
            const sourceDetails = componentSourceDetails(component);
            return (
              <div
                key={label}
                className={`trip-score-headline min-w-0 rounded-xl border px-2 py-2 text-center ${unavailable ? 'border-border bg-secondary/40' : 'border-border/60 bg-background/50'}`}
                title={component.note || buildScoreExplanation(trip, `score_${key}`)}
              >
                <div className={`font-grotesk text-xl font-bold ${c}`}>
                  {unavailable ? '-' : formatScoreWithProvenance(component.value, scoreProvenance)}
                </div>
                <div className="text-xs font-medium text-muted-foreground">{label}</div>
                {shouldShowComponentEvidenceBadge(component.evidence) && (
                  <div className="mt-0.5 text-[11px] capitalize text-muted-foreground">{componentEvidenceText(component.evidence)}</div>
                )}
                <span
                  tabIndex={0}
                  title={sourceDetails.title}
                  aria-label={sourceDetails.title}
                  className="mx-auto mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
                >
                  <Info className="h-3 w-3" />
                  Sources
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {unavailableOverallScore && (
        <p className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
          {SCORE_UNAVAILABLE_MESSAGE}
        </p>
      )}
      {lowScoreConfidence && (
        <p className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
          {scoreConfidence.description} Short city trips often have enough GPS data to score, but not enough distance or supporting signals to call the score high confidence yet.
        </p>
      )}
      {inferredSpeedLimitScoring && (
        <p role="note" className="mt-3 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Speed-limit score uses estimated limits.</span> OpenStreetMap had no posted maxspeed for part of this trip, so road-type or regional default estimates may be used. Regional defaults are useful fallback estimates when posted speed data is unavailable, but they are not proof of the posted speed limit. Posted signs, school zones, construction zones, temporary limits, municipal bylaws, and road-specific exceptions can override them. REGION_DEFAULT is more reliable than GPS-only inference because it uses country/province/state and road-context information, but it is still an estimate unless confirmed by posted data.
        </p>
      )}
      {phoneUsePermissionRequired && (
        <PhoneUsePermissionBanner className="mt-3" />
      )}
      {topSpeedLimitSourceRows.length > 0 && (
        <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3 text-xs">
          <div className="flex items-start gap-2">
            <Tag className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              {/* Without a frozen snapshot this falls back to re-resolving every
                  point against CURRENT settings, so changing the fallback country
                  in Settings changes the panel with no rescore. Only the frozen
                  basis may claim to describe the stored score. */}
              <div className="font-semibold text-foreground">
                {speedLimitSourcesAreFrozen ? 'Speed-limit sources used for this score' : 'Speed-limit sources, recomputed now'}
              </div>
              <div className="mt-1 text-muted-foreground">
                Speeding penalties depend on where the app got the limit. Posted and confirmed sources are strongest; estimates are clearly marked.
                {speedLimitSourcesAreFrozen
                  ? ' These are the sources recorded when this trip was scored, so they do not change until it is re-scored.'
                  : ' This breakdown is recalculated from your current settings and may differ from the sources used when the score was last computed.'}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {topSpeedLimitSourceRows.map((row) => (
                  <span
                    key={row.key}
                    title={`${row.detail} ${row.limits.length ? `Limits used: ${row.limits.map((value) => formatSpeed(value, units)).join(', ')}.` : ''}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 font-semibold text-foreground"
                  >
                    <span className={`h-2 w-2 rounded-full ${row.tone}`} />
                    {row.percent}% {row.label}
                  </span>
                ))}
              </div>
              {speedLimitSourceRows.length > topSpeedLimitSourceRows.length && (
                <div className="mt-1 text-muted-foreground">
                  See Speed Zones below for all {speedLimitSourceRows.length} source types.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="mt-4 rounded-2xl border border-border bg-secondary/30 p-4">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">What shaped this score</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Top 3 read-only drivers from stored component scores and recorded events. This does not reconstruct exact point deductions or rewrite the trip.
            </p>
          </div>
        </div>
        {scoreDrivers.length > 0 ? (
          <div className="mt-3 space-y-2">
            {scoreDrivers.map((driver, index) => (
              <div key={driver.factor} className="rounded-xl bg-background/70 px-3 py-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                        #{index + 1}
                      </span>
                      <div className="font-semibold text-foreground">{driver.label}</div>
                    </div>
                    <div className="mt-1 text-muted-foreground">{scoreDriverReason(driver)}</div>
                  </div>
                  <div className="shrink-0 font-grotesk text-sm font-bold text-foreground">
                    {driver.kind === 'component' ? `~${driver.score}` : `${driver.count}x`}
                  </div>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {driver.category}
                  {['low', 'developing'].includes(driver.evidence) ? ' - limited evidence' : ''}
                  {driver.note ? ` - ${driver.note}` : ''}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            No stored component or event evidence is available for an explanation yet.
          </p>
        )}
      </div>
      {scoreProvenance && (
        <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-semibold text-foreground">
              Scoring provenance
              {OVERALL_SCORE_IS_APPROXIMATE && <CalibrationStatusTag />}
            </span>
          </div>
          {/* Scoped deliberately: this timestamp describes the scoring pass, not
              every panel above it. Panels that still recompute live say so. */}
          <div className="mt-1">Score last calculated {formatDateTime(scoreProvenance.computed_at)}</div>
          {provenanceChange && (
            <p className="mt-2 rounded-xl bg-secondary/50 p-3">
              {provenanceChange.reason === 'provenance_added'
                ? 'Provenance was recorded when this trip was refreshed.'
                : provenanceChange.reason === 'legacy_tagged_without_rescore'
                  ? 'Provenance was tagged during migration; this score was not recalculated.'
                : provenanceChange.reason === 'scoring_version_changed'
                  ? `Recalculated after the scoring model changed from version ${provenanceChange.previous_scoring_version || 'unknown'} to ${provenanceChange.current_scoring_version}.`
                  : provenanceChange.reason === 'user_requested_rescore'
                    ? 'Recalculated after a manual re-score request.'
                    : 'Recalculated after scoring calibration inputs changed.'}
              {changedConstants.length > 0 && ` Updated constants: ${changedConstants.join(', ')}.`}
            </p>
          )}
          {latestScoreChange && (
            <div className="mt-2 rounded-xl bg-secondary/50 p-3">
              <div className="font-semibold text-foreground">What the last re-score changed</div>
              <div className="mt-1">
                {`Recalculated ${formatDateTime(latestScoreChange.at)} because ${scoreChangeReasonText(latestScoreChange.reason)}.`}
              </div>
              <ul className="mt-2 space-y-1">
                {(latestScoreChange.changes || []).map((change) => (
                  <li key={change.key} className="flex items-center gap-2">
                    <span
                      className={
                        change.delta == null
                          ? 'text-muted-foreground'
                          : change.delta > 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                      }
                      aria-hidden="true"
                    >
                      {change.delta == null ? '-' : change.delta > 0 ? '^' : 'v'}
                    </span>
                    <span className="min-w-0 text-foreground">{scoreChangeText(change)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 mt-5 sm:grid-cols-2">
        {componentSummaryRows.map(({ label, metricKey, component, grade, qualifier, badge }) => (
          <div key={label} className="flex min-w-0 items-center gap-3 rounded-2xl bg-secondary/50 p-3">
            <div className="shrink-0">
              <ScoreRing
                score={component.value ?? 0}
                evidence={component.evidence}
                size={56}
                strokeWidth={5}
                title={buildScoreExplanation(trip, metricKey)}
                scoreProvenance={scoreProvenance}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-tight">{label}</div>
              {qualifier && <div className="text-[11px] text-muted-foreground">{qualifier}</div>}
              {badge && (
                <div className="mt-0.5 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">{badge}</div>
              )}
              {shouldShowComponentEvidenceBadge(component.evidence) && (
                <div className="text-[11px] capitalize text-muted-foreground">{componentEvidenceText(component.evidence)}</div>
              )}
              <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                ['calm', 'exemplary', 'defensive', 'smooth'].includes(grade) ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' :
                  ['moderate', 'acceptable'].includes(grade) ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' :
                    ['assertive', 'average', 'frequent'].includes(grade) ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300' :
                      'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
              }`}>{grade || 'unknown'}</span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
