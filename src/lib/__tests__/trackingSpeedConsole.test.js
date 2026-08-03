import { describe, expect, it } from 'vitest';
import {
  POSTED_SIGN_OVERRIDE_NOTE,
  buildTrackingSpeedConsoleData,
  fallbackReasonForSpeedSource,
  neutralizeSpeedRecommendation,
  speedThresholdStatus,
  trackingSpeedSourceLabel,
} from '@/lib/trackingSpeedConsole';

describe('tracking speed console data', () => {
  it('labels posted, estimated, and learned sources without certainty inflation', () => {
    expect(trackingSpeedSourceLabel('user_confirmed_posted_sign')).toBe('Your confirmed posted sign');
    expect(trackingSpeedSourceLabel('region_default_estimate')).toBe('Regional default estimate');
    expect(trackingSpeedSourceLabel('trip_consensus')).toBe('Local learned estimate');
    expect(trackingSpeedSourceLabel('local_road_memory')).toBe('Local Road Memory estimate');
    expect(fallbackReasonForSpeedSource('inferred')).toContain('fallback context');
    expect(fallbackReasonForSpeedSource('user_entered_estimate')).toContain('Confirm a posted sign');
    expect(fallbackReasonForSpeedSource('local_road_memory')).toContain('repeated local drives');
  });

  it('uses neutral threshold wording', () => {
    expect(speedThresholdStatus({ speed_kmh: 68, speed_limit_kmh: 60 })).toBe('threshold exceeded');
    expect(speedThresholdStatus({ speed_kmh: 62, speed_limit_kmh: 60 })).toBe('within recorded threshold');
    expect(neutralizeSpeedRecommendation('Review low-confidence estimated limits before treating events as confirmed speeding.'))
      .toContain('confirmed threshold evidence');
  });

  it('summarizes local rules, expiring rules, and trip coverage', () => {
    const data = buildTrackingSpeedConsoleData({
      nowMs: Date.parse('2026-07-09T12:00:00.000Z'),
      speedKnowledgeData: {
        cells: {
          abc123: { limitKmh: 50, source: 'trip_consensus', confidence: 0.55 },
        },
        roadMemory: {
          candidates: [{
            id: 'road-memory-1',
            active: true,
            limitKmh: 60,
            confidence: 0.64,
            tripCount: 3,
            agreement: 1,
            lastObservedAt: '2026-07-08T12:00:00.000Z',
          }],
        },
        corrections: [{
          id: 'posted-rule',
          roadName: 'King Street',
          limitKmh: 40,
          source: 'user_confirmed_posted_sign',
          appliedAt: '2026-07-01T00:00:00.000Z',
        }, {
          id: 'temp-rule',
          roadName: 'Queen Street',
          limitKmh: 30,
          source: 'user_entered_estimate',
          expiresAt: '2026-07-12T00:00:00.000Z',
        }],
      },
      trips: [{
        id: 'trip-1',
        status: 'completed',
        start_time: '2026-07-08T12:00:00.000Z',
        route_points: [
          { lat: 43.65, lng: -79.38, speed_kmh: 35, speed_limit_kmh: 40, speed_limit_source: 'openstreetmap' },
          { lat: 43.651, lng: -79.381, speed_kmh: 64, speed_limit_kmh: 50, speed_limit_source: 'region_default_estimate' },
        ],
      }],
    });

    expect(data.safeWording).toBe(POSTED_SIGN_OVERRIDE_NOTE);
    expect(data.counts.savedRuleCount).toBe(2);
    expect(data.counts.learnedCellCount).toBe(1);
    expect(data.counts.roadMemoryCandidateCount).toBe(1);
    expect(data.counts.expiringRuleCount).toBe(1);
    expect(data.counts.postedSourceCount).toBeGreaterThan(0);
    expect(data.sourceSummary.some((row) => row.source === 'user_confirmed_posted_sign')).toBe(true);
    expect(data.sourceSummary.some((row) => row.source === 'local_road_memory')).toBe(true);
    expect(data.tripCoverageRows[0]).toMatchObject({
      tripId: 'trip-1',
      coveragePercent: 100,
      verifiedCoveragePercent: 50,
      thresholdExceededPointCount: 1,
    });
  });
});
