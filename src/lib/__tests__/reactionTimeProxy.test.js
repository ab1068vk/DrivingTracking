import { describe, expect, it } from 'vitest';
import { calculateReactionTimeProxy, EVENT_TYPES } from '@/lib/tripEngine';

const p = (index, speed) => ({
  lat: 43.65 + index * 0.003,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
});

describe('reaction time proxy', () => {
  it('handles empty route points', () => {
    expect(calculateReactionTimeProxy([], [])).toMatchObject({ reaction_score: 100, reaction_sample_count: 0 });
  });

  it('handles a single route point', () => {
    expect(calculateReactionTimeProxy([p(0, 40)], [])).toMatchObject({ reaction_grade: 'anticipatory' });
  });

  it('measures a deterministic braking reaction window', () => {
    const points = [p(0, 80), p(1, 75), p(2, 60), p(3, 25)];
    const events = [{ type: EVENT_TYPES.HARSH_BRAKE, timestamp: points[2].timestamp, speed_kmh: 60 }];
    const result = calculateReactionTimeProxy(points, events);

    expect(result.reaction_sample_count).toBe(1);
    expect(result.avg_reaction_seconds).toBe(2);
    expect(result.reaction_score).toBeGreaterThan(0);
  });

  it('grades excellent windows above slow windows', () => {
    const excellentPoints = [p(0, 70), p(1, 60)];
    const slowPoints = [p(0, 80), p(1, 78), p(2, 75), p(3, 70), p(4, 60)];
    const excellent = calculateReactionTimeProxy(excellentPoints, [{ type: EVENT_TYPES.HARSH_BRAKE, timestamp: excellentPoints[1].timestamp, speed_kmh: 60 }]);
    const slow = calculateReactionTimeProxy(slowPoints, [{ type: EVENT_TYPES.HARSH_BRAKE, timestamp: slowPoints[4].timestamp, speed_kmh: 60 }]);

    expect(excellent.reaction_score).toBeGreaterThan(slow.reaction_score);
  });

  it('normalizes same-rate reaction penalties by distance', () => {
    const base = [p(0, 80), p(1, 75), p(2, 60), p(3, 25)];
    const doubled = [...base, ...base.map((point, index) => ({ ...point, lat: point.lat + 0.01, timestamp: p(index + 10, point.speed_kmh).timestamp }))];
    const baseScore = calculateReactionTimeProxy(base, [{ type: EVENT_TYPES.HARSH_BRAKE, timestamp: base[2].timestamp, speed_kmh: 60 }]).reaction_score;
    const doubledScore = calculateReactionTimeProxy(doubled, [
      { type: EVENT_TYPES.HARSH_BRAKE, timestamp: doubled[2].timestamp, speed_kmh: 60 },
      { type: EVENT_TYPES.HARSH_BRAKE, timestamp: doubled[6].timestamp, speed_kmh: 60 },
    ]).reaction_score;

    expect(Math.abs(baseScore - doubledScore)).toBeLessThanOrEqual(5);
  });
});
