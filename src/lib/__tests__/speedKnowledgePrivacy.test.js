import { describe, expect, it } from 'vitest';
import { geohashEncode } from '@/lib/localSpeedKnowledge';
import {
  purgeSpeedKnowledgeDataForPrivacyZones,
  speedKnowledgeRecordTouchesPrivacyZones,
} from '@/lib/speedKnowledgePrivacy';

const zone = {
  id: 'home',
  label: 'Home',
  type: 'circle',
  lat: 43.65,
  lng: -79.38,
  radius_m: 140,
};

describe('speed knowledge privacy cleanup', () => {
  it('detects a traced road that crosses a zone even when both endpoints are outside', () => {
    expect(speedKnowledgeRecordTouchesPrivacyZones({
      sectionPoints: [
        { lat: 43.65, lng: -79.383 },
        { lat: 43.65, lng: -79.377 },
      ],
    }, [zone])).toBe(true);
  });

  it('purges every precise derived record and coordinate-bearing history atomically', () => {
    const privateHash = geohashEncode(43.65, -79.38);
    const publicHash = geohashEncode(44.2, -78.8);
    const { data, result } = purgeSpeedKnowledgeDataForPrivacyZones({
      knowledgeRevision: 7,
      cells: {
        [privateHash]: { limitKmh: 40 },
        [publicHash]: { limitKmh: 80 },
      },
      corrections: [
        { id: 'private-rule', geohash: privateHash, lat: 43.65, lng: -79.38 },
        { id: 'public-rule', geohash: publicHash, lat: 44.2, lng: -78.8 },
      ],
      excludedSections: [
        { id: 'private-exclusion', sectionPoints: [{ lat: 43.65, lng: -79.381 }, { lat: 43.65, lng: -79.379 }] },
      ],
      roadMemory: {
        candidates: [
          { id: 'private-memory', geohash: privateHash, lat: 43.65, lng: -79.38 },
          { id: 'public-memory', geohash: publicHash, lat: 44.2, lng: -78.8 },
        ],
        processedTrips: { privateTrip: '2026-07-01T00:00:00.000Z' },
        intelligence: { feedbackCount: 12 },
      },
      history: {
        undo: [{ data: { corrections: [{ lat: 43.65, lng: -79.38 }] } }],
        redo: [{ data: { cells: { [privateHash]: { limitKmh: 40 } } } }],
      },
    }, [zone]);

    expect(result).toMatchObject({
      changed: true,
      cellsPurged: 1,
      correctionsPurged: 1,
      roadMemoryCandidatesPurged: 1,
      exclusionsPurged: 1,
      processedTripMarkersPurged: 1,
      historySnapshotsPurged: 2,
    });
    expect(data.knowledgeRevision).toBe(7);
    expect(Object.keys(data.cells)).toEqual([publicHash]);
    expect(data.corrections.map((item) => item.id)).toEqual(['public-rule']);
    expect(data.roadMemory.candidates.map((item) => item.id)).toEqual(['public-memory']);
    expect(data.roadMemory.processedTrips).toEqual({});
    expect(data.roadMemory.intelligence).toBeNull();
    expect(data.excludedSections).toEqual([]);
    expect(data.history).toEqual({ undo: [], redo: [] });
  });
});
