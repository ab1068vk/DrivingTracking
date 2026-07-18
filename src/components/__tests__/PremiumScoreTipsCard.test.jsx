import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PremiumScoreTipsCard, { buildPremiumScoreTipViewModel } from '@/components/PremiumScoreTipsCard';

const tipCases = [
  ['braking', 'Most score loss is coming from harsh braking. Leave a larger following gap and lift off earlier before stops.'],
  ['acceleration', 'Rapid acceleration is your biggest pattern. Try smoother throttle starts to improve smoothness and fuel cost.'],
  ['cornering', 'Sharp turns are showing up most often. Slow before corners, then accelerate after the car is straight.'],
  ['speeding', 'Speeding is your main risk event. Lowering cruise speed is the fastest way to improve safety score.'],
  ['night', 'A large share of trips happen at night, where Road Sage applies extra safety risk. Keep routes familiar and take breaks on longer drives.'],
  ['excellent', 'Your recent average is excellent. Keep the streak going by protecting smooth starts and early braking.'],
  ['focus', 'Focus on one behavior this week instead of all of them. Cutting the top event type will move the score fastest.'],
  ['evidence', 'Not enough data yet. Complete a trip of at least 2 km for coaching tips.'],
];

describe('buildPremiumScoreTipViewModel', () => {
  it.each(tipCases)('maps the real %s tip to distinct artwork and presentation', (tone, tip) => {
    const model = buildPremiumScoreTipViewModel(tip);
    expect(model.id).toBe(tone);
    expect(model.tip).toBe(tip);
    expect(model.artwork).toContain(`premium-score-tip-${tone}.png`);
    expect(model.headline).not.toBe('');
  });

  it('keeps unknown future coaching copy intact with a safe fallback', () => {
    const tip = 'Use the smoother route when conditions change.';
    expect(buildPremiumScoreTipViewModel(tip)).toMatchObject({
      id: 'evidence',
      headline: tip,
      tip,
    });
  });
});

describe('PremiumScoreTipsCard', () => {
  it('renders each selected tip in order with semantic tones, full accessible copy, and generated artwork', () => {
    const tips = [tipCases[3][1], tipCases[6][1], tipCases[4][1]];
    const html = renderToStaticMarkup(<PremiumScoreTipsCard tips={tips} />);

    expect(html).toContain('class="premium-score-tips"');
    expect(html).toContain('Smart driving. Higher score.');
    expect(html).toContain('data-tone="speeding"');
    expect(html).toContain('data-tone="focus"');
    expect(html).toContain('data-tone="night"');
    expect(html).toContain('premium-score-tip-speeding.png');
    expect(html).toContain(`aria-label="${tips[0]}"`);
    expect(html.indexOf('data-tone="speeding"')).toBeLessThan(html.indexOf('data-tone="focus"'));
    expect(html.indexOf('data-tone="focus"')).toBeLessThan(html.indexOf('data-tone="night"'));
    expect(html).toContain('<strong>fastest way</strong>');
    expect(html).toContain('<strong>move the score fastest</strong>');
  });

  it('uses honest loading and empty states without demonstration values', () => {
    const loadingHtml = renderToStaticMarkup(<PremiumScoreTipsCard isLoading />);
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain('Loading personalized score tips');
    expect(loadingHtml).not.toContain('data-tone=');

    const emptyHtml = renderToStaticMarkup(<PremiumScoreTipsCard tips={[]} />);
    expect(emptyHtml).toContain('No coaching priority surfaced');
    expect(emptyHtml).toContain('next eligible trip');
    expect(emptyHtml).not.toContain('data-tone=');
  });
});
