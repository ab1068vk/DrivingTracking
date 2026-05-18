import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import {
  buildDrivingThresholds,
  calculateTripStats,
  detectDrivingEvents,
  EVENT_TYPES,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import {
  notifyDrowsyWarning,
  notifyFatigueBreakReminder,
  notifyPhoneUseDetected,
  notifySpeedingAlert,
} from '@/lib/notificationService';
import { isAndroid } from '@/lib/nativePlatform';
import { getAndroidPhoneUsageSummary } from '@/lib/activityRecognition';
import { buildPhoneUseFromAndroidUsage, mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { speakSafetyAlert } from '@/lib/voiceAlerts';

const RECENT_WINDOW_MS = 120000;
const CHECK_INTERVAL_MS = 15000;
const DISPLAY_MS = 8000;
const PHONE_DISPLAY_MS = 15000;

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

export default function LiveCoachOverlay({ currentRoutePoints = [], currentEvents = [], tripStartTime }) {
  const [message, setMessage] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const visibleRef = useRef(false);
  const queueRef = useRef([]);
  const lastCoachCheckRef = useRef(0);
  const lastVoiceAlertRef = useRef({});
  const previousCountsRef = useRef({
    [EVENT_TYPES.HARSH_BRAKE]: currentEvents.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length,
    [EVENT_TYPES.RAPID_ACCELERATION]: currentEvents.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length,
    [EVENT_TYPES.TAILGATE_CYCLE]: currentEvents.filter((event) => event.type === EVENT_TYPES.TAILGATE_CYCLE).length,
  });

  const showNext = () => {
    if (visibleRef.current || queueRef.current.length === 0 || dismissed) return;
    visibleRef.current = true;
    const next = queueRef.current.shift();
    const normalized = typeof next === 'string' ? { text: next, tone: 'default' } : next;
    setMessage(normalized);
    speakSafetyAlert(plainText(normalized.text), localSettings.get()).catch(() => {});
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
      [EVENT_TYPES.TAILGATE_CYCLE]: 0,
    };
    lastCoachCheckRef.current = new Date(tripStartTime).getTime() || Date.now();
  }, [tripStartTime]);

  useEffect(() => {
    if (!tripStartTime || currentRoutePoints.length < 2) return undefined;

    const evaluate = async () => {
      const settings = localSettings.get();
      if (settings.live_coaching_enabled === false) return;

      const thresholds = buildDrivingThresholds(settings);
      const currentTime = new Date().toISOString();
      const now = Date.now();
      const canSpeakTimedAlert = (key, cooldownMs) => {
        const last = lastVoiceAlertRef.current[key] || 0;
        if (now - last < cooldownMs) return false;
        lastVoiceAlertRef.current[key] = now;
        return true;
      };
      const stats = calculateTripStats(currentRoutePoints, tripStartTime, currentTime, thresholds);
      const detection = detectDrivingEvents(currentRoutePoints, thresholds, currentTime);
      const events = Reflect.get(detection, 'events') ?? detection;
      const gpsPhoneUse = Reflect.get(detection, 'phoneUse') ?? {};
      let phoneUse = gpsPhoneUse;
      const tripStartMs = new Date(tripStartTime).getTime();
      if (isAndroid() && Number.isFinite(tripStartMs)) {
        const usageSummary = await getAndroidPhoneUsageSummary(tripStartMs, now).catch(() => null);
        const usagePhoneUse = buildPhoneUseFromAndroidUsage(usageSummary || {}, currentRoutePoints, stats.duration_seconds);
        phoneUse = mergePhoneUseSignals(gpsPhoneUse, usagePhoneUse, stats.duration_seconds);
      }
      const lastCoachCheckTime = lastCoachCheckRef.current || (now - CHECK_INTERVAL_MS);
      const newPhoneWindows = (phoneUse.phone_use_events || []).filter((window) => {
        const startMs = new Date(window.startTime || window.timestamp || 0).getTime();
        return Number.isFinite(startMs) && startMs > lastCoachCheckTime;
      });
      const recentNearMiss = events.some((event) => (
        event.type === EVENT_TYPES.NEAR_MISS &&
        now - new Date(event.timestamp).getTime() <= RECENT_WINDOW_MS
      ));
      const harshBrakeCount = events.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length;
      const rapidAccelCount = events.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length;
      const tailgateCount = events.filter((event) => event.type === EVENT_TYPES.TAILGATE_CYCLE).length;
      const speedingEvents = events.filter((event) => event.type === EVENT_TYPES.SPEEDING);
      const latestSpeeding = speedingEvents[speedingEvents.length - 1];
      const latestSpeed = Number(currentRoutePoints[currentRoutePoints.length - 1]?.speed_kmh) || 0;

      let nextMessage = null;
      if (newPhoneWindows.length > 0) {
        const highestConfidence = [...newPhoneWindows].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
        nextMessage = {
          text: (
            <>
              <span className="block text-sm font-bold uppercase">Put your phone down</span>
              <span className="block text-xs font-medium">Distracted driving detected. Keep your eyes on the road.</span>
            </>
          ),
          tone: 'danger',
          displayMs: PHONE_DISPLAY_MS,
        };
        if (settings.phone_use_live_alert_enabled !== false && settings.notif_phone_use_alert_enabled !== false) {
          notifyPhoneUseDetected({
            confidence: highestConfidence.confidence_level,
            speedKmh: highestConfidence.speed_kmh,
          }, settings).catch(() => {});
        }
      } else if (recentNearMiss) nextMessage = 'Near miss detected - increase following distance';
      else if (harshBrakeCount > previousCountsRef.current[EVENT_TYPES.HARSH_BRAKE]) nextMessage = 'Brake earlier and more gradually';
      else if (tailgateCount > previousCountsRef.current[EVENT_TYPES.TAILGATE_CYCLE]) nextMessage = 'Open your following gap';
      else if (latestSpeed > (thresholds.SPEEDING_FALLBACK_KMH ?? 100) + (thresholds.SPEED_OVER_KMH ?? 5)) nextMessage = "You're above the speed threshold";
      else if (rapidAccelCount > previousCountsRef.current[EVENT_TYPES.RAPID_ACCELERATION]) nextMessage = 'Accelerate more smoothly';
      else if ((stats.idle_time_seconds || 0) > 300) nextMessage = 'Extended idling detected';

      if (latestSpeeding && settings.notif_speeding_alert_enabled !== false) {
        notifySpeedingAlert({
          currentSpeedKmh: latestSpeeding.speed_kmh,
          limitKmh: latestSpeeding.inferred_zone_kmh ?? thresholds.SPEEDING_FALLBACK_KMH,
          durationS: latestSpeeding.duration_seconds ?? 0,
        }, settings).catch(() => {});
        if (!nextMessage && settings.voice_alerts_enabled !== false && canSpeakTimedAlert('speeding', 60000)) {
          nextMessage = `Speed warning. ${Math.round(latestSpeeding.speed_kmh || latestSpeed)} kilometers per hour.`;
        }
      }
      if (stats.drowsy_risk_level === 'high' && settings.notif_drowsy_alert_enabled !== false) {
        notifyDrowsyWarning({
          drowsyRiskLevel: 'high',
          tripDurationMinutes: (stats.duration_seconds || 0) / 60,
        }, settings).catch(() => {});
        if (!nextMessage && settings.voice_alerts_enabled !== false && canSpeakTimedAlert('drowsy', 10 * 60 * 1000)) {
          nextMessage = 'Fatigue warning. Take a break when it is safe.';
        }
      }
      const durationMins = Number.isFinite(tripStartMs) ? (now - tripStartMs) / 60000 : 0;
      if (durationMins >= (settings.threshold_long_drive_minutes ?? 120)) {
        notifyFatigueBreakReminder({
          tripDurationMinutes: durationMins,
          thresholdMinutes: settings.threshold_long_drive_minutes ?? 120,
          tripId: tripStartTime,
        }, settings).catch(() => {});
        if (!nextMessage && settings.voice_alerts_enabled !== false && canSpeakTimedAlert('long_drive', 30 * 60 * 1000)) {
          nextMessage = `Long drive reminder. You have been driving for ${Math.round(durationMins)} minutes.`;
        }
      }

      previousCountsRef.current = {
        [EVENT_TYPES.HARSH_BRAKE]: harshBrakeCount,
        [EVENT_TYPES.RAPID_ACCELERATION]: rapidAccelCount,
        [EVENT_TYPES.TAILGATE_CYCLE]: tailgateCount,
      };
      lastCoachCheckRef.current = now;

      if (nextMessage) {
        queueRef.current.push(nextMessage);
        showNext();
      }
    };

    const interval = setInterval(evaluate, CHECK_INTERVAL_MS);
    evaluate();
    return () => clearInterval(interval);
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
