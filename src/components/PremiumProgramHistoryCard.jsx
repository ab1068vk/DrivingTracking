// @ts-check
import {
  Activity,
  Gauge,
  History,
  MoonStar,
  Navigation,
  PhoneOff,
  RefreshCcw,
  Route,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import { COACH_FOCUS_CATALOG } from '@/lib/coachPrograms';
import premiumProgramHistoryHero from '@/assets/premium-program-history-hero.webp';
import premiumProgramHistoryBraking from '@/assets/premium-program-history-braking.webp';
import premiumProgramHistoryAcceleration from '@/assets/premium-program-history-acceleration.webp';
import premiumProgramHistoryTurns from '@/assets/premium-program-history-turns.webp';
import premiumProgramHistorySpeed from '@/assets/premium-program-history-speed.webp';
import premiumProgramHistoryPhone from '@/assets/premium-program-history-phone.webp';
import premiumProgramHistoryFatigue from '@/assets/premium-program-history-fatigue.webp';
import premiumProgramHistoryConsistency from '@/assets/premium-program-history-consistency.webp';

const FOCUS_VISUALS = Object.freeze({
  harsh_brakes: {
    accent: 'braking',
    artwork: premiumProgramHistoryBraking,
    icon: ShieldCheck,
  },
  rapid_accel: {
    accent: 'acceleration',
    artwork: premiumProgramHistoryAcceleration,
    icon: TrendingUp,
  },
  sharp_turns: {
    accent: 'turns',
    artwork: premiumProgramHistoryTurns,
    icon: Navigation,
  },
  speeding: {
    accent: 'speed',
    artwork: premiumProgramHistorySpeed,
    icon: Gauge,
  },
  phone_use: {
    accent: 'attention',
    artwork: premiumProgramHistoryPhone,
    icon: PhoneOff,
  },
  fatigue: {
    accent: 'fatigue',
    artwork: premiumProgramHistoryFatigue,
    icon: MoonStar,
  },
  consistency: {
    accent: 'consistency',
    artwork: premiumProgramHistoryConsistency,
    icon: Route,
  },
});

const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));

function statusLabelFor(program) {
  if (program?.result?.graduated || program?.status === 'graduated') return 'Graduated';
  if (program?.status === 'replaced') return 'Replaced';
  if (program?.status === 'completed') return 'Completed';
  return String(program?.status || 'Archived')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function improvementLabelFor(program) {
  const rawImprovement = program?.result?.improvement;
  if (rawImprovement == null || rawImprovement === '' || !Number.isFinite(Number(rawImprovement))) {
    return 'No measured change';
  }
  const improvement = Number(rawImprovement);
  const suffix = program?.result?.improvementUnit === '%' ? '%' : ' pts';
  return `${improvement > 0 ? '+' : ''}${improvement}${suffix}`;
}

/**
 * Keeps every premium label and progress indicator derived from the same local
 * program records used by the standard history card.
 * @param {Record<string, any>} program
 */
export function buildPremiumProgramHistoryItem(program = {}) {
  const focusId = FOCUS_VISUALS[program.focusId] ? program.focusId : 'consistency';
  const visual = FOCUS_VISUALS[focusId];
  const focus = COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency;
  const completedCount = Math.max(0, Number(program?.result?.completedCount) || 0);
  const targetTripCount = Math.max(1, Number(program?.targetTripCount) || 1);
  const improvement = Number(program?.result?.improvement);
  const hasImprovement = program?.result?.improvement != null
    && program?.result?.improvement !== ''
    && Number.isFinite(improvement);

  return {
    ...visual,
    completedCount,
    focusId,
    improvementLabel: improvementLabelFor(program),
    improvementTone: !hasImprovement || improvement === 0
      ? 'steady'
      : improvement > 0 ? 'improving' : 'declining',
    progressPercent: clampPercent((completedCount / targetTripCount) * 100),
    statusLabel: statusLabelFor(program),
    targetTripCount,
    title: focus.label,
  };
}

/**
 * @param {{ programs?: Array<Record<string, any>> }} props
 */
export default function PremiumProgramHistoryCard({ programs = [] }) {
  const visiblePrograms = (Array.isArray(programs) ? programs : []).slice(0, 6);

  return (
    <section className="premium-program-history" aria-labelledby="premium-program-history-title">
      <div className="premium-program-history-grid" aria-hidden="true" />
      <img loading="lazy" className="premium-program-history-hero" src={premiumProgramHistoryHero} alt="" aria-hidden="true" />

      <header className="premium-program-history-header">
        <div className="premium-program-history-eyebrow">
          <History aria-hidden="true" />
          <span>Program history</span>
        </div>
        <h2 id="premium-program-history-title">What coaching has worked</h2>
        <p>Completed and replaced programs stay local on this device.</p>
        {visiblePrograms.length > 0 && (
          <div className="premium-program-history-summary">
            <RefreshCcw aria-hidden="true" />
            {visiblePrograms.length} recent local program{visiblePrograms.length === 1 ? '' : 's'}
          </div>
        )}
      </header>

      {visiblePrograms.length === 0 ? (
        <div className="premium-program-history-empty">
          <div className="premium-program-history-empty-icon" aria-hidden="true"><History /></div>
          <div>
            <strong>Your first result will appear here</strong>
            <p>Finish your first program to build a coaching-effectiveness history.</p>
          </div>
        </div>
      ) : (
        <div className="premium-program-history-list">
          {visiblePrograms.map((program) => {
            const item = buildPremiumProgramHistoryItem(program);
            const FocusIcon = item.icon;
            const ImprovementIcon = item.improvementTone === 'improving'
              ? TrendingUp
              : item.improvementTone === 'declining' ? TrendingDown : Activity;
            const StatusIcon = item.statusLabel === 'Graduated' ? Trophy : History;

            return (
              <article
                key={program.id}
                className="premium-program-history-item"
                data-accent={item.accent}
                data-improvement={item.improvementTone}
                aria-label={`${item.title}: ${item.completedCount} of ${item.targetTripCount} drives, ${item.statusLabel}, ${item.improvementLabel}`}
              >
                <div className="premium-program-history-art" aria-hidden="true">
                  <img loading="lazy" src={item.artwork} alt="" />
                </div>

                <div className="premium-program-history-item-copy">
                  <div className="premium-program-history-item-heading">
                    <div className="premium-program-history-focus-icon" aria-hidden="true"><FocusIcon /></div>
                    <h3>{item.title}</h3>
                  </div>

                  <div className="premium-program-history-count">
                    <strong>{item.completedCount}/{item.targetTripCount}</strong>
                    <span>drives · {item.statusLabel.toLowerCase()}</span>
                  </div>

                  <div
                    className="premium-program-history-progress"
                    role="progressbar"
                    aria-label={`${item.title} program drive progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progressPercent)}
                  >
                    <span style={{ width: `${item.progressPercent}%` }} />
                  </div>

                  <div className="premium-program-history-result">
                    <span aria-hidden="true"><ImprovementIcon /></span>
                    <strong>{item.improvementLabel}</strong>
                  </div>
                </div>

                <div className="premium-program-history-status" title={item.statusLabel} aria-hidden="true">
                  <StatusIcon />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
