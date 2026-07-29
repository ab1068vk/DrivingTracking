// @ts-check
import { Activity, CalendarClock, Route, TrendingUp } from 'lucide-react';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { formatDistanceScope } from '@/lib/unitFormatting';
import premiumFleetAction from '@/assets/premium-fleet-action.webp';
import premiumFleetBusiest from '@/assets/premium-fleet-busiest.webp';
import premiumFleetScore from '@/assets/premium-fleet-score.webp';

const clampScore = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null;
};

const scoreTone = (score) => {
  if (score == null) return 'learning';
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'strong';
  if (score >= 50) return 'developing';
  return 'attention';
};

const FLEET_GAUGE_SEGMENT_COUNT = 18;
const FLEET_GAUGE_START_DEGREES = 135;
const FLEET_GAUGE_SWEEP_DEGREES = 270;

const polarPoint = (radius, degrees) => {
  const radians = degrees * Math.PI / 180;
  return {
    x: 80 + radius * Math.cos(radians),
    y: 80 + radius * Math.sin(radians),
  };
};

const describeGaugeArc = (radius, startDegrees, endDegrees) => {
  const start = polarPoint(radius, startDegrees);
  const end = polarPoint(radius, endDegrees);
  const largeArc = endDegrees - startDegrees > 180 ? 1 : 0;
  return [
    `M ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
  ].join(' ');
};

const FLEET_GAUGE_SEGMENTS = Array.from({ length: FLEET_GAUGE_SEGMENT_COUNT }, (_, index) => {
  const segmentSweep = FLEET_GAUGE_SWEEP_DEGREES / FLEET_GAUGE_SEGMENT_COUNT;
  const startDegrees = FLEET_GAUGE_START_DEGREES + index * segmentSweep + 1.35;
  const endDegrees = FLEET_GAUGE_START_DEGREES + (index + 1) * segmentSweep - 1.35;
  return {
    body: describeGaugeArc(58, startDegrees, endDegrees),
    innerEdge: describeGaugeArc(49, startDegrees, endDegrees),
    outerEdge: describeGaugeArc(67, startDegrees, endDegrees),
  };
});

/**
 * Builds every premium label and gauge value from the same live fleet summary
 * consumed by the standard Vehicles UI.
 * @param {Record<string, any>} intelligence
 * @param {{ highConfidenceAssignmentCount?: number, units?: string }} options
 */
export function buildPremiumFleetIntelligenceViewModel(
  intelligence = {},
  { highConfidenceAssignmentCount = 0, units = 'metric' } = {},
) {
  const busiest = intelligence?.busiestVehicle || null;
  const best = intelligence?.bestScoreVehicle || null;
  const score = clampScore(best?.score);
  const assignmentReviewCount = Math.max(0, Number(intelligence?.assignmentReviewCount) || 0);
  const serviceDueCount = Math.max(0, Number(intelligence?.serviceDueCount) || 0);
  const suggestionCount = Math.max(0, Number(highConfidenceAssignmentCount) || 0);

  let actionTitle = 'Vehicle data is current';
  let actionDetail = 'New trips will keep the fleet profile fresh.';
  let actionTone = 'current';

  if (suggestionCount > 0) {
    actionTitle = 'Confirm suggested vehicles';
    actionDetail = `${suggestionCount} high-confidence suggestion${suggestionCount === 1 ? ' is' : 's are'} ready.`;
    actionTone = 'assignment';
  } else if (assignmentReviewCount > 0) {
    actionTitle = 'Review vehicle assignments';
    actionDetail = 'Confirmed assignment data unlocks better costs, CO2, odometer, and maintenance.';
    actionTone = 'assignment';
  } else if (serviceDueCount > 0) {
    actionTitle = 'Review service reminders';
    actionDetail = 'Mark completed service to keep forecasts accurate.';
    actionTone = 'service';
  }

  return {
    actionDetail,
    actionTitle,
    actionTone,
    bestDetail: best
      ? `${formatEstimatedScore(score)} aggregate evidence`
      : 'Assign vehicles to compare real driving behavior',
    bestName: best?.vehicle?.name || 'Not enough scored trips',
    busiestDetail: busiest
      ? `${formatDistanceScope(busiest.distanceKm, units)} across ${busiest.trips} trip${busiest.trips === 1 ? '' : 's'}`
      : 'Complete trips to build a vehicle profile',
    busiestName: busiest?.vehicle?.name || 'No trip data yet',
    score,
    scoreDegrees: Math.round((score || 0) * 27) / 10,
    scoreLabel: score == null ? '—' : String(Math.round(score)),
    scoreTone: scoreTone(score),
  };
}

/**
 * @param {{
 *   intelligence: Record<string, any>,
 *   highConfidenceAssignmentCount?: number,
 *   units?: string
 * }} props
 */
export default function PremiumFleetIntelligenceCard({
  intelligence,
  highConfidenceAssignmentCount = 0,
  units = 'metric',
}) {
  const model = buildPremiumFleetIntelligenceViewModel(intelligence, {
    highConfidenceAssignmentCount,
    units,
  });
  const activeGaugeSegments = model.score == null
    ? 0
    : Math.round((model.score / 100) * FLEET_GAUGE_SEGMENT_COUNT);
  const exactGaugeArc = model.score > 0
    ? describeGaugeArc(
        45,
        FLEET_GAUGE_START_DEGREES,
        FLEET_GAUGE_START_DEGREES + model.scoreDegrees,
      )
    : null;

  return (
    <section className="premium-fleet-card" aria-labelledby="premium-fleet-title">
      <div className="premium-fleet-heading">
        <div className="premium-fleet-heading-icon" aria-hidden="true"><TrendingUp /></div>
        <div>
          <h2 id="premium-fleet-title">Fleet intelligence</h2>
          <p>Live insights to optimize your fleet performance</p>
        </div>
      </div>

      <div className="premium-fleet-grid">
        <article
          className="premium-fleet-insight premium-fleet-busiest"
          aria-label={`Busiest vehicle: ${model.busiestName}. ${model.busiestDetail}`}
        >
          <img src={premiumFleetBusiest} alt="" aria-hidden="true" className="premium-fleet-art" />
          <div className="premium-fleet-insight-icon" aria-hidden="true"><Route /></div>
          <div className="premium-fleet-copy">
            <span>Busiest vehicle</span>
            <strong>{model.busiestName}</strong>
            <small>{model.busiestDetail}</small>
          </div>
        </article>

        <article
          className="premium-fleet-insight premium-fleet-score"
          data-score-tone={model.scoreTone}
          aria-label={`Best scoring vehicle: ${model.bestName}. ${model.bestDetail}`}
        >
          <img src={premiumFleetScore} alt="" aria-hidden="true" className="premium-fleet-art" />
          <div className="premium-fleet-insight-icon" aria-hidden="true"><Activity /></div>
          <div className="premium-fleet-copy">
            <span>Best scoring vehicle</span>
            <strong>{model.bestName}</strong>
            <small>{model.bestDetail}</small>
          </div>
          <div
            className="premium-fleet-score-gauge"
            data-state={model.score == null ? 'learning' : 'ready'}
            role="img"
            aria-label={model.score == null
              ? 'Fleet score is still building'
              : `Approximate fleet score ${model.scoreLabel} out of 100`}
            style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({
              '--fleet-score-degrees': `${model.scoreDegrees}deg`,
            })}
          >
            <svg
              className="premium-fleet-score-instrument"
              viewBox="0 0 160 160"
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                <linearGradient id="fleet-score-segment-face" x1="30" y1="24" x2="126" y2="136" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#8ffffa" />
                  <stop offset="0.28" stopColor="#14d9d4" />
                  <stop offset="0.62" stopColor="#078c91" />
                  <stop offset="0.82" stopColor="#034d59" />
                  <stop offset="1" stopColor="#0bbfc1" />
                </linearGradient>
                <radialGradient id="fleet-score-center-well" cx="0" cy="0" r="1" gradientTransform="translate(67 61) rotate(52) scale(66)">
                  <stop offset="0" stopColor="#12323a" stopOpacity="0.94" />
                  <stop offset="0.48" stopColor="#071821" stopOpacity="0.98" />
                  <stop offset="1" stopColor="#02090f" />
                </radialGradient>
                <filter id="fleet-score-segment-depth" x="-35%" y="-35%" width="170%" height="180%">
                  <feDropShadow dx="0" dy="-1" stdDeviation="0.7" floodColor="#a5ffff" floodOpacity="0.58" />
                  <feDropShadow dx="0" dy="3" stdDeviation="2.4" floodColor="#001b24" floodOpacity="0.92" />
                  <feDropShadow dx="0" dy="0" stdDeviation="3.2" floodColor="#00ddd9" floodOpacity="0.34" />
                </filter>
              </defs>

              <g className="premium-fleet-score-track">
                {FLEET_GAUGE_SEGMENTS.map((segment, index) => (
                  <path key={`track-${index}`} d={segment.body} />
                ))}
              </g>

              <g
                className="premium-fleet-score-segment-backs"
                filter="url(#fleet-score-segment-depth)"
              >
                {FLEET_GAUGE_SEGMENTS.slice(0, activeGaugeSegments).map((segment, index) => (
                  <path key={`back-${index}`} d={segment.body} />
                ))}
              </g>
              <g className="premium-fleet-score-segment-faces">
                {FLEET_GAUGE_SEGMENTS.slice(0, activeGaugeSegments).map((segment, index) => (
                  <path key={`face-${index}`} d={segment.body} />
                ))}
              </g>
              <g className="premium-fleet-score-rim premium-fleet-score-rim-outer">
                {FLEET_GAUGE_SEGMENTS.slice(0, activeGaugeSegments).map((segment, index) => (
                  <path key={`outer-${index}`} d={segment.outerEdge} />
                ))}
              </g>
              <g className="premium-fleet-score-rim premium-fleet-score-rim-inner">
                {FLEET_GAUGE_SEGMENTS.slice(0, activeGaugeSegments).map((segment, index) => (
                  <path key={`inner-${index}`} d={segment.innerEdge} />
                ))}
              </g>

              <circle className="premium-fleet-score-well-rim" cx="80" cy="80" r="45" />
              <circle className="premium-fleet-score-well" cx="80" cy="80" r="41" />
              <circle className="premium-fleet-score-well-detail" cx="80" cy="80" r="34" />
              {exactGaugeArc && (
                <path className="premium-fleet-score-exact-arc" d={exactGaugeArc} />
              )}
            </svg>
            <div>
              <strong>{model.scoreLabel}</strong>
              <span>{model.score == null ? 'Building' : 'Score'}</span>
            </div>
          </div>
        </article>

        <article
          className="premium-fleet-insight premium-fleet-action"
          data-action-tone={model.actionTone}
          aria-label={`Next action: ${model.actionTitle}. ${model.actionDetail}`}
        >
          <img src={premiumFleetAction} alt="" aria-hidden="true" className="premium-fleet-art" />
          <div className="premium-fleet-insight-icon" aria-hidden="true"><CalendarClock /></div>
          <div className="premium-fleet-copy">
            <span>Next action</span>
            <strong>{model.actionTitle}</strong>
            <small>{model.actionDetail}</small>
          </div>
        </article>
      </div>
    </section>
  );
}
