// @ts-check
import {
  AlertTriangle,
  Clock3,
  Cuboid,
  Flame,
  Gauge,
  Moon,
  Navigation,
  ShieldAlert,
  Star,
  StickyNote,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import premiumTripEmblemDawn from '@/assets/premium-trip-emblem-dawn-v2.webp';
import premiumTripEmblemDay from '@/assets/premium-trip-emblem-day-v2.webp';
import premiumTripEmblemDusk from '@/assets/premium-trip-emblem-dusk-v2.webp';
import premiumTripEmblemDuskCaution from '@/assets/premium-trip-emblem-dusk-caution-v2.webp';
import premiumTripEmblemDuskRisk from '@/assets/premium-trip-emblem-dusk-risk-v2.webp';
import premiumTripEmblemNight from '@/assets/premium-trip-emblem-night-v2.webp';
import premiumTripMorning from '@/assets/premium-trip-morning-v2.webp';
import premiumTripDay from '@/assets/premium-trip-day-v2.webp';
import premiumTripDusk from '@/assets/premium-trip-dusk-v2.webp';
import premiumTripDuskCaution from '@/assets/premium-trip-dusk-caution-v2.webp';
import premiumTripDuskRisk from '@/assets/premium-trip-dusk-risk-v2.webp';
import premiumTripNight from '@/assets/premium-trip-night-v2.webp';
import { hasProvisionalCalibration } from '@/lib/scoringConstants';
import { formatScoreWithProvenance } from '@/lib/scoreDisplay';
import {
  formatDate,
  formatDistance,
  formatDuration,
  formatSpeed,
  formatTime,
  getTripComponentScore,
} from '@/lib/tripEngine';
import {
  buildScoreExplanation,
  getTripDisplayName,
  getTripTagOption,
  normalizeTripTags,
} from '@/lib/tripMetadata';
import {
  getPremiumTripEventCount,
  getPremiumTripSceneVariant,
  getPremiumTripScorePresentation,
  getPremiumTripTimePresentation,
} from '@/lib/premiumTripPresentation';

const OVERALL_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['score_overall']);
const SCORE_UNAVAILABLE_MESSAGE = 'Score unavailable for this trip – re-score to update';

const TRIP_VISUALS = Object.freeze({
  dawn: { asset: premiumTripMorning, emblem: premiumTripEmblemDawn },
  day: { asset: premiumTripDay, emblem: premiumTripEmblemDay },
  dusk: { asset: premiumTripDusk, emblem: premiumTripEmblemDusk },
  'dusk-caution': { asset: premiumTripDuskCaution, emblem: premiumTripEmblemDuskCaution },
  'dusk-risk': { asset: premiumTripDuskRisk, emblem: premiumTripEmblemDuskRisk },
  night: { asset: premiumTripNight, emblem: premiumTripEmblemNight },
});

/**
 * Premium-only presentation of the shared trip card. It intentionally consumes
 * the same trip record, formatters, actions, units, and evidence flags as the
 * standard card.
 * @param {{
 *  trip: Record<string, any>, units?: string, compact?: boolean,
 *  scoreDelta?: Record<string, any>|null,
 *  onToggleFavorite?: ((trip: Record<string, any>) => void)|null,
 *  onIntent?: ((trip: Record<string, any>) => void)|null
 * }} props
 */
