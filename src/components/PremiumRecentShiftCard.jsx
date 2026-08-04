// @ts-check
import {
  Activity,
  AlertTriangle,
  Gauge,
  Info,
  Route,
  Smartphone,
  Sparkles,
  TrendingUp,
  Waves,
  Zap,
} from 'lucide-react';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import premiumRecentShiftRoute from '@/assets/premium-recent-shift-route-layer.webp';
import premiumRecentShiftCar from '@/assets/premium-recent-shift-car-layer.webp';
import premiumRecentShiftShield from '@/assets/premium-recent-shift-shield.webp';

const REASON_META = Object.freeze({
  harsh_per_10km: {
    icon: AlertTriangle,
    label: 'Braking pattern',
    detail: 'Harsh braking rate differed',
    tone: 'coral',
  },
  accel_per_10km: {
    icon: Zap,
    label: 'Acceleration pattern',
    detail: 'Rapid acceleration rate differed',
    tone: 'amber',
  },
  turn_per_10km: {
    icon: Route,
    label: 'Turning pattern',
    detail: 'Sharp-turn rate differed',
    tone: 'violet',
  },
  speed_per_10km: {
    icon: Gauge,
    label: 'Speeding pattern',
    detail: 'Speeding-event rate differed',
    tone: 'blue',
  },
  phone_pct: {
    icon: Smartphone,
    label: 'Phone-use pattern',
    detail: 'Phone-use share differed',
    tone: 'rose',
  },
  score: {
    icon: Activity,
    label: 'Overall score',
    detail: 'Trip score differed',
    tone: 'cyan',
  },
  avg_speed: {
    icon: Gauge,
    label: 'Average speed',
    detail: 'Running speed differed',
    tone: 'blue',
  },
  smoothness: {
    icon: Waves,
    label: 'Smoothness',
    detail: 'Smoothness score differed',
    tone: 'green',
  },
});

const TONE_COPY = Object.freeze({
  normal: {
    headline: 'Normal difference from your norm',
    status: 'Within your usual range',
    summary: 'This trip stayed close to the driving patterns in your local model.',
  },
  moderate: {
    headline: 'Moderate difference from your norm',
    status: 'Noticeably different',
    summary: 'This trip differed from your usual pattern in a few measured ways.',
  },
  high: {
    headline: 'High difference from your norm',
    status: 'Strongly different',
    summary: 'This trip differed substantially from your usual local pattern.',
  },
  learning: {
    headline: 'No unusual recent shift',
    status: 'Still learning your norm',
    summary: 'Complete more measured trips to build a reliable local comparison.',
  },
});

function normalizeReason(reason) {
  const key = String(reason || '');
  return REASON_META[key] || {
    icon: Sparkles,
    label: key ? key.replaceAll('_', ' ') : 'Measured signal',
    detail: 'This measured signal differed',
    tone: 'cyan',
  };
}

/**
 * Converts the live anomaly result into safe presentation data without
 * inventing scores, comparison trips, or unusual signals.
 * @param {Record<string, any> | null | undefined} anomaly
 */
export function buildPremiumRecentShiftViewModel(anomaly) {
  const level = String(anomaly?.anomaly_level || '').toLowerCase();
  const tone = level === 'high' || level === 'moderate' || level === 'normal'
    ? level
    : 'learning';
  const scoreNumber = anomaly?.anomaly_score == null || anomaly?.anomaly_score === ''
    ? null
    : Number(anomaly.anomaly_score);
  const score = Number.isFinite(scoreNumber)
    ? Math.max(0, Math.min(100, scoreNumber))
    : null;
  const comparisonCount = Math.max(0, Number(anomaly?.model_trip_count) || 0);
  const reasons = Array.isArray(anomaly?.reasons)
    ? anomaly.reasons.filter(Boolean).slice(0, 3).map((reason) => ({
      id: String(reason),
      ...normalizeReason(reason),
    }))
    : [];
  const copy = TONE_COPY[tone];

  return {
    comparisonCount,
    comparisonLabel: comparisonCount === 1 ? '1 local trip' : `${comparisonCount} local trips`,
    headline: copy.headline,
    reasons,
    score,
    scoreLabel: score == null ? '—' : formatEstimatedScore(score, { approximate: false }),
    status: copy.status,
    summary: copy.summary,
    tone,
  };
}

/**
 * Premium-only presentation of the standard Recent Shift result.
 * @param {{ anomaly?: Record<string, any> | null }} props
 */
export default function PremiumRecentShiftCard({ anomaly = null }) {
  const model = buildPremiumRecentShiftViewModel(anomaly);

  return (
    <section
      className="premium-recent-shift-card"
      data-tone={model.tone}
      aria-labelledby="premium-recent-shift-title"
    >
      <div className="premium-recent-shift-grid" aria-hidden="true" />
      <img
        className="premium-recent-shift-route"
        src={premiumRecentShiftRoute}
        alt=""
        aria-hidden="true"
      />
      <img
        className="premium-recent-shift-car"
        src={premiumRecentShiftCar}
        alt=""
        aria-hidden="true"
      />

      <header className="premium-recent-shift-head">
        <div className="premium-recent-shift-kicker">
          <span aria-hidden="true"><TrendingUp /></span>
          Recent shift
        </div>
        <h2 id="premium-recent-shift-title">{model.headline}</h2>
        {model.tone === 'learning' && <p>{model.status}</p>}
      </header>

      <article
        className="premium-recent-shift-score"
        aria-label={`Difference score ${model.scoreLabel} out of 100. Last trip compared with ${model.comparisonLabel}.`}
      >
        <div className="premium-recent-shift-score-primary">
          <div className="premium-recent-shift-shield" aria-hidden="true">
            <img src={premiumRecentShiftShield} alt="" />
          </div>
          <div className="premium-recent-shift-score-copy">
            <div className="premium-recent-shift-value">
              {model.score != null && <span aria-hidden="true">~</span>}
              <strong>{model.scoreLabel}</strong>
              <small>/100</small>
            </div>
            <p>
              Last trip compared with <strong>{model.comparisonLabel}</strong>.
            </p>
          </div>
        </div>

        {model.reasons.length > 0 && (
          <div className="premium-recent-shift-signals" aria-label="Unusual signals">
            {model.reasons.map(({ id, icon: Icon, label, detail, tone }) => (
              <div key={id} className="premium-recent-shift-signal" data-accent={tone}>
                <span aria-hidden="true"><Icon /></span>
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </article>

      <footer className="premium-recent-shift-note">
        <span aria-hidden="true"><Info /></span>
        <p>
          {model.tone === 'learning' && <strong>{model.summary}</strong>}
          A difference means the trip was unusual for you, not necessarily unsafe.
        </p>
      </footer>
    </section>
  );
}
