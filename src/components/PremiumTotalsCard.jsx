// @ts-check
import { useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  CalendarDays,
  CarFront,
  CircleDashed,
  Clock3,
  MapPinned,
  Mountain,
  Route,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import premiumDashboardHero from '@/assets/premium-dashboard-hero.png';
import premiumDashboardSprites from '@/assets/premium-dashboard-sprites.png';
import premiumDashboardCalendar from '@/assets/premium-dashboard-calendar.png';
import premiumBaselineWeek from '@/assets/premium-baseline-week.png';
import premiumBaselineReference from '@/assets/premium-baseline-reference.png';
import premiumBaselinePercentile from '@/assets/premium-baseline-percentile.png';
import premiumBaselineStress from '@/assets/premium-baseline-stress.png';

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIODS = Object.freeze({
  ALL_TIME: 'all_time',
  SEVEN_DAYS: 'seven_days',
});

function validTripDate(trip) {
  const timestamp = new Date(trip?.start_time || trip?.end_time || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compactDuration(totalSeconds) {
  const minutes = Math.max(0, Math.round((Number(totalSeconds) || 0) / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${remainingMinutes}m`;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * @param {Array<Record<string, any>>} trips
 * @param {'all_time'|'seven_days'} period
 * @param {number} now
 */
export function buildPremiumTotals(trips = [], period = PERIODS.ALL_TIME, now = Date.now()) {
  const earliest = now - 7 * DAY_MS;
  const selectedTrips = (trips || []).filter((trip) => (
    period === PERIODS.ALL_TIME || validTripDate(trip) >= earliest
  ));
  const distanceKm = selectedTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip?.distance_km) || 0), 0);
  const durationSeconds = selectedTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip?.duration_seconds) || 0), 0);
  const longestDistanceKm = selectedTrips.reduce((longest, trip) => (
    Math.max(longest, Math.max(0, Number(trip?.distance_km) || 0))
  ), 0);
  const activeDays = new Set(selectedTrips.map((trip) => {
    const timestamp = validTripDate(trip);
    if (!timestamp) return null;
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }).filter(Boolean)).size;

  return {
    activeDays,
    averageDistanceKm: selectedTrips.length ? distanceKm / selectedTrips.length : 0,
    distanceKm,
    durationSeconds,
    longestDistanceKm,
    tripCount: selectedTrips.length,
  };
}

const METRIC_STYLES = [
  { id: 'distance', icon: MapPinned, accent: 'cyan', label: 'Distance', sprite: '0% 0%' },
  { id: 'duration', icon: Clock3, accent: 'blue', label: 'Time driving', sprite: '50% 0%' },
  { id: 'trips', icon: CarFront, accent: 'green', label: 'Trips', sprite: '100% 0%' },
  { id: 'days', icon: CalendarDays, accent: 'purple', label: 'Active days', sprite: 'center', asset: premiumDashboardCalendar },
  { id: 'average', icon: Route, accent: 'amber', label: 'Average trip', sprite: '50% 100%' },
  { id: 'longest', icon: Mountain, accent: 'royal', label: 'Longest trip', sprite: '100% 100%' },
];

/**
 * @param {{ trips?: Array<Record<string, any>>, units?: string }} props
 */
export default function PremiumTotalsCard({ trips = [], units = 'metric' }) {
  const [period, setPeriod] = useState(/** @type {'all_time'|'seven_days'} */ (PERIODS.ALL_TIME));
  const totals = useMemo(() => buildPremiumTotals(trips, period), [period, trips]);
  const values = {
    distance: formatDistance(totals.distanceKm, units),
    duration: compactDuration(totals.durationSeconds),
    trips: String(totals.tripCount),
    days: String(totals.activeDays),
    average: formatDistance(totals.averageDistanceKm, units),
    longest: formatDistance(totals.longestDistanceKm, units),
  };
  const activeDayRate = totals.activeDays ? totals.tripCount / totals.activeDays : 0;
  const sublabels = {
    distance: 'completed trips',
    duration: 'recorded time',
    trips: period === PERIODS.ALL_TIME ? 'all time' : 'last 7 days',
    days: `${activeDayRate.toFixed(1)} trips / active day`,
    average: 'typical distance',
    longest: period === PERIODS.ALL_TIME ? 'all time' : 'last 7 days',
  };
  const periodLabel = period === PERIODS.ALL_TIME ? 'All-time totals' : 'Last 7 days';

  return (
    <section className="premium-totals-card" aria-labelledby="premium-totals-title">
      <img className="premium-totals-hero" src={premiumDashboardHero} alt="" aria-hidden="true" />

      <div className="premium-totals-heading">
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
          All time
        </button>
        <button
          type="button"
          aria-pressed={period === PERIODS.SEVEN_DAYS}
          onClick={() => setPeriod(PERIODS.SEVEN_DAYS)}
        >
          7 days
        </button>
      </div>

      <div className="premium-metric-grid">
        {METRIC_STYLES.map(({ id, icon: Icon, accent, label, sprite, asset }) => (
          <article key={id} className="premium-metric" data-accent={accent}>
            <div
              className="premium-metric-art"
              aria-hidden="true"
              style={{
                backgroundImage: `url(${asset || premiumDashboardSprites})`,
                backgroundPosition: sprite,
                backgroundSize: asset ? 'contain' : undefined,
              }}
            />
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
    baselineValue,
    delta,
    deltaLabel: delta == null
      ? 'Building comparison'
      : `${delta >= 0 ? '+' : ''}${delta} vs baseline`,
    percentileMeta: baseline?.percentile == null
      ? `Needs ${percentileMinimum} scored weeks`
      : `${weeksAnalyzed} scored weeks analyzed`,
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

  return (
    <section className="premium-baseline-card" data-tone={model.tone} aria-labelledby="premium-baseline-title">
      <div className="premium-baseline-ambient" aria-hidden="true" />
      <div className="premium-baseline-head">
        <div>
          <div className="premium-baseline-kicker"><span /> Driver profile</div>
          <h2 id="premium-baseline-title">Personal Baseline</h2>
          <p>{baselineText}</p>
        </div>
        <div className="premium-baseline-trend"><TrendIcon /> {model.trendLabel}</div>
      </div>

      <div className="premium-baseline-layout">
        <article
          className="premium-baseline-tile premium-baseline-week"
          data-state={model.score == null ? 'learning' : 'ready'}
          aria-label={`This week score: ${model.scoreLabel}. ${model.deltaLabel}`}
        >
          <div className="premium-baseline-week-copy">
            <div
              className="premium-score-gauge"
              role="img"
              aria-label={model.score == null ? 'This week score is still building' : `This week score ${model.scoreLabel} out of 100`}
              style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({ '--premium-score': `${model.scoreDegrees}deg` })}
            >
              <div>
                <strong>{model.scoreLabel}</strong>
                <span>THIS WEEK</span>
              </div>
            </div>
            <div className="premium-score-summary">
              <span className="premium-baseline-tile-label"><Activity /> Weekly score</span>
              <strong>{model.deltaLabel}</strong>
              <small>{model.delta == null ? 'Record a scored trip this week' : 'Compared with your recent baseline'}</small>
            </div>
          </div>
          <img src={premiumBaselineWeek} alt="" aria-hidden="true" className="premium-baseline-art" />
        </article>

        <article
          className="premium-baseline-tile premium-baseline-reference"
          aria-label={`Approximate personal baseline: ${model.baselineValue}`}
        >
          <div className="premium-baseline-tile-copy">
            <span className="premium-baseline-tile-label"><Route /> Reference range</span>
            <strong>{model.baselineValue}</strong>
            <span>Approx baseline</span>
            <small>{model.baselineMeta}</small>
          </div>
          <img src={premiumBaselineReference} alt="" aria-hidden="true" className="premium-baseline-art" />
        </article>

        <article
          className="premium-baseline-tile premium-baseline-percentile"
          data-state={baseline?.percentile == null ? 'learning' : 'ready'}
          aria-label={`Personal percentile: ${model.percentileValue}. ${model.percentileMeta}`}
        >
          <div className="premium-baseline-tile-copy">
            <span className="premium-baseline-tile-label"><BarChart3 /> Personal rank</span>
            <strong>{model.percentileValue}</strong>
            <span>Recorded-week percentile</span>
            <small>{model.percentileMeta}</small>
          </div>
          <img src={premiumBaselinePercentile} alt="" aria-hidden="true" className="premium-baseline-art" />
        </article>

        <article
          className="premium-baseline-tile premium-baseline-stress"
          data-stress={model.stressTone}
          aria-label={`Rush hour behaviour: ${model.stressLabel}. ${model.stressMeta}`}
        >
          <div className="premium-baseline-tile-copy">
            <span className="premium-baseline-tile-label"><ShieldCheck /> Traffic composure</span>
            <strong>{model.stressLabel}</strong>
            <span>Rush hour behaviour</span>
            <small>{model.stressMeta}</small>
          </div>
          <img src={premiumBaselineStress} alt="" aria-hidden="true" className="premium-baseline-art" />
        </article>
      </div>
    </section>
  );
}
