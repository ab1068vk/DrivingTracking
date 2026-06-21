import { describe, expect, it } from 'vitest';
import { inspectSpeedKnowledgeHealth } from '@/lib/speedKnowledgeHealth';

describe('speed knowledge health', () => {
  it('reports expired, invalid, conflicting, and disagreeing local rules', () => {
    const report = inspectSpeedKnowledgeHealth({
      cells: {
        dpz83f: {
          limitKmh: 50,
          source: 'trip_consensus',
          confidence: 0.4,
          conflict: true,
          lastUpdatedAt: '2025-01-01T00:00:00.000Z',
        },
      },
      corrections: [{
        geohash: 'dpz83g',
        roadName: 'King Street',
        directionMode: 'both',
        limitKmh: 40,
        expiresAt: '2026-01-01T00:00:00.000Z',
        sectionPoints: [{ lat: 43.65, lng: -79.38 }],
      }, {
        geohash: 'dpz83h',
        roadName: 'King Street',
        directionMode: 'both',
        limitKmh: 50,
        sectionPoints: [
          { lat: 43.66, lng: -79.39 },
          { lat: 43.661, lng: -79.391 },
        ],
      }],
    }, Date.parse('2026-06-20T12:00:00.000Z'));

    expect(report.healthy).toBe(false);
    expect(report.counts.conflict).toBe(1);
    expect(report.counts.expired_rule).toBe(1);
    expect(report.counts.invalid_geometry).toBe(1);
    expect(report.counts.road_limit_disagreement).toBe(2);
  });

  it('accepts clean saved geometry', () => {
    const report = inspectSpeedKnowledgeHealth({
      cells: {},
      corrections: [{
        geohash: 'dpz83g',
        roadName: 'King Street',
        directionMode: 'both',
        limitKmh: 50,
        sectionPoints: [
          { lat: 43.65, lng: -79.38 },
          { lat: 43.651, lng: -79.381 },
        ],
      }],
    });

    expect(report.healthy).toBe(true);
    expect(report.issueCount).toBe(0);
  });
});
