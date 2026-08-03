import {
  roadMemoryCandidateOperationalState,
  roadMemoryConfidenceExplanation,
  roadMemoryEvidenceConfidence,
} from '@/lib/localRoadMemory';

export const ROAD_MEMORY_INTELLIGENCE_VERSION = 1;
export const ROAD_MEMORY_MIN_FEEDBACK = 8;
export const ROAD_MEMORY_MIN_SHADOW_DRIVES = 20;
export const ROAD_MEMORY_SHADOW_WINDOW_DRIVES = 90;
export const ROAD_MEMORY_MIN_EXACT_RATE = 0.8;
export const ROAD_MEMORY_MIN_LOWER_BOUND = 0.55;

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

const roundedLimit = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
};

const wilsonLowerBound = (successes, total, z = 1.96) => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = clamp(successes / total);
  const denominator = 1 + (z ** 2 / total);
  const center = ratio + (z ** 2 / (2 * total));
  const margin = z * Math.sqrt((ratio * (1 - ratio) + z ** 2 / (4 * total)) / total);
  return clamp((center - margin) / denominator);
};

export function roadMemoryContextKey(candidate = {}) {
  const limit = roundedLimit(candidate.limitAtReviewKmh ?? candidate.limitKmh) || 0;
  const speedBand = limit <= 40
    ? '30-40'
    : limit <= 60
      ? '50-60'
      : limit <= 80
        ? '70-80'
        : '90+';
  const spread = Number(candidate.quality?.congestionSpreadKmh);
  const trafficBand = Number.isFinite(spread) && spread <= 12 ? 'stable' : 'mixed';
  const accuracy = Number(candidate.quality?.medianAccuracyM);
  const gpsBand = !Number.isFinite(accuracy)
    ? 'gps-unknown'
    : accuracy <= 10
      ? 'gps-strong'
      : accuracy <= 25
        ? 'gps-moderate'
        : 'gps-weak';
  const timeBand = (candidate.timeProfiles || []).some((profile) => profile?.eligible)
    ? 'time-pattern'
    : 'all-times';
  return `${speedBand}|${trafficBand}|${gpsBand}|${timeBand}`;
}

export function roadMemoryFeedbackForCandidate(candidate = {}) {
  const reviewState = String(candidate.reviewState || '');
  const storedOutcome = String(candidate.feedbackOutcome || '');
  if (!storedOutcome && !['confirmed', 'adjusted', 'rejected', 'kept_existing'].includes(reviewState)) {
    return null;
  }
  const proposedLimitKmh = roundedLimit(
    candidate.limitAtReviewKmh ??
    candidate.feedbackContext?.proposedLimitKmh ??
    candidate.limitKmh
  );
  const chosenLimitKmh = roundedLimit(
    candidate.reviewedLimitKmh ??
    candidate.feedbackContext?.chosenLimitKmh
  );
  const deltaKmh = proposedLimitKmh != null && chosenLimitKmh != null
    ? Math.abs(proposedLimitKmh - chosenLimitKmh)
    : null;
  let outcome = storedOutcome;
  if (!outcome) {
    if (reviewState === 'confirmed') outcome = deltaKmh === 0 ? 'exact' : 'adjusted';
    else if (reviewState === 'adjusted') outcome = deltaKmh === 0 ? 'exact' : 'adjusted';
    else outcome = 'rejected';
  }
  if (!['exact', 'adjusted', 'rejected'].includes(outcome)) return null;
  const score = outcome === 'exact' ? 1 : outcome === 'adjusted' && deltaKmh != null && deltaKmh <= 10 ? 0.35 : 0;
  return {
    candidateId: String(candidate.id || candidate.sectionKey || ''),
    outcome,
    score,
    exact: outcome === 'exact',
    proposedLimitKmh,
    chosenLimitKmh,
    deltaKmh,
    contextKey: candidate.feedbackContext?.contextKey || roadMemoryContextKey(candidate),
    reviewedAt: candidate.reviewedAt || null,
  };
}

