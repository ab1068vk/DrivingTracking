// @ts-check
import {
  CarFront,
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  ChevronRight,
  Disc3,
  Flag,
  Gauge,
  MoonStar,
  Radar,
  Route,
  Target,
  TrendingUp,
} from 'lucide-react';
import premiumConnectedGoalsHero from '@/assets/premium-connected-goals-hero.webp';
import premiumConnectedGoalsAtlas from '@/assets/premium-connected-goals-atlas.webp';
import premiumConnectedGoalHarshBrakes from '@/assets/premium-connected-goal-harsh-brakes-v2.webp';
import premiumConnectedGoalSpeeding from '@/assets/premium-connected-goal-speeding-v2.webp';
import premiumConnectedGoalScore from '@/assets/premium-connected-goal-score-v2.webp';
import premiumConnectedGoalNightDistance from '@/assets/premium-connected-goal-night-distance-v2.webp';
import premiumConnectedGoalNightTrips from '@/assets/premium-connected-goal-night-trips-v2.webp';
import { formatDistance } from '@/lib/tripEngine';
import {
  buildPremiumWeeklyGoals,
  premiumWeeklyCardTone,
} from '@/components/PremiumWeeklyDriverGoals';

const GOAL_PRESENTATION = Object.freeze({
  harsh_brakes: {
    Icon: Disc3,
    art: 'braking',
    artwork: premiumConnectedGoalHarshBrakes,
    guidance: 'Keep at or below target',
  },
  speeding: {
    Icon: Gauge,
    art: 'speeding',
    artwork: premiumConnectedGoalSpeeding,
    guidance: 'Keep at or below target',
  },
  avg_score: {
    Icon: ChartNoAxesColumnIncreasing,
    art: 'score',
    artwork: premiumConnectedGoalScore,
    guidance: 'Reach or exceed target',
  },
  night_distance: {
    Icon: Route,
    OverlayIcon: MoonStar,
    art: 'night-distance',
    artwork: premiumConnectedGoalNightDistance,
    guidance: 'Keep at or below target',
  },
  night_trips: {
    Icon: CarFront,
    OverlayIcon: MoonStar,
    art: 'night-trips',
    artwork: premiumConnectedGoalNightTrips,
    guidance: 'Keep at or below target',
  },
});

const safeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
};

/** The card bars visualize the live metric amount, independently of evidence qualification. */
export function connectedGoalMetricProgress(goal = {}) {
  const value = safeNumber(goal.value);
  const target = safeNumber(goal.target);
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, (value / target) * 100));
}

/** @param {Record<string, any>} goal @param {string} units */
export function connectedGoalValueLabel(goal = {}, units = 'metric') {
  const value = safeNumber(goal.value);
  const target = safeNumber(goal.target);
  if (goal.id === 'night_distance' || goal.unit === 'km') {
    return `${formatDistance(value, units)} / ${formatDistance(target, units)}`;
  }
  return `${value} / ${target}${goal.direction === 'over' ? '+' : ''}`;
}

/** @param {Array<Record<string, any>>} goals @param {string} units @returns {Array<Record<string, any>>} */
export function buildPremiumConnectedGoals(goals = [], units = 'metric') {
  return buildPremiumWeeklyGoals(goals, units).map((goal) => ({
    ...goal,
    progress: connectedGoalMetricProgress(goal),
    valueLabel: connectedGoalValueLabel(goal, units),
  }));
}

/** @param {Array<Record<string, any>>} rows */
export function connectedGoalsSummary(rows = []) {
  const tone = premiumWeeklyCardTone(rows);
  const metCount = rows.filter((goal) => goal.met).length;
  const attentionCount = rows.filter((goal) => goal.tone === 'attention').length;
  const progress = rows.length
    ? Math.round(rows.reduce((sum, goal) => sum + safeNumber(goal.progress), 0) / rows.length)
    : 0;

  if (tone === 'complete') return { tone, progress: 100, label: 'All weekly goals met' };
  if (tone === 'attention') {
    return {
      tone,
      progress,
      label: `${attentionCount} ${attentionCount === 1 ? 'goal needs' : 'goals need'} focus`,
    };
  }
  if (tone === 'building') return { tone, progress, label: 'Building weekly evidence' };
  return { tone, progress, label: `${metCount} of ${rows.length} goals met` };
}

/**
 * Premium presentation for the same native details control and live goal data
 * used by the standard Coaching card.
 * @param {{ goals?: Array<Record<string, any>>, units?: string }} props
 */
