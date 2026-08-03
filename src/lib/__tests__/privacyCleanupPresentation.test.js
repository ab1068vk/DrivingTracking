import { describe, expect, it } from 'vitest';
import {
  buildHeightenedPrivacyCleanupPresentation,
  buildPrivacyCleanupPresentation,
} from '@/lib/privacyCleanupPresentation';

describe('privacy cleanup presentation', () => {
  it('reports raw GPS and every derived saved-road category without hiding zeroes', () => {
    const result = buildPrivacyCleanupPresentation({
      purgeResult: { pointsPurged: 4, eventsPurged: 1, tripsAffected: 2 },
      speedKnowledgeCleanup: {
        cellsPurged: 3,
        correctionsPurged: 2,
        roadMemoryCandidatesPurged: 1,
        historySnapshotsPurged: 4,
        processedTripMarkersPurged: 2,
        exclusionsPurged: 0,
        totalRecordsPurged: 12,
      },
    });

    expect(result.description).toContain('Raw GPS cleanup: 4 stored GPS points and 1 event location across 2 trips.');
    expect(result.description).toContain('Saved road-speed cleanup: 12 records');
    expect(result.description).toContain('3 cells');
    expect(result.description).toContain('2 rules');
    expect(result.description).toContain('1 Road Memory corridor');
    expect(result.description).toContain('4 history snapshots');
    expect(result.description).toContain('0 exclusions');
  });

  it('includes saved road-speed cleanup in heightened-privacy confirmation copy', () => {
    expect(buildHeightenedPrivacyCleanupPresentation({
      zoneCount: 2,
      pointsPurged: 7,
      eventsPurged: 3,
      speedKnowledgeRecordsPurged: 5,
    })).toBe('Removed 7 stored GPS points, 3 event locations, and 5 saved road-speed records from 2 configured privacy zones.');
  });
});
