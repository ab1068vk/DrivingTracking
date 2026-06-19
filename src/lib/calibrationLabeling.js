import { SCORING_VERSION } from '@/lib/tripEngine';
import { getJson, setJson } from '@/lib/mobileStorage';
import {
  MIN_CALIBRATION_LABEL_COUNT,
  surveyRatingToTargetScore,
} from '@/lib/calibrationFitting';

export const CALIBRATION_LABEL_SCHEMA_VERSION = 2;
export const CALIBRATION_LABEL_TARGET_COUNT = MIN_CALIBRATION_LABEL_COUNT;
export const CALIBRATION_LABEL_COLLECTION = 'trip_calibration_labels';
export const POST_TRIP_SURVEY_QUESTION = 'Did Road Sage score this trip fairly?';
export const ANONYMOUS_INSTALL_ID_KEY = 'road_sage_anonymous_install_id';
export const SURVEY_RATING_OPTIONS = Object.freeze([
  { value: 1, label: 'Risky' },
  { value: 2, label: 'Poor' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Excellent' },
]);
export const SCORE_ACCURACY_OPTIONS = Object.freeze(['accurate', 'too_high', 'too_low']);
export const SCORE_REVIEW_ISSUE_OPTIONS = Object.freeze([
  'harsh_brake',
  'rapid_acceleration',
  'sharp_turn',
  'speeding',
  'phone_use',
  'other',
]);
export const WAS_DRIVER_OPTIONS = Object.freeze(['yes', 'no', 'unsure']);
export const TRIP_CONTEXT_TAG_OPTIONS = Object.freeze([
  'traffic',
  'weather',
  'construction',
  'fatigue',
  'aggressive_drivers',
  'bad_road',
  'gps_issue',
  'passenger',
  'other',
]);
export const CALIBRATION_QUALITY_THRESHOLDS = Object.freeze({
  minDistanceKm: 0.5,
  minDurationMin: 2,
  minGpsQualityScore: 0.45,
  maxPrivacyMaskedRatio: 0.5,
  minSampleCount: 10,
});

const numberOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const boolOrNull = (value) => (typeof value === 'boolean' ? value : null);

const round = (value, digits = 3) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
};

const EVENT_COUNT_FIELDS = Object.freeze({
  harsh_brake: 'harsh_brakes_count',
  rapid_acceleration: 'rapid_accel_count',
  sharp_turn: 'sharp_turns_count',
  speeding: 'speeding_events_count',
  idle: 'idle_events_count',
  phone_use: 'phone_use_window_count',
  stop_start_pattern: 'stop_start_pattern_count',
  tailgate_cycle: 'tailgate_cycle_count',
  erratic_speed: 'erratic_speed_event_count',
});

const eventCountsFromTrip = (trip = {}) => Object.fromEntries(
  Object.entries(EVENT_COUNT_FIELDS)
    .map(([type, field]) => [type, Math.max(0, Number(trip[field]) || 0)])
    .filter(([, count]) => Number(count) > 0)
);

const per100Km = (count, distanceKm) => (
  distanceKm > 0 ? round((Math.max(0, Number(count) || 0) / distanceKm) * 100, 3) : 0
);

const ratio = (value, denominator) => {
  const numerator = Math.max(0, Number(value) || 0);
  const divisor = Math.max(0, Number(denominator) || 0);
  return divisor > 0 ? round(numerator / divisor, 3) : 0;
};

function normalizeRating(value, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 5) {
    throw new Error('Survey rating must be an integer from 1 to 5.');
  }
  return normalized;
}

function normalizeSurveyLabel(input = {}, trip = {}) {
  const source = typeof input === 'number' ? { overallDriveRating: input } : input || {};
  const scoreAccuracy = source.scoreAccuracy || null;
  const wasDriver = source.wasDriver || 'unsure';
  const tripDifficulty = normalizeRating(source.tripDifficulty, { optional: true });

  if (scoreAccuracy != null && !SCORE_ACCURACY_OPTIONS.includes(scoreAccuracy)) {
    throw new Error(`scoreAccuracy must be one of: ${SCORE_ACCURACY_OPTIONS.join(', ')}.`);
  }
  if (!WAS_DRIVER_OPTIONS.includes(wasDriver)) {
    throw new Error(`wasDriver must be one of: ${WAS_DRIVER_OPTIONS.join(', ')}.`);
  }

  const contextTags = [...new Set((Array.isArray(source.contextTags) ? source.contextTags : [])
    .filter((tag) => TRIP_CONTEXT_TAG_OPTIONS.includes(tag)))];
  const scoreIssueTypes = [...new Set((Array.isArray(source.scoreIssueTypes) ? source.scoreIssueTypes : [])
    .filter((type) => SCORE_REVIEW_ISSUE_OPTIONS.includes(type)))];
  const explicitRating = source.overallDriveRating ?? source.rating;
  const tripScore = numberOrNull(trip?.score_overall);
  const inferredTargetScore = tripScore == null || scoreAccuracy == null
    ? null
    : Math.max(0, Math.min(100, tripScore + (scoreAccuracy === 'too_low' ? 10 : scoreAccuracy === 'too_high' ? -10 : 0)));
  const explicitTargetScore = numberOrNull(source.targetScore ?? source.target_score);
  const targetScore = explicitTargetScore ?? (
    explicitRating != null ? surveyRatingToTargetScore(normalizeRating(explicitRating)) : inferredTargetScore
  );
  if (targetScore == null) {
    throw new Error('Choose whether the trip score was accurate, too high, or too low.');
  }
  const overallDriveRating = explicitRating != null
    ? normalizeRating(explicitRating)
    : Math.max(1, Math.min(5, Math.round(targetScore / 25) + 1));

  return {
    question: POST_TRIP_SURVEY_QUESTION,
    overallDriveRating,
    rating: overallDriveRating,
    targetScore,
    target_score: targetScore,
    scoreAccuracy,
    scoreIssueTypes,
    wasDriver,
    tripDifficulty,
    contextTags,
  };
}

