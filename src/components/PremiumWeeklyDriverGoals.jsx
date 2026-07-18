// @ts-check
import {
  CarFront,
  ChartNoAxesColumnIncreasing,
  Disc3,
  Gauge,
  MoonStar,
  Route,
  Target,
} from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import premiumWeeklyGoalsTelemetry from '@/assets/premium-weekly-goals-telemetry.png';
import premiumSmoothBrakingRoad from '@/assets/premium-smooth-braking-road-v2.png';
import premiumFatigueRiskShield from '@/assets/premium-fatigue-risk-shield.png';

const GOAL_PRESENTATION = Object.freeze({
  harsh_brakes: { Icon: Disc3 },
  speeding: { Icon: Gauge },
  avg_score: { Icon: ChartNoAxesColumnIncreasing },
  night_distance: { Icon: Route, OverlayIcon: MoonStar },
  night_trips: { Icon: CarFront, OverlayIcon: MoonStar },
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

  return (
    <section className="premium-weekly-goals-card" data-tone={cardTone} aria-labelledby="premium-weekly-goals-title">
      <img className="premium-weekly-goals-art" src={premiumWeeklyGoalsTelemetry} alt="" aria-hidden="true" />
      <div className="premium-weekly-goals-scanline" aria-hidden="true" />

      <header className="premium-weekly-goals-head">
        <div className="premium-weekly-goals-mark" aria-hidden="true"><Target /></div>
        <div>
          <span>{WEEKLY_KICKERS[cardTone]}</span>
          <h2 id="premium-weekly-goals-title">Weekly Driver Goals</h2>
          <p>Stay consistent. Drive smarter.</p>
        </div>
      </header>

      {buildingGoal && (
        <div className="premium-weekly-evidence" role="status">
          Goals activate after {safeNumber(buildingGoal.evidence?.minimum_trips)} trips and {formatDistance(safeNumber(buildingGoal.evidence?.minimum_distance_km), units)}. Progress shows the evidence collected so far.
        </div>
      )}

      <div className="premium-weekly-goal-list">
        {rows.map((goal) => {
          const presentation = GOAL_PRESENTATION[goal.id] || { Icon: Target };
          const GoalIcon = presentation.Icon;
          const OverlayIcon = 'OverlayIcon' in presentation ? presentation.OverlayIcon : null;
          return (
            <article
              key={goal.id}
              className="premium-weekly-goal"
              data-goal={goal.id}
              data-tone={goal.tone}
              aria-label={`${goal.label}: ${goal.valueLabel}. ${goal.statusLabel}`}
            >
              <div className="premium-weekly-goal-icon" aria-hidden="true">
                <span className="premium-weekly-goal-glyph">
                  <GoalIcon className="premium-weekly-goal-glyph-main" />
                  {OverlayIcon && <OverlayIcon className="premium-weekly-goal-glyph-overlay" />}
                </span>
              </div>
              <div className="premium-weekly-goal-body">
                <div className="premium-weekly-goal-labels">
                  <span>{goal.label}</span>
                  <strong>{goal.valueLabel}</strong>
                </div>
                <div
                  className="premium-weekly-goal-track"
                  role="progressbar"
                  aria-label={`${goal.label} goal progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(goal.progress)}
                  aria-valuetext={goal.statusLabel}
                >
                  <span style={{ width: `${goal.progress}%` }} />
                </div>
              </div>
            </article>
          );
        })}
      </div>
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
