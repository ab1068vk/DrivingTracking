// @ts-check
import {
  ChartNoAxesCombined,
  ClipboardCheck,
  GraduationCap,
  ShieldCheck,
  Trophy,
} from 'lucide-react';
import programsArtwork from '@/assets/premium-coaching-responsiveness-programs.jpg';
import graduatedArtwork from '@/assets/premium-coaching-responsiveness-graduated.jpg';
import improvedArtwork from '@/assets/premium-coaching-responsiveness-improved.jpg';

const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));

/**
 * Derives the premium presentation from the same local program history used by
 * the standard Coaching Responsiveness card.
 * @param {Array<Record<string, any>>} programs
 */
export function buildCoachingResponsivenessMetrics(programs = []) {
  const safePrograms = Array.isArray(programs) ? programs : [];
  const completed = safePrograms.length;
  const graduated = safePrograms.filter((program) => program?.result?.graduated).length;
  const improved = safePrograms.filter((program) => Number(program?.result?.improvement) > 0).length;
  const percentOfCompleted = (value) => completed > 0
    ? clampPercent((value / completed) * 100)
    : 0;

  return {
    completed,
    graduated,
    improved,
    metrics: [
      {
        accent: 'programs',
        artwork: programsArtwork,
        detail: 'Completed',
        icon: ClipboardCheck,
        id: 'completed',
        label: 'Programs',
        progress: completed > 0 ? 100 : 0,
        value: completed,
      },
      {
        accent: 'graduated',
        artwork: graduatedArtwork,
        detail: 'Programs',
        icon: GraduationCap,
        id: 'graduated',
        label: 'Graduated',
        progress: percentOfCompleted(graduated),
        value: graduated,
      },
      {
        accent: 'improved',
        artwork: improvedArtwork,
        detail: 'Programs',
        icon: ChartNoAxesCombined,
        id: 'improved',
        label: 'Improved',
        progress: percentOfCompleted(improved),
        value: improved,
      },
    ],
  };
}

/**
 * @param {{ programs?: Array<Record<string, any>>, loading?: boolean }} props
 */
export default function PremiumCoachingResponsivenessCard({
  programs = [],
  loading = false,
}) {
  const model = buildCoachingResponsivenessMetrics(programs);
  const title = loading
    ? 'Loading coaching history'
    : model.completed > 0
      ? 'Your completed programs'
      : 'Complete a program to measure what works';

  return (
    <section
      className="premium-coaching-responsiveness"
      aria-labelledby="premium-coaching-responsiveness-title"
      aria-busy={loading}
    >
      <div className="premium-coaching-responsiveness-orbit" aria-hidden="true" />

      <header className="premium-coaching-responsiveness-header">
        <div className="premium-coaching-responsiveness-eyebrow">
          <Trophy aria-hidden="true" />
          <span>Coaching responsiveness</span>
        </div>
        <h2 id="premium-coaching-responsiveness-title">{title}</h2>
      </header>

      <div className="premium-coaching-responsiveness-grid">
        {model.metrics.map((metric) => {
          const MetricIcon = metric.icon;
          const displayValue = loading ? '—' : String(metric.value);
          const valueLength = displayValue.length > 4
            ? 'long'
            : displayValue.length > 2 ? 'medium' : 'short';

          return (
            <article
              key={metric.id}
              className="premium-coaching-responsiveness-metric"
              data-accent={metric.accent}
              aria-label={loading
                ? `${metric.label} programs loading`
                : `${metric.value} ${metric.label.toLowerCase()} ${metric.detail.toLowerCase()}`}
            >
              <img src={metric.artwork} alt="" aria-hidden="true" />
              <div className="premium-coaching-responsiveness-shade" aria-hidden="true" />

              <div className="premium-coaching-responsiveness-icon" aria-hidden="true">
                <MetricIcon />
              </div>

              <div className="premium-coaching-responsiveness-copy">
                <strong data-value-length={valueLength}>{displayValue}</strong>
                <span>{metric.label}</span>
                <small>{metric.detail}</small>
              </div>

              <div
                className="premium-coaching-responsiveness-progress"
                role="progressbar"
                aria-label={metric.id === 'completed'
                  ? 'Completed program history'
                  : `${metric.label} share of completed programs`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={loading ? 0 : Math.round(metric.progress)}
              >
                <span style={{ width: `${loading ? 0 : metric.progress}%` }} />
              </div>
            </article>
          );
        })}
      </div>

      <footer className="premium-coaching-responsiveness-footer">
        <p>
          Road Sage can use this history to show which drills and difficulty levels
          produce measurable changes for you.
        </p>
        <div aria-hidden="true"><ShieldCheck /></div>
      </footer>
    </section>
  );
}
