// @ts-check
import {
  AlertTriangle,
  Gauge,
  LoaderCircle,
  MapPin,
  Route,
} from 'lucide-react';
import premiumEventAreasHighway from '@/assets/premium-event-areas-highway-v7.webp';
import premiumEventAreasMap from '@/assets/premium-event-areas-map-v2.webp';
import premiumEventAreasShield from '@/assets/premium-event-areas-shield-v3.webp';
import premiumEventAreasShieldWheel from '@/assets/premium-event-areas-shield-wheel-v4.webp';
import premiumEventAreasTripMap from '@/assets/premium-event-areas-trip-map-v4.webp';
import premiumEventAreaBraking from '@/assets/premium-event-area-braking-v2.webp';
import premiumEventAreaSpeeding from '@/assets/premium-event-area-speeding-v2.webp';
import premiumEventAreaTurn from '@/assets/premium-event-area-turn-v2.webp';
import { DANGER_ZONE_CELL_SIZE_M, DANGER_ZONE_MIN_EVENTS } from '@/lib/dangerZoneEngine';
import { formatDistance } from '@/lib/tripEngine';

const EVENT_PRESENTATIONS = Object.freeze({
  harsh_brake: {
    asset: premiumEventAreaBraking,
    icon: AlertTriangle,
    label: 'Harsh braking',
    pluralLabel: 'Harsh braking',
    displayLabel: 'Harsh Braking',
    tone: 'braking',
    tracePoints: '0,17 9,9 18,15 28,5 38,17 48,8 58,14 68,4 78,15 88,8 98,16 110,6',
  },
  speeding: {
    asset: premiumEventAreaSpeeding,
    icon: Gauge,
    label: 'Speeding',
    pluralLabel: 'Speeding',
    tone: 'speeding',
    tracePoints: '0,17 10,12 19,16 29,6 39,14 50,3 60,13 70,7 80,17 90,10 100,14 110,5',
  },
  sharp_turn: {
    asset: premiumEventAreaTurn,
    icon: Route,
    label: 'Sharp turn',
    pluralLabel: 'Sharp turns',
    displayLabel: 'Sharp Turns',
    tone: 'turning',
    tracePoints: '0,15 12,10 24,15 36,6 48,17 60,11 72,17 84,8 96,13 110,7',
  },
});

