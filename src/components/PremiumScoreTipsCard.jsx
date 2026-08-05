import { Gauge, ShieldCheck, Sparkles } from 'lucide-react';
import premiumScoreTipAcceleration from '@/assets/premium-score-tip-acceleration.webp';
import premiumScoreTipBraking from '@/assets/premium-score-tip-braking.webp';
import premiumScoreTipCornering from '@/assets/premium-score-tip-cornering.webp';
import premiumScoreTipEvidence from '@/assets/premium-score-tip-evidence.webp';
import premiumScoreTipExcellent from '@/assets/premium-score-tip-excellent.webp';
import premiumScoreTipFocus from '@/assets/premium-score-tip-focus.webp';
import premiumScoreTipNight from '@/assets/premium-score-tip-night.webp';
import premiumScoreTipSpeeding from '@/assets/premium-score-tip-speeding.webp';

const TIP_PRESENTATIONS = [
  {
    id: 'braking',
    match: 'Most score loss is coming from harsh braking.',
    label: 'Braking pattern',
    emphasis: 'lift off earlier',
    artwork: premiumScoreTipBraking,
  },
  {
    id: 'acceleration',
    match: 'Rapid acceleration is your biggest pattern.',
    label: 'Throttle control',
    emphasis: 'smoother throttle starts',
    artwork: premiumScoreTipAcceleration,
  },
  {
    id: 'cornering',
    match: 'Sharp turns are showing up most often.',
    label: 'Cornering line',
    emphasis: 'accelerate after the car is straight',
    artwork: premiumScoreTipCornering,
  },
  {
    id: 'speeding',
    match: 'Speeding is your main risk event.',
    label: 'Speed awareness',
    emphasis: 'fastest way',
    artwork: premiumScoreTipSpeeding,
  },
  {
    id: 'night',
    match: 'A large share of trips happen at night',
    label: 'Night exposure',
    emphasis: 'Keep routes familiar',
    artwork: premiumScoreTipNight,
  },
  {
    id: 'excellent',
    match: 'Your recent average is excellent.',
    label: 'Strong momentum',
    emphasis: 'Keep the streak going',
    artwork: premiumScoreTipExcellent,
  },
  {
    id: 'focus',
    match: 'Focus on one behavior this week',
    label: 'Weekly focus',
    emphasis: 'move the score fastest',
    artwork: premiumScoreTipFocus,
  },
  {
    id: 'evidence',
    match: 'Record a few trips to unlock personalized coaching tips.',
    label: 'Building evidence',
    emphasis: 'personalized coaching tips',
    artwork: premiumScoreTipEvidence,
  },
  {
    id: 'evidence',
    match: 'Complete a trip of at least 2 km for coaching tips.',
    label: 'Building evidence',
    emphasis: 'at least 2 km',
    artwork: premiumScoreTipEvidence,
  },
];

const FALLBACK_PRESENTATION = {
  id: 'evidence',
  label: 'Driver insight',
  emphasis: '',
  artwork: premiumScoreTipEvidence,
};

function splitTip(tip) {
  const firstStop = tip.indexOf('.');
  if (firstStop < 0 || firstStop === tip.length - 1) {
    return { headline: tip, detail: '' };
  }
  return {
    headline: tip.slice(0, firstStop + 1),
    detail: tip.slice(firstStop + 1).trim(),
  };
}

/**
 * Maps the existing rules-based tip copy to presentation only. Score-tip
 * calculations and eligibility remain owned by buildScoreTips.
 * @param {string} tip
 */
export function buildPremiumScoreTipViewModel(tip) {
  const normalizedTip = typeof tip === 'string' ? tip.trim() : '';
  const presentation = TIP_PRESENTATIONS.find((item) => normalizedTip.includes(item.match))
    || FALLBACK_PRESENTATION;
  const { headline, detail } = splitTip(normalizedTip);

  return {
    ...presentation,
    detail,
    headline,
    tip: normalizedTip,
  };
}

function HighlightedDetail({ detail, emphasis }) {
  if (!detail) return null;
  const index = emphasis ? detail.toLocaleLowerCase().indexOf(emphasis.toLocaleLowerCase()) : -1;
  if (index < 0) return <p>{detail}</p>;

  return (
    <p>
      {detail.slice(0, index)}
      <strong>{detail.slice(index, index + emphasis.length)}</strong>
      {detail.slice(index + emphasis.length)}
    </p>
  );
}

/** @param {{ tips?: string[], isLoading?: boolean }} props */
export default function PremiumScoreTipsCard({ tips = [], isLoading = false }) {
  const models = tips.map(buildPremiumScoreTipViewModel);

  return (
    <section className="premium-score-tips" aria-labelledby="premium-score-tips-title" aria-busy={isLoading || undefined}>
      <div className="premium-score-tips-ambient" aria-hidden="true" />
      <header className="premium-score-tips-header">
        <div className="premium-score-tips-mark" aria-hidden="true">
          <ShieldCheck />
        </div>
        <div className="premium-score-tips-heading">
          <span><Sparkles /> Driver intelligence</span>
          <h2 id="premium-score-tips-title">Score Tips</h2>
          <p>Smart driving. Higher score.</p>
        </div>
        <Gauge className="premium-score-tips-gauge" aria-hidden="true" />
      </header>

      <div className="premium-score-tips-list">
        {isLoading ? (
          <div className="premium-score-tip-skeleton" aria-label="Loading personalized score tips">
            <span />
            <div><span /><span /><span /></div>
          </div>
        ) : models.length > 0 ? models.map((model, index) => (
          <article
            key={`${model.id}-${model.tip}`}
            className="premium-score-tip"
            data-tone={model.id}
            aria-label={model.tip}
          >
            <div className="premium-score-tip-art-shell" aria-hidden="true">
              <span className="premium-score-tip-art-orbit" />
              <img loading="lazy" src={model.artwork} alt="" />
            </div>
            <div className="premium-score-tip-divider" aria-hidden="true" />
            <div className="premium-score-tip-copy">
              <span className="premium-score-tip-label">{String(index + 1).padStart(2, '0')} · {model.label}</span>
              <h3>{model.headline}</h3>
              <HighlightedDetail detail={model.detail} emphasis={model.emphasis} />
            </div>
          </article>
        )) : (
          <div className="premium-score-tip-empty">
            <img loading="lazy" src={premiumScoreTipEvidence} alt="" aria-hidden="true" />
            <div>
              <strong>No coaching priority surfaced</strong>
              <span>Your next eligible trip will refresh these personalized tips.</span>
            </div>
          </div>
        )}
      </div>

      <div className="premium-score-tips-road" aria-hidden="true"><span /><span /><span /></div>
    </section>
  );
}
