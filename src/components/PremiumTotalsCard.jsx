// @ts-check
import { useMemo, useState } from 'react';
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CarFront,
  CircleDashed,
  Clock3,
  Gauge,
  MapPinned,
  Mountain,
  Route,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { buildDashboardActivityStats } from '@/lib/dashboardStats';
import { formatDistance, formatDuration } from '@/lib/tripEngine';
import premiumTotalsHero from '@/assets/premium-totals-hero-v2.webp';
import premiumTotalsDistance from '@/assets/premium-totals-distance-v2.webp';
import premiumTotalsDuration from '@/assets/premium-totals-duration-v2.webp';
import premiumTotalsTrips from '@/assets/premium-totals-trips-v2.webp';
import premiumTotalsDays from '@/assets/premium-totals-days-v4.webp';
import premiumTotalsAverage from '@/assets/premium-totals-average-v2.webp';
import premiumTotalsLongest from '@/assets/premium-totals-longest-v2.webp';
import premiumBaselineHero from '@/assets/premium-baseline-hero-v2.jpg';
import premiumBaselineWeek from '@/assets/premium-baseline-week-v3.jpg';
import premiumBaselineReference from '@/assets/premium-baseline-reference-v3.jpg';
import premiumBaselinePercentile from '@/assets/premium-baseline-percentile-v4.jpg';
import premiumBaselineStressSafe from '@/assets/premium-baseline-stress-safe-v1.jpg';
import premiumBaselineStressCaution from '@/assets/premium-baseline-stress-caution-v1.jpg';
import premiumBaselineStressWarning from '@/assets/premium-baseline-stress-warning-v1.jpg';
import premiumBaselineStressAlert from '@/assets/premium-baseline-stress-alert-v1.jpg';
import premiumBaselineStressLearning from '@/assets/premium-baseline-stress-learning-v1.jpg';
import premiumBaselineStressSceneSafe from '@/assets/premium-baseline-stress-scene-safe-v1.jpg';
import premiumBaselineStressSceneCaution from '@/assets/premium-baseline-stress-scene-caution-v1.jpg';
import premiumBaselineStressSceneWarning from '@/assets/premium-baseline-stress-scene-warning-v1.jpg';
import premiumBaselineStressSceneAlert from '@/assets/premium-baseline-stress-scene-alert-v1.jpg';
import premiumBaselineStressSceneLearning from '@/assets/premium-baseline-stress-scene-learning-v1.jpg';

const PERIODS = Object.freeze({
  ALL_TIME: 'all_time',
  SEVEN_DAYS: 'seven_days',
});

/**
 * @param {Array<Record<string, any>>} trips
 * @param {'all_time'|'seven_days'} period
 * @param {number} now
 */
export function buildPremiumTotals(trips = [], period = PERIODS.ALL_TIME, now = Date.now()) {
  const completedTrips = (Array.isArray(trips) ? trips : []).map((trip) => (
    trip?.status ? trip : { ...trip, status: 'completed' }
  ));
  const stats = buildDashboardActivityStats(completedTrips, {
    now: new Date(now),
    periodDays: period === PERIODS.ALL_TIME ? null : 7,
  });

  return {
    activeDays: stats.activeDays,
    averageDistanceKm: stats.averageTripKm,
    distanceKm: stats.distanceKm,
    durationSeconds: stats.drivingSeconds,
    longestDistanceKm: stats.longestTripKm,
    tripCount: stats.tripCount,
  };
}

const METRIC_STYLES = [
  { id: 'distance', icon: MapPinned, accent: 'blue', label: 'Distance', asset: premiumTotalsDistance },
  { id: 'duration', icon: Clock3, accent: 'green', label: 'Time driving', asset: premiumTotalsDuration },
  { id: 'trips', icon: CarFront, accent: 'purple', label: 'Trips', asset: premiumTotalsTrips },
  { id: 'days', icon: CalendarDays, accent: 'orange', label: 'Active days', asset: premiumTotalsDays },
  { id: 'average', icon: Route, accent: 'cyan', label: 'Average trip', asset: premiumTotalsAverage },
  { id: 'longest', icon: Mountain, accent: 'amber', label: 'Longest trip', asset: premiumTotalsLongest },
];

/**
 * @param {{ trips?: Array<Record<string, any>>, units?: string }} props
 */
