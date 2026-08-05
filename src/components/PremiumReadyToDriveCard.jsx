// @ts-check
import {
  AlertTriangle,
  Camera,
  LocateFixed,
  RefreshCw,
  Satellite,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import premiumReadyHero from '@/assets/premium-ready-city-hero-v6.webp';
import premiumReadyManual from '@/assets/premium-ready-systems-v6.webp';
import premiumReadyPrivate from '@/assets/premium-ready-private-v6.webp';
import premiumReadyPrivateControl from '@/assets/premium-ready-private-control-generated-v1.webp';
import premiumReadyPrivateShield from '@/assets/premium-ready-private-shield-generated-v1.webp';
import premiumReadyStartControl from '@/assets/premium-ready-start-generated-v1.webp';

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
 *   onStartTripWithCamera?: () => void,
 *   speedSignScannerEnabled?: boolean,
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
  onStartTripWithCamera,
  speedSignScannerEnabled = false,
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
      data-manual-mode={isAndroidManualMode ? 'true' : 'false'}
      aria-labelledby="premium-ready-title"
    >
      <img loading="lazy"
        className="premium-ready-card-background"
        src={premiumReadyHero}
        alt=""
        aria-hidden="true"
      />
      <div className="premium-ready-hero">
        <img loading="lazy"
          className="premium-ready-hero-image"
          src={premiumReadyHero}
          alt=""
          aria-hidden="true"
        />
        <div className="premium-ready-hero-shade" aria-hidden="true" />

        <div className="premium-ready-copy">
          <div className="premium-ready-eyebrow">Ready to drive?</div>
          <h2 id="premium-ready-title">Start a new trip</h2>
          <p>Tap to begin tracking your route</p>

          <button
            type="button"
            onClick={onStartTrip}
            disabled={startingTrip}
            aria-label={startingTrip ? 'Starting trip' : 'Start trip'}
            aria-busy={startingTrip || undefined}
            className="premium-ready-start"
          >
            <img loading="lazy"
              className="premium-ready-start-art"
              src={premiumReadyStartControl}
              alt=""
              aria-hidden="true"
            />
            <span className="premium-ready-start-ring" aria-hidden="true">
              {startingTrip ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <span className="premium-ready-start-label">
                  <span>Start</span>
                  <span>Trip</span>
                </span>
              )}
              <span className="premium-ready-start-ready" />
            </span>
          </button>
        </div>
      </div>

      {typeof onStartTripWithCamera === 'function' && (
        <div className="premium-ready-actions">
          <button
            type="button"
            onClick={onStartTripWithCamera}
            disabled={startingTrip}
            className="premium-ready-camera-start"
            title={speedSignScannerEnabled
              ? 'Start the manual trip and mounted rear-camera scanner while parked'
              : 'Enable Optional on-device speed-sign scan in Settings first'}
          >
            <Camera aria-hidden="true" />
            {startingTrip
              ? 'Starting...'
              : speedSignScannerEnabled
                ? 'Start Trip + Camera'
                : 'Enable Sign Scan in Settings'}
          </button>
        </div>
      )}

      {isAndroidManualMode && (
        <div className="premium-ready-manual" data-status={manualReady ? 'ready' : 'attention'}>
          <img loading="lazy" className="premium-ready-manual-image" src={premiumReadyManual} alt="" aria-hidden="true" />
          <div className="premium-ready-manual-shade" aria-hidden="true" />

          <div className="premium-ready-manual-head">
            <div>
              <span className="premium-ready-manual-kicker">
                {manualReady ? <ShieldCheck aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
                {manualReady ? 'Protected recording' : 'Action required'}
              </span>
              <span className="premium-ready-manual-count">
                {launchStatus.readyCount} of {launchStatus.totalCount} checks ready
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
        <img loading="lazy" className="premium-ready-private-image" src={premiumReadyPrivate} alt="" aria-hidden="true" />
        <span className="premium-ready-private-shade" aria-hidden="true" />
        <img loading="lazy"
          className="premium-ready-private-shield-art"
          src={premiumReadyPrivateShield}
          alt=""
          aria-hidden="true"
        />
        <span className="premium-ready-private-copy">
          <strong>{startingTrip ? 'Starting trip...' : 'Start Private Trip'}</strong>
          <small>
            <span>Save distance and duration only.</span>
            <span>No route, addresses, events, or score.</span>
          </small>
        </span>
        <img loading="lazy"
          className="premium-ready-private-control-art"
          src={premiumReadyPrivateControl}
          alt=""
          aria-hidden="true"
        />
      </button>
    </section>
  );
}
