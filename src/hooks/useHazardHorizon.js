/**
 * The live hazard warning, as one call Dashboard can make per GPS fix.
 *
 * This exists to keep the whole decision — snapshot, projection, ranking,
 * gating, speech, notification — out of the GPS callback in Dashboard.jsx, which
 * previously held the entire alert inline: a per-fix storage decrypt, a radial
 * scan, a hand-rolled cooldown ref, and the speech and notification calls.
 *
 * The snapshot is held for the life of the drive and rebuilt only when hazard
 * knowledge changes. The gate is the shared `liveHazardAlertGate` singleton, so
 * LiveCoachOverlay can see what has already been said.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { buildHazardHorizon } from '@/lib/hazard/hazardHorizon';
import { buildHazardDisplayMessage } from '@/lib/hazard/hazardAlertMessages';
import { getHazardHorizonSnapshot } from '@/lib/hazard/hazardHorizonSnapshot';
import { liveHazardAlertGate } from '@/lib/hazard/hazardAlertGate';
import { createHazardDriveTally } from '@/lib/hazard/hazardDriveDiagnostics';
import { notifyStayAlert } from '@/lib/notificationService';
import { buildVoiceAlertMessage } from '@/lib/voiceAlertMessages';
import { speakSafetyAlert } from '@/lib/voiceAlerts';
import { logError } from '@/lib/errorReporting';
import { recordTrackingDiagnostic } from '@/lib/trackingDiagnostics';
import { HAZARD_ALERT_GLOBAL_COOLDOWN_MS } from '@/lib/appConstants';

/** Notification id 4007 is kept from the warning this replaces so a newer hazard replaces an older one in the tray. */
const HAZARD_NOTIFICATION_ID = 4007;

export function useHazardHorizon() {
  const lastDiagnosticsRef = useRef(null);
  const tallyRef = useRef(null);
  if (!tallyRef.current) tallyRef.current = createHazardDriveTally();

  const reset = useCallback(() => {
    // Flush before clearing: this runs as a drive ends, and the tallies are the
    // only record of why it stayed quiet.
    const summary = tallyRef.current.flush(liveHazardAlertGate.stats());
    if (summary) {
      try {
        recordTrackingDiagnostic(summary);
      } catch (error) {
        // A diagnostic that cannot be written must never affect the drive.
        logError('hazard_horizon_diagnostics', error, {});
      }
    }
    liveHazardAlertGate.startDrive();
    lastDiagnosticsRef.current = null;
  }, []);

  // A drive that ends while the component is mounted must not leave one-shot
  // state behind for the next one.
  useEffect(() => () => liveHazardAlertGate.reset(), []);

  const evaluate = useCallback(async ({
    point, recentPoints = [], settings = {}, privacyZones = [], voiceMuted = false,
  }) => {
    let snapshot = null;
    try {
      snapshot = await getHazardHorizonSnapshot({ privacyZones });
    } catch (error) {
      logError('hazard_horizon_snapshot', error, {});
      return null;
    }

    const horizon = buildHazardHorizon({
      point, recentPoints, snapshot, settings, privacyZones,
    });
    lastDiagnosticsRef.current = horizon.diagnostics;
    tallyRef.current.record(horizon);

    const hazard = horizon.top;
    if (!hazard) return null;

    const decision = liveHazardAlertGate.evaluate({
      hazardId: hazard.id,
      kind: hazard.kind,
      etaSeconds: hazard.etaSeconds,
      urgency: hazard.urgency,
      speedKmh: Number(point?.speed_kmh) || 0,
      alongTrackM: hazard.alongTrackM,
    });
    if (!decision.shouldAlert) return null;

    const message = buildHazardDisplayMessage(hazard);
    if (!message) return null;

    notifyStayAlert({
      id: HAZARD_NOTIFICATION_ID,
      title: message.title,
      body: message.body,
      // The gate already decides how often a hazard may speak; notifyStayAlert's
      // own 60 s default would gate it a second time on different terms.
      cooldownMs: HAZARD_ALERT_GLOBAL_COOLDOWN_MS,
      extra: { type: hazard.notificationType, hazardId: hazard.id },
    }).catch((error) => {
      logError('hazard_horizon_notification', error, {
        hazard_id: hazard.id,
        kind: hazard.kind,
        eta_seconds: Math.round(hazard.etaSeconds),
      });
    });

    if (!voiceMuted) {
      speakSafetyAlert(
        buildVoiceAlertMessage(hazard.voiceKey, {
          ...hazard.evidence,
          etaSeconds: hazard.etaSeconds,
        }, { settings }),
        settings,
        { alertKey: hazard.voiceKey }
      ).catch((error) => {
        logError('hazard_horizon_voice_alert', error, {
          hazard_id: hazard.id,
          kind: hazard.kind,
        });
      });
    }

    return { body: message.body, title: message.title, kind: hazard.kind, hazard };
  }, []);

  /** Why the drive has been quiet, live. The end-of-drive tally is what reaches Diagnostics. */
  const diagnostics = useCallback(() => ({
    ...(lastDiagnosticsRef.current || {}),
    gate: liveHazardAlertGate.stats(),
  }), []);

  // Stable identity: Dashboard lists this in effect and callback dependencies,
  // and a fresh object per render would re-run them on every state change.
  return useMemo(() => ({ evaluate, reset, diagnostics }), [diagnostics, evaluate, reset]);
}
