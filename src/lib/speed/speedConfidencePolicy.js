/**
 * One place that turns "how much do we trust this speed limit" into every
 * downstream consequence: the scoring penalty weight, the margin the badge
 * turns red at, the margin the app speaks at, and whether it may speak at all.
 *
 * These four decisions used to live in four modules and disagree. The two that
 * mattered most:
 *
 *   - Voice fired *before* the badge appeared. The voice margin was a flat 12
 *     km/h for every estimated tier while GPS_INFERRED's visual margin was 20,
 *     so the app spoke at +12 but refused to display until +20. `voiceMarginKmh`
 *     is now clamped to never be tighter than `visualMarginKmh`.
 *   - Compliance weighted a limit by its *resolved* evidence (staleness,
 *     conflict and expiry applied) while the speeding-event penalty re-derived
 *     the weight from the static source profile. Same limit, two weights. Both
 *     now call `speedPenaltyWeightForConfidence` with the resolved confidence.
 *
 * Confidence in, policy out. Callers pass the confidence they resolved; this
 * module never re-derives it from a source string when a resolved value exists.
 */
import { SPEED_ALERT_MIN_CONFIDENCE } from '@/lib/appConstants';
import { speedLimitSourceProfile } from '@/lib/speedLimitConfidence';
import {
  canonicalSpeedSource,
  canonicalSpeedTier,
  isEstimatedSpeedTier,
  voiceCooldownMsForTier,
} from '@/lib/speed/speedTierNames';

/** Sources that carry their own accumulated evidence, which beats the profile default. */
const SOURCES_WITH_OWN_CONFIDENCE = new Set([
  'user_confirmed_posted_sign',
  'user_entered_estimate',
  'learned_local',
  'local_road_memory',
]);

const finiteSetting = (value, fallback) => {
  if (value === '' || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/**
 * Confidence in a speed limit from a given source.
 *
 * SPEED_LIMIT_SOURCE_PROFILES in speedLimitConfidence.js is the single source of
 * truth for the per-source defaults. A stored per-record confidence still wins
 * where one exists: a user-confirmed sign or a learned local limit carries its
 * own accumulated evidence, which is more specific than a source-level default.
 */
export function confidenceForSource(source, learnedLocalConfidence = null) {
  const explicitConfidence = learnedLocalConfidence == null ? null : Number(learnedLocalConfidence);
  const canonical = canonicalSpeedSource(source);
  if (SOURCES_WITH_OWN_CONFIDENCE.has(canonical) && Number.isFinite(explicitConfidence)) {
    return explicitConfidence;
  }
  const profileConfidence = Number(speedLimitSourceProfile(canonical)?.confidence);
  return Number.isFinite(profileConfidence) ? profileConfidence : 0.0;
}

/** Fraction of a speeding penalty that a limit of this confidence may charge. */
export function speedPenaltyWeightForConfidence(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return 0.0;
  if (value >= 0.95) return 1.0;
  if (value >= 0.90) return 0.95;
  if (value >= 0.65) return 0.85;
  if (value >= 0.45) return 0.55;
  if (value >= 0.30) return 0.50;
  return 0.0;
}

/** How far over the limit the badge waits before flagging. Infinity means never. */
export function visualAlertMarginKmh(confidence, baseMarginKmh = 5) {
  const value = Number(confidence);
  const base = Number.isFinite(Number(baseMarginKmh)) ? Number(baseMarginKmh) : 5;
  if (!Number.isFinite(value)) return Infinity;
  if (value >= 0.90) return base;
  if (value >= 0.65) return base + 3;
  if (value >= 0.45) return base + 7;
  if (value >= 0.30) return base + 15;
  return Infinity;
}

/** A limit this uncertain must not be spoken aloud. Native applies the same floor. */
export function meetsAlertConfidenceFloor(confidence, floor = SPEED_ALERT_MIN_CONFIDENCE) {
  const value = Number(confidence);
  return Number.isFinite(value) && value >= Number(floor);
}

/**
 * The spoken margin for a candidate.
 *
 * Never tighter than the visual margin: speaking about something the badge is
 * not yet willing to display is the inversion this clamp exists to prevent.
 */
export function voiceAlertMarginKmh(tierName, settings = {}, visualMarginKmh = 0) {
  const tier = canonicalSpeedTier(tierName || 'UNKNOWN');
  const estimatedDefault = finiteSetting(settings.estimated_voice_margin_kmh, 12);
  const requested = tier === 'GPS_INFERRED'
    ? finiteSetting(settings.inferred_voice_margin_kmh, estimatedDefault)
    : isEstimatedSpeedTier(tier)
      ? estimatedDefault
      : visualMarginKmh;
  return Math.max(Number(visualMarginKmh) || 0, requested);
}

/**
 * The full alert policy for a resolved candidate.
 *
 * @param {{limitKmh?: number, tier?: string, confidence?: number, alertMarginKmh?: number}} candidate
 * @param {Record<string, any>} settings
 */
export function speedAlertPolicy(candidate, settings = {}) {
  const tier = canonicalSpeedTier(candidate?.tier || 'UNKNOWN');
  const confidence = Number(candidate?.confidence) || 0;
  const baseMargin = finiteSetting(
    settings.threshold_speed_over_kmh ?? settings.SPEED_OVER_KMH,
    5
  );
  const visualMarginKmh = Number.isFinite(Number(candidate?.alertMarginKmh))
    ? Number(candidate.alertMarginKmh)
    : visualAlertMarginKmh(confidence, baseMargin);
  const voiceMarginKmh = voiceAlertMarginKmh(tier, settings, visualMarginKmh);

  const estimatedTier = isEstimatedSpeedTier(tier);
  const estimateGuidanceAllowed = settings.speed_estimates_enabled !== false || tier === 'POSTED';
  const confidenceFloor = finiteSetting(settings.speed_alert_min_confidence, SPEED_ALERT_MIN_CONFIDENCE);
  const meetsFloor = meetsAlertConfidenceFloor(confidence, confidenceFloor);

  const speechAllowedForTier = tier === 'POSTED'
    ? settings.speak_posted_speed_warnings !== false
    : (estimatedTier || tier === 'GPS_INFERRED') && settings.speak_estimated_speed_checks === true;

  const voiceAllowed =
    settings.voice_alerts_enabled !== false &&
    estimateGuidanceAllowed &&
    speechAllowedForTier &&
    meetsFloor;

  const visualAllowed =
    settings.speed_warning_enabled !== false &&
    tier !== 'UNKNOWN' &&
    estimateGuidanceAllowed;

  return {
    tier,
    confidence,
    marginKmh: visualMarginKmh,
    visualMarginKmh,
    voiceMarginKmh,
    visualAllowed,
    voiceAllowed,
    meetsConfidenceFloor: meetsFloor,
    confidenceFloor,
    penaltyWeight: speedPenaltyWeightForConfidence(confidence),
    messageMode: tier === 'POSTED'
      ? 'posted_limit_warning'
      : tier === 'UNKNOWN' ? 'none' : 'speed_check',
    cooldownMs: voiceCooldownMsForTier(tier),
  };
}
