import {
  saveExportToDownloads
} from '../../lib/nativeDownloads.js';
import {
  clamp,
  pearsonCorrelation
} from '../../lib/mathUtils.js';
import {
  detectTripStops,
  estimateTripEconomics,
  FATIGUE_HEATMAP_SEGMENT_SECONDS
} from '../../lib/tripInsights.js';
import {
  maskEventCoordinatesForPrivacy,
  maskTripForPrivacy
} from '../../lib/privacyZones.js';
import {
  COMPONENT_METRIC_KEYS,
  CSV_METRIC_COLUMNS,
  METRIC_REGISTRY,
  formatMetricMetadata
} from '../../lib/metricRegistry.js';
import {
  NIGHT_END_HOUR,
  NIGHT_END_TIME,
  NIGHT_START_HOUR,
  NIGHT_START_TIME,
  FATIGUE_SAFETY_PENALTY_SCALE,
  FATIGUE_SAFETY_MAX_PENALTY,
  PENALTY_SCALE_FACTOR
} from '../../lib/appConstants.js';
import {
  SCORING_VERSION,
  SCORING_CONSTANTS,
  calibrationStatusForMetrics,
  getProvisionalScoringConstants,
  scoringValue
} from '../../lib/scoringConstants.js';
import {
  formatEstimatedScore,
  isEstimatedScoreMetric
} from '../../lib/scoreDisplay.js';
import {
  createScoringPipelineContext
} from '../../lib/scoring/pipeline.js';
import {
  explainScores
} from '../../lib/scoring/explainer.js';

