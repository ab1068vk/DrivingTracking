// @ts-check
import { AlertTriangle, Clock3, Coffee, MoonStar, ShieldCheck } from 'lucide-react';
import premiumDrivingExposureClock from '@/assets/premium-driving-exposure-clock.webp';
import premiumDrivingExposureRest from '@/assets/premium-driving-exposure-rest.webp';
import premiumDrivingExposureWheel from '@/assets/premium-driving-exposure-wheel.webp';

const EXPOSURE_LEVELS = Object.freeze({
  low: { label: 'Low', icon: ShieldCheck },
  moderate: { label: 'Moderate', icon: AlertTriangle },
  high: { label: 'High', icon: AlertTriangle },
  critical: { label: 'Critical', icon: AlertTriangle },
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/**
 * Normalizes the live daily-fatigue calculation for the premium presentation.
 * It never substitutes demonstration values for unavailable evidence.
 * @param {Record<string, any>} dailyFatigue
 */
export function buildPremiumDrivingExposureViewModel(dailyFatigue = {}) {
  const score = Math.min(10, finiteNonNegative(dailyFatigue.cumulativeFatigueScore));
  const rawLevel = String(dailyFatigue.fatigueLevel || '').toLowerCase();
  const level = Object.hasOwn(EXPOSURE_LEVELS, rawLevel) ? rawLevel : 'low';
  const tripCount = Math.trunc(finiteNonNegative(dailyFatigue.tripCount));
  const totalDrivingMinutes = Math.round(finiteNonNegative(dailyFatigue.totalDrivingMinutes));
  const restingMinutes = dailyFatigue.minutesSinceLastTrip == null
    ? null
    : Math.round(finiteNonNegative(dailyFatigue.minutesSinceLastTrip));
  const recommendedBreakMinutes = Math.round(finiteNonNegative(dailyFatigue.recommendedBreakMinutes));

  return {
    gaugeProgress: score * 7.5,
    level,
    levelLabel: EXPOSURE_LEVELS[level].label,
    recommendedBreakMinutes,
    restingMinutes,
    score,
    scoreLabel: String(score),
    totalDrivingMinutes,
    tripCount,
    tripLabel: `${tripCount} ${tripCount === 1 ? 'trip' : 'trips'}`,
  };
}

/**
 * @param {{ dailyFatigue?: Record<string, any> }} props
 */
export default function PremiumDrivingExposureCard({ dailyFatigue = {} }) {
  const model = buildPremiumDrivingExposureViewModel(dailyFatigue);
  const StatusIcon = EXPOSURE_LEVELS[model.level].icon;
  const gaugeLabel = `${model.levelLabel} driving-time exposure estimate, approximately ${model.scoreLabel} out of 10`;

  return (
    <section
      className="premium-driving-exposure"
      data-level={model.level}
      aria-labelledby="premium-driving-exposure-title"
    >
      <div className="premium-exposure-gridlines" aria-hidden="true" />

      <header className="premium-exposure-head">
        <div>
          <p className="premium-exposure-kicker"><span /> Daily wellbeing</p>
          <h2 id="premium-driving-exposure-title">
            Driving-Time <span>Exposure Estimate</span>
          </h2>
        </div>
        <div className="premium-exposure-status" aria-label={`${model.levelLabel} exposure`}>
          <StatusIcon aria-hidden="true" />
          <span>{model.levelLabel}</span>
        </div>
      </header>

      <div className="premium-exposure-instrument-row">
        <div className="premium-exposure-wheel" aria-hidden="true">
          <img src={premiumDrivingExposureWheel} alt="" />
        </div>

        <div className="premium-exposure-gauge" role="img" aria-label={gaugeLabel}>
          <svg viewBox="0 0 180 180" aria-hidden="true">
            <circle className="premium-exposure-gauge-track" cx="90" cy="90" r="68" pathLength="100" />
            <circle
              className="premium-exposure-gauge-value"
              cx="90"
              cy="90"
              r="68"
              pathLength="100"
              style={{ strokeDasharray: `${model.gaugeProgress} ${100 - model.gaugeProgress}` }}
            />
          </svg>
          <div className="premium-exposure-gauge-copy">
            <div><span>~</span><strong>{model.scoreLabel}</strong><small>/10</small></div>
            <p>today</p>
          </div>
        </div>
      </div>

      <div className="premium-exposure-metrics">
        <article
          className="premium-exposure-metric premium-exposure-metric-driving"
          data-long={String(model.totalDrivingMinutes).length > 5 || String(model.tripCount).length > 5 ? 'true' : undefined}
          aria-label={`${model.totalDrivingMinutes} minutes driven today across ${model.tripLabel}`}
        >
          <img src={premiumDrivingExposureClock} alt="" aria-hidden="true" />
          <div className="premium-exposure-metric-icon" aria-hidden="true"><Clock3 /></div>
          <div className="premium-exposure-metric-copy">
            <strong>{model.totalDrivingMinutes}<small> min</small></strong>
            <span>Driven today</span>
            <p>Across {model.tripLabel}</p>
          </div>
        </article>

        <article
          className="premium-exposure-metric premium-exposure-metric-rest"
          data-long={model.restingMinutes != null && String(model.restingMinutes).length > 5 ? 'true' : undefined}
          aria-label={model.restingMinutes == null
            ? 'Rest time is not available yet'
            : `Resting ${model.restingMinutes} minutes since the latest trip`}
        >
          <img src={premiumDrivingExposureRest} alt="" aria-hidden="true" />
          <div className="premium-exposure-metric-icon" aria-hidden="true"><MoonStar /></div>
          <div className="premium-exposure-metric-copy">
            <strong>{model.restingMinutes == null ? '—' : model.restingMinutes}<small>{model.restingMinutes == null ? '' : ' min'}</small></strong>
            <span>{model.restingMinutes == null ? 'Rest unavailable' : 'Resting'}</span>
            <p>{model.restingMinutes == null ? 'Recovery clock pending' : 'Since your latest trip'}</p>
          </div>
        </article>
      </div>

      <div
        className="premium-exposure-progress"
        role="progressbar"
        aria-label={`Driving-time exposure score ${model.scoreLabel} out of 10`}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={model.score}
      >
        <span style={{ width: `${model.score * 10}%` }} />
      </div>

      {model.recommendedBreakMinutes > 0 && (
        <div className="premium-exposure-break">
          <Coffee aria-hidden="true" />
          <span>Consider a <strong>{model.recommendedBreakMinutes}-min break</strong> before your next trip</span>
        </div>
      )}

      <p className="premium-exposure-disclaimer">Driving-time proxy only · not a diagnosis of fatigue</p>
    </section>
  );
}
