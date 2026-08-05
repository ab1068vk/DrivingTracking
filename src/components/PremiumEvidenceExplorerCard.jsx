// @ts-check
import {
  Activity,
  Gauge,
  ShieldCheck,
} from 'lucide-react';
import { formatPerDistanceRate } from '@/lib/unitFormatting';
import premiumEvidenceBrakeTurn from '@/assets/premium-evidence-brake-turn.webp';
import premiumEvidenceErraticSpeed from '@/assets/premium-evidence-erratic-speed.webp';
import premiumEvidenceHarshBrakes from '@/assets/premium-evidence-harsh-brakes.webp';
import premiumEvidenceHeadingDeviations from '@/assets/premium-evidence-heading-deviations.webp';
import premiumEvidenceRapidAccel from '@/assets/premium-evidence-rapid-accel.webp';
import premiumEvidenceSharpTurns from '@/assets/premium-evidence-sharp-turns.webp';
import premiumEvidenceSpeeding from '@/assets/premium-evidence-speeding.webp';
import premiumEvidenceStopStart from '@/assets/premium-evidence-stop-start.webp';

const EVIDENCE_STYLES = Object.freeze({
  harsh_brakes: { tone: 'danger', artwork: premiumEvidenceHarshBrakes },
  rapid_accel: { tone: 'amber', artwork: premiumEvidenceRapidAccel },
  sharp_turns: { tone: 'violet', artwork: premiumEvidenceSharpTurns },
  speeding: { tone: 'blue', artwork: premiumEvidenceSpeeding },
  heading_deviations: { tone: 'teal', artwork: premiumEvidenceHeadingDeviations },
  stop_start_patterns: { tone: 'magenta', artwork: premiumEvidenceStopStart },
  erratic_speed: { tone: 'orange', artwork: premiumEvidenceErraticSpeed },
  brake_turn_alerts: { tone: 'rose', artwork: premiumEvidenceBrakeTurn },
});

const FALLBACK_STYLE = Object.freeze({ tone: 'blue', artwork: premiumEvidenceSpeeding });

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function clampPercent(value) {
  return Math.min(100, Math.round(finiteNonNegative(value)));
}

/**
 * Creates the plotted evidence pulse from the same live count and share shown
 * in each row. It is a compact signal-density motif, not a chronological trend.
 * @param {number} share
 * @param {number} count
 */
export function buildEvidencePulsePath(share, count) {
  const normalizedShare = clampPercent(share) / 100;
  const normalizedCount = Math.min(1, finiteNonNegative(count) / 12);
  const amplitude = 4 + (normalizedShare * 10);
  const countLift = normalizedCount * 5;
  const points = [0, 0.72, 0.2, 0.9, 0.38, 0.78, 0.5, 1];

  return points.map((phase, index) => {
    const x = Math.round((index / (points.length - 1)) * 88);
    const y = Math.round(26 - (phase * amplitude) - (index === points.length - 1 ? countLift : 0));
    return `${index === 0 ? 'M' : 'L'}${x} ${Math.max(3, Math.min(27, y))}`;
  }).join(' ');
}

/**
 * @param {Array<Record<string, any>>} patterns
 * @param {string} units
 */
export function buildPremiumEvidenceExplorerModel(patterns = [], units = 'metric') {
  return (Array.isArray(patterns) ? patterns : []).slice(0, 4).map((pattern, index) => {
    const style = EVIDENCE_STYLES[pattern?.key] || FALLBACK_STYLE;
    const count = finiteNonNegative(pattern?.count);
    const share = clampPercent(pattern?.share_percent);
    const rawRate = Number(pattern?.events_per_100km);
    const rate = formatPerDistanceRate(
      pattern?.events_per_100km == null || !Number.isFinite(rawRate) || rawRate < 0 ? null : rawRate,
      units,
      { empty: 'Unavailable' },
    );

    return {
      artwork: style.artwork,
      count,
      id: String(pattern?.key || `pattern-${index}`),
      label: String(pattern?.label || 'Recorded risk pattern'),
      pulsePath: buildEvidencePulsePath(share, count),
      rate,
      share,
      tone: style.tone,
    };
  });
}

/**
 * @param {{ patterns?: Array<Record<string, any>>, units?: string }} props
 */
export default function PremiumEvidenceExplorerCard({ patterns = [], units = 'metric' }) {
  const rows = buildPremiumEvidenceExplorerModel(patterns, units);

  return (
    <section className="premium-evidence-explorer" aria-labelledby="premium-evidence-explorer-title">
      <div className="premium-evidence-ambient" aria-hidden="true" />
      <header className="premium-evidence-heading">
        <div className="premium-evidence-kicker"><Gauge /> Evidence explorer</div>
        <h2 id="premium-evidence-explorer-title">What is driving the recommendation</h2>
      </header>

      {rows.length > 0 ? (
        <div className="premium-evidence-list">
          {rows.map((row) => (
            <article
              key={row.id}
              className="premium-evidence-pattern"
              data-tone={row.tone}
              aria-label={`${row.label}: ${row.rate}; ${row.share}% of recorded risk events; ${row.count} recorded events`}
            >
              <span className="premium-evidence-rail" aria-hidden="true" />
              <div className="premium-evidence-art" aria-hidden="true">
                <img loading="lazy" src={row.artwork} alt="" />
              </div>

              <div className="premium-evidence-copy">
                <h3>{row.label}</h3>
                <strong>{row.rate}</strong>
                <p><b>{row.share}%</b> of recorded risk events</p>
              </div>

              <div className="premium-evidence-viz">
                <div
                  className="premium-evidence-ring"
                  style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({
                    '--evidence-share': `${row.share}%`,
                  })}
                  role="img"
                  aria-label={`${row.share}% contribution`}
                >
                  <span>{row.share}%</span>
                </div>
                <svg viewBox="0 0 92 30" role="img" aria-label={`Evidence pulse based on ${row.count} recorded events`}>
                  <path className="premium-evidence-pulse-shadow" d={row.pulsePath} />
                  <path d={row.pulsePath} />
                  <circle cx="88" cy={Number(row.pulsePath.split(' ').at(-1)) || 10} r="2.8" />
                </svg>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="premium-evidence-empty" role="status">
          <span aria-hidden="true"><Activity /></span>
          <div>
            <strong>Evidence is still building</strong>
            <p>No dominant risk event is currently strong enough to display.</p>
          </div>
        </div>
      )}

      <footer className="premium-evidence-note">
        <span aria-hidden="true"><ShieldCheck /></span>
        <p>These insights are based on recorded risk events and help prioritize areas with the greatest impact.</p>
      </footer>

    </section>
  );
}
