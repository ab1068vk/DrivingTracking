// @ts-check
import {
  CircleAlert,
  Disc3,
  Gauge,
  Info,
  Route,
  Zap,
} from 'lucide-react';
import premiumEventScenes from '@/assets/premium-event-scenes.png';

const EVENT_CARDS = Object.freeze([
  {
    id: 'harshBrakes',
    accent: 'red',
    label: 'Harsh Brakes',
    hint: 'Stay smooth, brake early',
    icon: Disc3,
    badge: CircleAlert,
    scenePosition: '0% 0%',
  },
  {
    id: 'rapidAccel',
    accent: 'amber',
    label: 'Rapid Accel',
    hint: 'Good throttle control',
    icon: Gauge,
    badge: Zap,
    scenePosition: '100% 0%',
  },
  {
    id: 'sharpTurns',
    accent: 'blue',
    label: 'Sharp Turns',
    hint: 'Take it wide, drive safe',
    icon: Route,
    scenePosition: '0% 100%',
  },
  {
    id: 'speeding',
    accent: 'orange',
    label: 'Speeding',
    hint: 'Keep it safe, follow limits',
    icon: Gauge,
    scenePosition: '100% 100%',
  },
]);

function eventCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/**
 * @param {Array<Record<string, any>>} trips
 */
export function buildPremiumEventSummary(trips = []) {
  return (trips || []).reduce((totals, trip) => ({
    harshBrakes: totals.harshBrakes + eventCount(trip?.harsh_brakes_count),
    rapidAccel: totals.rapidAccel + eventCount(trip?.rapid_accel_count),
    sharpTurns: totals.sharpTurns + eventCount(trip?.sharp_turns_count),
    speeding: totals.speeding + eventCount(trip?.speeding_events_count),
  }), {
    harshBrakes: 0,
    rapidAccel: 0,
    sharpTurns: 0,
    speeding: 0,
  });
}

/**
 * @param {{ trips?: Array<Record<string, any>> }} props
 */
export default function PremiumEventSummary({ trips = [] }) {
  const totals = buildPremiumEventSummary(trips);

  return (
    <section className="premium-event-summary" aria-labelledby="premium-event-summary-title">
      <div className="premium-event-summary-heading">
        <h2 id="premium-event-summary-title">Event Summary</h2>
        <Info role="img" aria-label="Counts across completed trips" />
      </div>

      <div className="premium-event-grid">
        {EVENT_CARDS.map(({ id, accent, label, hint, icon: Icon, badge: Badge, scenePosition }) => (
          <article
            key={id}
            className="premium-event-card"
            data-accent={accent}
            aria-label={`${label}: ${totals[id]}`}
          >
            <div
              className="premium-event-art"
              aria-hidden="true"
              style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({
                backgroundImage: `url(${premiumEventScenes})`,
                '--event-scene-position': scenePosition,
              })}
            />
            <div className="premium-event-icon" aria-hidden="true">
              <Icon />
              {Badge && <Badge className="premium-event-icon-badge" />}
            </div>
            <div className="premium-event-copy">
              <strong>{totals[id]}</strong>
              <span>{label}</span>
              <small>{hint}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
