// @ts-check
import {
  BarChart3,
  Clock3,
  CloudSun,
  MoonStar,
  ShieldCheck,
  Sun,
  Sunset,
} from 'lucide-react';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import premiumPressureWindowsHero from '@/assets/premium-pressure-windows-hero.webp';
import premiumPressureWindowMorning from '@/assets/premium-pressure-window-morning.webp';
import premiumPressureWindowAfternoon from '@/assets/premium-pressure-window-afternoon.webp';
import premiumPressureWindowEvening from '@/assets/premium-pressure-window-evening.webp';
import premiumPressureWindowNight from '@/assets/premium-pressure-window-night.webp';

const WINDOW_PRESENTATION = Object.freeze({
  morning: { art: premiumPressureWindowMorning, icon: Sun },
  afternoon: { art: premiumPressureWindowAfternoon, icon: CloudSun },
  evening: { art: premiumPressureWindowEvening, icon: Sunset },
  night: { art: premiumPressureWindowNight, icon: MoonStar },
});

const PRESSURE_LABELS = Object.freeze({
  high: 'High',
  learning: 'Learning',
  low: 'Low',
  medium: 'Medium',
});

const DAY_LABELS = Object.freeze({
  Fri: 'Friday',
  Mon: 'Monday',
  Sat: 'Saturday',
  Sun: 'Sunday',
  Thu: 'Thursday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
});

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function pressureTone(avgScore, events, trips) {
  if (avgScore == null) return 'learning';
  const eventsPerTrip = trips > 0 ? events / trips : 0;
  if (avgScore < 70 || eventsPerTrip >= 4) return 'high';
  if (avgScore < 85 || eventsPerTrip >= 1) return 'medium';
  return 'low';
}

/**
 * Builds display-only labels from the live time-of-day and weekday analysis.
 * @param {Array<Record<string, any>>} timeOfDay
 * @param {Record<string, any>|null} weakestDay
 */
export function buildPremiumPressureWindowsViewModel(timeOfDay = [], weakestDay = null) {
  const windows = (Array.isArray(timeOfDay) ? timeOfDay : []).map((row) => {
    const presentation = WINDOW_PRESENTATION[row?.id] || WINDOW_PRESENTATION.night;
    const trips = Math.max(0, Math.trunc(finiteNumber(row?.trips) ?? 0));
    const events = Math.max(0, Math.trunc(finiteNumber(row?.events) ?? 0));
    const avgScore = finiteNumber(row?.avgScore);
    const tone = pressureTone(avgScore, events, trips);

    return {
      art: presentation.art,
      avgScore,
      events,
      eventText: `${events} risk event${events === 1 ? '' : 's'}`,
      Icon: presentation.icon,
      id: row?.id || 'night',
      label: row?.label || 'Time window',
      pressureLabel: PRESSURE_LABELS[tone],
      range: row?.range || '',
      scoreText: formatEstimatedScore(avgScore, { empty: '\u2014' }),
      tone,
      trips,
      tripText: `${trips} trip${trips === 1 ? '' : 's'}`,
    };
  });

  const weakestDayScore = finiteNumber(weakestDay?.avgScore);
  const weakestDayName = DAY_LABELS[weakestDay?.day] || weakestDay?.day || '';
  const hasWeakestDay = Boolean(weakestDayName && weakestDayScore != null);

  return {
    insight: hasWeakestDay
      ? {
        kind: 'ready',
        day: weakestDayName,
        score: formatEstimatedScore(weakestDayScore),
      }
      : {
        kind: 'learning',
        text: 'Complete at least two scored trips on the same weekday to unlock your weekday comparison.',
      },
    windows,
  };
}

/**
 * @param {{
 *  timeOfDay?: Array<Record<string, any>>,
 *  weakestDay?: Record<string, any>|null,
 * }} props
 */
export default function PremiumPressureWindowsCard({
  timeOfDay = [],
  weakestDay = null,
}) {
  const model = buildPremiumPressureWindowsViewModel(timeOfDay, weakestDay);

  return (
    <section className="premium-pressure-windows" aria-labelledby="premium-pressure-windows-title">
      <img loading="lazy"
        className="premium-pressure-windows-hero"
        src={premiumPressureWindowsHero}
        alt=""
        aria-hidden="true"
      />
      <div className="premium-pressure-windows-grid" aria-hidden="true" />

      <header className="premium-pressure-windows-header">
        <div className="premium-pressure-windows-kicker"><Clock3 /> Pressure windows</div>
        <h2 id="premium-pressure-windows-title">Personal time pattern</h2>
        <p>Your daily risk overview across time</p>
      </header>

      <div className="premium-pressure-window-list">
        {model.windows.map((window) => {
          const WindowIcon = window.Icon;
          return (
            <article
              key={window.id}
              className="premium-pressure-window"
              data-window={window.id}
              data-pressure={window.tone}
              data-sampled={window.avgScore == null ? 'false' : 'true'}
              aria-label={`${window.label}${window.range ? `, ${window.range}` : ''}: ${window.tripText}, ${window.eventText}, estimated average score ${window.avgScore == null ? 'still learning' : window.scoreText}, ${window.pressureLabel.toLowerCase()} pressure`}
            >
              <img loading="lazy" src={window.art} alt="" aria-hidden="true" />
              <div className="premium-pressure-window-veil" aria-hidden="true" />
              <div className="premium-pressure-window-icon" aria-hidden="true"><WindowIcon /></div>

              <div className="premium-pressure-window-copy">
                <h3>{window.label}</h3>
                <strong>{window.tripText}</strong>
                <div
                  className="premium-pressure-window-events"
                  data-empty={window.events === 0 ? 'true' : 'false'}
                >
                  <ShieldCheck aria-hidden="true" />
                  <span>{window.eventText}</span>
                </div>
              </div>

              <div className="premium-pressure-window-score">
                <strong>{window.scoreText}</strong>
                <em>{window.pressureLabel}</em>
              </div>
            </article>
          );
        })}
      </div>

      <div className="premium-pressure-windows-insight" aria-live="polite">
        <span aria-hidden="true"><BarChart3 /></span>
        {model.insight.kind === 'ready' ? (
          <p>
            Your weakest sufficiently sampled day is <strong>{model.insight.day}</strong>,
            {' '}averaging <strong>{model.insight.score}</strong>.
          </p>
        ) : (
          <p>{model.insight.text}</p>
        )}
      </div>
    </section>
  );
}
