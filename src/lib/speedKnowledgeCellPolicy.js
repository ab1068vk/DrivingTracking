import {
  assessSpeedLimitEvidence,
  speedLimitSourceProfile,
} from '@/lib/speedLimitConfidence';

export const TRUSTED_SPEED_KNOWLEDGE_CELL_SOURCES = new Set([
  'trip_consensus',
  'user_confirmed_posted_sign',
  'user_entered_estimate',
  'user_correction',
  'openstreetmap',
]);
export const MAX_SAVED_SPEED_LIMIT_KMH = 210;
export const MIN_TRIP_CONSENSUS_EVIDENCE = 3;

export function speedKnowledgeCellIndependentTripCount(cell = {}) {
  const independentIds = new Set(
    (Array.isArray(cell?.tripEvidenceIds) ? cell.tripEvidenceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  // Legacy records did not retain evidence IDs. Accept their counters only
  // when both independently maintained counts agree, so a lone cached sample
  // cannot become operational merely because one field was inflated.
  const tripCount = Math.max(0, Math.floor(Number(cell?.tripCount) || 0));
  const evidenceCount = Math.max(0, Math.floor(Number(cell?.evidenceCount) || 0));
  return Math.max(independentIds.size, Math.min(tripCount, evidenceCount));
}

export function speedKnowledgeCellConfidence(cell = {}) {
  const explicit = Number(cell?.confidence);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(1, explicit));
  return Number(speedLimitSourceProfile(cell?.source).confidence) || 0;
}

export function speedKnowledgeCellEligibility(cell = {}, nowMs = Date.now()) {
  const limitKmh = Number(cell?.limitKmh);
  const source = String(cell?.source || '');
  const confidence = speedKnowledgeCellConfidence(cell);
  const evidence = assessSpeedLimitEvidence(cell || {}, nowMs);
  let reason = 'eligible';
  if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
    reason = 'invalid_limit';
  }
  else if (!TRUSTED_SPEED_KNOWLEDGE_CELL_SOURCES.has(source)) reason = 'untrusted_source';
  else if (
    source === 'trip_consensus' &&
    speedKnowledgeCellIndependentTripCount(cell) < MIN_TRIP_CONSENSUS_EVIDENCE
  ) reason = 'insufficient_independent_trip_evidence';
  else if (confidence < 0.55) reason = 'low_confidence';
  else if (evidence.expired) reason = 'expired';
  else if (evidence.stale) reason = 'stale';
  else if (evidence.conflict) reason = 'conflict';
  return {
    eligible: reason === 'eligible',
    reason,
    source,
    limitKmh: Number.isFinite(limitKmh) ? limitKmh : null,
    confidence,
    evidence,
  };
}
