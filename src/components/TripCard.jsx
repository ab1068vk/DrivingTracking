import { motion } from 'framer-motion';
import { Clock, Gauge, Navigation, ChevronRight, ShieldAlert, Flame, Star, StickyNote, Moon } from 'lucide-react';
import { formatDistance, formatDuration, formatDate, formatTime, getScoreColor, formatSpeed } from '@/lib/gps/formatting';
import { getTripComponentScore } from '@/lib/scoring/componentScores';
import {
  buildScoreExplanation,
  getTripDisplayName,
  getTripTagOption,
  normalizeTripTags,
} from '@/lib/tripMetadata';
import { useNavigate } from 'react-router-dom';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import { hasProvisionalCalibration } from '@/lib/scoringConstants';
import { formatScoreWithProvenance, isApproximateScoreOutput, scoreEstimateProgressText } from '@/lib/scoreDisplay';

const OVERALL_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['score_overall']);
const evidenceLabel = (evidence) => `${evidence || 'unavailable'} evidence`;
const SCORE_UNAVAILABLE_MESSAGE = 'Score unavailable for this trip – re-score to update';

export default function TripCard({
  trip,
  units = 'metric',
  index = 0,
  scoreDelta = null,
  onToggleFavorite = null,
  tripCount = null,
}) {
  const navigate = useNavigate();
  const overallScore = getTripComponentScore(trip, 'overall');
  const safetyScore = getTripComponentScore(trip, 'safety');
  const phoneUsePermissionRequired = trip.phone_use_score_status === 'usage_access_required';
  const unavailableScore = overallScore.value == null;
  const { color, label: scoreLabel, bg } = unavailableScore
    ? { color: 'text-muted-foreground', label: 'Unavailable', bg: 'bg-secondary' }
    : getScoreColor(overallScore.value);
  const lowScoreConfidence = ['low', 'unavailable'].includes(overallScore.evidence);
  const tags = normalizeTripTags(trip);
  const displayTags = trip.night_driving && !tags.includes('night') ? [...tags, 'night'] : tags;
  const title = getTripDisplayName(trip);
  const estimateProgressText = !unavailableScore && isApproximateScoreOutput(trip.score_provenance)
    ? scoreEstimateProgressText(tripCount)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      onClick={() => navigate(`/trips/${trip.id}`)}
      className="bg-card border border-border rounded-2xl p-4 hover:shadow-md hover:border-primary/30 transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="w-3.5 h-3.5" />
                <span>{formatDate(trip.start_time)}</span>
                <span>-</span>
                <span>{formatTime(trip.start_time)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite?.(trip);
              }}
              title={trip.is_favorite ? 'Remove favorite' : 'Favorite trip'}
              className={`rounded-lg p-1.5 transition-colors ${
                trip.is_favorite ? 'text-amber-500' : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              <Star className={`h-4 w-4 ${trip.is_favorite ? 'fill-current' : ''}`} />
            </button>
          </div>

          {(trip.start_address || trip.end_address) && (
            <div className="flex items-center gap-1.5 mb-2 text-sm">
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-1.5 text-foreground font-medium truncate">
                  <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0" />
                  <span className="truncate">{trip.start_address || 'Start'}</span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground truncate">
                  <div className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0" />
                  <span className="truncate">{trip.end_address || 'End'}</span>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Navigation className="w-3.5 h-3.5" />
              <span className="font-medium text-foreground">{formatDistance(trip.distance_km || 0, units)}</span>
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              <span>{formatDuration(trip.duration_seconds)}</span>
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Gauge className="w-3.5 h-3.5" />
              <span>{formatSpeed(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0, units)}</span>
            </div>
            {trip.notes && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground" title={trip.notes}>
                <StickyNote className="w-3.5 h-3.5" />
                <span>Note</span>
              </div>
            )}
          </div>

          {displayTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {displayTags.map((tagId) => {
                const option = getTripTagOption(tagId);
                return (
                  <span key={tagId} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${option?.className || 'bg-secondary text-muted-foreground border-border'}`}>
                    {tagId === 'night' && <Moon className="h-3 w-3" />}
                    {option?.label || tagId}
                  </span>
                );
              })}
            </div>
          )}

          {(trip.harsh_brakes_count > 0 || trip.rapid_accel_count > 0 || trip.sharp_turns_count > 0 || trip.speeding_events_count > 0) && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {trip.harsh_brakes_count > 0 && (
                <span className="text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/40 px-1.5 py-0.5 rounded-md">
                  {trip.harsh_brakes_count} brake{trip.harsh_brakes_count > 1 ? 's' : ''}
                </span>
              )}
              {trip.rapid_accel_count > 0 && (
                <span className="text-xs bg-yellow-50 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-800/40 px-1.5 py-0.5 rounded-md">
                  {trip.rapid_accel_count} accel
                </span>
              )}
              {trip.sharp_turns_count > 0 && (
                <span className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40 px-1.5 py-0.5 rounded-md">
                  {trip.sharp_turns_count} turn{trip.sharp_turns_count > 1 ? 's' : ''}
                </span>
              )}
              {trip.speeding_events_count > 0 && (
                <span className="text-xs bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800/40 px-1.5 py-0.5 rounded-md">
                  {trip.speeding_events_count} speed
                </span>
              )}
            </div>
          )}

          {((trip.close_proximity_count ?? 0) > 0 || trip.aggressive_grade === 'aggressive') && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {(trip.close_proximity_count ?? 0) > 0 && (
                <span title={`${trip.close_proximity_count} estimated brake-turn manoeuvre alert(s)`} className="inline-flex items-center gap-1 text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/40 px-1.5 py-0.5 rounded-md">
                  <ShieldAlert className="w-3 h-3" /> {trip.close_proximity_count}
                </span>
              )}
              {trip.aggressive_grade === 'aggressive' && (
                <span title="Aggressive driving pattern" className="inline-flex items-center text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/40 px-1.5 py-0.5 rounded-md">
                  <Flame className="w-3 h-3" />
                </span>
              )}
            </div>
          )}

          {unavailableScore && (
            <div className="mt-2 text-xs font-medium text-muted-foreground">
              {SCORE_UNAVAILABLE_MESSAGE}
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div
            className={`w-12 h-12 rounded-2xl ${bg} flex items-center justify-center border`}
            title={unavailableScore ? SCORE_UNAVAILABLE_MESSAGE : lowScoreConfidence ? 'Score based on limited available evidence.' : buildScoreExplanation(trip, 'score_overall')}
          >
            <span className={`font-grotesk font-bold text-lg ${color}`}>
              {formatScoreWithProvenance(overallScore.value, trip.score_provenance)}
            </span>
          </div>
          {scoreDelta && (
            <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${
              scoreDelta.direction === 'up'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                : scoreDelta.direction === 'down'
                  ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                  : 'bg-secondary text-muted-foreground'
            }`}>
              {scoreDelta.insufficientBaseline
                ? 'Building baseline'
                : `${scoreDelta.direction === 'up' ? 'Up' : scoreDelta.direction === 'down' ? 'Down' : 'Flat'} vs last 5`}
            </span>
          )}
          <span className={`text-xs font-medium ${color}`}>{scoreLabel}</span>
          {estimateProgressText && (
            <div className="max-w-[120px] text-center text-xs leading-snug text-muted-foreground">
              {estimateProgressText}
            </div>
          )}
          {phoneUsePermissionRequired && (
            <div
              className="inline-flex max-w-[7rem] items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-300"
              title="Phone use could not be measured for this trip. Safety does not include a phone-use signal."
            >
              <span className="truncate">Safety {formatScoreWithProvenance(safetyScore.value, trip.score_provenance)}</span>
              <ShieldAlert className="h-3 w-3 flex-shrink-0" />
            </div>
          )}
          <span className="text-[10px] capitalize text-muted-foreground">{evidenceLabel(overallScore.evidence)}</span>
          {OVERALL_SCORE_IS_APPROXIMATE && overallScore.value != null && <CalibrationStatusTag />}
        </div>
      </div>

      <div className="flex justify-end mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </div>
    </motion.div>
  );
}
