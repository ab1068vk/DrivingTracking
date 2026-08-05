// @ts-check
import {
  CircleDashed,
  Clock3,
  Database,
  Disc3,
  Eye,
  Footprints,
  Gauge,
  GitCompareArrows,
  LockKeyhole,
  MapPin,
  Mountain,
  Navigation,
  Radar,
  RotateCcw,
  Route,
  ShieldCheck,
  Sparkles,
  Timer,
  TrendingUp,
  Wind,
} from 'lucide-react';
import { buildPremiumCoachRecommendationViewModel } from '@/components/PremiumRecommendedProgramCard';
import premiumPracticeBraking from '@/assets/premium-practice-steps-harsh-brakes.webp';
import premiumPracticeAcceleration from '@/assets/premium-practice-steps-rapid-accel.webp';
import premiumPracticeTurns from '@/assets/premium-practice-steps-sharp-turns.webp';
import premiumPracticeSpeeding from '@/assets/premium-practice-steps-speeding.webp';
import premiumPracticePhone from '@/assets/premium-practice-steps-phone-use.webp';
import premiumPracticeFatigue from '@/assets/premium-practice-steps-fatigue.webp';
import premiumPracticeConsistency from '@/assets/premium-practice-steps-consistency.webp';
import premiumPracticeEvidence from '@/assets/premium-practice-steps-evidence.webp';

const PRACTICE_VISUALS = Object.freeze({
  harsh_brakes: {
    artwork: premiumPracticeBraking,
    stepIcons: [MapPin, Footprints, Disc3],
  },
  rapid_accel: {
    artwork: premiumPracticeAcceleration,
    stepIcons: [ShieldCheck, Gauge, Wind],
  },
  sharp_turns: {
    artwork: premiumPracticeTurns,
    stepIcons: [ShieldCheck, Route, RotateCcw],
  },
  speeding: {
    artwork: premiumPracticeSpeeding,
    stepIcons: [Gauge, Mountain, Radar],
  },
  phone_use: {
    artwork: premiumPracticePhone,
    stepIcons: [Sparkles, Navigation, LockKeyhole],
  },
  fatigue: {
    artwork: premiumPracticeFatigue,
    stepIcons: [Eye, Clock3, ShieldCheck],
  },
  consistency: {
    artwork: premiumPracticeConsistency,
    stepIcons: [Clock3, Timer, GitCompareArrows],
  },
});

const EVIDENCE_VISUAL = Object.freeze({
  artwork: premiumPracticeEvidence,
  stepIcons: [CircleDashed, Database, TrendingUp],
});

/**
 * Builds a two-level instruction without relying on hard-coded plan copy.
 * The full source string is always retained for accessibility and wrapping.
 * @param {unknown} value
 */
export function splitPracticeInstruction(value) {
  const text = String(value || '').trim();
  if (!text) return { detail: '', lead: '' };

  const connective = /\s+(before|after|while|when|then|and|only as|over|for|from|without)\s+/i.exec(text);
  if (connective && connective.index >= 8) {
    return {
      lead: text.slice(0, connective.index).replace(/[,.]$/, ''),
      detail: text.slice(connective.index).replace(/^\s+/, ''),
    };
  }

  const words = text.split(/\s+/);
  if (words.length < 6) return { lead: text, detail: '' };
  const leadWordCount = Math.max(3, Math.ceil(words.length * 0.58));
  return {
    lead: words.slice(0, leadWordCount).join(' '),
    detail: words.slice(leadWordCount).join(' '),
  };
}

/**
 * @param {unknown} value
 * @param {unknown} fallback
 */
export function splitLiveCue(value, fallback = '') {
  const text = String(value || '').trim();
  const sentence = /^(.+?[.!?])(?:\s+(.+))?$/.exec(text);
  return {
    detail: sentence?.[2] || String(fallback || '').trim(),
    headline: sentence?.[1] || text || 'Coaching cue is still building.',
  };
}

/**
 * Keeps all premium presentation derived from the same live focus definition
 * and recommendation used by the standard practice-plan card.
 * @param {{ definition?: Record<string, any> | null, recommendation?: Record<string, any> | null }} input
 */
