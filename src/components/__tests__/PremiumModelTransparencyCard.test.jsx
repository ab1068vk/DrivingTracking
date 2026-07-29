import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumModelTransparencyCard, {
  buildPremiumModelTransparencyViewModel,
} from '@/components/PremiumModelTransparencyCard';

describe('buildPremiumModelTransparencyViewModel', () => {
  it('formats the same live metric values used by the standard card', () => {
    expect(buildPremiumModelTransparencyViewModel({
      eligibleTripCount: 62,
      confidence: 0.996,
      distanceKm: 508.94,
      units: 'metric',
    })).toMatchObject({
      confidenceDegrees: 360,
      confidencePercent: 100,
      confidenceValue: '100%',
      distanceValue: '508.9 km',
      tripCount: 62,
      tripValue: '62',
    });
  });

  it('honors unit settings and safely normalizes invalid inputs', () => {
    expect(buildPremiumModelTransparencyViewModel({
      eligibleTripCount: -4,
      confidence: Number.NaN,
      distanceKm: 10,
      units: 'imperial',
    })).toMatchObject({
      confidenceDegrees: 0,
      confidenceValue: '0%',
      distanceValue: '6.2 mi',
      tripCount: 0,
      tripValue: '0',
    });
  });
});

describe('PremiumModelTransparencyCard', () => {
  it('renders all premium artwork and exposes calculated values accessibly', () => {
    const html = renderToStaticMarkup(
      <PremiumModelTransparencyCard
        eligibleTripCount={14}
        confidence={0.7}
        distanceKm={123.45}
        units="metric"
      />,
    );

    expect(html).toContain('class="premium-model-transparency"');
    expect(html).toContain('premium-model-transparency-hero.jpg');
    expect(html).toContain('premium-model-transparency-trips.jpg');
    expect(html).toContain('premium-model-transparency-confidence.jpg');
    expect(html).toContain('premium-model-transparency-distance.jpg');
    expect(html).toContain('aria-label="eligible driver trips: 14"');
    expect(html).toContain('aria-label="habit-model confidence: 70%"');
    expect(html).toContain('aria-label="coaching distance: 123.5 km"');
    expect(html).toContain('--model-confidence:252deg');
    expect(html).toContain('They are not validated collision-risk, medical, legal, or insurance assessments.');
  });

  it('keeps large dynamic values in text instead of raster artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumModelTransparencyCard
        eligibleTripCount={1234567}
        confidence={0.125}
        distanceKm={987654.321}
        units="imperial"
      />,
    );

    expect(html).toContain('1234567');
    expect(html).toContain('13%');
    expect(html).toContain('613699.8 mi');
    expect(html).not.toContain('508.9 km');
  });
});
