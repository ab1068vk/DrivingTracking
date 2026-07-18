import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildPremiumWeeklyGoals,
  premiumWeeklyCardTone,
  PremiumWeeklyGoalsCard,
  PremiumWeeklyInsightCards,
} from '@/components/PremiumWeeklyDriverGoals';

const evidence = {
  trips: 2,
  distance_km: 20,
  minimum_trips: 4,
  minimum_distance_km: 40,
};

describe('buildPremiumWeeklyGoals', () => {
  it('derives progress, semantic state, and values from live goals', () => {
    const goals = buildPremiumWeeklyGoals([
      { id: 'harsh_brakes', label: 'Harsh brakes', value: 1, target: 5, direction: 'under', qualified: true, met: true },
      { id: 'avg_score', label: 'Average score', value: 63, target: 80, direction: 'over', qualified: true, met: false },
      { id: 'night_distance', label: 'Night distance', value: 8, target: 20, unit: 'km', direction: 'under', qualified: false, met: false, evidence },
    ]);

    expect(goals[0]).toMatchObject({ progress: 100, tone: 'met', valueLabel: '1/5' });
    expect(goals[1]).toMatchObject({ progress: 78.75, tone: 'attention', valueLabel: '63/80+' });
    expect(goals[2]).toMatchObject({ progress: 50, tone: 'building', statusLabel: 'Building evidence' });
    expect(goals[2].valueLabel).toBe('2/4 trips · 20.0 km / 40.0 km');
  });

  it('converts the live night-distance evidence and target for imperial units', () => {
    const [goal] = buildPremiumWeeklyGoals([
      { id: 'night_distance', label: 'Night distance', value: 10, target: 20, unit: 'km', direction: 'under', qualified: true, met: true },
    ], 'imperial');

    expect(goal.valueLabel).toBe('6.2 mi / 12.4 mi');
  });

  it('clamps malformed and large values without inventing demonstration data', () => {
    const [goal] = buildPremiumWeeklyGoals([
      { id: 'speeding', label: 'Speeding events', value: 1000000, target: 3, direction: 'under', qualified: true, met: false },
    ]);

    expect(goal.progress).toBeCloseTo(0.0003);
    expect(goal.valueLabel).toBe('1000000/3');
  });
});

describe('premiumWeeklyCardTone', () => {
  it('uses a success treatment only when every weekly goal is met', () => {
    expect(premiumWeeklyCardTone([
      { met: true, tone: 'met' },
      { met: true, tone: 'met' },
    ])).toBe('complete');
    expect(premiumWeeklyCardTone([
      { met: true, tone: 'met' },
      { met: false, tone: 'attention' },
    ])).toBe('attention');
  });

  it('keeps evidence-building goals visually distinct from failed goals', () => {
    expect(premiumWeeklyCardTone([{ met: false, tone: 'building' }])).toBe('building');
    expect(premiumWeeklyCardTone([])).toBe('building');
  });
});

describe('premium weekly driver cards', () => {
  it('renders all goal rows with accessible live progress and generated artwork', () => {
    const goals = [
      { id: 'harsh_brakes', label: 'Harsh brakes', value: 0, target: 5, direction: 'under', qualified: true, met: true },
      { id: 'speeding', label: 'Speeding events', value: 2, target: 3, direction: 'under', qualified: true, met: true },
      { id: 'avg_score', label: 'Average score', value: 79, target: 80, direction: 'over', qualified: true, met: false },
      { id: 'night_distance', label: 'Night distance', value: 0, target: 20, unit: 'km', direction: 'under', qualified: true, met: true },
      { id: 'night_trips', label: 'Night trips', value: 0, target: 3, direction: 'under', qualified: true, met: true },
    ];
    const html = renderToStaticMarkup(<PremiumWeeklyGoalsCard goals={goals} />);

    expect(html).toContain('class="premium-weekly-goals-card"');
    expect(html).toContain('data-tone="attention"');
    expect(html).toContain('Focus needed');
    expect(html).toContain('premium-weekly-goals-telemetry.png');
    expect(html.match(/class="premium-weekly-goal-glyph"/g)).toHaveLength(5);
    expect(html).toContain('lucide-disc3');
    expect(html).toContain('lucide-gauge');
    expect(html).toContain('lucide-chart-no-axes-column-increasing');
    expect(html).toContain('lucide-route');
    expect(html).toContain('lucide-car-front');
    expect(html.match(/lucide-moon-star/g)).toHaveLength(2);
    expect(html.match(/role="progressbar"/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Average score: 79/80+. Needs attention"');
    expect(html).toContain('0 m / 20.0 km');
  });

  it('changes the panel emblem and border state when every live goal is met', () => {
    const goals = [
      { id: 'harsh_brakes', label: 'Harsh brakes', value: 0, target: 5, direction: 'under', qualified: true, met: true },
      { id: 'speeding', label: 'Speeding events', value: 0, target: 3, direction: 'under', qualified: true, met: true },
      { id: 'avg_score', label: 'Average score', value: 91, target: 80, direction: 'over', qualified: true, met: true },
      { id: 'night_distance', label: 'Night distance', value: 0, target: 20, unit: 'km', direction: 'under', qualified: true, met: true },
      { id: 'night_trips', label: 'Night trips', value: 0, target: 3, direction: 'under', qualified: true, met: true },
    ];
    const html = renderToStaticMarkup(<PremiumWeeklyGoalsCard goals={goals} />);

    expect(html).toContain('data-tone="complete"');
    expect(html).toContain('All goals met');
    expect(html.match(/data-tone="met"/g)).toHaveLength(5);
  });

  it.each([
    ['low', 'LOW', 0],
    ['medium', 'MEDIUM', 1],
    ['high', 'HIGH', 4],
  ])('renders the computed %s fatigue state instead of a fixed example', (level, label, count) => {
    const html = renderToStaticMarkup(
      <PremiumWeeklyInsightCards
        fatigueRisk={{ level, long_trip_count: count }}
        noHarshBrakeStreak={123456}
      />,
    );

    expect(html).toContain(`data-risk="${level}"`);
    expect(html).toContain(`>${label}</strong>`);
    expect(html).toContain(`${count} long ${count === 1 ? 'drive' : 'drives'} this week`);
    expect(html).toContain('123456');
    expect(html).toContain('premium-smooth-braking-road-v2.png');
    expect(html).toContain('premium-fatigue-risk-shield.png');
    expect(html).not.toContain('premium-weekly-insight-icon');
  });
});