export function buildPremiumPracticePlanViewModel({
  definition = null,
  recommendation = null,
} = {}) {
  if (!definition || !recommendation) {
    const fallback = buildPremiumCoachRecommendationViewModel(null);
    return {
      ...fallback,
      empty: true,
      emptyDescription: 'Road Sage needs comparable measurements before it can make a real plan.',
      emptyMessage: 'The next newly recorded trip can qualify. Historical trips with missing Coach fields stay visible in your trip history but do not become fake zeros here.',
      heroArtwork: fallback.cueArtwork,
      liveArtwork: fallback.artwork,
      liveDetail: 'Missing historical measurements remain unavailable instead of becoming fake zeroes.',
      liveHeadline: 'A measured trip will unlock your next practice plan.',
      practiceArtwork: EVIDENCE_VISUAL.artwork,
      stepIcons: EVIDENCE_VISUAL.stepIcons,
      steps: [],
      title: 'No measured focus available',
    };
  }

  const focusId = PRACTICE_VISUALS[definition.id]
    ? definition.id
    : PRACTICE_VISUALS[recommendation.focusId]
      ? recommendation.focusId
      : 'consistency';
  const recommendationModel = buildPremiumCoachRecommendationViewModel({
    ...recommendation,
    focus: definition,
    focusId,
  });
  const liveCue = splitLiveCue(definition.liveCue, definition.cue);
  const visual = PRACTICE_VISUALS[focusId];

  return {
    ...recommendationModel,
    empty: false,
    focusId,
    heroArtwork: recommendationModel.cueArtwork,
    liveArtwork: recommendationModel.artwork,
    liveDetail: liveCue.detail,
    liveHeadline: liveCue.headline,
    practiceArtwork: visual.artwork,
    stepIcons: visual.stepIcons,
    steps: (Array.isArray(definition.drill) ? definition.drill : [])
      .map((step) => String(step || '').trim())
      .filter(Boolean),
    title: String(definition.label || recommendationModel.title),
  };
}

/**
 * @param {{ definition?: Record<string, any> | null, recommendation?: Record<string, any> | null }} props
 */
export default function PremiumPracticePlanCard({
  definition = null,
  recommendation = null,
}) {
  const model = buildPremiumPracticePlanViewModel({ definition, recommendation });
  const FocusIcon = model.icon;

  return (
    <section
      className="premium-practice-plan"
      data-focus={model.focusId}
      data-tone={model.tone}
      data-state={model.empty ? 'empty' : 'ready'}
      aria-labelledby="premium-practice-plan-title"
    >
      <div className="premium-practice-grid" aria-hidden="true" />

      <header className="premium-practice-hero">
        <img loading="lazy" src={model.heroArtwork} alt="" aria-hidden="true" />
        <div className="premium-practice-hero-shade" aria-hidden="true" />
        <div className="premium-practice-heading">
          <div className="premium-practice-brand">
            <span aria-hidden="true"><FocusIcon /></span>
            <strong>Practice plan</strong>
          </div>
          <h2 id="premium-practice-plan-title">{model.title}</h2>
          <i aria-hidden="true" />
          <p>{model.empty ? model.emptyDescription : model.cue}</p>
        </div>
      </header>

      {model.empty ? (
        <article className="premium-practice-empty" role="status">
          <span className="premium-practice-empty-icon" aria-hidden="true"><CircleDashed /></span>
          <div>
            <strong>Real evidence is still building</strong>
            <p>{model.emptyMessage}</p>
          </div>
          <span
            className="premium-practice-empty-art"
            aria-hidden="true"
            style={{ backgroundImage: `url(${model.practiceArtwork})` }}
          />
        </article>
      ) : (
        <ol className="premium-practice-steps" aria-label={`${model.title} practice steps`}>
          {model.steps.map((step, index) => {
            const StepIcon = model.stepIcons[index % model.stepIcons.length] || FocusIcon;
            const copy = splitPracticeInstruction(step);
            return (
              <li key={`${step}-${index}`} aria-label={`Step ${index + 1}: ${step}`}>
                <span className="premium-practice-step-number" aria-hidden="true">{index + 1}</span>
                <span className="premium-practice-step-icon" aria-hidden="true"><StepIcon /></span>
                <span className="premium-practice-step-copy">
                  <strong>{copy.lead}</strong>
                  {copy.detail && <span>{copy.detail}</span>}
                </span>
                <span
                  className="premium-practice-step-art"
                  aria-hidden="true"
                  style={{
                    backgroundImage: `url(${model.practiceArtwork})`,
                    backgroundPosition: `${Math.min(index, 2) * 50}% center`,
                  }}
                />
              </li>
            );
          })}
        </ol>
      )}

      <aside className="premium-practice-live" aria-label="Live coaching cue">
        <img loading="lazy" src={model.liveArtwork} alt="" aria-hidden="true" />
        <div className="premium-practice-live-shade" aria-hidden="true" />
        <span className="premium-practice-pulse" aria-hidden="true">
          <ActivityPulse />
        </span>
        <div className="premium-practice-live-copy">
          <span>Live cue</span>
          <h3>{model.liveHeadline}</h3>
          <p>{model.liveDetail}</p>
          <small>Live coaching keeps safety-critical warnings and limits habit prompts using the selected difficulty.</small>
        </div>
      </aside>
    </section>
  );
}

function ActivityPulse() {
  return (
    <svg viewBox="0 0 48 48" role="presentation">
      <path d="M4 26h9l4-9 7 18 6-25 6 16h8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" />
    </svg>
  );
}
