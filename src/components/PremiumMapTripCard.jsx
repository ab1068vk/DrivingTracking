// @ts-check
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Map,
  Route,
  Satellite,
  TrendingUp,
} from 'lucide-react';
import premiumMapTripAmber from '@/assets/premium-map-trip-amber-v2.webp';
import premiumMapTripBlue from '@/assets/premium-map-trip-blue-v2.webp';
import premiumMapTripCyan from '@/assets/premium-map-trip-cyan-v2.webp';
import premiumMapTripEmerald from '@/assets/premium-map-trip-emerald-v2.webp';
import premiumMapTripOrange from '@/assets/premium-map-trip-orange-v2.webp';
import premiumMapTripViolet from '@/assets/premium-map-trip-violet-v2.webp';
import premiumMapTripEmblemAmber from '@/assets/premium-map-trip-emblem-amber-v2.png';
import premiumMapTripEmblemBlue from '@/assets/premium-map-trip-emblem-blue-v2.png';
import premiumMapTripEmblemCyan from '@/assets/premium-map-trip-emblem-cyan-v2.png';
import premiumMapTripEmblemEmerald from '@/assets/premium-map-trip-emblem-emerald-v2.png';
import premiumMapTripEmblemOrange from '@/assets/premium-map-trip-emblem-orange-v2.png';
import premiumMapTripEmblemViolet from '@/assets/premium-map-trip-emblem-violet-v2.png';
import { formatScoreWithProvenance } from '@/lib/scoreDisplay';
import { formatDate, formatDistance, getTripComponentScore } from '@/lib/tripEngine';
import useLocalSettings from '@/hooks/useLocalSettings';
import {
  getPremiumTripEventCount,
  getPremiumTripScorePresentation,
  getPremiumTripTimePresentation,
} from '@/lib/premiumTripPresentation';

const VISUALS = Object.freeze({
  amber: { asset: premiumMapTripAmber, emblem: premiumMapTripEmblemAmber },
  blue: { asset: premiumMapTripBlue, emblem: premiumMapTripEmblemBlue },
  cyan: { asset: premiumMapTripCyan, emblem: premiumMapTripEmblemCyan },
  emerald: { asset: premiumMapTripEmerald, emblem: premiumMapTripEmblemEmerald },
  orange: { asset: premiumMapTripOrange, emblem: premiumMapTripEmblemOrange },
  violet: { asset: premiumMapTripViolet, emblem: premiumMapTripEmblemViolet },
});

const EVIDENCE_PRESENTATION = Object.freeze({
  high: { label: 'High evidence', stateLabel: 'Strong', confidence: 100 },
  medium: { label: 'Medium evidence', stateLabel: 'Developing', confidence: 72 },
  developing: { label: 'Developing evidence', stateLabel: 'Developing', confidence: 55 },
  low: { label: 'Low evidence', stateLabel: 'Limited', confidence: 42 },
  unavailable: { label: 'Evidence unavailable', stateLabel: 'Unavailable', confidence: 14 },
});

const finiteCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
};

/**
 * @param {Record<string, any>} trip
 * @param {Record<string, any>} [nightSettings]
 */
export function buildPremiumMapTripCardModel(trip = {}, nightSettings = {}) {
  const overallScore = getTripComponentScore(trip, 'overall');
  const score = getPremiumTripScorePresentation(overallScore.value);
  const routePointCount = Array.isArray(trip.route_points) ? trip.route_points.length : null;
  const storedMapPointCount = finiteCount(trip.route_points_map_count);
  const mapPoints = routePointCount ?? storedMapPointCount;
  const recordedPoints = finiteCount(trip.route_points_raw_count) ?? mapPoints;
  const detailedEventCount = getPremiumTripEventCount(trip);
  const listedEventCount = Array.isArray(trip.driving_events) ? trip.driving_events.length : 0;
  const eventCount = Math.max(detailedEventCount, listedEventCount);
  const distanceKm = Math.max(0, Number(trip.distance_km) || 0);
  const eventDensity = distanceKm > 0 ? eventCount / distanceKm : eventCount;
  const evidenceKey = String(overallScore.evidence || 'unavailable').toLowerCase();
  const evidence = EVIDENCE_PRESENTATION[evidenceKey] || {
    label: `${evidenceKey.replace(/_/g, ' ')} evidence`,
    stateLabel: evidenceKey.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase()),
    confidence: 55,
  };
  const time = getPremiumTripTimePresentation(trip, nightSettings);

  let variant = 'cyan';
  if (time.period === 'night') variant = 'blue';
  else if (['low', 'unavailable'].includes(evidenceKey)) variant = 'violet';
  else if (['poor', 'risky'].includes(score.tone) || trip.aggressive_grade === 'aggressive' || eventDensity >= 1.5) variant = 'orange';
  else if (score.tone === 'fair' || eventCount >= 3) variant = 'amber';
  else if (score.tone === 'excellent' && eventCount <= 1) variant = 'emerald';

  return {
    asset: VISUALS[variant].asset,
    confidence: evidence.confidence,
    evidenceLabel: evidence.label,
    evidenceStateLabel: evidence.stateLabel,
    eventCount,
    emblem: VISUALS[variant].emblem,
    mapPointLabel: mapPoints == null
      ? 'Route details unavailable'
      : `${mapPoints.toLocaleString()} map/playback point${mapPoints === 1 ? '' : 's'}`,
    recordedPointLabel: recordedPoints == null
      ? 'GPS reading count unavailable'
      : `${recordedPoints.toLocaleString()} GPS reading${recordedPoints === 1 ? '' : 's'}`,
    score,
    scoreValue: formatScoreWithProvenance(overallScore.value, trip.score_provenance),
    timePeriod: time.period,
    variant,
  };
}

