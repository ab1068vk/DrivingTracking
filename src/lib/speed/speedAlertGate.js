/**
 * Decides when being over the limit has lasted long enough to say something.
 *
 * The webview had no such gate. The native service required 5 seconds sustained
 * over the limit before alerting; the webview spoke on the first GPS fix that
 * crossed the threshold — and Dashboard fed it *raw* point speed, so a single
 * GPS spike was enough to trigger speech. There was also nothing that ever
 * released the "over" state, so hovering on the threshold could re-arm the
 * alert repeatedly.
 *
 * This gate supplies both halves, using the constants shared with Java in
 * appConstants.js so the two sides agree.
 */
import { SPEED_ALERT_RELEASE_KMH, SPEED_ALERT_SUSTAINED_MS } from '@/lib/appConstants';

/**
 * The sustained window in milliseconds, from the driver's setting.
 *
 * Stored in whole seconds because that is what the slider offers and what the
 * label reads; the gate and the Java service both work in milliseconds.
 */
export function speedAlertSustainedMs(settings = {}) {
  const stored = settings?.speed_alert_sustained_s;
  // 0 is a real choice here ("speak as soon as I am over"), so an unset value
  // has to be distinguished from it: Number('') and Number(null) are both 0,
  // which would turn a missing setting into no gate at all.
  if (stored === '' || stored == null) return SPEED_ALERT_SUSTAINED_MS;
  const seconds = Number(stored);
  if (!Number.isFinite(seconds) || seconds < 0) return SPEED_ALERT_SUSTAINED_MS;
  return Math.round(seconds * 1000);
}

export function createSpeedAlertGate({
  sustainedMs: defaultSustainedMs = SPEED_ALERT_SUSTAINED_MS,
  releaseKmh = SPEED_ALERT_RELEASE_KMH,
} = {}) {
  let overSinceMs = null;

  const reset = () => {
    overSinceMs = null;
  };

  return {
    /**
     * `sustainedMs` is per call rather than fixed at construction: the live gate
     * is a module singleton shared by Dashboard and LiveCoachOverlay, so it is
     * built long before the driver's setting is readable and must not cache it.
     * The elapsed-time state is shared; only the threshold is per call.
     *
     * @param {{speedKmh: number, limitKmh: number, marginKmh: number, nowMs?: number, sustainedMs?: number}} input
     * @returns {{over: boolean, sustained: boolean, overForMs: number}}
     */
    evaluate({ speedKmh, limitKmh, marginKmh, nowMs = Date.now(), sustainedMs } = {}) {
      const requiredMs = Number.isFinite(Number(sustainedMs))
        ? Math.max(0, Number(sustainedMs))
        : defaultSustainedMs;
      // Number(null) and Number('') are both 0, which would make a missing limit
      // look like a limit of zero and put any movement "over" it.
      const numeric = (value) => {
        if (value == null || value === '') return NaN;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : NaN;
      };
      const speed = numeric(speedKmh);
      const limit = numeric(limitKmh);
      const margin = numeric(marginKmh);
      if (!Number.isFinite(speed) || !(limit > 0) || !Number.isFinite(margin)) {
        reset();
        return { over: false, sustained: false, overForMs: 0 };
      }

      const threshold = limit + margin;
      // Hysteresis: once engaged, it takes a drop of releaseKmh *below* the
      // threshold to stand down, so sitting exactly on the line does not
      // oscillate between armed and clear on every fix.
      const releaseAt = threshold - Math.max(0, releaseKmh);

      if (overSinceMs == null) {
        if (speed <= threshold) return { over: false, sustained: false, overForMs: 0 };
        overSinceMs = nowMs;
      } else if (speed <= releaseAt) {
        reset();
        return { over: false, sustained: false, overForMs: 0 };
      }

      // A clock that jumps backwards must not appear to have been over for a
      // negative time, nor latch a stale start forever.
      if (nowMs < overSinceMs) overSinceMs = nowMs;
      const overForMs = nowMs - overSinceMs;
      return { over: true, sustained: overForMs >= requiredMs, overForMs };
    },
    reset,
  };
}

/**
 * The gate for the live trip. Dashboard and LiveCoachOverlay both alert on the
 * same drive, so they must share one notion of "how long have we been over" —
 * two independent gates would let one of them speak while the other was still
 * waiting.
 */
export const liveSpeedAlertGate = createSpeedAlertGate();
