// @ts-check
import { LoaderCircle } from 'lucide-react';
import premiumSegmentHero from '@/assets/premium-segment-intelligence-hero-v1.webp';
import premiumSegmentEarly from '@/assets/premium-segment-intelligence-early-v1.webp';
import premiumSegmentMiddle from '@/assets/premium-segment-intelligence-middle-v1.webp';
import premiumSegmentLate from '@/assets/premium-segment-intelligence-late-v1.webp';
import premiumSegmentArrowIcon from '@/assets/premium-segment-icon-arrow-v1.webp';
import premiumSegmentCarIcon from '@/assets/premium-segment-icon-car-v1.webp';
import premiumSegmentEveningIcon from '@/assets/premium-segment-icon-evening-v1.webp';
import premiumSegmentMiddayIcon from '@/assets/premium-segment-icon-midday-v1.webp';
import premiumSegmentMorningIcon from '@/assets/premium-segment-icon-morning-v1.webp';
import premiumSegmentNetworkIcon from '@/assets/premium-segment-icon-network-v1.webp';
import premiumSegmentPinIcon from '@/assets/premium-segment-icon-pin-v1.webp';
import premiumSegmentRepeatIcon from '@/assets/premium-segment-icon-repeat-v1.webp';
import premiumSegmentShieldIcon from '@/assets/premium-segment-icon-shield-v1.webp';
import premiumSegmentTargetIcon from '@/assets/premium-segment-icon-target-v1.webp';

const SECTION_PRESENTATIONS = Object.freeze({
  early: {
    asset: premiumSegmentEarly,
    iconAsset: premiumSegmentMorningIcon,
    tone: 'early',
  },
  middle: {
    asset: premiumSegmentMiddle,
    iconAsset: premiumSegmentMiddayIcon,
    tone: 'middle',
  },
  late: {
    asset: premiumSegmentLate,
    iconAsset: premiumSegmentEveningIcon,
    tone: 'late',
  },
});

const ROUTE_ORDER = Object.freeze(['early', 'middle', 'late']);

export const shouldRenderPremiumSegmentIntelligence = (premiumVisualExperience) => (
  premiumVisualExperience === true
);

function routeTone(label = '') {
  const normalized = label.toLowerCase();
  if (normalized.includes('morning')) return 'morning';
  if (normalized.includes('evening') || normalized.includes('night')) return 'evening';
  return 'route';
}

function RouteChoiceIcon({ label = '' }) {
  const tone = routeTone(label);
  const asset = tone === 'morning'
    ? premiumSegmentMorningIcon
    : tone === 'evening'
      ? premiumSegmentEveningIcon
      : premiumSegmentRepeatIcon;

  return <img loading="lazy" className="premium-segment-icon-art" src={asset} alt="" aria-hidden="true" />;
}

/**
 * Normalizes the calculated coach segment data for a chronological route view.
 * No values are inferred; the premium surface presents the same counts and rates
 * as the standard Coaching card.
 * @param {Record<string, any>} insights
 */
export function buildPremiumSegmentViewModel(insights = {}) {
  const strongestId = insights?.strongestSection?.eventCount > 0
    ? insights.strongestSection.id
    : null;
  const sections = Array.isArray(insights?.sections) ? insights.sections : [];
  const byId = new Map(sections.map((section) => [section.id, section]));

  return {
    evidenceLevel: String(insights?.evidenceLevel || 'limited').toLowerCase(),
    locatedEvents: Math.max(0, Number(insights?.locatedEvents) || 0),
    sections: ROUTE_ORDER
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((section) => ({
        ...section,
        eventCount: Math.max(0, Number(section.eventCount) || 0),
        isStrongest: section.id === strongestId,
        repeatRate: Math.max(0, Math.min(100, Number(section.repeatRate) || 0)),
      })),
    tripCount: Math.max(0, Number(insights?.tripCount) || 0),
  };
}

function RouteTrace() {
  return (
    <svg className="premium-segment-route-trace" viewBox="0 0 132 102" aria-hidden="true">
      <path d="M18 18c36-14 83-7 89 10 5 16-33 12-52 24-19 13 7 20 27 23 17 2 29 10 28 20" />
      <circle cx="18" cy="18" r="4" />
      <image
        className="premium-segment-route-pin"
        href={premiumSegmentPinIcon}
        x="87"
        y="63"
        width="44"
        height="44"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  );
}