import {
  CLOSE_PROXIMITY_DECAY_BASE,
  CONFIDENCE_LEVELS,
  DEFAULT_THRESHOLDS,
  ECO_DEFAULTS,
  ECO_SPEED_STABILITY_CV_MULTIPLIER,
  EVENT_PENALTIES,
  EVENT_TYPES,
  FATIGUE_SEGMENT_SECONDS,
  FUEL_BAND_FULL_SCORE_MULTIPLIER,
  HEADING_DRIFT_CIRCADIAN_MULTIPLIER,
  LEGACY_COMPONENT_FIELDS,
  MIN_BRAKE_ONSET_SMOOTHNESS_SEQUENCES,
  OBD_ECO_PENALTY_MAX,
  OBD_HIGH_THROTTLE_PCT,
  OBD_IDLE_RPM_MIN,
  OBD_OVER_REV_RPM,
  OBD_SPEED_FALLBACK_ACCURACY_M,
  OBD_SPEED_MAX_SAMPLE_AGE_MS,
  PHONE_USE_SAFETY_WEIGHT,
  PROVENANCE_THRESHOLD_KEYS,
  STOP_START_MAX_CYCLES_PER_5_KM,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN,
  STOP_START_MIN_HIGHWAY_DISTANCE_KM,
  STOP_START_MIN_URBAN_DISTANCE_KM,
  STOP_START_NORMALISATION_WINDOW_KM,
  SVI_DEFAULTS,
  TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH,
  TIRE_WEAR_DEFAULT_SPEED_TURN_KMH,
  buildDrivingThresholds,
  buildScoreConstantsSnapshot,
  buildScoreProvenance,
  cappedEvidenceLevel,
  componentConfidence,
  confidenceLevelFromNumeric,
  confidenceNumericValue,
  createComponentScore,
  ecoSettingNumber,
  getScoreProvenanceStatus,
  getTripComponentScore,
  isDiagnosticOnlyScoringEvent,
  normalizedEvidenceLevel,
  registeredComponentConfidence,
  reportedInvalidEcoThresholds,
  resolveEcoScoringConfig,
  settingNumber,
  stableSettingsFingerprint,
  weightedBlend
} from '../calibration/baseline.js';
import {
  CANDIDATE_TRIP_DEFAULTS,
  TRIP_STATES,
  accuracyMeters,
  activityConfidenceOf,
  activityTypeOf,
  calculateAcceleration,
  calculateBearing,
  calculateSegmentMetrics,
  calculateSpeedKmh,
  cleanRoutePoints,
  computeSmoothedAccelerations,
  countStableGpsPoints,
  finiteCoordinate,
  hasValidCoordinates,
  haversineDistance,
  haversineMeters,
  headingDiff,
  headingStdDev,
  isNearRecentParkedLocation,
  isStrongFootActivity,
  isVehicleActivity,
  movementNoiseFloorMeters,
  normalizeLocationPoint,
  parseTimestampMs,
  shouldAcceptLocationPoint,
  speedStdDev,
  timestampMs,
  toRad,
  trimParkedTail,
  validateCandidateTrip
} from '../utils/gps.js';
import {
  perpendicularDistanceMeters,
  simplifyRoute
} from '../route/downsampler.js';
import {
  average,
  calculateEstimatedPrivateDistanceKm,
  calculateRouteDistanceKm,
  calculateTerminalStoppedSeconds,
  classifyRoadType,
  classifyRoadTypesByPoint,
  createRoadTypeWindowSummary,
  createZoneLookup,
  finiteSpeed,
  finiteVehicleSpeed,
  gpsSpeedTimestampMs,
  inferSpeedZones,
  isLikelySpeedSpike,
  isPrivacyBoundaryPoint,
  nearestPointIndexByTimestamp,
  normalizeRoadTypeLabel,
  obdSpeedTimestampMs,
  percentileFromSorted,
  percentileValue,
  pointSpeedKmh,
  privacyZoneKey,
  reliablePointSpeed,
  roadTypeFromWindowSummary,
  round1,
  round2,
  safeMax,
  samePrivacyZoneBoundary,
  sortedInsert,
  sortedRemove,
  speedSourceForPoint,
  speedStdDevFromSummary,
  updateRoadTypeWindowSummary,
  vehicleSpeedKmh,
  zoneFromP85
} from '../route/osmLookup.js';
import {
  calculateEcoDrivingScore,
  calculateFuelBandScore,
  calculateHillDrivingScore,
  calculateJerkScore,
  calculateObdEcoSignals,
  calculateSpeedVariabilityIndex,
  standardDeviation,
  sviDistanceKm,
  unavailableSvi
} from '../scoring/ecoScore.js';
import {
  LANE_CHANGE_BILATERAL_WINDOW_S,
  LANE_CHANGE_EVENT_TYPE,
  LANE_CHANGE_GPS_MAX_DELTA_DEG,
  LANE_CHANGE_GPS_MIN_DELTA_DEG,
  LANE_CHANGE_MAX_GPS_ACCURACY_M,
  LANE_CHANGE_MAX_LATERAL_G,
  LANE_CHANGE_MAX_NET_HEADING_DEG,
  LANE_CHANGE_MAX_SPEED_DROP_KMH,
  LANE_CHANGE_MIN_LATERAL_G,
  LANE_CHANGE_MIN_SPEED_KMH,
  LANE_CHANGE_NO_BRAKE_MS2_THRESHOLD,
  calculateLaneChangingScore,
  detectHeadingDeviationEvents,
  detectHighwayMergeBehavior,
  detectLaneChanges,
  finiteSampleValue,
  firstPointAtOrAfter,
  headingBetweenPair,
  headingValueForLaneChange,
  normalizedLaneMotionSample,
  sampleTimestampMs,
  speedMaintainedInWindow
} from '../detection/harshAcceleration.js';
import {
  detectCloseProximityManeuverAlerts,
  detectNearMisses,
  detectStopStartPatterns,
  detectStopStartPatternsForMode,
  detectTailgateCycles,
  medianMovingSpeedKmh
} from '../detection/gpsTailgate.js';
import {
  calculateAngularStdDev,
  calculateWindowStats,
  detectErraticSpeedWindows,
  detectSpeedCreepWithThresholds,
  geometryHeadingForIndex,
  headingForIndex,
  headingVarianceForRange,
  isNearIntersectionOrRampContext,
  pointHasIntersectionOrRampContext,
  signedHeadingDelta,
  smoothHeading,
  stddev,
  usableHeadingSegment
} from '../detection/speeding.js';
import {
  BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS,
  BRAKING_GRADE_THRESHOLDS,
  analyzeIntersectionBehavior,
  analyzeParkingApproach,
  brakeOnsetSmoothnessGrade,
  brakingEfficiencyGrade,
  calculateBrakeOnsetSmoothness,
  calculateBrakingEfficiency,
  calculateCorneringConsistency,
  calculateOvertakeQualityScore,
  calculateReactionTimeProxy,
  calculateRoadTypeSegmentedScores,
  calculateSmoothBrakingRatio,
  calculateSpeedLimitCompliance,
  complianceFallbackLimit,
  contextualFallbackLimitKmh,
  detectSlipperyConditionProxy,
  extractBrakingSequences,
  getInferredLimitForPoint,
  hasSustainedLateralG,
  lateralGForTriplet,
  resolveEffectiveSpeedLimitForIndex,
  scoreBrakeOnsetSmoothness,
  speedLimitForIndex
} from '../detection/cornering.js';
import {
  analyzeFatigueProgression,
  calculateSegmentStats,
  detectDrowsyDriving,
  detectHeadingDriftBeta,
  scoreFatigueSegment,
  scoreSegmentPoints
} from '../detection/headingDrift.js';
import {
  detectAggressiveOvertakes
} from '../detection/overtakePattern.js';
import {
  attachEventResult,
  detectDrivingEvents,
  detectPhoneProxy,
  detectPhoneUsageProxy,
  detectPhoneUseWindows,
  emptyPhoneUseResult,
  maskDetectedEventsForPrivacy,
  summarizePhoneUseEvents
} from '../detection/harshBraking.js';
import {
  calculateAggressiveDrivingScore,
  calculateDefensiveDrivingScore,
  calculateEngineStressScore,
  calculateFatigueScore,
  calculateNightPenalty,
  calculateRouteSummary,
  calculateTireWearUnits,
  calculateTripScores,
  calculateTripStats,
  createTripNightChecker,
  dayOfYear,
  gapContainsPermissionLoss,
  generatedTripId,
  highwayEvidenceDistanceKm,
  intersectionScoringPoints,
  isNightDrivingTime,
  isWithinClockWindow,
  localDateKey,
  parseClockMinutes,
  permissionLossEventTimesMs,
  sanitizePrivateIntersectionStats,
  splitTripAtStops,
  stopStartEvidenceDistances,
  stopStartScoreForContext,
  sunEventMinutes
} from '../scoring/pipeline.js';
import {
  formatDate,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatSpeed,
  formatTime,
  getScoreColor,
  getScoreGradient
} from '../utils/units.js';