export default function PremiumConnectedGoalsCard({ goals = [], units = 'metric' }) {
  const rows = buildPremiumConnectedGoals(goals, units);
  const summary = connectedGoalsSummary(rows);
  const evidence = rows.find((goal) => !goal.qualified)?.evidence;

  return (
    <details className="premium-connected-goals group" data-tone={summary.tone}>
      <summary className="premium-connected-goals-summary">
        <img loading="lazy"
          className="premium-connected-goals-hero"
          src={premiumConnectedGoalsHero}
          alt=""
          aria-hidden="true"
        />
        <span className="premium-connected-goals-veil" aria-hidden="true" />
        <span className="premium-connected-goals-copy">
          <span className="premium-connected-goals-heading-row">
            <span className="premium-connected-goals-mark" aria-hidden="true"><Flag /></span>
            <span className="premium-connected-goals-heading">
              <span className="premium-connected-goals-eyebrow">Connected goals</span>
              <span className="premium-connected-goals-title">This week</span>
            </span>
          </span>
          <span className="premium-connected-goals-rule" aria-hidden="true">
            <span style={{ width: `${summary.progress}%` }} />
          </span>
          <span className="premium-connected-goals-description">
            Open your supporting weekly goals when you want a wider progress check.
          </span>
          <span className="premium-connected-goals-chip">
            <TrendingUp aria-hidden="true" />
            <span>{summary.label}</span>
          </span>
        </span>
        <span className="premium-connected-goals-toggle" aria-hidden="true">
          <ChevronRight />
        </span>
      </summary>

      <div className="premium-connected-goals-expanded">
        {evidence && (
          <div className="premium-connected-evidence" role="status">
            <span className="premium-connected-evidence-art" aria-hidden="true">
              <img loading="lazy" src={premiumConnectedGoalsAtlas} alt="" />
            </span>
            <span className="premium-connected-evidence-icon" aria-hidden="true"><Radar /></span>
            <span>
              <strong>Building reliable evidence</strong>
              <small>
                {safeNumber(evidence.trips)}/{safeNumber(evidence.minimum_trips)} trips ·{' '}
                {formatDistance(safeNumber(evidence.distance_km), units)} /{' '}
                {formatDistance(safeNumber(evidence.minimum_distance_km), units)}
              </small>
            </span>
          </div>
        )}

        {rows.length > 0 ? (
          <div className="premium-connected-goals-grid">
            {rows.map((goal) => {
              const presentation = GOAL_PRESENTATION[goal.id] || {
                Icon: Target,
                art: 'evidence',
                artwork: premiumConnectedGoalsAtlas,
                guidance: goal.direction === 'over' ? 'Reach or exceed target' : 'Keep at or below target',
              };
              const GoalIcon = presentation.Icon;
              const OverlayIcon = 'OverlayIcon' in presentation ? presentation.OverlayIcon : null;

              return (
                <article
                  key={goal.id}
                  className="premium-connected-goal"
                  data-goal={goal.id}
                  data-tone={goal.tone}
                  aria-label={`${goal.label}: ${goal.valueLabel}. ${goal.statusLabel}`}
                >
                  <span className="premium-connected-goal-art" data-art={presentation.art} aria-hidden="true">
                    <img loading="lazy" src={presentation.artwork} alt="" />
                  </span>
                  <span className="premium-connected-goal-shade" aria-hidden="true" />
                  <span className="premium-connected-goal-head">
                    <span className="premium-connected-goal-icon" aria-hidden="true">
                      <GoalIcon />
                      {OverlayIcon && <OverlayIcon className="premium-connected-goal-overlay" />}
                    </span>
                    <span className="premium-connected-goal-state">
                      {goal.met && <CheckCircle2 aria-hidden="true" />}
                      {goal.statusLabel}
                    </span>
                  </span>
                  <span className="premium-connected-goal-copy">
                    <span>{goal.label}</span>
                    <strong>{goal.valueLabel}</strong>
                    <small>{presentation.guidance}</small>
                  </span>
                  <span
                    className="premium-connected-goal-track"
                    role="progressbar"
                    aria-label={`${goal.label} value relative to target`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(goal.progress)}
                    aria-valuetext={`${goal.valueLabel}. ${goal.statusLabel}`}
                  >
                    <span className={goal.progress <= 0 ? 'is-empty' : undefined} style={{ width: `${goal.progress}%` }} />
                  </span>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="premium-connected-goals-empty" role="status">
            Weekly goals will appear here when enough driving data is available.
          </div>
        )}
      </div>
    </details>
  );
}
