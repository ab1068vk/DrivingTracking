// @ts-check
// Pure module-scope helpers extracted from src/pages/Dashboard.jsx.
// None of these close over component state, JSX, or hooks — they were always
// module-scope in the page and are moved here byte-identical.
import { logError } from '@/lib/errorReporting';
import { isAndroid } from '@/lib/nativePlatform';
import { VOICE_COOLDOWNS_BY_TIER, alertMarginForConfidence, shouldWarnForSpeed } from '@/lib/speedLimitSource';
import { TRIP_STATES, formatSpeed } from '@/lib/tripEngine';
import { formatDistanceMeters, speedUnitLabel } from '@/lib/unitFormatting';
import { shouldMuteWebViewVoiceForTrip, speakSafetyAlertOnce } from '@/lib/voiceAlerts';
import { buildSpeedingMessage } from '@/lib/voiceAlertMessages';

export const RECOVERABLE_TRIP_STATES = new Set([TRIP_STATES.CANDIDATE, TRIP_STATES.CONFIRMED]);
export const LIVE_SPEED_ALERT_MIN_SECONDS = 30;
export const LIVE_SPEED_ALERT_MIN_POINTS = 3;

export const scheduleDashboardIdleWork = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 3000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, 500);
  return () => window.clearTimeout(id);
};

export function tripElapsedSeconds(trip, nowValue = Date.now()) {
  const startMs = new Date(trip?.start_time || 0).getTime();
  const nowMs = typeof nowValue === 'number' ? nowValue : new Date(nowValue || Date.now()).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs < startMs) return 0;
  return Math.round((nowMs - startMs) / 1000);
}

export function isFreshTripPoint(point, trip) {
  const pointMs = new Date(point?.timestamp || 0).getTime();
  const startMs = new Date(trip?.start_time || 0).getTime();
  if (!Number.isFinite(pointMs) || !Number.isFinite(startMs)) return true;
  return pointMs >= startMs - 5000;
}

export function hasLiveSpeedEvidence(trip, routePoints = [], point = null, nowValue = Date.now()) {
  if (!trip) return false;
  if (!isFreshTripPoint(point, trip)) return false;
  if ((Array.isArray(routePoints) ? routePoints.length : 0) < LIVE_SPEED_ALERT_MIN_POINTS) return false;
  return tripElapsedSeconds(trip, nowValue) >= LIVE_SPEED_ALERT_MIN_SECONDS;
}

export function shouldMuteDashboardWebViewVoice(trip) {
  return shouldMuteWebViewVoiceForTrip(trip, { isAndroidPlatform: isAndroid() });
}

export function createTierAwareSpeedLimitContext(context, settings = {}) {
  const limitKmh = context?.limitKmh ?? context?.effectiveLimitKmh ?? null;
  const confidence = Number(context?.confidence) || 0;
  const margin = alertMarginForConfidence(confidence, settings.threshold_speed_over_kmh ?? 5);
  const tier = context?.tier || 'UNKNOWN';
  const estimateGuidanceAllowed = settings.speed_estimates_enabled !== false || tier === 'POSTED';
  if (!estimateGuidanceAllowed) {
    return {
      ...context,
      limitKmh: null,
      tier: 'UNKNOWN',
      confidence: 0,
      alertMarginKmh: Infinity,
      shouldAlert: () => false,
    };
  }
  return {
    ...context,
    limitKmh,
    alertMarginKmh: margin,
    shouldAlert: (speedKmh) => (
      settings.speed_warning_enabled !== false &&
      estimateGuidanceAllowed &&
      Number.isFinite(Number(speedKmh)) &&
      Number.isFinite(Number(limitKmh)) &&
      Number(speedKmh) > Number(limitKmh) + margin
    ),
  };
}

export function annotatePointWithResolvedSpeedLimit(point = {}, resolved = null) {
  const limitKmh = Number(resolved?.limitKmh ?? resolved?.effectiveLimitKmh);
  if (!Number.isFinite(limitKmh) || limitKmh <= 0) return point;
  return {
    ...point,
    speed_limit_kmh: limitKmh,
    speed_limit_source: resolved.limitSource || resolved.source || point.speed_limit_source,
    speed_limit_tier: resolved.tier || point.speed_limit_tier,
    speed_limit_confidence: resolved.confidence ?? point.speed_limit_confidence,
    speed_limit_resolution_reason: resolved.resolutionReason || point.speed_limit_resolution_reason,
    speed_limit_fallback_reason: resolved.fallbackReason || point.speed_limit_fallback_reason,
    speed_limit_local_rule_id: resolved.localSpeedRule?.correctionId || point.speed_limit_local_rule_id,
    speed_limit_local_match_type: resolved.localSpeedRule?.matchType || point.speed_limit_local_match_type,
    speed_limit_local_match_distance_m: resolved.localSpeedRule?.matchDistanceM ?? point.speed_limit_local_match_distance_m,
    speed_limit_local_match_reason: resolved.localSpeedRule?.matchReason || point.speed_limit_local_match_reason,
  };
}

