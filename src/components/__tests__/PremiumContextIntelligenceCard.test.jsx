import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PremiumContextIntelligenceCard, {
  buildPremiumContextIntelligenceViewModel,
  shouldRenderPremiumContextIntelligence,
} from '@/components/PremiumContextIntelligenceCard';

describe('PremiumContextIntelligenceCard', () => {
  it('renders only for the explicitly enabled premium appearance setting', () => {
    expect(shouldRenderPremiumContextIntelligence(true)).toBe(true);
    expect(shouldRenderPremiumContextIntelligence(false)).toBe(false);
    expect(shouldRenderPremiumContextIntelligence(undefined)).toBe(false);
    expect(shouldRenderPremiumContextIntelligence('true')).toBe(false);
  });

  it('builds measured values from live context evidence', () => {
    const model = buildPremiumContextIntelligenceViewModel({
      routes: [{ id: 'one' }, { id: 'two' }],
      dangerZones: [{ id: 'zone-one' }],
      weakestTime: { id: 'evening', label: 'Evening', avgScore: 64 },
    });

    expect(model.map(({ id, value, detail, state }) => ({ id, value, detail, state }))).toEqual([
      {
        id: 'routes',
        value: '2',
        detail: 'matched by similar start and end areas',
        state: 'measured',
      },
      {
        id: 'event-areas',
        value: '1',
        detail: 'harsh braking, speeding, or sharp-turn clusters',
        state: 'measured',
      },
      {
        id: 'pressure-window',
        value: 'Evening',
        detail: 'average ~64',
        state: 'measured',
      },
    ]);
  });

  it('preserves honest empty states instead of inventing values', () => {
    const model = buildPremiumContextIntelligenceViewModel();

    expect(model[0]).toMatchObject({ value: 'Not enough evidence', state: 'learning' });
    expect(model[1]).toMatchObject({ value: 'Not enough evidence', state: 'learning' });
    expect(model[2]).toMatchObject({
      value: 'Learning',
      detail: 'needs comparable trips',
      state: 'learning',
    });
    expect(model[2].art).toContain('premium-context-intelligence-learning.webp');
  });

  it.each([
    ['morning', 'premium-context-intelligence-morning.webp'],
    ['afternoon', 'premium-context-intelligence-afternoon.webp'],
    ['evening', 'premium-context-intelligence-evening.webp'],
    ['night', 'premium-context-intelligence-night.webp'],
  ])('selects context-correct artwork for the %s pressure window', (id, asset) => {
    const [,, pressureWindow] = buildPremiumContextIntelligenceViewModel({
      weakestTime: { id, label: id, avgScore: 70 },
    });

    expect(pressureWindow.art).toContain(asset);
    expect(pressureWindow.tone).toBe(id);
  });

  it('renders the generated scenes, live evidence, and preserved map control', () => {
    const html = renderToStaticMarkup(
      <PremiumContextIntelligenceCard
        routes={[{ id: 'route' }]}
        dangerZones={[]}
        weakestTime={{ id: 'night', label: 'Night', avgScore: 72 }}
        onOpenMap={vi.fn()}
      />,
    );

    expect(html).toContain('class="premium-context-intelligence"');
    expect(html).toContain('premium-context-intelligence-hero.webp');
    expect(html).toContain('premium-context-intelligence-routes.webp');
    expect(html).toContain('premium-context-intelligence-events.webp');
    expect(html).toContain('premium-context-intelligence-night.webp');
    expect(html).toContain('data-context-metric="routes"');
    expect(html).toContain('data-state="learning"');
    expect(html).toContain('lucide-shield');
    expect(html).toContain('lucide-car-front');
    expect(html).toContain('lucide-moon-star');
    expect(html).toContain('Where and when your driving changes');
    expect(html).toContain('Open map');
    expect(html).toContain('average ~72');
  });
});
