import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumFleetIntelligenceCard, {
  buildPremiumFleetIntelligenceViewModel,
} from '@/components/PremiumFleetIntelligenceCard';

const intelligence = {
  assignmentReviewCount: 2,
  serviceDueCount: 1,
  busiestVehicle: {
    vehicle: { id: 'car-1', name: 'City Commuter' },
    distanceKm: 621.3,
    trips: 46,
  },
  bestScoreVehicle: {
    vehicle: { id: 'car-2', name: 'Family EV' },
    score: 61,
  },
};

describe('PremiumFleetIntelligenceCard', () => {
  it('derives copy, units, action priority, and the gauge from live fleet values', () => {
    expect(buildPremiumFleetIntelligenceViewModel(intelligence, {
      highConfidenceAssignmentCount: 3,
      units: 'imperial',
    })).toMatchObject({
      actionDetail: '3 high-confidence suggestions are ready.',
      actionTitle: 'Confirm suggested vehicles',
      actionTone: 'assignment',
      bestDetail: '~61 aggregate evidence',
      bestName: 'Family EV',
      busiestDetail: expect.stringMatching(/386\.1 mi across 46 trips/),
      busiestName: 'City Commuter',
      score: 61,
      scoreDegrees: 164.7,
      scoreLabel: '61',
      scoreTone: 'developing',
    });
  });

  it('renders all three generated scenes and an accessible responsive score gauge', () => {
    const html = renderToStaticMarkup(
      <PremiumFleetIntelligenceCard
        intelligence={intelligence}
        highConfidenceAssignmentCount={0}
        units="metric"
      />,
    );

    expect(html).toContain('class="premium-fleet-card"');
    expect(html).toContain('premium-fleet-busiest.webp');
    expect(html).toContain('premium-fleet-score.webp');
    expect(html).toContain('premium-fleet-action.webp');
    expect(html).toContain('aria-label="Busiest vehicle: City Commuter. 621.3 km across 46 trips"');
    expect(html).toContain('aria-label="Best scoring vehicle: Family EV. ~61 aggregate evidence"');
    expect(html).toContain('aria-label="Approximate fleet score 61 out of 100"');
    expect(html).toContain('--fleet-score-degrees:164.7deg');
    expect(html).toContain('class="premium-fleet-score-instrument"');
    expect(html).toContain('class="premium-fleet-score-segment-faces"');
    expect(html).toContain('Review vehicle assignments');
  });

  it('keeps no-score and no-trip states explicit without inventing data', () => {
    const model = buildPremiumFleetIntelligenceViewModel({
      assignmentReviewCount: 0,
      serviceDueCount: 0,
      busiestVehicle: null,
      bestScoreVehicle: null,
    });

    expect(model).toMatchObject({
      actionTitle: 'Vehicle data is current',
      actionTone: 'current',
      bestName: 'Not enough scored trips',
      busiestName: 'No trip data yet',
      score: null,
      scoreDegrees: 0,
      scoreLabel: '—',
      scoreTone: 'learning',
    });
  });

  it('clamps out-of-range score inputs before calculating the visual fill', () => {
    expect(buildPremiumFleetIntelligenceViewModel({
      bestScoreVehicle: { vehicle: { name: 'Test car' }, score: 140 },
    })).toMatchObject({
      score: 100,
      scoreDegrees: 270,
      scoreLabel: '100',
      scoreTone: 'excellent',
    });

    expect(buildPremiumFleetIntelligenceViewModel({
      bestScoreVehicle: { vehicle: { name: 'Test car' }, score: -20 },
    })).toMatchObject({
      score: 0,
      scoreDegrees: 0,
      scoreLabel: '0',
      scoreTone: 'attention',
    });
  });
});
