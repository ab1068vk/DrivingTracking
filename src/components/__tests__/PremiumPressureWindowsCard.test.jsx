import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumPressureWindowsCard, {
  buildPremiumPressureWindowsViewModel,
} from '@/components/PremiumPressureWindowsCard';

const liveWindows = [
  { id: 'morning', label: 'Morning', range: '5a-12p', trips: 5, events: 0, avgScore: 92 },
  { id: 'afternoon', label: 'Afternoon', range: '12p-5p', trips: 2, events: 2, avgScore: 82 },
  { id: 'evening', label: 'Evening', range: '5p-10p', trips: 4, events: 20, avgScore: 95 },
  { id: 'night', label: 'Night', range: '10p-5a', trips: 1, events: 1, avgScore: null },
];

describe('PremiumPressureWindowsCard', () => {
  it('renders every live window with distinct generated artwork and semantic pressure states', () => {
    const html = renderToStaticMarkup(
      <PremiumPressureWindowsCard
        timeOfDay={liveWindows}
        weakestDay={{ day: 'Wed', trips: 3, events: 6, avgScore: 73 }}
      />,
    );

    expect(html).toContain('premium-pressure-windows-hero.webp');
    expect(html).toContain('premium-pressure-window-morning.webp');
    expect(html).toContain('premium-pressure-window-afternoon.webp');
    expect(html).toContain('premium-pressure-window-evening.webp');
    expect(html).toContain('premium-pressure-window-night.webp');
    expect(html).toContain('data-window="morning" data-pressure="low" data-sampled="true"');
    expect(html).toContain('data-window="afternoon" data-pressure="medium" data-sampled="true"');
    expect(html).toContain('data-window="evening" data-pressure="high" data-sampled="true"');
    expect(html).toContain('data-window="night" data-pressure="learning" data-sampled="false"');
    expect(html).toContain('>5 trips</strong>');
    expect(html).toContain('>0 risk events</span>');
    expect(html).toContain('>~92</strong>');
    expect(html).toContain('Your weakest sufficiently sampled day is <strong>Wednesday</strong>');
    expect(html).toContain('averaging <strong>~73</strong>');
  });

  it('keeps singular labels and real changing values instead of demonstration copy', () => {
    const model = buildPremiumPressureWindowsViewModel([
      { id: 'morning', label: 'Early commute', trips: 1, events: 1, avgScore: 67.6 },
    ], null);
    const html = renderToStaticMarkup(
      <PremiumPressureWindowsCard
        timeOfDay={[{ id: 'morning', label: 'Early commute', trips: 1, events: 1, avgScore: 67.6 }]}
      />,
    );

    expect(model.windows[0]).toMatchObject({
      eventText: '1 risk event',
      label: 'Early commute',
      pressureLabel: 'High',
      scoreText: '~68',
      tripText: '1 trip',
    });
    expect(html).toContain('Early commute');
    expect(html).toContain('>1 trip</strong>');
    expect(html).toContain('>1 risk event</span>');
    expect(html).toContain('>~68</strong>');
  });

  it('uses explicit learning and empty states without inventing scores', () => {
    const model = buildPremiumPressureWindowsViewModel([
      { id: 'night', label: 'Night', trips: -2, events: -4, avgScore: null },
    ], null);
    const html = renderToStaticMarkup(
      <PremiumPressureWindowsCard
        timeOfDay={[{ id: 'night', label: 'Night', trips: 0, events: 0, avgScore: null }]}
      />,
    );

    expect(model.windows[0]).toMatchObject({
      events: 0,
      scoreText: '\u2014',
      tone: 'learning',
      trips: 0,
    });
    expect(model.insight.kind).toBe('learning');
    expect(html).toContain('estimated average score still learning');
    expect(html).toContain('>Learning</em>');
    expect(html).toContain('Complete at least two scored trips on the same weekday');
    expect(html).not.toContain('>~0</strong>');
  });
});