const EVENT_SUMMARY_ORDER = Object.freeze(['harsh_brake', 'speeding', 'sharp_turn']);

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
export function buildPremiumEventAreaViewModel(zone = {}, units = 'metric') {
  const presentation = EVENT_PRESENTATIONS[zone?.dominantType] || FALLBACK_PRESENTATION;
  const eventCount = Math.max(0, Math.floor(Number(zone?.eventCount) || 0));
  const latitude = Number(zone?.lat);
  const longitude = Number(zone?.lng);
  const radiusM = Math.max(0, Number(zone?.radiusM) || 0);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const rawRiskLevel = String(zone?.riskLevel || 'low').toLowerCase();
  const riskLevel = ['critical', 'high', 'medium', 'low'].includes(rawRiskLevel) ? rawRiskLevel : 'low';
  const evidenceDots = Math.max(1, Math.min(5, eventCount));

  return {
    ...presentation,
    areaLabel: radiusM > 0 ? `Approximately ${formatDistance(radiusM / 1000, units)} area` : 'Area size unavailable',
    coordLabel: hasCoordinates ? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` : 'Location unavailable',
    eventCount,
    eventLabel: `${eventCount} repeated event${eventCount === 1 ? '' : 's'}`,
    evidenceDots,
    label: EVENT_PRESENTATIONS[zone?.dominantType]?.label || titleCaseEventType(zone?.dominantType),
    riskLabel: `${riskLevel} event level`,
    riskLevel,
  };
}

/**
 * Aggregates the actual learned area list into the three semantic summaries
 * shown in the reference-led premium card. Counts are learned areas, not
 * demonstration event values.
 * @param {Array<Record<string, any>>} zones
 */
export function buildPremiumEventAreaTypeSummaries(zones = []) {
  const summaries = Object.fromEntries(EVENT_SUMMARY_ORDER.map((type) => [
    type,
    {
      ...EVENT_PRESENTATIONS[type],
      areaCount: 0,
      eventCount: 0,
      type,
    },
  ]));

  for (const zone of Array.isArray(zones) ? zones : []) {
    const summary = summaries[zone?.dominantType];
    if (!summary) continue;
    summary.areaCount += 1;
    summary.eventCount += Math.max(0, Math.floor(Number(zone?.eventCount) || 0));
  }

  return EVENT_SUMMARY_ORDER.map((type) => summaries[type]);
}

function EvidenceDots({ count }) {
  return (
    <span className="premium-event-area-evidence" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((dot) => <i key={dot} data-active={dot < count} />)}
    </span>
  );
}

function EvidenceAudit({
  completedTripCount,
  hiddenAreaCount,
  state,
  visibleDangerZoneCount,
}) {
  const hiddenByPrivacy = hiddenAreaCount > 0;
  const noTrips = completedTripCount === 0;

  return (
    <div
      className="premium-event-areas-audit"
      data-kind={state === 'loading' ? 'loading' : hiddenByPrivacy ? 'private' : noTrips ? 'new' : visibleDangerZoneCount ? 'found' : 'clear'}
      role={state === 'loading' ? 'status' : undefined}
      aria-live={state === 'loading' ? 'polite' : undefined}
    >
      <div className="premium-event-areas-audit-metric">
        <span className="premium-event-areas-check premium-event-areas-trip-emblem" aria-hidden="true">
          <img loading="lazy" src={premiumEventAreasTripMap} alt="" />
        </span>
        <strong>{completedTripCount}</strong>
        <span>Completed trip{completedTripCount === 1 ? '' : 's'} checked</span>
      </div>
      <div className="premium-event-areas-audit-copy">
        {state === 'loading' ? (
          <>
            <strong>Checking your driving history</strong>
            <p>Looking through completed trips for repeated driving-event locations.</p>
          </>
        ) : hiddenByPrivacy ? (
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
        ) : visibleDangerZoneCount > 0 ? (
          <>
            <strong>{visibleDangerZoneCount} repeated driving-event area{visibleDangerZoneCount === 1 ? '' : 's'} found.</strong>
            <p>
              Each area contains at least <b>{DANGER_ZONE_MIN_EVENTS}</b> scored harsh-braking, speeding, or sharp-turn events grouped into roughly <b>{DANGER_ZONE_CELL_SIZE_M}-metre</b> cells.
            </p>
          </>
        ) : (
          <>
            <p>
              Checked all <b>{completedTripCount}</b> completed trip{completedTripCount === 1 ? '' : 's'}. No small map area has at least <b>{DANGER_ZONE_MIN_EVENTS}</b> scored harsh-braking, speeding, or sharp-turn events. The app groups event coordinates into roughly <b>{DANGER_ZONE_CELL_SIZE_M}-metre</b> cells; driving the same road more than once does not create an event area unless qualifying events also repeat there.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function EventTypeSummaryGrid({ loading, summaries }) {
  return (
    <div className="premium-event-type-grid" aria-label="Repeated driving-event area totals by type">
      {summaries.map((summary) => {
        const Icon = summary.icon;
        return (
          <article
            key={summary.type}
            className="premium-event-type-card"
            data-event={summary.tone}
            aria-label={loading
              ? `${summary.pluralLabel}. Checking learned areas.`
              : `${summary.pluralLabel}. ${summary.areaCount} learned area${summary.areaCount === 1 ? '' : 's'}, ${summary.eventCount} qualifying event${summary.eventCount === 1 ? '' : 's'}.`}
          >
            <img loading="lazy" src={summary.asset} alt="" aria-hidden="true" />
            <div className="premium-event-type-copy">
              <strong>{summary.displayLabel || summary.pluralLabel}</strong>
              <svg
                className="premium-event-type-trace"
                viewBox="0 0 110 22"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <polyline points={summary.tracePoints} />
              </svg>
              <span className="premium-event-type-count">
                <Icon aria-hidden="true" />
                <b>{loading ? '\u2014' : summary.areaCount}</b>
                <span>{loading ? 'checking' : `area${summary.areaCount === 1 ? '' : 's'}`}</span>
              </span>
              {!loading && (
                <small>{summary.eventCount} qualifying event{summary.eventCount === 1 ? '' : 's'}</small>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/**
 * @param {{
 *  completedTripCount: number,
 *  canToggleAll: boolean,
 *  dangerZones?: Array<Record<string, any>>,
 *  dangerZonesReady: boolean,
 *  displayedDangerZones: Array<Record<string, any>>,
 *  hiddenAreaCount: number,
 *  hiddenDangerZoneCount: number,
 *  loading: boolean,
 *  onShowAll: () => void,
 *  onShowOnMap: () => void,
 *  relativeTimeFormatter: (value: any) => string,
 *  showAllDangerZones: boolean,
 *  units?: string,
 *  variant?: 'coach' | 'map',
 *  visibleDangerZoneCount: number,
 * }} props
 */
export default function PremiumEventAreasCard({
  canToggleAll,
  completedTripCount,
  dangerZones,
  dangerZonesReady,
  displayedDangerZones,
  hiddenAreaCount,
  hiddenDangerZoneCount,
  loading,
  onShowAll,
  onShowOnMap,
  relativeTimeFormatter,
  showAllDangerZones,
  units = 'metric',
  variant = 'map',
  visibleDangerZoneCount,
}) {
  const state = loading || !dangerZonesReady ? 'loading' : visibleDangerZoneCount ? 'ready' : 'empty';
  const isCoachVariant = variant === 'coach';
  const primaryZone = displayedDangerZones[0] || null;
  const primaryModel = primaryZone ? buildPremiumEventAreaViewModel(primaryZone, units) : null;
  const coachAccent = state === 'ready' ? primaryModel?.tone || 'risk' : hiddenAreaCount > 0 ? 'private' : 'shield';
  const sectionTitle = isCoachVariant
    ? state === 'loading'
      ? 'Checking your driving history'
      : state === 'ready'
        ? `${visibleDangerZoneCount} local area${visibleDangerZoneCount === 1 ? '' : 's'} need attention`
        : hiddenAreaCount > 0
          ? `${hiddenAreaCount} repeated event area${hiddenAreaCount === 1 ? '' : 's'} stay private`
          : 'No repeated event area has enough evidence yet'
    : 'Repeated Driving-Event Areas';
  const coachDescription = state === 'loading'
    ? `Scanning ${completedTripCount} completed trip${completedTripCount === 1 ? '' : 's'} for repeat location evidence.`
    : state === 'ready'
      ? `${primaryModel?.label || 'Driving events'} is the leading pattern with ${primaryModel?.eventLabel || 'repeat evidence'}. Coordinates stay in the existing private map workflow.`
      : hiddenAreaCount > 0
        ? `${hiddenAreaCount} repeated driving-event area${hiddenAreaCount === 1 ? ' is' : 's are'} hidden because ${hiddenAreaCount === 1 ? 'it is' : 'they are'} inside your privacy zones.`
        : completedTripCount === 0
          ? 'Complete a trip with event-location evidence to start building your private pattern.'
          : `Coordinates stay in the existing private map workflow; all ${completedTripCount} completed trip${completedTripCount === 1 ? ' has' : 's have'} been checked.`;
  const heroAsset = isCoachVariant
    ? state === 'ready' && primaryModel
      ? primaryModel.asset
      : premiumEventAreasShield
    : premiumEventAreasHighway;
  const heroArt = isCoachVariant
    ? state === 'ready'
      ? primaryModel?.tone || 'map'
      : 'shield'
    : 'map';
  const mapButtonDisabled = visibleDangerZoneCount === 0;
  const mapButtonStatus = state === 'loading'
    ? 'Areas are still loading'
    : hiddenAreaCount > 0
      ? 'All areas are private'
      : 'No areas to map';
  const typeSummaries = buildPremiumEventAreaTypeSummaries(dangerZones || displayedDangerZones);

  return (
    <section
      className="premium-event-areas"
      data-accent={coachAccent}
      data-risk={primaryModel?.riskLevel || 'none'}
      data-state={state}
      data-variant={variant}
      aria-labelledby="premium-event-areas-title"
    >
      <div className="premium-event-areas-grid" aria-hidden="true" />
      <div className="premium-event-areas-orbit" aria-hidden="true"><i /><i /><i /></div>

      {isCoachVariant ? (
        <>
          <header className="premium-event-areas-coach-header">
            <span className="premium-event-areas-coach-emblem" aria-hidden="true">
              <img loading="lazy" src={premiumEventAreasShield} alt="" />
            </span>
            <span className="premium-event-areas-eyebrow">Repeated event areas</span>
          </header>

          <div className="premium-event-areas-coach-intro">
            <h2 id="premium-event-areas-title">{sectionTitle}</h2>
            <p>{coachDescription}</p>

            {state === 'loading' ? (
              <div className="premium-event-areas-coach-status" role="status" aria-live="polite">
                <LoaderCircle aria-hidden="true" />
                <span>Reviewing private trip evidence</span>
              </div>
            ) : (
              <div className="premium-event-areas-coach-facts" aria-label="Repeated event area evidence summary">
                <span><strong>{state === 'ready' ? visibleDangerZoneCount : 0}</strong> area{visibleDangerZoneCount === 1 ? '' : 's'}</span>
                <i aria-hidden="true" />
                <span><strong>{completedTripCount}</strong> trip{completedTripCount === 1 ? '' : 's'} checked</span>
                {primaryModel && (
                  <>
                    <i aria-hidden="true" />
                    <span><strong>{primaryModel.eventCount}</strong> events in the leading area</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="premium-event-areas-hero" aria-hidden="true">
            <img loading="lazy" src={heroAsset} alt="" data-art={heroArt} />
            <span className="premium-event-areas-scan" />
          </div>
        </>
      ) : (
        <>
          <header className="premium-event-areas-header">
            <span className="premium-event-areas-emblem" aria-hidden="true">
              <img loading="lazy" src={premiumEventAreasShieldWheel} alt="" />
            </span>
            <div className="premium-event-areas-identity">
              <div>
                <h2 id="premium-event-areas-title">{sectionTitle}</h2>
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
            <span className="premium-event-areas-map-copy">
              Show on map
              {mapButtonDisabled && <small>{mapButtonStatus}</small>}
            </span>
          </button>
          </header>

          <div className="premium-event-areas-hero" aria-hidden="true">
            <img loading="lazy" src={heroAsset} alt="" data-art={heroArt} />
            <span className="premium-event-areas-scan" />
          </div>
        </>
      )}

      {!isCoachVariant && (
        <div className="premium-event-areas-evidence-shell">
          <EvidenceAudit
            completedTripCount={completedTripCount}
            hiddenAreaCount={hiddenAreaCount}
            state={state}
            visibleDangerZoneCount={visibleDangerZoneCount}
          />
          <EventTypeSummaryGrid loading={state === 'loading'} summaries={typeSummaries} />
        </div>
      )}

      {state === 'ready' ? (
        <div className="premium-event-area-grid" aria-label={`${visibleDangerZoneCount} repeated driving-event area${visibleDangerZoneCount === 1 ? '' : 's'}`}>
          {displayedDangerZones.map((zone) => {
            const model = buildPremiumEventAreaViewModel(zone, units);
            const Icon = model.icon;
            return (
              <article
                key={zone.id}
                className="premium-event-area-card"
                data-event={model.tone}
                data-risk={model.riskLevel}
                aria-label={`${model.label}. ${model.eventLabel}. ${model.riskLabel}. Near ${model.coordLabel}${zone.lastSeen ? `. Last seen ${relativeTimeFormatter(zone.lastSeen)}` : ''}`}
              >
                <img loading="lazy" className="premium-event-area-art" src={model.asset} alt="" aria-hidden="true" />
                <div className="premium-event-area-glass" aria-hidden="true" />
                <div className="premium-event-area-head">
                  <span className="premium-event-area-icon" aria-hidden="true"><Icon /></span>
                  <span className="premium-event-area-risk">{model.riskLabel}</span>
                </div>
                <div className="premium-event-area-copy">
                  <span className="premium-event-area-type">{model.label}</span>
                  <strong>{model.eventCount}</strong>
                  <span className="premium-event-area-count">repeated event{model.eventCount === 1 ? '' : 's'}</span>
                  {isCoachVariant && <span className="premium-event-area-size">{model.areaLabel}</span>}
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
      ) : null}

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
