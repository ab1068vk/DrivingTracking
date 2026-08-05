// @ts-check
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  MessageCircleMore,
  Route,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import {
  COACH_FEEDBACK_OPTIONS,
  COACH_FOCUS_CATALOG,
  formatCoachMetric,
} from '@/lib/coachPrograms';
import premiumPostDriveAwaiting from '@/assets/premium-post-drive-awaiting.webp';
import premiumPostDriveSuccess from '@/assets/premium-post-drive-success.webp';
import premiumPostDrivePractice from '@/assets/premium-post-drive-practice.webp';
import premiumPostDriveEvidence from '@/assets/premium-post-drive-evidence.webp';
import premiumPostDriveFeedback from '@/assets/premium-post-drive-feedback.webp';

const STATE_COPY = Object.freeze({
  awaiting: {
    description: 'Complete an eligible drive after starting the program to begin measuring progress.',
    status: null,
    title: 'Your next result will appear here',
  },
  success: {
    description: 'This result is measured against the active program target, not a generic all-time score.',
    status: 'Target reached on this drive',
    title: 'What changed on the last mission drive',
  },
  practice: {
    description: 'This result is measured against the active program target, not a generic all-time score.',
    status: 'Keep practising this focus',
    title: 'What changed on the last mission drive',
  },
});

function formatReviewDate(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Derives every premium label from the same program progress and settings used
 * by the standard Post-drive review card.
 * @param {Record<string, any> | null | undefined} progress
 * @param {Record<string, any> | null | undefined} program
 * @param {string} units
 */
export function buildPremiumPostDriveReviewViewModel(progress, program, units = 'metric') {
  const review = progress?.latestReview || null;
  const focusId = program?.focusId || progress?.focus?.id || 'consistency';
  const focus = COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency;
  const state = !review ? 'awaiting' : review.metTarget ? 'success' : 'practice';
  const copy = STATE_COPY[state];

  return {
    ...copy,
    artwork: state === 'success'
      ? premiumPostDriveSuccess
      : state === 'practice'
        ? premiumPostDrivePractice
        : premiumPostDriveAwaiting,
    dateLabel: review ? formatReviewDate(review.startTime) : null,
    distanceLabel: review ? formatDistance(review.distanceKm, units) : null,
    focusId,
    focusLabel: focus.metricLabel,
    metricLabel: review ? formatCoachMetric(review.metric, focusId) : 'Awaiting drive',
    review,
    scoreLabel: review?.score == null ? null : formatEstimatedScore(review.score),
    state,
    status: copy.status || null,
    targetLabel: program?.targetMetric == null
      ? 'Unavailable'
      : formatCoachMetric(program.targetMetric, focusId),
  };
}

/**
 * @param {{
 *  progress?: Record<string, any> | null,
 *  program?: Record<string, any> | null,
 *  units?: string,
 *  feedbackValue?: string | null,
 *  feedbackBusy?: boolean,
 *  onReviewTrip: () => void,
 *  onFeedback: (verdict: string) => void,
 * }} props
 */
export default function PremiumPostDriveReviewCard({
  progress = null,
  program = null,
  units = 'metric',
  feedbackValue = null,
  feedbackBusy = false,
  onReviewTrip,
  onFeedback,
}) {
  const model = buildPremiumPostDriveReviewViewModel(progress, program, units);
  const StatusIcon = model.state === 'success' ? CheckCircle2 : AlertTriangle;

  return (
    <section
      className="premium-post-drive-card"
      data-state={model.state}
      data-focus={model.focusId}
      aria-labelledby="premium-post-drive-title"
    >
      <div className="premium-post-drive-grid" aria-hidden="true" />
      <img loading="lazy" className="premium-post-drive-hero" src={model.artwork} alt="" aria-hidden="true" />

      <header className="premium-post-drive-header">
        <div className="premium-post-drive-kicker">
          <span aria-hidden="true"><Activity /></span>
          Post-drive review
        </div>
        <h2 id="premium-post-drive-title">{model.title}</h2>
        <p>{model.description}</p>
      </header>

      {model.state === 'awaiting' ? (
        <div className="premium-post-drive-awaiting">
          <div className="premium-post-drive-awaiting-icon" aria-hidden="true"><ClipboardCheck /></div>
          <div>
            <strong>Measured after your next eligible drive</strong>
            <p>The coach will show the exact trip metric, whether it met the target, and a direct link to review detected events.</p>
          </div>
          <img loading="lazy" src={premiumPostDriveEvidence} alt="" aria-hidden="true" />
        </div>
      ) : (
        <div className="premium-post-drive-content">
          <div className="premium-post-drive-status">
            <span aria-hidden="true"><StatusIcon /></span>
            <strong>{model.status}</strong>
          </div>

          <div className="premium-post-drive-metrics">
            <article data-metric="result" aria-label={`Mission metric: ${model.metricLabel}`}>
              <span className="premium-post-drive-metric-icon" aria-hidden="true"><Activity /></span>
              <div>
                <strong>{model.metricLabel}</strong>
                <span>Mission metric</span>
                <small>{model.focusLabel}</small>
              </div>
            </article>
            <article data-metric="target" aria-label={`Program target: ${model.targetLabel}`}>
              <span className="premium-post-drive-metric-icon" aria-hidden="true"><Target /></span>
              <div>
                <strong>{model.targetLabel}</strong>
                <span>Program target</span>
                <small>{model.state === 'success' ? 'Reached on this drive' : 'Keep this target in view'}</small>
              </div>
            </article>
          </div>

          <div className="premium-post-drive-trip-meta" aria-label="Reviewed trip details">
            <span><Route aria-hidden="true" /> {model.dateLabel}</span>
            <span>{model.distanceLabel}</span>
            {model.scoreLabel && <span>Score {model.scoreLabel}</span>}
          </div>

          <button
            type="button"
            onClick={onReviewTrip}
            disabled={!model.review?.tripId}
            className="premium-post-drive-evidence"
          >
            <img loading="lazy" src={premiumPostDriveEvidence} alt="" aria-hidden="true" />
            <span className="premium-post-drive-action-icon" aria-hidden="true"><ShieldCheck /></span>
            <span>
              <small>Detected events and route context</small>
              <strong>Review trip evidence</strong>
            </span>
            <ArrowRight aria-hidden="true" />
          </button>

          <div className="premium-post-drive-feedback">
            <img loading="lazy" src={premiumPostDriveFeedback} alt="" aria-hidden="true" />
            <div className="premium-post-drive-feedback-title">
              <span aria-hidden="true"><MessageCircleMore /></span>
              <div>
                <strong>Was this coaching useful?</strong>
                <small>This rates the coaching, not your driving.</small>
              </div>
            </div>
            <div className="premium-post-drive-feedback-options">
              {Object.values(COACH_FEEDBACK_OPTIONS).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={feedbackBusy}
                  aria-pressed={feedbackValue === option.id}
                  onClick={() => onFeedback(option.id)}
                >
                  {feedbackValue === option.id && <Check aria-hidden="true" />}
                  {option.label}
                </button>
              ))}
            </div>
            <p>Incorrect detections remain reviewable in Trip Detail.</p>
          </div>
        </div>
      )}

      <div className="premium-post-drive-road-mark" aria-hidden="true"><span /><Route /><span /></div>
    </section>
  );
}