export function distanceWeightedTripScore(trips = [], field = 'score_overall') {
  const scored = trips
    .map((trip) => ({
      score: Number(trip?.[field]),
      distance: Number(trip?.distance_km) || 0,
    }))
    .filter((item) => Number.isFinite(item.score));
  const totalKm = scored.reduce((sum, item) => sum + item.distance, 0);
  return totalKm > 0
    ? scored.reduce((sum, item) => sum + item.score * item.distance, 0) / totalKm
    : null;
}

/**
 * Generate a summary report for a set of trips.
 *
 * @param {Array} trips - Array of completed trips
 * @returns {Object} Report summary
 */
export function generateReportSummary(trips) {
  if (!trips || trips.length === 0) {
    return {
      total_trips: 0,
      total_distance_km: 0,
      total_duration_seconds: 0,
      avg_score: null,
      best_trip: null,
      worst_trip: null,
      total_harsh_brakes: 0,
      total_rapid_accels: 0,
      total_sharp_turns: 0,
      total_speeding_events: 0,
      total_heading_deviations: 0,
      total_stop_start_patterns: 0,
      total_distraction_events: 0,
      most_common_risk: null,
    };
  }

  const completed = trips.filter(t => t.status === 'completed');
  const totalDistance = completed.reduce((s, t) => s + (t.distance_km || 0), 0);
  const totalDuration = completed.reduce((s, t) => s + (t.duration_seconds || 0), 0);
  const scores = completed
    .map((trip) => Number(trip.score_overall))
    .filter((score) => Number.isFinite(score));
  const weightedScore = distanceWeightedTripScore(completed);
  const avgScore = weightedScore == null ? null : Math.round(weightedScore);

  const scoredTrips = completed.filter((trip) => Number.isFinite(Number(trip.score_overall)));
  const sorted = [...scoredTrips].sort((a, b) => Number(b.score_overall) - Number(a.score_overall));
  const bestTrip = sorted[0] || null;
  const worstTrip = sorted[sorted.length - 1] || null;

  const hb = completed.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
  const ra = completed.reduce((s, t) => s + (t.rapid_accel_count || 0), 0);
  const st = completed.reduce((s, t) => s + (t.sharp_turns_count || 0), 0);
  const sp = completed.reduce((s, t) => s + (t.speeding_events_count || 0), 0);
  const hd = completed.reduce((s, t) => s + (t.heading_deviation_count ?? 0), 0);
  const ss = completed.reduce((s, t) => s + (t.stop_start_pattern_count ?? t.tailgate_cycle_count ?? 0), 0);
  const er = completed.reduce((s, t) => s + (t.distraction_events_count || 0), 0);

  const riskMap = {
    [EVENT_TYPES.HARSH_BRAKE]: hb,
    [EVENT_TYPES.RAPID_ACCELERATION]: ra,
    [EVENT_TYPES.SHARP_TURN]: st,
    [EVENT_TYPES.SPEEDING]: sp,
    [EVENT_TYPES.HEADING_DEVIATION]: hd,
    [EVENT_TYPES.STOP_START_PATTERN]: ss,
    [EVENT_TYPES.ERRATIC_SPEED]: er,
  };
  const mostCommonRisk = Object.entries(riskMap).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    total_trips: completed.length,
    total_distance_km: Math.round(totalDistance * 10) / 10,
    total_duration_seconds: totalDuration,
    avg_score: avgScore,
    best_trip: bestTrip,
    worst_trip: worstTrip,
    total_harsh_brakes: hb,
    total_rapid_accels: ra,
    total_sharp_turns: st,
    total_speeding_events: sp,
    total_heading_deviations: hd,
    total_stop_start_patterns: ss,
    total_distraction_events: er,
    most_common_risk: mostCommonRisk,
    score_trend: scores,
  };
}

