import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LiveScorePanel from '@/components/tracking/LiveScorePanel';

const baseScore = {
  status: 'ok',
  tripId: 'live-1',
  confidence: 'developing',
  provisionalScore: 82,
  safetyScore: 79,
  smoothnessScore: 88,
  distanceKm: 5.4,
  durationSeconds: 900,
  routePointCount: 450,
  topDrivers: [
    { key: 'harsh_brake', label: 'Harsh braking', count: 4, per100km: 74.1 },
  ],
  windowComparison: { available: false, firstScore: null, lastScore: null, delta: null, declined: false },
  fatigueAlert: false,
  limitation: 'Provisional in-drive estimate from partial data.',
};

const render = (score) => renderToStaticMarkup(<LiveScorePanel score={score} />);

describe('LiveScorePanel', () => {
  it('renders nothing without an active trip', () => {
    expect(render(null)).toBe('');
    expect(render({ ...baseScore, status: 'no_active_trip' })).toBe('');
  });

  it('shows the score through the approximate display path', () => {
    const markup = render(baseScore);

    expect(markup).toContain('~82');
    expect(markup).toContain('~79');
    expect(markup).toContain('~88');
    expect(markup).toContain('Developing evidence');
  });

  it('never presents a provisional score as a final one', () => {
    const markup = render(baseScore);

    expect(markup).toContain('Provisional drive score');
    expect(markup).toContain('will not match the completed trip score');
  });

  it('lists the top score drivers with their rates', () => {
    const markup = render(baseScore);

    expect(markup).toContain('Harsh braking');
    expect(markup).toContain('74.1 / 100 km');
  });

  it('converts driver rates to the selected unit system', () => {
    const markup = renderToStaticMarkup(<LiveScorePanel score={baseScore} units="imperial" />);

    expect(markup).toContain('/ 100 mi');
    expect(markup).not.toContain('/ 100 km');
  });

  it('explains the waiting state instead of showing a number', () => {
    const markup = render({ ...baseScore, status: 'insufficient_data', confidence: 'insufficient_data', provisionalScore: null });

    expect(markup).toContain('Waiting for evidence');
    expect(markup).toContain('needs a few minutes of recorded movement');
    expect(markup).not.toContain('~82');
  });

  it('flags a declining window comparison', () => {
    const markup = render({
      ...baseScore,
      windowComparison: { available: true, firstScore: 88, lastScore: 61, delta: -27, declined: true },
      fatigueAlert: true,
    });

    expect(markup).toContain('Later driving is scoring lower');
    expect(markup).toContain('~88');
    expect(markup).toContain('~61');
    expect(markup).toContain('(-27)');
  });

  it('reports a steady window comparison neutrally', () => {
    const markup = render({
      ...baseScore,
      windowComparison: { available: true, firstScore: 80, lastScore: 83, delta: 3, declined: false },
    });

    expect(markup).toContain('First and latest ten minutes compared');
    expect(markup).toContain('(+3)');
    expect(markup).not.toContain('Later driving is scoring lower');
  });
});
