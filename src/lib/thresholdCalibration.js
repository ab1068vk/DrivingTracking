import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { clamp } from '@/lib/mathUtils';
import { calculateAcceleration, calculateSegmentMetrics } from '@/lib/tripEngine';
import { scoringValue } from '@/lib/scoringConstants';

export const CALIBRATION_PROFILE_KEY = 'drivesense_calibration_profile';

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const finiteNumber = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const DEFAULT_THRESHOLDS = {
  threshold_harsh_brake_ms2: scoringValue('CALIBRATION_FALLBACK_HARSH_BRAKE_MS2'),
  threshold_rapid_accel_ms2: scoringValue('CALIBRATION_FALLBACK_RAPID_ACCEL_MS2'),
  threshold_sharp_turn_g_low: scoringValue('CALIBRATION_FALLBACK_SHARP_TURN_G_LOW'),
  threshold_sharp_turn_g_medium: scoringValue('SHARP_TURN_G_MEDIUM'),
  threshold_sharp_turn_g_high: scoringValue('SHARP_TURN_G_HIGH'),
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

const currentValue = (thresholds, lowerKey, upperKey) => {
  const localValue = Number(thresholds?.[lowerKey]);
  if (Number.isFinite(localValue) && localValue > 0) return localValue;
  const legacyValue = Number(thresholds?.[upperKey]);
  if (Number.isFinite(legacyValue) && legacyValue > 0) return legacyValue;
  return DEFAULT_THRESHOLDS[lowerKey] || 0;
};

const roundThreshold = (key, value) => (
  key.includes('_g_') ? round2(value) : round1(value)
);

const feedbackThresholdMap = {
  harsh_brake: { key: 'threshold_harsh_brake_ms2', margin: 0.3, min: 3.0, max: 7.0 },
  rapid_acceleration: { key: 'threshold_rapid_accel_ms2', margin: 0.3, min: 2.0, max: 6.0 },
  sharp_turn: { key: 'threshold_sharp_turn_g_medium', margin: 0.05, min: 0.25, max: 0.70 },
};

const surveyThresholdMap = {
  harsh_brake: { key: 'threshold_harsh_brake_ms2', baseNudge: 0.2, step: 0.1, maxNudge: 0.6, min: 3.0, max: 7.0 },
  rapid_acceleration: { key: 'threshold_rapid_accel_ms2', baseNudge: 0.2, step: 0.1, maxNudge: 0.6, min: 2.0, max: 6.0 },
  sharp_turn: { key: 'threshold_sharp_turn_g_medium', baseNudge: 0.03, step: 0.01, maxNudge: 0.09, min: 0.25, max: 0.70 },
};

const summarizeEventFeedback = (trips = []) => {
  const byType = {};
  for (const trip of trips) {
    for (const item of Object.values(trip?.event_feedback || {})) {
      const type = item?.type;
      const config = feedbackThresholdMap[type];
      if (!config) continue;
      byType[type] ??= { accurate: 0, wrong: 0, wrongValues: [], accurateValues: [] };
      if (item.verdict === 'wrong') {
        byType[type].wrong += 1;
        if (Number.isFinite(Number(item.value))) byType[type].wrongValues.push(Math.abs(Number(item.value)));
      }
      if (item.verdict === 'accurate') {
        byType[type].accurate += 1;
        if (Number.isFinite(Number(item.value))) byType[type].accurateValues.push(Math.abs(Number(item.value)));
      }
    }
  }
  const total = Object.values(byType).reduce((sum, item) => sum + item.accurate + item.wrong, 0);
  return { total, byType };
};

export function summarizeCalibrationSurveyLabels(labels = []) {
  const usable = (Array.isArray(labels) ? labels : [])
    .map((label) => {
      const survey = label?.surveyLabel || label?.survey || {};
      const score = finiteNumber(label?.scoreOutput?.overall ?? label?.score_output?.overall ?? label?.score_overall);
      const target = finiteNumber(survey.targetScore ?? survey.target_score ?? label?.target_score);
      const rating = finiteNumber(survey.overallDriveRating ?? survey.rating ?? label?.survey_rating);
      if (score == null || target == null || rating == null) return null;
      return {
        score,
        target,
        rating,
        scoreAccuracy: survey.scoreAccuracy ?? survey.score_accuracy ?? null,
        scoreIssueTypes: Array.isArray(survey.scoreIssueTypes ?? survey.score_issue_types)
          ? (survey.scoreIssueTypes ?? survey.score_issue_types)
          : [],
        wasDriver: survey.wasDriver ?? survey.was_driver ?? 'unsure',
        eligible: label?.eligibleForCalibration ?? label?.eligible_for_calibration ?? false,
        uploadStatus: label?.upload_status ?? label?.uploadStatus ?? 'local_only',
        contextTags: Array.isArray(survey.contextTags ?? survey.context_tags)
          ? (survey.contextTags ?? survey.context_tags)
          : [],
      };
    })
    .filter(Boolean);

  const eligible = usable.filter((label) => label.eligible !== false && label.wasDriver !== 'no');
  const rows = eligible.length ? eligible : usable.filter((label) => label.wasDriver !== 'no');
  const count = rows.length;
  const averageScoreDelta = count
    ? round1(rows.reduce((sum, label) => sum + (label.target - label.score), 0) / count)
    : null;
  const meanRating = count
    ? round1(rows.reduce((sum, label) => sum + label.rating, 0) / count)
    : null;
  const tooHigh = rows.filter((label) => label.scoreAccuracy === 'too_high').length;
  const tooLow = rows.filter((label) => label.scoreAccuracy === 'too_low').length;
  const accurate = rows.filter((label) => label.scoreAccuracy === 'accurate').length;
  const tagCounts = {};
  const issueCounts = {};
  const tooHarshIssueCounts = {};
  const tooGenerousIssueCounts = {};
  for (const label of rows) {
    for (const tag of label.contextTags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    for (const issue of label.scoreIssueTypes) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
      if (label.scoreAccuracy === 'too_low') {
        tooHarshIssueCounts[issue] = (tooHarshIssueCounts[issue] || 0) + 1;
      }
      if (label.scoreAccuracy === 'too_high') {
        tooGenerousIssueCounts[issue] = (tooGenerousIssueCounts[issue] || 0) + 1;
      }
    }
  }
  const topContextTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag, total]) => ({ tag, count: total }));
  const pendingUploadCount = usable.filter((label) => label.uploadStatus === 'pending_upload').length;
  const localOnlyCount = usable.filter((label) => label.uploadStatus === 'local_only').length;
  const uploadedCount = usable.filter((label) => label.uploadStatus === 'uploaded').length;

  let direction = 'aligned';
  let recommendation = 'Survey labels are broadly aligned with the current score output.';
  if (averageScoreDelta != null && averageScoreDelta >= 8) {
    direction = 'scores_feel_too_harsh';
    recommendation = 'Your fair scores are higher than the app scores; review false positives before applying less-sensitive detection.';
  } else if (averageScoreDelta != null && averageScoreDelta <= -8) {
    direction = 'scores_feel_too_generous';
    recommendation = 'Your fair scores are lower than the app scores; review missed risky events before applying more-sensitive detection.';
  } else if (tooHigh > tooLow + 1) {
    direction = 'scores_feel_too_generous';
    recommendation = 'Score feedback says the app is too generous; inspect missed-event coverage before applying more-sensitive detection.';
  } else if (tooLow > tooHigh + 1) {
    direction = 'scores_feel_too_harsh';
    recommendation = 'Score feedback says the app is too harsh; inspect false positives before applying less-sensitive detection.';
  }

  return {
    total: usable.length,
    usable: count,
    eligible: eligible.length,
    meanRating,
    averageScoreDelta,
    direction,
    recommendation,
    confidence: count >= 20 ? 'medium' : count >= 5 ? 'low' : 'very low',
    scoreAccuracy: { accurate, tooHigh, tooLow },
    issueCounts,
    tooHarshIssueCounts,
    tooGenerousIssueCounts,
    topContextTags,
    uploadStatus: { uploaded: uploadedCount, localOnly: localOnlyCount, pendingUpload: pendingUploadCount },
  };
}

