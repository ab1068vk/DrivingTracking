import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumPreTripPlanner, { getBetterWindowVisualState } from '@/components/PremiumPreTripPlanner';

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
      {
        key: 'events',
        label: 'Driving-event density',
        detail: 'Few recent events',
        normalizedRisk: 32,
        contribution: 4,
      },
    ],
  },
  preTripRisk: {
    readinessScore: 82,
    readinessRange: { low: 76, high: 87 },
    riskLevel: 'low',
    primaryConcern: 'Recent driving trend',
    dataQuality: { confidenceScore: 91 },
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

    expect(html).toContain('class="premium-planner premium-planner-reference"');
    expect(html).toContain('class="premium-planner-hero-art"');
    expect(html).toContain('class="premium-planner-range"');
    expect(html.match(/premium-planner-icon-/g)).toHaveLength(6);
    expect(html).toContain('Likely range');
    expect(html).toContain('76–87');
    expect(html).toContain('91% confidence');
    expect(html.match(/class="premium-planner-insight-art"/g)).toHaveLength(4);
    expect(html).toContain('class="premium-planner-history-art"');
    expect(html).toContain('data-risk="low"');
    expect(html).toContain('aria-label="Dismiss readiness card"');
    expect(html).toContain('aria-label="Readiness score 82/100"');
    expect(html).toContain('<details class="premium-planner-details"><summary>');
    expect(html.indexOf('class="premium-planner-range"')).toBeLessThan(html.indexOf('<details class="premium-planner-details">'));
    expect(html).toContain('Advanced readiness details');
    expect(html).not.toContain('<details class="premium-planner-details" open="">');
    expect(html).toContain('Before you start');
    expect(html).toContain('Better window');
    expect(html).toContain('Saved speed checks');
    expect(html).toContain('Watch road areas');
    expect(html).toContain('School-zone rule');
    expect(html).toContain('240 m away - 3 past events');
    expect(html).toContain('Risk factors ranked');
    expect(html).toContain('Estimated historical context');
    expect(html).toContain('Driving-event density');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="32"');
    expect(html).toContain('style="width:32%"');
    expect(html).toContain('not validated against collision or casualty outcomes');
  });

  it.each([
    ['Current time looks acceptable', 'acceptable'],
    ['Current time looks as good as any upcoming window for you.', 'acceptable'],
    ['After 7 PM or before rush hour', 'recommended'],
    ['Earliest lower-risk pattern recorded: 3:00 AM (3 observations).', 'recommended'],
    ['Late night is higher risk. Consider waiting until daylight or after a proper rest.', 'late-night'],
    ['Lower-risk hours vary; see your trip history for patterns.', 'learning'],
    ['Complete more scored trips before Road Sage can compare departure windows.', 'learning'],
    ['Historical context is disabled in Settings.', 'disabled'],
  ])('selects the %s Better window artwork state', (message, state) => {
    expect(getBetterWindowVisualState(message)).toBe(state);
    const html = renderToStaticMarkup(<PremiumPreTripPlanner {...baseProps} saferWindow={message} />);
    expect(html).toContain(`data-visual-state="${state}"`);
    expect(html).toContain(`premium-planner-${state === 'late-night' ? 'window-late-night' : state === 'acceptable' ? 'window-v2' : `window-${state}-v4`}`);
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
    expect(html).toContain('class="premium-planner-range" data-available="false"');
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
