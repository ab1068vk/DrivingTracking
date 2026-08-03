import { describe, expect, it, vi } from 'vitest';
import {
  activeSpeedCorrectionsForConflictReview,
  buildTracedConflictResolutionMetadata,
  consumeLegacyIgnoredTripReviewKeys,
  persistIgnoredSpeedReviewSection,
  speedReviewCorrectionIsReadOnly,
  speedReviewDraftForDisplay,
  speedReviewDraftFromDisplay,
  speedReviewRuleLifecycleAt,
} from '@/components/SpeedLimitConflictReview';

describe('SpeedLimitConflictReview smart speed behavior', () => {
  it('round-trips imperial input through canonical km/h storage', () => {
    const canonical = speedReviewDraftFromDisplay('62', 'imperial');

    expect(Number(canonical)).toBeCloseTo(99.78, 2);
    expect(speedReviewDraftForDisplay(canonical, 'imperial')).toBe('62');
    expect(speedReviewDraftForDisplay('210', 'imperial')).toBe('130');
    expect(speedReviewDraftForDisplay('100', 'metric')).toBe('100');
  });

  it('persists an ignored section before requesting truthful trip rescoring', async () => {
    const beforeKnowledge = { knowledgeRevision: 4, corrections: [{ id: 'old-rule' }] };
    const afterKnowledge = { knowledgeRevision: 5, corrections: [] };
    const exclusion = {
      id: 'excluded-road-1',
      geohash: 'dpz83d',
      lat: 43.65,
      lng: -79.38,
      sectionPoints: [
        { lat: 43.65, lng: -79.38 },
        { lat: 43.6505, lng: -79.3795 },
      ],
    };
    const knowledge = {
      exportData: vi.fn()
        .mockResolvedValueOnce(beforeKnowledge)
        .mockResolvedValueOnce(afterKnowledge),
      excludeSpeedSection: vi.fn().mockResolvedValue({ exclusion }),
    };
    const refreshedTrips = [{ id: 'trip-1' }];
    Object.defineProperties(refreshedTrips, {
      queuedTripCount: { value: 2 },
      totalAffectedTripCount: { value: 3 },
    });
    const refreshKnowledgeChanges = vi.fn().mockResolvedValue(refreshedTrips);

    const result = await persistIgnoredSpeedReviewSection({
      knowledge,
      refreshKnowledgeChanges,
      cell: {
        geohash: 'dpz83d',
        lat: 43.65,
        lng: -79.38,
        roads: ['Example Road'],
        sectionPoints: exclusion.sectionPoints,
      },
    });

    expect(knowledge.excludeSpeedSection).toHaveBeenCalledWith(expect.objectContaining({
      geohash: 'dpz83d',
      roadName: 'Example Road',
      exclusionKeys: expect.arrayContaining([expect.stringMatching(/^geom:/)]),
    }), 'user_ignored_trip_review');
    expect(refreshKnowledgeChanges).toHaveBeenCalledWith(beforeKnowledge, afterKnowledge);
    expect(result).toMatchObject({
      ok: true,
      exclusion,
      updatedTripCount: 1,
      queuedTripCount: 2,
      affectedTripCount: 3,
    });
    expect(result.rescoreStatus).toContain('1 matching trip score refreshed and 2 queued');
  });

  it('consumes and deletes plaintext legacy ignored keys instead of retaining them', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const localStorage = {
      getItem: vi.fn().mockReturnValue(JSON.stringify(['trip-1:dpz83d'])),
      removeItem: vi.fn(),
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage },
    });

    try {
      expect(consumeLegacyIgnoredTripReviewKeys()).toEqual(['trip-1:dpz83d']);
      expect(localStorage.removeItem).toHaveBeenCalledWith('roadsage_ignored_trip_speed_review_sections_v1');
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('requires a real trip trace when turning a coarse conflict into a saved road rule', () => {
    const cell = {
      geohash: 'dpz83d',
      roads: ['Example Road'],
      sectionPoints: [
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ],
    };
    expect(buildTracedConflictResolutionMetadata(cell, null)).toBeNull();

    const metadata = buildTracedConflictResolutionMetadata(cell, {
      roads: ['Traced Road'],
      sectionPoints: [
        { lat: 43.65, lng: -79.38 },
        { lat: 43.6505, lng: -79.3795 },
      ],
    }, 'history-1');

    expect(metadata).toMatchObject({
      lat: 43.6505,
      lng: -79.3795,
      roadName: 'Example Road',
      historyGroup: 'history-1',
      provenance: 'trip_route_conflict_review',
    });
    expect(metadata.sectionPoints).toHaveLength(2);
  });

  it('keeps historical and inactive versions read-only and out of active overlap checks', () => {
    const now = new Date('2026-08-02T12:00:00.000Z').getTime();
    const active = { id: 'active', limitKmh: 50 };
    const historical = { id: 'historical', historicalVersion: true, limitKmh: 40 };
    const expired = { id: 'expired', expiresAt: '2026-08-01T12:00:00.000Z', limitKmh: 30 };
    const future = { id: 'future', validFrom: '2026-08-03T12:00:00.000Z', limitKmh: 60 };

    expect(speedReviewRuleLifecycleAt(historical, now)).toBe('historical');
    expect(speedReviewCorrectionIsReadOnly(historical, now)).toBe(true);
    expect(speedReviewCorrectionIsReadOnly(expired, now)).toBe(true);
    expect(speedReviewCorrectionIsReadOnly(future, now)).toBe(true);
    expect(speedReviewCorrectionIsReadOnly(active, now)).toBe(false);
    expect(activeSpeedCorrectionsForConflictReview([
      historical,
      expired,
      future,
      active,
    ], now)).toEqual([active]);
  });
});