export function summarizeSurveyCoverage(labels = []) {
  const buckets = {
    city: 0,
    highway: 0,
    mixed: 0,
    night: 0,
    short: 0,
    traffic: 0,
    weather: 0,
    gpsIssue: 0,
  };
  let usable = 0;

  for (const label of Array.isArray(labels) ? labels : []) {
    const survey = label?.surveyLabel || label?.survey || {};
    const features = label?.tripFeatureSummary || label?.trip_feature_summary || {};
    const rating = finiteNumber(survey.overallDriveRating ?? survey.rating ?? label?.survey_rating);
    if (rating == null) continue;
    usable += 1;

    const cityRatio = finiteNumber(features.cityRoadRatio ?? features.city_road_ratio, 0);
    const highwayRatio = finiteNumber(features.highwayRoadRatio ?? features.highway_road_ratio, 0);
    if (highwayRatio >= 0.5) buckets.highway += 1;
    else if (cityRatio >= 0.5) buckets.city += 1;
    else buckets.mixed += 1;

    if (features.nightDrive === true || features.night_drive === true) buckets.night += 1;
    if (finiteNumber(features.distanceKm ?? features.distance_km, 0) < 2) buckets.short += 1;

    const tags = Array.isArray(survey.contextTags ?? survey.context_tags)
      ? (survey.contextTags ?? survey.context_tags)
      : [];
    if (tags.includes('traffic')) buckets.traffic += 1;
    if (tags.includes('weather')) buckets.weather += 1;
    if (tags.includes('gps_issue')) buckets.gpsIssue += 1;
  }

  const weakBuckets = Object.entries(buckets)
    .filter(([, count]) => count > 0 && count < 3)
    .map(([bucket]) => bucket);
  const missingCoreBuckets = ['city', 'highway', 'night']
    .filter((bucket) => buckets[bucket] === 0);

  return {
    usable,
    buckets,
    weakBuckets,
    missingCoreBuckets,
    enoughBreadth: usable >= 10 && missingCoreBuckets.length === 0,
  };
}

