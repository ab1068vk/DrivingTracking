// @ts-check
import {
  BarChart3,
  Brain,
  Clock3,
  Disc3,
  ShieldCheck,
} from 'lucide-react';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import premiumContextHero from '@/assets/premium-personal-context-hero.webp';
import premiumContextConfidence from '@/assets/premium-personal-context-confidence.webp';
import premiumContextFatigue from '@/assets/premium-personal-context-fatigue.webp';
import premiumContextWindow from '@/assets/premium-personal-context-window.webp';
import premiumContextStreak from '@/assets/premium-personal-context-streak.webp';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const confidenceCopy = (percent) => {
  if (percent >= 80) return { detail: 'High confidence in personalized predictions', tone: 'high' };
  if (percent >= 50) return { detail: 'Profile reliability is becoming stronger', tone: 'medium' };
  if (percent > 0) return { detail: 'Calibration is still learning from your trips', tone: 'low' };
  return { detail: 'Complete scored trips to begin calibration', tone: 'learning' };
};

/**
 * Formats only the live calculations already used by the standard card.
 * @param {Record<string, any>} habitProfile
 * @param {Record<string, any>|null} bestTime
 * @param {Record<string, any>|null} weakestTime
 * @param {number} streak
 * @param {number} tripCount
 */
export function buildPremiumPersonalContextViewModel(
  habitProfile = {},
  bestTime = null,
  weakestTime = null,
  streak = 0,
  tripCount = 0,
) {
  const rawConfidence = finiteNumber(habitProfile?.confidence) ?? 0;
  const confidencePercent = Math.round(clamp(rawConfidence, 0, 1) * 100);
  const confidence = confidenceCopy(confidencePercent);
  const rawFatigueMinutes = finiteNumber(habitProfile?.fatigueOnsetMinutes);
  const fatigueMinutes = rawFatigueMinutes == null ? null : Math.max(0, Math.round(rawFatigueMinutes));
  const cleanStreak = Math.max(0, Math.trunc(finiteNumber(streak) ?? 0));
  const measuredTrips = Math.max(0, Math.trunc(finiteNumber(tripCount) ?? 0));
  const bestWindowId = ['morning', 'afternoon', 'evening', 'night'].includes(bestTime?.id)
    ? bestTime.id
    : 'learning';
  const canCompare = Boolean(
    bestTime && weakestTime &&
    bestTime.id !== weakestTime.id &&
    finiteNumber(bestTime.avgScore) != null &&
    finiteNumber(weakestTime.avgScore) != null,
  );

  let insight;
  if (canCompare) {
    insight = {
      bestScore: formatEstimatedScore(bestTime.avgScore),
      bestWindow: bestTime.label,
      kind: 'comparison',
      weakestScore: formatEstimatedScore(weakestTime.avgScore),
      weakestWindow: weakestTime.label,
    };
  } else if (bestTime && finiteNumber(bestTime.avgScore) != null) {
    insight = {
      kind: 'best-only',
      score: formatEstimatedScore(bestTime.avgScore),
      window: bestTime.label,
    };
  } else {
    insight = {
      kind: 'learning',
      text: measuredTrips > 0
        ? 'Complete at least two scored trips in a time window to unlock your comparison.'
        : 'Your time-window comparison will appear after Road Sage learns from scored trips.',
    };
  }

  return {
    bestWindowDetail: bestTime
      ? `${Math.max(0, Math.trunc(finiteNumber(bestTime.trips) ?? 0))} measured trip${Number(bestTime.trips) === 1 ? '' : 's'} in this window`
      : 'Your best performance time of day',
    bestWindowId,
    bestWindowValue: bestTime?.label || 'Learning',
    confidenceDetail: confidence.detail,
    confidencePercent,
    confidenceTone: confidence.tone,
    fatigueDetail: confidencePercent === 0
      ? 'Baseline estimate while your profile begins learning'
      : 'Estimated time before fatigue may affect driving',
    fatigueMinutes,
    insight,
    streak: cleanStreak,
    streakDetail: cleanStreak > 0
      ? 'Consecutive driving days without harsh braking'
      : 'Your next clean-braking day starts the streak',
  };
}

/**
 * @param {{
 *  habitProfile: Record<string, any>,
 *  bestTime?: Record<string, any>|null,
 *  weakestTime?: Record<string, any>|null,
 *  streak?: number,
 *  tripCount?: number,
 * }} props
 */