export default function PremiumTotalsCard({ trips = [], units = 'metric' }) {
  const [period, setPeriod] = useState(/** @type {'all_time'|'seven_days'} */ (PERIODS.ALL_TIME));
  const totals = useMemo(() => buildPremiumTotals(trips, period), [period, trips]);
  const values = {
    distance: formatDistance(totals.distanceKm, units),
    duration: formatDuration(Math.round(totals.durationSeconds)),
    trips: String(totals.tripCount),
    days: period === PERIODS.SEVEN_DAYS ? `${totals.activeDays}/7` : String(totals.activeDays),
    average: formatDistance(totals.averageDistanceKm, units),
    longest: formatDistance(totals.longestDistanceKm, units),
  };
  const activeDayRate = totals.activeDays ? totals.tripCount / totals.activeDays : 0;
  const sublabels = {
    distance: 'completed trips',
    duration: 'recorded time',
    trips: period === PERIODS.ALL_TIME ? 'all time' : 'last 7 days',
    days: totals.activeDays ? `${activeDayRate.toFixed(1)} trips / active day` : 'no driving days',
    average: 'typical distance',
    longest: period === PERIODS.ALL_TIME ? 'all time' : 'last 7 days',
  };
  const periodLabel = period === PERIODS.ALL_TIME ? 'All-time totals' : 'Last 7 days';

  return (
    <section
      className="premium-totals-card"
      data-empty={totals.tripCount === 0 ? 'true' : 'false'}
      data-period={period}
      aria-labelledby="premium-totals-title"
    >
      <img loading="lazy" className="premium-totals-hero" src={premiumTotalsHero} alt="" aria-hidden="true" />
      <div className="premium-totals-hero-shade" aria-hidden="true" />

      <div className="premium-totals-heading">
        <span className="premium-totals-emblem" aria-hidden="true"><Gauge /></span>
        <div>
          <h2 id="premium-totals-title">{periodLabel}</h2>
          <p>{period === PERIODS.ALL_TIME ? 'Everything recorded on this device' : 'Your most recent seven days'}</p>
        </div>
      </div>

      <div className="premium-period-picker" aria-label="Totals period">
        <button
          type="button"
          aria-pressed={period === PERIODS.ALL_TIME}
          onClick={() => setPeriod(PERIODS.ALL_TIME)}
        >
          <CalendarClock aria-hidden="true" />
          All time
        </button>
        <button
          type="button"
          aria-pressed={period === PERIODS.SEVEN_DAYS}
          onClick={() => setPeriod(PERIODS.SEVEN_DAYS)}
        >
          <CalendarDays aria-hidden="true" />
          7 days
        </button>
      </div>

      <div className="premium-metric-grid" aria-live="polite">
        {METRIC_STYLES.map(({ id, icon: Icon, accent, label, asset }) => (
          <article
            key={id}
            className="premium-metric"
            data-accent={accent}
            aria-label={`${label}: ${values[id]}. ${sublabels[id]}`}
          >
            <img loading="lazy" className="premium-metric-art" src={asset} alt="" aria-hidden="true" />
            <div className="premium-metric-shade" aria-hidden="true" />
            <div className="premium-metric-icon" aria-hidden="true"><Icon /></div>
            <div className="premium-metric-copy">
              <strong>{values[id]}</strong>
              <span>{label}</span>
              <small>{sublabels[id]}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function baselineTone(trend) {
  if (trend === 'improving') return 'improving';
  if (trend === 'declining') return 'declining';
  if (trend === 'steady') return 'steady';
  return 'learning';
}

const BASELINE_TRENDS = Object.freeze({
  improving: { icon: TrendingUp, label: 'Improving' },
  declining: { icon: TrendingDown, label: 'Declining' },
  steady: { icon: Activity, label: 'Steady' },
  learning: { icon: CircleDashed, label: 'Building' },
});

const BASELINE_STRESS_STATES = Object.freeze({
  safe: {
    iconAsset: premiumBaselineStressSafe,
    sceneAsset: premiumBaselineStressSceneSafe,
  },
  caution: {
    iconAsset: premiumBaselineStressCaution,
    sceneAsset: premiumBaselineStressSceneCaution,
  },
  warning: {
    iconAsset: premiumBaselineStressWarning,
    sceneAsset: premiumBaselineStressSceneWarning,
  },
  alert: {
    iconAsset: premiumBaselineStressAlert,
    sceneAsset: premiumBaselineStressSceneAlert,
  },
  learning: {
    iconAsset: premiumBaselineStressLearning,
    sceneAsset: premiumBaselineStressSceneLearning,
  },
});

function stressTone(peakStress = {}) {
  if (peakStress?.insufficient_data) return 'learning';
  if (peakStress?.peak_stress_label === 'consistent') return 'safe';
  if (peakStress?.peak_stress_label === 'slightly stressed') return 'caution';
  if (peakStress?.peak_stress_label === 'traffic-affected') return 'warning';
  return peakStress?.peak_stress_label ? 'alert' : 'learning';
}

/**
 * Builds presentation labels from the live calculations used by the standard
 * Personal Baseline card.
 * @param {Record<string, any>} baseline
 * @param {string} baselineRangeLabel
 * @param {Record<string, any>} peakStress
 */
export function buildPremiumBaselineViewModel(baseline = {}, baselineRangeLabel = '', peakStress = {}) {
  const rawScore = baseline?.this_week_avg;
  const hasScore = rawScore != null && rawScore !== '' && Number.isFinite(Number(rawScore));
  const score = hasScore ? Math.max(0, Math.min(100, Number(rawScore))) : null;
  const delta = baseline?.delta != null && baseline.delta !== '' && Number.isFinite(Number(baseline.delta))
    ? Number(baseline.delta)
    : null;
  const tone = baselineTone(baseline?.trend);
  const recentTripCount = Math.max(0, Number(baseline?.baseline_trip_count) || 0);
  const weeksAnalyzed = Math.max(0, Number(baseline?.weeks_analyzed) || 0);
  const percentileMinimum = Math.max(0, Number(baseline?.percentile_min_weeks) || 0);
  const peakTripCount = Math.max(0, Number(peakStress?.peak_trip_count) || 0);
  const offPeakTripCount = Math.max(0, Number(peakStress?.off_peak_trip_count) || 0);
  const baselineValue = baseline?.baseline_avg == null
    ? 'Building'
    : baselineRangeLabel
      ? `${baseline.baseline_avg} (${baselineRangeLabel})`
      : String(baseline.baseline_avg);
  const percentileValue = baseline?.percentile == null ? '—' : `${baseline.percentile}%`;
  const stressLabel = peakStress?.peak_stress_label || 'Building';

  return {
    baselineMeta: baseline?.baseline_includes_older_scores
      ? 'Mixed scoring versions'
      : baseline?.baseline_avg == null
        ? `${recentTripCount}/10 recent scored trips`
        : `${recentTripCount} recent scored trips`,
    baselineRange: baseline?.baseline_avg == null ? '' : baselineRangeLabel,
    baselineScoreLabel: baseline?.baseline_avg == null ? 'Building' : String(baseline.baseline_avg),
    baselineValue,
    delta,
    deltaLabel: delta == null
      ? 'Building comparison'
      : `${delta >= 0 ? '+' : ''}${delta} vs baseline`,
    percentileMeta: baseline?.percentile == null
      ? `Needs ${percentileMinimum} scored weeks`
      : `${weeksAnalyzed} scored weeks analyzed`,
    percentileProgress: baseline?.percentile == null
      ? 0
      : Math.max(0, Math.min(100, Number(baseline.percentile) || 0)),
    percentileValue,
    score,
    scoreDegrees: (score || 0) * 2.7,
    scoreLabel: score == null ? '—' : String(rawScore),
    stressLabel,
    stressMeta: peakStress?.insufficient_data !== false
      ? 'Needs peak and off-peak trips'
      : `${peakTripCount} peak / ${offPeakTripCount} off-peak trips`,
    stressTone: stressTone(peakStress),
    tone,
    trendLabel: BASELINE_TRENDS[tone].label,
  };
}

/**
 * @param {{ baseline: Record<string, any>, baselineRangeLabel?: string, baselineText: string, peakStress: Record<string, any> }} props
 */
export function PremiumBaselineCard({ baseline, baselineRangeLabel = '', baselineText, peakStress }) {
  const model = buildPremiumBaselineViewModel(baseline, baselineRangeLabel, peakStress);
  const TrendIcon = BASELINE_TRENDS[model.tone].icon;
  const stressState = BASELINE_STRESS_STATES[model.stressTone];

  return (
    <section className="premium-baseline-card" data-tone={model.tone} aria-labelledby="premium-baseline-title">
      <img loading="lazy" className="premium-baseline-hero" src={premiumBaselineHero} alt="" aria-hidden="true" />
      <div className="premium-baseline-head">
        <div>
          <div className="premium-baseline-title-row">
            <span className="premium-baseline-title-icon" aria-hidden="true"><Activity /></span>
            <h2 id="premium-baseline-title">Personal Baseline</h2>
          </div>
          <p>{baselineText}</p>
        </div>
        <div className="premium-baseline-trend"><span aria-hidden="true" /><TrendIcon /> {model.trendLabel}</div>
      </div>

      <div className="premium-baseline-layout">
        <article
          className="premium-baseline-tile premium-baseline-week"
          data-state={model.score == null ? 'learning' : 'ready'}
          aria-label={`This week score: ${model.scoreLabel}. ${model.deltaLabel}`}
        >
          <img loading="lazy" src={premiumBaselineWeek} alt="" aria-hidden="true" className="premium-baseline-art" />
          <div className="premium-baseline-week-copy">
            <span className="premium-baseline-tile-label">This Week</span>
            <strong>{model.scoreLabel}</strong>
            <span className="premium-baseline-delta" data-direction={model.delta == null ? 'learning' : model.delta >= 0 ? 'up' : 'down'}>
              {model.delta == null ? 'Building comparison' : `${model.delta >= 0 ? '↗' : '↘'} ${model.delta >= 0 ? '+' : ''}${model.delta}`}
            </span>
            {model.delta == null && <small>Record a scored trip this week</small>}
          </div>
        </article>

        <article
          className="premium-baseline-tile premium-baseline-reference"
          aria-label={`Approximate personal baseline: ${model.baselineValue}. ${model.baselineMeta}`}
        >
          <img loading="lazy" src={premiumBaselineReference} alt="" aria-hidden="true" className="premium-baseline-art" />
          <div className="premium-baseline-tile-copy">
            <span className="premium-baseline-tile-label">Approx Baseline</span>
            <strong>{model.baselineScoreLabel}</strong>
            {model.baselineRange && <span className="premium-baseline-range">({model.baselineRange})</span>}
            <small>Recent trips</small>
          </div>
        </article>

        <article
          className="premium-baseline-tile premium-baseline-percentile"
          data-state={baseline?.percentile == null ? 'learning' : 'ready'}
          aria-label={`Personal percentile: ${model.percentileValue}. ${model.percentileMeta}`}
        >
          <img loading="lazy" src={premiumBaselinePercentile} alt="" aria-hidden="true" className="premium-baseline-art" />
          <div className="premium-baseline-tile-copy">
            <strong>{model.percentileValue}</strong>
            <span>Percentile among<br />your recorded weeks</span>
          </div>
          <div
            className="premium-baseline-percentile-progress"
            role="img"
            aria-label={baseline?.percentile == null
              ? model.percentileMeta
              : `${model.percentileProgress}% of personal percentile scale`}
          >
            <span style={{ width: `${model.percentileProgress}%` }} />
          </div>
          <div className="premium-baseline-progress-scale" aria-hidden="true"><span>0%</span><span>100%</span></div>
          {baseline?.percentile == null && <small>{model.percentileMeta}</small>}
        </article>

        <article
          className="premium-baseline-tile premium-baseline-stress"
          data-stress={model.stressTone}
          aria-label={`Rush hour behaviour: ${model.stressLabel}. ${model.stressMeta}`}
        >
          <img loading="lazy"
            src={stressState.sceneAsset}
            alt=""
            aria-hidden="true"
            className="premium-baseline-art premium-baseline-stress-scene"
            data-scene={model.stressTone}
          />
          <div className="premium-baseline-tile-copy">
            <span className="premium-baseline-stress-icon" data-icon={model.stressTone} aria-hidden="true">
              <img loading="lazy" className="premium-baseline-stress-state-art" src={stressState.iconAsset} alt="" />
            </span>
            <strong>{model.stressLabel}</strong>
            <span>Rush hour<br />behaviour</span>
            {peakStress?.insufficient_data !== false && <small>{model.stressMeta}</small>}
          </div>
        </article>
      </div>
    </section>
  );
}
