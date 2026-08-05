// @ts-check
import premiumTripSensorFusion from '@/assets/premium-trip-sensor-fusion.jpg';
import premiumTripSensorPartial from '@/assets/premium-trip-sensor-partial.jpg';
import premiumTripSensorUnavailable from '@/assets/premium-trip-sensor-unavailable.jpg';
import premiumTripSpeedEstimated from '@/assets/premium-trip-speed-estimated.jpg';
import premiumTripSpeedLimits from '@/assets/premium-trip-speed-limits.jpg';
import premiumTripSpeedReview from '@/assets/premium-trip-speed-review.jpg';
import premiumTripSpeedUnavailable from '@/assets/premium-trip-speed-unavailable.jpg';
import premiumTripNight from '@/assets/premium-trip-night-v2.webp';
import premiumTripTagRoute from '@/assets/premium-trip-tag-route.jpg';
import premiumTripWeather from '@/assets/premium-trip-weather.jpg';
import premiumTripWeatherDry from '@/assets/premium-trip-weather-dry.jpg';
import premiumTripWeatherFog from '@/assets/premium-trip-weather-fog.jpg';
import premiumTripWeatherSnow from '@/assets/premium-trip-weather-snow.jpg';
import premiumTripWeatherStorm from '@/assets/premium-trip-weather-storm.jpg';
import premiumTripWeatherUnavailable from '@/assets/premium-trip-weather-unavailable.jpg';

const ARTWORK = Object.freeze({
  'sensor-good': premiumTripSensorFusion,
  'sensor-partial': premiumTripSensorPartial,
  'sensor-unavailable': premiumTripSensorUnavailable,
  'speed-estimated': premiumTripSpeedEstimated,
  'speed-review': premiumTripSpeedReview,
  'speed-unavailable': premiumTripSpeedUnavailable,
  'speed-verified': premiumTripSpeedLimits,
  tag: premiumTripTagRoute,
  'tag-highway': premiumTripSpeedLimits,
  'tag-night': premiumTripNight,
  'weather-dry': premiumTripWeatherDry,
  'weather-fog': premiumTripWeatherFog,
  'weather-rain': premiumTripWeather,
  'weather-snow': premiumTripWeatherSnow,
  'weather-storm': premiumTripWeatherStorm,
  'weather-unavailable': premiumTripWeatherUnavailable,
});

const normalizeState = (value) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export function selectPremiumTripTagArtwork(tag) {
  const normalizedTag = normalizeState(tag);
  if (normalizedTag.includes('night')) return 'tag-night';
  if (normalizedTag.includes('highway')) return 'tag-highway';
  if (/(snow|freez|winter)/.test(normalizedTag)) return 'weather-snow';
  if (/(rain|wet|storm)/.test(normalizedTag)) return 'weather-rain';
  return 'tag';
}

/**
 * Selects artwork from real weather evidence without inventing a condition.
 * @param {{ condition?: unknown, displayValue?: unknown, source?: unknown }} input
 */
export function selectPremiumWeatherArtwork({ condition, displayValue, source }) {
  if (normalizeState(source) === 'unavailable') return 'weather-unavailable';

  const evidence = `${normalizeState(condition)} ${normalizeState(displayValue)}`;
  if (/(snow|freez|ice|sleet)/.test(evidence)) return 'weather-snow';
  if (/(storm|thunder|lightning)/.test(evidence)) return 'weather-storm';
  if (/(fog|mist|haze)/.test(evidence)) return 'weather-fog';
  if (/(rain|drizzle|shower|wet|precip)/.test(evidence)) return 'weather-rain';
  if (/(dry|clear|sun|fair)/.test(evidence)) return 'weather-dry';
  return 'weather-unavailable';
}

/**
 * @param {{
 *   coverage?: unknown,
 *   hasPostedEvidence?: boolean,
 *   lookupEnabled?: boolean,
 *   reviewNeeded?: boolean,
 *   status?: unknown,
 * }} input
 */
export function selectPremiumSpeedArtwork({
  coverage,
  hasPostedEvidence = false,
  lookupEnabled = true,
  reviewNeeded = false,
  status,
}) {
  const normalizedStatus = normalizeState(status);
  if (
    lookupEnabled === false ||
    /(disabled|unavailable|failed|error|missing|not_found)/.test(normalizedStatus)
  ) {
    return 'speed-unavailable';
  }
  if (
    reviewNeeded ||
    /(review|conflict|deferred|partial|stale)/.test(normalizedStatus)
  ) {
    return 'speed-review';
  }
  if (hasPostedEvidence) return 'speed-verified';
  if (Number(coverage) > 0 || /(fetched|cache_hit|loaded|success|estimated|fallback)/.test(normalizedStatus)) {
    return 'speed-estimated';
  }
  return 'speed-unavailable';
}

/**
 * @param {{ quality?: unknown, sample_count?: unknown } | null | undefined} summary
 */
export function selectPremiumSensorArtwork(summary) {
  const quality = normalizeState(summary?.quality);
  const sampleCount = Number(summary?.sample_count) || 0;
  if (
    sampleCount <= 0 ||
    /(unavailable|disabled|unsupported|none|missing|failed|error)/.test(quality)
  ) {
    return 'sensor-unavailable';
  }
  if (/(good|high|complete|excellent|available)/.test(quality)) return 'sensor-good';
  return 'sensor-partial';
}

/**
 * Shared premium shell for Trip Detail context. All copy and metrics are supplied
 * by the caller so the artwork never substitutes for live trip evidence.
 * @param {{
 *   accent: 'blue' | 'sky' | 'emerald' | 'violet',
 *   artwork: keyof typeof ARTWORK,
 *   ariaLabel: string,
 *   children?: import('react').ReactNode,
 *   className?: string,
 *   eyebrow: string,
 *   icon: import('lucide-react').LucideIcon,
 *   status?: string,
 *   title: string,
 * }} props
 */
export default function PremiumTripContextCard({
  accent,
  artwork,
  ariaLabel,
  children,
  className = '',
  eyebrow,
  icon: Icon,
  status,
  title,
}) {
  return (
    <article
      className={`premium-trip-context-card ${className}`.trim()}
      data-accent={accent}
      data-context-card={artwork}
      aria-label={ariaLabel}
    >
      <img loading="lazy"
        className="premium-trip-context-art"
        src={ARTWORK[artwork]}
        alt=""
        aria-hidden="true"
      />
      <div className="premium-trip-context-content">
        <header className="premium-trip-context-head">
          <div className="premium-trip-context-heading">
            <span className="premium-trip-context-icon" aria-hidden="true">
              <Icon />
            </span>
            <div>
              <p>{eyebrow}</p>
              <h2>{title}</h2>
            </div>
          </div>
          {status && <span className="premium-trip-context-status">{status}</span>}
        </header>
        <div className="premium-trip-context-body">{children}</div>
      </div>
    </article>
  );
}