export function buildRoadMemoryActivity(candidates = [], { limit = 8 } = {}) {
  const activity = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const reviewState = String(candidate?.reviewState || '');
    const changeStatus = String(candidate?.changeDetection?.status || '');
    const timestamp = candidate?.reviewedAt || candidate?.changeDetection?.resolvedAt ||
      candidate?.changeDetection?.detectedAt || candidate?.updatedAt || candidate?.lastObservedAt || null;
    const roadName = String(candidate?.roadName || candidate?.contextLabel || 'Local road corridor');
    if (reviewState === 'confirmed') {
      return { id: candidate.id, type: 'confirmed', title: 'Posted speed confirmed', detail: `${roadName} is now authoritative and blocks matching Road Memory suggestions.`, timestamp };
    }
    if (reviewState === 'adjusted') {
      return { id: candidate.id, type: 'adjusted', title: 'Speed corrected', detail: `${roadName} now uses the speed you selected.`, timestamp };
    }
    if (reviewState === 'kept_existing') {
      return { id: candidate.id, type: 'dismissed', title: 'Possible change dismissed', detail: `${roadName} keeps its established speed; the change warning is resolved.`, timestamp };
    }
    if (reviewState === 'rejected') {
      return { id: candidate.id, type: 'rejected', title: 'Suggestion rejected', detail: `${roadName} remains blocked from scores and alerts.`, timestamp };
    }
    if (reviewState === 'deferred') {
      return { id: candidate.id, type: 'deferred', title: 'Decision postponed', detail: `${roadName} remains paused until new evidence or another review.`, timestamp };
    }
    if (reviewState === 'time_profiles_accepted') {
      return { id: candidate.id, type: 'confirmed', title: 'Time-specific speeds accepted', detail: `${roadName} resolves its speed using the accepted time pattern.`, timestamp };
    }
    if (changeStatus === 'possible_change' || candidate?.stage === 'change_review') {
      return { id: candidate.id, type: 'warning', title: 'Possible speed change detected', detail: `${roadName} is paused and cannot affect scores or alerts until you decide.`, timestamp };
    }
    if (candidate?.stage === 'operational') {
      return { id: candidate.id, type: 'learned', title: 'Strong corridor evidence', detail: `${roadName} reached operational evidence but still follows local validation safeguards.`, timestamp };
    }
    return { id: candidate.id, type: 'learning', title: 'Corridor evidence updated', detail: `${roadName} is still learning in shadow mode.`, timestamp };
  });
  return activity
    .filter((entry) => entry.id)
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, Math.max(1, Number(limit) || 8));
}

const calibrationStats = (feedback = []) => {
  const total = feedback.length;
  const exact = feedback.filter((item) => item.exact).length;
  const adjusted = feedback.filter((item) => item.outcome === 'adjusted').length;
  const rejected = feedback.filter((item) => item.outcome === 'rejected').length;
  const weightedSuccess = feedback.reduce((sum, item) => sum + clamp(item.score), 0);
  const posteriorMean = (3 + weightedSuccess) / (4 + total);
  const exactRate = total ? exact / total : 0;
  const lowerBound = wilsonLowerBound(exact, total);
  const validated = total >= ROAD_MEMORY_MIN_FEEDBACK &&
    exactRate >= ROAD_MEMORY_MIN_EXACT_RATE &&
    lowerBound >= ROAD_MEMORY_MIN_LOWER_BOUND;
  const unreliable = total >= ROAD_MEMORY_MIN_FEEDBACK && exactRate < 0.55;
  return {
    feedbackCount: total,
    exactCount: exact,
    adjustedCount: adjusted,
    rejectedCount: rejected,
    exactRate: Math.round(exactRate * 1000) / 1000,
    lowerBound: Math.round(lowerBound * 1000) / 1000,
    posteriorMean: Math.round(posteriorMean * 1000) / 1000,
    validated,
    status: validated ? 'validated' : unreliable ? 'needs_tuning' : 'collecting',
    feedbackNeeded: Math.max(0, ROAD_MEMORY_MIN_FEEDBACK - total),
  };
};

export function buildRoadMemoryCalibration(candidates = []) {
  const source = Array.isArray(candidates) ? candidates : [];
  const feedback = source
    .map(roadMemoryFeedbackForCandidate)
    .filter(Boolean);
  const shadowDriveCount = Math.min(
    ROAD_MEMORY_SHADOW_WINDOW_DRIVES,
    new Set(source.flatMap((candidate) => (candidate.tripIds || []).map(String)).filter(Boolean)).size
  );
  const byContext = {};
  feedback.forEach((item) => {
    byContext[item.contextKey] ??= [];
    byContext[item.contextKey].push(item);
  });
  const contexts = Object.fromEntries(Object.entries(byContext).map(([key, items]) => [
    key,
    calibrationStats(items),
  ]));
  const globalStats = calibrationStats(feedback);
  const parkedValidationPassed = globalStats.validated;
  const shadowValidationPassed = shadowDriveCount >= ROAD_MEMORY_MIN_SHADOW_DRIVES;
  const validated = parkedValidationPassed && shadowValidationPassed;
  return {
    version: ROAD_MEMORY_INTELLIGENCE_VERSION,
    ...globalStats,
    validated,
    status: validated
      ? 'validated'
      : globalStats.status === 'needs_tuning'
        ? 'needs_tuning'
        : 'collecting',
    parkedValidationPassed,
    shadowValidationPassed,
    shadowDriveCount,
    shadowDriveTarget: ROAD_MEMORY_MIN_SHADOW_DRIVES,
    shadowWindowDrives: ROAD_MEMORY_SHADOW_WINDOW_DRIVES,
    contexts,
    feedback: feedback.slice(-100),
  };
}

