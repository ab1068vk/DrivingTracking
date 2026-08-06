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
 * Derives the premium presentation from the same responsiveness summary used by
 * the standard Coaching Responsiveness card.
 *
 * Accepts either the summary object from buildCoachingResponsivenessSummary or,
 * for older callers, a bare program-history array.
 * @param {Record<string, any>|Array<Record<string, any>>} [source]
 */
export function buildCoachingResponsivenessMetrics(source = {}) {
  const summary = Array.isArray(source)
    ? {
      completed: source.length,
      graduated: source.filter((program) => program?.result?.graduated).length,
      improved: source.filter((program) => Number(program?.result?.improvement) > 0).length,
      focuses: [],
      fallbackBaselineCount: 0,
      measuredCount: 0,
    }
    : (source || {});
  const completed = Number(summary.completed) || 0;
  const graduated = Number(summary.graduated) || 0;
  const improved = Number(summary.improved) || 0;
  const percentOfCompleted = (value) => completed > 0
    ? clampPercent((value / completed) * 100)
    : 0;

  return {
    completed,
    graduated,
    improved,
    measuredCount: Number(summary.measuredCount) || 0,
    fallbackBaselineCount: Number(summary.fallbackBaselineCount) || 0,
    focuses: Array.isArray(summary.focuses) ? summary.focuses : [],
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
 * @param {{ summary?: Record<string, any>, programs?: Array<Record<string, any>>, loading?: boolean }} props
 */
export default function PremiumCoachingResponsivenessCard({
  summary = null,
  programs = [],
  loading = false,
}) {
  const model = buildCoachingResponsivenessMetrics(summary || programs);
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
              <img loading="lazy" src={metric.artwork} alt="" aria-hidden="true" />
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

      {model.focuses.length > 0 && (
        <ul className="premium-coaching-responsiveness-focuses">
          {model.focuses.map((focus) => (
            <li key={focus.focusId}>
              <span>{focus.label}</span>
              <small>
                {focus.programCount} program{focus.programCount === 1 ? '' : 's'}
                {focus.graduationRate == null ? '' : ` · ${focus.graduationRate}% graduated`}
                {focus.averageImprovement == null ? '' : ` · ${focus.averageImprovement > 0 ? '+' : ''}${focus.averageImprovement} avg change`}
              </small>
            </li>
          ))}
        </ul>
      )}

      <footer className="premium-coaching-responsiveness-footer">
        <p>
          {model.measuredCount
            ? `Measured from ${model.measuredCount} completed program${model.measuredCount === 1 ? '' : 's'}. This compares your drives before and after each program with no control group, so treat it as a direction, not proof.`
            : 'Complete a program and this will show which drills and difficulty levels produce measurable changes for you.'}
          {model.fallbackBaselineCount > 0 && ` ${model.fallbackBaselineCount} program${model.fallbackBaselineCount === 1 ? '' : 's'} used an all-drives baseline for lack of comparable drives, which weakens the comparison.`}
        </p>
        <div aria-hidden="true"><ShieldCheck /></div>
      </footer>
    </section>
  );
}
