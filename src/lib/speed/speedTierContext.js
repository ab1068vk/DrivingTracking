/**
 * Wraps a resolved speed-limit context with the tier-aware alert margin and an
 * `shouldAlert` predicate.
 *
 * This existed byte-for-byte twice — in dashboardHelpers.js and inside
 * LiveCoachOverlay.jsx — so the two live surfaces could drift apart silently.
 * Both now import this.
 */
import { visualAlertMarginKmh } from '@/lib/speed/speedConfidencePolicy';

const SUPPRESSED_CONTEXT = Object.freeze({
  limitKmh: null,
  tier: 'UNKNOWN',
  confidence: 0,
  alertMarginKmh: Infinity,
});

export function createTierAwareSpeedLimitContext(context, settings = {}) {
  const limitKmh = context?.limitKmh ?? context?.effectiveLimitKmh ?? null;
  const confidence = Number(context?.confidence) || 0;
  const margin = visualAlertMarginKmh(confidence, settings.threshold_speed_over_kmh ?? 5);
  const tier = context?.tier || 'UNKNOWN';
  const estimateGuidanceAllowed = settings.speed_estimates_enabled !== false || tier === 'POSTED';

  if (!estimateGuidanceAllowed) {
    return { ...context, ...SUPPRESSED_CONTEXT, shouldAlert: () => false };
  }

  return {
    ...context,
    limitKmh,
    alertMarginKmh: margin,
    shouldAlert: (speedKmh) => (
      settings.speed_warning_enabled !== false &&
      Number.isFinite(Number(speedKmh)) &&
      Number.isFinite(Number(limitKmh)) &&
      Number(speedKmh) > Number(limitKmh) + margin
    ),
  };
}