const calibrationForCandidate = (candidate, calibration) => (
  calibration?.contexts?.[roadMemoryContextKey(candidate)] || null
);

export function decorateRoadMemoryCandidate(candidate = {}, calibration = null, nowMs = Date.now()) {
  // Persisted candidates may already contain a display/calibrated confidence
  // from older builds. Reconstruct the evidence confidence from independent
  // votes when the dedicated raw field is absent, then keep it immutable while
  // deriving model confidence. This makes decoration idempotent.
  const evidenceConfidence = clamp(
    candidate.evidenceConfidence ??
    candidate.rawConfidence ??
    roadMemoryEvidenceConfidence(
      Number(candidate.tripCount) || 0,
      Number(candidate.agreement) || 0
    )
  );
  const baseState = roadMemoryCandidateOperationalState({
    ...candidate,
    evidenceConfidence,
  }, nowMs);
  const model = calibration || buildRoadMemoryCalibration([candidate]);
  const contextCalibration = calibrationForCandidate(candidate, model);
  // Global validation guards the overall learner, but it must not authorize a
  // speed/traffic/GPS/time context that has never been tested by parked review.
  const confidenceCalibration = contextCalibration?.feedbackCount >= 4
    ? contextCalibration
    : model;
  const agreement = clamp(candidate.agreement);
  const tripCount = Math.max(0, Number(candidate.tripCount) || 0);
  const confidence = clamp(baseState.effectiveConfidence);
  const voteCounts = Object.values(candidate.limitVotes || {})
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
  const voteTotal = voteCounts.reduce((sum, value) => sum + value, 0);
  const voteMargin = voteTotal
    ? ((voteCounts[0] || 0) - (voteCounts[1] || 0)) / voteTotal
    : agreement;
  const calibratedConfidence = Math.round(clamp(
    confidence * (0.72 + clamp(confidenceCalibration?.posteriorMean, 0, 1) * 0.28) *
    (0.8 + agreement * 0.2)
  ) * 100) / 100;
  const resolved = ['confirmed', 'adjusted', 'rejected'].includes(candidate.reviewState);
  const possibleChange = candidate.changeDetection?.status === 'possible_change';
  const contextSupported = contextCalibration?.feedbackCount >= 4 &&
    contextCalibration.exactRate >= 0.75 &&
    contextCalibration.posteriorMean >= 0.7;
  const validationReady = model.validated === true && contextSupported;
  const candidateReady = baseState.stage === 'operational' &&
    tripCount >= 4 &&
    agreement >= 0.75 &&
    voteMargin >= 0.5 &&
    confidence >= 0.64 &&
    Array.isArray(candidate.sectionPoints) && candidate.sectionPoints.length >= 2;
  const canAffect = !resolved && !possibleChange && !baseState.stale && validationReady && candidateReady;
  const usageStage = resolved
    ? 'resolved'
    : possibleChange
      ? 'review_required'
      : canAffect
        ? 'validated'
        : candidateReady || baseState.stage === 'operational'
          ? 'shadow'
          : 'learning';
  const validationReason = canAffect
    ? `Validated by ${model.feedbackCount} parked decisions at ${Math.round(model.exactRate * 100)}% exact agreement.`
    : !model.validated
      ? model.parkedValidationPassed && !model.shadowValidationPassed
        ? `${model.shadowDriveCount} of ${model.shadowDriveTarget} private shadow drives evaluated; estimates remain blocked.`
        : model.feedbackCount === 0
        ? 'No parked confirmations have tested this learning model yet.'
        : `${model.feedbackCount} of ${ROAD_MEMORY_MIN_FEEDBACK} parked decisions collected; new estimates remain in shadow mode.`
      : !candidateReady
        ? `This corridor still needs ${Math.max(0, 4 - tripCount)} more stable drive${Math.max(0, 4 - tripCount) === 1 ? '' : 's'} or stronger agreement.`
        : !contextSupported
          ? `This road context has ${Number(contextCalibration?.feedbackCount) || 0} of 4 supporting parked decisions; it remains in shadow mode.`
        : 'This evidence is paused for review.';
  return {
    ...candidate,
    evidenceConfidence: Math.round(evidenceConfidence * 100) / 100,
    ...baseState,
    active: canAffect,
    baseStage: baseState.stage,
    usageStage,
    shadowMode: usageStage === 'shadow' || usageStage === 'learning',
    canAffectScoreAndAlerts: canAffect,
    calibratedConfidence,
    voteMargin: Math.round(clamp(voteMargin) * 100) / 100,
    uncertainty: Math.round(clamp(1 - (
      agreement * 0.45 +
      confidence * 0.25 +
      clamp(confidenceCalibration?.posteriorMean) * 0.2 +
      clamp(voteMargin) * 0.1
    )) * 100) / 100,
    confidence: Math.min(confidence, calibratedConfidence),
    validationReason,
    contextCalibration: {
      feedbackCount: Number(contextCalibration?.feedbackCount) || 0,
      exactRate: Number(contextCalibration?.exactRate) || 0,
      posteriorMean: Number(contextCalibration?.posteriorMean) || 0,
      validated: contextSupported,
      contextKey: roadMemoryContextKey(candidate),
    },
    confidenceExplanation: `${roadMemoryConfidenceExplanation(candidate, nowMs)} · ${validationReason}`,
  };
}