function EvidenceMetric({ asset, tone, value, label }) {
  return (
    <article className="premium-segment-evidence-metric" data-tone={tone} aria-label={`${value} ${label}`}>
      <span className="premium-segment-evidence-icon" aria-hidden="true">
        <img loading="lazy" className="premium-segment-icon-art" src={asset} alt="" />
      </span>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

/**
 * @param {{
 *  insights: Record<string, any>,
 *  loading?: boolean,
 *  lockedToActiveProgram?: boolean,
 *  onOpenRouteEvidence: () => void,
 *  onSelectRoute: (routeKey: string) => void,
 *  route: Record<string, any> | null,
 *  routes?: Array<Record<string, any>>,
 * }} props
 */
export default function PremiumSegmentIntelligenceCard({
  insights,
  loading = false,
  lockedToActiveProgram = false,
  onOpenRouteEvidence,
  onSelectRoute,
  route,
  routes = [],
}) {
  const model = buildPremiumSegmentViewModel(insights);
  const hasRoute = Boolean(route);
  const selectableRoutes = routes.slice(0, 5);

  return (
    <section
      className="premium-segment-intelligence"
      data-evidence={model.evidenceLevel}
      data-empty={hasRoute ? 'false' : 'true'}
      data-loading={loading ? 'true' : 'false'}
      aria-labelledby="premium-segment-title"
    >
      <div className="premium-segment-hero">
        <img loading="lazy" src={premiumSegmentHero} alt="" aria-hidden="true" />
        <div className="premium-segment-hero-shade" aria-hidden="true" />
        <div className="premium-segment-hero-copy">
          <div className="premium-segment-eyebrow">
            <img loading="lazy"
              className="premium-segment-icon-art"
              src={premiumSegmentNetworkIcon}
              alt=""
              aria-hidden="true"
            />
            <span>Segment intelligence</span>
          </div>
          <h2 id="premium-segment-title">{route?.label || 'Choose a repeated route'}</h2>
          <p>{insights?.explanation || 'Complete the same route twice to unlock section-by-section comparisons.'}</p>
          {route?.lastTripId && (
            <button type="button" onClick={onOpenRouteEvidence}>
              Open route evidence
              <img loading="lazy"
                className="premium-segment-icon-art"
                src={premiumSegmentArrowIcon}
                alt=""
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      </div>

      {selectableRoutes.length > 1 && !lockedToActiveProgram && (
        <div className="premium-segment-route-picker" aria-label="Repeated route">
          {selectableRoutes.map((candidate) => (
            <button
              key={candidate.routeKey}
              type="button"
              data-tone={routeTone(candidate.label)}
              aria-pressed={candidate.routeKey === route?.routeKey}
              onClick={() => onSelectRoute(candidate.routeKey)}
            >
              <RouteChoiceIcon label={candidate.label} />
              <span>{candidate.label}</span>
            </button>
          ))}
        </div>
      )}

      {hasRoute ? (
        <>
          <div className="premium-segment-evidence-grid" aria-label="Route evidence summary">
            <EvidenceMetric asset={premiumSegmentCarIcon} tone="drives" value={model.tripCount} label="detailed drives" />
            <EvidenceMetric asset={premiumSegmentTargetIcon} tone="events" value={model.locatedEvents} label="located events" />
            <EvidenceMetric asset={premiumSegmentShieldIcon} tone="evidence" value={model.evidenceLevel} label="evidence" />
          </div>

          <div className="premium-segment-section-list" aria-live="polite" aria-busy={loading}>
            {model.sections.map((section) => {
              const presentation = SECTION_PRESENTATIONS[section.id] || SECTION_PRESENTATIONS.middle;
              return (
                <article
                  key={section.id}
                  className="premium-segment-section-card"
                  data-tone={presentation.tone}
                  data-strongest={section.isStrongest ? 'true' : 'false'}
                  aria-label={`${section.label}: ${section.eventCount} events, repeated on ${section.repeatRate}% of detailed drives${section.isStrongest ? ', highest event count section' : ''}`}
                >
                  <div className="premium-segment-section-art">
                    <img loading="lazy" src={presentation.asset} alt="" aria-hidden="true" />
                    <span aria-hidden="true">
                      <img loading="lazy"
                        className="premium-segment-icon-art"
                        src={presentation.iconAsset}
                        alt=""
                      />
                    </span>
                  </div>
                  <div className="premium-segment-section-copy">
                    <span className="premium-segment-section-kicker">
                      {section.isStrongest ? 'Most events' : 'Route phase'}
                    </span>
                    <strong>{section.label}</strong>
                    <b>{loading ? '\u2014' : section.eventCount}</b>
                    <p>events <i aria-hidden="true">·</i> repeated on <em>{loading ? '\u2014' : `${section.repeatRate}%`}</em> of detailed drives</p>
                  </div>
                  <RouteTrace />
                </article>
              );
            })}
            {loading && (
              <div className="premium-segment-loading" role="status">
                <LoaderCircle aria-hidden="true" />
                Loading detailed route evidence
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="premium-segment-empty">
          <span aria-hidden="true">
            <img loading="lazy"
              className="premium-segment-icon-art"
              src={premiumSegmentPinIcon}
              alt=""
            />
          </span>
          <div>
            <strong>Build a route comparison</strong>
            <p>Complete the same route twice to unlock section-by-section comparisons.</p>
          </div>
        </div>
      )}
    </section>
  );
}
