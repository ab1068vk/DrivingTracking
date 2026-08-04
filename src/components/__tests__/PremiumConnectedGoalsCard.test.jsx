import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumConnectedGoalsCard, {
  buildPremiumConnectedGoals,
  connectedGoalMetricProgress,
  connectedGoalsSummary,
} from '@/components/PremiumConnectedGoalsCard';

const goal = (overrides = {}) => ({
  id: 'harsh_brakes',
  label: 'Harsh brakes',
  value: 1,
  target: 5,
  direction: 'under',
  qualified: true,
  met: true,
  status: 'met',
  evidence: {
    qualified: true,
    trips: 4,
    distance_km: 50,
    minimum_trips: 3,
    minimum_distance_km: 25,
  },
  ...overrides,
});

describe('PremiumConnectedGoalsCard', () => {
  it('uses live goal values, semantic states, progress, and imperial units', () => {
    const rows = buildPremiumConnectedGoals([
      goal(),
      goal({ id: 'avg_score', label: 'Average score', value: 76, target: 80, direction: 'over', met: false, status: 'needs_attention' }),
      goal({ id: 'night_distance', label: 'Night distance', value: 10, target: 20, unit: 'km' }),
    ], 'imperial');

    expect(rows[0]).toMatchObject({ valueLabel: '1 / 5', progress: 20, tone: 'met' });
    expect(rows[1]).toMatchObject({ valueLabel: '76 / 80+', progress: 95, tone: 'attention' });
    expect(rows[2].valueLabel).toBe('6.2 mi / 12.4 mi');
    expect(connectedGoalsSummary(rows)).toMatchObject({ tone: 'attention', label: '1 goal needs focus' });
  });

  it('renders every real weekly goal with distinct generated artwork and accessible progress', () => {
    const goals = [
      goal(),
      goal({ id: 'speeding', label: 'Speeding events', value: 2, target: 3 }),
      goal({ id: 'avg_score', label: 'Average score', value: 91, target: 80, direction: 'over' }),
      goal({ id: 'night_distance', label: 'Night distance', value: 4.5, target: 20, unit: 'km' }),
      goal({ id: 'night_trips', label: 'Night trips', value: 1, target: 3 }),
    ];
    const html = renderToStaticMarkup(<PremiumConnectedGoalsCard goals={goals} />);

    expect(html).toContain('class="premium-connected-goals group"');
    expect(html).toContain('data-tone="complete"');
    expect(html).toContain('premium-connected-goals-hero.webp');
    expect(html).toContain('premium-connected-goal-harsh-brakes-v2.webp');
    expect(html).toContain('premium-connected-goal-speeding-v2.webp');
    expect(html).toContain('premium-connected-goal-score-v2.webp');
    expect(html).toContain('premium-connected-goal-night-distance-v2.webp');
    expect(html).toContain('premium-connected-goal-night-trips-v2.webp');
    expect(html).toContain('data-art="braking"');
    expect(html).toContain('data-art="speeding"');
    expect(html).toContain('data-art="score"');
    expect(html).toContain('data-art="night-distance"');
    expect(html).toContain('data-art="night-trips"');
    expect(html.match(/role="progressbar"/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Average score: 91 / 80+. Goal met"');
    expect(html).toContain('All weekly goals met');
  });

  it('sizes each progress bar from its calculated live value', () => {
    const html = renderToStaticMarkup(
      <PremiumConnectedGoalsCard
        goals={[
          goal({
            id: 'avg_score',
            label: 'Average score',
            value: 40,
            target: 80,
            direction: 'over',
            met: false,
            status: 'needs_attention',
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('style="width:50%"');
  });

  it('keeps zero-value bars empty and caps values above target at a full bar', () => {
    const rows = buildPremiumConnectedGoals([
      goal({ value: 0, qualified: false, met: false, status: 'building_evidence' }),
      goal({ id: 'avg_score', label: 'Average score', value: 90, target: 80, direction: 'over' }),
    ]);

    expect(rows[0].progress).toBe(0);
    expect(rows[1].progress).toBe(100);
    expect(connectedGoalMetricProgress({ value: 2, target: 3 })).toBeCloseTo(66.67, 1);

    const zeroHtml = renderToStaticMarkup(<PremiumConnectedGoalsCard goals={[goal({ value: 0 })]} />);
    expect(zeroHtml).toContain('class="is-empty"');
    expect(zeroHtml).toContain('style="width:0%"');
    expect(zeroHtml).toContain('aria-valuenow="0"');
  });

  it('shows real evidence thresholds before qualification and keeps large values wrap-safe', () => {
    const evidence = {
      qualified: false,
      trips: 2,
      distance_km: 19.25,
      minimum_trips: 4,
      minimum_distance_km: 40,
    };
    const html = renderToStaticMarkup(
      <PremiumConnectedGoalsCard
        goals={[
          goal({ qualified: false, met: false, status: 'building_evidence', evidence, value: 123456789, target: 5 }),
        ]}
      />,
    );

    expect(html).toContain('data-tone="building"');
    expect(html).toContain('Building reliable evidence');
    expect(html).toContain('2/4 trips · 19.3 km / 40.0 km');
    expect(html).toContain('123456789 / 5');
    expect(html).toContain('class="premium-connected-goal-copy"');
    expect(html).toContain('premium-connected-goals-atlas.webp');
  });

  it('renders an honest empty state without demonstration metrics', () => {
    const html = renderToStaticMarkup(<PremiumConnectedGoalsCard goals={[]} />);

    expect(html).toContain('Weekly goals will appear here when enough driving data is available.');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('Building weekly evidence');
  });
});
