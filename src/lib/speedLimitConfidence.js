const DAY_MS = 86400000;

/** Agreeing observations needed before a learned limit earns a corroboration bonus. */
const MIN_CORROBORATION_EVIDENCE = 3;
/** Matches MIN_OPERATIONAL_AGREEMENT in localRoadMemory.js. */
const MIN_AGREEMENT_RATIO_FOR_BONUS = 0.67;

/**
 * Fixed reference profile per speed-limit source.
 *
 * These `confidence` numbers are NOT learned or measured: they are provisional
 * constants expressing how much each source type is trusted by policy. They do
 * not reflect this user's observed hit rate for any source, and they never
 * change with use. UI that surfaces them should say "reference profile", not
 * imply a computed confidence.
 */
export const SPEED_LIMIT_SOURCE_PROFILES = Object.freeze({
  user_confirmed_posted_sign: {
    confidence: 0.92,
    level: 'high',
    authority: 'confirmed',
    reviewAfterDays: 365,
    scoringWeight: 1,
  },
  openstreetmap: {
    confidence: 0.90,
    level: 'high',
    authority: 'mapped',
    reviewAfterDays: 270,
    scoringWeight: 1,
  },
  user_entered_estimate: {
    confidence: 0.75,
    level: 'medium',
    authority: 'estimated',
    reviewAfterDays: 120,
    scoringWeight: 0.65,
  },
  user_correction: {
    confidence: 0.75,
    level: 'medium',
    authority: 'estimated',
    reviewAfterDays: 120,
    scoringWeight: 0.65,
  },
  trip_consensus: {
    confidence: 0.68,
    level: 'medium',
    authority: 'learned',
    reviewAfterDays: 90,
    scoringWeight: 0.55,
  },
  learned_local: {
    confidence: 0.65,
    level: 'medium',
    authority: 'learned',
    reviewAfterDays: 90,
    scoringWeight: 0.55,
  },
  local_road_memory: {
    confidence: 0.62,
    level: 'medium',
    authority: 'learned',
    reviewAfterDays: 120,
    scoringWeight: 0.55,
  },
  time_of_day_bucket: {
    confidence: 0.55,
    level: 'low',
    authority: 'learned',
    reviewAfterDays: 45,
    scoringWeight: 0.45,
  },
  osm_highway_default: {
    confidence: 0.48,
    level: 'low',
    authority: 'estimated',
    reviewAfterDays: 60,
    scoringWeight: 0.5,
  },
  region_default_estimate: {
    confidence: 0.40,
    level: 'low',
    authority: 'estimated',
    reviewAfterDays: 45,
    scoringWeight: 0.5,
  },
  inferred: {
    confidence: 0.35,
    level: 'low',
    authority: 'inferred',
    reviewAfterDays: 30,
    scoringWeight: 0.5,
  },
  missing_posted_review: {
    confidence: 0,
    level: 'unavailable',
    authority: 'missing',
    reviewAfterDays: 0,
    scoringWeight: 0,
  },
  unknown: {
    confidence: 0,
    level: 'unavailable',
    authority: 'missing',
    reviewAfterDays: 0,
    scoringWeight: 0,
  },
});

const profileForSource = (source) => (
  SPEED_LIMIT_SOURCE_PROFILES[source] || SPEED_LIMIT_SOURCE_PROFILES.unknown
);

const finiteTimestamp = (value) => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function speedLimitSourceProfile(source) {
  return { ...profileForSource(source) };
}

export function speedLimitConfidenceLevel(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence <= 0) return 'unavailable';
  if (confidence >= 0.82) return 'high';
  if (confidence >= 0.58) return 'medium';
  return 'low';
}

export function assessSpeedLimitEvidence(record = {}, nowMs = Date.now()) {
  const source = record.source ?? record.speed_limit_source ?? 'unknown';
  const profile = profileForSource(source);
  const explicitConfidence = Number(record.confidence ?? record.speed_limit_confidence);
  const baseConfidence = Number.isFinite(explicitConfidence)
    ? Math.max(0, Math.min(1, explicitConfidence))
    : profile.confidence;
  const verifiedTimestamp = finiteTimestamp(
    record.verifiedAt ??
    record.lastVerifiedAt ??
    record.appliedAt ??
    record.lastUpdatedAt ??
    record.speed_limit_verified_at
  );
  const ageDays = verifiedTimestamp == null
    ? null
    : Math.max(0, Math.floor((nowMs - verifiedTimestamp) / DAY_MS));
  const stale = profile.reviewAfterDays > 0 &&
    ageDays != null &&
    ageDays > profile.reviewAfterDays;
  const expired = finiteTimestamp(record.expiresAt) != null &&
    finiteTimestamp(record.expiresAt) <= nowMs;
  const conflict = record.conflict === true || Boolean(record.conflictDetails);
  const evidenceCount = Math.max(
    0,
    Number(record.evidenceCount ?? record.tripCount ?? record.sampleCount) || 0
  );

  // The corroboration bonus must be earned by evidence that *agrees*. It used to
  // read the raw evidence count, and the learner incremented that count on the
  // disagreement branch too — so repeatedly contradicting a saved limit could
  // push it past the threshold and raise its confidence.
  const explicitAgreeingCount = Number(record.agreeingEvidenceCount ?? record.agreementCount);
  const agreeingEvidenceCount = Math.max(
    0,
    Number.isFinite(explicitAgreeingCount) ? explicitAgreeingCount : (conflict ? 0 : evidenceCount)
  );
  const agreementRatio = Number(record.agreementRatio);
  const agreementSupported = Number.isFinite(agreementRatio)
    ? agreementRatio >= MIN_AGREEMENT_RATIO_FOR_BONUS
    : !conflict;

  let confidence = baseConfidence;
  if (stale) confidence -= profile.authority === 'confirmed' ? 0.12 : 0.18;
  if (conflict) confidence -= 0.22;
  if (expired) confidence = 0;
  if (
    agreeingEvidenceCount >= MIN_CORROBORATION_EVIDENCE &&
    agreementSupported &&
    profile.authority === 'learned'
  ) {
    confidence += 0.05;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    source,
    confidence,
    confidencePercent: Math.round(confidence * 100),
    level: speedLimitConfidenceLevel(confidence),
    authority: profile.authority,
    scoringWeight: profile.scoringWeight,
    evidenceCount,
    agreeingEvidenceCount,
    agreementRatio: Number.isFinite(agreementRatio) ? agreementRatio : null,
    ageDays,
    stale,
    expired,
    conflict,
    reviewAfterDays: profile.reviewAfterDays,
    needsReview: expired || conflict || stale || confidence < 0.58,
  };
}

export function speedLimitConfidenceLabel(evidence = {}) {
  if (evidence.expired) return 'Expired';
  if (evidence.conflict) return 'Conflicted';
  if (evidence.level === 'high') return 'High confidence';
  if (evidence.level === 'medium') return 'Medium confidence';
  if (evidence.level === 'low') return 'Low confidence';
  return 'No verified limit';
}
