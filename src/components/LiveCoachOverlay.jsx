import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import {
  buildDrivingThresholds,
  EVENT_TYPES,
} from '@/lib/scoring/componentScores';
import { calculateTripStats } from '@/lib/gps/routeSummary';
import { detectDrivingEvents } from '@/lib/detection/harshEvents';
import { resolveEffectiveSpeedLimitForIndex } from '@/lib/scoring/intersectionScore';
import { localSettings } from '@/lib/trackingStore';
import {
  notifyHeadingDriftBetaWarning,
  notifyFatigueBreakReminder,
  notifyPhoneUseDetected,
  notifySpeedingAlert,
} from '@/lib/notificationService';
import { isAndroid } from '@/lib/nativePlatform';
import { getAndroidPhoneUsageSummary } from '@/lib/activityRecognition';
import { buildPhoneUseFromAndroidUsage, mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { speakSafetyAlert, speakSafetyAlertOnce } from '@/lib/voiceAlerts';
import { logError } from '@/lib/errorReporting';

const RECENT_WINDOW_MS = 120000;
const CHECK_INTERVAL_MS = 15000;
const SPEED_CHECK_INTERVAL_MS = 4000;
const SPEED_ALERT_BUFFER_KMH = 5;
const MIN_SPEEDING_DURATION_S = 8;
const DISPLAY_MS = 8000;
const PHONE_DISPLAY_MS = 15000;
const VOICE_COOLDOWNS_MS = {
  phone_use: 120000,
  close_proximity: 120000,
  harsh_brake: 30000,
  stop_start_pattern: 60000,
  speeding: 60000,
  heading_drift_beta: 10 * 60 * 1000,
  rapid_accel: 30000,
  long_drive: 30 * 60 * 1000,
  idle: 5 * 60 * 1000,
};

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

const isVoiceAlertsEnabled = (settings) => {
  const value = settings?.voice_alerts_enabled;
  return value === true || value === 'true';
};

export default function LiveCoachOverlay({ currentRoutePoints = [], currentEvents = [], tripStartTime }) {
  const [message, setMessage] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const visibleRef = useRef(false);
  const queueRef = useRef([]);
  const coachIntervalRef = useRef(null);
  const speedIntervalRef = useRef(null);
  const speedingStartMsRef = useRef(null);
  const lastCoachCheckRef = useRef(0);
  const lastDisplayedAlertRef = useRef({});
  const previousCountsRef = useRef({
    [EVENT_TYPES.HARSH_BRAKE]: currentEvents.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length,
    [EVENT_TYPES.RAPID_ACCELERATION]: currentEvents.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length,
    [EVENT_TYPES.STOP_START_PATTERN]: currentEvents.filter((event) => event.type === EVENT_TYPES.STOP_START_PATTERN || event.type === EVENT_TYPES.TAILGATE_CYCLE).length,
  });

  const showNext = () => {
    if (visibleRef.current || queueRef.current.length === 0) return;
    visibleRef.current = true;
    const next = queueRef.current.shift();
    const normalized = typeof next === 'string' ? { text: next, tone: 'default' } : next;
    const settings = localSettings.get();
    const voiceText = plainText(normalized.text);
    const speak = normalized.voiceKey
      ? speakSafetyAlertOnce(normalized.voiceKey, voiceText, settings, normalized.voiceCooldownMs).catch((err) => {
          logError('live_coach_voice_alert_once', err, { voiceKey: normalized.voiceKey });
        })
      : speakSafetyAlert(voiceText, settings).catch((err) => {
          logError('live_coach_voice_alert', err);
        });
    void speak;
    if (!dismissed) setMessage(normalized);
    setTimeout(() => {
      visibleRef.current = false;
      setMessage(null);
      showNext();
    }, normalized?.displayMs || DISPLAY_MS);
  };

  useEffect(() => {
    setDismissed(false);
    previousCountsRef.current = {
      [EVENT_TYPES.HARSH_BRAKE]: 0,
      [EVENT_TYPES.RAPID_ACCELERATION]: 0,
      [EVENT_TYPES.STOP_START_PATTERN]: 0,
    };
    lastCoachCheckRef.current = new Date(tripStartTime).getTime() || Date.now();
    lastDisplayedAlertRef.current = {};
    speedingStartMsRef.current = null;
  }, [tripStartTime]);

  const checkSpeedAlert = useCallback(() => {
    const settings = localSettings.get();
    const speedWarningEnabled = settings?.speed_warning_enabled !== false;
    if (!speedWarningEnabled) {
      speedingStartMsRef.current = null;
      return;
    }

    const points = Array.isArray(currentRoutePoints) ? currentRoutePoints : [];
    if (points.length < 2) {
      speedingStartMsRef.current = null;
      return;
    }

    const latest = points[points.length - 1];
    const currentSpeedKmh = Number(latest?.speed_kmh) || 0;
    if (currentSpeedKmh <= 0) {
      speedingStartMsRef.current = null;
      return;
    }

    const thresholds = buildDrivingThresholds(settings);
    const currentIndex = points.length - 1;
    const limitResult = resolveEffectiveSpeedLimitForIndex(points, currentIndex, thresholds);
    const limitKmh = limitResult?.actualLimitKmh ?? null;
    if (limitKmh === null) {
      // No annotated limit available yet: do not fire an alert, and do not fetch.
      speedingStartMsRef.current = null;
      return;
    }

    const isCurrentlySpeeding = limitKmh !== null &&
      Number.isFinite(limitKmh) &&
      currentSpeedKmh > limitKmh + SPEED_ALERT_BUFFER_KMH;
    const now = Date.now();

    if (!isCurrentlySpeeding) {
      speedingStartMsRef.current = null;
      return;
    }

    if (speedingStartMsRef.current === null) {
      speedingStartMsRef.current = now;
    }

    const durationS = Math.round((now - speedingStartMsRef.current) / 1000);
    if (durationS < MIN_SPEEDING_DURATION_S) return;

    if (settings?.notif_speeding_alert_enabled !== false) {
      notifySpeedingAlert({
        currentSpeedKmh,
        limitKmh,
        durationS,
        limitSource: limitResult?.limitSource ?? 'inferred',
      }, settings).catch((err) => {
        // Speed and limit are intentionally omitted from local diagnostics.
        logError('live_coach_speeding_notification', err, {
          duration_seconds: durationS,
        });
      });
    }

    if (isVoiceAlertsEnabled(settings)) {
      const overBy = Math.round(currentSpeedKmh - limitKmh);
      const voiceText = `Speed warning. ${Math.round(currentSpeedKmh)} kilometres per hour. ${overBy} over the limit.`;
      speakSafetyAlertOnce('speeding', voiceText, settings, VOICE_COOLDOWNS_MS.speeding)
        .catch((err) => logError('live_coach_speed_voice', err));
    }
  }, [currentRoutePoints]);

  useEffect(() => {
    if (!tripStartTime) {
      speedingStartMsRef.current = null;
      return undefined;
    }

    checkSpeedAlert();
    speedIntervalRef.current = setInterval(checkSpeedAlert, SPEED_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    };
  }, [checkSpeedAlert, tripStartTime]);

  useEffect(() => {
    if (!tripStartTime || currentRoutePoints.length < 2) return undefined;

    const evaluate = async () => {
      const settings = localSettings.get();
      if (settings.live_coaching_enabled === false) return;

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
      const stats = calculateTripStats(currentRoutePoints, tripStartTime, currentTime, thresholds);
      const { events, phoneUse: gpsPhoneUse } = detectDrivingEvents(currentRoutePoints, thresholds, currentTime);
      let phoneUse = settings.phone_use_detection_enabled === false
        ? {}
        : mergePhoneUseSignals(gpsPhoneUse, {}, stats.duration_seconds);
      const tripStartMs = new Date(tripStartTime).getTime();
      if (settings.phone_use_detection_enabled !== false && isAndroid() && Number.isFinite(tripStartMs)) {
        const usageSummary = await getAndroidPhoneUsageSummary(tripStartMs, now).catch((err) => {
          logError('live_coach_phone_usage_summary', err, {
            duration_seconds: Math.round((now - tripStartMs) / 1000),
          });
          return null;
        });
        const usagePhoneUse = buildPhoneUseFromAndroidUsage(usageSummary || {}, currentRoutePoints, stats.duration_seconds);
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
      const stopStartPatternCount = events.filter((event) => event.type === EVENT_TYPES.STOP_START_PATTERN || event.type === EVENT_TYPES.TAILGATE_CYCLE).length;
      const durationMins = Number.isFinite(tripStartMs) ? (now - tripStartMs) / 60000 : 0;

      let nextMessage = null;
      const livePhoneAlertsEnabled = settings.phone_use_detection_enabled !== false && settings.phone_use_live_alert_enabled !== false;
      if (newPhoneWindows.length > 0 && livePhoneAlertsEnabled) {
        const highestConfidence = [...newPhoneWindows].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
        nextMessage = {
          text: (
            <>
              <span className="block text-sm font-bold uppercase">Put your phone down</span>
              <span className="block text-xs font-medium">Phone activity was recorded during this drive. Keep your eyes on the road.</span>
            </>
          ),
          tone: 'danger',
          displayMs: PHONE_DISPLAY_MS,
          voiceKey: 'phone_use',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.phone_use,
        };
        if (settings.notif_phone_use_alert_enabled !== false) {
          notifyPhoneUseDetected({
            confidence: highestConfidence.confidence_level,
            speedKmh: highestConfidence.speed_kmh,
          }, settings).catch((err) => {
            logError('live_coach_phone_use_notification', err, {
              confidence: highestConfidence.confidence_level,
            });
          });
        }
      } else if (recentCloseProximity) {
        nextMessage = {
          text: 'Estimated brake-turn manoeuvre alert. Review conditions when safe.',
          voiceKey: 'close_proximity',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.close_proximity,
        };
      } else if (stats.heading_drift_beta_level === 'high') {
        nextMessage = {
          text: 'GPS heading variation pattern recorded. Take a break if you feel tired.',
          voiceKey: 'heading_drift_beta',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.heading_drift_beta,
        };
      } else if (harshBrakeCount > previousCountsRef.current[EVENT_TYPES.HARSH_BRAKE]) {
        nextMessage = {
          text: 'Brake earlier and more gradually',
          voiceKey: 'harsh_brake',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.harsh_brake,
        };
      } else if (stopStartPatternCount > previousCountsRef.current[EVENT_TYPES.STOP_START_PATTERN]) {
        nextMessage = {
          text: 'Repeated stop-start pattern recorded',
          voiceKey: 'stop_start_pattern',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.stop_start_pattern,
        };
      } else if (rapidAccelCount > previousCountsRef.current[EVENT_TYPES.RAPID_ACCELERATION]) {
        nextMessage = {
          text: 'Accelerate more smoothly',
          voiceKey: 'rapid_accel',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.rapid_accel,
        };
      } else if (durationMins >= (settings.threshold_long_drive_minutes ?? 120)) {
        nextMessage = {
          text: `Long drive reminder. You have been driving for ${Math.round(durationMins)} minutes.`,
          voiceKey: 'long_drive',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.long_drive,
        };
      } else if ((stats.idle_time_seconds || 0) > 300) {
        nextMessage = {
          text: 'Extended idling recorded',
          voiceKey: 'idle',
          voiceCooldownMs: VOICE_COOLDOWNS_MS.idle,
        };
      }

      if (stats.heading_drift_beta_level === 'high' && settings.notif_heading_drift_alert_enabled !== false) {
        notifyHeadingDriftBetaWarning({
          headingDriftBetaLevel: 'high',
          tripDurationMinutes: (stats.duration_seconds || 0) / 60,
        }, settings).catch((err) => {
          logError('live_coach_heading_drift_notification', err, {
            duration_seconds: stats.duration_seconds || 0,
          });
        });
      }
      if (durationMins >= (settings.threshold_long_drive_minutes ?? 120)) {
        notifyFatigueBreakReminder({
          tripDurationMinutes: durationMins,
          thresholdMinutes: settings.threshold_long_drive_minutes ?? 120,
          tripId: tripStartTime,
        }, settings).catch((err) => {
          logError('live_coach_fatigue_notification', err, {
            trip_start_time: tripStartTime,
            duration_minutes: Math.round(durationMins),
          });
        });
      }

      previousCountsRef.current = {
        [EVENT_TYPES.HARSH_BRAKE]: harshBrakeCount,
        [EVENT_TYPES.RAPID_ACCELERATION]: rapidAccelCount,
        [EVENT_TYPES.STOP_START_PATTERN]: stopStartPatternCount,
      };
      lastCoachCheckRef.current = now;

      if (nextMessage && canDisplayAlert(nextMessage.voiceKey, nextMessage.voiceCooldownMs)) {
        queueRef.current.push(nextMessage);
        showNext();
      }
    };

    coachIntervalRef.current = setInterval(evaluate, CHECK_INTERVAL_MS);
    evaluate();
    return () => {
      clearInterval(coachIntervalRef.current);
      coachIntervalRef.current = null;
    };
  }, [currentRoutePoints, tripStartTime, dismissed]);

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