// ─── GPS Location Service (Browser) ───────────────────────────────────────────
/**
 * Live GPS tracking service using the Web Geolocation API.
 * Returns an object with start/stop methods and a callback for new points.
 */
export function createLocationService() {
  let watchId = null;
  let onPoint = null;
  let onError = null;

  return {
    start(onPointCb, onErrorCb) {
      onPoint = onPointCb;
      onError = onErrorCb;

      if (!navigator.geolocation) {
        onError?.({ message: 'Geolocation not supported' });
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (pos.coords.accuracy > DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M) return; // filter noisy points
          onPoint?.({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speed_kmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading,
            timestamp: new Date(pos.timestamp).toISOString(),
          });
        },
        (err) => onError?.({ message: err.message, code: err.code }),
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    },
    stop() {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    isActive: () => watchId !== null,
  };
}

// ─── CSV Export ────────────────────────────────────────────────────────────────
export const csvSpeedLimitSources = (trip = {}) => {
  const sources = new Set();
  (trip.route_points || []).forEach((point) => {
    if (point?.speed_limit_source) sources.add(point.speed_limit_source);
  });
  (trip.driving_events || []).forEach((event) => {
    if (event?.speed_limit_source) sources.add(event.speed_limit_source);
    if (event?.limit_source) sources.add(event.limit_source);
  });
  ['highway_compliance', 'urban_compliance', 'residential_compliance'].forEach((key) => {
    if (trip[key]?.limit_source) sources.add(trip[key].limit_source);
  });
  return [...sources].sort().join(';');
};

export const csvSpeedLimitDefaultCountries = (trip = {}) => {
  const countries = new Set();
  (trip.route_points || []).forEach((point) => {
    if (point?.speed_limit_default_country) countries.add(point.speed_limit_default_country);
    if (point?.fallback_country) countries.add(point.fallback_country);
  });
  (trip.driving_events || []).forEach((event) => {
    if (event?.speed_limit_default_country) countries.add(event.speed_limit_default_country);
    if (event?.fallback_country) countries.add(event.fallback_country);
  });
  return [...countries].sort().join(';');
};

export function tripsToCSV(trips) {
  const headers = [
    'ID', 'Start Time', 'End Time', 'Duration (min)', 'Distance (km)',
    'Avg Speed (km/h)', 'Avg Moving Speed (km/h)', 'Max Speed (km/h)', 'Score', 'Safety', 'Smoothness',
    // FIX: Add exported moving-speed column immediately after the legacy overall average speed.
    'Eco Score Estimate', 'Smoothness Index', 'Eco Driving Estimate', 'Stop-Start Pattern Estimate', 'Attention-Pattern Estimate', 'Approach-Stop Estimate',
    'Aggressive Score', 'Aggressive Grade', 'Defensive Driving Estimate', 'Defensive Grade', 'SVI', 'Fuel Band',
    'Smooth Braking', 'Engine Stress', 'Tire Wear Units', 'Heading Drift Beta', 'Phone Proxy (Diagnostic)', 'Parking Score',
    'Highway Score', 'Urban Score', 'Residential Score', 'Dominant Road Type',
    'Brake Onset Smoothness Score', 'Avg Brake Onset Ramp (s)', 'Brake Onset Smoothness Grade',
    'Phone Use Windows', 'Phone Use Total Seconds', 'Phone Use Risk', 'Phone Use Score (Usage Access)', 'Phone Use Pct Trip',
    'Cornering Consistency Score', 'Mean Lateral G', 'Peak Lateral G',
    'Braking Efficiency Score', 'Braking Efficiency Grade', 'Braking Sequence Count',
    'Highway Compliance Score', 'Urban Compliance Score', 'Residential Compliance Score', 'Overall Compliance Score',
    'Speed Limit Sources', 'Speed Limit Default Countries',
    'Overtake Quality Score (Beta Diagnostic)', 'Overtake Pattern Count (Beta Diagnostic)', 'Unsafe Re-entry Count (Beta Diagnostic)',
    'Weather Context', 'Safety Condition Bonus',
    'Road Type', 'Harsh Brakes', 'Rapid Accels', 'Sharp Turns', 'Speeding Events',
    'Heading Deviation Events (Beta)', 'Heading Events (Legacy)', 'Stop-Start Patterns', 'Erratic Speed Events', 'Brake-Turn Manoeuvre Alerts', 'Overtake Patterns (Beta Diagnostic)', 'Night Driving',
    'Event Feedback Accurate', 'Event Feedback Wrong', 'Event Feedback JSON',
    'GPS Point Count', 'Route Points JSON', 'Driving Events JSON',
  ];
  const metricMetadata = headers.map((header, index) => {
    if (index === 0) return 'Metric Metadata';
    const metricKey = CSV_METRIC_COLUMNS[header];
    return metricKey ? formatMetricMetadata(metricKey) : '';
  });

  const scoreCsvValue = (header, value) => (
    isEstimatedScoreMetric(CSV_METRIC_COLUMNS[header])
      ? formatEstimatedScore(value, { empty: '' })
      : value ?? ''
  );

  const rows = trips.map((rawTrip) => {
    const t = /** @type {any} */ (maskTripForPrivacy(rawTrip));
    const feedbackItems = Object.values(t.event_feedback || {});
    const accurateFeedback = feedbackItems.filter((item) => item?.verdict === 'accurate').length;
    const wrongFeedback = feedbackItems.filter((item) => item?.verdict === 'wrong').length;
    return [
    t.id,
    t.start_time,
    t.end_time,
    t.duration_seconds ? (t.duration_seconds / 60).toFixed(1) : '',
    t.distance_km ?? '',
    t.avg_speed_kmh ?? '',
    t.avg_running_speed_kmh ?? '',
    // FIX: Export avg_running_speed_kmh so CSV consumers can use driving speed excluding stops.
    t.max_speed_kmh ?? '',
    scoreCsvValue('Score', t.score_overall),
    scoreCsvValue('Safety', t.score_safety),
    scoreCsvValue('Smoothness', t.score_smoothness),
    scoreCsvValue('Eco Score Estimate', t.score_eco),
    t.jerk_score ?? '',
    scoreCsvValue('Eco Driving Estimate', t.eco_driving_score),
    scoreCsvValue('Stop-Start Pattern Estimate', t.stop_start_pattern_score),
    scoreCsvValue('Attention-Pattern Estimate', t.distraction_score),
    scoreCsvValue('Approach-Stop Estimate', t.intersection_score),
    scoreCsvValue('Aggressive Score', t.aggressive_driving_score),
    t.aggressive_grade ?? '',
    scoreCsvValue('Defensive Driving Estimate', t.defensive_driving_score),
    t.defensive_grade ?? '',
    t.speed_variability_index ?? '',
    scoreCsvValue('Fuel Band', t.fuel_band_score),
    t.smooth_braking_ratio ?? '',
    scoreCsvValue('Engine Stress', t.engine_stress_score),
    t.trip_tire_wear_units ?? '',
    t.heading_drift_beta_level ?? t.drowsy_risk_level ?? '',
    t.phone_proxy_risk ?? '',
    scoreCsvValue('Parking Score', t.parking_approach_score),
    scoreCsvValue('Highway Score', t.highway_score?.overall),
    scoreCsvValue('Urban Score', t.urban_score?.overall),
    scoreCsvValue('Residential Score', t.residential_score?.overall),
    t.dominant_road_type ?? '',
    scoreCsvValue('Brake Onset Smoothness Score', t.brake_onset_smoothness_score),
    t.avg_brake_onset_ramp_seconds ?? '',
    t.brake_onset_smoothness_grade ?? '',
    t.phone_use_window_count ?? 0,
    t.phone_use_total_seconds ?? 0,
    t.phone_use_risk ?? 'none',
    scoreCsvValue('Phone Use Score (Usage Access)', t.phone_use_score),
    t.phone_use_pct_of_trip ?? 0,
    scoreCsvValue('Cornering Consistency Score', t.cornering_consistency_score),
    t.mean_lateral_g ?? '',
    t.peak_lateral_g ?? '',
    scoreCsvValue('Braking Efficiency Score', t.braking_efficiency_score),
    t.braking_efficiency_grade ?? '',
    t.braking_sequence_count ?? '',
    scoreCsvValue('Highway Compliance Score', t.highway_compliance?.score),
    scoreCsvValue('Urban Compliance Score', t.urban_compliance?.score),
    scoreCsvValue('Residential Compliance Score', t.residential_compliance?.score),
    scoreCsvValue('Overall Compliance Score', t.overall_compliance_score),
    csvSpeedLimitSources(t),
    csvSpeedLimitDefaultCountries(t),
    scoreCsvValue('Overtake Quality Score (Beta Diagnostic)', t.overtake_quality_score),
    t.overtake_count ?? '',
    t.unsafe_reentry_count ?? '',
    t.slippery_proxy ?? '',
    t.safety_condition_bonus ?? '',
    t.road_type ?? '',
    t.harsh_brakes_count ?? '',
    t.rapid_accel_count ?? '',
    t.sharp_turns_count ?? '',
    t.speeding_events_count ?? '',
    t.heading_deviation_count ?? '',
    t.heading_deviation_legacy_count ?? '',
    t.stop_start_pattern_count ?? t.tailgate_cycle_count ?? '',
    t.distraction_events_count ?? '',
    t.close_proximity_count ?? '',
    t.overtake_event_count ?? '',
    t.night_driving ? 'Yes' : 'No',
    accurateFeedback,
    wrongFeedback,
    JSON.stringify(t.event_feedback || {}),
    t.route_points?.length || 0,
    JSON.stringify(t.route_points || []),
    JSON.stringify(t.driving_events || []),
    ];
  });

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers, metricMetadata, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

export async function downloadCSV(content, filename) {
  const safeFilename = filename.replace(/[\\/:*?"<>|]+/g, '-');

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const result = await saveExportToDownloads({
        filename: safeFilename,
        data: content,
        mimeType: 'text/csv',
      });
      return {
        native: true,
        uri: result.uri,
        filename: safeFilename,
      };
    }
  } catch (error) {
    console.warn('Native CSV export failed, falling back to browser download.', error);
  }

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return {
    native: false,
    filename: safeFilename,
  };
}
