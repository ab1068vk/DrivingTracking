// @ts-check
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import premiumOperationalHero from '@/assets/premium-operational-model-hero-v1.png';
import premiumOperationalStrength from '@/assets/premium-operational-model-strength-v1.png';
import premiumOperationalBraking from '@/assets/premium-operational-model-braking-v1.png';
import premiumOperationalFatigue from '@/assets/premium-operational-model-fatigue-v1.png';
import premiumIconBrain from '@/assets/premium-operational-icon-brain-v1.png';
import premiumIconAggression from '@/assets/premium-operational-icon-aggression-v1.png';
import premiumIconSmoothness from '@/assets/premium-operational-icon-smoothness-v1.png';
import premiumIconEco from '@/assets/premium-operational-icon-eco-v1.png';
import premiumIconSpeed from '@/assets/premium-operational-icon-speed-v1.png';
import premiumIconConsistency from '@/assets/premium-operational-icon-consistency-v1.png';
import premiumIconBraking from '@/assets/premium-operational-icon-braking-v1.png';
import premiumIconFatigue from '@/assets/premium-operational-icon-fatigue-v1.png';
import premiumIconAcceleration from '@/assets/premium-operational-icon-acceleration-v1.png';
import premiumIconTurns from '@/assets/premium-operational-icon-turns-v1.png';
import premiumIconSpeeding from '@/assets/premium-operational-icon-speeding-v1.png';
import premiumIconPhone from '@/assets/premium-operational-icon-phone-v1.png';
import premiumStrengthMorning from '@/assets/premium-operational-strength-morning-v1.jpg';
import premiumStrengthAfternoon from '@/assets/premium-operational-strength-afternoon-v1.jpg';
import premiumStrengthNight from '@/assets/premium-operational-strength-night-v1.jpg';
import premiumStrengthLearning from '@/assets/premium-operational-strength-learning-v1.jpg';
import premiumWeaknessAcceleration from '@/assets/premium-operational-weakness-acceleration-v1.jpg';
import premiumWeaknessTurns from '@/assets/premium-operational-weakness-turns-v1.jpg';
import premiumWeaknessSpeeding from '@/assets/premium-operational-weakness-speeding-v1.jpg';
import premiumWeaknessPhone from '@/assets/premium-operational-weakness-phone-v1.jpg';
import premiumWeaknessConsistency from '@/assets/premium-operational-weakness-consistency-v1.jpg';
import './PremiumOperationalDriverModel.css';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const SIGNALS = [
  { art: premiumIconAggression, id: 'aggression', key: 'aggression', label: 'Aggression', tone: 'orange' },
  { art: premiumIconSmoothness, id: 'smoothness', key: 'smoothness', label: 'Smoothness', tone: 'cyan' },
  { art: premiumIconEco, id: 'eco', key: 'ecoMindedness', label: 'Eco', tone: 'green' },
  { art: premiumIconSpeed, id: 'speed', key: 'speedTolerance', label: 'Speed tolerance', tone: 'violet' },
  { art: premiumIconConsistency, id: 'consistency', key: 'consistencyIdx', label: 'Consistency', tone: 'blue' },
];

const STRENGTH_ART = {
  morning: premiumStrengthMorning,
  afternoon: premiumStrengthAfternoon,
  evening: premiumOperationalStrength,
  night: premiumStrengthNight,
  learning: premiumStrengthLearning,
};

const WEAKNESS_CONFIG = {
  harsh_brakes: { art: premiumOperationalBraking, iconArt: premiumIconBraking },
  rapid_accel: { art: premiumWeaknessAcceleration, iconArt: premiumIconAcceleration },
  sharp_turns: { art: premiumWeaknessTurns, iconArt: premiumIconTurns },
  speeding: { art: premiumWeaknessSpeeding, iconArt: premiumIconSpeeding },
  phone_use: { art: premiumWeaknessPhone, iconArt: premiumIconPhone },
  fatigue: { art: premiumOperationalFatigue, iconArt: premiumIconFatigue },
  consistency: { art: premiumWeaknessConsistency, iconArt: premiumIconConsistency },
};

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const titleCase = (value) => String(value || '')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

const pointAt = (radius, index, center = 150) => {
  const angle = ((index * 72) - 90) * (Math.PI / 180);
  return {
    x: center + (Math.cos(angle) * radius),
    y: center + (Math.sin(angle) * radius),
  };
};

const pointsAttribute = (values, radius = 112) => values
  .map((value, index) => {
    const point = pointAt(radius * value, index);
    return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  })
  .join(' ');

/**
 * Strictly gates the alternate rendering behind the persisted appearance flag.
 * @param {unknown} premiumVisualExperience
 */