export function speedLimitBadgeForResolved(resolved, units = 'metric') {
  const tier = resolved?.tier || 'UNKNOWN';
  const limit = Number(resolved?.limitKmh);
  const displayLimit = Number.isFinite(limit) ? formatSpeed(limit, units) : null;
  const badgeByTier = {
    POSTED: {
      text: displayLimit == null ? `— ${speedUnitLabel(units)}` : displayLimit,
      className: 'border-emerald-200/70 bg-emerald-400/20 text-emerald-50',
    },
    MAP_ESTIMATED: {
      text: displayLimit == null ? `— ${speedUnitLabel(units)}` : `~${displayLimit} (road type)`,
      className: 'border-amber-200/70 bg-amber-400/20 text-amber-50',
    },
    LEARNED_LOCAL: {
      text: displayLimit == null ? `— ${speedUnitLabel(units)}` : `${displayLimit} (this road)`,
      className: 'border-amber-200/70 bg-amber-300/15 text-amber-50',
    },
    REGION_DEFAULT: {
      text: displayLimit == null ? `— ${speedUnitLabel(units)}` : `~${displayLimit} (regional estimate)`,
      className: 'border-dashed border-amber-200/70 bg-amber-400/15 text-amber-50',
    },
    GPS_INFERRED: {
      text: displayLimit == null ? `— ${speedUnitLabel(units)}` : `~${displayLimit} (estimated)`,
      className: 'border-dashed border-slate-200/60 bg-slate-400/15 text-slate-50',
    },
    UNKNOWN: {
      text: `— ${speedUnitLabel(units)}`,
      className: 'border-slate-200/40 bg-slate-500/20 text-slate-100',
    },
  };
  return badgeByTier[tier] || badgeByTier.UNKNOWN;
}

export function checkAndSpeakSpeedAlert(speed, resolved, settings, onAlert, { voiceMuted = false } = {}) {
  if (speed < 1) return;
  const warning = shouldWarnForSpeed({ speedKmh: speed, candidate: resolved, settings });
  if (!warning) return;

  if (warning.visual) {
    onAlert?.();
  }
  if (voiceMuted || !warning.voice) return;

  const message = buildSpeedingMessage({
    speedKmh: speed,
    speedLimitKmh: resolved.limitKmh,
    tier: resolved.tier,
  }, null, { settings });
  if (!message) return;

  speakSafetyAlertOnce(
    `speeding_${resolved.tier}`,
    message,
    settings,
    VOICE_COOLDOWNS_BY_TIER[resolved.tier] ?? 60000
  ).catch((error) => {
    logError('speed_alert_voice', error, {
      tier: resolved.tier,
      speed_kmh: Math.round(speed),
      speed_limit_kmh: resolved.limitKmh,
    });
  });
}

export function isRecoverableActiveTrip(trip) {
  if (!trip || typeof trip !== 'object') return false;
  if (trip.status !== 'active') return false;
  if (trip.end_time) return false;
  return RECOVERABLE_TRIP_STATES.has(trip.trip_state);
}

export function readinessPlannerTone(riskLevel) {
  if (riskLevel === 'high') {
    return {
      status: 'Reset first',
      headline: 'Not a great moment to start',
      color: '#ef4444',
      className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
      guidance: 'Take a short reset before driving, then start with extra following room and slower first inputs.',
    };
  }
  if (riskLevel === 'moderate') {
    return {
      status: 'Use margin',
      headline: 'Drive with extra margin',
      color: '#f97316',
      className: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/30 dark:text-orange-200',
      guidance: 'Start deliberately, keep more space ahead, and avoid trying to make up time.',
    };
  }
  if (riskLevel === 'low') {
    return {
      status: 'Good to go',
      headline: 'Good time to drive',
      color: '#22c55e',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200',
      guidance: 'Conditions look steady. Mount the phone, confirm GPS is ready, and keep your usual smooth rhythm.',
    };
  }
  return {
    status: 'Learning',
    headline: 'Use basic pre-drive checks',
    color: '#64748b',
    className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-200',
    guidance: 'The app needs more personal history for a firm estimate, but it can still flag fatigue, recent rest, and nearby history.',
  };
}

export function formatWatchDistance(distanceM, units = 'metric') {
  const meters = Number(distanceM);
  if (!Number.isFinite(meters)) return null;
  return formatDistanceMeters(meters, units);
}

export function eventTypeLabel(type) {
  return ({
    harsh_brake: 'harsh braking',
    sharp_turn: 'sharp turns',
    speeding: 'speeding',
    rapid_acceleration: 'rapid acceleration',
  }[type] || String(type || 'driving events').replace(/_/g, ' '));
}

export function watchZoneSortDistance(zone) {
  const distance = Number(zone?.distanceM);
  return Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER;
}


export function waitForTripEndingFeedbackPaint() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

export const lastUsableParkingPoint = (points = []) => (
  [...(Array.isArray(points) ? points : [])].reverse().find((point) => (
    Number.isFinite(Number(point?.lat)) &&
    Number.isFinite(Number(point?.lng)) &&
    !point?.masked_for_privacy &&
    !point?.privacy_gap &&
    !point?.privacy_live_redacted
  )) || null
);
