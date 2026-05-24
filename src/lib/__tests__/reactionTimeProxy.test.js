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
    expect(calculateReactionTimeProxy([], [])).toMatchObject({ reaction_score: null, reaction_sample_count: 0 });
  });

  it('handles a single route point', () => {
    expect(calculateReactionTimeProxy([p(0, 40)], [])).toMatchObject({ reaction_grade: 'insufficient_data' });
  });

  it('measures a deterministic braking reaction window', () => {
    const points = [
      p(0, 80), p(1, 75), p(2, 60), p(3, 25),
      p(10, 80), p(11, 75), p(12, 60), p(13, 25),
      p(20, 80), p(21, 75), p(22, 60), p(23, 25),
    ];
    const events = [points[2], points[6], points[10]].map((point) => ({
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: point.timestamp,
      speed_kmh: 60,
    }));
    const result = calculateReactionTimeProxy(points, events);

    expect(result.reaction_sample_count).toBe(3);
    expect(result.avg_reaction_seconds).toBe(2);
    expect(result.reaction_score).toBeGreaterThan(0);
  });

  it('grades excellent windows above slow windows', () => {
    const excellentPoints = [p(0, 70), p(1, 60), p(10, 70), p(11, 60), p(20, 70), p(21, 60)];
    const slowPoints = [
      p(0, 80), p(1, 78), p(2, 75), p(3, 70), p(4, 60),
      p(10, 80), p(11, 78), p(12, 75), p(13, 70), p(14, 60),
      p(20, 80), p(21, 78), p(22, 75), p(23, 70), p(24, 60),
    ];
    const excellent = calculateReactionTimeProxy(excellentPoints, [excellentPoints[1], excellentPoints[3], excellentPoints[5]].map((point) => ({
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: point.timestamp,
      speed_kmh: 60,
    })));
    const slow = calculateReactionTimeProxy(slowPoints, [slowPoints[4], slowPoints[9], slowPoints[14]].map((point) => ({
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: point.timestamp,
      speed_kmh: 60,
    })));

    expect(excellent.reaction_score).toBeGreaterThan(slow.reaction_score);
  });

  it('normalizes same-rate reaction penalties by distance', () => {
    const base = [
      p(0, 80), p(1, 75), p(2, 60), p(3, 25),
      p(10, 80), p(11, 75), p(12, 60), p(13, 25),
      p(20, 80), p(21, 75), p(22, 60), p(23, 25),
    ];
    const doubled = [...base, ...base.map((point, index) => ({ ...point, lat: point.lat + 0.1, timestamp: p(index + 30, point.speed_kmh).timestamp }))];
    const baseScore = calculateReactionTimeProxy(base, [base[2], base[6], base[10]].map((point) => ({
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: point.timestamp,
      speed_kmh: 60,
    }))).reaction_score;
    const doubledScore = calculateReactionTimeProxy(doubled, [doubled[2], doubled[6], doubled[10], doubled[14], doubled[18], doubled[22]].map((point) => ({
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: point.timestamp,
      speed_kmh: 60,
    }))).reaction_score;

    expect(Math.abs(baseScore - doubledScore)).toBeLessThanOrEqual(5);
  });
});