export const shouldRenderPremiumOperationalDriverModel = (premiumVisualExperience) => (
  premiumVisualExperience === true
);

/**
 * Formats the exact values used by the standard Operational driver model card.
 * @param {{
 *  driverSignature?: Record<string, any>|null,
 *  bestTime?: Record<string, any>|null,
 *  recommendation?: Record<string, any>|null,
 *  currentFocus?: Record<string, any>|null,
 *  habitProfile?: Record<string, any>,
 * }} input
 */
export function buildPremiumOperationalDriverModel({
  driverSignature = null,
  bestTime = null,
  recommendation = null,
  currentFocus = null,
  habitProfile = {},
} = {}) {
  const isReady = Boolean(driverSignature);
  const tripCount = Math.max(0, Math.trunc(finiteNumber(driverSignature?.trip_count_used) ?? 0));
  const signals = SIGNALS.map((definition) => {
    const rawValue = finiteNumber(driverSignature?.dimensions?.[definition.key]);
    const value = rawValue == null ? null : clamp(rawValue, 0, 1);
    return {
      ...definition,
      percent: value == null ? null : Math.round(value * 100),
      plotValue: value ?? 0,
    };
  });
  const focus = recommendation?.focus || currentFocus || null;
  const focusId = recommendation?.focusId || focus?.id || 'consistency';
  const weaknessConfig = WEAKNESS_CONFIG[focusId] || WEAKNESS_CONFIG.consistency;
  const fatigueMinutesRaw = finiteNumber(habitProfile?.fatigueOnsetMinutes);
  const fatigueMinutes = fatigueMinutesRaw == null ? null : Math.max(0, Math.round(fatigueMinutesRaw));
  const strengthWindow = STRENGTH_ART[bestTime?.id] ? bestTime.id : 'learning';

  return {
    archetype: isReady ? titleCase(driverSignature?.archetype || 'balanced') : 'Building Your Personal Model',
    description: isReady
      ? `Built locally from ${tripCount} recent trip${tripCount === 1 ? '' : 's'}. Each signal below explains how it changes coaching.`
      : 'Complete at least five scored trips to unlock your driver signature.',
    fatigue: {
      art: premiumOperationalFatigue,
      detail: 'This is learned from your local multi-trip history and is not a medical fatigue measurement.',
      title: fatigueMinutes == null
        ? 'Still learning your endurance pattern'
        : `Performance change estimated near ${fatigueMinutes} minutes`,
    },
    isReady,
    radarPoints: pointsAttribute(signals.map((signal) => signal.plotValue)),
    recommendation: {
      art: weaknessConfig.art,
      detail: recommendation?.reason || currentFocus?.cue || 'Road Sage is still gathering enough evidence to name a developing weakness.',
      focusId,
      iconArt: weaknessConfig.iconArt,
      title: focus?.label || 'Consistency',
    },
    signals,
    strength: {
      art: STRENGTH_ART[strengthWindow],
      detail: bestTime
        ? `${Math.max(0, Math.trunc(finiteNumber(bestTime.trips) ?? 0))} trips average ${formatEstimatedScore(bestTime.avgScore)}. The coach uses this as a personal reference set.`
        : 'More repeated contexts are needed before naming a stable strength.',
      title: bestTime ? `${bestTime.label} driving` : 'Still calibrating',
      window: strengthWindow,
    },
    tripCount,
  };
}

