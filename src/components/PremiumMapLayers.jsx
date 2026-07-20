// @ts-check
import {
  ChevronRight,
  CloudDownload,
  Gauge,
  Layers3,
  LockKeyhole,
  MapPinned,
  Radar,
  Route,
  ShieldCheck,
} from 'lucide-react';
import premiumSpeedLayerArt from '@/assets/premium-map-layer-speed.webp';
import premiumRepeatedRouteArt from '@/assets/premium-map-layer-repeated-route.webp';
import premiumEventAreasArt from '@/assets/premium-map-layer-event-areas.webp';
import { describeMapMatchingStatus, describeOsmSpeedLimitStatus } from '@/lib/openSourceTripContext';

const cleanStatus = (value) => String(value || 'not_fetched').replace(/_/g, ' ');
const formatCount = (value) => new Intl.NumberFormat('en-US').format(Math.max(0, Number(value) || 0));

export function getPremiumSpeedLayerStatus({
  selectedTrip,
  selectedRouteReady,
  selectedHasLocalSpeedLimits,
  selectedHasSpeedLimits,
  selectedSpeedLimitCoverage,
  speedLimitLookupEnabled,
  roadDataPending,
  osmFetchStatus,
  selectedSpeedLimitStatus,
}) {
  if (!selectedTrip) return 'Select a trip first';
  if (!selectedRouteReady) return 'Loading route data';
  if (selectedHasLocalSpeedLimits) return 'Saved local speeds available - tap to show or hide';
  if (selectedHasSpeedLimits) return `${selectedSpeedLimitCoverage}% coverage - tap to show or hide`;
  if (!speedLimitLookupEnabled) return 'OpenStreetMap speed-limit lookup is off in Settings';
  if (roadDataPending) return osmFetchStatus || 'Getting road data...';
  return `${cleanStatus(selectedSpeedLimitStatus)} - tap to get road data`;
}

const ToggleState = ({ active, disabled, actionLabel = 'Off', disabledLabel = 'Unavailable' }) => (
  <span className="premium-map-layer-state" data-active={active} data-disabled={disabled}>
    {disabled && <LockKeyhole aria-hidden="true" />}
    <span>{disabled ? disabledLabel : active ? 'On' : actionLabel}</span>
  </span>
);

/**
 * Premium-only presentation for the existing map-layer controls. Data and
 * actions are intentionally owned by MapScreen so standard mode stays intact.
 */
