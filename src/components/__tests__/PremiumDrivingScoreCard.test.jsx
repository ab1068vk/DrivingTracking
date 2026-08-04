import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PremiumDrivingScoreCard, { buildPremiumDrivingScoreSummary } from '@/components/PremiumDrivingScoreCard';

describe('buildPremiumDrivingScoreSummary', () => {
  it('uses only valid real score points and derives recent peak, range, latest, and delta', () => {
    expect(buildPremiumDrivingScoreSummary([
      { i: 0, score: null },
      { i: 1, score: 72 },
      { i: 2, score: '84.4' },
      { i: 3, score: 79 },
      { i: 4, score: Number.NaN },
    ])).toEqual({
      chartData: [
        { i: 1, score: 72 },
        { i: 2, score: 84.4 },
        { i: 3, score: 79 },
      ],
      delta: 7,
      latest: 79,
      low: 72,
      peak: 84.4,
      scoredTripCount: 3,
    });
  });

  it('clamps out-of-domain scores and leaves an empty series unavailable', () => {
    expect(buildPremiumDrivingScoreSummary([{ score: -4 }, { score: 112 }])).toMatchObject({
      delta: 100,
      latest: 100,
      low: 0,
      peak: 100,
      scoredTripCount: 2,
    });
    expect(buildPremiumDrivingScoreSummary([{ score: undefined }, { score: 'invalid' }])).toEqual({
      chartData: [],
      delta: null,
      latest: null,
      low: null,
      peak: null,
      scoredTripCount: 0,
    });
  });
});

describe('PremiumDrivingScoreCard', () => {
  it('renders calculated values, generated metric artwork, evidence, and approximate labeling', () => {
    const html = renderToStaticMarkup(
      <PremiumDrivingScoreCard
        avgScore={81}
        evidence="developing"
        scoreTrend={[{ i: 0, score: 72 }, { i: 1, score: 84 }, { i: 2, score: 79 }]}
        tripCount={5}
        showApproximateTag
      />
    );

    expect(html).toContain('class="premium-driving-score"');
    expect(html).toContain('Performance');
    expect(html).toContain('Telemetry');
    expect(html).toContain('Last 5 trips');
    expect(html).toContain('Limited evidence');
    expect(html).toContain('Average driving score: ~81 out of 100. Limited evidence.');
    expect(html).toContain('approximate');
    expect(html).toContain('Latest');
    expect(html).toContain('~79');
    expect(html).toContain('Recent peak');
    expect(html).toContain('~84');
    expect(html).toContain('Observed range');
    expect(html).toContain('~72–84');
    expect(html).toContain('premium-driving-score-hero-v2.webp');
    expect(html).toContain('premium-driving-score-trend-v2.webp');
    expect(html).toContain('premium-driving-score-peak-v3.webp');
    expect(html).toContain('premium-driving-score-range-v3.webp');
    expect(html).toContain('data-telemetry-icon="performance-gauge-alert"');
    expect(html).toContain('data-telemetry-icon="performance-gauge"');
    expect(html).toContain('data-telemetry-icon="trajectory-route"');
    expect(html).toContain('data-telemetry-icon="summit-flag"');
    expect(html).toContain('data-telemetry-icon="range-sliders"');
    expect(html).toContain('premium-telemetry-header-gauge-generated.webp');
    expect(html).toContain('premium-telemetry-performance-gauge-generated.webp');
    expect(html).toContain('premium-telemetry-trajectory-generated.webp');
    expect(html).toContain('premium-telemetry-summit-generated-v3.webp');
    expect(html).toContain('premium-telemetry-sliders-generated-v2.webp');
    expect(html).toContain('premium-driving-score-gauge-outer-rim');
    expect(html).toContain('premium-driving-score-gauge-rim-inset');
    expect(html).toContain('premium-driving-score-gauge-inner-rim');
    expect(html).toContain('premium-driving-score-gauge-value-glow');
    expect(html).toContain('premium-driving-score-gauge-sheen');
    expect(html).not.toContain('premium-driving-score-grid');
    expect(html).not.toContain('lucide-award');
    expect(html).toContain('stroke-dasharray="81 19"');
  });

  it('preserves empty and loading states without demonstration values', () => {
    const emptyHtml = renderToStaticMarkup(<PremiumDrivingScoreCard tripCount={0} />);
    expect(emptyHtml).toContain('Complete more trips to see trend');
    expect(emptyHtml).toContain('0/3 scored trips ready');
    expect(emptyHtml).toContain('No scored trips yet');
    expect(emptyHtml).toContain('Awaiting evidence');
    expect(emptyHtml).not.toContain('stroke-dasharray=');

    const loadingHtml = renderToStaticMarkup(<PremiumDrivingScoreCard isLoading />);
    expect(loadingHtml).toContain('Loading driving score');
    expect(loadingHtml).not.toContain('Recent peak');
  });
});
