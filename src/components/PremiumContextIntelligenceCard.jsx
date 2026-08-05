// @ts-check
import {
  AlertTriangle,
  ArrowRight,
  CarFront,
  Clock3,
  Map,
  MapPinned,
  MoonStar,
  Route,
  Shield,
} from 'lucide-react';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import premiumContextHero from '@/assets/premium-context-intelligence-hero.webp';
import premiumContextRoutes from '@/assets/premium-context-intelligence-routes.webp';
import premiumContextEvents from '@/assets/premium-context-intelligence-events.webp';
import premiumContextMorning from '@/assets/premium-context-intelligence-morning.webp';
import premiumContextAfternoon from '@/assets/premium-context-intelligence-afternoon.webp';
import premiumContextEvening from '@/assets/premium-context-intelligence-evening.webp';
import premiumContextNight from '@/assets/premium-context-intelligence-night.webp';
import premiumContextLearning from '@/assets/premium-context-intelligence-learning.webp';

const TIME_ART = Object.freeze({
  morning: premiumContextMorning,
  afternoon: premiumContextAfternoon,
  evening: premiumContextEvening,
  night: premiumContextNight,
});

export const shouldRenderPremiumContextIntelligence = (premiumVisualExperience) => (
  premiumVisualExperience === true
);

/**
 * Keeps live evidence and empty states separate from the generated artwork.
 * @param {{
 *   routes?: Array<Record<string, any>>,
 *   dangerZones?: Array<Record<string, any>>,
 *   weakestTime?: Record<string, any> | null,
 * }} input
 */
export function buildPremiumContextIntelligenceViewModel({
  routes = [],
  dangerZones = [],
  weakestTime = null,
} = {}) {
  const routeCount = Array.isArray(routes) ? routes.length : 0;
  const eventAreaCount = Array.isArray(dangerZones) ? dangerZones.length : 0;
  const timeId = TIME_ART[weakestTime?.id] ? weakestTime.id : null;

  return [
    {
      id: 'routes',
      tone: 'route',
      state: routeCount > 0 ? 'measured' : 'learning',
      icon: Route,
      art: premiumContextRoutes,
      value: routeCount > 0 ? String(routeCount) : 'Not enough evidence',
      label: 'repeated routes',
      detail: 'matched by similar start and end areas',
    },
    {
      id: 'event-areas',
      tone: 'warning',
      state: eventAreaCount > 0 ? 'measured' : 'learning',
      icon: AlertTriangle,
      art: premiumContextEvents,
      value: eventAreaCount > 0 ? String(eventAreaCount) : 'Not enough evidence',
      label: 'repeated event areas',
      detail: 'harsh braking, speeding, or sharp-turn clusters',
    },
    {
      id: 'pressure-window',
      tone: timeId || 'time',
      state: timeId ? 'measured' : 'learning',
      icon: timeId === 'night' ? MoonStar : Clock3,
      art: timeId ? TIME_ART[timeId] : premiumContextLearning,
      value: weakestTime?.label || 'Learning',
      label: 'highest-pressure window',
      detail: weakestTime
        ? `average ${formatEstimatedScore(weakestTime.avgScore)}`
        : 'needs comparable trips',
    },
  ];
}

/**
 * @param {{
 *   routes?: Array<Record<string, any>>,
 *   dangerZones?: Array<Record<string, any>>,
 *   weakestTime?: Record<string, any> | null,
 *   onOpenMap: () => void,
 * }} props
 */
export default function PremiumContextIntelligenceCard({
  routes = [],
  dangerZones = [],
  weakestTime = null,
  onOpenMap,
}) {
  const metrics = buildPremiumContextIntelligenceViewModel({
    routes,
    dangerZones,
    weakestTime,
  });

  return (
    <section className="premium-context-intelligence" aria-labelledby="premium-context-title">
      <div className="premium-context-hero">
        <img loading="lazy" src={premiumContextHero} alt="" aria-hidden="true" />
        <div className="premium-context-hero-copy">
          <div className="premium-context-eyebrow">
            <span className="premium-context-shield" aria-hidden="true">
              <Shield />
              <CarFront />
            </span>
            Context intelligence
          </div>
          <h2 id="premium-context-title">Where and when your driving changes</h2>
          <p>
            Patterns are separated from the active mission so the coach can monitor secondary
            risks without constantly changing your focus.
          </p>
          <button type="button" onClick={onOpenMap}>
            <Map aria-hidden="true" />
            <span>Open map</span>
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="premium-context-metrics" aria-label="Context intelligence evidence">
        {metrics.map(({ id, tone, state, icon: Icon, art, value, label, detail }) => (
          <article
            key={id}
            className="premium-context-metric"
            data-context-metric={id}
            data-tone={tone}
            data-state={state}
          >
            <img loading="lazy" src={art} alt="" aria-hidden="true" />
            <div className="premium-context-metric-icon" aria-hidden="true">
              {id === 'routes' ? <MapPinned /> : <Icon />}
            </div>
            <div className="premium-context-metric-copy">
              <strong>{value}</strong>
              <span>{label}</span>
              <small>{detail}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
