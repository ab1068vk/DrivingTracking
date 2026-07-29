// @ts-check
import { Target } from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import premiumWeeklyGoalsHero from '@/assets/premium-weekly-goals-hero-v3.jpg';
import premiumWeeklyGoalBraking from '@/assets/premium-weekly-goal-braking-v3.jpg';
import premiumWeeklyGoalSpeeding from '@/assets/premium-weekly-goal-speeding-v3.jpg';
import premiumWeeklyGoalScore from '@/assets/premium-weekly-goal-score-v3.jpg';
import premiumWeeklyGoalNightDistance from '@/assets/premium-weekly-goal-night-distance-v3.jpg';
import premiumWeeklyGoalNightTrips from '@/assets/premium-weekly-goal-night-trips-v3.jpg';
import premiumSmoothBrakingRoad from '@/assets/premium-smooth-braking-road-v2.png';
import premiumFatigueRiskShield from '@/assets/premium-fatigue-risk-shield.png';

const GOAL_PRESENTATION = Object.freeze({
  harsh_brakes: { artwork: premiumWeeklyGoalBraking },
  speeding: { artwork: premiumWeeklyGoalSpeeding },
  avg_score: { artwork: premiumWeeklyGoalScore },
  night_distance: { artwork: premiumWeeklyGoalNightDistance },
  night_trips: { artwork: premiumWeeklyGoalNightTrips },
});

const clampPercent = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function evidenceProgress(evidence = {}) {
  const tripTarget = Math.max(1, safeNumber(evidence.minimum_trips));
  const distanceTarget = Math.max(1, safeNumber(evidence.minimum_distance_km));
  return clampPercent(Math.min(
    (safeNumber(evidence.trips) / tripTarget) * 100,
    (safeNumber(evidence.distance_km) / distanceTarget) * 100,
  ));
}

function goalProgress(goal = {}) {
  if (!goal.qualified) return evidenceProgress(goal.evidence);
  if (goal.met) return 100;
  const value = safeNumber(goal.value);
  const target = safeNumber(goal.target);
  if (goal.direction === 'under') {
    return target > 0 ? clampPercent(Math.min(99, (target / Math.max(target, value)) * 100)) : 0;
  }
  return target > 0 ? clampPercent(Math.min(99, (value / target) * 100)) : 0;
}

function goalValueLabel(goal = {}, units = 'metric') {
  if (!goal.qualified && goal.evidence) {
    const evidence = goal.evidence;
    return `${safeNumber(evidence.trips)}/${safeNumber(evidence.minimum_trips)} trips · ${formatDistance(safeNumber(evidence.distance_km), units)} / ${formatDistance(safeNumber(evidence.minimum_distance_km), units)}`;
  }
  if (goal.id === 'night_distance' || goal.unit === 'km') {
    return `${formatDistance(safeNumber(goal.value), units)} / ${formatDistance(safeNumber(goal.target), units)}`;
  }
  return `${safeNumber(goal.value)}/${safeNumber(goal.target)}${goal.direction === 'over' ? '+' : ''}`;
}

/**
 * Builds premium presentation values from the same live goal objects used by
 * the standard dashboard card.
 * @param {Array<Record<string, any>>} goals
 * @param {string} units
 * @returns {Array<Record<string, any>>}
 */
export function buildPremiumWeeklyGoals(goals = [], units = 'metric') {
  return (goals || []).map((goal) => ({
    ...goal,
    progress: goalProgress(goal),
    statusLabel: !goal.qualified ? 'Building evidence' : goal.met ? 'Goal met' : 'Needs attention',
    tone: !goal.qualified ? 'building' : goal.met ? 'met' : 'attention',
    valueLabel: goalValueLabel(goal, units),
  }));
}

/**
 * @param {Array<Record<string, any>>} rows
 */
export function premiumWeeklyCardTone(rows = []) {
  if (rows.length > 0 && rows.every((goal) => goal.met)) return 'complete';
  if (rows.some((goal) => goal.tone === 'attention')) return 'attention';
  if (rows.some((goal) => goal.tone === 'building') || rows.length === 0) return 'building';
  return 'mixed';
}

const WEEKLY_KICKERS = Object.freeze({
  attention: 'Focus needed',
  building: 'Building evidence',
  complete: 'All goals met',
  mixed: 'Weekly focus',
});

/**
 * @param {{ goals?: Array<Record<string, any>>, units?: string }} props
 */
