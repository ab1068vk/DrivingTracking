// @ts-check
import { Activity, Award, Gauge, Minus, SlidersHorizontal, TrendingDown, TrendingUp } from 'lucide-react';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import DeferredRecharts from '@/components/DeferredRecharts';
import ScoreRing from '@/components/ScoreRing';
import premiumDrivingScoreHero from '@/assets/premium-driving-score-hero.png';
import premiumDrivingScorePeak from '@/assets/premium-driving-score-peak.png';
import premiumDrivingScoreRange from '@/assets/premium-driving-score-range.png';
import premiumDrivingScoreTrend from '@/assets/premium-driving-score-trend.png';
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
    return score == null ? [] : [{ i: Number.isFinite(Number(point?.i)) ? Number(point.i) : index, score }];
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

function deltaPresentation(delta, scoredTripCount) {
  if (scoredTripCount === 0) return { Icon: Activity, label: 'Awaiting scored trips', tone: 'neutral' };
  if (scoredTripCount === 1 || delta == null) return { Icon: Activity, label: 'First score recorded', tone: 'neutral' };
  if (Math.abs(delta) < 0.5) return { Icon: Minus, label: 'Holding steady', tone: 'steady' };
  if (delta > 0) return { Icon: TrendingUp, label: `Up ${formatEstimatedScore(Math.abs(delta))}`, tone: 'improving' };
  return { Icon: TrendingDown, label: `Down ${formatEstimatedScore(Math.abs(delta))}`, tone: 'declining' };
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
      <div className="premium-driving-score-grid" aria-hidden="true" />
      <img className="premium-driving-score-hero-art" src={premiumDrivingScoreHero} alt="" aria-hidden="true" />

      <header className="premium-driving-score-head">
        <div>
          <span className="premium-driving-score-eyebrow"><Gauge aria-hidden="true" /> Performance telemetry</span>
          <div className="premium-driving-score-title-row">
            <h2 id="premium-driving-score-title">Driving Score</h2>
            {showApproximateTag && <CalibrationStatusTag />}
          </div>
          <p>Last {visibleTripCount} trips</p>
        </div>
      </header>

      {isLoading ? (
        <div className="premium-driving-score-loading" role="status" aria-live="polite">
          <span />
          <strong>Loading driving score</strong>
          <small>Preparing your recent performance telemetry</small>
        </div>
      ) : (
        <>
          <div className="premium-driving-score-overview">
            <div className="premium-driving-score-gauge" aria-label={`Average driving score: ${scoreText(avgScore)}`}>
              <ScoreRing score={avgScore} evidence={evidence} size={132} strokeWidth={9} sublabel="average" />
            </div>
            <div className="premium-driving-score-overview-copy">
              <span>RECENT PERFORMANCE</span>
              <strong>{scoreText(avgScore)}<small>/100</small></strong>
              <p>Distance-weighted average from your most recent scored trips.</p>
              <div className="premium-driving-score-delta" data-tone={delta.tone}>
                <DeltaIcon aria-hidden="true" />
                {delta.label}
              </div>
            </div>
          </div>

          <article className="premium-score-trajectory" aria-labelledby="premium-score-trajectory-title">
            <img src={premiumDrivingScoreTrend} alt="" aria-hidden="true" />
            <div className="premium-score-trajectory-head">
              <div>
                <span>RECENT TRAJECTORY</span>
                <h3 id="premium-score-trajectory-title">Score trend</h3>
              </div>
              <div className="premium-score-latest">
                <small>Latest</small>
                <strong>{scoreText(summary.latest)}</strong>
              </div>
            </div>

            {summary.chartData.length > 2 ? (
              <div className="premium-score-chart" aria-label="Driving score trend across recent scored trips">
                <DeferredRecharts height={112}>
                  {({ ResponsiveContainer, AreaChart, Area, Tooltip }) => (
                    <ResponsiveContainer width="100%" height={112}>
                      <AreaChart data={summary.chartData} margin={{ top: 8, right: 4, bottom: 2, left: 4 }}>
                        <defs>
                          <linearGradient id="premium-driving-score-fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="hsl(158 78% 49%)" stopOpacity={0.42} />
                            <stop offset="100%" stopColor="hsl(190 92% 48%)" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <Area
                          type="monotone"
                          dataKey="score"
                          stroke="hsl(164 79% 47%)"
                          strokeWidth={3}
                          fill="url(#premium-driving-score-fill)"
                          dot={{ r: 3, fill: 'hsl(190 96% 58%)', stroke: 'hsl(var(--card))', strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: 'hsl(150 78% 52%)', strokeWidth: 0 }}
                        />
                        <Tooltip
                          contentStyle={{ background: 'hsl(var(--card) / 0.96)', border: '1px solid hsl(164 79% 47% / 0.42)', borderRadius: 12, fontSize: 11, boxShadow: '0 10px 28px hsl(215 60% 8% / 0.18)' }}
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
              <img src={premiumDrivingScorePeak} alt="" aria-hidden="true" />
              <div className="premium-score-metric-icon"><Award aria-hidden="true" /></div>
              <div>
                <strong>{scoreText(summary.peak)}</strong>
                <span>Recent peak</span>
                <small>{summary.scoredTripCount ? `Best of ${summary.scoredTripCount} scored trips` : 'No scored trips yet'}</small>
              </div>
            </article>
            <article className="premium-score-metric" data-accent="range" aria-label={`Observed score range: ${rangeText}`}>
              <img src={premiumDrivingScoreRange} alt="" aria-hidden="true" />
              <div className="premium-score-metric-icon"><SlidersHorizontal aria-hidden="true" /></div>
              <div>
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
