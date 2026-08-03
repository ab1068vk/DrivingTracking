const MAX_TERMINAL_WINDOW_MS = 5 * 60 * 1000;
const MAX_TERMINAL_POINTS = 32;
const VEHICLE_SPEED_KMH = 12;
const STOP_SPEED_KMH = 8;
const MAX_STOP_CLUSTER_RADIUS_M = 60;
const MAX_PARKING_ACCURACY_M = 75;
const MAX_ENDPOINT_AGE_MS = 2 * 60 * 1000;
const HIGH_CONFIDENCE_SCORE = 75;
const MEDIUM_CONFIDENCE_SCORE = 50;

const validCoordinate = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0);
};

const timestampMs = (point) => {
  const parsed = Date.parse(String(point?.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const distanceM = (first, second) => {
  const toRad = Math.PI / 180;
  const lat1 = Number(first.lat) * toRad;
  const lat2 = Number(second.lat) * toRad;
  const dLat = lat2 - lat1;
  const dLng = (Number(second.lng) - Number(first.lng)) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
};

const pointAccuracyM = (point) => {
  const value = Number(point?.accuracy);
  return Number.isFinite(value) && value >= 0 ? value : 100;
};

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));

const normalizedActivity = (activity) => ({
  type: String(activity?.type || '').toLowerCase(),
  confidence: Math.max(0, Math.min(100, Number(activity?.confidence) || 0)),
});

const obdIgnitionEvidence = (points = []) => {
  const rpms = points
    .map((point) => Number(point?.obd_rpm))
    .filter(Number.isFinite);
  if (!rpms.length) return { observed: false, ignitionOff: false, engineRunning: false };
  return {
    observed: true,
    ignitionOff: rpms.some((rpm) => rpm >= 500) && rpms.at(-1) < 200,
    engineRunning: rpms.at(-1) >= 500,
  };
};

const terminalCreepPattern = (points = []) => {
  const recent = points.slice(-20);
  let stopped = 0;
  let creeping = 0;
  let transitions = 0;
  let previousBand = null;
  recent.forEach((point) => {
    const speed = Number(point?.speed_kmh);
    if (!Number.isFinite(speed)) return;
    const band = speed <= 0.8 ? 'stopped' : speed <= 8 ? 'creeping' : 'moving';
    if (band === 'stopped') stopped += 1;
    if (band === 'creeping') creeping += 1;
    if (previousBand && previousBand !== band) transitions += 1;
    previousBand = band;
  });
  return {
    detected: stopped >= 2 && creeping >= 3 && transitions >= 4,
    stopped,
    creeping,
    transitions,
  };
};

const parkingLearningProfile = (signals = {}) => {
  const source = signals.parkingLearningProfile || signals.parking_learning_profile || {};
  return {
    feedbackCount: Math.max(0, Number(source.feedback_count) || 0),
    strictnessLevel: Math.max(0, Math.min(2, Number(source.strictness_level) || 0)),
    shortStopMaxSeconds: Math.max(45, Number(source.short_stop_max_seconds) || 45),
    inVehicleStopMaxSeconds: Math.max(120, Number(source.in_vehicle_stop_max_seconds) || 120),
    minimumAutomaticConfidence: Math.max(
      40,
      Math.min(70, Number(source.minimum_automatic_confidence) || 40)
    ),
  };
};

const confirmedParkingExit = (points = [], signals = {}) => {
  const activity = normalizedActivity(signals.activity);
  return signals.vehicleExitTransition === true ||
    signals.vehicleDisconnected === true ||
    obdIgnitionEvidence(points).ignitionOff ||
    (['walking', 'running', 'on_foot'].includes(activity.type) && activity.confidence >= 75);
};

/**
 * Rejects only strong transient-stop signatures. Ambiguous stops are retained
 * with lower confidence so a real parking location is not silently lost.
 */
export function classifyTransientParkingStop(points = [], signals = {}) {
  if (signals.manualEnd === true) return { rejected: false, reason: null };
  const activity = normalizedActivity(signals.activity);
  const stoppedSeconds = Math.max(0, Number(signals.stoppedSeconds) || 0);
  const obd = obdIgnitionEvidence(points);
  const learning = parkingLearningProfile(signals);
  if (confirmedParkingExit(points, signals)) return { rejected: false, reason: null };

  const creep = terminalCreepPattern(points);
  if (creep.detected && stoppedSeconds > 0 && stoppedSeconds < 5 * 60) {
    return { rejected: true, reason: 'possible_drive_through', evidence: creep };
  }
  if (obd.engineRunning && stoppedSeconds >= 30 && stoppedSeconds < 15 * 60) {
    return { rejected: true, reason: 'possible_fuel_or_engine_on_stop' };
  }
  if (
    activity.type === 'in_vehicle' &&
    activity.confidence >= 70 &&
    stoppedSeconds > 0 &&
    stoppedSeconds < learning.inVehicleStopMaxSeconds
  ) {
    return { rejected: true, reason: 'possible_traffic_or_dropoff_stop' };
  }
  if (stoppedSeconds > 0 && stoppedSeconds < learning.shortStopMaxSeconds) {
    return { rejected: true, reason: 'short_stop' };
  }
  return { rejected: false, reason: null };
}

const findGarageEntrance = (sourcePoints, selected, candidates) => {
  const clusterStartMs = timestampMs(candidates[0]);
  const possible = sourcePoints.filter((point) => (
    validCoordinate(point) &&
    !point?.masked_for_privacy &&
    !point?.privacy_gap &&
    !point?.privacy_live_redacted &&
    pointAccuracyM(point) <= 20 &&
    (!clusterStartMs || !timestampMs(point) || timestampMs(point) <= clusterStartMs) &&
    distanceM(point, selected) <= 300
  ));
  const entrance = possible.at(-1);
  return entrance ? {
    lat: Number(entrance.lat),
    lng: Number(entrance.lng),
    accuracy_m: Math.round(pointAccuracyM(entrance)),
  } : null;
};

/**
 * Produces an explainable local parking-confidence score. No coordinates are
 * included in the evidence so it is safe to mirror to the widget.
 */
export function scoreParkingConfidence({
  candidates = [],
  selected = null,
  spreadM = 0,
  durationSeconds = 0,
  signals = {},
  sourcePoints = [],
} = {}) {
  const evidence = [];
  let score = 0;
  const accuracyM = pointAccuracyM(selected);
  const endpoint = candidates.at(-1) || selected || {};
  const endpointSpeedKmh = Number(endpoint?.speed_kmh);
  const sampleCount = candidates.length;
  const refinementCount = candidates.filter((point) => point?.parking_refinement === true).length;
  const activity = normalizedActivity(signals.activity);
  const stoppedSeconds = Math.max(0, Number(signals.stoppedSeconds) || 0);
  const observedMovingSpeedKmh = Math.max(
    0,
    ...sourcePoints.map((point) => Number(point?.speed_kmh)).filter(Number.isFinite)
  );
  const lastMovingSpeedKmh = Math.max(
    observedMovingSpeedKmh,
    Math.max(0, Number(signals.lastMovingSpeedKmh) || 0)
  );
  const gpsDriftM = Number(signals.gpsDriftM);
  const obd = obdIgnitionEvidence(sourcePoints);
  const learning = parkingLearningProfile(signals);

  if (accuracyM <= 10) {
    score += 25;
    evidence.push('gps_accuracy_excellent');
  } else if (accuracyM <= 20) {
    score += 20;
    evidence.push('gps_accuracy_good');
  } else if (accuracyM <= 40) {
    score += 12;
    evidence.push('gps_accuracy_fair');
  } else {
    score += 4;
    evidence.push('gps_accuracy_weak');
  }

  if (sampleCount >= 5) {
    score += 15;
    evidence.push('stable_fix_cluster');
  } else if (sampleCount >= 3) {
    score += 12;
    evidence.push('multi_fix_cluster');
  } else if (sampleCount >= 2) {
    score += 6;
    evidence.push('two_fix_cluster');
  } else {
    evidence.push('single_fix_only');
  }

  if (durationSeconds >= 20) {
    score += 10;
    evidence.push('stop_observed_20s');
  } else if (durationSeconds >= 8) {
    score += 5;
    evidence.push('stop_observed_8s');
  }

  if (spreadM <= 10) {
    score += 15;
    evidence.push('gps_cluster_tight');
  } else if (spreadM <= 25) {
    score += 10;
    evidence.push('gps_cluster_stable');
  } else if (spreadM <= 60) {
    score += 3;
    evidence.push('gps_cluster_wide');
  } else {
    score -= 15;
    evidence.push('gps_cluster_unstable');
  }

  if (Number.isFinite(endpointSpeedKmh) && endpointSpeedKmh <= 2) {
    score += 10;
    evidence.push('near_zero_speed');
  } else if (Number.isFinite(endpointSpeedKmh) && endpointSpeedKmh <= 5) {
    score += 5;
    evidence.push('low_speed');
  } else if (Number.isFinite(endpointSpeedKmh) && endpointSpeedKmh > STOP_SPEED_KMH) {
    score -= 25;
    evidence.push('endpoint_still_moving');
  }

  if (stoppedSeconds >= 90) {
    score += 10;
    evidence.push('sustained_stop');
  } else if (stoppedSeconds >= 30) {
    score += 5;
    evidence.push('stop_duration_support');
  }

  if (lastMovingSpeedKmh >= VEHICLE_SPEED_KMH) {
    score += 5;
    evidence.push('vehicle_movement_before_stop');
  }

  if (activity.type === 'still' && activity.confidence >= 70) {
    score += 10;
    evidence.push('activity_still');
  } else if (['walking', 'running', 'on_foot'].includes(activity.type) && activity.confidence >= 75) {
    score += 15;
    evidence.push('left_vehicle_on_foot');
  } else if (activity.type === 'in_vehicle' && activity.confidence >= 65) {
    score += 4;
    evidence.push('activity_in_vehicle');
  }

  if (Number.isFinite(gpsDriftM) && gpsDriftM <= 8) {
    score += 5;
    evidence.push('stop_drift_stable');
  }
  if (obd.ignitionOff) {
    score += 15;
    evidence.push('obd_ignition_off');
  } else if (obd.engineRunning) {
    evidence.push('obd_engine_running');
  }
  if (signals.vehicleDisconnected === true) {
    score += 15;
    evidence.push('vehicle_connection_disconnected');
  }
  if (signals.vehicleExitTransition === true) {
    score += 15;
    evidence.push('activity_vehicle_exit_transition');
  }
  if (learning.feedbackCount > 0) {
    evidence.push('personalized_parking_learning');
    if (!confirmedParkingExit(sourcePoints, signals) && learning.strictnessLevel > 0) {
      score -= learning.strictnessLevel * 4;
    }
  }
  if (signals.indoorEstimated === true) {
    score -= 8;
    evidence.push('indoor_location_estimated');
  }
  if (refinementCount >= 3) {
    score += 10;
    evidence.push('post_stop_refinement');
  } else if (refinementCount > 0) {
    score += 4;
    evidence.push('post_stop_refinement_partial');
  }
  if (signals.manualEnd === true) {
    evidence.push('manual_trip_end');
  } else if (String(signals.stopReason || '').trim()) {
    const reason = String(signals.stopReason).toLowerCase();
    evidence.push(reason.includes('park') || reason.includes('still')
      ? 'trip_end_parking_stop'
      : 'trip_end_reason_observed');
  }

  const confidenceScore = clampScore(score);
  const confidence = confidenceScore >= HIGH_CONFIDENCE_SCORE
    ? 'high'
    : confidenceScore >= MEDIUM_CONFIDENCE_SCORE
      ? 'medium'
      : 'estimated';
  return {
    confidence,
    confidenceScore,
    evidence: Array.from(new Set(evidence)),
    refinementCount,
  };
}

const selectRecordedMedoid = (points) => points.reduce((best, candidate) => {
  const distanceScore = points.reduce((sum, point) => sum + Math.min(200, distanceM(candidate, point)), 0);
  const score = distanceScore + pointAccuracyM(candidate) * 0.35;
  return !best || score < best.score ? { point: candidate, score } : best;
}, null)?.point || points[points.length - 1];

const buildTerminalWindow = (points) => {
  const valid = (Array.isArray(points) ? points : []).filter(validCoordinate);
  if (!valid.length) return [];
  const endpointMs = timestampMs(valid[valid.length - 1]);
  return valid
    .filter((point) => !endpointMs || !timestampMs(point) || endpointMs - timestampMs(point) <= MAX_TERMINAL_WINDOW_MS)
    .slice(-MAX_TERMINAL_POINTS);
};

const terminalStopCluster = (window) => {
  let lastVehicleIndex = -1;
  window.forEach((point, index) => {
    if (Number(point?.speed_kmh) >= VEHICLE_SPEED_KMH && pointAccuracyM(point) <= 60) lastVehicleIndex = index;
  });

  if (lastVehicleIndex >= 0 && lastVehicleIndex < window.length - 1) {
    const cluster = [];
    let anchor = null;
    for (const point of window.slice(lastVehicleIndex + 1)) {
      if (pointAccuracyM(point) > 50) continue;
      const speed = Number(point?.speed_kmh);
      if (Number.isFinite(speed) && speed > STOP_SPEED_KMH) {
        if (cluster.length) break;
        continue;
      }
      anchor ||= point;
      if (distanceM(anchor, point) > MAX_STOP_CLUSTER_RADIUS_M) break;
      cluster.push(point);
    }
    if (cluster.length) return cluster;
  }

  const endpoint = window[window.length - 1];
  return window.slice(-8).filter((point) => {
    const speed = Number(point?.speed_kmh);
    return distanceM(endpoint, point) <= MAX_STOP_CLUSTER_RADIUS_M &&
      (!Number.isFinite(speed) || speed <= STOP_SPEED_KMH);
  });
};

/**
 * Resolves a privacy-safe parking candidate from the terminal GPS fixes.
 * The returned coordinate is always one of the recorded fixes, never a fabricated centroid.
 * @param {Array<Record<string, any>>} points
 * @param {{
 *   endTime?: string | number | Date | null,
 *   parkingTimestamp?: string | number | Date | null,
 *   signals?: Record<string, any>,
 * }} [options]
 */
export function resolveParkedLocation(points, {
  endTime = null,
  parkingTimestamp = endTime,
  signals = {},
} = {}) {
  const sourcePoints = Array.isArray(points) ? points : [];
  const rawEndpoint = sourcePoints[sourcePoints.length - 1];
  if (rawEndpoint?.masked_for_privacy || rawEndpoint?.privacy_gap || rawEndpoint?.privacy_live_redacted) {
    return { location: null, suppressionReason: 'privacy_zone' };
  }
  if (!validCoordinate(rawEndpoint)) {
    return { location: null, suppressionReason: 'trip_end_unavailable' };
  }
  const transientStop = classifyTransientParkingStop(sourcePoints, signals);
  if (transientStop.rejected) {
    return {
      location: null,
      suppressionReason: null,
      ignoredReason: transientStop.reason,
      ignoredEvidence: transientStop.evidence || null,
    };
  }
  const endpointMs = timestampMs(rawEndpoint);
  const tripEndMs = Date.parse(String(endTime || ''));
  if (
    endpointMs > 0 &&
    Number.isFinite(tripEndMs) &&
    tripEndMs - endpointMs > MAX_ENDPOINT_AGE_MS
  ) {
    return { location: null, suppressionReason: 'stale_trip_end' };
  }

  const window = buildTerminalWindow(sourcePoints);
  const cluster = terminalStopCluster(window);
  const candidates = cluster.length ? cluster : [rawEndpoint];
  const selected = selectRecordedMedoid(candidates);
  const spreadM = Math.max(0, ...candidates.map((point) => distanceM(selected, point)));
  const firstMs = timestampMs(candidates[0]);
  const lastMs = timestampMs(candidates[candidates.length - 1]);
  const durationSeconds = firstMs && lastMs ? Math.max(0, (lastMs - firstMs) / 1000) : 0;
  const accuracyM = pointAccuracyM(selected);
  if (accuracyM > MAX_PARKING_ACCURACY_M) {
    return { location: null, suppressionReason: 'low_accuracy_trip_end' };
  }
  const meanClusterAccuracyM = candidates.reduce((sum, point) => sum + pointAccuracyM(point), 0) /
    Math.max(1, candidates.length);
  const indoorEstimated = signals.indoorMode === true ||
    accuracyM >= 30 ||
    meanClusterAccuracyM >= 35;
  const garageEntrance = indoorEstimated
    ? findGarageEntrance(sourcePoints, selected, candidates)
    : null;
  const confidenceResult = scoreParkingConfidence({
    candidates,
    selected,
    spreadM,
    durationSeconds,
    signals: { ...signals, indoorEstimated },
    sourcePoints,
  });
  const learning = parkingLearningProfile(signals);
  if (
    signals.manualEnd !== true &&
    learning.feedbackCount > 0 &&
    !confirmedParkingExit(sourcePoints, signals) &&
    confidenceResult.confidenceScore < learning.minimumAutomaticConfidence
  ) {
    return {
      location: null,
      suppressionReason: null,
      ignoredReason: 'learned_low_confidence_stop',
      ignoredEvidence: {
        confidenceScore: confidenceResult.confidenceScore,
        requiredScore: learning.minimumAutomaticConfidence,
      },
    };
  }

  return {
    location: {
      lat: Number(selected.lat),
      lng: Number(selected.lng),
      endpointLat: Number(rawEndpoint.lat),
      endpointLng: Number(rawEndpoint.lng),
      timestamp: parkingTimestamp || selected.timestamp || new Date().toISOString(),
      accuracyM: Number.isFinite(accuracyM) ? Math.round(accuracyM) : null,
      confidence: confidenceResult.confidence,
      confidenceScore: confidenceResult.confidenceScore,
      evidence: confidenceResult.evidence,
      strategy: confidenceResult.refinementCount >= 3
        ? 'post_stop_refinement'
        : candidates.length > 1 ? 'terminal_stop_cluster' : 'last_trip_point',
      sampleCount: candidates.length,
      refinementCount: confidenceResult.refinementCount,
      spreadM: Math.round(spreadM),
      indoorEstimated,
      garageEntrance,
    },
    suppressionReason: null,
  };
}
