import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumPreTripPlanner from '@/components/PremiumPreTripPlanner';

const baseProps = {
  actions: ['Mount the phone securely.', 'Leave extra following room.'],
  historicalContextEnabled: true,
  historyStatus: 'low context - Personal history looks steady',
  localSpeedEmptyText: 'No saved local speed rules yet.',
  localSpeedItems: [{ key: 'speed-1', title: 'School-zone rule', detail: '300 m away', tone: 'warn' }],
  onDismiss: vi.fn(),
  plannerTone: {
    status: 'Good to go',
    headline: 'Good time to drive',
    guidance: 'Conditions look steady. Mount the phone and keep your usual smooth rhythm.',
  },
  predictiveRouteRisk: {
    insufficientHistory: false,
    riskLevel: 'low',
    riskScore: 18,
    primaryFactor: 'Personal history looks steady',
    safestWindow: 'Current departure window is typical for you.',
    nearbyDangerZoneCount: 1,
    componentBreakdown: [
      { key: 'events', label: 'Driving-event density', detail: 'Few recent events', contribution: 4 },
    ],
  },
  preTripRisk: {
    readinessScore: 82,
    riskLevel: 'low',
    primaryConcern: 'Recent driving trend',
    topSignals: [
      { key: 'trend', label: 'Recent driving trend', tip: 'Begin at a calm pace.', value: 24 },
    ],
  },
  readinessApproximate: true,
  readinessEvidence: 'high',
  routeRiskApproximate: true,
  saferWindow: 'The next hour matches your safer history.',
  scoreText: '82/100',
  watchZoneEmptyText: 'No repeated-event areas are nearby.',
  watchZoneItems: [{ key: 'zone-1', title: 'harsh braking', detail: '240 m away - 3 past events' }],
};

describe('PremiumPreTripPlanner', () => {
  it('renders live readiness data, every nested planning card, and the dismiss control', () => {
    const html = renderToStaticMarkup(<PremiumPreTripPlanner {...baseProps} />);

    expect(html).toContain('class="premium-planner"');
    expect(html).toContain('class="premium-planner-hero-art-shell"');
    expect(html).toContain('class="premium-planner-hero-art"');
    expect(html.match(/class="premium-planner-insight-art"/g)).toHaveLength(4);
    expect(html).toContain('data-risk="low"');
    expect(html).toContain('aria-label="Dismiss readiness card"');
    expect(html).toContain('aria-label="Readiness score 82/100"');
    expect(html).toContain('Before you start');
    expect(html).toContain('Better window');
    expect(html).toContain('Saved speed checks');
    expect(html).toContain('Watch road areas');
    expect(html).toContain('School-zone rule');
    expect(html).toContain('240 m away - 3 past events');
    expect(html).toContain('Risk factors ranked');
    expect(html).toContain('Estimated historical context');
    expect(html).toContain('Driving-event density');
    expect(html).toContain('not validated against collision or casualty outcomes');
  });

  it('uses the real empty, learning, and insufficient-history states without fabricated values', () => {
    const html = renderToStaticMarkup(
      <PremiumPreTripPlanner
        {...baseProps}
        actions={['More trips are needed before personal signals become reliable.']}
        localSpeedItems={[]}
        predictiveRouteRisk={{ ...baseProps.predictiveRouteRisk, insufficientHistory: true }}
        preTripRisk={{
          readinessScore: null,
          riskLevel: 'unavailable',
          primaryConcern: 'Insufficient readiness evidence',
          topSignals: [],
        }}
        scoreText="Learning"
        watchZoneItems={[]}
      />,
    );

    expect(html).toContain('data-risk="unavailable"');
    expect(html).toContain('aria-label="Readiness score learning"');
    expect(html).toContain('No saved local speed rules yet.');
    expect(html).toContain('No repeated-event areas are nearby.');
    expect(html).toContain('Not enough driving history');
    expect(html).toContain('Complete a scored trip with recorded distance');
    expect(html).not.toContain('Estimated historical context');
    expect(html).not.toContain('Signal contributions');
  });

  it('omits historical context when the existing setting disables it and keeps long values intact', () => {
    const longGuidance = 'A deliberately long readiness explanation that must remain available for wrapping on narrow screens without being truncated or replaced.';
    const html = renderToStaticMarkup(
      <PremiumPreTripPlanner
        {...baseProps}
        historicalContextEnabled={false}
        plannerTone={{ ...baseProps.plannerTone, guidance: longGuidance }}
        preTripRisk={{ ...baseProps.preTripRisk, readinessScore: 100, riskLevel: 'low' }}
        scoreText="100/100"
      />,
    );

    expect(html).toContain(longGuidance);
    expect(html).toContain('aria-label="Readiness score 100/100"');
    expect(html).not.toContain('Historical context');
    expect(html).not.toContain('Estimated historical context');
  });
});
