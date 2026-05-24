import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Navigation, Clock, Gauge, TrendingDown, Zap, Car, MapPin,
  CornerUpRight, AlertTriangle, Moon, Trash2, Fuel, Leaf, Milestone,
  Building, Shuffle, Home, Waves, ShieldCheck, Focus, TimerReset, Tag,
  ParkingSquare, Droplets, GitBranch, Route, Smartphone, Pencil, Save, Star,
  StickyNote, X
} from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import ScoreRing from '@/components/ScoreRing';
import TripMap from '@/components/TripMap';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import {
  calculateSegmentMetrics,
  formatDistance,
  formatDuration,
  formatDateTime,
  formatSpeed,
  getScoreColor,
  inferSpeedZones,
  PHONE_USE_SAFETY_WEIGHT,
  splitTripAtStops,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { formatCurrencyAmount } from '@/lib/currency';
import { getJson, setJson } from '@/lib/mobileStorage';
import { DAILY_FATIGUE_THRESHOLDS } from '@/lib/dailyFatigueEngine';
import { buildFatigueHeatmapData, calculateFatigueRisk, detectTripStops, estimateTripEconomics, suggestTripTag } from '@/lib/tripInsights';
import { getSegmentsForTrip, loadRouteRiskIndex } from '@/lib/routeRiskIndex';
import {
  buildOpenSourceTripContextPatch,
  buildRoadContextPrivacyMessage,
  describeMapMatchingStatus,
  describeOsmSpeedLimitStatus,
} from '@/lib/openSourceTripContext';
import { buildPhoneUseFromTripEvidence, mergePhoneUseEventsIntoDrivingEvents } from '@/lib/phoneUsageAccess';
import {
  TRIP_TAG_OPTIONS,
  buildScoreExplanation,
  getTripDisplayName,
  getTripTagOption,
  normalizeTripTags,
} from '@/lib/tripMetadata';
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

const roadTypeConfig = {
  highway: { label: 'Highway', icon: Milestone, className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800/50' },
  urban: { label: 'Urban', icon: Building, className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800/50' },
  mixed: { label: 'Mixed', icon: Shuffle, className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700' },
  residential: { label: 'Residential', icon: Home, className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800/50' },
};

const fatigueText = {
  significant: 'Quality dropped toward end of trip',
  moderate: 'Quality dipped; consider breaks',
  improving: 'You warmed up well',
  slight: 'Fairly consistent',
};
const CRITICAL_FATIGUE_CHART_LEVEL = DAILY_FATIGUE_THRESHOLDS.CRITICAL * 10;

export default function TripDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = localSettings.get();
  const units = settings.units || 'metric';
  const [showCorneringHeatmap, setShowCorneringHeatmap] = useState(false);
  const [showSpeedLimitsOnMap, setShowSpeedLimitsOnMap] = useState(false);
  const [routeRiskIndex, setRouteRiskIndex] = useState(new Map());
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState({ nickname: '', notes: '', tags: [] });
  const [osmFetchStatus, setOsmFetchStatus] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState('');
  const [showAllRouteRiskSegments, setShowAllRouteRiskSegments] = useState(false);
  const [dismissedTagsLoaded, setDismissedTagsLoaded] = useState(false);
  const metadataSectionRef = useRef(null);

  const { data: trip, isLoading } = useQuery({
    queryKey: ['trip', id],
    queryFn: () => tripService.getById(id),
  });

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => tripService.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
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
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
      navigate('/trips');
    },
  });
  const tagMutation = useMutation({
    mutationFn: (/** @type {any} */ tag) => {
      const tags = [...new Set([...normalizeTripTags(trip), tag])];
      return tripService.update(id, { tags, tag, tag_reviewed: true });
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
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
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
      setMetadataDraft({
        nickname: updatedTrip?.nickname || '',
        notes: updatedTrip?.notes || '',
        tags: normalizeTripTags(updatedTrip || {}),
      });
      setEditingMetadata(false);
    },
  });
  const feedbackMutation = useMutation({
    mutationFn: async (/** @type {{eventKey:string, event:any, verdict:string}} */ vars) => {
      const existing = trip?.event_feedback || {};
      await tripService.update(id, {
        event_feedback: {
          ...existing,
          [vars.eventKey]: {
            verdict: vars.verdict,
            type: vars.event?.type || 'unknown',
            timestamp: vars.event?.timestamp || null,
            value: vars.event?.value ?? null,
            reviewed_at: new Date().toISOString(),
          },
        },
        needs_rescore: true,
        feedback_reviewed_at: new Date().toISOString(),
      });
      return tripService.getById(id);
    },
    onSuccess: (updatedTrip, vars) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
      setFeedbackStatus(vars.verdict === 'wrong'
        ? 'Marked wrong. This event is removed from scoring on rescore and used to raise future thresholds.'
        : 'Marked accurate. This event stays in scoring and helps keep calibration from becoming too loose.');
      setTimeout(() => setFeedbackStatus(''), 6000);
    },
  });
  const contextMutation = useMutation({
    mutationFn: async () => {
      setOsmFetchStatus('Preparing road data');
      const patch = await buildOpenSourceTripContextPatch(trip, localSettings.get(), {
        onProgress: setOsmFetchStatus,
      });
      return tripService.update(id, patch);
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) qc.setQueryData(['trip', id], updatedTrip);
      qc.invalidateQueries({ queryKey: ['trip', id] });
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
      qc.invalidateQueries({ queryKey: ['map-trips'] });
    },
    onError: (error) => {
      setOsmFetchStatus(error?.message || 'Could not get road data');
    },
    onSettled: () => {
      setTimeout(() => setOsmFetchStatus(''), 2500);
    },
  });
  const [dismissedTags, setDismissedTags] = useState([]);

  const confirmAndFetchRoadContext = () => {
    const latestSettings = localSettings.get();
    if (typeof window !== 'undefined' && !window.confirm(buildRoadContextPrivacyMessage(latestSettings))) {
      return;
    }
    contextMutation.mutate();
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
    const zones = inferSpeedZones(points);
    const byZone = new Map();
    for (let i = 1; i < points.length; i++) {
      const zone = zones.find((item) => i >= item.startIndex && i <= item.endIndex);
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
  }, [trip]);
  const fatigueHeatmapData = useMemo(() => (
    trip ? buildFatigueHeatmapData(trip) : []
  ), [trip]);
  const routeRiskSegments = useMemo(() => (
    trip ? getSegmentsForTrip(trip, routeRiskIndex).filter((segment) => segment.riskLevel === 'high' || segment.riskLevel === 'moderate') : []
  ), [routeRiskIndex, trip]);
  const displayedRouteRiskSegments = showAllRouteRiskSegments
    ? routeRiskSegments
    : routeRiskSegments.slice(0, MAX_ROUTE_RISK_SEGMENTS_SHOWN);
  const hiddenRouteRiskSegmentCount = routeRiskSegments.length - displayedRouteRiskSegments.length;

  useEffect(() => {
    loadRouteRiskIndex().then(setRouteRiskIndex);
  }, []);

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

  const { color, label: scoreLabel, bg } = getScoreColor(trip.score_overall || 0);
  const tripVehicle = vehicles.find((vehicle) => String(vehicle.id) === String(trip.vehicle_id));
  const economics = estimateTripEconomics(trip, tripVehicle, settings);
  const fatigueRisk = calculateFatigueRisk([trip], settings);
  const tagSuggestion = suggestTripTag(trip);
  const tripTags = normalizeTripTags(trip);
  const tripTitle = getTripDisplayName(trip);
  const showTagSuggestion = dismissedTagsLoaded && tripTags.length === 0 &&
    ['high', 'medium'].includes(tagSuggestion.auto_tag_confidence) &&
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
    metadataMutation.mutate({
      nickname: metadataDraft.nickname.trim(),
      notes: metadataDraft.notes.trim(),
      tags,
      tag: tags[0] || null,
      tag_reviewed: true,
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
      tags: normalizeTripTags([...draft.tags, tagSuggestion.auto_tag]),
    }));
    requestAnimationFrame(() => {
      metadataSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };
  const roadCfg = roadTypeConfig[trip.road_type];
  const dominantRoadCfg = roadTypeConfig[trip.dominant_road_type] || roadCfg;
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
  const roadConditionLabel = {
    likely_wet: 'Likely Wet',
    possible_wet: 'Possibly Wet',
    appears_dry: 'Dry',
    insufficient_data: 'Not Enough Data',
  }[trip.slippery_proxy] || null;
  const weatherContext = trip.weather_context || null;
  const speedLimitContext = trip.speed_limit_context || null;
  const mapMatchingContext = trip.map_matching_context || null;
  const osmSpeedLimitPoints = (trip.route_points || []).filter((point) => (
    ['openstreetmap', 'osm_highway_default'].includes(point.speed_limit_source) &&
    Number.isFinite(Number(point.speed_limit_kmh))
  ));
  const osmSpeedLimits = [...new Set(osmSpeedLimitPoints.map((point) => Number(point.speed_limit_kmh)).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  const sensorFusionSummary = trip.sensor_fusion_summary || null;
  const driverAnomaly = trip.driver_anomaly || null;
  const possibleIncidentEvents = (trip.driving_events || []).filter((event) => event.type === 'possible_crash');
  const displayPhoneUse = buildPhoneUseFromTripEvidence(trip, trip.route_points || [], trip.duration_seconds || 0, {});
  const phoneUseWindows = displayPhoneUse.phone_use_events || [];
  const phoneUseRisk = displayPhoneUse.phone_use_risk || trip.phone_use_risk || 'none';
  const showPhoneUse = (displayPhoneUse.phone_use_window_count || trip.phone_use_window_count || phoneUseWindows.length || 0) > 0 || phoneUseRisk !== 'none';
  const phoneUseScoreForImpactRaw = displayPhoneUse.phone_use_score ?? trip.phone_use_score ?? 100;
  const phoneUseScoreForImpact = Number.isFinite(Number(phoneUseScoreForImpactRaw)) ? Math.max(0, Math.min(100, Number(phoneUseScoreForImpactRaw))) : 100;
  // Keep this estimate aligned with calculateTripScores' phoneUseScoreForSafety blend.
  const phoneUseSafetyImpactPoints = Math.max(1, Math.round(Math.max(0, 100 - phoneUseScoreForImpact) * PHONE_USE_SAFETY_WEIGHT));
  const avgPhoneUseSpeed = phoneUseWindows.length
    ? Math.round(phoneUseWindows.reduce((sum, event) => sum + (Number(event.speed_kmh) || 0), 0) / phoneUseWindows.length)
    : 0;
  const phoneUseRiskClass = {
    high: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/60',
    medium: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800/60',
    low: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60',
    none: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60',
  }[phoneUseRisk] || 'bg-secondary text-muted-foreground border-border';
  const displayEvents = mergePhoneUseEventsIntoDrivingEvents(trip.driving_events || [], displayPhoneUse);
  const eventFeedback = trip.event_feedback || {};
  const eventFeedbackKey = (event, index) => [
    event.type || 'event',
    event.timestamp || index,
    Number.isFinite(Number(event.value)) ? Number(event.value).toFixed(2) : '',
  ].join('|');
  const feedbackCounts = Object.values(eventFeedback).reduce((counts, item) => {
    if (item?.verdict === 'accurate') counts.accurate += 1;
    if (item?.verdict === 'wrong') counts.wrong += 1;
    return counts;
  }, { accurate: 0, wrong: 0 });
  const mapEvents = settings.phone_use_show_on_map === false
    ? displayEvents.filter((event) => event.type !== 'phone_use')
    : displayEvents;
  const fatigueChartData = Array.isArray(trip.segment_scores) && trip.segment_scores.length === 3
    ? [
      { label: 'First', score: trip.segment_scores[0] },
      { label: 'Middle', score: trip.segment_scores[1] },
      { label: 'Last', score: trip.segment_scores[2] },
    ]
    : [];
  const fatigueColor = trip.fatigue_progression === 'significant'
    ? '#ef4444'
    : trip.fatigue_progression === 'moderate'
      ? '#f59e0b'
      : '#22c55e';
  const primaryAvgSpeedKmh = trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0;
  // FIX: Use moving average speed as the primary Avg Speed metric.
  const showOverallAvgSpeed = (trip.idle_time_seconds || 0) > 60;
  // FIX: Show overall average only when there was meaningful stopped time.
  const trafficIdleSeconds = trip.traffic_idle_seconds ?? Math.max(0, (trip.idle_time_seconds || 0) - (trip.sustained_idle_seconds || 0));
  const parkedIdleSeconds = trip.sustained_idle_seconds ?? Math.max(0, (trip.idle_time_seconds || 0) - trafficIdleSeconds);
  const terminalParkedSeconds = trip.parking_stop_duration_seconds || 0;
  const unavailableEstimate = '—';
  const fuelSavedValue = economics.vehicle_profile_available
    ? `${economics.fuel_saved_liters.toFixed(2)} L`
    : unavailableEstimate;
  const co2SavedValue = Number.isFinite(Number(economics.co2_saved_kg))
    ? `${economics.co2_saved_kg} kg`
    : unavailableEstimate;
  const tripEndState = trip.parking_stop_detected
    ? 'Parked'
    : terminalParkedSeconds > 0
      ? 'Stopped'
      : 'Ended while moving';
  const tripMapPointCount = trip.route_points?.length || 0;
  const tripRawPointCount = Number(trip.route_points_raw_count) || tripMapPointCount;
  const tripPointSummary = tripRawPointCount !== tripMapPointCount
    ? `${tripRawPointCount} recorded GPS readings - ${tripMapPointCount} map/playback points`
    : `${tripMapPointCount} GPS readings`;
  const speedLimitLayerEffect = osmSpeedLimitPoints.length > 0
    ? 'The speed-limit layer recolors this route: green is within the matched/default limit, orange is over, red is well over.'
    : speedLimitContext?.status === 'unavailable'
      ? speedLimitContext.error || 'The OSM speed-limit lookup failed, so this map is still using GPS speed bands and fallback scoring thresholds.'
    : speedLimitContext
      ? 'Road data was checked, but no usable speed limits are available for this trip, so the speed-limit layer cannot visibly change the map yet.'
      : 'Before getting road data, this map shows GPS speed bands and event markers only.';

  return (
    <div className="space-y-5 pb-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <button
          onClick={() => navigate('/trips')}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm">Back</span>
        </button>
        <div className="flex gap-2">
          {parkStops.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity">
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
          <button
            onClick={() => metadataMutation.mutate({ is_favorite: trip.is_favorite !== true })}
            title={trip.is_favorite ? 'Remove favorite' : 'Favorite trip'}
            className={`p-2 rounded-xl transition-colors ${
              trip.is_favorite ? 'text-amber-500 bg-amber-50 dark:bg-amber-950/30' : 'text-muted-foreground hover:bg-secondary'
            }`}
          >
            <Star className={`w-4 h-4 ${trip.is_favorite ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={() => {
              if (confirm('Delete this trip? This cannot be undone.')) deleteMutation.mutate();
            }}
            className="p-2 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 rounded-xl transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </motion.div>

      {showTagSuggestion && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-primary/5 border border-primary/20 rounded-2xl p-3 flex items-center gap-3"
        >
          <Tag className="w-4 h-4 text-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Suggested tag: {getTripTagOption(tagSuggestion.auto_tag)?.label || tagSuggestion.auto_tag}</div>
            <div className="text-xs text-muted-foreground capitalize">{tagSuggestion.auto_tag_confidence} confidence</div>
          </div>
          <button
            onClick={() => tagMutation.mutate(tagSuggestion.auto_tag)}
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
      )}

      {(trip.near_miss_count || 0) > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300">
          {trip.near_miss_count} estimated close-proximity alert{trip.near_miss_count === 1 ? '' : 's'} on this trip. Review your route for possible hazardous zones.
        </div>
      )}

      {possibleIncidentEvents.length > 0 && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Possible crash / incident detected
          </div>
          <div className="mt-1 text-xs">
            Impact-like motion and low movement were recorded. {trip.emergency_workflow_acknowledged_at ? `Emergency check-in was acknowledged (${trip.emergency_workflow_acknowledged_action || 'ok'}).` : possibleIncidentEvents.some((event) => event.emergency_workflow_pending) ? 'Emergency check-in was active for this trip.' : 'Review the trip timeline and notes while the details are fresh.'}
          </div>
        </div>
      )}

      {['possible', 'likely'].includes(trip.phone_proxy_risk) && (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm font-medium text-yellow-700 dark:border-yellow-800/50 dark:bg-yellow-950/30 dark:text-yellow-300">
          Possible phone distraction detected ({trip.phone_proxy_count || 0} instance{(trip.phone_proxy_count || 0) === 1 ? '' : 's'}). Consider enabling Do Not Disturb while driving.
        </div>
      )}

      {(trip.overtake_event_count || 0) > 0 && (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-3 text-sm font-medium text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300">
          Aggressive overtaking detected. This pattern significantly increases collision risk.
        </div>
      )}

      {roadConditionLabel && trip.slippery_proxy !== 'insufficient_data' && (
        <div
          title="Road condition is inferred from stopping-distance patterns and is not a weather measurement."
          className="flex items-center gap-2 rounded-2xl border border-border bg-card p-3 text-sm font-medium"
        >
          <Droplets className={`h-4 w-4 ${trip.slippery_proxy === 'appears_dry' ? 'text-emerald-500' : 'text-sky-500'}`} />
          <span>Road Conditions: {roadConditionLabel}</span>
          {(trip.safety_condition_bonus || 0) > 0 && (
            <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              +{trip.safety_condition_bonus} safety context
            </span>
          )}
        </div>
      )}

      {(weatherContext || speedLimitContext || mapMatchingContext || sensorFusionSummary || driverAnomaly) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {weatherContext && (
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold">
                  <Droplets className="h-4 w-4 text-sky-500" />
                  Weather context
                </div>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize">
                  {weatherContext.riskLevel || 'low'} risk
                </span>
              </div>
              <div className="mt-2 text-xs text-muted-foreground capitalize">
                {String(weatherContext.condition || 'unknown').replace(/_/g, ' ')}
                {weatherContext.avg_temp_c != null ? ` · ${weatherContext.avg_temp_c}°C` : ''}
                {weatherContext.precipitation_mm ? ` · ${weatherContext.precipitation_mm} mm precip` : ''}
              </div>
              {trip.weather_score_adjustment < 0 && (
                <div className="mt-2 text-xs font-semibold text-orange-600 dark:text-orange-300">
                  Score adjusted {trip.weather_score_adjustment} for harsh events in poor conditions.
                </div>
              )}
            </div>
          )}
          {speedLimitContext && (
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
                {describeOsmSpeedLimitStatus(speedLimitContext)} {osmSpeedLimits.length ? `Detected/default limits: ${osmSpeedLimits.join(', ')} km/h.` : 'GPS fallback thresholds fill gaps.'}
              </div>
              {speedLimitContext.error && (
                <div className="mt-1 text-xs text-orange-600 dark:text-orange-300">{speedLimitContext.error}</div>
              )}
            </div>
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
              <div className="mt-2 text-xs text-muted-foreground">
                {describeMapMatchingStatus(mapMatchingContext)}
              </div>
            </div>
          )}
          {sensorFusionSummary && (
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
                {sensorFusionSummary.sample_count || 0} motion samples · peak {sensorFusionSummary.peak_linear_ms2 || 0} m/s² · phone movement {sensorFusionSummary.phone_movement_score || 0}/100.
              </div>
            </div>
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
                Anomaly score {driverAnomaly.anomaly_score ?? 0}/100
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
          className="bg-card border border-border rounded-3xl p-5 shadow-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Phone Use Analysis</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Android Usage Access when enabled, with GPS behaviour fallback.
              </p>
            </div>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${phoneUseRiskClass}`}>
              {phoneUseRisk}
            </span>
          </div>

          {phoneUseRisk === 'none' ? (
            <div className="mt-4 rounded-2xl bg-emerald-50 p-3 text-sm font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              No phone use patterns detected this trip.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Smartphone className="mb-2 h-4 w-4 text-red-500" />
                  <div className="font-grotesk text-2xl font-bold">{displayPhoneUse.phone_use_window_count || trip.phone_use_window_count || phoneUseWindows.length}</div>
                  <div className="text-xs text-muted-foreground">windows detected</div>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Clock className="mb-2 h-4 w-4 text-orange-500" />
                  <div className="font-grotesk text-2xl font-bold">{Math.round(displayPhoneUse.phone_use_total_seconds || trip.phone_use_total_seconds || 0)}s</div>
                  <div className="text-xs text-muted-foreground">estimated duration</div>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Gauge className="mb-2 h-4 w-4 text-blue-500" />
                  <div className="font-grotesk text-2xl font-bold">{avgPhoneUseSpeed || '-'}</div>
                  <div className="text-xs text-muted-foreground">avg km/h during detection</div>
                </div>
                <div className="rounded-2xl bg-secondary/50 p-3">
                  <Focus className="mb-2 h-4 w-4 text-violet-500" />
                  <div className="font-grotesk text-2xl font-bold">{Math.round((displayPhoneUse.phone_use_pct_of_trip || trip.phone_use_pct_of_trip || 0) * 10) / 10}%</div>
                  <div className="text-xs text-muted-foreground">of trip time</div>
                </div>
              </div>

              <details className="rounded-2xl bg-secondary/50 p-3">
                <summary className="cursor-pointer list-none text-sm font-semibold">Window breakdown</summary>
                <div className="mt-3 space-y-2">
                  {phoneUseWindows.map((event, index) => (
                    <div key={`${event.startTime || event.timestamp}-${index}`} className="rounded-xl bg-card p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold">
                          Window {index + 1} - {event.startTime ? new Date(event.startTime).toLocaleTimeString() : 'time unknown'}
                        </div>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold uppercase">
                          {event.confidence_level || 'medium'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {Math.round(event.durationS ?? event.duration_seconds ?? 0)} seconds - {Math.round(event.speed_kmh || 0)} km/h
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Signals: {(event.signals_triggered || []).join(', ') || 'combined GPS behaviour'}
                        {event.source === 'android_usage_access' ? ' - real foreground app activity' : ''}
                      </div>
                      <button
                        type="button"
                        onClick={() => document.querySelector('.map-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                        className="mt-2 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                      >
                        View on map
                      </button>
                    </div>
                  ))}
                </div>
              </details>

              {settings.phone_use_affects_score !== false && phoneUseScoreForImpact < 95 && (
                <div className="rounded-xl bg-red-50 p-3 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  Phone use reduced your Safety score by about {phoneUseSafetyImpactPoints} point{phoneUseSafetyImpactPoints === 1 ? '' : 's'}.
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}

      {/* Map */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          <button
            onClick={confirmAndFetchRoadContext}
            disabled={contextMutation.isPending || !trip.route_points?.length}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors disabled:opacity-60"
          >
            <Route className="h-3.5 w-3.5" />
            {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : 'Get / Refresh Road Data'}
          </button>
          <button
            onClick={() => setShowSpeedLimitsOnMap((value) => !value)}
            disabled={osmSpeedLimitPoints.length === 0}
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
            {describeOsmSpeedLimitStatus(speedLimitContext)} Tap Get Road Data to add speed limits and weather for this trip. Route snapping runs only if OSRM is enabled in Settings.
          </div>
        )}
        <div className="mb-2 rounded-2xl bg-secondary/40 p-3 text-xs text-muted-foreground">
          <div className="font-semibold text-foreground">Trip map buttons</div>
          <div className="mt-1 break-words">
            {tripPointSummary}. Get Road Data checks online map/weather services for this trip. Show Speed-Limit Layer only changes the colors after speed limits are available.
          </div>
          <div className="mt-2 grid gap-1">
            <div>Get Road Data: checks the enabled options below for this trip.</div>
            <div>Speed limits {settings.speed_limit_lookup_enabled === false ? 'OFF' : 'ON'}: {settings.speed_limit_lookup_enabled === false ? 'skips OpenStreetMap; the app uses GPS/fallback limits.' : 'sends route-area boxes to OpenStreetMap for road names and posted/default limits.'}</div>
            <div>Weather {settings.weather_context_enabled === false ? 'OFF' : 'ON'}: {settings.weather_context_enabled === false ? 'skips Open-Meteo; scores get no weather adjustment.' : 'sends trip midpoint and date to Open-Meteo.'}</div>
            <div>Snap to roads {settings.map_matching_enabled === false ? 'OFF' : settings.osrm_map_matching_url ? 'ON' : 'NEEDS LINK'}: {settings.map_matching_enabled === false ? 'skips OSRM; map/playback keep the GPS line.' : settings.osrm_map_matching_url ? 'sends sampled GPS points to OSRM to clean up the route line.' : 'skips OSRM until an endpoint is set in Settings.'}</div>
            <div>Show Speed-Limit Layer: only changes colors after speed limits are available.</div>
            <div>Cornering Heatmap: local-only visual overlay for sharper turns.</div>
          </div>
          <div className="mt-2 rounded-xl bg-background/60 px-3 py-2 font-medium text-foreground">
            {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : speedLimitLayerEffect}
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
        <div className="rounded-2xl overflow-hidden border border-border shadow-sm">
          <TripMap
            routePoints={trip.route_points || []}
            events={mapEvents}
            showCorneringHeatmap={showCorneringHeatmap}
            showSpeedLimits={showSpeedLimitsOnMap}
            showRouteRisk={routeRiskSegments.length > 0}
            routeRiskSegments={routeRiskSegments}
            rawPointCount={trip.route_points_raw_count}
            height="300px"
          />
        </div>
      </motion.div>

      <motion.div
        ref={metadataSectionRef}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-3xl border border-border bg-card p-5 shadow-sm"
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
              <div className="mb-2 text-xs font-medium text-muted-foreground">Tags</div>
              <div className="flex flex-wrap gap-2">
                {TRIP_TAG_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => toggleDraftTag(option.id)}
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
                  return (
                    <span key={tagId} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${option?.className || 'bg-secondary text-muted-foreground border-border'}`}>
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
        <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
          <h2 className="font-semibold mb-3">Route history</h2>
          <div className="space-y-2">
            {displayedRouteRiskSegments.map((segment, index) => {
              const perPass = segment.tripCount ? segment.totalEvents / segment.tripCount : 0;
              return (
                <div key={`${segment.from.lat}-${segment.to.lat}-${index}`} className="flex gap-3 rounded-2xl bg-secondary/50 p-3">
                  <span className={`mt-1 h-3 w-3 rounded-full ${segment.riskLevel === 'high' ? 'bg-red-500' : 'bg-orange-500'}`} />
                  <div className="text-sm">
                    <div className="font-semibold capitalize">{segment.riskLevel}-risk stretch</div>
                    <div className="text-xs text-muted-foreground">
                      You've driven through this area {segment.tripCount} times. Average {perPass.toFixed(1)} events per pass · mostly {(segment.dominantEventType || 'risk events').replace(/_/g, ' ')}
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
        <TripScoreOverview trip={trip} />
      </SectionErrorBoundary>
      {roadTypeScores.length > 0 && (
        <motion.details
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          className="bg-card border border-border rounded-3xl p-5 shadow-sm"
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
                    <span className={`font-semibold ${scoreColor}`} title={buildScoreExplanation(trip, 'score_overall')}>{data.overall}</span>
                  </div>
                  <div className="h-2 rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(0, Math.min(100, data.overall || 0))}%` }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDistance(data.distance_km || 0, units)} analyzed, {data.event_count || 0} event{(data.event_count || 0) === 1 ? '' : 's'}
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
        className="bg-card border border-border rounded-3xl p-5 shadow-sm space-y-4"
      >
        <h2 className="font-semibold">Trip Details</h2>

        <div className="grid grid-cols-2 gap-4">
          {[
            { icon: Navigation, label: 'Distance', value: formatDistance(trip.distance_km || 0, units) },
            { icon: Clock, label: 'Duration', value: formatDuration(trip.duration_seconds) },
            {
              icon: Gauge,
              label: 'Avg Speed',
              value: formatSpeed(primaryAvgSpeedKmh, units),
              subValue: showOverallAvgSpeed ? `Overall avg (incl. stops): ${formatSpeed(trip.avg_speed_kmh || 0, units)}` : null,
            },
            // FIX: Add overall average as a secondary line while keeping moving speed primary.
            { icon: Gauge, label: 'Max Speed', value: formatSpeed(trip.max_speed_kmh || 0, units) },
            { icon: Fuel, label: 'Fuel Cost', value: formatCurrencyAmount(economics.cost, settings), subValue: economics.estimate_label },
            { icon: Leaf, label: 'Fuel Saved', value: fuelSavedValue, subValue: economics.vehicle_profile_available ? 'Eco-driving effect capped at 8%.' : 'Assign a vehicle to estimate savings.' },
            { icon: Leaf, label: 'CO2', value: `${economics.co2_kg.toFixed(1)} kg`, subValue: economics.estimate_label },
            { icon: Leaf, label: 'CO2 Saved vs Average', value: co2SavedValue, subValue: economics.co2_saved_label },
            { icon: ParkingSquare, label: 'Parking', value: `${trip.parking_approach_score ?? 100}` },
            { icon: TimerReset, label: 'Traffic Stops', value: formatDuration(trafficIdleSeconds) },
            { icon: ParkingSquare, label: 'Parked Idle', value: formatDuration(parkedIdleSeconds) },
            { icon: MapPin, label: 'Trip End', value: tripEndState, subValue: terminalParkedSeconds > 0 ? `${formatDuration(terminalParkedSeconds)} at final stop` : null },
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
          {trip.night_driving && (
            <div className="flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400">
              <Moon className="w-4 h-4" />
              <span>Night driving detected</span>
            </div>
          )}
          {roadCfg && (
            <div className={`inline-flex w-fit items-center gap-2 text-sm border rounded-full px-3 py-1 ${roadCfg.className}`}>
              <RoadIcon className="w-4 h-4" />
              <span>{roadCfg.label} route</span>
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
          className="bg-card border border-border rounded-3xl p-5 shadow-sm"
        >
          <h2 className="font-semibold mb-3">Speed Zones</h2>
          <div className="space-y-2">
            {speedZoneSummary.map((zone) => (
              <div key={zone.inferredZone} className="flex items-center justify-between rounded-xl bg-secondary/50 p-3">
                <div>
                  <div className="text-sm font-semibold">{zone.inferredZoneKmh} km/h inferred</div>
                  <div className="text-xs text-muted-foreground capitalize">{zone.confidence} confidence</div>
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
                  {data.limit_source === 'openstreetmap' ? 'OSM maxspeed' : data.limit_source === 'osm_highway_default' ? 'OSM road-type default' : 'Inferred limit'} {data.inferred_limit_kmh} km/h, max excess {data.max_excess_kmh} km/h, score {data.score}
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
        className="bg-card border border-border rounded-3xl p-5 shadow-sm"
      >
        <h2 className="font-semibold mb-4">Driving Pattern</h2>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[
            { icon: MapPin, label: 'traffic stops', value: trip.traffic_stop_count ?? trip.stop_count ?? 0, color: 'text-primary' },
            { icon: AlertTriangle, label: 'fatigue risk', value: fatigueRisk.level, color: fatigueRisk.level === 'high' ? 'text-red-500' : fatigueRisk.level === 'medium' ? 'text-orange-500' : 'text-emerald-500', capitalize: true },
            { icon: Waves, label: 'jerk score', value: trip.jerk_score ?? '-', color: 'text-sky-500' },
            { icon: GitBranch, label: 'reaction', value: trip.avg_reaction_seconds ? `${trip.avg_reaction_seconds}s` : '-', color: ['reactive', 'delayed'].includes(trip.reaction_grade) ? 'text-red-500' : 'text-emerald-500' },
            { icon: Leaf, label: 'eco driving', value: trip.eco_driving_score ?? '-', color: 'text-emerald-500' },
            { icon: ShieldCheck, label: 'following score', value: trip.following_distance_score ?? '-', color: 'text-blue-500' },
            { icon: Focus, label: 'focus score', value: trip.distraction_score ?? '-', color: 'text-violet-500' },
            { icon: TimerReset, label: 'intersection score', value: trip.intersection_score ?? '-', color: 'text-amber-500' },
            { icon: Gauge, label: 'SVI', value: trip.speed_variability_index ?? '-', color: 'text-indigo-500' },
            { icon: Fuel, label: 'fuel band', value: trip.fuel_band_score ?? '-', color: 'text-lime-500' },
            { icon: Car, label: 'engine stress', value: trip.engine_stress_score ?? '-', color: 'text-orange-500' },
            { icon: ParkingSquare, label: 'parking', value: trip.parking_approach_grade ?? '-', color: 'text-slate-500', capitalize: true },
            { icon: AlertTriangle, label: 'drowsy risk', value: trip.drowsy_risk_level ?? 'none', color: trip.drowsy_risk_level === 'high' ? 'text-red-500' : trip.drowsy_risk_level === 'medium' ? 'text-orange-500' : 'text-emerald-500', capitalize: true },
            ...(trip.hill_driving_score != null ? [{ icon: Milestone, label: 'hill control', value: trip.hill_driving_score, color: 'text-emerald-500' }] : []),
          ].map(({ icon: Icon, label, value, color, capitalize }) => (
            <div key={label} className="bg-secondary/50 rounded-xl p-3">
              <Icon className={`w-4 h-4 mb-2 ${color}`} />
              <div className={`font-grotesk font-bold text-xl ${capitalize ? 'capitalize' : ''}`}>{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        {fatigueHeatmapData.length > 0 ? (
          <div className="mb-4 bg-secondary/50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Fatigue progression</div>
              <span className="text-xs text-muted-foreground">fatigue level 0-100</span>
            </div>
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
          </div>
        ) : fatigueChartData.length === 3 && (
          <div className="mb-4 bg-secondary/50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Driving quality over trip</div>
              <span className="text-xs text-muted-foreground">{fatigueText[trip.fatigue_progression] || trip.fatigue_progression}</span>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={fatigueChartData} margin={{ top: 5, right: 0, bottom: 0, left: -28 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Area type="monotone" dataKey="score" stroke={fatigueColor} fill={fatigueColor} fillOpacity={0.18} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {(Number.isFinite(trip.braking_efficiency_score) || Number.isFinite(trip.smooth_braking_ratio)) && (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium">Braking Efficiency</span>
              <span className="font-semibold capitalize">
                {trip.braking_efficiency_grade?.replace('_', ' ') || `${trip.smooth_braking_ratio}% smooth`}
              </span>
            </div>
            {Number.isFinite(trip.braking_efficiency_score) && (
              <div className="mb-2 flex items-baseline gap-2">
                <span className="font-grotesk text-2xl font-bold">{trip.braking_efficiency_score}</span>
                <span className="text-xs text-muted-foreground">
                  {trip.braking_sequence_count || 0} stop sequence{(trip.braking_sequence_count || 0) === 1 ? '' : 's'}, smoothness {Math.round((trip.avg_braking_smoothness || 0) * 100)}%
                </span>
              </div>
            )}
            <div className="h-2 overflow-hidden rounded-full bg-background">
              <div
                className={`h-full rounded-full ${
                  (trip.braking_efficiency_score ?? trip.smooth_braking_ratio) >= 80 ? 'bg-emerald-500' : (trip.braking_efficiency_score ?? trip.smooth_braking_ratio) >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                }`}
                style={{ width: `${Math.max(0, Math.min(100, trip.braking_efficiency_score ?? trip.smooth_braking_ratio))}%` }}
              />
            </div>
          </div>
        )}

        {trip.hill_driving_score != null && (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3 text-sm">
            <div className="font-medium">Hill Control</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {trip.climb_distance_km ?? 0} km climbing, {trip.descent_distance_km ?? 0} km descending. Use engine braking on descents rather than braking repeatedly.
            </div>
          </div>
        )}

        {trip.cornering_consistency_score != null && (
          <div className="mb-4 rounded-xl bg-secondary/50 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium">Cornering</div>
              <span className="rounded-full bg-card px-2 py-0.5 text-xs font-semibold capitalize">
                {trip.cornering_grade}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-card p-2">
                <div className="font-grotesk text-lg font-bold">{trip.cornering_consistency_score}</div>
                <div className="text-[11px] text-muted-foreground">score</div>
              </div>
              <div className="rounded-lg bg-card p-2">
                <div className="font-grotesk text-lg font-bold">{trip.mean_lateral_g}</div>
                <div className="text-[11px] text-muted-foreground">mean g</div>
              </div>
              <div className="rounded-lg bg-card p-2">
                <div className="font-grotesk text-lg font-bold">{trip.peak_lateral_g}</div>
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
            {trip.traffic_stop_count ?? trip.stop_count} traffic stops detected. No extended stopped periods were recorded.
          </div>
        ) : (
          <div className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
            No traffic stops or extended stopped periods detected on this trip.
          </div>
        )}
      </motion.div>

      {/* Driving Events */}
      {displayEvents.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-card border border-border rounded-3xl p-5 shadow-sm"
        >
          <h2 className="font-semibold mb-4">
            Driving Events
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {displayEvents.length} detected
            </span>
          </h2>
          {(feedbackCounts.accurate > 0 || feedbackCounts.wrong > 0) && (
            <div className="mb-4 rounded-2xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              Detection feedback: <span className="font-semibold text-emerald-600 dark:text-emerald-300">{feedbackCounts.accurate} accurate</span>
              <span className="mx-1">/</span>
              <span className="font-semibold text-red-600 dark:text-red-300">{feedbackCounts.wrong} needs review</span>
              {trip.feedback_adjusted_events_count > 0 && (
                <span className="ml-1">/ {trip.feedback_adjusted_events_count} removed from scoring</span>
              )}
            </div>
          )}
          {feedbackStatus && (
            <div className="mb-4 rounded-2xl border border-border bg-card p-3 text-xs font-medium text-muted-foreground">
              {feedbackStatus}
            </div>
          )}

          {/* Summary counts */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { label: 'Harsh Brakes', value: trip.harsh_brakes_count, icon: TrendingDown, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
              { label: 'Rapid Accel', value: trip.rapid_accel_count, icon: Zap, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
              { label: 'Sharp Turns', value: trip.sharp_turns_count, icon: CornerUpRight, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
              { label: 'Speeding', value: trip.speeding_events_count, icon: AlertTriangle, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
              { label: 'Lane Changes', value: trip.lane_changes_count, icon: Shuffle, color: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800/50' },
              { label: 'Tailgate', value: trip.tailgate_cycle_count, icon: ShieldCheck, color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
              { label: 'Erratic Speed', value: trip.distraction_events_count, icon: Focus, color: 'text-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950/30' },
              { label: 'Close Proximity', value: trip.near_miss_count, icon: ShieldCheck, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
              { label: 'Overtakes', value: trip.overtake_event_count, icon: Zap, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
              ...(trip.overtake_count > 0 ? [{ label: 'Overtake Quality', value: trip.overtake_quality_score ?? '-', icon: Shuffle, color: 'text-sky-500', bg: 'bg-sky-50 dark:bg-sky-950/30' }] : []),
            ].map(({ label, value, icon: Icon, color, bg }) => (
              <div key={label} className={`${bg} rounded-xl p-3 flex items-center gap-3`}>
                <Icon className={`w-5 h-5 ${color}`} />
                <div>
                  <div className={`font-grotesk font-bold text-xl ${color}`}>{value || 0}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Event list */}
          <div className="space-y-2 max-h-64 overflow-y-auto thin-scrollbar">
            {displayEvents.map((evt, i) => {
              const key = eventFeedbackKey(evt, i);
              const feedback = eventFeedback[key]?.verdict || null;
              const labels = {
                harsh_brake: { label: 'Harsh Brake', icon: '🛑', color: 'text-red-600' },
                rapid_acceleration: { label: 'Rapid Acceleration', icon: '⚡', color: 'text-yellow-600' },
                sharp_turn: { label: 'Sharp Turn', icon: '↰', color: 'text-blue-600' },
                speeding: { label: 'Speeding', icon: '🚀', color: 'text-orange-600' },
                idle: { label: 'Excessive Idle', icon: '⏸', color: 'text-slate-500' },
                near_miss: { label: 'Close Proximity', icon: '!', color: 'text-red-700' },
                close_proximity: { label: 'Close Proximity', icon: '!', color: 'text-red-700' },
                aggressive_overtake: { label: 'Aggressive Overtake', icon: '>>', color: 'text-orange-600' },
                lane_change: { label: 'Lane Change', icon: '<>', color: 'text-sky-600' },
                tailgate_cycle: { label: 'Tailgate Cycle', icon: '!!', color: 'text-red-600' },
                erratic_speed: { label: 'Erratic Speed', icon: '~', color: 'text-yellow-600' },
                possible_crash: { label: 'Possible Incident', icon: '!!', color: 'text-red-700' },
                phone_use: { label: 'Phone Use', icon: 'P', color: 'text-red-600' },
              };
              const cfg = labels[evt.type] || { label: evt.type, icon: '⚠', color: 'text-foreground' };
              const eventValueText = evt.type === 'possible_crash'
                ? `${Math.round(evt.speed_before_kmh || 0)} km/h before - ${evt.peak_linear_ms2 || 0} m/s2 peak`
                : evt.type === 'phone_use'
                  ? `${Math.round(evt.durationS ?? evt.duration_seconds ?? 0)}s at ${Math.round(evt.speed_kmh || 0)} km/h`
                  : `${evt.value?.toFixed?.(1) ?? '-'} ${evt.type === 'idle' ? 's' : evt.type === 'speeding' ? 'km/h' : 'm/s2'}`;
              const inferredTypes = ['lane_change', 'tailgate_cycle', 'erratic_speed', 'phone_use', 'near_miss', 'close_proximity', 'aggressive_overtake'];
              const confidenceText = evt.source === 'android_usage_access'
                ? 'Measured phone activity'
                : evt.type === 'speeding' && evt.speed_limit_source
                  ? `Limit from ${String(evt.speed_limit_source).replace(/_/g, ' ')}`
                  : inferredTypes.includes(evt.type)
                    ? `${evt.confidence_level || evt.zone_confidence || 'medium'} confidence GPS inference`
                    : 'Measured from GPS motion';
              return (
                <div key={i} className="flex flex-col gap-2 py-2 border-b border-border/50 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{cfg.icon}</span>
                    <div>
                      <div className={`text-sm font-medium ${cfg.color}`}>{cfg.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(evt.timestamp).toLocaleTimeString()} - {eventValueText}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{confidenceText}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-8 sm:pl-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize
                      ${evt.severity === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400' :
                        evt.severity === 'medium' ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400' :
                        'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400'}`}>
                      {evt.severity}
                    </span>
                    {[
                      { id: 'accurate', label: 'Accurate', className: 'border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300' },
                      { id: 'wrong', label: 'Wrong', className: 'border-red-200 text-red-700 dark:border-red-900/60 dark:text-red-300' },
                    ].map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => feedbackMutation.mutate({ eventKey: key, event: evt, verdict: option.id })}
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                          feedback === option.id ? `${option.className} bg-background` : 'border-border text-muted-foreground hover:bg-secondary'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
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

function TripScoreOverview({ trip }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className="bg-card border border-border rounded-3xl p-5 shadow-sm"
    >
      <div className="flex items-center gap-6">
        <ScoreRing
          score={trip.score_overall || 0}
          size={100}
          strokeWidth={8}
          sublabel="overall"
          title={buildScoreExplanation(trip, 'score_overall')}
        />
        <div className="flex-1 grid grid-cols-3 gap-3">
          {[
            { label: 'Safety', key: 'score_safety', value: trip.score_safety },
            { label: 'Smooth', key: 'score_smoothness', value: trip.score_smoothness },
            { label: 'Eco', key: 'score_eco', value: trip.score_eco },
          ].map(({ label, key, value }) => {
            const { color: c } = getScoreColor(value || 0);
            return (
              <div key={label} className="text-center" title={buildScoreExplanation(trip, key)}>
                <div className={`font-grotesk font-bold text-xl ${c}`}>{value ?? '-'}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 mt-5 sm:grid-cols-2">
        {[
          { label: 'Aggression', score: trip.aggressive_driving_score, grade: trip.aggressive_grade },
          { label: 'Defensive', score: trip.defensive_driving_score, grade: trip.defensive_grade },
        ].map(({ label, score, grade }) => (
          <div key={label} className="flex min-w-0 items-center gap-3 rounded-2xl bg-secondary/50 p-3">
            <div className="shrink-0">
              <ScoreRing
                score={score ?? 0}
                size={56}
                strokeWidth={5}
                title={buildScoreExplanation(trip, label === 'Aggression' ? 'aggressive_driving_score' : 'defensive_driving_score')}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-tight">{label}</div>
              <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                ['calm', 'exemplary', 'defensive'].includes(grade) ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' :
                  grade === 'moderate' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' :
                    ['assertive', 'average'].includes(grade) ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300' :
                      'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
              }`}>{grade || 'unknown'}</span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
