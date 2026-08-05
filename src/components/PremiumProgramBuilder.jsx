// @ts-check
import {
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  Target,
} from 'lucide-react';
import premiumProgramBraking from '@/assets/premium-program-builder-braking.webp';
import premiumProgramAcceleration from '@/assets/premium-program-builder-acceleration-v2.webp';
import premiumProgramTurns from '@/assets/premium-program-builder-turns-v2.webp';
import premiumProgramSpeed from '@/assets/premium-program-builder-speed.webp';
import premiumProgramAttention from '@/assets/premium-program-builder-attention.webp';
import premiumProgramFatigue from '@/assets/premium-program-builder-fatigue-v2.webp';
import premiumProgramConsistency from '@/assets/premium-program-builder-consistency.webp';
import premiumProgramIconBraking from '@/assets/premium-program-builder-icon-braking.webp';
import premiumProgramIconAcceleration from '@/assets/premium-program-builder-icon-acceleration-v2.webp';
import premiumProgramIconTurns from '@/assets/premium-program-builder-icon-turns-v2.webp';
import premiumProgramIconSpeed from '@/assets/premium-program-builder-icon-speed.webp';
import premiumProgramIconAttention from '@/assets/premium-program-builder-icon-attention.webp';
import premiumProgramIconFatigue from '@/assets/premium-program-builder-icon-fatigue-v2.webp';
import premiumProgramIconConsistency from '@/assets/premium-program-builder-icon-consistency.webp';

const PROGRAM_VISUALS = Object.freeze({
  harsh_brakes: { artwork: premiumProgramBraking, iconArtwork: premiumProgramIconBraking, tone: 'braking' },
  rapid_accel: { artwork: premiumProgramAcceleration, iconArtwork: premiumProgramIconAcceleration, tone: 'acceleration' },
  sharp_turns: { artwork: premiumProgramTurns, iconArtwork: premiumProgramIconTurns, tone: 'turns' },
  speeding: { artwork: premiumProgramSpeed, iconArtwork: premiumProgramIconSpeed, tone: 'speed' },
  phone_use: { artwork: premiumProgramAttention, iconArtwork: premiumProgramIconAttention, tone: 'attention' },
  fatigue: { artwork: premiumProgramFatigue, iconArtwork: premiumProgramIconFatigue, tone: 'fatigue' },
  consistency: { artwork: premiumProgramConsistency, iconArtwork: premiumProgramIconConsistency, tone: 'consistency' },
});

const FALLBACK_VISUAL = PROGRAM_VISUALS.consistency;

/**
 * Keeps the premium selector driven by the exact recommendation objects used
 * by the standard Program tab.
 * @param {Array<Record<string, any>>} recommendations
 * @param {string} selectedFocus
 */
export function buildPremiumProgramOptions(recommendations = [], selectedFocus = '') {
  return (Array.isArray(recommendations) ? recommendations : []).map((recommendation, index) => {
    const focusId = String(recommendation?.focusId || '');
    const visual = PROGRAM_VISUALS[focusId] || FALLBACK_VISUAL;
    const rawPriority = String(recommendation?.priority || 'low').toLowerCase();
    const priority = ['high', 'medium', 'low'].includes(rawPriority) ? rawPriority : 'low';

    return {
      ...visual,
      evidence: recommendation?.evidence || null,
      focusId,
      label: recommendation?.focus?.label || 'Measured driving focus',
      priority,
      priorityLabel: index === 0 ? 'Recommended' : priority,
      reason: recommendation?.reason || recommendation?.focus?.cue || '',
      selected: selectedFocus === focusId,
      whyNow: recommendation?.whyNow || null,
    };
  });
}

/**
 * @param {{
 *   activeProgram?: Record<string, any> | null,
 *   recommendations?: Array<Record<string, any>>,
 *   selectedFocus?: string,
 *   onSelect: (focusId: string) => void,
 * }} props
 */
export default function PremiumProgramBuilder({
  activeProgram = null,
  recommendations = [],
  selectedFocus = '',
  onSelect,
}) {
  const options = buildPremiumProgramOptions(recommendations, selectedFocus);

  return (
    <section
      className="premium-program-builder"
      data-empty={options.length === 0 ? 'true' : 'false'}
      aria-labelledby="premium-program-builder-title"
    >
      <header className="premium-program-builder-header">
        <div className="premium-program-builder-eyebrow">
          <Target aria-hidden="true" />
          <span>{activeProgram ? 'Change program' : 'Build a program'}</span>
        </div>
        <h2 id="premium-program-builder-title">Choose one habit to practise</h2>
        <p>Road Sage recommends the highest-value focus, but you remain in control. Starting a new program archives the current one.</p>
      </header>

      {options.length > 0 ? (
        <div className="premium-program-builder-list" aria-label="Coaching focus options">
          {options.map((option) => {
            return (
              <button
                key={option.focusId}
                type="button"
                aria-pressed={option.selected}
                className="premium-program-option"
                data-priority={option.priorityLabel.toLowerCase()}
                data-selected={option.selected ? 'true' : 'false'}
                data-tone={option.tone}
                onClick={() => onSelect(option.focusId)}
              >
                <img loading="lazy" className="premium-program-option-art" src={option.artwork} alt="" aria-hidden="true" />
                <span className="premium-program-option-shade" aria-hidden="true" />
                <img loading="lazy" className="premium-program-option-icon" src={option.iconArtwork} alt="" aria-hidden="true" />

                <span className="premium-program-option-copy">
                  <span className="premium-program-option-priority">{option.priorityLabel}</span>
                  <strong>{option.label}</strong>
                  <span className="premium-program-option-reason">{option.reason}</span>
                  {option.evidence && (
                    <span className="premium-program-option-evidence">
                      <ChartNoAxesColumnIncreasing aria-hidden="true" />
                      {option.evidence}
                    </span>
                  )}
                  {option.whyNow && (
                    <span className="premium-program-option-why">
                      <b>Why now:</b> {option.whyNow}
                    </span>
                  )}
                </span>

                {option.selected && (
                  <span className="premium-program-option-check" aria-hidden="true">
                    <CheckCircle2 />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="premium-program-builder-empty">
          No focus is recommended yet because fewer than two trips contain a comparable measurement. Complete a newly measured drive; old missing fields will remain excluded.
        </div>
      )}
    </section>
  );
}
