// @ts-check
import {
  Activity,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import DeferredRecharts from '@/components/DeferredRecharts';
import premiumDrivingScoreHero from '@/assets/premium-driving-score-hero-v2.webp';
import premiumDrivingScorePeak from '@/assets/premium-driving-score-peak-v3.webp';
import premiumDrivingScoreRange from '@/assets/premium-driving-score-range-v3.webp';
import premiumDrivingScoreTrend from '@/assets/premium-driving-score-trend-v2.webp';
import premiumTelemetryHeaderGauge from '@/assets/premium-telemetry-header-gauge-generated.webp';
import premiumTelemetryPerformanceGauge from '@/assets/premium-telemetry-performance-gauge-generated.webp';
import premiumTelemetrySliders from '@/assets/premium-telemetry-sliders-generated-v2.webp';
import premiumTelemetrySummit from '@/assets/premium-telemetry-summit-generated-v3.webp';
import premiumTelemetryTrajectory from '@/assets/premium-telemetry-trajectory-generated.webp';
import { formatEstimatedScore } from '@/lib/scoreDisplay';

function validScore(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null;
}

/**
 * @param {Array<{ i?: number, score?: number | null }>} scoreTrend
 */
export function buildPremiumDrivingScoreSummary(scoreTrend = []) {
  const chartData = (scoreTrend || []).flatMap((point, index) => {
    const score = validScore(point?.score);
    return score == null ? [] : [{
      i: Number.isFinite(Number(point?.i)) ? Number(point.i) : index,
      score,
    }];
  });
  const scores = chartData.map((point) => point.score);
  const first = scores[0] ?? null;
  const latest = scores.at(-1) ?? null;
  const peak = scores.length ? Math.max(...scores) : null;
  const low = scores.length ? Math.min(...scores) : null;
  const delta = first == null || latest == null ? null : latest - first;

  return {
    chartData,
    delta,
    latest,
    low,
    peak,
    scoredTripCount: scores.length,
  };
}

function scoreText(value) {
  return formatEstimatedScore(value, { empty: '—' });
}

function evidenceText(evidence, score) {
  if (score == null || evidence === 'unavailable') return 'Awaiting evidence';
  return {
    high: 'Strong evidence',
    developing: 'Limited evidence',
    low: 'Low evidence',
  }[evidence || 'low'] || 'Low evidence';
}

function deltaPresentation(delta, scoredTripCount) {
  if (scoredTripCount === 0) return { Icon: Activity, label: 'Awaiting scored trips', tone: 'neutral' };
  if (scoredTripCount === 1 || delta == null) return { Icon: Activity, label: 'First score recorded', tone: 'neutral' };
  if (Math.abs(delta) < 0.5) return { Icon: Minus, label: 'Holding steady', tone: 'steady' };
  if (delta > 0) return { Icon: TrendingUp, label: `Up ${formatEstimatedScore(Math.abs(delta))}`, tone: 'improving' };
  return { Icon: TrendingDown, label: `Down ${formatEstimatedScore(Math.abs(delta))}`, tone: 'declining' };
}

function PerformanceGaugeIcon({ alertAccent = false }) {
  return (
    <img loading="lazy"
      className="premium-telemetry-icon premium-telemetry-icon-gauge"
      src={alertAccent ? premiumTelemetryHeaderGauge : premiumTelemetryPerformanceGauge}
      alt=""
      aria-hidden="true"
      data-telemetry-icon={alertAccent ? 'performance-gauge-alert' : 'performance-gauge'}
    />
  );
}

function TrajectoryRouteIcon() {
  return (
    <img loading="lazy"
      className="premium-telemetry-icon premium-telemetry-icon-route"
      src={premiumTelemetryTrajectory}
      alt=""
      aria-hidden="true"
      data-telemetry-icon="trajectory-route"
    />
  );
}

function SummitFlagIcon() {
  return (
    <img loading="lazy"
      className="premium-telemetry-icon premium-telemetry-icon-summit"
      src={premiumTelemetrySummit}
      alt=""
      aria-hidden="true"
      data-telemetry-icon="summit-flag"
    />
  );
}

function RangeSlidersIcon() {
  return (
    <img loading="lazy"
      className="premium-telemetry-icon premium-telemetry-icon-sliders"
      src={premiumTelemetrySliders}
      alt=""
      aria-hidden="true"
      data-telemetry-icon="range-sliders"
    />
  );
}

function PremiumScoreGauge({ score, evidence }) {
  const normalizedScore = validScore(score);
  const valueText = scoreText(normalizedScore);
  const evidenceLabel = evidenceText(evidence, normalizedScore);

  return (
    <div className="premium-driving-score-gauge-shell">
      <div
        className="premium-driving-score-gauge"
        aria-label={`Average driving score: ${valueText} out of 100. ${evidenceLabel}.`}
      >
        <svg viewBox="0 0 120 120" role="img" aria-hidden="true">
          <defs>
            <linearGradient id="premium-score-ring-gradient" x1="18" y1="96" x2="103" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#087d70" />
              <stop offset="30%" stopColor="#0fae98" />
              <stop offset="58%" stopColor="#20c9b3" />
              <stop offset="80%" stopColor="#69e5d1" />
              <stop offset="100%" stopColor="#13a993" />
            </linearGradient>
            <linearGradient id="premium-score-track-gradient" x1="15" y1="102" x2="101" y2="18" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#031d23" />
              <stop offset="48%" stopColor="#04312f" />
              <stop offset="100%" stopColor="#075044" />
            </linearGradient>
            <linearGradient id="premium-score-rim-gradient" x1="14" y1="14" x2="107" y2="107" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#a7c4c7" stopOpacity="0.82" />
              <stop offset="33%" stopColor="#315a61" stopOpacity="0.54" />
              <stop offset="70%" stopColor="#102f38" stopOpacity="0.78" />
              <stop offset="100%" stopColor="#78979b" stopOpacity="0.72" />
            </linearGradient>
          </defs>
          <circle className="premium-driving-score-gauge-outer-rim" cx="60" cy="60" r="58" />
          <circle className="premium-driving-score-gauge-rim-inset" cx="60" cy="60" r="55.5" />
          <circle className="premium-driving-score-gauge-track" cx="60" cy="60" r="48" pathLength="100" />
          {normalizedScore != null && (
            <>
              <circle
                className="premium-driving-score-gauge-value-glow"
                cx="60"
                cy="60"
                r="48"
                pathLength="100"
                strokeDasharray={`${normalizedScore} ${100 - normalizedScore}`}
              />
              <circle
                className="premium-driving-score-gauge-value"
                cx="60"
                cy="60"
                r="48"
                pathLength="100"
                strokeDasharray={`${normalizedScore} ${100 - normalizedScore}`}
              />
            </>
          )}
          <circle className="premium-driving-score-gauge-inner-rim" cx="60" cy="60" r="40.25" />
          <circle
            className="premium-driving-score-gauge-sheen"
            cx="60"
            cy="60"
            r="56.5"
            pathLength="100"
          />
        </svg>
        <div className="premium-driving-score-gauge-value-copy">
          <strong>{valueText}</strong>
          <span>/100</span>
          <small>average</small>
        </div>
      </div>
      <div className="premium-driving-score-evidence" data-evidence={evidence || 'low'}>
        <ShieldCheck aria-hidden="true" />
        <span>{evidenceLabel}</span>
      </div>
    </div>
  );
}

/**
 * @param {{
 *  avgScore?: number | null,
 *  evidence?: string | null,
 *  scoreTrend?: Array<{ i?: number, score?: number | null }>,
 *  tripCount?: number,
 *  isLoading?: boolean,
 *  showApproximateTag?: boolean,
 * }} props
 */
export default function PremiumDrivingScoreCard({
  avgScore = null,
  evidence = null,
  scoreTrend = [],
  tripCount = 0,
  isLoading = false,
  showApproximateTag = false,
}) {
  const normalizedAverage = validScore(avgScore);
  const summary = buildPremiumDrivingScoreSummary(scoreTrend);
  const delta = deltaPresentation(summary.delta, summary.scoredTripCount);
  const DeltaIcon = delta.Icon;
  const visibleTripCount = Math.min(10, Math.max(0, Number(tripCount) || 0));
  const rangeText = summary.low == null || summary.peak == null
    ? '—'
    : summary.low === summary.peak
      ? scoreText(summary.low)
      : `~${Math.round(summary.low)}–${Math.round(summary.peak)}`;

  return (
    <section className="premium-driving-score" aria-labelledby="premium-driving-score-title">
      <img loading="lazy" className="premium-driving-score-hero-art" src={premiumDrivingScoreHero} alt="" aria-hidden="true" />

      <header className="premium-driving-score-head">
        <div className="premium-driving-score-brand">
          <span className="premium-driving-score-brand-icon" aria-hidden="true">
            <PerformanceGaugeIcon alertAccent />
          </span>
          <span className="premium-driving-score-brand-copy">
            <small>Performance</small>
            <strong>Telemetry</strong>
          </span>
        </div>

        <div className="premium-driving-score-title-row">
          <h2 id="premium-driving-score-title">Driving Score</h2>
          {showApproximateTag && <CalibrationStatusTag />}
        </div>
        <p>Last {visibleTripCount} trips</p>
      </header>

      {isLoading ? (
        <div className="premium-driving-score-loading" role="status" aria-live="polite">
          <span />
          <strong>Loading driving score</strong>
          <small>Preparing your recent performance telemetry</small>
        </div>
      ) : (
        <>
          <article className="premium-driving-score-overview">
            <PremiumScoreGauge score={normalizedAverage} evidence={evidence} />
            <div className="premium-driving-score-overview-copy">
              <div className="premium-driving-score-section-label">
                <PerformanceGaugeIcon />
                <span>Recent performance</span>
              </div>
              <div className="premium-driving-score-result">
                <strong>{scoreText(normalizedAverage)}<small>/100</small></strong>
                <div className="premium-driving-score-delta" data-tone={delta.tone}>
                  <DeltaIcon aria-hidden="true" />
                  {delta.label}
                </div>
              </div>
              <p>Distance-weighted average from your most recent scored trips.</p>
            </div>
          </article>

          <article className="premium-score-trajectory" aria-labelledby="premium-score-trajectory-title">
            <img loading="lazy" src={premiumDrivingScoreTrend} alt="" aria-hidden="true" />
            <div className="premium-score-trajectory-head">
              <div className="premium-score-trajectory-heading">
                <span className="premium-score-trajectory-icon" aria-hidden="true">
                  <TrajectoryRouteIcon />
                </span>
                <div>
                  <span>Recent trajectory</span>
                  <h3 id="premium-score-trajectory-title">Score trend</h3>
                </div>
              </div>
              <div className="premium-score-latest">
                <small>Latest</small>
                <strong>{scoreText(summary.latest)}</strong>
              </div>
            </div>

            {summary.chartData.length > 2 ? (
              <div className="premium-score-chart" aria-label="Driving score trend across recent scored trips">
                <DeferredRecharts height={126}>
                  {({ ResponsiveContainer, AreaChart, Area, Tooltip }) => (
                    <ResponsiveContainer width="100%" height={126}>
                      <AreaChart data={summary.chartData} margin={{ top: 10, right: 5, bottom: 3, left: 5 }}>
                        <defs>
                          <linearGradient id="premium-driving-score-fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#1fd6bd" stopOpacity={0.5} />
                            <stop offset="100%" stopColor="#0ba5c7" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <Area
                          type="monotone"
                          dataKey="score"
                          stroke="#24d7bc"
                          strokeWidth={3}
                          fill="url(#premium-driving-score-fill)"
                          dot={{ r: 4, fill: '#37e3cf', stroke: '#06131b', strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: '#6ef2dd', strokeWidth: 0 }}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'rgba(5, 15, 25, 0.94)',
                            border: '1px solid rgba(37, 216, 193, 0.42)',
                            borderRadius: 12,
                            color: '#eefcfb',
                            fontSize: 11,
                            boxShadow: '0 10px 28px rgba(1, 8, 18, 0.32)',
                          }}
                          formatter={(value) => [formatEstimatedScore(value), 'Score']}
                          labelFormatter={() => 'Recent trip'}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </DeferredRecharts>
              </div>
            ) : (
              <div className="premium-score-empty">
                <Activity aria-hidden="true" />
                <span>Complete more trips to see trend</span>
                <small>{summary.scoredTripCount}/3 scored trips ready</small>
              </div>
            )}
          </article>

          <div className="premium-score-metric-grid">
            <article className="premium-score-metric" data-accent="peak" aria-label={`Recent peak: ${scoreText(summary.peak)}`}>
              <img loading="lazy" src={premiumDrivingScorePeak} alt="" aria-hidden="true" />
              <div className="premium-score-metric-icon"><SummitFlagIcon /></div>
              <div className="premium-score-metric-copy">
                <strong>{scoreText(summary.peak)}</strong>
                <span>Recent peak</span>
                <small>{summary.scoredTripCount ? `Best of ${summary.scoredTripCount} scored trips` : 'No scored trips yet'}</small>
              </div>
            </article>
            <article className="premium-score-metric" data-accent="range" aria-label={`Observed score range: ${rangeText}`}>
              <img loading="lazy" src={premiumDrivingScoreRange} alt="" aria-hidden="true" />
              <div className="premium-score-metric-icon"><RangeSlidersIcon /></div>
              <div className="premium-score-metric-copy">
                <strong>{rangeText}</strong>
                <span>Observed range</span>
                <small>{summary.scoredTripCount > 1 ? 'Low to high across recent trips' : 'More trips reveal consistency'}</small>
              </div>
            </article>
          </div>
        </>
      )}
    </section>
  );
}
