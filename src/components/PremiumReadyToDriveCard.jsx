// @ts-check
import {
  AlertTriangle,
  LocateFixed,
  Play,
  RefreshCw,
  Satellite,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import premiumReadyHero from '@/assets/premium-ready-hero-v2.png';
import premiumReadyManual from '@/assets/premium-ready-manual-v2.png';
import premiumReadyPrivate from '@/assets/premium-ready-private-v2.png';

const MANUAL_SYSTEMS = Object.freeze([
  { id: 'location', label: 'Location', icon: LocateFixed },
  { id: 'background', label: 'Background', icon: Satellite },
  { id: 'notifications', label: 'Notifications', icon: Smartphone },
]);

/**
 * @param {{ foregroundLocationReady?: boolean, backgroundLocationReady?: boolean, notificationsReady?: boolean }} status
 */
export function buildTripLaunchStatus(status = {}) {
  const readyById = {
    location: status.foregroundLocationReady === true,
    background: status.backgroundLocationReady === true,
    notifications: status.notificationsReady === true,
  };
  const systems = MANUAL_SYSTEMS.map((system) => ({
    ...system,
    ready: readyById[system.id],
  }));
  const readyCount = systems.filter((system) => system.ready).length;

  return {
    isReady: readyCount === systems.length,
    readyCount,
    systems,
    totalCount: systems.length,
  };
}

/**
 * @param {{
 *   androidManualBackgroundReady?: boolean,
 *   backgroundLocationReady?: boolean,
 *   foregroundLocationReady?: boolean,
 *   isAndroidManualMode?: boolean,
 *   notificationsReady?: boolean,
 *   onEnableBackgroundTracking: () => void,
 *   onRefreshTrackingStatus: () => void,
 *   onStartPrivateTrip: () => void,
 *   onStartTrip: () => void,
 *   startingTrip?: boolean,
 * }} props
 */
export default function PremiumReadyToDriveCard({
  androidManualBackgroundReady = false,
  backgroundLocationReady = false,
  foregroundLocationReady = false,
  isAndroidManualMode = false,
  notificationsReady = false,
  onEnableBackgroundTracking,
  onRefreshTrackingStatus,
  onStartPrivateTrip,
  onStartTrip,
  startingTrip = false,
}) {
  const launchStatus = buildTripLaunchStatus({
    backgroundLocationReady,
    foregroundLocationReady,
    notificationsReady,
  });
  const manualReady = isAndroidManualMode && androidManualBackgroundReady && launchStatus.isReady;
  const statusReady = !isAndroidManualMode || manualReady;

  return (
    <section
      className="premium-ready-card"
      data-status={statusReady ? 'ready' : 'attention'}
      aria-labelledby="premium-ready-title"
    >
      <div className="premium-ready-grid" aria-hidden="true" />
      <div className="premium-ready-orbit premium-ready-orbit-one" aria-hidden="true" />
      <div className="premium-ready-orbit premium-ready-orbit-two" aria-hidden="true" />

      <div className="premium-ready-hero">
        <div className="premium-ready-road-lines" aria-hidden="true" />
        <div className="premium-ready-copy">
          <div className="premium-ready-eyebrow">
            <span className="premium-ready-live-dot" aria-hidden="true" />
            Ready to drive?
          </div>
          <h2 id="premium-ready-title">Start a new trip</h2>
          <p>Tap to begin tracking your route</p>

          <div className="premium-ready-status" data-status={statusReady ? 'ready' : 'attention'}>
            {statusReady ? <ShieldCheck aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
            <span>
              <strong>{statusReady ? 'Trip systems ready' : 'Setup needed'}</strong>
              <small>
                {isAndroidManualMode
                  ? `${launchStatus.readyCount} of ${launchStatus.totalCount} checks ready`
                  : 'Route tracking is standing by'}
              </small>
            </span>
          </div>

          <button
            type="button"
            onClick={onStartTrip}
            disabled={startingTrip}
            aria-label={startingTrip ? 'Starting trip' : 'Start trip'}
            aria-busy={startingTrip || undefined}
            className="premium-ready-start"
          >
            <span aria-hidden="true">
              {startingTrip
                ? <RefreshCw className="animate-spin" />
                : <Play />}
            </span>
          </button>
        </div>

        <div className="premium-ready-visual">
          <div className="premium-ready-art-halo" aria-hidden="true" />
          <img src={premiumReadyHero} alt="" aria-hidden="true" />
        </div>
      </div>

      {isAndroidManualMode && (
        <div className="premium-ready-manual" data-status={manualReady ? 'ready' : 'attention'}>
          <img className="premium-ready-manual-art" src={premiumReadyManual} alt="" aria-hidden="true" />
          <div className="premium-ready-manual-head">
            <div>
              <span className="premium-ready-manual-kicker">
                {manualReady ? <ShieldCheck aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
                {manualReady ? 'Protected recording' : 'Action required'}
              </span>
              <strong>
                {manualReady
                  ? 'Manual trips will use Background GPS'
                  : 'Manual background setup needed'}
              </strong>
              <p>
                {manualReady
                  ? 'You can minimize Road Sage after starting while the recording notification is visible. Do not fully close or force-stop the app.'
                  : 'Enable Background Tracking before you start. Manual Android trips are intended to run through the native background service.'}
              </p>
            </div>
          </div>

          <div className="premium-ready-checks" aria-label="Manual trip system checks">
            {launchStatus.systems.map(({ id, icon: Icon, label, ready }) => (
              <div key={id} className="premium-ready-check" data-ready={ready ? 'true' : 'false'}>
                <Icon aria-hidden="true" />
                <span>{label}</span>
                <small>{ready ? 'Ready' : 'Needed'}</small>
              </div>
            ))}
          </div>

          <div className="premium-ready-actions">
            {!manualReady && (
              <button type="button" onClick={onEnableBackgroundTracking}>
                Enable Background Tracking
              </button>
            )}
            <button type="button" onClick={onRefreshTrackingStatus}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onStartPrivateTrip}
        disabled={startingTrip}
        aria-busy={startingTrip || undefined}
        className="premium-ready-private"
      >
        <span className="premium-ready-private-art" aria-hidden="true">
          <img src={premiumReadyPrivate} alt="" />
        </span>
        <span className="premium-ready-private-copy">
          <span className="premium-ready-private-kicker">Privacy mode</span>
          <strong>{startingTrip ? 'Starting trip...' : 'Start Private Trip'}</strong>
          <small>
            <span>Save distance and duration only.</span>
            <span>No route, addresses, events, or score.</span>
          </small>
        </span>
        <span className="premium-ready-private-arrow" aria-hidden="true">→</span>
      </button>
    </section>
  );
}
