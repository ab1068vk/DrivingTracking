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

const RECENT_WINDOW_MS = 120000;
const CHECK_INTERVAL_MS = 60000;
const DISPLAY_MS = 8000;

export default function LiveCoachOverlay({ currentRoutePoints = [], currentEvents = [], tripStartTime }) {
  const [message, setMessage] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const visibleRef = useRef(false);
  const queueRef = useRef([]);
  const previousCountsRef = useRef({
    [EVENT_TYPES.HARSH_BRAKE]: currentEvents.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length,
    [EVENT_TYPES.RAPID_ACCELERATION]: currentEvents.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length,
  });

  const showNext = () => {
    if (visibleRef.current || queueRef.current.length === 0 || dismissed) return;
    visibleRef.current = true;
    setMessage(queueRef.current.shift());
    setTimeout(() => {
      visibleRef.current = false;
      setMessage(null);
      showNext();
    }, DISPLAY_MS);
  };

  useEffect(() => {
    setDismissed(false);
    previousCountsRef.current = {
      [EVENT_TYPES.HARSH_BRAKE]: 0,
      [EVENT_TYPES.RAPID_ACCELERATION]: 0,
    };
  }, [tripStartTime]);

  useEffect(() => {
    if (!tripStartTime || currentRoutePoints.length < 2) return undefined;

    const evaluate = () => {
      const settings = localSettings.get();
      if (settings.live_coaching_enabled === false) return;

      const thresholds = buildDrivingThresholds(settings);
      const stats = calculateTripStats(currentRoutePoints, tripStartTime, new Date().toISOString(), thresholds);
      const events = detectDrivingEvents(currentRoutePoints, thresholds);
      const now = Date.now();
      const recentNearMiss = events.some((event) => (
        event.type === EVENT_TYPES.NEAR_MISS &&
        now - new Date(event.timestamp).getTime() <= RECENT_WINDOW_MS
      ));
      const harshBrakeCount = events.filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE).length;
      const rapidAccelCount = events.filter((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION).length;
      const latestSpeed = Number(currentRoutePoints[currentRoutePoints.length - 1]?.speed_kmh) || 0;

      let nextMessage = null;
      if (recentNearMiss) nextMessage = '⚠️ Near miss detected — increase following distance';
      else if (harshBrakeCount > previousCountsRef.current[EVENT_TYPES.HARSH_BRAKE]) nextMessage = 'Brake earlier and more gradually';
      else if (latestSpeed > (thresholds.SPEEDING_FALLBACK_KMH ?? 130)) nextMessage = "You're above the speed threshold";
      else if (rapidAccelCount > previousCountsRef.current[EVENT_TYPES.RAPID_ACCELERATION]) nextMessage = 'Accelerate more smoothly';
      else if ((stats.idle_time_seconds || 0) > 300) nextMessage = 'Extended idling detected';

      previousCountsRef.current = {
        [EVENT_TYPES.HARSH_BRAKE]: harshBrakeCount,
        [EVENT_TYPES.RAPID_ACCELERATION]: rapidAccelCount,
      };

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
          className="fixed bottom-4 left-4 right-4 z-50 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 shadow-lg dark:border-amber-800/60 dark:bg-amber-950 dark:text-amber-100"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1 text-sm font-medium">{message}</div>
            <button
              type="button"
              onClick={() => {
                queueRef.current = [];
                visibleRef.current = false;
                setMessage(null);
                setDismissed(true);
              }}
              className="rounded-lg p-1 hover:bg-amber-100 dark:hover:bg-amber-900"
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
