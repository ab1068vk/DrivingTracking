// @ts-check
import {
  CarFront,
  Info,
  LockKeyhole,
  MapPinned,
  ShieldCheck,
} from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import premiumModelTransparencyHero from '@/assets/premium-model-transparency-hero.jpg';
import premiumModelTransparencyTrips from '@/assets/premium-model-transparency-trips.jpg';
import premiumModelTransparencyConfidence from '@/assets/premium-model-transparency-confidence.jpg';
import premiumModelTransparencyDistance from '@/assets/premium-model-transparency-distance.jpg';

const DISCLAIMER = 'Scores, event detections, readiness, repeated areas, and coaching targets are personal GPS/sensor estimates. They are not validated collision-risk, medical, legal, or insurance assessments. Review incorrect events from Trip Detail so future evidence is based on corrected trips.';

/**
 * Keeps premium presentation derived from the same live values used by the
 * standard Model transparency card.
 * @param {{ eligibleTripCount?: number, confidence?: number, distanceKm?: number, units?: string }} values
 */
export function buildPremiumModelTransparencyViewModel({
  eligibleTripCount = 0,
  confidence = 0,
  distanceKm = 0,
  units = 'metric',
} = {}) {
  const normalizedTripCount = Math.max(0, Math.trunc(Number(eligibleTripCount) || 0));
  const numericConfidence = Number(confidence);
  const confidencePercent = Number.isFinite(numericConfidence)
    ? Math.round(Math.max(0, Math.min(1, numericConfidence)) * 100)
    : 0;
  const numericDistance = Number(distanceKm);
  const normalizedDistanceKm = Number.isFinite(numericDistance) ? Math.max(0, numericDistance) : 0;

  return {
    confidenceDegrees: Math.round(confidencePercent * 36) / 10,
    confidencePercent,
    confidenceValue: `${confidencePercent}%`,
    distanceValue: formatDistance(normalizedDistanceKm, units),
    tripCount: normalizedTripCount,
    tripValue: String(normalizedTripCount),
  };
}

const METRICS = [
  {
    id: 'trips',
    label: 'eligible driver trips',
    tone: 'blue',
    icon: CarFront,
    asset: premiumModelTransparencyTrips,
  },
  {
    id: 'confidence',
    label: 'habit-model confidence',
    tone: 'green',
    icon: ShieldCheck,
    asset: premiumModelTransparencyConfidence,
  },
  {
    id: 'distance',
    label: 'coaching distance',
    tone: 'violet',
    icon: MapPinned,
    asset: premiumModelTransparencyDistance,
  },
];

/**
 * @param {{ eligibleTripCount?: number, confidence?: number, distanceKm?: number, units?: string }} props
 */
export default function PremiumModelTransparencyCard({
  eligibleTripCount = 0,
  confidence = 0,
  distanceKm = 0,
  units = 'metric',
}) {
  const model = buildPremiumModelTransparencyViewModel({
    eligibleTripCount,
    confidence,
    distanceKm,
    units,
  });
  const values = {
    trips: model.tripValue,
    confidence: model.confidenceValue,
    distance: model.distanceValue,
  };

  return (
    <section className="premium-model-transparency" aria-labelledby="premium-model-transparency-title">
      <img loading="lazy"
        className="premium-model-transparency-hero"
        src={premiumModelTransparencyHero}
        alt=""
        aria-hidden="true"
      />

      <header className="premium-model-transparency-head">
        <div className="premium-model-transparency-kicker">
          <ShieldCheck aria-hidden="true" />
          <span>Model transparency</span>
        </div>
        <h2 id="premium-model-transparency-title">Evidence and limitations</h2>
      </header>

      <div className="premium-model-transparency-grid">
        {METRICS.map(({ id, label, tone, icon: Icon, asset }) => (
          <article
            key={id}
            className="premium-model-transparency-metric"
            data-tone={tone}
            aria-label={`${label}: ${values[id]}`}
          >
            <img loading="lazy"
              className="premium-model-transparency-art"
              src={asset}
              alt=""
              aria-hidden="true"
            />
            <div
              className="premium-model-transparency-icon"
              aria-hidden="true"
              style={id === 'confidence'
                ? /** @type {import('react').CSSProperties & Record<string, string>} */ ({
                    '--model-confidence': `${model.confidenceDegrees}deg`,
                  })
                : undefined}
            >
              <span><Icon /></span>
            </div>
            <div className="premium-model-transparency-copy">
              <strong>{values[id]}</strong>
              <span>{label}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="premium-model-transparency-note">
        <span aria-hidden="true"><Info /></span>
        <p>{DISCLAIMER}</p>
        <LockKeyhole className="premium-model-transparency-lock" aria-hidden="true" />
      </div>
    </section>
  );
}
