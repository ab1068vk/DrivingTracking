// @ts-check
import {
  AlertTriangle,
  CircleCheckBig,
  Gauge,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Route,
} from 'lucide-react';
import premiumEventAreasEmblem from '@/assets/premium-event-areas-emblem-v2.png';
import premiumEventAreasMap from '@/assets/premium-event-areas-map-v2.png';
import premiumEventAreaBraking from '@/assets/premium-event-area-braking.png';
import premiumEventAreaSpeeding from '@/assets/premium-event-area-speeding.png';
import premiumEventAreaTurn from '@/assets/premium-event-area-turn.png';

const EVENT_PRESENTATIONS = Object.freeze({
  harsh_brake: {
    asset: premiumEventAreaBraking,
    icon: AlertTriangle,
    label: 'Harsh braking',
    tone: 'braking',
  },
  speeding: {
    asset: premiumEventAreaSpeeding,
    icon: Gauge,
    label: 'Speeding',
    tone: 'speeding',
  },
  sharp_turn: {
    asset: premiumEventAreaTurn,
    icon: Route,
    label: 'Sharp turn',
    tone: 'turning',
  },
});

const FALLBACK_PRESENTATION = Object.freeze({
  asset: premiumEventAreasMap,
  icon: AlertTriangle,
  label: 'Driving event',
  tone: 'risk',
});

function titleCaseEventType(value) {
  const label = String(value || '').replace(/_/g, ' ').trim();
  return label ? label.replace(/\b\w/g, (letter) => letter.toUpperCase()) : FALLBACK_PRESENTATION.label;
}

/**
 * Keeps the premium surface driven by the same calculated danger-zone object
 * as the standard UI while normalizing unsafe or unexpectedly large values.
 * @param {Record<string, any>} zone
 */