export function decorateRoadMemoryCandidates(candidates = [], nowMs = Date.now()) {
  const source = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  const calibration = buildRoadMemoryCalibration(source);
  const decorated = source.map((candidate) => decorateRoadMemoryCandidate(candidate, calibration, nowMs));
  return { candidates: decorated, calibration };
}

const reviewQueueFromDecorated = (decorated, calibration, limit) => {
  const items = decorated
    .filter((candidate) => {
      if (['confirmed', 'adjusted', 'rejected'].includes(candidate.reviewState)) return false;
      if (['deferred', 'kept_existing'].includes(candidate.reviewState) &&
        Number(candidate.tripCount) <= Number(candidate.lastPromptedTripCount)) return false;
      return ['suggested', 'operational', 'change_review'].includes(candidate.baseStage || candidate.stage);
    })
    .map((candidate) => {
      const stage = candidate.baseStage || candidate.stage;
      const disagreement = 1 - clamp(candidate.agreement);
      const priority = Math.round(
        (stage === 'change_review' ? 140 : stage === 'operational' ? 80 : 45) +
        Math.min(24, (Number(candidate.tripCount) || 0) * 4) +
        disagreement * 25 +
        clamp(candidate.uncertainty) * 20 +
        (candidate.shadowMode ? 15 : 0)
      );
      const why = stage === 'change_review'
        ? 'Recent drives disagree with the established corridor belief, so it is paused.'
        : candidate.shadowMode
          ? 'This is one of the strongest unverified corridors and gives the learning model useful feedback.'
          : 'A parked check can replace the lower-authority estimate with a confirmed posted limit.';
      const expectedImpact = calibration.feedbackNeeded > 0
        ? `This decision leaves ${Math.max(0, calibration.feedbackNeeded - 1)} more before the model can qualify for validation.`
        : !calibration.shadowValidationPassed
          ? `${Math.max(0, calibration.shadowDriveTarget - calibration.shadowDriveCount)} more distinct drives are needed for the shadow sample.`
        : 'This decision keeps the model calibrated and can improve future review ordering.';
      return { candidate, priority, why, expectedImpact };
    })
    .sort((a, b) => b.priority - a.priority ||
      Number(b.candidate.tripCount) - Number(a.candidate.tripCount))
    .slice(0, Math.max(1, Number(limit) || 8));
  return { items, calibration, totalEligible: decorated.length };
};

export function buildRoadMemoryReviewQueue(candidates = [], { limit = 8 } = {}) {
  const { candidates: decorated, calibration } = decorateRoadMemoryCandidates(candidates);
  return reviewQueueFromDecorated(decorated, calibration, limit);
}

export function analyzeRoadMemoryIntelligence(candidates = [], { reviewLimit = 8 } = {}) {
  const { candidates: decorated, calibration } = decorateRoadMemoryCandidates(candidates);
  const queue = reviewQueueFromDecorated(decorated, calibration, reviewLimit);
  const summary = {
    version: ROAD_MEMORY_INTELLIGENCE_VERSION,
    candidateCount: decorated.length,
    learningCount: decorated.filter((item) => item.usageStage === 'learning').length,
    shadowCount: decorated.filter((item) => item.usageStage === 'shadow').length,
    validatedCount: decorated.filter((item) => item.canAffectScoreAndAlerts).length,
    reviewRequiredCount: decorated.filter((item) => item.usageStage === 'review_required').length,
    reviewQueueCount: queue.items.length,
    calibration,
  };
  return { candidates: decorated, calibration, queue, summary };
}

export function summarizeRoadMemoryIntelligence(candidates = []) {
  return analyzeRoadMemoryIntelligence(candidates).summary;
}
