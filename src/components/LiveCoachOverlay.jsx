// @ts-check
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import {
  buildDrivingThresholds,
  calculateTripStats,
  detectDrivingEvents,
  EVENT_TYPES,
  formatSpeed,
  reliablePointSpeed,
  resolveEffectiveSpeedLimitForIndex,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { speedUnitLabel } from '@/lib/unitFormatting';
import {
  notifyHeadingDriftBetaWarning,
  notifyFatigueBreakReminder,
  notifyPhoneUseDetected,
  notifySpeedingAlert,
} from '@/lib/notificationService';
import { isAndroid } from '@/lib/nativePlatform';
import { buildPhoneUseFromAndroidUsage, mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { speakSafetyAlert, speakSafetyAlertOnce } from '@/lib/voiceAlerts';
import { shouldWarnForSpeed, VOICE_COOLDOWNS_BY_TIER } from '@/lib/speedLimitSource';
import { createTierAwareSpeedLimitContext } from '@/lib/speed/speedTierContext';
import { buildSpeedingMessage, buildVoiceAlertMessage } from '@/lib/voiceAlertMessages';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { COACH_FOCUS_CATALOG, loadCoachProgramStore } from '@/lib/coachPrograms';

// CHANGES (session):
// - Added tier-aware speed alert helpers for LiveCoachOverlay.
// - Modified live coach speed alerts to use buildSpeedingMessage and speeding_${resolved.tier} cooldowns.
// - Modified live coach speed alert badge to render tier-aware text and styles.
// - Renamed regional default badge wording away from legal certainty.
// - Use speed-check display wording for non-POSTED speed tiers.
// - Wired live coach speed checks to speed estimate and tier voice settings.

const RECENT_WINDOW_MS = 120000;
const CHECK_INTERVAL_MS = 15000;
const DISPLAY_MS = 8000;
const PHONE_DISPLAY_MS = 15000;
const getAndroidPhoneUsageSummaryForOverlay = (...args) => import('@/lib/activityRecognition')
  .then(({ getAndroidPhoneUsageSummary }) => getAndroidPhoneUsageSummary(...args));
const VOICE_COOLDOWNS_MS = {
  phone_use: 120000,
  close_proximity: 120000,
  harsh_brake: 30000,
  stop_start_pattern: 60000,
  heading_drift_beta: 10 * 60 * 1000,
  rapid_accel: 30000,
  long_drive: 30 * 60 * 1000,
  idle: 5 * 60 * 1000,
};

function speedLimitBadgeForResolved(resolved, units = 'metric') {
  const tier = resolved?.tier || 'UNKNOWN';
  const limit = Number(resolved?.limitKmh);
  const displayLimit = Number.isFinite(limit) ? formatSpeed(limit, units) : null;
  const badgeByTier = {
    POSTED: {
      text: displayLimit == null ? `â€” ${speedUnitLabel(units)}` : displayLimit,
      className: 'border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100',
    },
    MAP_ESTIMATED: {
      text: displayLimit == null ? `â€” ${speedUnitLabel(units)}` : `~${displayLimit} (road type)`,
      className: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100',
    },
    LEARNED_LOCAL: {
      text: displayLimit == null ? `â€” ${speedUnitLabel(units)}` : `${displayLimit} (this road)`,
      className: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100',
    },
    REGION_DEFAULT: {
      text: displayLimit == null ? `â€” ${speedUnitLabel(units)}` : `~${displayLimit} (regional estimate)`,
      className: 'border-dashed border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100',
    },
    GPS_INFERRED: {
      text: displayLimit == null ? `â€” ${speedUnitLabel(units)}` : `~${displayLimit} (estimated)`,
      className: 'border-dashed border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
    },
    UNKNOWN: {
      text: `â€” ${speedUnitLabel(units)}`,
      className: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
    },
  };
  return badgeByTier[tier] || badgeByTier.UNKNOWN;
}

function buildTierAwareSpeedAlert(speed, resolved, settings = {}) {
  if (speed < 1) return null;
  const warning = shouldWarnForSpeed({ speedKmh: speed, candidate: resolved, settings });
  if (!warning) return null;

  const voiceText = warning.voice
    ? buildSpeedingMessage({
      speedKmh: speed,
      speedLimitKmh: resolved.limitKmh,
      tier: resolved.tier,
    }, null, { settings })
    : null;
  if (warning.voice && !voiceText) return null;

  const badge = speedLimitBadgeForResolved(resolved, settings.units || 'metric');
  const displayLabel = resolved.tier === 'POSTED' ? 'Speed warning' : 'Speed check';
  return {
    text: (
      <>
        <span className="block text-sm font-bold">{displayLabel}. {formatSpeed(speed, settings.units || 'metric')}.</span>
        <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>
          {badge.text}
        </span>
      </>
    ),
    voiceKey: `speeding_${resolved.tier}`,
    voiceText,
    voiceCooldownMs: warning.cooldownMs ?? VOICE_COOLDOWNS_BY_TIER[resolved.tier] ?? 60000,
    silent: !warning.voice,
  };
}

const plainText = (message) => {
  if (typeof message === 'string') return message;
  if (typeof message?.props?.children === 'string') return message.props.children;
  if (Array.isArray(message?.props?.children)) {
    return message.props.children
      .map((child) => plainText(child))
      .join(' ')
      .trim();
  }
  return 'Road Sage safety alert';
};

export default function LiveCoachOverlay({
  currentRoutePoints = [],
  currentEvents = [],
  tripStartTime,
  voiceMuted = false,
}) {
  const [message, setMessage] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const visibleRef = useRef(false);
  const queueRef = useRef([]);
  const lastCoachCheckRef = useRef(0);
  const lastDisplayedAlertRef = useRef({});
  const localSpeedKnowledgeRef = useRef(null);
  const activeProgramRef = useRef(null);
  const missionBriefedRef = useRef(false);
  const missionPromptCountRef = useRef(0);
  const previousCountsRef = useRef({
    [EVENT_TYPES.HARSH_BRAKE]: currentEvents.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length,
    [EVENT_TYPES.RAPID_ACCELERATION]: currentEvents.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length,
    [EVENT_TYPES.SHARP_TURN]: currentEvents.filter((event) => event.type === EVENT_TYPES.SHARP_TURN).length,
    [EVENT_TYPES.STOP_START_PATTERN]: currentEvents.filter((event) => event.type === EVENT_TYPES.STOP_START_PATTERN || event.type === EVENT_TYPES.TAILGATE_CYCLE).length,
  });

  const showNext = () => {
    if (visibleRef.current || queueRef.current.length === 0) return;
    visibleRef.current = true;
    const next = queueRef.current.shift();
    const normalized = typeof next === 'string' ? { text: next, tone: 'default' } : next;
    const settings = localSettings.get();
    if (!normalized.silent && !voiceMuted) {
      const voiceText = plainText(normalized.voiceText ?? normalized.text);
      const speak = normalized.voiceKey
        ? speakSafetyAlertOnce(
          normalized.voiceKey,
          voiceText,
          settings,
          normalized.voiceCooldownMs,
          undefined,
          normalized.voiceParams
        ).catch(() => {})
        : speakSafetyAlert(voiceText, settings, normalized.voiceParams).catch(() => {});
      void speak;
    }
    if (!dismissed) setMessage(normalized);
    setTimeout(() => {
      visibleRef.current = false;
      setMessage(null);
      showNext();
    }, normalized?.displayMs || DISPLAY_MS);
  };

  // showNext is self-recursive via setTimeout, so a useCallback would have to
  // depend on itself. Reading it through a ref keeps the coach interval below
  // from restarting every render while still calling the latest closure.
  const showNextRef = useRef(showNext);
  showNextRef.current = showNext;

  useEffect(() => {
    setDismissed(false);
    previousCountsRef.current = {
      [EVENT_TYPES.HARSH_BRAKE]: 0,
      [EVENT_TYPES.RAPID_ACCELERATION]: 0,
      [EVENT_TYPES.SHARP_TURN]: 0,
      [EVENT_TYPES.STOP_START_PATTERN]: 0,
    };
    lastCoachCheckRef.current = new Date(tripStartTime).getTime() || Date.now();
    lastDisplayedAlertRef.current = {};
    activeProgramRef.current = null;
    missionBriefedRef.current = false;
    missionPromptCountRef.current = 0;
    loadCoachProgramStore().then((store) => {
      activeProgramRef.current = store.active?.status === 'active' ? store.active : null;
    }).catch(() => {
      activeProgramRef.current = null;
    });
  }, [tripStartTime]);

  // Route points arrive as a fresh array on every GPS fix. Listing them in the
  // effect deps below tore down and restarted the CHECK_INTERVAL_MS timer on
  // essentially every fix, so the interval almost never elapsed and evaluate()
  // ran far more often than intended. Reading them through a ref keeps the
  // timer stable while evaluate() still sees the latest route.
  const routePointsRef = useRef(currentRoutePoints);
  routePointsRef.current = currentRoutePoints;
  const hasEvaluableRoute = currentRoutePoints.length >= 2;

  useEffect(() => {
    if (!tripStartTime || !hasEvaluableRoute) return undefined;

    const evaluate = async () => {
      const settings = localSettings.get();
      if (settings.live_coaching_enabled === false) return;
      const routePoints = routePointsRef.current;
      if (routePoints.length < 2) return;

      const thresholds = buildDrivingThresholds(settings);
      const currentTime = new Date().toISOString();
      const now = Date.now();
      const canDisplayAlert = (key, cooldownMs) => {
        if (!key || !cooldownMs) return true;
        const last = lastDisplayedAlertRef.current[key] || 0;
        if (now - last < cooldownMs) return false;
        lastDisplayedAlertRef.current[key] = now;
        return true;
      };
      const stats = calculateTripStats(routePoints, tripStartTime, currentTime, thresholds);
      const { events, phoneUse: gpsPhoneUse } = detectDrivingEvents(routePoints, thresholds, currentTime);
      let phoneUse = settings.phone_use_detection_enabled === false
        ? {}
        : mergePhoneUseSignals(gpsPhoneUse, {}, stats.duration_seconds);
      const tripStartMs = new Date(tripStartTime).getTime();
      if (settings.phone_use_detection_enabled !== false && isAndroid() && Number.isFinite(tripStartMs)) {
        const usageSummary = await getAndroidPhoneUsageSummaryForOverlay(tripStartMs, now).catch(() => null);
        const usagePhoneUse = buildPhoneUseFromAndroidUsage(usageSummary || {}, routePoints, stats.duration_seconds);
        phoneUse = mergePhoneUseSignals(gpsPhoneUse, usagePhoneUse, stats.duration_seconds);
      }
      const lastCoachCheckTime = lastCoachCheckRef.current || (now - CHECK_INTERVAL_MS);
      const newPhoneWindows = (phoneUse.phone_use_events || []).filter((window) => {
        const startMs = new Date(window.startTime || window.timestamp || 0).getTime();
        return Number.isFinite(startMs) && startMs > lastCoachCheckTime;
      });
      const recentCloseProximity = events.some((event) => (
        (event.type === EVENT_TYPES.CLOSE_PROXIMITY || event.type === EVENT_TYPES.NEAR_MISS) &&
        now - new Date(event.timestamp).getTime() <= RECENT_WINDOW_MS
      ));
      const harshBrakeCount = events.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length;
      const rapidAccelCount = events.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length;
      const sharpTurnCount = events.filter((event) => event.type === EVENT_TYPES.SHARP_TURN).length;
      const stopStartPatternCount = events.filter((event) => event.type === EVENT_TYPES.STOP_START_PATTERN || event.type === EVENT_TYPES.TAILGATE_CYCLE).length;
      const speedingEvents = events.filter((event) => event.type === EVENT_TYPES.SPEEDING);
      const latestSpeeding = speedingEvents[speedingEvents.length - 1];
      const latestSpeed = reliablePointSpeed(routePoints, routePoints.length - 1, thresholds) ?? 0;
      const latestPoint = routePoints[routePoints.length - 1] || null;
      if (!localSpeedKnowledgeRef.current) {
        localSpeedKnowledgeRef.current = new LocalSpeedKnowledge(speedKnowledgeStore);
      }
      const pointTimeMs = new Date(latestPoint?.timestamp || Date.now()).getTime();
      const localKnowledge = latestPoint &&
        Number.isFinite(Number(latestPoint.lat)) &&
        Number.isFinite(Number(latestPoint.lng))
        ? await localSpeedKnowledgeRef.current.getForPoint(
          Number(latestPoint.lat),
          Number(latestPoint.lng),
          Number.isFinite(pointTimeMs) ? pointTimeMs : Date.now(),
          { headingDeg: latestPoint.heading ?? latestPoint.bearing ?? latestPoint.course ?? null }
        ).catch(() => null)
        : null;
      const latestSpeedLimitContext = resolveEffectiveSpeedLimitForIndex(
        routePoints,
        routePoints.length - 1,
        thresholds,
        { localKnowledge, settings }
      );
      const resolvedSpeedLimit = createTierAwareSpeedLimitContext(latestSpeedLimitContext, settings);
      const durationMins = Number.isFinite(tripStartMs) ? (now - tripStartMs) / 60000 : 0;
      const activeProgram = activeProgramRef.current;
      const missionFocus = activeProgram
        ? COACH_FOCUS_CATALOG[activeProgram.focusId] || null
        : null;
      const canUseMissionPrompt = (focusId) => (
        activeProgram?.status === 'active' &&
        activeProgram.focusId === focusId &&
        missionPromptCountRef.current < (Number(activeProgram.promptBudget) || 3)
      );
      const missionMessage = (focusId, fallbackText, voiceKey, fallbackVoiceText) => {
        const matchedFocusId = canUseMissionPrompt(focusId)
          ? focusId
          : canUseMissionPrompt('consistency') ? 'consistency' : null;
        if (!matchedFocusId) {
          return { text: fallbackText, voiceKey, voiceText: fallbackVoiceText, voiceCooldownMs: VOICE_COOLDOWNS_MS[voiceKey] };
        }
        return {
          text: missionFocus?.cue || fallbackText,
          voiceKey: `coach_program_${activeProgram.id}_${voiceKey}`,
          voiceText: missionFocus?.cue || fallbackVoiceText,
          voiceCooldownMs: VOICE_COOLDOWNS_MS[voiceKey],
          missionPrompt: true,
        };
      };

      let nextMessage = null;
      const liveSpeedAlert = buildTierAwareSpeedAlert(latestSpeed, resolvedSpeedLimit, settings);
      const livePhoneAlertsEnabled = settings.phone_use_detection_enabled !== false && settings.phone_use_live_alert_enabled !== false;
      if (newPhoneWindows.length > 0 && livePhoneAlertsEnabled) {
        const highestConfidence = [...newPhoneWindows].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
        const phoneMissionPrompt = Boolean(canUseMissionPrompt('phone_use') && missionFocus?.cue);
        nextMessage = {
          text: (
            <>
              <span className="block text-sm font-bold uppercase">Put your phone down</span>
              <span className="block text-xs font-medium">{phoneMissionPrompt ? missionFocus.cue : 'Phone activity was recorded during this drive. Keep your eyes on the road.'}</span>
            </>
          ),
          tone: 'danger',
          displayMs: PHONE_DISPLAY_MS,
          voiceKey: 'phone_use',
          voiceText: buildVoiceAlertMessage('phone_use', {
            source: highestConfidence.source || highestConfidence.evidence_source,
          }, { settings }) + (phoneMissionPrompt ? ` ${missionFocus.cue}` : ''),
          voiceCooldownMs: VOICE_COOLDOWNS_MS.phone_use,
          voiceParams: { interrupt: true },
          missionPrompt: phoneMissionPrompt,
        };
        if (settings.notif_phone_use_alert_enabled !== false) {
          notifyPhoneUseDetected({
            confidence: highestConfidence.confidence_level,
            speedKmh: highestConfidence.speed_kmh,
          }, settings).catch(() => {});
        }
      } else if (recentCloseProximity) {
        nextMessage = {
          text: 'Estimated brake-turn manoeuvre alert. Review conditions when safe.',
          voiceKey: 'close_proximity',
          voiceText: buildVoiceAlertMessage('close_proximity', {}, { settings }),
          voiceCooldownMs: VOICE_COOLDOWNS_MS.close_proximity,
        };
      } else if (stats.heading_drift_beta_level === 'high') {
        nextMessage = {
          text: 'GPS heading variation pattern recorded. Take a break if you feel tired.',
          voiceKey: 'heading_drift_beta',
          voiceText: buildVoiceAlertMessage('heading_drift_beta', {}, { settings }),
          voiceCooldownMs: VOICE_COOLDOWNS_MS.heading_drift_beta,
        };
      } else if (activeProgram?.status === 'active' && missionFocus && !missionBriefedRef.current && durationMins >= 0.2 && durationMins <= 5) {
        missionBriefedRef.current = true;
        nextMessage = {
          text: missionFocus.liveCue,
          voiceKey: `coach_program_brief_${activeProgram.id}`,
          voiceText: missionFocus.liveCue,
          voiceCooldownMs: 24 * 60 * 60 * 1000,
          displayMs: 10000,
        };
      } else if (liveSpeedAlert) {
        const speedMissionPrompt = Boolean(canUseMissionPrompt('speeding') && missionFocus?.cue);
        if (speedMissionPrompt) {
          nextMessage = {
            ...liveSpeedAlert,
            text: (
              <>
                {liveSpeedAlert.text}
                <span className="mt-1 block border-t border-current/20 pt-1 text-xs font-medium">
                  Coach: {missionFocus.cue}
                </span>
              </>
            ),
            voiceText: liveSpeedAlert.voiceText
              ? `${liveSpeedAlert.voiceText} ${missionFocus.cue}`
              : null,
            missionPrompt: true,
          };
        } else {
          nextMessage = liveSpeedAlert;
        }
      } else if (harshBrakeCount > previousCountsRef.current[EVENT_TYPES.HARSH_BRAKE]) {
        nextMessage = missionMessage(
          'harsh_brakes',
          'Brake earlier and more gradually',
          'harsh_brake',
          buildVoiceAlertMessage('harsh_brake', {}, { settings })
        );
      } else if (sharpTurnCount > previousCountsRef.current[EVENT_TYPES.SHARP_TURN]) {
        nextMessage = missionMessage(
          'sharp_turns',
          'Set your speed before the turn',
          'sharp_turn',
          'Set your speed before the turn and accelerate as the wheel straightens.'
        );
      } else if (stopStartPatternCount > previousCountsRef.current[EVENT_TYPES.STOP_START_PATTERN]) {
        nextMessage = missionMessage(
          'consistency',
          'Repeated stop-start pattern recorded',
          'stop_start_pattern',
          buildVoiceAlertMessage('stop_start_pattern', {}, { settings })
        );
      } else if (rapidAccelCount > previousCountsRef.current[EVENT_TYPES.RAPID_ACCELERATION]) {
        nextMessage = missionMessage(
          'rapid_accel',
          'Accelerate more smoothly',
          'rapid_accel',
          buildVoiceAlertMessage('rapid_accel', {}, { settings })
        );
      } else if (durationMins >= (settings.threshold_long_drive_minutes ?? 120)) {
        const fatigueMission = canUseMissionPrompt('fatigue');
        nextMessage = {
          text: fatigueMission ? missionFocus.cue : `Long drive reminder. You have been driving for ${Math.round(durationMins)} minutes.`,
          voiceKey: fatigueMission ? `coach_program_${activeProgram.id}_long_drive` : 'long_drive',
          voiceText: fatigueMission ? missionFocus.cue : buildVoiceAlertMessage('long_drive', {}, { settings }),
          voiceCooldownMs: VOICE_COOLDOWNS_MS.long_drive,
          missionPrompt: fatigueMission,
        };
      } else if ((stats.idle_time_seconds || 0) > 300) {
        nextMessage = {
          text: 'Extended idling recorded',
          voiceKey: 'idle',
          voiceText: buildVoiceAlertMessage('idle', {}, { settings }),
          voiceCooldownMs: VOICE_COOLDOWNS_MS.idle,
        };
      }

      if (latestSpeeding && settings.notif_speeding_alert_enabled !== false) {
        notifySpeedingAlert({
          currentSpeedKmh: latestSpeeding.speed_kmh,
          limitKmh: latestSpeeding.speed_limit_kmh ?? latestSpeeding.inferred_zone_kmh ?? thresholds.SPEEDING_FALLBACK_KMH,
          durationS: latestSpeeding.duration_seconds ?? 0,
        }, settings).catch(() => {});
        if (!nextMessage) {
          nextMessage = buildTierAwareSpeedAlert(latestSpeeding.speed_kmh || latestSpeed, resolvedSpeedLimit, settings);
        }
      }
      if (stats.heading_drift_beta_level === 'high' && settings.notif_heading_drift_alert_enabled !== false) {
        notifyHeadingDriftBetaWarning({
          headingDriftBetaLevel: 'high',
          tripDurationMinutes: (stats.duration_seconds || 0) / 60,
        }, settings).catch(() => {});
      }
      if (durationMins >= (settings.threshold_long_drive_minutes ?? 120)) {
        notifyFatigueBreakReminder({
          tripDurationMinutes: durationMins,
          thresholdMinutes: settings.threshold_long_drive_minutes ?? 120,
          tripId: tripStartTime,
        }, settings).catch(() => {});
      }

      previousCountsRef.current = {
        [EVENT_TYPES.HARSH_BRAKE]: harshBrakeCount,
        [EVENT_TYPES.RAPID_ACCELERATION]: rapidAccelCount,
        [EVENT_TYPES.SHARP_TURN]: sharpTurnCount,
        [EVENT_TYPES.STOP_START_PATTERN]: stopStartPatternCount,
      };
      lastCoachCheckRef.current = now;

      if (nextMessage && canDisplayAlert(nextMessage.voiceKey, nextMessage.voiceCooldownMs)) {
        if (nextMessage.missionPrompt) missionPromptCountRef.current += 1;
        queueRef.current.push(nextMessage);
        showNextRef.current?.();
      }
    };

    const interval = setInterval(evaluate, CHECK_INTERVAL_MS);
    evaluate();
    return () => clearInterval(interval);
  }, [hasEvaluableRoute, tripStartTime, dismissed, voiceMuted]);

  if (dismissed) return null;

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 28 }}
          className={`fixed bottom-4 left-4 right-4 z-50 rounded-2xl border px-4 py-3 shadow-lg ${
            message.tone === 'danger'
              ? 'border-red-300 bg-gradient-to-r from-red-600 to-red-500 text-white dark:border-red-700'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950 dark:text-amber-100'
          }`}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1 text-sm font-medium">{message.text}</div>
            <button
              type="button"
              onClick={() => {
                queueRef.current = [];
                visibleRef.current = false;
                setMessage(null);
                setDismissed(true);
              }}
              className={`rounded-lg p-1 ${message.tone === 'danger' ? 'hover:bg-red-700/60' : 'hover:bg-amber-100 dark:hover:bg-amber-900'}`}
              aria-label="Dismiss live coaching"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
