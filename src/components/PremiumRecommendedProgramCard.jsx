// @ts-check
import {
  AlertTriangle,
  ArrowRight,
  Gauge,
  MoonStar,
  Navigation,
  PhoneOff,
  Route,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import premiumCoachBraking from '@/assets/premium-coach-harsh-brakes.webp';
import premiumCoachAcceleration from '@/assets/premium-coach-rapid-accel.webp';
import premiumCoachTurns from '@/assets/premium-coach-sharp-turns.webp';
import premiumCoachSpeeding from '@/assets/premium-coach-speeding.webp';
import premiumCoachPhone from '@/assets/premium-coach-phone-use.webp';
import premiumCoachFatigue from '@/assets/premium-coach-fatigue.webp';
import premiumCoachConsistency from '@/assets/premium-coach-consistency.webp';
import premiumCoachEvidence from '@/assets/premium-coach-evidence.webp';
import premiumCoachCueBraking from '@/assets/premium-coach-cue-harsh-brakes.webp';
import premiumCoachCueAcceleration from '@/assets/premium-coach-cue-rapid-accel.webp';
import premiumCoachCueTurns from '@/assets/premium-coach-cue-sharp-turns.webp';
import premiumCoachCueSpeeding from '@/assets/premium-coach-cue-speeding.webp';
import premiumCoachCuePhone from '@/assets/premium-coach-cue-phone-use.webp';
import premiumCoachCueFatigue from '@/assets/premium-coach-cue-fatigue.webp';
import premiumCoachCueConsistency from '@/assets/premium-coach-cue-consistency.webp';
import premiumCoachCueEvidence from '@/assets/premium-coach-cue-evidence.webp';

const FOCUS_VISUALS = Object.freeze({
  harsh_brakes: { artwork: premiumCoachBraking, cueArtwork: premiumCoachCueBraking, icon: ShieldCheck, tone: 'braking' },
  rapid_accel: { artwork: premiumCoachAcceleration, cueArtwork: premiumCoachCueAcceleration, icon: TrendingUp, tone: 'acceleration' },
  sharp_turns: { artwork: premiumCoachTurns, cueArtwork: premiumCoachCueTurns, icon: Navigation, tone: 'turns' },
  speeding: { artwork: premiumCoachSpeeding, cueArtwork: premiumCoachCueSpeeding, icon: Gauge, tone: 'speed' },
  phone_use: { artwork: premiumCoachPhone, cueArtwork: premiumCoachCuePhone, icon: PhoneOff, tone: 'attention' },
  fatigue: { artwork: premiumCoachFatigue, cueArtwork: premiumCoachCueFatigue, icon: MoonStar, tone: 'fatigue' },
  consistency: { artwork: premiumCoachConsistency, cueArtwork: premiumCoachCueConsistency, icon: Route, tone: 'consistency' },
});

const FALLBACK_VISUAL = Object.freeze({
  artwork: premiumCoachEvidence,
  cueArtwork: premiumCoachCueEvidence,
  icon: AlertTriangle,
  tone: 'evidence',
});

/**
 * Keeps the premium card's presentation derived from the same recommendation
 * object that powers the standard Coach card.
 * @param {Record<string, any> | null | undefined} recommendation
 */
export function buildPremiumCoachRecommendationViewModel(recommendation) {
  if (!recommendation?.focus) {
    return {
      ...FALLBACK_VISUAL,
      actionLabel: 'Review trip evidence',
      badgeLabel: 'Historical evidence unavailable',
      cue: 'Complete a measured trip to rebuild a trustworthy coaching baseline.',
      evidence: null,
      focusId: 'evidence',
      reason: 'Older trip records without score or event measurements are excluded. Road Sage will never turn a missing value into 0.',
      shortLabel: 'Measurements still building',
      title: 'Your trips are here, but their Coach measurements are not.',
      whyNow: null,
    };
  }

  const focusId = FOCUS_VISUALS[recommendation.focusId] ? recommendation.focusId : 'consistency';
  return {
    ...FOCUS_VISUALS[focusId],
    actionLabel: 'Build my program',
    badgeLabel: 'Recommended next program',
    cue: recommendation.focus.cue,
    evidence: recommendation.evidence || null,
    focusId,
    reason: recommendation.reason || recommendation.focus.cue,
    shortLabel: recommendation.focus.shortLabel,
    title: recommendation.focus.label,
    whyNow: recommendation.whyNow || null,
  };
}

/**
 * @param {{ recommendation?: Record<string, any> | null, onConfigure: () => void }} props
 */
export default function PremiumRecommendedProgramCard({ recommendation = null, onConfigure }) {
  const model = buildPremiumCoachRecommendationViewModel(recommendation);
  const FocusIcon = model.icon;

  return (
    <section
      className="premium-coach-card"
      data-focus={model.focusId}
      data-tone={model.tone}
      aria-labelledby="premium-coach-recommendation-title"
    >
      <div className="premium-coach-grid" aria-hidden="true" />
      <img loading="lazy" className="premium-coach-hero-art" src={model.artwork} alt="" aria-hidden="true" />

      <div className="premium-coach-badge">
        <span className="premium-coach-badge-icon" aria-hidden="true"><Sparkles /></span>
        <span>{model.badgeLabel}</span>
      </div>

      <div className="premium-coach-copy">
        <h2 id="premium-coach-recommendation-title">{model.title}</h2>
        <p className="premium-coach-reason">{model.reason}</p>
        {(model.evidence || model.whyNow) && (
          <div className="premium-coach-evidence-row" aria-label="Recommendation evidence">
            {model.evidence && <strong>{model.evidence}</strong>}
            {model.whyNow && <span>{model.whyNow}</span>}
          </div>
        )}
      </div>

      <div className="premium-coach-cue">
        <div className="premium-coach-cue-icon" aria-hidden="true"><FocusIcon /></div>
        <div className="premium-coach-cue-copy">
          <span>{model.shortLabel}</span>
          <p>{model.cue}</p>
        </div>
        <img loading="lazy" className="premium-coach-cue-art" src={model.cueArtwork} alt="" aria-hidden="true" />
      </div>

      <button type="button" onClick={onConfigure} className="premium-coach-action">
        <span className="premium-coach-action-icon" aria-hidden="true"><FocusIcon /></span>
        <span>{model.actionLabel}</span>
        <ArrowRight aria-hidden="true" />
      </button>
    </section>
  );
}
