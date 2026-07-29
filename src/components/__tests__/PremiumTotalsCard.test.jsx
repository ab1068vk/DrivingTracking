import { describe, expect, it } from 'vitest';
import {
  buildPremiumBaselineViewModel,
  buildPremiumTotals,
  default as PremiumTotalsCard,
  PremiumBaselineCard,
} from '@/components/PremiumTotalsCard';
import PremiumEventSummary, { buildPremiumEventSummary } from '@/components/PremiumEventSummary';
import { renderToStaticMarkup } from 'react-dom/server';

const NOW = new Date('2026-07-16T12:00:00Z').getTime();

function trip({ daysAgo, distanceKm, durationSeconds }) {
  return {
    start_time: new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    distance_km: distanceKm,
    duration_seconds: durationSeconds,
  };
}

describe('buildPremiumTotals', () => {
  const trips = [
    trip({ daysAgo: 1, distanceKm: 12.5, durationSeconds: 1800 }),
    trip({ daysAgo: 1, distanceKm: 7.5, durationSeconds: 1200 }),
    trip({ daysAgo: 5, distanceKm: 30, durationSeconds: 3600 }),
    trip({ daysAgo: 12, distanceKm: 50, durationSeconds: 5400 }),
  ];

  it('summarizes all recorded trips and unique active days', () => {
    expect(buildPremiumTotals(trips, 'all_time', NOW)).toEqual({
      activeDays: 3,
      averageDistanceKm: 25,
      distanceKm: 100,
      durationSeconds: 12000,
      longestDistanceKm: 50,
      tripCount: 4,
    });
  });

  it('limits the seven-day view without double-counting an active day', () => {
    expect(buildPremiumTotals(trips, 'seven_days', NOW)).toEqual({
      activeDays: 2,
      averageDistanceKm: 50 / 3,
      distanceKm: 50,
      durationSeconds: 6600,
      longestDistanceKm: 30,
      tripCount: 3,
    });
  });

  it('treats invalid dates and negative totals as zero', () => {
    expect(buildPremiumTotals([{ start_time: 'invalid', distance_km: -5, duration_seconds: -1 }], 'all_time', NOW)).toEqual({
      activeDays: 0,
      averageDistanceKm: 0,
      distanceKm: 0,
      durationSeconds: 0,
      longestDistanceKm: 0,
      tripCount: 0,
    });
  });

  it('matches the dashboard rules for future, incomplete, and timestamp-derived trips', () => {
    expect(buildPremiumTotals([
      {
        status: 'completed',
        start_time: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(NOW - 60 * 60 * 1000).toISOString(),
        distance_km: 20,
      },
      {
        status: 'active',
        start_time: new Date(NOW - 60 * 60 * 1000).toISOString(),
        distance_km: 80,
        duration_seconds: 3600,
      },
      {
        status: 'completed',
        start_time: new Date(NOW + 60 * 60 * 1000).toISOString(),
        distance_km: 40,
        duration_seconds: 1800,
      },
    ], 'seven_days', NOW)).toEqual({
      activeDays: 1,
      averageDistanceKm: 20,
      distanceKm: 20,
      durationSeconds: 3600,
      longestDistanceKm: 20,
      tripCount: 1,
    });
  });
});

describe('PremiumTotalsCard', () => {
  it('renders the generated scene for every live metric and exposes both period controls', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard
        trips={[trip({ daysAgo: 1, distanceKm: 12.5, durationSeconds: 1800 })]}
        units="metric"
      />,
    );

    expect(html).toContain('class="premium-totals-card"');
    expect(html).toContain('data-period="all_time"');
    expect(html).toContain('premium-totals-hero-v2.webp');
    expect(html).toContain('premium-totals-distance-v2.webp');
    expect(html).toContain('premium-totals-duration-v2.webp');
    expect(html).toContain('premium-totals-trips-v2.webp');
    expect(html).toContain('premium-totals-days-v4.webp');
    expect(html).toContain('premium-totals-average-v2.webp');
    expect(html).toContain('premium-totals-longest-v2.webp');
    expect(html).toContain('aria-label="Totals period"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Distance: 12.5 km. completed trips"');
    expect(html.match(/class="premium-metric"/g)).toHaveLength(6);
  });

  it('keeps zero-data values readable without inventing activity', () => {
    const html = renderToStaticMarkup(<PremiumTotalsCard trips={[]} units="imperial" />);

    expect(html).toContain('data-empty="true"');
    expect(html).toContain('Distance: 0.0 mi. completed trips');
    expect(html).toContain('Time driving: 0m. recorded time');
    expect(html).toContain('Active days: 0. no driving days');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });
});

