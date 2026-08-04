import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PremiumSegmentIntelligenceCard, {
  buildPremiumSegmentViewModel,
  shouldRenderPremiumSegmentIntelligence,
} from '@/components/PremiumSegmentIntelligenceCard';

const route = {
  routeKey: 'route-evening',
  label: 'Evening repeated route',
  lastTripId: 'trip-5',
};

const routes = [
  route,
  { routeKey: 'route-morning', label: 'Morning repeated route', lastTripId: 'trip-3' },
  { routeKey: 'route-other', label: 'Repeated route', lastTripId: 'trip-2' },
];

const insights = {
  tripCount: 5,
  locatedEvents: 7,
  evidenceLevel: 'strong',
  explanation: 'Sections use event positions within matched route replays; they do not infer a road cause.',
  strongestSection: { id: 'middle', eventCount: 5 },
  sections: [
    { id: 'middle', label: 'Middle route', eventCount: 5, repeatRate: 80 },
    { id: 'late', label: 'Late route', eventCount: 1, repeatRate: 20 },
    { id: 'early', label: 'Early route', eventCount: 1, repeatRate: 20 },
  ],
};

describe('PremiumSegmentIntelligenceCard', () => {
  it('renders only for the explicit persisted premium appearance value', () => {
    expect(shouldRenderPremiumSegmentIntelligence(true)).toBe(true);
    expect(shouldRenderPremiumSegmentIntelligence(false)).toBe(false);
    expect(shouldRenderPremiumSegmentIntelligence(undefined)).toBe(false);
    expect(shouldRenderPremiumSegmentIntelligence('true')).toBe(false);
  });

  it('keeps live calculations but presents route sections chronologically', () => {
    expect(buildPremiumSegmentViewModel(insights)).toEqual(expect.objectContaining({
      tripCount: 5,
      locatedEvents: 7,
      evidenceLevel: 'strong',
      sections: [
        expect.objectContaining({ id: 'early', eventCount: 1, repeatRate: 20, isStrongest: false }),
        expect.objectContaining({ id: 'middle', eventCount: 5, repeatRate: 80, isStrongest: true }),
        expect.objectContaining({ id: 'late', eventCount: 1, repeatRate: 20, isStrongest: false }),
      ],
    }));
  });

  it('renders real route controls, evidence values, and distinct generated artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumSegmentIntelligenceCard
        insights={insights}
        onOpenRouteEvidence={vi.fn()}
        onSelectRoute={vi.fn()}
        route={route}
        routes={routes}
      />,
    );

    expect(html).toContain('class="premium-segment-intelligence"');
    expect(html).toContain('premium-segment-intelligence-hero-v1.webp');
    expect(html).toContain('premium-segment-intelligence-early-v1.webp');
    expect(html).toContain('premium-segment-intelligence-middle-v1.webp');
    expect(html).toContain('premium-segment-intelligence-late-v1.webp');
    expect(html).toContain('premium-segment-icon-network-v1.webp');
    expect(html).toContain('premium-segment-icon-arrow-v1.webp');
    expect(html).toContain('premium-segment-icon-evening-v1.webp');
    expect(html).toContain('premium-segment-icon-morning-v1.webp');
    expect(html).toContain('premium-segment-icon-repeat-v1.webp');
    expect(html).toContain('premium-segment-icon-car-v1.webp');
    expect(html).toContain('premium-segment-icon-target-v1.webp');
    expect(html).toContain('premium-segment-icon-shield-v1.webp');
    expect(html).toContain('premium-segment-icon-midday-v1.webp');
    expect(html).toContain('premium-segment-icon-pin-v1.webp');
    expect(html).toContain('Evening repeated route');
    expect(html).toContain('aria-label="Repeated route"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('5 detailed drives');
    expect(html).toContain('7 located events');
    expect(html).toContain('strong evidence');
    expect(html).toContain('Middle route: 5 events, repeated on 80% of detailed drives, highest event count section');
    expect(html).toContain('Open route evidence');
  });

  it('exposes loading and empty states without invented metric values', () => {
    const loadingHtml = renderToStaticMarkup(
      <PremiumSegmentIntelligenceCard
        insights={insights}
        loading
        onOpenRouteEvidence={vi.fn()}
        onSelectRoute={vi.fn()}
        route={route}
        routes={routes}
      />,
    );
    const emptyHtml = renderToStaticMarkup(
      <PremiumSegmentIntelligenceCard
        insights={{ explanation: 'Detailed route-event positions are needed.' }}
        onOpenRouteEvidence={vi.fn()}
        onSelectRoute={vi.fn()}
        route={null}
        routes={[]}
      />,
    );

    expect(loadingHtml).toContain('data-loading="true"');
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain('Loading detailed route evidence');
    expect(emptyHtml).toContain('data-empty="true"');
    expect(emptyHtml).toContain('Choose a repeated route');
    expect(emptyHtml).toContain('Complete the same route twice to unlock section-by-section comparisons.');
    expect(emptyHtml).not.toContain('detailed drives');
  });

  it('hides route switching when an active program locks the context', () => {
    const html = renderToStaticMarkup(
      <PremiumSegmentIntelligenceCard
        insights={insights}
        lockedToActiveProgram
        onOpenRouteEvidence={vi.fn()}
        onSelectRoute={vi.fn()}
        route={route}
        routes={routes}
      />,
    );

    expect(html).not.toContain('aria-label="Repeated route"');
    expect(html).toContain('Evening repeated route');
  });

  it('keeps long route names and large calculated values intact', () => {
    const html = renderToStaticMarkup(
      <PremiumSegmentIntelligenceCard
        insights={{
          ...insights,
          tripCount: 123456,
          locatedEvents: 987654,
          sections: insights.sections.map((section) => ({
            ...section,
            eventCount: section.id === 'middle' ? 543210 : section.eventCount,
          })),
          strongestSection: { id: 'middle', eventCount: 543210 },
        }}
        onOpenRouteEvidence={vi.fn()}
        onSelectRoute={vi.fn()}
        route={{
          ...route,
          label: 'Morning repeated route through a very long translated metropolitan corridor',
        }}
        routes={routes}
      />,
    );

    expect(html).toContain('Morning repeated route through a very long translated metropolitan corridor');
    expect(html).toContain('123456 detailed drives');
    expect(html).toContain('987654 located events');
    expect(html).toContain('Middle route: 543210 events');
  });
});