export function computeCalibrationProfile(trips = [], /** @type {any} */ currentThresholds = {}, options = {}) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const tripsAnalyzed = completed.length;
  const kmAnalyzedRaw = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const feedbackSummary = summarizeEventFeedback(completed);
  const surveySummary = summarizeCalibrationSurveyLabels(options.surveyLabels || []);
  const surveyCoverage = summarizeSurveyCoverage(options.surveyLabels || []);
  const consistentSurveyIssueCount = Math.max(
    0,
    ...Object.values(surveySummary.tooHarshIssueCounts || {}),
    ...Object.values(surveySummary.tooGenerousIssueCounts || {})
  );

  if (tripsAnalyzed < 15 && kmAnalyzedRaw < 200 && feedbackSummary.total < 3 && consistentSurveyIssueCount < 3) {
    return {
      insufficient: true,
      tripsNeeded: Math.max(0, 15 - tripsAnalyzed),
      kmNeeded: Math.max(0, Math.ceil(200 - kmAnalyzedRaw)),
      feedbackSummary,
      surveySummary,
      surveyCoverage,
    };
  }

  const accelValues = [];
  const decelValues = [];
  const lateralGValues = [];

  for (const trip of completed) {
    const points = Array.isArray(trip.route_points) ? trip.route_points : [];
    for (let i = 1; i < points.length; i++) {
      const segment = calculateSegmentMetrics(points[i - 1], points[i], currentThresholds);
      if (segment.dt <= 0 || segment.dt > 60 || segment.isNoise) continue;
      const previousSpeed = Number(points[i - 1]?.speed_kmh);
      const baselineSpeed = Number.isFinite(previousSpeed) ? previousSpeed : segment.reliableSpeedKmh;
      const accel = calculateAcceleration(baselineSpeed, segment.reliableSpeedKmh, segment.dt);
      if (!Number.isFinite(accel) || Math.max(baselineSpeed, segment.reliableSpeedKmh) <= 15) continue;
      if (accel > 0) accelValues.push(accel);
      if (accel < 0) decelValues.push(Math.abs(accel));
    }

    for (const event of trip.driving_events || []) {
      const lateralG = Number(event.value);
      if (event.type === 'sharp_turn' && Number.isFinite(lateralG)) lateralGValues.push(Math.abs(lateralG));
    }
  }

  const suggested = {
    threshold_harsh_brake_ms2: round1(clamp(percentile(decelValues, 0.90) ?? currentValue(currentThresholds, 'threshold_harsh_brake_ms2', 'HARSH_BRAKE_MS2'), 3.0, 7.0)),
    threshold_rapid_accel_ms2: round1(clamp(percentile(accelValues, 0.88) ?? currentValue(currentThresholds, 'threshold_rapid_accel_ms2', 'RAPID_ACCEL_MS2'), 2.0, 6.0)),
    threshold_sharp_turn_g_low: null,
    threshold_sharp_turn_g_medium: null,
    threshold_sharp_turn_g_high: null,
  };

  if (lateralGValues.length >= 20) {
    suggested.threshold_sharp_turn_g_low = round2(clamp(percentile(lateralGValues, 0.70), 0.20, 0.50));
    suggested.threshold_sharp_turn_g_medium = round2(clamp(percentile(lateralGValues, 0.85), 0.25, 0.70));
    suggested.threshold_sharp_turn_g_high = round2(clamp(percentile(lateralGValues, 0.95), 0.35, 0.90));
  }

  const current = {
    threshold_harsh_brake_ms2: currentValue(currentThresholds, 'threshold_harsh_brake_ms2', 'HARSH_BRAKE_MS2'),
    threshold_rapid_accel_ms2: currentValue(currentThresholds, 'threshold_rapid_accel_ms2', 'RAPID_ACCEL_MS2'),
    threshold_sharp_turn_g_low: currentValue(currentThresholds, 'threshold_sharp_turn_g_low', 'SHARP_TURN_G_LOW'),
    threshold_sharp_turn_g_medium: currentValue(currentThresholds, 'threshold_sharp_turn_g_medium', 'SHARP_TURN_G_MEDIUM'),
    threshold_sharp_turn_g_high: currentValue(currentThresholds, 'threshold_sharp_turn_g_high', 'SHARP_TURN_G_HIGH'),
  };

  for (const [type, feedback] of Object.entries(feedbackSummary.byType)) {
    const config = feedbackThresholdMap[type];
    if (!config || feedback.wrong < 2 || feedback.wrongValues.length === 0) continue;
    const wrongTarget = (percentile(feedback.wrongValues, 0.75) || current[config.key]) + config.margin;
    const accurateCeiling = feedback.accurateValues.length >= 3
      ? (percentile(feedback.accurateValues, 0.95) || wrongTarget) + config.margin
      : wrongTarget;
    const feedbackTarget = roundThreshold(config.key, clamp(Math.min(wrongTarget, accurateCeiling), config.min, config.max));
    suggested[config.key] = Math.max(Number(suggested[config.key] || current[config.key]), feedbackTarget);
  }

  const surveyThresholdSignals = [];
  const applySurveyThresholdSignals = (counts, direction) => {
    for (const [issueType, count] of Object.entries(counts || {})) {
      const config = surveyThresholdMap[issueType];
      if (!config || count < 3) continue;
      const nudge = Math.min(config.maxNudge, config.baseNudge + Math.max(0, count - 3) * config.step);
      const target = roundThreshold(
        config.key,
        clamp(
          Number(current[config.key]) + (direction === 'loosen' ? nudge : -nudge),
          config.min,
          config.max
        )
      );
      suggested[config.key] = direction === 'loosen'
        ? Math.max(Number(suggested[config.key] || current[config.key]), target)
        : Math.min(Number(suggested[config.key] || current[config.key]), target);
      surveyThresholdSignals.push({
        issueType,
        responseCount: count,
        direction,
        thresholdKey: config.key,
        suggestedValue: suggested[config.key],
      });
    }
  };
  applySurveyThresholdSignals(surveySummary.tooHarshIssueCounts, 'loosen');
  applySurveyThresholdSignals(surveySummary.tooGenerousIssueCounts, 'tighten');

  const delta = Object.fromEntries(Object.entries(suggested).map(([key, value]) => [
    key,
    value == null ? null : roundThreshold(key, value - current[key]),
  ]));
  const kmAnalyzed = Math.round(kmAnalyzedRaw * 10) / 10;
  const confidence = tripsAnalyzed >= 40 && kmAnalyzed >= 500
    ? 'high'
    : tripsAnalyzed >= 20 && kmAnalyzed >= 250
      ? 'medium'
      : feedbackSummary.total >= 6
        ? 'medium'
        : 'low';

  return {
    insufficient: false,
    confidence,
    tripsAnalyzed,
    kmAnalyzed,
    eventsAnalyzed: accelValues.length + decelValues.length + lateralGValues.length,
    suggested,
    current,
    delta,
    feedbackSummary,
    surveySummary,
    surveyCoverage,
    surveyThresholdSignals,
    appliedAt: null,
  };
}

export async function applyCalibrationProfile(profile, currentSettings = {}, saveSettings) {
  const suggested = Object.fromEntries(
    Object.entries(profile?.suggested || {}).filter(([, value]) => value != null)
  );
  const newSettings = {
    ...currentSettings,
    ...suggested,
    calibration_profile_key: CALIBRATION_PROFILE_KEY,
  };
  const appliedProfile = { ...profile, appliedAt: new Date().toISOString() };
  await saveCalibrationProfile(appliedProfile);
  if (typeof saveSettings === 'function') await saveSettings(newSettings);
  return newSettings;
}

export async function saveCalibrationProfile(profile) {
  await setJson(CALIBRATION_PROFILE_KEY, profile);
}

export async function loadCalibrationProfile() {
  return getJson(CALIBRATION_PROFILE_KEY, null);
}

export async function clearCalibrationProfile() {
  await removeJson(CALIBRATION_PROFILE_KEY);
}
