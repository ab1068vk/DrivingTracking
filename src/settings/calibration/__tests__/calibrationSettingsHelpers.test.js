import { describe, expect, it } from 'vitest';
import { labelBreakdownFromMarkers, ratedTripCount } from '@/settings/calibration/labelBreakdown';
import { calibrationModelStatus } from '@/settings/calibration/modelStatus';
import { calibrationProgress } from '@/settings/calibration/progress';
import { recentUnratedTripCount } from '@/settings/calibration/recentUnratedTrips';

const scoredTrip = (id, daysAgo = 0) => ({
  id,
  status: 'completed',
  start_time: new Date(Date.UTC(2026, 0, 15 - daysAgo)).toISOString(),
  score_overall: 80,
});

describe('calibration settings helpers', () => {
  it('counts rated trips and label balance from survey markers', () => {
    const markers = {
      a: { rating: 5 },
      b: { rating: 4 },
      c: { rating: 3 },
      d: { rating: 1 },
      e: { skipped: true },
    };

    expect(ratedTripCount(markers)).toBe(4);
    expect(labelBreakdownFromMarkers(markers)).toEqual({
      careful: 1,
      normal: 1,
      rushed: 1,
      incident: 1,
    });
  });

  it('computes target progress and next milestone', () => {
    const progress = calibrationProgress(50);

    expect(progress.target).toBe(2000);
    expect(progress.percent).toBe(2.5);
    expect(progress.nextMilestone).toMatchObject({
      count: 200,
      label: 'Personalized',
    });
  });

  it('detects recent unrated scored trips', () => {
    const trips = [
      scoredTrip('rated', 1),
      scoredTrip('unrated_recent', 2),
      scoredTrip('unrated_old', 20),
      { ...scoredTrip('unscored', 1), score_overall: null },
    ];
    const markers = {
      rated: { rating: 4 },
    };
    const nowMs = Date.UTC(2026, 0, 15);

    expect(recentUnratedTripCount(trips, markers, nowMs)).toBe(1);
  });

  it('reports current model status for settings display', () => {
    expect(calibrationModelStatus()).toMatchObject({
      provisional: true,
      versionHash: expect.stringMatching(/^[a-f0-9]{8}$/),
    });
  });
});