export default function PremiumTripCard({
  trip,
  units = 'metric',
  compact = false,
  scoreDelta = null,
  onToggleFavorite = null,
  onIntent = null,
}) {
  const navigate = useNavigate();
  const overallScore = getTripComponentScore(trip, 'overall');
  const safetyScore = getTripComponentScore(trip, 'safety');
  const eventCount = getPremiumTripEventCount(trip);
  const timePresentation = getPremiumTripTimePresentation(trip.start_time);
  const scorePresentation = getPremiumTripScorePresentation(overallScore.value);
  const sceneVariant = getPremiumTripSceneVariant(timePresentation.period, scorePresentation.tone, {
    eventCount,
    distanceKm: trip.distance_km,
    aggressive: trip.aggressive_grade === 'aggressive',
    proximityCount: trip.close_proximity_count,
  });
  const { asset, emblem } = TRIP_VISUALS[sceneVariant];
  const title = getTripDisplayName(trip);
  const premiumTitle = title === 'Untitled trip' ? timePresentation.label : title;
  const tags = normalizeTripTags(trip);
  const displayTags = trip.night_driving && !tags.includes('night') ? [...tags, 'night'] : tags;
  const privateTrip = trip.privacy_mode === 'summary_only';
  const routeDataExpired = Boolean(trip.route_data_expired_at);
  const replay3dAvailable = trip.route_replay_available === true && !privateTrip && !routeDataExpired;
  const speedLimitReviewRequired = trip.speed_limit_review_required === true &&
    !trip.speed_limit_review_resolved_at && Boolean(trip.id) && !privateTrip;
  const phoneUsePermissionRequired = trip.phone_use_score_status === 'usage_access_required';
  const unavailableScore = overallScore.value == null;
  const lowScoreConfidence = ['low', 'unavailable'].includes(overallScore.evidence);
  const scoreUnavailableMessage = privateTrip
    ? 'Score unavailable because this private trip saved no route data'
    : SCORE_UNAVAILABLE_MESSAGE;
  const scoreTitle = unavailableScore
    ? scoreUnavailableMessage
    : lowScoreConfidence
      ? 'Score based on limited available evidence.'
      : buildScoreExplanation(trip, 'score_overall');
  const openTrip = () => navigate(`/trips/${trip.id}`);
  const formattedScore = formatScoreWithProvenance(overallScore.value, trip.score_provenance);
  const scoreValue = OVERALL_SCORE_IS_APPROXIMATE && overallScore.value != null && !formattedScore.startsWith('~')
    ? `~${formattedScore}`
    : formattedScore;
  const roundedDelta = scoreDelta?.delta == null ? null : Math.round(Math.abs(Number(scoreDelta.delta)));
  const scoreDeltaLabel = scoreDelta?.insufficientBaseline
    ? 'Building baseline'
    : scoreDelta
      ? `${roundedDelta ?? 0} vs last ${scoreDelta.sampleCount || 5}`
      : null;

  return (
    <article
      className="premium-trip-card render-lazy"
      data-compact={compact ? 'true' : 'false'}
      data-score-tone={scorePresentation.tone}
      data-scene={sceneVariant}
      data-time={timePresentation.period}
      style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({
        '--premium-trip-score': `${scorePresentation.degrees}deg`,
        '--premium-trip-score-color': scorePresentation.hue,
      })}
    >
      <img className="premium-trip-scene" src={asset} alt="" aria-hidden="true" />
      <div className="premium-trip-grid" aria-hidden="true" />
      <button
        type="button"
        onPointerDown={() => onIntent?.(trip)}
        onMouseEnter={() => onIntent?.(trip)}
        onFocus={() => onIntent?.(trip)}
        onClick={openTrip}
        aria-label={`Open trip: ${title}`}
        className="premium-trip-open-target"
      />

      <div className="premium-trip-content">
        <header className="premium-trip-header">
          <div className="premium-trip-emblem" aria-hidden="true">
            <img src={emblem} alt="" />
          </div>

          <div className="premium-trip-heading">
            <p>{formatDate(trip.start_time)} <span aria-hidden="true">•</span> {formatTime(trip.start_time)}</p>
            <h3>{premiumTitle}</h3>
          </div>

          <div className="premium-trip-actions">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite?.(trip);
              }}
              title={trip.is_favorite ? 'Remove favorite' : 'Favorite trip'}
              aria-label={trip.is_favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
              className="premium-trip-favorite"
            >
              <Star className={trip.is_favorite ? 'fill-current' : ''} />
            </button>

            <div className="premium-trip-score-stack">
              <div
                className="premium-trip-score"
                role="img"
                aria-label={unavailableScore ? scoreUnavailableMessage : `Trip score ${scoreValue} out of 100, ${scorePresentation.label}`}
                title={scoreTitle}
              >
                <div>
                  <strong>{scoreValue}</strong>
                  <span>{scorePresentation.label}</span>
                </div>
              </div>
              {scoreDeltaLabel && (
                <span className="premium-trip-delta" data-direction={scoreDelta?.direction || 'flat'}>
                  {scoreDelta?.insufficientBaseline ? '—' : scoreDelta?.direction === 'up' ? '↑' : scoreDelta?.direction === 'down' ? '↓' : '—'} {scoreDeltaLabel}
                </span>
              )}
            </div>
          </div>
        </header>

        {(trip.start_address || trip.end_address) && (
          <div className="premium-trip-route" title={`${trip.start_address || 'Start'} to ${trip.end_address || 'End'}`}>
            <span>{trip.start_address || 'Start'}</span>
            <Navigation aria-hidden="true" />
            <span>{trip.end_address || 'End'}</span>
          </div>
        )}

        <div className="premium-trip-metrics" aria-label="Trip metrics">
          <div className="premium-trip-metric" data-metric="distance">
            <span className="premium-trip-metric-icon"><Navigation /></span>
            <span><strong>{formatDistance(trip.distance_km || 0, units)}</strong><small>Distance</small></span>
          </div>
          <div className="premium-trip-metric" data-metric="duration">
            <span className="premium-trip-metric-icon"><Clock3 /></span>
            <span><strong>{formatDuration(trip.duration_seconds)}</strong><small>Duration</small></span>
          </div>
          <div className="premium-trip-metric" data-metric="speed">
            <span className="premium-trip-metric-icon"><Gauge /></span>
            <span><strong>{formatSpeed(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0, units)}</strong><small>Avg speed</small></span>
          </div>
        </div>

        <div className="premium-trip-footer">
          <div className="premium-trip-badges">
            {eventCount > 0 && (
              <span className="premium-trip-badge" data-tone="warning"><AlertTriangle /> {eventCount} event{eventCount === 1 ? '' : 's'}</span>
            )}
            {trip.notes && <span className="premium-trip-badge"><StickyNote /> Note</span>}
            {privateTrip && <span className="premium-trip-badge"><ShieldAlert /> Private trip – summary only</span>}
            {routeDataExpired && !privateTrip && (
              <span className="premium-trip-badge" title="Raw GPS retention removed the route coordinates. The trip summary, score, distance, and duration are still saved.">
                <ShieldAlert /> Route expired – summary kept
              </span>
            )}
            {phoneUsePermissionRequired && (
              <span className="premium-trip-badge" data-tone="info" title="Phone use could not be measured for this trip. Safety does not include a phone-use signal.">
                <ShieldAlert /> Safety {formatScoreWithProvenance(safetyScore.value, trip.score_provenance)} · phone signal off
              </span>
            )}
            {(trip.close_proximity_count ?? 0) > 0 && (
              <span className="premium-trip-badge" data-tone="danger" title={`${trip.close_proximity_count} estimated brake-turn manoeuvre alert(s)`}>
                <ShieldAlert /> {trip.close_proximity_count} proximity
              </span>
            )}
            {trip.aggressive_grade === 'aggressive' && <span className="premium-trip-badge" data-tone="danger"><Flame /> Aggressive</span>}
            {unavailableScore && <span className="premium-trip-badge">{scoreUnavailableMessage}</span>}
            {trip._dpApplied && <span className="premium-trip-badge">~ Privacy-estimated near protected zones</span>}
            {displayTags.map((tagId) => {
              const option = getTripTagOption(tagId);
              return (
                <span key={tagId} className="premium-trip-badge" data-tone={tagId === 'night' ? 'night' : 'tag'}>
                  {tagId === 'night' && <Moon />}{option?.label || tagId}
                </span>
              );
            })}
          </div>

          <div className="premium-trip-buttons">
            {speedLimitReviewRequired && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(`/trips/${trip.id}?review=speed-limit-conflicts`);
                }}
                className="premium-trip-button"
                data-tone="warning"
                aria-label={`Review speed limits for ${title}`}
              >
                <AlertTriangle /> Review speed
              </button>
            )}
            {replay3dAvailable && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(`/3d-replay?tripId=${encodeURIComponent(String(trip.id))}`);
                }}
                className="premium-trip-button"
                aria-label={`Open 3D replay for ${title}`}
              >
                <Cuboid /> 3D Route
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