function RadarPlot({ signals, points }) {
  const ringValues = [0.2, 0.4, 0.6, 0.8, 1];
  const outerPoints = Array.from({ length: 5 }, (_, index) => pointAt(112, index));

  return (
    <div className="premium-operational-radar-plot">
      <svg
        viewBox="0 0 300 300"
        role="img"
        aria-label={`Driver signal radar. ${signals.map((signal) => `${signal.label}: ${signal.percent == null ? 'learning' : `${signal.percent} percent`}`).join('. ')}.`}
      >
        <defs>
          <linearGradient id="premium-operational-radar-fill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1677ff" stopOpacity="0.5" />
            <stop offset="58%" stopColor="#208cff" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#63c8ff" stopOpacity="0.16" />
          </linearGradient>
          <filter id="premium-operational-radar-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="premium-operational-radar-grid">
          {ringValues.map((ring) => (
            <polygon
              key={ring}
              points={pointsAttribute([ring, ring, ring, ring, ring])}
            />
          ))}
          {outerPoints.map((point, index) => (
            <line key={SIGNALS[index].id} x1="150" y1="150" x2={point.x} y2={point.y} />
          ))}
        </g>
        <polygon
          className="premium-operational-radar-area"
          points={points}
          filter="url(#premium-operational-radar-glow)"
        />
        {signals.map((signal, index) => {
          const point = pointAt(112 * signal.plotValue, index);
          return (
            <circle
              key={signal.id}
              className="premium-operational-radar-point"
              cx={point.x}
              cy={point.y}
              r="4.4"
              tabIndex={0}
            >
              <title>{signal.label}: {signal.percent == null ? 'Learning' : `${signal.percent}%`}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function InsightCard({ art, eyebrow, iconArt, title, detail, tone, state }) {
  return (
    <article
      className="premium-operational-insight"
      data-tone={tone}
      data-state={state}
      aria-label={`${eyebrow}. ${title}. ${detail}`}
    >
      <img src={art} alt="" aria-hidden="true" className="premium-operational-insight-art" />
      <span className="premium-operational-insight-shade" aria-hidden="true" />
      <div className="premium-operational-insight-rail" aria-hidden="true">
        <img src={iconArt} alt="" />
      </div>
      <div className="premium-operational-insight-copy">
        <div className="premium-operational-insight-eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
    </article>
  );
}

/**
 * @param {{
 *  driverSignature?: Record<string, any>|null,
 *  bestTime?: Record<string, any>|null,
 *  recommendation?: Record<string, any>|null,
 *  currentFocus?: Record<string, any>|null,
 *  habitProfile?: Record<string, any>,
 *  loading?: boolean,
 * }} props
 */
export default function PremiumOperationalDriverModel({
  driverSignature = null,
  bestTime = null,
  recommendation = null,
  currentFocus = null,
  habitProfile = {},
  loading = false,
}) {
  const model = buildPremiumOperationalDriverModel({
    driverSignature,
    bestTime,
    recommendation,
    currentFocus,
    habitProfile,
  });

  return (
    <section
      className="premium-operational-model"
      data-ready={model.isReady}
      data-loading={loading}
      aria-labelledby="premium-operational-model-title"
    >
      <img className="premium-operational-hero" src={premiumOperationalHero} alt="" aria-hidden="true" />
      <span className="premium-operational-hero-shade" aria-hidden="true" />

      <header className="premium-operational-header">
        <div className="premium-operational-kicker">
          <img src={premiumIconBrain} alt="" aria-hidden="true" />
          Operational driver model
        </div>
        <h2 id="premium-operational-model-title">{model.archetype}</h2>
        <p>{model.description}</p>
      </header>

      {loading && !model.isReady ? (
        <div className="premium-operational-loading" role="status" aria-live="polite">
          <img src={premiumIconBrain} alt="" aria-hidden="true" />
          <div>
            <strong>Refreshing your local driver model</strong>
            <span>Comparing the latest eligible trips and coaching signals.</span>
          </div>
        </div>
      ) : model.isReady ? (
        <>
          <div className="premium-operational-radar">
            <RadarPlot signals={model.signals} points={model.radarPoints} />
            {model.signals.map((signal) => {
              return (
                <div
                  key={signal.id}
                  className={`premium-operational-signal premium-operational-signal-${signal.id}`}
                  data-tone={signal.tone}
                  title={`${signal.label}: ${signal.percent == null ? 'Learning' : `${signal.percent}%`}`}
                >
                  <img src={signal.art} alt="" aria-hidden="true" />
                  <strong>{signal.label}</strong>
                </div>
              );
            })}
          </div>

          <div className="premium-operational-insights">
            <InsightCard
              art={model.strength.art}
              detail={model.strength.detail}
              eyebrow="Stable strength"
              iconArt={premiumIconConsistency}
              state={model.strength.window}
              title={model.strength.title}
              tone="strength"
            />
            <InsightCard
              art={model.recommendation.art}
              detail={model.recommendation.detail}
              eyebrow="Developing weakness"
              iconArt={model.recommendation.iconArt}
              state={model.recommendation.focusId}
              title={model.recommendation.title}
              tone="weakness"
            />
            <InsightCard
              art={model.fatigue.art}
              detail={model.fatigue.detail}
              eyebrow="Fatigue response"
              iconArt={premiumIconFatigue}
              state="fatigue"
              title={model.fatigue.title}
              tone="fatigue"
            />
          </div>
        </>
      ) : (
        <div className="premium-operational-empty" role="status">
          <img src={premiumIconBrain} alt="" aria-hidden="true" />
          <div>
            <strong>Your driver signature is calibrating</strong>
            <p>Road Sage will reveal the five-signal model after five eligible scored trips. Your existing coaching data remains local.</p>
          </div>
          <div className="premium-operational-empty-progress" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => <i key={index} />)}
          </div>
        </div>
      )}
    </section>
  );
}