export default function PremiumPersonalContextCard({
  habitProfile,
  bestTime = null,
  weakestTime = null,
  streak = 0,
  tripCount = 0,
}) {
  const model = buildPremiumPersonalContextViewModel(
    habitProfile,
    bestTime,
    weakestTime,
    streak,
    tripCount,
  );
  const progressStyle = /** @type {import('react').CSSProperties & Record<string, string>} */ ({
    '--context-confidence-angle': `${model.confidencePercent * 3.6}deg`,
    '--context-progress': `${model.confidencePercent}%`,
  });

  return (
    <section className="premium-personal-context" aria-labelledby="premium-personal-context-title">
      <img loading="lazy" className="premium-personal-context-hero" src={premiumContextHero} alt="" aria-hidden="true" />
      <div className="premium-personal-context-grid" aria-hidden="true" />

      <header className="premium-personal-context-header">
        <div className="premium-personal-context-kicker"><ShieldCheck /> Drive readiness</div>
        <h2 id="premium-personal-context-title">Personal context</h2>
        <span className="premium-personal-context-rule" aria-hidden="true" />
        <p>Insights based on your driving behavior and conditions</p>
      </header>

      <div className="premium-personal-context-metrics">
        <article
          className="premium-personal-context-metric premium-personal-context-confidence"
          data-state={model.confidenceTone}
          style={progressStyle}
          aria-label={`Model confidence ${model.confidencePercent} percent. ${model.confidenceDetail}`}
        >
          <img loading="lazy" src={premiumContextConfidence} alt="" aria-hidden="true" />
          <div className="premium-personal-context-icon" aria-hidden="true"><ShieldCheck /></div>
          <div className="premium-personal-context-copy">
            <div className="premium-personal-context-value">{model.confidencePercent}%</div>
            <h3>Model Confidence</h3>
            <p>{model.confidenceDetail}</p>
          </div>
          <div
            className="premium-personal-context-progress"
            role="progressbar"
            aria-label="Model calibration confidence"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={model.confidencePercent}
          ><span /></div>
        </article>

        <article
          className="premium-personal-context-metric premium-personal-context-fatigue"
          aria-label={`Learned fatigue onset ${model.fatigueMinutes == null ? 'unavailable' : `${model.fatigueMinutes} minutes`}. ${model.fatigueDetail}`}
        >
          <img loading="lazy" src={premiumContextFatigue} alt="" aria-hidden="true" />
          <div className="premium-personal-context-icon" aria-hidden="true"><Brain /></div>
          <div className="premium-personal-context-copy">
            <div className="premium-personal-context-value">
              {model.fatigueMinutes == null ? '—' : model.fatigueMinutes}
              {model.fatigueMinutes != null && <small> min</small>}
            </div>
            <h3>Learned Fatigue Onset</h3>
            <p>{model.fatigueDetail}</p>
          </div>
        </article>

        <article
          className="premium-personal-context-metric premium-personal-context-window"
          data-window={model.bestWindowId}
          aria-label={`Strongest window ${model.bestWindowValue}. ${model.bestWindowDetail}`}
        >
          <img loading="lazy" src={premiumContextWindow} alt="" aria-hidden="true" />
          <div className="premium-personal-context-icon" aria-hidden="true"><Clock3 /></div>
          <div className="premium-personal-context-copy">
            <div className="premium-personal-context-value premium-personal-context-word">{model.bestWindowValue}</div>
            <h3>Strongest Window</h3>
            <p>{model.bestWindowDetail}</p>
          </div>
        </article>

        <article
          className="premium-personal-context-metric premium-personal-context-streak"
          aria-label={`${model.streak} day clean-braking streak. ${model.streakDetail}`}
        >
          <img loading="lazy" src={premiumContextStreak} alt="" aria-hidden="true" />
          <div className="premium-personal-context-icon" aria-hidden="true"><Disc3 /></div>
          <div className="premium-personal-context-copy">
            <div className="premium-personal-context-value">{model.streak}</div>
            <h3>Day Streak</h3>
            <p>{model.streakDetail}</p>
          </div>
        </article>
      </div>

      <div className="premium-personal-context-insight" aria-live="polite">
        <span className="premium-personal-context-insight-icon" aria-hidden="true"><BarChart3 /></span>
        {model.insight.kind === 'comparison' ? (
          <p>
            {model.insight.weakestWindow} trips average <strong>{model.insight.weakestScore}</strong>, versus{' '}
            <strong>{model.insight.bestScore}</strong> in your {model.insight.bestWindow.toLowerCase()} window.
          </p>
        ) : model.insight.kind === 'best-only' ? (
          <p>Your <strong>{model.insight.window}</strong> window currently averages <strong>{model.insight.score}</strong>.</p>
        ) : (
          <p>{model.insight.text}</p>
        )}
      </div>
    </section>
  );
}
