import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumRecentShiftCard, {
  buildPremiumRecentShiftViewModel,
} from '@/components/PremiumRecentShiftCard';

describe('PremiumRecentShiftCard', () => {
  it.each([
    ['normal', 'normal', 'Normal difference from your norm'],
    ['moderate', 'moderate', 'Moderate difference from your norm'],
    ['high', 'high', 'High difference from your norm'],
    ['unknown', 'learning', 'No unusual recent shift'],
  ])('maps the live %s level to the %s premium state', (level, tone, headline) => {
    const model = buildPremiumRecentShiftViewModel({
      anomaly_level: level,
      anomaly_score: 42,
      model_trip_count: 12,
      reasons: [],
    });

    expect(model.tone).toBe(tone);
    expect(model.headline).toBe(headline);
  });

  it('renders the live score, comparison count, unusual signals, and distinct generated artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumRecentShiftCard
        anomaly={{
          anomaly_level: 'moderate',
          anomaly_score: 61.4,
          model_trip_count: 37,
          reasons: ['harsh_per_10km', 'phone_pct', 'smoothness'],
        }}
      />,
    );

    expect(html).toContain('data-tone="moderate"');
    expect(html).toContain('Difference score 61 out of 100');
    expect(html).toContain('37 local trips');
    expect(html).toContain('Braking pattern');
    expect(html).toContain('Phone-use pattern');
    expect(html).toContain('Smoothness');
    expect(html).toContain('premium-recent-shift-route-layer.webp');
    expect(html).toContain('premium-recent-shift-car-layer.webp');
    expect(html).toContain('premium-recent-shift-shield.webp');
  });

  it('uses an explicit learning state without inventing a score or comparison count', () => {
    const model = buildPremiumRecentShiftViewModel(null);
    const html = renderToStaticMarkup(<PremiumRecentShiftCard anomaly={null} />);

    expect(model).toMatchObject({
      comparisonCount: 0,
      comparisonLabel: '0 local trips',
      reasons: [],
      score: null,
      scoreLabel: '—',
      tone: 'learning',
    });
    expect(html).toContain('Still learning your norm');
    expect(html).toContain('Complete more measured trips');
    expect(html).not.toContain('Unusual signals');
    expect(html).not.toContain('aria-hidden="true">~</span>');
  });

  it('clamps malformed future values and keeps unknown reason labels readable', () => {
    const model = buildPremiumRecentShiftViewModel({
      anomaly_level: 'high',
      anomaly_score: 140,
      model_trip_count: -5,
      reasons: ['future_signal_name', null, 'avg_speed', 'extra_signal'],
    });

    expect(model.score).toBe(100);
    expect(model.comparisonCount).toBe(0);
    expect(model.reasons).toHaveLength(3);
    expect(model.reasons[0]).toMatchObject({
      id: 'future_signal_name',
      label: 'future signal name',
    });
  });
});