export default function PremiumMapLayers({
  selectedTrip,
  selectedRouteReady,
  selectedHasLocalSpeedLimits,
  selectedHasSpeedLimits,
  selectedSpeedLimitCoverage,
  selectedSpeedLimitStatus,
  selectedMapMatchingStatus,
  selectedRiskSegmentCount,
  visibleDangerZoneCount,
  dangerZonesLoading,
  speedLimitLookupEnabled,
  showSpeedLimits,
  showRouteRisk,
  showDangerZones,
  speedLayerDisabled,
  roadDataPending,
  roadDataError,
  osmFetchStatus,
  selectedLayerEffect,
  osrmConfigured,
  settings,
  onSpeedLayer,
  onRouteRiskLayer,
  onDangerZoneLayer,
  onFetchRoadData,
}) {
  const speedStatus = getPremiumSpeedLayerStatus({
    selectedTrip,
    selectedRouteReady,
    selectedHasLocalSpeedLimits,
    selectedHasSpeedLimits,
    selectedSpeedLimitCoverage,
    speedLimitLookupEnabled,
    roadDataPending,
    osmFetchStatus,
    selectedSpeedLimitStatus,
  });
  const routeDisabled = !selectedTrip;
  const speedActionLabel = selectedTrip && selectedRouteReady && !selectedHasSpeedLimits && speedLimitLookupEnabled
    ? 'Get data'
    : 'Off';
  const speedDisabledLabel = !selectedTrip
    ? 'Trip required'
    : !selectedRouteReady || roadDataPending
      ? 'Please wait'
      : !selectedHasSpeedLimits && !speedLimitLookupEnabled
        ? 'Settings off'
        : 'Unavailable';
  const speedLimitsEnabled = settings.speed_limit_lookup_enabled !== false;
  const weatherEnabled = settings.weather_context_enabled !== false;
  const matchingEnabled = settings.map_matching_enabled !== false;
  const matchingReady = matchingEnabled && settings.osrm_map_matching_url && settings.osrm_data_sharing_consented === true;
  const eventAreaStatus = dangerZonesLoading
    ? 'Checking local areas...'
    : `${formatCount(visibleDangerZoneCount)} local areas`;

  return (
    <section className="premium-map-layers-card" aria-labelledby="premium-map-layers-title">
      <div className="premium-map-layers-head">
        <span className="premium-map-layers-emblem" aria-hidden="true"><Layers3 /></span>
        <div>
          <h2 id="premium-map-layers-title">Map layers</h2>
          <p>{selectedTrip ? 'Fine-tune overlays for this selected trip' : 'Customize what appears on your map'}</p>
        </div>
        <span className="premium-map-layers-context">{selectedTrip ? 'Trip selected' : 'Overview'}</span>
      </div>

      <div className="premium-map-layer-grid">
        <button
          type="button"
          className="premium-map-layer-tile"
          data-layer="speed"
          aria-pressed={showSpeedLimits}
          aria-label={`Speed-limit layer. ${speedStatus}`}
          disabled={speedLayerDisabled}
          onClick={onSpeedLayer}
        >
          <img className="premium-map-layer-art" src={premiumSpeedLayerArt} alt="" aria-hidden="true" />
          <span className="premium-map-layer-glass" aria-hidden="true" />
          <span className="premium-map-layer-icon" aria-hidden="true"><Gauge /></span>
          <span className="premium-map-layer-copy">
            <strong>Speed-limit layer</strong>
            <small>{speedStatus}</small>
          </span>
          <span className="premium-map-layer-tail">
            <ToggleState
              active={showSpeedLimits}
              disabled={speedLayerDisabled}
              actionLabel={speedActionLabel}
              disabledLabel={speedDisabledLabel}
            />
            <ChevronRight aria-hidden="true" />
          </span>
        </button>

        <button
          type="button"
          className="premium-map-layer-tile"
          data-layer="route-risk"
          aria-pressed={showRouteRisk}
          aria-label={`Repeated-event layer. ${selectedTrip ? `${formatCount(selectedRiskSegmentCount)} matched segments` : 'Select a trip first'}`}
          disabled={routeDisabled}
          onClick={onRouteRiskLayer}
        >
          <img className="premium-map-layer-art" src={premiumRepeatedRouteArt} alt="" aria-hidden="true" />
          <span className="premium-map-layer-glass" aria-hidden="true" />
          <span className="premium-map-layer-icon" aria-hidden="true"><Route /></span>
          <span className="premium-map-layer-copy">
            <strong>Repeated-event layer</strong>
            <small>{selectedTrip ? `${formatCount(selectedRiskSegmentCount)} matched segments` : 'Select a trip first'}</small>
          </span>
          <span className="premium-map-layer-tail">
            <ToggleState active={showRouteRisk} disabled={routeDisabled} disabledLabel="Trip required" />
            <ChevronRight aria-hidden="true" />
          </span>
        </button>

        <button
          type="button"
          className="premium-map-layer-tile"
          data-layer="event-areas"
          aria-pressed={showDangerZones}
          aria-label={`Repeated event areas. ${eventAreaStatus}`}
          onClick={onDangerZoneLayer}
        >
          <img className="premium-map-layer-art" src={premiumEventAreasArt} alt="" aria-hidden="true" />
          <span className="premium-map-layer-glass" aria-hidden="true" />
          <span className="premium-map-layer-icon" aria-hidden="true"><Radar /></span>
          <span className="premium-map-layer-copy">
            <strong>Repeated event areas</strong>
            <small>{eventAreaStatus}</small>
          </span>
          <span className="premium-map-layer-tail">
            <ToggleState active={showDangerZones} disabled={false} />
            <ChevronRight aria-hidden="true" />
          </span>
        </button>
      </div>

      {selectedTrip && (
        <div className="premium-map-road-data">
          <div className="premium-map-road-data-head">
            <span aria-hidden="true"><ShieldCheck /></span>
            <div>
              <h3>Get Road Data, in plain words</h3>
              <p>Runs only the enabled online lookups for this selected trip. Privacy-zone coordinates are excluded before anything leaves the app.</p>
            </div>
          </div>

          <div className="premium-map-road-data-grid">
            <div className="premium-map-road-source" data-source="speed">
              <Gauge aria-hidden="true" />
              <strong>Speed limits <span>{speedLimitsEnabled ? 'ON' : 'OFF'}</span></strong>
              <p>{speedLimitsEnabled ? 'Sends privacy-filtered public road boxes to OpenStreetMap for posted maxspeed; missing tags may use labeled estimates.' : 'OpenStreetMap speed-limit lookup is skipped; route colors use GPS bands or any speed-limit data already saved on the trip.'}</p>
            </div>
            <div className="premium-map-road-source" data-source="weather">
              <MapPinned aria-hidden="true" />
              <strong>Weather <span>{weatherEnabled ? 'ON' : 'OFF'}</span></strong>
              <p>{weatherEnabled ? 'Sends one privacy-safe route point and trip date to Open-Meteo.' : 'Open-Meteo is skipped; scores get no weather adjustment.'}</p>
            </div>
            <div className="premium-map-road-source" data-source="matching">
              <Route aria-hidden="true" />
              <strong>Snap to roads <span>{!matchingEnabled ? 'OFF' : matchingReady ? 'ON' : 'NEEDS CONSENT'}</span></strong>
              <p>{!matchingEnabled ? 'OSRM is skipped; map/playback keep GPS shape.' : matchingReady ? 'Sends sampled public GPS segments to your OSRM endpoint.' : 'OSRM is skipped until a trusted endpoint and consent are saved in Settings.'}</p>
            </div>
          </div>

          <div className="premium-map-road-result" aria-live="polite">
            <Radar aria-hidden="true" />
            <strong>{roadDataPending ? osmFetchStatus || 'Getting road data...' : selectedLayerEffect}</strong>
            <span>Speed limits: {cleanStatus(selectedSpeedLimitStatus)}</span>
            <span>Map matching: {cleanStatus(selectedMapMatchingStatus)}{osrmConfigured ? '' : ' (off)'}</span>
          </div>

          {!osrmConfigured && (
            <div className="premium-map-road-note">
              {describeMapMatchingStatus(selectedTrip.map_matching_context || { status: 'disabled' })}
            </div>
          )}
        </div>
      )}

      {selectedTrip && !selectedHasSpeedLimits && speedLimitLookupEnabled && (
        <div className="premium-map-road-fetch">
          <span className="premium-map-road-fetch-icon" aria-hidden="true"><CloudDownload /></span>
          <div>
            <strong>Speed data is ready to request</strong>
            <p>{describeOsmSpeedLimitStatus(selectedTrip.speed_limit_context)}</p>
            {roadDataError && <p className="premium-map-road-error">{roadDataError}</p>}
          </div>
          <button
            type="button"
            onClick={onFetchRoadData}
            disabled={roadDataPending || !selectedRouteReady || !selectedTrip.route_points?.length}
          >
            {roadDataPending ? osmFetchStatus || 'Getting road data...' : 'Get Road Data'}
          </button>
        </div>
      )}
    </section>
  );
}