function gpsQualityScore(trip = {}) {
  const explicit = numberOrNull(trip.gps_quality_score ?? trip.location_quality_score);
  if (explicit != null) return Math.max(0, Math.min(1, explicit > 1 ? explicit / 100 : explicit));
  const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (!routePoints.length) return 0;
  const usable = routePoints.filter((point) => {
    if (point?.masked_for_privacy === true) return false;
    const accuracy = numberOrNull(point?.accuracy);
    return accuracy == null || accuracy <= 50;
  }).length;
  return round(usable / routePoints.length, 3);
}

function sampleCount(trip = {}) {
  return Math.max(
    0,
    Number(trip.route_points_raw_count) ||
      (Array.isArray(trip.route_points) ? trip.route_points.length : 0) ||
      Number(trip.route_point_count) ||
      0
  );
}

function privacyMaskedRatio(trip = {}) {
  const explicit = numberOrNull(trip.privacy_masked_ratio);
  if (explicit != null) return Math.max(0, Math.min(1, explicit));
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (!points.length) return 0;
  return round(points.filter((point) => point?.masked_for_privacy === true || point?.lat == null || point?.lng == null).length / points.length, 3);
}

function roadRatio(trip = {}, roadType) {
  const score = trip[`${roadType}_score`];
  if (score && Number.isFinite(Number(score.distance_km))) {
    return ratio(score.distance_km, trip.distance_km);
  }
  const segments = Array.isArray(trip.road_type_segments) ? trip.road_type_segments : [];
  const distance = segments
    .filter((segment) => segment?.road_type === roadType)
    .reduce((sum, segment) => sum + (Number(segment.distance_km) || 0), 0);
  if (distance > 0) return ratio(distance, trip.distance_km);
  return trip.dominant_road_type === roadType || trip.road_type === roadType ? 1 : 0;
}

export function buildTripFeatureSummary(trip = {}) {
  const distanceKm = Math.max(0, numberOrNull(trip.distance_km) || 0);
  const eventCounts = eventCountsFromTrip(trip);
  const totalEventCount = Object.values(eventCounts).reduce((sum, count) => sum + count, 0);
  const durationMin = Math.max(0, (numberOrNull(trip.duration_seconds) || 0) / 60);

  return {
    distanceKm: round(distanceKm, 3),
    durationMin: round(durationMin, 2),
    avgSpeedKmh: round(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh, 1),
    maxSpeedKmh: round(trip.max_speed_kmh, 1),
    harshBrakesPer100Km: per100Km(trip.harsh_brakes_count, distanceKm),
    rapidAccelPer100Km: per100Km(trip.rapid_accel_count, distanceKm),
    sharpTurnsPer100Km: per100Km(trip.sharp_turns_count, distanceKm),
    speedingRatio: ratio(trip.speeding_events_count, totalEventCount || sampleCount(trip)),
    nightDrive: boolOrNull(trip.night_driving),
    cityRoadRatio: round(Math.max(roadRatio(trip, 'urban'), roadRatio(trip, 'residential')), 3),
    highwayRoadRatio: round(roadRatio(trip, 'highway'), 3),
    trafficStopCount: Math.max(0, Number(trip.traffic_stop_count ?? trip.stop_count) || 0),
    idleDurationMin: round((Number(trip.idle_time_seconds) || 0) / 60, 2),
    fatigueRisk: round(trip.fatigue_risk_score, 2),
    routeRisk: round(trip.route_risk_score, 2),
    gpsQualityScore: gpsQualityScore(trip),
    sampleCount: sampleCount(trip),
    privacyMaskedRatio: privacyMaskedRatio(trip),
  };
}