export function PremiumWeeklyGoalsCard({ goals = [], units = 'metric' }) {
  const rows = buildPremiumWeeklyGoals(goals, units);
  const buildingGoal = rows.find((goal) => goal.status === 'building_evidence');
  const cardTone = premiumWeeklyCardTone(rows);
  const evidenceCopy = buildingGoal
    ? `Goals activate after ${safeNumber(buildingGoal.evidence?.minimum_trips)} trips and ${formatDistance(safeNumber(buildingGoal.evidence?.minimum_distance_km), units)}. Until then, Road Sage is building evidence—not awarding easy completions.`
    : `${rows.length} live goals use this week's recorded trips and your configured targets.`;

  return (
    <section className="premium-weekly-goals-card" data-tone={cardTone} aria-labelledby="premium-weekly-goals-title">
      <div className="premium-weekly-goals-hero">
        <img src={premiumWeeklyGoalsHero} alt="" aria-hidden="true" />
        <div className="premium-weekly-goals-hero-shade" aria-hidden="true" />
        <header className="premium-weekly-goals-head">
          <div className="premium-weekly-goals-status-row">
            <div className="premium-weekly-goals-mark" aria-hidden="true"><Target /></div>
            <span>{WEEKLY_KICKERS[cardTone]}</span>
          </div>
          <h2 id="premium-weekly-goals-title">Weekly Driver Goals</h2>
          <p role={buildingGoal ? 'status' : undefined}>{evidenceCopy}</p>
        </header>
      </div>

      {rows.length === 0 ? (
        <div className="premium-weekly-goals-empty" role="status">
          Weekly goals will appear when Road Sage has trip evidence to evaluate.
        </div>
      ) : (
        <div className="premium-weekly-goal-list">
          {rows.map((goal) => {
            const presentation = GOAL_PRESENTATION[goal.id] || {};
            const roundedProgress = Math.round(goal.progress);
            return (
              <article
                key={goal.id}
                className="premium-weekly-goal"
                data-goal={goal.id}
                data-tone={goal.tone}
                aria-label={`${goal.label}: ${goal.valueLabel}. ${goal.statusLabel}`}
              >
                <div className="premium-weekly-goal-art" aria-hidden="true">
                  {presentation.artwork
                    ? <img src={presentation.artwork} alt="" />
                    : <Target />}
                </div>
                <div className="premium-weekly-goal-title">
                  <span>{goal.label}</span>
                  <small>{goal.statusLabel}</small>
                </div>
                <div className="premium-weekly-goal-body">
                  <strong>{goal.valueLabel}</strong>
                  <div
                    className="premium-weekly-goal-track"
                    role="progressbar"
                    aria-label={`${goal.label} goal progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={roundedProgress}
                    aria-valuetext={goal.statusLabel}
                  >
                    <span style={{ width: `${goal.progress}%` }} />
                  </div>
                </div>
                <div className="premium-weekly-goal-ring" aria-hidden="true">
                  <svg viewBox="0 0 48 48">
                    <circle className="premium-weekly-goal-ring-track" cx="24" cy="24" r="20" pathLength="100" />
                    <circle
                      className="premium-weekly-goal-ring-value"
                      cx="24"
                      cy="24"
                      r="20"
                      pathLength="100"
                      strokeDasharray={`${goal.progress} 100`}
                    />
                  </svg>
                  <span>{roundedProgress}%</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function fatigueTone(level) {
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  return 'low';
}

/**
 * @param {{ fatigueRisk?: Record<string, any>, noHarshBrakeStreak?: number }} props
 */
export function PremiumWeeklyInsightCards({ fatigueRisk = {}, noHarshBrakeStreak = 0 }) {
  const streak = Math.max(0, Math.trunc(safeNumber(noHarshBrakeStreak)));
  const longTripCount = Math.max(0, Math.trunc(safeNumber(fatigueRisk.long_trip_count)));
  const riskTone = fatigueTone(String(fatigueRisk.level || '').toLowerCase());
  const riskLabel = riskTone.toUpperCase();
  const longTripLabel = `${longTripCount} long ${longTripCount === 1 ? 'drive' : 'drives'} this week`;

  return (
    <section className="premium-weekly-insights" aria-label="Weekly driving insights">
      <article className="premium-weekly-insight premium-braking-streak" aria-label={`${streak} days without harsh braking`}>
        <img src={premiumSmoothBrakingRoad} alt="" aria-hidden="true" />
        <div className="premium-weekly-insight-shade" aria-hidden="true" />
        <div className="premium-weekly-insight-copy">
          <strong>{streak}</strong>
          <span>{streak === 1 ? 'Day' : 'Days'}</span>
          <p>without harsh braking</p>
        </div>
      </article>

      <article
        className="premium-weekly-insight premium-fatigue-risk"
        data-risk={riskTone}
        aria-label={`${riskLabel} estimated fatigue risk, driving-time proxy. ${longTripLabel}`}
      >
        <img src={premiumFatigueRiskShield} alt="" aria-hidden="true" />
        <div className="premium-weekly-insight-shade" aria-hidden="true" />
        <div className="premium-weekly-insight-copy">
          <strong>{riskLabel}</strong>
          <span>Estimated fatigue risk</span>
          <p>(driving-time proxy) · {longTripLabel}</p>
        </div>
      </article>
    </section>
  );
}