/**
 * Premium-only selectable trip summary for the Map page. The standard Map
 * card remains in MapScreen and is rendered unchanged when premium is off.
 * @param {{ trip: Record<string, any>, units?: string, selected?: boolean, onSelect?: ((trip: Record<string, any>) => void)|null }} props
 */
export default function PremiumMapTripCard({ trip, units = 'metric', selected = false, onSelect = null }) {
  const settings = useLocalSettings();
  const model = buildPremiumMapTripCardModel(trip, settings);
  const dateLabel = formatDate(trip.start_time);
  const scoreAria = model.score.normalizedScore == null
    ? 'score unavailable'
    : `${model.score.label.toLowerCase()} score ${model.scoreValue} out of 100`;

  return (
    <article
      className="premium-map-trip-card render-lazy"
      data-selected={selected ? 'true' : 'false'}
      data-time={model.timePeriod}
      data-variant={model.variant}
      style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({
        '--premium-map-trip-confidence': `${model.confidence}%`,
      })}
    >
      <img className="premium-map-trip-art" src={model.asset} alt="" aria-hidden="true" />
      <div className="premium-map-trip-grid" aria-hidden="true" />
      <button
        type="button"
        className="premium-map-trip-target"
        onClick={() => onSelect?.(trip)}
        aria-label={`Select trip from ${dateLabel}, ${scoreAria}, ${model.evidenceLabel.toLowerCase()}`}
        aria-pressed={selected}
      />

      <div className="premium-map-trip-content">
        <div className="premium-map-trip-emblem" aria-hidden="true">
          <img src={model.emblem} alt="" />
        </div>

        <div className="premium-map-trip-copy">
          <div className="premium-map-trip-title">
            <CalendarDays aria-hidden="true" />
            <strong>{dateLabel}</strong>
          </div>
          <div className="premium-map-trip-facts" title={`${formatDistance(trip.distance_km || 0, units)} · ${model.recordedPointLabel}`}>
            <span><Route aria-hidden="true" /> {formatDistance(trip.distance_km || 0, units)}</span>
            <i aria-hidden="true">·</i>
            <span><Satellite aria-hidden="true" /> {model.recordedPointLabel}</span>
          </div>
          <div className="premium-map-trip-facts" title={`${model.mapPointLabel} · ${model.eventCount} events`}>
            <span><Map aria-hidden="true" /> {model.mapPointLabel}</span>
            <i aria-hidden="true">·</i>
            <span data-fact="events"><AlertTriangle aria-hidden="true" /> {model.eventCount} event{model.eventCount === 1 ? '' : 's'}</span>
          </div>
        </div>

        <aside className="premium-map-trip-score" aria-label={`${scoreAria}, ${model.evidenceLabel}`}>
          <div className="premium-map-trip-score-value"><TrendingUp aria-hidden="true" /><strong>{model.scoreValue}</strong></div>
          <span>{model.evidenceStateLabel}</span>
          <div className="premium-map-trip-confidence" aria-hidden="true"><i /></div>
          <div className="premium-map-trip-evidence">
            <small>{selected ? 'On map' : 'Evidence'}</small>
            <ChevronRight aria-hidden="true" />
          </div>
        </aside>
      </div>
    </article>
  );
}