describe('PremiumBaselineCard', () => {
  const baseline = {
    baseline_avg: 82,
    baseline_trip_count: 14,
    delta: 5,
    percentile: 75,
    percentile_min_weeks: 4,
    this_week_avg: 87,
    trend: 'improving',
    weeks_analyzed: 8,
  };
  const peakStress = {
    insufficient_data: false,
    off_peak_trip_count: 11,
    peak_stress_label: 'consistent',
    peak_trip_count: 6,
  };

  it('derives every premium label from live baseline evidence', () => {
    expect(buildPremiumBaselineViewModel(baseline, '76-91', peakStress)).toMatchObject({
      baselineMeta: '14 recent scored trips',
      baselineRange: '76-91',
      baselineScoreLabel: '82',
      baselineValue: '82 (76-91)',
      deltaLabel: '+5 vs baseline',
      percentileMeta: '8 scored weeks analyzed',
      percentileProgress: 75,
      percentileValue: '75%',
      scoreDegrees: 234.9,
      scoreLabel: '87',
      stressLabel: 'consistent',
      stressMeta: '6 peak / 11 off-peak trips',
      stressTone: 'safe',
      tone: 'improving',
    });
  });

  it('renders all four illustrated metric cards with accessible live values', () => {
    const html = renderToStaticMarkup(
      <PremiumBaselineCard
        baseline={baseline}
        baselineRangeLabel="76-91"
        baselineText="Approximate baseline: 82. This week is +5."
        peakStress={peakStress}
      />,
    );

    expect(html).toContain('class="premium-baseline-card"');
    expect(html).toContain('data-tone="improving"');
    expect(html).toContain('aria-label="This week score: 87. +5 vs baseline"');
    expect(html).toContain('aria-label="Approximate personal baseline: 82 (76-91). 14 recent scored trips"');
    expect(html).toContain('aria-label="Personal percentile: 75%. 8 scored weeks analyzed"');
    expect(html).toContain('aria-label="Rush hour behaviour: consistent. 6 peak / 11 off-peak trips"');
    expect(html).toContain('data-icon="safe"');
    expect(html).toContain('data-scene="safe"');
    expect(html).toContain('class="premium-baseline-stress-state-art"');
    expect(html.match(/class="premium-baseline-art(?: |")/g)).toHaveLength(4);
    expect(html).toContain('class="premium-baseline-hero"');
    expect(html).toContain('aria-label="75% of personal percentile scale"');
    expect(html).toContain('style="width:75%"');
    expect(html).not.toContain('Recent baseline trend');
  });

  it('keeps empty and learning states explicit without inventing values', () => {
    const model = buildPremiumBaselineViewModel({
      baseline_avg: null,
      baseline_trip_count: 3,
      delta: null,
      percentile: null,
      percentile_min_weeks: 4,
      this_week_avg: null,
      trend: 'unknown',
      weeks_analyzed: 1,
    }, '', {
      insufficient_data: true,
      peak_stress_label: 'insufficient off-peak data',
    });

    expect(model).toMatchObject({
      baselineMeta: '3/10 recent scored trips',
      baselineRange: '',
      baselineScoreLabel: 'Building',
      baselineValue: 'Building',
      delta: null,
      deltaLabel: 'Building comparison',
      percentileMeta: 'Needs 4 scored weeks',
      percentileProgress: 0,
      percentileValue: '—',
      score: null,
      scoreLabel: '—',
      stressMeta: 'Needs peak and off-peak trips',
      stressTone: 'learning',
      tone: 'learning',
      trendLabel: 'Building',
    });
  });

  it.each([
    ['improving', 'Improving'],
    ['steady', 'Steady'],
    ['declining', 'Declining'],
    ['unknown', 'Building'],
  ])('maps the live %s trend to the matching premium state', (trend, trendLabel) => {
    const model = buildPremiumBaselineViewModel({ ...baseline, trend }, '76-91', peakStress);
    expect(model).toMatchObject({
      tone: trend === 'unknown' ? 'learning' : trend,
      trendLabel,
    });
  });

  it.each([
    ['consistent', false, 'safe'],
    ['slightly stressed', false, 'caution'],
    ['traffic-affected', false, 'warning'],
    ['significantly stressed', false, 'alert'],
    ['insufficient off-peak data', true, 'learning'],
  ])('maps live rush-hour state %s to its semantic 3D icon', (peakStressLabel, insufficientData, tone) => {
    const livePeakStress = {
      insufficient_data: insufficientData,
      off_peak_trip_count: 11,
      peak_stress_label: peakStressLabel,
      peak_trip_count: 6,
    };
    const model = buildPremiumBaselineViewModel(baseline, '76-91', livePeakStress);
    const html = renderToStaticMarkup(
      <PremiumBaselineCard
        baseline={baseline}
        baselineRangeLabel="76-91"
        baselineText="Approximate baseline: 82. This week is +5."
        peakStress={livePeakStress}
      />,
    );

    expect(model.stressTone).toBe(tone);
    expect(html).toContain(`data-icon="${tone}"`);
    expect(html).toContain(`data-scene="${tone}"`);
    expect(html).toContain(`premium-baseline-stress-scene-${tone}-v1.jpg`);
    expect(html).toContain('class="premium-baseline-stress-state-art"');
  });

  it('preserves long labels and large evidence counts without abbreviating live data', () => {
    const model = buildPremiumBaselineViewModel({
      baseline_avg: 100,
      baseline_includes_older_scores: true,
      baseline_trip_count: 1234567,
      delta: -100,
      percentile: 100,
      percentile_min_weeks: 4,
      this_week_avg: 0,
      trend: 'declining',
      weeks_analyzed: 123456,
    }, 'older scores use a different scoring version and remain approximate', {
      insufficient_data: false,
      off_peak_trip_count: 7654321,
      peak_stress_label: 'significantly stressed',
      peak_trip_count: 1234567,
    });

    expect(model.baselineValue).toContain('older scores use a different scoring version');
    expect(model.percentileMeta).toBe('123456 scored weeks analyzed');
    expect(model.stressMeta).toBe('1234567 peak / 7654321 off-peak trips');
    expect(model.stressLabel).toBe('significantly stressed');
  });

  it('clamps dynamic score and percentile visuals to their real display scales', () => {
    const model = buildPremiumBaselineViewModel({
      baseline_avg: 104,
      baseline_trip_count: 12,
      delta: -150,
      percentile: 140,
      percentile_min_weeks: 4,
      this_week_avg: -20,
      trend: 'declining',
      weeks_analyzed: 5,
    }, '98-108', peakStress);

    expect(model.score).toBe(0);
    expect(model.scoreLabel).toBe('-20');
    expect(model.scoreDegrees).toBe(0);
    expect(model.percentileValue).toBe('140%');
    expect(model.percentileProgress).toBe(100);
  });

  it.each([
    [0, 0],
    [42, 42],
    [140, 100],
  ])('renders a live %s percentile with a %s percent responsive bar fill', (percentile, expectedFill) => {
    const html = renderToStaticMarkup(
      <PremiumBaselineCard
        baseline={{ ...baseline, percentile }}
        baselineRangeLabel="76-91"
        baselineText="Live baseline summary"
        peakStress={peakStress}
      />,
    );

    expect(html).toContain(`style="width:${expectedFill}%"`);
  });
});

describe('PremiumEventSummary', () => {
  const eventTrips = [
    { harsh_brakes_count: 1, rapid_accel_count: 2, sharp_turns_count: 3, speeding_events_count: 4 },
    { harsh_brakes_count: '2', rapid_accel_count: null, sharp_turns_count: -5, speeding_events_count: 1.8 },
    { harsh_brakes_count: Number.NaN, rapid_accel_count: 3, sharp_turns_count: 2, speeding_events_count: undefined },
  ];

  it('sums live event counts and normalizes invalid values', () => {
    expect(buildPremiumEventSummary(eventTrips)).toEqual({
      harshBrakes: 3,
      rapidAccel: 5,
      sharpTurns: 5,
      speeding: 5,
    });
  });

  it('renders the four accessible event cards with calculated values', () => {
    const html = renderToStaticMarkup(<PremiumEventSummary trips={eventTrips} />);

    expect(html).toContain('class="premium-event-summary"');
    expect(html).toContain('aria-label="Harsh Brakes: 3"');
    expect(html).toContain('aria-label="Rapid Accel: 5"');
    expect(html).toContain('aria-label="Sharp Turns: 5"');
    expect(html).toContain('aria-label="Speeding: 5"');
  });
});