export function buildPremiumEventAreaViewModel(zone = {}) {
  const presentation = EVENT_PRESENTATIONS[zone?.dominantType] || FALLBACK_PRESENTATION;
  const eventCount = Math.max(0, Math.floor(Number(zone?.eventCount) || 0));
  const latitude = Number(zone?.lat);
  const longitude = Number(zone?.lng);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const rawRiskLevel = String(zone?.riskLevel || 'low').toLowerCase();
  const riskLevel = ['critical', 'high', 'medium', 'low'].includes(rawRiskLevel) ? rawRiskLevel : 'low';
  const evidenceDots = Math.max(1, Math.min(5, eventCount));

  return {
    ...presentation,
    coordLabel: hasCoordinates ? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` : 'Location unavailable',
    eventCount,
    eventLabel: `${eventCount} repeated event${eventCount === 1 ? '' : 's'}`,
    evidenceDots,
    label: EVENT_PRESENTATIONS[zone?.dominantType]?.label || titleCaseEventType(zone?.dominantType),
    riskLabel: `${riskLevel} event level`,
    riskLevel,
  };
}

function EvidenceDots({ count }) {
  return (
    <span className="premium-event-area-evidence" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((dot) => <i key={dot} data-active={dot < count} />)}
    </span>
  );
}

function EmptyEvidence({ completedTripCount, hiddenAreaCount }) {
  const hiddenByPrivacy = hiddenAreaCount > 0;
  const noTrips = completedTripCount === 0;
  return (
    <div className="premium-event-areas-empty" data-kind={hiddenByPrivacy ? 'private' : noTrips ? 'new' : 'clear'}>
      <div className="premium-event-areas-empty-metric">
        <span className="premium-event-areas-check" aria-hidden="true">
          {hiddenByPrivacy ? <LockKeyhole /> : noTrips ? <Route /> : <CircleCheckBig />}
        </span>
        <strong>{hiddenByPrivacy ? hiddenAreaCount : completedTripCount}</strong>
        <span>{hiddenByPrivacy ? `private area${hiddenAreaCount === 1 ? '' : 's'}` : `trip${completedTripCount === 1 ? '' : 's'} checked`}</span>
      </div>
      <div className="premium-event-areas-empty-copy">
        {hiddenByPrivacy ? (
          <>
            <strong>Your privacy zones are working.</strong>
            <p>
              {hiddenAreaCount} repeated driving-event area{hiddenAreaCount === 1 ? ' is' : 's are'} hidden because {hiddenAreaCount === 1 ? 'it is' : 'they are'} inside your privacy zones.
            </p>
          </>
        ) : noTrips ? (
          <>
            <strong>Build your private driving pattern.</strong>
            <p>No completed trips with event-location evidence are available yet.</p>
          </>
        ) : (
          <>
            <p>
              Checked all <b>{completedTripCount}</b> completed trip{completedTripCount === 1 ? '' : 's'}. The app groups scored harsh-braking, speeding, and sharp-turn coordinates into roughly <b>80-metre</b> cells. Driving the same road again only creates an area when qualifying events also repeat there.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * @param {{
 *  completedTripCount: number,
 *  canToggleAll: boolean,
 *  dangerZonesReady: boolean,
 *  displayedDangerZones: Array<Record<string, any>>,
 *  hiddenAreaCount: number,
 *  hiddenDangerZoneCount: number,
 *  loading: boolean,
 *  onShowAll: () => void,
 *  onShowOnMap: () => void,
 *  relativeTimeFormatter: (value: any) => string,
 *  showAllDangerZones: boolean,
 *  visibleDangerZoneCount: number,
 * }} props
 */
export default function PremiumEventAreasCard({
  canToggleAll,
  completedTripCount,
  dangerZonesReady,
  displayedDangerZones,
  hiddenAreaCount,
  hiddenDangerZoneCount,
  loading,
  onShowAll,
  onShowOnMap,
  relativeTimeFormatter,
  showAllDangerZones,
  visibleDangerZoneCount,
}) {
  const state = loading || !dangerZonesReady ? 'loading' : visibleDangerZoneCount ? 'ready' : 'empty';
  const mapButtonDisabled = visibleDangerZoneCount === 0;
  const mapButtonStatus = state === 'loading'
    ? 'Areas are still loading'
    : hiddenAreaCount > 0
      ? 'All areas are private'
      : 'No areas to map';

  return (
    <section className="premium-event-areas" data-state={state} aria-labelledby="premium-event-areas-title">
      <div className="premium-event-areas-grid" aria-hidden="true" />
      <div className="premium-event-areas-orbit" aria-hidden="true"><i /><i /><i /></div>

      <header className="premium-event-areas-header">
        <span className="premium-event-areas-emblem" aria-hidden="true">
          <img src={premiumEventAreasEmblem} alt="" />
        </span>
        <div className="premium-event-areas-identity">
          <div>
            <h2 id="premium-event-areas-title">Repeated Driving-Event Areas</h2>
            <p>Your repeated harsh-braking, speeding, or sharp-turn locations</p>
          </div>
        </div>
        <button
          type="button"
          className="premium-event-areas-map-button"
          onClick={onShowOnMap}
          disabled={mapButtonDisabled}
          aria-label={mapButtonDisabled ? `Show on map unavailable. ${mapButtonStatus}.` : 'Show repeated driving-event areas on map'}
          title={mapButtonDisabled ? mapButtonStatus : 'Show repeated driving-event areas on map'}
        >
          <span className="premium-event-areas-map-icon" aria-hidden="true">
            <MapPin />
          </span>
          <span className="premium-event-areas-map-copy">Show on map</span>
        </button>
      </header>

      <div className="premium-event-areas-hero" aria-hidden="true">
        <img src={premiumEventAreasMap} alt="" />
        <span className="premium-event-areas-scan" />
      </div>

      {state === 'loading' ? (
        <div className="premium-event-areas-loading" role="status" aria-live="polite">
          <span className="premium-event-areas-loader" aria-hidden="true"><LoaderCircle /></span>
          <div>
            <strong>Checking your driving history</strong>
            <p>Looking through completed trips for repeated driving-event locations...</p>
          </div>
          <span className="premium-event-areas-loading-line" aria-hidden="true"><i /></span>
        </div>
      ) : state === 'empty' ? (
        <EmptyEvidence completedTripCount={completedTripCount} hiddenAreaCount={hiddenAreaCount} />
      ) : (
        <div className="premium-event-area-grid" aria-label={`${visibleDangerZoneCount} repeated driving-event area${visibleDangerZoneCount === 1 ? '' : 's'}`}>
          {displayedDangerZones.map((zone) => {
            const model = buildPremiumEventAreaViewModel(zone);
            const Icon = model.icon;
            return (
              <article
                key={zone.id}
                className="premium-event-area-card"
                data-event={model.tone}
                data-risk={model.riskLevel}
                aria-label={`${model.label}. ${model.eventLabel}. ${model.riskLabel}. Near ${model.coordLabel}${zone.lastSeen ? `. Last seen ${relativeTimeFormatter(zone.lastSeen)}` : ''}`}
              >
                <img className="premium-event-area-art" src={model.asset} alt="" aria-hidden="true" />
                <div className="premium-event-area-glass" aria-hidden="true" />
                <div className="premium-event-area-head">
                  <span className="premium-event-area-icon" aria-hidden="true"><Icon /></span>
                  <span className="premium-event-area-risk">{model.riskLabel}</span>
                </div>
                <div className="premium-event-area-copy">
                  <span className="premium-event-area-type">{model.label}</span>
                  <strong>{model.eventCount}</strong>
                  <span className="premium-event-area-count">repeated event{model.eventCount === 1 ? '' : 's'}</span>
                  <span className="premium-event-area-location"><MapPin aria-hidden="true" /> {model.coordLabel}</span>
                  {zone.lastSeen && <small>Last seen {relativeTimeFormatter(zone.lastSeen)}</small>}
                </div>
                <div className="premium-event-area-footer">
                  <span>Repeat evidence</span>
                  <EvidenceDots count={model.evidenceDots} />
                </div>
              </article>
            );
          })}
        </div>
      )}

      {canToggleAll && !showAllDangerZones && (
        <button type="button" onClick={onShowAll} className="premium-event-areas-more">
          Show all areas <span>{hiddenDangerZoneCount} hidden</span>
        </button>
      )}
      {canToggleAll && showAllDangerZones && (
        <button type="button" onClick={onShowAll} className="premium-event-areas-more">
          Show fewer areas
        </button>
      )}

    </section>
  );
}