export function buildScoreOutputSummary(trip = {}) {
  return {
    overall: numberOrNull(trip.score_overall),
    safety: numberOrNull(trip.score_safety),
    smoothness: numberOrNull(trip.score_smoothness),
    eco: numberOrNull(trip.score_eco),
    confidence: trip.score_confidence_label || trip.component_scores?.overall?.evidence || null,
    calibrationStatus: trip.score_provenance?.calibration_status || null,
  };
}

export function dataQualityFlagsForCalibration(trip = {}, surveyLabel = {}, featureSummary = buildTripFeatureSummary(trip)) {
  const flags = [];
  if (surveyLabel.wasDriver === 'no') flags.push('passenger_trip');
  if ((featureSummary.distanceKm ?? 0) < CALIBRATION_QUALITY_THRESHOLDS.minDistanceKm) flags.push('distance_too_short');
  if ((featureSummary.durationMin ?? 0) < CALIBRATION_QUALITY_THRESHOLDS.minDurationMin) flags.push('duration_too_short');
  if ((featureSummary.gpsQualityScore ?? 0) < CALIBRATION_QUALITY_THRESHOLDS.minGpsQualityScore) flags.push('gps_quality_low');
  if ((featureSummary.privacyMaskedRatio ?? 0) > CALIBRATION_QUALITY_THRESHOLDS.maxPrivacyMaskedRatio) flags.push('privacy_masking_high');
  if ((featureSummary.sampleCount ?? 0) < CALIBRATION_QUALITY_THRESHOLDS.minSampleCount) flags.push('sample_count_low');
  if (trip.test_trip === true || trip.is_test_trip === true || trip.debug_trip === true || trip.source === 'debug') flags.push('test_or_debug_trip');
  if (trip.status !== 'completed' || trip.incomplete === true || trip.app_crash_during_trip === true || trip.crash_recovered === true) flags.push('incomplete_or_crash_recovered');
  if (surveyLabel.contextTags?.includes('gps_issue')) flags.push('user_reported_gps_issue');
  return flags;
}

export function isCalibrationEligible(qualityFlags = []) {
  return !qualityFlags.some((flag) => [
    'passenger_trip',
    'distance_too_short',
    'duration_too_short',
    'gps_quality_low',
    'privacy_masking_high',
    'sample_count_low',
    'test_or_debug_trip',
    'incomplete_or_crash_recovered',
  ].includes(flag));
}

function roundedCreatedAt(value, granularity = 'hour') {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 13) + ':00:00.000Z';
  if (granularity === 'day') {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCMinutes(0, 0, 0);
  }
  return date.toISOString();
}

const randomInstallId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `install_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

export async function getAnonymousInstallIdHash() {
  const existing = await getJson(ANONYMOUS_INSTALL_ID_KEY, null);
  const installId = typeof existing === 'string' && existing ? existing : randomInstallId();
  if (!existing) await setJson(ANONYMOUS_INSTALL_ID_KEY, installId);
  const input = `road-sage-calibration:${installId}`;

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `fallback_${Math.abs(hash).toString(16)}`;
}

export function buildCalibrationLabelPayload(trip = {}, surveyInput, options = {}) {
  const surveyLabel = normalizeSurveyLabel(surveyInput, trip);
  const tripFeatureSummary = buildTripFeatureSummary(trip);
  const scoreOutput = buildScoreOutputSummary(trip);
  const dataQualityFlags = dataQualityFlagsForCalibration(trip, surveyLabel, tripFeatureSummary);
  const scoringVersion = trip.score_provenance?.scoring_version || SCORING_VERSION;
  const labelId = options.labelId || `label_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return {
    labelId,
    schemaVersion: CALIBRATION_LABEL_SCHEMA_VERSION,
    anonymousInstallIdHash: options.anonymousInstallIdHash || null,
    scoringModelVersion: scoringVersion,
    createdAt: roundedCreatedAt(options.createdAt || options.submittedAt, options.createdAtGranularity || 'hour'),
    tripFeatureSummary,
    scoreOutput,
    surveyLabel,
    dataQualityFlags,
    eligibleForCalibration: isCalibrationEligible(dataQualityFlags),
  };
}

export async function buildCalibrationUploadPayload(trip = {}, surveyInput, options = {}) {
  const anonymousInstallIdHash = options.anonymousInstallIdHash || await getAnonymousInstallIdHash();
  return buildCalibrationLabelPayload(trip, surveyInput, {
    ...options,
    anonymousInstallIdHash,
  });
}

export function buildLocalSurveyRecord(payload, { freeTextNote = '', includeFreeTextInUpload = false } = {}) {
  return {
    ...payload,
    local_only_note: typeof freeTextNote === 'string' ? freeTextNote.slice(0, 2000) : '',
    include_free_text_in_upload: includeFreeTextInUpload === true,
  };
}
