import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_PASSWORD_REQUIRED_CODE,
  BACKUP_SIGNATURE_INVALID_CODE,
  BACKUP_WRONG_PASSWORD_CODE,
  buildDriveSenseBackup,
  exportDriveSenseBackup,
  importDriveSenseBackup,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_IMPORTED_TRIP_DRIVING_EVENTS,
  MAX_IMPORTED_TRIP_NOTES_LENGTH,
  MAX_IMPORTED_TRIP_ROUTE_POINTS,
  migrateBackup,
  parseDriveSenseBackup,
  sanitizeSpeedKnowledge,
} from '@/lib/dataBackup';
import {
  decryptBackupText,
  encryptBackupText,
  isEncryptedBackupEnvelope,
} from '@/lib/backupEnvelopeEncryption';
import {
  isSignedExportEnvelope,
  signExport,
  verifyExport,
} from '@/lib/exportIntegrity';
import { SCORING_VERSION } from '@/lib/scoringConstants';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import {
  geohashBounds,
  geohashEncode,
  LocalSpeedKnowledge,
  STORAGE_KEY as SPEED_KNOWLEDGE_STORAGE_KEY,
} from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { getJson, setJson } from '@/lib/mobileStorage';
import { maskTripForPrivacy } from '@/lib/privacyZones';
import { analyzeRoadMemoryIntelligence } from '@/lib/roadMemoryIntelligence';
import { speedKnowledgeCellEligibility } from '@/lib/speedKnowledgeCellPolicy';
import { loadTransmissionLog } from '@/lib/transmissionLog';

vi.mock('@/api/trips', () => ({
  tripService: {
    upsertMany: vi.fn(async (trips) => trips),
    listAll: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    update: vi.fn(async (id, patch) => ({ id, ...patch })),
  },
}));

vi.mock('@/api/vehicles', () => ({
  vehicleService: {
    upsertMany: vi.fn(async (vehicles) => vehicles),
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const parseTrips = (trips) => parseDriveSenseBackup(JSON.stringify({
  app: 'Road Sage',
  version: 5,
  trips,
})).trips;

const trustedRoadMemoryCandidates = () => {
  const tripIds = Array.from({ length: 20 }, (_, index) => `trust-trip-${index + 1}`);
  const tripVotes = Object.fromEntries(tripIds.map((tripId) => [tripId, 50]));
  const observedAt = new Date().toISOString();
  const candidate = (id, index, reviewed = false) => {
    const lat = 43.7001 + index * 0.001;
    const lng = -79.4001 - index * 0.001;
    return {
      id,
      geohash: geohashEncode(lat, lng),
      lat,
      lng,
      limitKmh: 50,
      confidence: 0.72,
      agreement: 1,
      tripCount: tripIds.length,
      evidenceCount: tripIds.length,
      tripIds,
      tripVotes,
      limitVotes: { 50: tripIds.length },
      stage: 'operational',
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      sectionPoints: [
        { lat: lat - 0.0002, lng: lng - 0.0002 },
        { lat: lat + 0.0002, lng: lng + 0.0002 },
      ],
      ...(reviewed ? {
        reviewState: 'confirmed',
        reviewedAt: observedAt,
        limitAtReviewKmh: 50,
        reviewedLimitKmh: 50,
        feedbackOutcome: 'exact',
      } : {}),
    };
  };
  return [
    candidate('trust-target', 0, false),
    ...Array.from({ length: 8 }, (_, index) => (
      candidate(`trust-feedback-${index + 1}`, index + 1, true)
    )),
  ];
};

const roadMemoryBackupPayload = () => ({
  app: 'Road Sage',
  version: BACKUP_VERSION,
  vehicles: [],
  trips: [],
  speed_knowledge: {
    cells: {},
    corrections: [],
    roadMemory: { candidates: trustedRoadMemoryCandidates() },
  },
});

const captureRestoredSpeedKnowledge = (initial = {
  schemaVersion: 2,
  knowledgeRevision: 0,
  knowledgeUpdatedAt: null,
  cells: {},
  corrections: [],
  excludedSections: [],
  roadMemory: { version: 3, candidates: [], processedTrips: {}, intelligence: null },
}) => {
  let restored = initial;
  vi.spyOn(speedKnowledgeStore, 'get').mockImplementation(async () => restored);
  vi.spyOn(speedKnowledgeStore, 'update').mockImplementation(async (_key, updater) => {
    const proposed = await updater(restored);
    restored = {
      ...proposed,
      schemaVersion: 2,
      knowledgeRevision: Math.max(
        Number(restored?.knowledgeRevision) || 0,
        Number(proposed?.knowledgeRevision) || 0
      ) + 1,
      knowledgeUpdatedAt: new Date().toISOString(),
    };
    return restored;
  });
  return () => restored;
};

describe('Road Memory backup sanitization', () => {
  it('preserves bounded staged, change, and time-pattern evidence', () => {
    const sanitized = sanitizeSpeedKnowledge({
      cells: {},
      corrections: [],
      roadMemory: {
        candidates: [{
          id: 'road-memory-advanced',
          geohash: 'dpz83b',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          confidence: 0.68,
          agreement: 0.5,
          tripCount: 6,
          tripIds: ['1', '2', '3', '4', '5', '6'],
          tripVotes: { 1: 50, 2: 50, 3: 50, 4: 40, 5: 40, 6: 40 },
          active: true,
          stage: 'operational',
          reviewState: 'time_profiles_accepted',
          timeProfilesAcceptedAt: '2026-07-29T17:00:00.000Z',
          limitAtReviewKmh: 50,
          reviewedLimitKmh: 50,
          sectionPoints: [
            { lat: 43.653, lng: -79.384 },
            { lat: 43.654, lng: -79.383 },
          ],
          timeProfiles: [{
            bucket: 'weekday_morning',
            limitKmh: 50,
            tripCount: 3,
            agreement: 1,
            eligible: false,
          }, {
            bucket: 'weekday_evening',
            limitKmh: 40,
            tripCount: 3,
            agreement: 1,
            eligible: true,
          }],
          recentObservations: [{
            tripId: '6',
            limitKmh: 40,
            observedAt: '2026-07-29T16:00:00.000Z',
            timeBucket: 'weekday_evening',
          }],
          lastObservedAt: '2026-07-29T16:00:00.000Z',
        }],
      },
    }, [], null, { preserveRoadMemoryTrust: true });

    expect(sanitized.roadMemory.version).toBe(3);
    expect(sanitized.roadMemory.candidates[0]).toMatchObject({
      id: 'road-memory-advanced',
      active: false,
      stage: 'operational',
      reviewState: 'time_profiles_accepted',
      feedbackOutcome: null,
      timeProfilesAcceptedAt: '2026-07-29T17:00:00.000Z',
      tripCount: 6,
      tripVotes: { 1: 50, 2: 50, 3: 50, 4: 40, 5: 40, 6: 40 },
    });
    expect(sanitized.roadMemory.candidates[0].timeProfiles).toHaveLength(2);
    expect(sanitized.roadMemory.candidates[0].recentObservations).toHaveLength(1);
  });

  it('fails closed when trusted Road Memory review state or outcome metadata is malformed', () => {
    const [first, second] = trustedRoadMemoryCandidates();
    const sanitized = sanitizeSpeedKnowledge({
      cells: {},
      corrections: [],
      roadMemory: {
        candidates: [
          { ...first, reviewState: 'model_admin', feedbackOutcome: 'exact' },
          { ...second, feedbackOutcome: 'fabricated_exact' },
        ],
      },
    }, [], null, { preserveRoadMemoryTrust: true });

    sanitized.roadMemory.candidates.forEach((candidate) => {
      expect(candidate).toMatchObject({
        active: false,
        stage: 'learning',
        reviewState: '',
        feedbackOutcome: null,
        tripIds: [],
        tripVotes: {},
        limitVotes: {},
        tripCount: 0,
        evidenceCount: 0,
        confidence: 0,
        agreement: 0,
        chronologyRepairPending: true,
      });
    });
  });

  it('preserves version metadata and valid temporal rules while rejecting malformed validity and private exclusions', () => {
    const privacyZones = [{ id: 'home', lat: 43.65, lng: -79.38, radius_m: 150 }];
    const safeLat = 43.7001;
    const safeLng = -79.4001;
    const safeGeohash = geohashEncode(safeLat, safeLng);
    const privateGeohash = geohashEncode(43.65, -79.38);
    const correction = (id, validity = {}) => ({
      id,
      geohash: safeGeohash,
      lat: safeLat,
      lng: safeLng,
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
      ...validity,
    });

    const sanitized = sanitizeSpeedKnowledge({
      schemaVersion: 2,
      knowledgeRevision: 17,
      knowledgeUpdatedAt: '2026-07-30T12:00:00.000Z',
      cells: {},
      corrections: [
        correction('valid', {
          validFrom: '2026-08-01T12:00:00Z',
          validFromDate: '2026-08-01',
          expiresAt: '2026-09-01T12:00:00Z',
          expiresAtDate: '2026-09-01',
        }),
        correction('bad-start', { validFrom: 'not-a-date' }),
        correction('bad-expiry', { expiresAt: 'also-not-a-date' }),
        correction('reversed', {
          validFrom: '2026-09-01T12:00:00Z',
          expiresAt: '2026-08-01T12:00:00Z',
        }),
        correction('bad-calendar', {
          validFrom: '2026-08-01T12:00:00Z',
          validFromDate: '2026-02-30',
        }),
        correction('orphan-calendar', { validFromDate: '2026-08-01' }),
      ],
      excludedSections: [{
        id: 'geom:43.65000,-79.38000',
        geohash: safeGeohash,
        lat: safeLat,
        lng: safeLng,
        roadName: 'Safe Road',
        reason: 'parking_private',
        exclusionKeys: [
          'geom:43.65000,-79.38000',
          'ends:43.64900,-79.38100:43.65100,-79.37900',
        ],
        sectionPoints: [
          { lat: 43.7000, lng: -79.4000 },
          { lat: 43.7002, lng: -79.4002 },
        ],
        createdAt: '2026-07-30T13:00:00Z',
      }, {
        id: 'private-parking-road',
        geohash: privateGeohash,
        lat: 43.65,
        lng: -79.38,
        reason: 'parking_private',
      }],
      roadMemory: { chronologyVersion: 1, candidates: [] },
    }, privacyZones);

    expect(sanitized).toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 17,
      knowledgeUpdatedAt: '2026-07-30T12:00:00.000Z',
      excludedSections: [expect.objectContaining({
        id: expect.stringMatching(/^excluded-/),
        roadName: 'Safe Road',
        createdAt: '2026-07-30T13:00:00.000Z',
        exclusionKeys: [],
      })],
      roadMemory: expect.objectContaining({ chronologyVersion: 1 }),
    });
    expect(JSON.stringify(sanitized.excludedSections)).not.toContain('43.65000,-79.38000');
    expect(JSON.stringify(sanitized.excludedSections)).not.toContain('ends:');
    expect(sanitized.corrections).toHaveLength(1);
    expect(sanitized.corrections[0]).toMatchObject({
      id: 'valid',
      validFrom: '2026-08-01T12:00:00.000Z',
      validFromDate: '2026-08-01',
      expiresAt: '2026-09-01T12:00:00.000Z',
      expiresAtDate: '2026-09-01',
    });
  });

  it('preserves bounded correction lineage, provenance, qualifiers, conflicts, and audit history', () => {
    const longId = 'lineage-'.repeat(40);
    const correction = {
      id: 'historical-rule',
      geohash: geohashEncode(43.7001, -79.4001),
      lat: 43.7001,
      lng: -79.4001,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      directionMode: 'forward',
      historicalVersion: true,
      supersededAt: '2026-08-01T12:00:00Z',
      supersededByCorrectionId: longId,
      supersedesCorrectionId: 'older-rule',
      versionRootId: 'root-rule',
      provenance: 'road_memory_review',
      roadMemoryCandidateId: 'road-memory-candidate-1',
      qualifierStatus: 'conditional_school_when_flashing',
      conflictResolution: {
        savedLimitKmh: 50,
        observedLimitKmh: 300,
        deltaKmh: 999,
        action: 'kept_saved_limit',
        source: 'user_confirmed_posted_sign',
        note: 'Reviewed after parking',
        resolvedAt: '2026-08-01T11:00:00Z',
        unsafeNestedPayload: { ignored: true },
      },
      editHistory: Array.from({ length: 14 }, (_, index) => ({
        changedAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
        previousLimitKmh: 40,
      })),
      auditTrail: Array.from({ length: 30 }, (_, index) => ({
        action: `audit-${index}`,
        changedAt: '2026-08-01T12:00:00Z',
      })),
    };

    const firstPass = sanitizeSpeedKnowledge({ cells: {}, corrections: [correction] });
    const secondPass = sanitizeSpeedKnowledge(firstPass);
    const restored = secondPass.corrections[0];

    expect(restored).toMatchObject({
      id: 'historical-rule',
      historicalVersion: true,
      supersededAt: '2026-08-01T12:00:00.000Z',
      supersedesCorrectionId: 'older-rule',
      versionRootId: 'root-rule',
      provenance: 'road_memory_review',
      roadMemoryCandidateId: 'road-memory-candidate-1',
      qualifierStatus: 'conditional_school_when_flashing',
      conflictResolution: {
        savedLimitKmh: 50,
        observedLimitKmh: 210,
        deltaKmh: 160,
        action: 'kept_saved_limit',
        source: 'user_confirmed_posted_sign',
        note: 'Reviewed after parking',
        resolvedAt: '2026-08-01T11:00:00.000Z',
      },
    });
    expect(restored.supersededByCorrectionId).toHaveLength(160);
    expect(restored.conflictResolution).not.toHaveProperty('unsafeNestedPayload');
    expect(restored.editHistory).toHaveLength(10);
    expect(restored.auditTrail).toHaveLength(25);
  });

  it('fails closed for malformed enabled schedules and explicitly invalid directions', () => {
    const correction = (id, overrides = {}) => ({
      id,
      geohash: geohashEncode(43.7001, -79.4001),
      lat: 43.7001,
      lng: -79.4001,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      ...overrides,
    });
    const candidate = {
      id: 'invalid-direction-candidate',
      geohash: geohashEncode(43.7101, -79.4101),
      lat: 43.7101,
      lng: -79.4101,
      limitKmh: 50,
      directionMode: 'sideways',
      sectionPoints: [
        { lat: 43.7100, lng: -79.4100 },
        { lat: 43.7102, lng: -79.4102 },
      ],
    };

    const sanitized = sanitizeSpeedKnowledge({
      cells: {},
      corrections: [
        correction('legacy-safe'),
        correction('scheduled-safe', {
          directionMode: 'forward',
          timeRule: { enabled: true, days: [1, 3, 5], startMinutes: 480, endMinutes: 1020 },
        }),
        correction('invalid-direction', { directionMode: 'sideways' }),
        correction('invalid-days', {
          timeRule: { enabled: true, days: [], startMinutes: 480, endMinutes: 1020 },
        }),
        correction('invalid-minute-range', {
          timeRule: { enabled: true, days: [1], startMinutes: -1, endMinutes: 1020 },
        }),
        correction('invalid-null-minute', {
          timeRule: { enabled: true, days: [1], startMinutes: null, endMinutes: 1020 },
        }),
      ],
      excludedSections: [{
        id: 'invalid-direction-exclusion',
        geohash: geohashEncode(43.7201, -79.4201),
        lat: 43.7201,
        lng: -79.4201,
        directionMode: 'sideways',
      }],
      roadMemory: { candidates: [candidate] },
    });

    expect(sanitized.corrections.map((item) => item.id)).toEqual([
      'legacy-safe',
      'scheduled-safe',
    ]);
    expect(sanitized.corrections[0]).toMatchObject({
      directionMode: 'both',
      timeRule: { enabled: false },
    });
    expect(sanitized.corrections[1].timeRule).toMatchObject({
      enabled: true,
      days: [1, 3, 5],
    });
    expect(sanitized.excludedSections).toEqual([]);
    expect(sanitized.roadMemory.candidates).toEqual([]);
  });

  it('caps every imported saved-limit value, nested vote, profile, and conflict at 210 km/h', () => {
    const geohash = geohashEncode(43.7001, -79.4001);
    const sanitized = sanitizeSpeedKnowledge({
      cells: {
        [geohash]: {
          limitKmh: 300,
          timeOfDayBuckets: { '08-10': { p85Kmh: 300, count: 2 } },
        },
      },
      corrections: [{
        id: 'capped-correction',
        geohash,
        lat: 43.7001,
        lng: -79.4001,
        limitKmh: 300,
        conflictResolution: {
          savedLimitKmh: 300,
          observedLimitKmh: 250,
          deltaKmh: 999,
        },
      }],
      roadMemory: {
        candidates: [{
          id: 'capped-candidate',
          geohash,
          lat: 43.7001,
          lng: -79.4001,
          limitKmh: 300,
          limitVotes: { 300: 2, 220: 1 },
          tripVotes: { trip1: 300 },
          recentObservations: [{ tripId: 'trip1', limitKmh: 300, p85Kmh: 300 }],
          timeProfiles: [{ bucket: 'weekday_morning', limitKmh: 300, tripCount: 2 }],
          timeBuckets: { weekday_morning: { tripVotes: { trip1: 300 } } },
          changeDetection: { previousLimitKmh: 300, proposedLimitKmh: 300 },
          limitAtReviewKmh: 300,
          reviewedLimitKmh: 300,
          feedbackContext: {
            proposedLimitKmh: 300,
            chosenLimitKmh: 300,
            observedP85Kmh: 300,
          },
          observedP85Kmh: 300,
          sectionPoints: [
            { lat: 43.7000, lng: -79.4000 },
            { lat: 43.7002, lng: -79.4002 },
          ],
        }],
      },
    }, [], null, { preserveRoadMemoryTrust: true });

    expect(sanitized.cells[geohash]).toMatchObject({
      limitKmh: 210,
      timeOfDayBuckets: { '08-10': { p85Kmh: 210, count: 2 } },
    });
    expect(sanitized.corrections[0]).toMatchObject({
      limitKmh: 210,
      conflictResolution: { savedLimitKmh: 210, observedLimitKmh: 210, deltaKmh: 0 },
    });
    const candidate = sanitized.roadMemory.candidates[0];
    expect(candidate).toMatchObject({
      limitKmh: 210,
      limitVotes: { 210: 3 },
      tripVotes: { trip1: 210 },
      recentObservations: [{ tripId: 'trip1', limitKmh: 210, p85Kmh: 210 }],
      timeProfiles: [expect.objectContaining({ limitKmh: 210 })],
      timeBuckets: { weekday_morning: { tripVotes: { trip1: 210 } } },
      changeDetection: { previousLimitKmh: 210, proposedLimitKmh: 210 },
      limitAtReviewKmh: 210,
      reviewedLimitKmh: 210,
      feedbackContext: expect.objectContaining({
        proposedLimitKmh: 210,
        chosenLimitKmh: 210,
        observedP85Kmh: 210,
      }),
      observedP85Kmh: 210,
    });
  });

  it('drops whole records for privacy-overlapping geohashes and outside-endpoint circle or corridor crossings', () => {
    const circle = {
      id: 'private-circle',
      type: 'circle',
      lat: 43.65,
      lng: -79.38,
      radius_m: 120,
    };
    const corridor = {
      id: 'private-corridor',
      type: 'corridor',
      width_m: 40,
      waypoints: [
        { lat: 43.7, lng: -79.401 },
        { lat: 43.7, lng: -79.399 },
      ],
    };
    const overlapGeohash = geohashEncode(circle.lat, circle.lng, 6);
    const overlapBounds = geohashBounds(overlapGeohash);
    const overlapOutsidePoint = [
      { lat: overlapBounds.south + 0.000001, lng: overlapBounds.west + 0.000001 },
      { lat: overlapBounds.south + 0.000001, lng: overlapBounds.east - 0.000001 },
      { lat: overlapBounds.north - 0.000001, lng: overlapBounds.west + 0.000001 },
      { lat: overlapBounds.north - 0.000001, lng: overlapBounds.east - 0.000001 },
    ].sort((first, second) => (
      ((second.lat - circle.lat) ** 2 + (second.lng - circle.lng) ** 2) -
      ((first.lat - circle.lat) ** 2 + (first.lng - circle.lng) ** 2)
    ))[0];
    const circleStart = { lat: 43.648, lng: -79.38 };
    const circleEnd = { lat: 43.652, lng: -79.38 };
    const corridorStart = { lat: 43.6988, lng: -79.4 };
    const corridorEnd = { lat: 43.7012, lng: -79.4 };
    const safePoint = { lat: 44.1, lng: -80.1 };
    const correction = (id, geohash, coordinate, sectionPoints = []) => ({
      id,
      geohash,
      ...coordinate,
      limitKmh: 50,
      sectionPoints,
    });

    const sanitized = sanitizeSpeedKnowledge({
      cells: {},
      corrections: [
        correction('geohash-overlap', overlapGeohash, overlapOutsidePoint),
        correction(
          'circle-crossing',
          geohashEncode(circleStart.lat, circleStart.lng, 12),
          circleStart,
          [circleStart, circleEnd]
        ),
        correction('safe-control', geohashEncode(safePoint.lat, safePoint.lng, 12), safePoint),
      ],
      excludedSections: [{
        id: 'corridor-crossing-exclusion',
        geohash: geohashEncode(corridorStart.lat, corridorStart.lng, 12),
        ...corridorStart,
        sectionPoints: [corridorStart, corridorEnd],
      }],
      roadMemory: {
        candidates: [{
          id: 'corridor-crossing-candidate',
          geohash: geohashEncode(corridorStart.lat, corridorStart.lng, 12),
          ...corridorStart,
          limitKmh: 50,
          sectionPoints: [corridorStart, corridorEnd],
        }],
      },
    }, [circle, corridor]);

    expect(sanitized.corrections.map((item) => item.id)).toEqual(['safe-control']);
    expect(sanitized.excludedSections).toEqual([]);
    expect(sanitized.roadMemory.candidates).toEqual([]);
  });
});

describe('backup trip import sanitization', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects oversized backup files before reading them', async () => {
    const file = {
      size: MAX_BACKUP_BYTES + 1,
      text: vi.fn(),
    };

    await expect(importDriveSenseBackup(file)).rejects.toThrow('128 MB or smaller');
    expect(file.text).not.toHaveBeenCalled();
  });

  it('accepts a backup file exactly at the size limit', async () => {
    const file = {
      size: MAX_BACKUP_BYTES,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: 5,
        vehicles: [],
        trips: [],
      })),
    };

    await expect(importDriveSenseBackup(file)).resolves.toMatchObject({
      trips: 0,
      vehicles: 0,
    });
    expect(file.text).toHaveBeenCalledTimes(1);
  });

  it('restores trips in small batches instead of retaining another full import copy', async () => {
    const { tripService } = await import('@/api/trips');
    const file = {
      size: 1024,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: Array.from({ length: 10 }, (_, index) => ({
          id: `trip-batch-${index}`,
          status: 'completed',
        })),
      })),
    };

    await expect(importDriveSenseBackup(file)).resolves.toMatchObject({ trips: 10 });
    expect(tripService.upsertMany.mock.calls.map(([batch]) => batch.length)).toEqual([4, 4, 2]);
  });

  it('sanitizes active trips from backup imports', () => {
    const [trip] = parseTrips([{ id: 'trip-active', status: 'active' }]);

    expect(trip.status).toBe('completed');
  });

  it('preserves estimated private distance on imported trips', () => {
    const [trip] = parseTrips([{
      id: 'trip-private-distance',
      status: 'completed',
      estimated_private_distance_km: 0.42,
    }]);

    expect(trip.estimated_private_distance_km).toBe(0.42);
  });

  it('truncates oversized imported trip routes', () => {
    const [trip] = parseTrips([{
      id: 'trip-huge-route',
      status: 'completed',
      route_points: Array.from({ length: 100000 }, (_, index) => ({
        lat: 43 + index / 100000,
        lng: -79,
        timestamp: `2026-05-22T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
        payload: { oversized: true },
      })),
    }]);

    expect(trip.route_points).toHaveLength(MAX_IMPORTED_TRIP_ROUTE_POINTS);
    expect(trip.route_points[0].payload).toBeUndefined();
  });

  it('truncates oversized imported driving events', () => {
    const [trip] = parseTrips([{
      id: 'trip-huge-events',
      status: 'completed',
      driving_events: Array.from({ length: 1000 }, (_, index) => ({
        type: 'harsh_brake',
        severity: 'medium',
        timestamp: `2026-05-22T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })),
    }]);

    expect(trip.driving_events).toHaveLength(MAX_IMPORTED_TRIP_DRIVING_EVENTS);
  });

  it('strips unknown fields from imported trips and driving events', () => {
    const [trip] = parseTrips([{
      id: 'trip-unknown-fields',
      status: 'completed',
      score_overall: 91,
      unknown_top_level: 'nope',
      driving_events: [{
        type: 'harsh_brake',
        severity: 'medium',
        malicious_payload: { execute: true },
      }],
    }]);

    expect(trip).toMatchObject({ id: 'trip-unknown-fields', score_overall: 91 });
    expect(trip.unknown_top_level).toBeUndefined();
    expect(trip.driving_events[0].malicious_payload).toBeUndefined();
  });

  it('preserves jerk-score confidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-jerk-confidence',
      status: 'completed',
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
    }]);

    expect(trip.jerk_score).toBeNull();
    expect(trip.jerk_score_confidence).toBe('insufficient_data');
  });

  it('preserves bounded night-decision evidence and trip-time timezone context', () => {
    const [trip] = parseTrips([{
      id: 'trip-night-evidence',
      status: 'completed',
      night_driving: true,
      trip_timezone_id: 'America/Toronto',
      trip_utc_offset_minutes: -300,
      night_classification: {
        version: 1,
        is_night: true,
        mode: 'civil_twilight',
        method: 'civil_twilight',
        evening_event_local_time: '17:22',
        decision_local_time: '17:30',
        timezone_id: 'America/Toronto',
        utc_offset_minutes: -300,
        malicious_payload: { execute: true },
      },
      route_points: [{
        lat: 43.6532,
        lng: -79.3832,
        timestamp: '2026-01-01T22:30:00.000Z',
        timezone_id: 'America/Toronto',
        utc_offset_minutes: -300,
      }],
    }]);

    expect(trip).toMatchObject({
      night_driving: true,
      trip_timezone_id: 'America/Toronto',
      trip_utc_offset_minutes: -300,
      night_classification: {
        version: 1,
        mode: 'civil_twilight',
        evening_event_local_time: '17:22',
        timezone_id: 'America/Toronto',
        utc_offset_minutes: -300,
      },
      route_points: [{
        timezone_id: 'America/Toronto',
        utc_offset_minutes: -300,
      }],
    });
    expect(trip.night_classification.malicious_payload).toBeUndefined();
  });

  it('preserves tire-wear missing-speed evidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-tire-speed-evidence',
      status: 'completed',
      trip_tire_wear_units: 3.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    }]);

    expect(trip).toMatchObject({
      trip_tire_wear_units: 3.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    });
  });

  it('preserves road-type-stratified SVI evidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-svi-confidence',
      status: 'completed',
      speed_variability_index: 6.2,
      svi_score: 91,
      svi_label: 'very smooth',
      svi_score_confidence: 'road_type_stratified',
      svi_moving_sample_count: 42,
    }]);

    expect(trip).toMatchObject({
      speed_variability_index: 6.2,
      svi_score: 91,
      svi_label: 'very smooth',
      svi_score_confidence: 'road_type_stratified',
      svi_moving_sample_count: 42,
    });
  });

  it('preserves traffic-stop intersection results through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-intersection-stops',
      status: 'completed',
      intersection_score: 73,
      intersection_score_confidence: 'observed_stops',
      stop_count: 3,
      traffic_stop_count: 3,
      rolling_stop_count: 3,
      smooth_approach_count: 3,
    }]);

    expect(trip).toMatchObject({
      intersection_score: 73,
      intersection_score_confidence: 'observed_stops',
      traffic_stop_count: 3,
      rolling_stop_count: 3,
    });
  });

  it('preserves following-distance confidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-following-confidence',
      status: 'completed',
      following_distance_score: null,
      following_distance_score_confidence: 'insufficient_data',
    }]);

    expect(trip.following_distance_score).toBeNull();
    expect(trip.following_distance_score_confidence).toBe('insufficient_data');
  });

  it('preserves corrected duration and numeric component confidence metadata', () => {
    const [trip] = parseTrips([{
      id: 'trip-score-confidence',
      status: 'completed',
      duration_seconds: 120,
      wall_clock_duration_seconds: 720,
      gap_seconds: 600,
      fatigue_risk_score: 30,
      fatigue_risk_score_confidence: 0.8,
      speed_creep_score: 88,
      speed_creep_score_confidence: 0.8,
      smooth_braking_score: 82,
      smooth_braking_score_confidence: 0.8,
      braking_efficiency_score: 74,
      braking_efficiency_score_confidence: 0.8,
      hill_driving_score: null,
      hill_driving_score_confidence: 0,
    }]);

    expect(trip).toMatchObject({
      duration_seconds: 120,
      wall_clock_duration_seconds: 720,
      gap_seconds: 600,
      fatigue_risk_score: 30,
      fatigue_risk_score_confidence: 0.8,
      speed_creep_score: 88,
      speed_creep_score_confidence: 0.8,
      smooth_braking_score: 82,
      smooth_braking_score_confidence: 0.8,
      braking_efficiency_score_confidence: 0.8,
      hill_driving_score_confidence: 0,
    });
  });

  it('preserves typed component score evidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-component-evidence',
      status: 'completed',
      component_scores: {
        safety: {
          value: 84,
          evidence: 'developing',
          dataSource: ['gps', 'osm_speed_limit'],
          sampleCount: 18,
          note: 'Partial route context.',
        },
      },
      score_provenance: {
        computed_at: '2026-05-24T17:23:44.000Z',
        scoring_version: SCORING_VERSION,
        components: { safety: 'developing' },
        constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
      },
      score_provenance_change: {
        previous_scoring_version: '2.0.0',
        current_scoring_version: SCORING_VERSION,
        reason: 'scoring_inputs_changed',
        changed_constants: ['PENALTY_SCALE_FACTOR'],
      },
    }]);

    expect(trip.component_scores.safety).toEqual({
      value: 84,
      evidence: 'developing',
      dataSource: ['gps', 'osm_speed_limit'],
      sampleCount: 18,
      note: 'Partial route context.',
    });
    expect(trip.score_provenance).toMatchObject({
      scoring_version: SCORING_VERSION,
      constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
    });
    expect(trip.score_provenance_change.changed_constants).toEqual(['PENALTY_SCALE_FACTOR']);
  });

  it('rejects imported trips without a non-empty string id', () => {
    expect(() => parseTrips([{ id: '', status: 'completed' }])).toThrow('valid id');
    expect(() => parseTrips([{ id: 123, status: 'completed' }])).toThrow('valid id');
  });

  it('preserves legitimate long trip notes and reports truncation above their field limit', () => {
    const acceptableNote = 'a'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH);
    const [acceptable] = parseTrips([{ id: 'trip-note-ok', notes: acceptableNote }]);
    expect(acceptable.notes).toHaveLength(MAX_IMPORTED_TRIP_NOTES_LENGTH);

    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      trips: [{ id: 'trip-note-long', notes: 'b'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH + 1) }],
    }));
    expect(parsed.trips[0].notes).toHaveLength(MAX_IMPORTED_TRIP_NOTES_LENGTH);
    expect(parsed.warnings[0]).toContain('notes');
  });

  it('requires acknowledgement before importing truncated trip notes', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        trips: [{ id: 'long-note', notes: 'x'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH + 1) }],
      })),
    };
    const pending = await importDriveSenseBackup(file);
    expect(pending).toMatchObject({ requiresAcknowledgement: true, truncatedNoteTripCount: 1 });

    const imported = await importDriveSenseBackup(file, { acknowledgeTruncation: true });
    expect(imported.trips).toBe(1);
  });

  it('imports encrypted backups through the existing sanitizer without leaking plaintext', async () => {
    const passphrase = 'correct horse battery staple';
    const plaintext = JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-encrypted', status: 'completed', notes: 'private route note' }],
    });
    const encrypted = await encryptBackupText(plaintext, passphrase, {
      exportedAt: '2026-06-06T12:00:00.000Z',
    });
    const file = {
      size: encrypted.length,
      text: vi.fn(async () => encrypted),
    };

    expect(isEncryptedBackupEnvelope(encrypted)).toBe(true);
    expect(encrypted).not.toContain('trip-encrypted');
    expect(encrypted).not.toContain('private route note');

    await expect(importDriveSenseBackup(file)).rejects.toMatchObject({
      code: BACKUP_PASSWORD_REQUIRED_CODE,
    });
    await expect(importDriveSenseBackup(file, { passphrase: 'wrong password value' })).rejects.toMatchObject({
      code: BACKUP_WRONG_PASSWORD_CODE,
    });

    const imported = await importDriveSenseBackup(file, { passphrase });
    expect(imported).toMatchObject({ trips: 1, vehicles: 0 });
  });

  it('stops decompression when an encrypted backup expands beyond its safe limit', async () => {
    const passphrase = 'correct horse battery staple';
    const encrypted = await encryptBackupText('x'.repeat(4096), passphrase);

    await expect(decryptBackupText(encrypted, passphrase, {
      maxDecompressedBytes: 128,
    })).rejects.toMatchObject({
      code: 'backup_decompressed_too_large',
      message: expect.stringContaining('safe 256 MB import limit'),
    });
  });

  it('verifies signed backup envelopes before importing data', async () => {
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-signed', status: 'completed' }],
    });
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    expect(isSignedExportEnvelope(signed)).toBe(true);
    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: true });

    const imported = await importDriveSenseBackup(file);
    expect(imported).toMatchObject({ trips: 1, vehicles: 0 });
  });

  it('resets forged Road Memory calibration from unsigned legacy backups', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const payload = roadMemoryBackupPayload();
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(payload)),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = restoredSpeedKnowledge();
    const intelligence = analyzeRoadMemoryIntelligence(restored.roadMemory.candidates);

    expect(imported).toMatchObject({
      signatureVerified: false,
      signatureRecovered: false,
      roadMemoryTrustReset: true,
    });
    expect(imported.warnings.join(' ')).toContain('prior votes and review calibration were reset');
    restored.roadMemory.candidates.forEach((candidate) => {
      expect(candidate).toMatchObject({
        active: false,
        stage: 'learning',
        reviewState: '',
        feedbackOutcome: null,
        tripIds: [],
        tripVotes: {},
        limitVotes: {},
        tripCount: 0,
        evidenceCount: 0,
        chronologyRepairPending: true,
      });
    });
    expect(intelligence.summary.calibration).toMatchObject({
      feedbackCount: 0,
      shadowDriveCount: 0,
      validated: false,
    });
    expect(intelligence.candidates.some((candidate) => candidate.canAffectScoreAndAlerts)).toBe(false);
  });

  it('keeps every unsigned coarse cell only as an ineligible trip-consensus relearning hint', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const payload = {
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [],
      speed_knowledge: {
        cells: {
          dpz83q: {
            limitKmh: 50,
            source: 'trip_consensus',
            confidence: 1,
            tripCount: 999,
            evidenceCount: 999,
            verifiedAt: '2026-08-01T12:00:00.000Z',
            verificationStatus: 'forged_operational',
          },
          dpz83r: {
            limitKmh: 40,
            source: 'user_confirmed_posted_sign',
            confidence: 1,
            tripCount: 999,
            evidenceCount: 999,
            verifiedAt: '2026-08-01T12:00:00.000Z',
            verificationStatus: 'forged_confirmed_sign',
          },
          dpz83s: {
            limitKmh: 60,
            source: 'local_road_memory',
            confidence: 1,
            tripCount: 999,
            evidenceCount: 999,
            verifiedAt: '2026-08-01T12:00:00.000Z',
            verificationStatus: 'forged_operational',
          },
        },
        corrections: [],
      },
    };
    const file = { size: 100, text: vi.fn(async () => JSON.stringify(payload)) };

    const imported = await importDriveSenseBackup(file);
    const restored = restoredSpeedKnowledge();

    expect(imported).toMatchObject({
      signatureVerified: false,
      tripConsensusTrustReset: true,
      speedKnowledgeCells: 3,
    });
    expect(imported.warnings.join(' ')).toContain('shadow relearning hints');
    expect(Object.keys(restored.cells)).toHaveLength(3);
    Object.values(restored.cells).forEach((cell) => {
      expect(cell).toMatchObject({
        source: 'trip_consensus',
        confidence: 0,
        tripCount: 0,
        evidenceCount: 0,
        verifiedAt: null,
        verificationStatus: 'imported_shadow_relearning',
        importTrustState: 'shadow_relearning',
      });
      expect(speedKnowledgeCellEligibility(cell)).toMatchObject({
        eligible: false,
        reason: 'insufficient_independent_trip_evidence',
      });
    });
  });

  it('downgrades unsigned posted corrections until the sign is reconfirmed while parked', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const postedCorrection = {
      id: 'unsigned-posted-rule',
      geohash: geohashEncode(43.7001, -79.4001),
      lat: 43.7001,
      lng: -79.4001,
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
      verifiedAt: '2026-08-01T12:00:00.000Z',
      verificationStatus: 'confirmed_posted_sign',
      sectionPoints: [
        { lat: 43.7000, lng: -79.4002 },
        { lat: 43.7002, lng: -79.4000 },
      ],
    };
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        speed_knowledge: { cells: {}, corrections: [postedCorrection] },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const [restored] = restoredSpeedKnowledge().corrections;

    expect(imported).toMatchObject({
      signatureVerified: false,
      postedCorrectionTrustReset: 1,
      speedKnowledgeCorrections: 1,
    });
    expect(imported.warnings.join(' ')).toContain('downgraded to an estimate');
    expect(restored).toMatchObject({
      id: 'unsigned-posted-rule',
      source: 'user_entered_estimate',
      verifiedAt: null,
      verificationStatus: 'imported_requires_posted_reconfirmation',
      importTrustState: 'posted_reconfirmation_required',
    });
  });

  it('preserves posted correction authority only for a verified same-device backup', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [],
      speed_knowledge: {
        cells: {},
        corrections: [{
          id: 'signed-posted-rule',
          geohash: geohashEncode(43.7001, -79.4001),
          lat: 43.7001,
          lng: -79.4001,
          limitKmh: 40,
          source: 'user_confirmed_posted_sign',
          verifiedAt: '2026-08-01T12:00:00.000Z',
          verificationStatus: 'confirmed_posted_sign',
          sectionPoints: [
            { lat: 43.7000, lng: -79.4002 },
            { lat: 43.7002, lng: -79.4000 },
          ],
        }],
      },
    });
    const file = { size: 100, text: vi.fn(async () => JSON.stringify(signed)) };

    const imported = await importDriveSenseBackup(file);
    const [restored] = restoredSpeedKnowledge().corrections;

    expect(imported).toMatchObject({
      signatureVerified: true,
      postedCorrectionTrustReset: 0,
    });
    expect(restored).toMatchObject({
      id: 'signed-posted-rule',
      source: 'user_confirmed_posted_sign',
      verificationStatus: 'confirmed_posted_sign',
    });
    expect(restored).not.toHaveProperty('importTrustState');
  });

  it('preserves authenticated coarse-cell evidence from a verified same-device backup', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [],
      speed_knowledge: {
        cells: {
          dpz83r: {
            limitKmh: 40,
            source: 'user_confirmed_posted_sign',
            confidence: 0.95,
            tripCount: 8,
            evidenceCount: 8,
            verifiedAt: '2026-08-01T12:00:00.000Z',
            verificationStatus: 'confirmed_posted_sign',
          },
        },
        corrections: [],
      },
    });
    const file = { size: 100, text: vi.fn(async () => JSON.stringify(signed)) };

    const imported = await importDriveSenseBackup(file);
    const restored = restoredSpeedKnowledge();

    expect(imported).toMatchObject({
      signatureVerified: true,
      tripConsensusTrustReset: false,
      speedKnowledgeCells: 1,
    });
    expect(restored.cells.dpz83r).toMatchObject({
      source: 'user_confirmed_posted_sign',
      confidence: 0.95,
      tripCount: 8,
      evidenceCount: 8,
      verifiedAt: '2026-08-01T12:00:00.000Z',
      verificationStatus: 'confirmed_posted_sign',
    });
    expect(restored.cells.dpz83r).not.toHaveProperty('importTrustState');
  });

  it('stops import when encrypted privacy zones cannot be hydrated', async () => {
    const privacyZones = await import('@/lib/privacyZones');
    vi.spyOn(privacyZones, 'getHydratedPrivacyZones')
      .mockRejectedValueOnce(new Error('secure zone key unavailable'));
    const file = { size: 100, text: vi.fn(async () => '{}') };

    await expect(importDriveSenseBackup(file)).rejects.toThrow(
      'could not securely load your privacy zones'
    );
    expect(file.text).not.toHaveBeenCalled();
  });

  it('stops export before packaging when encrypted privacy zones cannot be hydrated', async () => {
    const privacyZones = await import('@/lib/privacyZones');
    vi.spyOn(privacyZones, 'getHydratedPrivacyZones')
      .mockRejectedValueOnce(new Error('secure zone key unavailable'));

    await expect(exportDriveSenseBackup({
      trips: [],
      vehicles: [],
      settings: { privacy_zones: [{ id: 'redacted-home-zone' }] },
    })).rejects.toThrow('could not securely load your privacy zones');
  });

  it('resets forged Road Memory calibration during explicit invalid-signature recovery', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const signed = await signExport(roadMemoryBackupPayload());
    signed.signature = signed.signature.replace(/.$/, signed.signature.endsWith('A') ? 'B' : 'A');
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    const imported = await importDriveSenseBackup(file, { allowUnverifiedSignedBackup: true });
    const restored = restoredSpeedKnowledge();
    const intelligence = analyzeRoadMemoryIntelligence(restored.roadMemory.candidates);

    expect(imported).toMatchObject({
      signatureVerified: false,
      signatureRecovered: true,
      roadMemoryTrustReset: true,
    });
    expect(restored.roadMemory.candidates[0]).toMatchObject({
      tripIds: [],
      tripVotes: {},
      limitVotes: {},
      tripCount: 0,
      reviewState: '',
      chronologyRepairPending: true,
    });
    expect(intelligence.summary.calibration.validated).toBe(false);
    expect(intelligence.candidates.some((candidate) => candidate.canAffectScoreAndAlerts)).toBe(false);
  });

  it('preserves authenticated Road Memory calibration from a verified same-device backup', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    const signed = await signExport(roadMemoryBackupPayload());
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = restoredSpeedKnowledge();
    const intelligence = analyzeRoadMemoryIntelligence(restored.roadMemory.candidates);
    const target = intelligence.candidates.find((candidate) => candidate.id === 'trust-target');

    expect(imported).toMatchObject({
      signatureVerified: true,
      signatureRecovered: false,
      roadMemoryTrustReset: false,
    });
    expect(restored.roadMemory.candidates[0]).toMatchObject({
      tripCount: 20,
      evidenceCount: 20,
      agreement: 1,
      limitVotes: { 50: 20 },
      chronologyRepairPending: false,
    });
    expect(intelligence.summary.calibration).toMatchObject({
      feedbackCount: 8,
      exactCount: 8,
      shadowDriveCount: 20,
      validated: true,
    });
    expect(target).toMatchObject({
      usageStage: 'validated',
      canAffectScoreAndAlerts: true,
    });
  });

  it('recalculates a stale Road Memory-derived trip against the durable trust-reset revision', async () => {
    const { tripService } = await import('@/api/trips');
    await setJson('drivesense_rescoring_queue_v1', []);
    const trustedCandidates = trustedRoadMemoryCandidates();
    const initialKnowledge = {
      schemaVersion: 2,
      knowledgeRevision: 12,
      knowledgeUpdatedAt: '2026-08-01T12:00:00.000Z',
      cells: {},
      corrections: [],
      excludedSections: [],
      roadMemory: {
        version: 3,
        candidates: trustedCandidates,
        processedTrips: {},
        intelligence: null,
      },
    };
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge(initialKnowledge);
    const target = trustedCandidates[0];
    const staleTrip = {
      id: 'trip-with-forged-road-memory-score',
      status: 'completed',
      start_time: '2026-08-01T12:00:00.000Z',
      end_time: '2026-08-01T12:01:00.000Z',
      overall_compliance_score: 0,
      speed_knowledge_revision: 12,
      route_points: [
        {
          ...target.sectionPoints[0],
          timestamp: '2026-08-01T12:00:00.000Z',
          speed_kmh: 65,
          accuracy: 5,
        },
        {
          ...target.sectionPoints[1],
          timestamp: '2026-08-01T12:01:00.000Z',
          speed_kmh: 65,
          accuracy: 5,
        },
      ],
    };
    let updatedTrip = null;
    tripService.listAll.mockResolvedValueOnce([staleTrip]);
    tripService.update.mockImplementationOnce(async (id, scorePatch) => {
      updatedTrip = { ...staleTrip, id, ...scorePatch };
      return updatedTrip;
    });
    const payload = roadMemoryBackupPayload();
    payload.trips = [staleTrip];
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(payload)),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = restoredSpeedKnowledge();

    expect(imported).toMatchObject({
      roadMemoryTrustReset: true,
      speedKnowledgeRestored: true,
      speedKnowledgeTripsRecalculated: 1,
      speedKnowledgeTripsQueued: 0,
      speedKnowledgeTripsAffected: 1,
      speedKnowledgeTargetRevision: 13,
      speedKnowledgeRescoreFailed: false,
    });
    expect(restored).toMatchObject({ knowledgeRevision: 13 });
    expect(restored.roadMemory.candidates[0]).toMatchObject({
      active: false,
      tripCount: 0,
      chronologyRepairPending: true,
    });
    expect(updatedTrip).toEqual(expect.objectContaining({
      id: staleTrip.id,
      needs_rescore: false,
      speed_knowledge_revision: 13,
    }));
    expect(updatedTrip.overall_compliance_score).not.toBe(staleTrip.overall_compliance_score);
  });

  it('keeps restored knowledge committed and warns truthfully when post-import rescoring cannot start', async () => {
    const { tripService } = await import('@/api/trips');
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge();
    tripService.listAll.mockRejectedValueOnce(new Error('trip index unavailable'));
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(roadMemoryBackupPayload())),
    };

    const imported = await importDriveSenseBackup(file);

    expect(restoredSpeedKnowledge().roadMemory.candidates).toHaveLength(9);
    expect(imported).toMatchObject({
      speedKnowledgeRestored: true,
      speedKnowledgeTripsRecalculated: null,
      speedKnowledgeTripsQueued: null,
      speedKnowledgeTripsAffected: null,
      speedKnowledgeRescoreFailed: true,
    });
    expect(imported.warnings.join(' ')).toContain(
      'affected trip scores could not be recalculated right now'
    );
  });

  it('restores an explicitly empty current-format speed store and retires stale local rules', async () => {
    const restoredSpeedKnowledge = captureRestoredSpeedKnowledge({
      schemaVersion: 2,
      knowledgeRevision: 4,
      knowledgeUpdatedAt: '2026-08-01T12:00:00.000Z',
      cells: {},
      corrections: [{
        id: 'stale-local-rule',
        geohash: geohashEncode(43.65, -79.38),
        lat: 43.65,
        lng: -79.38,
        limitKmh: 50,
        source: 'user_confirmed_posted_sign',
        sectionPoints: [
          { lat: 43.65, lng: -79.381 },
          { lat: 43.65, lng: -79.379 },
        ],
      }],
      excludedSections: [],
      roadMemory: { version: 3, candidates: [], processedTrips: {}, intelligence: null },
    });
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        speed_knowledge: {
          cells: {},
          corrections: [],
          excludedSections: [],
          roadMemory: { version: 3, candidates: [] },
        },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = restoredSpeedKnowledge();

    expect(imported).toMatchObject({
      speedKnowledgeRestored: true,
      speedKnowledgeCells: 0,
      speedKnowledgeCorrections: 0,
      speedKnowledgeTripsAffected: 0,
      speedKnowledgeRescoreFailed: false,
    });
    expect(restored.corrections).toEqual([]);
    expect(restored.knowledgeRevision).toBe(5);
  });

  it('rejects tampered signed backups before writing trips or vehicles', async () => {
    const { tripService } = await import('@/api/trips');
    const { vehicleService } = await import('@/api/vehicles');
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [{ id: 'vehicle-original', name: 'Original' }],
      trips: [{ id: 'trip-original', status: 'completed' }],
    });
    signed.payload.trips.push({ id: 'trip-fabricated', status: 'completed' });
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    await expect(importDriveSenseBackup(file)).rejects.toMatchObject({
      code: BACKUP_SIGNATURE_INVALID_CODE,
      message: expect.stringContaining('Backup signature invalid'),
    });
    expect(tripService.upsertMany).not.toHaveBeenCalled();
    expect(vehicleService.upsertMany).not.toHaveBeenCalled();
  });

  it('can explicitly recover the payload from a signed readable backup after signature key loss', async () => {
    const { localSettings } = await import('@/lib/trackingStore');
    const updateSettingsSpy = vi.spyOn(localSettings, 'update');
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      settings: {
        automatic_context_fetch_enabled: true,
        weather_context_enabled: true,
        speed_limit_lookup_enabled: true,
      },
      vehicles: [],
      trips: [{ id: 'trip-reinstall-recovery', status: 'completed' }],
    });
    signed.signature = signed.signature.replace(/.$/, signed.signature.endsWith('A') ? 'B' : 'A');
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    const imported = await importDriveSenseBackup(file, { allowUnverifiedSignedBackup: true });

    expect(imported).toMatchObject({
      trips: 1,
      vehicles: 0,
      signatureRecovered: true,
      settings: false,
      settingsSkippedForSignatureRecovery: true,
    });
    expect(updateSettingsSpy).not.toHaveBeenCalled();
  });
});

describe('backup schema migrations', () => {
  it('migrates a v3 trip through scoring refresh to the current backup version', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: 3,
      trips: [{ id: 'trip-v3', status: 'completed' }],
    }));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.sourceVersion).toBe(3);
    expect(parsed.trips[0].needs_rescore).toBe(true);
  });

  it('relabels legacy lane-change events when migrating v5 backups', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: 5,
      trips: [{
        id: 'trip-v5',
        status: 'completed',
        distance_km: 10,
        lane_changes_count: 1,
        driving_events: [{ type: 'lane_change', severity: 'medium' }],
      }],
    }));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.sourceVersion).toBe(5);
    expect(parsed.trips[0].driving_events[0]).toMatchObject({
      type: 'heading_deviation_legacy',
      legacy_renamed: true,
    });
    expect(parsed.trips[0].lane_changes_count).toBeUndefined();
    expect(parsed.trips[0].heading_deviation_count).toBe(0);
    expect(parsed.trips[0].heading_deviation_legacy_count).toBe(1);
  });

  it('migrates v6 content to the current schema with empty calibration payload', () => {
    const v6 = { app: 'Road Sage', version: 6, trips: [{ id: 'trip-v6', notes: 'kept' }] };
    expect(migrateBackup(v6, 6)).toEqual({
      ...v6,
      version: BACKUP_VERSION,
      calibration: { labels: [], survey_markers: {} },
      export_id: null,
      privacy_export: {
        zone_commitment_scheme: null,
        zone_commitment_count: 0,
      },
      zone_commitments: [],
      speed_knowledge: { cells: {}, corrections: [] },
    });
  });

  it('migrates v7 backups to the current privacy-safe backup schema', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: 7,
      vehicles: [],
      trips: [{ id: 'trip-v7', status: 'completed' }],
      settings: {
        privacy_zones: [{
          id: 'home',
          label: 'Home',
          radius_m: 100,
          privacy_cell_hashes: ['pzc_legacy'],
          masked_for_privacy: true,
        }],
      },
    }));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.sourceVersion).toBe(7);
    expect(parsed.trips[0].id).toBe('trip-v7');
  });

  it('migrates v8 backups with empty commitment metadata', () => {
    const v8 = {
      app: 'Road Sage',
      version: 8,
      vehicles: [],
      trips: [{ id: 'trip-v8', status: 'completed' }],
      privacy_export: {
        timestamp_fuzzing_enabled: true,
      },
    };

    expect(migrateBackup(v8, 8)).toEqual({
      ...v8,
      version: BACKUP_VERSION,
      export_id: null,
      privacy_export: {
        timestamp_fuzzing_enabled: true,
        zone_commitment_scheme: null,
        zone_commitment_count: 0,
      },
      zone_commitments: [],
      speed_knowledge: { cells: {}, corrections: [] },
    });
  });

  it('rejects backups newer than the current schema', () => {
    expect(() => parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION + 1,
      trips: [],
    }))).toThrow('newer than this app supports');
  });

  it('treats a versionless backup as v1', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      trips: [{ id: 'trip-v1', status: 'completed' }],
    }));

    expect(parsed.sourceVersion).toBe(1);
    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.trips[0].needs_rescore).toBe(true);
  });
});

describe('backup calibration labels', () => {
  afterEach(async () => {
    await localCalibrationLabelRepository.replaceAll([]);
    await localCalibrationLabelRepository.replaceTripSurveyMarkers({});
    vi.clearAllMocks();
  });

  it('exports and parses local survey labels and trip markers', async () => {
    const backup = await buildDriveSenseBackup({
      trips: [{ id: 'trip-calibration', status: 'completed' }],
      vehicles: [],
      calibrationLabels: [{
        id: 'label-1',
        upload_status: 'local_only',
        scoreOutput: { overall: 82 },
        surveyLabel: {
          overallDriveRating: 4,
          targetScore: 75,
          wasDriver: 'yes',
          contextTags: ['traffic'],
        },
        local_only_note: 'kept in user backup',
      }],
      calibrationSurveyMarkers: {
        'trip-calibration': {
          label_id: 'label-1',
          rating: 4,
          upload_status: 'local_only',
        },
      },
    });

    const parsed = parseDriveSenseBackup(JSON.stringify(backup));

    expect(parsed.calibration.labels).toHaveLength(1);
    expect(parsed.calibration.labels[0].surveyLabel.overallDriveRating).toBe(4);
    expect(parsed.calibration.survey_markers['trip-calibration']).toMatchObject({
      label_id: 'label-1',
      rating: 4,
    });
  });

  it('restores calibration labels during backup import', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        calibration: {
          labels: [{
            id: 'label-imported',
            scoreOutput: { overall: 70 },
            surveyLabel: { overallDriveRating: 5, targetScore: 100, wasDriver: 'yes' },
          }],
          survey_markers: {
            'trip-imported': { label_id: 'label-imported', rating: 5 },
          },
        },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const labels = await localCalibrationLabelRepository.list();
    const marker = await localCalibrationLabelRepository.getTripSurveyStatus('trip-imported');

    expect(imported).toMatchObject({
      calibrationLabels: 1,
      calibrationLabelsRestored: true,
    });
    expect(labels[0].id).toBe('label-imported');
    expect(marker).toMatchObject({ label_id: 'label-imported', rating: 5 });
  });
});

describe('backup speed knowledge', () => {
  afterEach(async () => {
    await setJson(SPEED_KNOWLEDGE_STORAGE_KEY, { cells: {}, corrections: [] });
    vi.clearAllMocks();
  });

  it('exports and parses local speed knowledge while dropping private-zone corrections', async () => {
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 150 }],
    };
    const backup = await buildDriveSenseBackup({
      trips: [],
      vehicles: [],
      settings,
      speedKnowledge: {
        schemaVersion: 2,
        knowledgeRevision: 23,
        knowledgeUpdatedAt: '2026-06-04T12:00:00.000Z',
        cells: {
          dpz83q: {
            limitKmh: 50,
            source: 'trip_consensus',
            confidence: 0.7,
            tripCount: 3,
            evidenceCount: 4,
            firstSeenAt: '2026-06-01T12:00:00.000Z',
            lastUpdatedAt: '2026-06-02T12:00:00.000Z',
            verifiedAt: '2026-06-02T12:00:00.000Z',
            verificationStatus: 'learned_from_confirmed_source',
            auditTrail: [{
              action: 'evidence_added',
              changedAt: '2026-06-02T12:00:00.000Z',
              pointSource: 'osm_maxspeed',
            }],
          },
          [geohashEncode(43.65, -79.38)]: {
            limitKmh: 30,
            source: 'trip_consensus',
            confidence: 0.8,
            tripCount: 4,
          },
        },
        corrections: [
          {
            geohash: 'dpz83q',
            lat: 43.7001,
            lng: -79.4001,
            limitKmh: 40,
            note: 'school zone',
            source: 'user_confirmed_posted_sign',
            validFrom: '2026-06-03T12:00:00.000Z',
            validFromDate: '2026-06-03',
            roadName: 'King Street',
            verifiedAt: '2026-06-03T12:00:00.000Z',
            verificationStatus: 'confirmed_posted_sign',
            evidenceCount: 2,
            sectionPoints: [
              { lat: 43.7001, lng: -79.4001 },
              { lat: 43.7003, lng: -79.4003 },
            ],
            editHistory: [{
              changedAt: '2026-06-03T11:00:00.000Z',
              previousLimitKmh: 50,
              previousSource: 'user_entered_estimate',
            }],
            auditTrail: [{
              action: 'updated',
              changedAt: '2026-06-03T12:00:00.000Z',
              previousLimitKmh: 50,
              nextLimitKmh: 40,
            }],
          },
          {
            geohash: 'dpz800',
            lat: 43.65,
            lng: -79.38,
            limitKmh: 30,
            note: 'inside privacy zone',
            source: 'user_entered_estimate',
          },
        ],
        excludedSections: [{
          id: 'safe-excluded-road',
          geohash: geohashEncode(43.7001, -79.4001),
          lat: 43.7001,
          lng: -79.4001,
          roadName: 'Parking access road',
          reason: 'parking_private',
          sectionPoints: [
            { lat: 43.7001, lng: -79.4001 },
            { lat: 43.7003, lng: -79.4003 },
          ],
        }, {
          id: 'private-excluded-road',
          geohash: geohashEncode(43.65, -79.38),
          lat: 43.65,
          lng: -79.38,
          reason: 'parking_private',
        }],
      },
    });

    expect(backup.privacy_export.no_backup_keys).not.toContain(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(backup.privacy_export.no_backup_keys).toContain(
      'drivesense_parking_learning_v1',
    );
    expect(backup.speed_knowledge.cells.dpz83q).toMatchObject({
      limitKmh: 50,
      source: 'trip_consensus',
      tripCount: 3,
      evidenceCount: 4,
      verificationStatus: 'learned_from_confirmed_source',
    });
    expect(backup.speed_knowledge.cells).not.toHaveProperty(geohashEncode(43.65, -79.38));
    expect(backup.speed_knowledge.cells.dpz83q.auditTrail).toEqual([expect.objectContaining({
      action: 'evidence_added',
      pointSource: 'osm_maxspeed',
    })]);
    expect(backup.speed_knowledge.corrections).toHaveLength(1);
    expect(backup.speed_knowledge.corrections[0]).toMatchObject({
      geohash: 'dpz83q',
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
      roadName: 'King Street',
      note: 'school zone',
      verifiedAt: '2026-06-03T12:00:00.000Z',
      verificationStatus: 'confirmed_posted_sign',
      evidenceCount: 2,
      validFrom: '2026-06-03T12:00:00.000Z',
      validFromDate: '2026-06-03',
    });
    expect(backup.speed_knowledge).toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 23,
      knowledgeUpdatedAt: '2026-06-04T12:00:00.000Z',
      excludedSections: [expect.objectContaining({
        id: expect.stringMatching(/^excluded-/),
        roadName: 'Parking access road',
      })],
    });
    expect(backup.speed_knowledge.corrections[0].editHistory).toHaveLength(1);
    expect(backup.speed_knowledge.corrections[0].auditTrail).toEqual([expect.objectContaining({
      action: 'updated',
      previousLimitKmh: 50,
      nextLimitKmh: 40,
    })]);

    const parsed = parseDriveSenseBackup(JSON.stringify(backup));
    expect(parsed.speed_knowledge.corrections).toHaveLength(1);
    expect(parsed.speed_knowledge.corrections[0].sectionPoints).toHaveLength(2);
    expect(parsed.speed_knowledge.corrections[0]).toMatchObject({
      source: 'user_entered_estimate',
      verifiedAt: null,
      verificationStatus: 'imported_requires_posted_reconfirmation',
      importTrustState: 'posted_reconfirmation_required',
      evidenceCount: 2,
      validFrom: '2026-06-03T12:00:00.000Z',
      validFromDate: '2026-06-03',
    });
    expect(parsed.speed_knowledge).toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 23,
      knowledgeUpdatedAt: '2026-06-04T12:00:00.000Z',
      excludedSections: [expect.objectContaining({ id: expect.stringMatching(/^excluded-/) })],
    });
    expect(parsed.speed_knowledge.corrections[0].auditTrail).toHaveLength(1);
  });

  it('restores speed knowledge during backup import', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        speed_knowledge: {
          schemaVersion: 2,
          knowledgeRevision: 7,
          knowledgeUpdatedAt: '2026-07-30T12:00:00.000Z',
          cells: {
            dpz83q: {
              limitKmh: 50,
              source: 'trip_consensus',
              confidence: 0.7,
              tripCount: 2,
            },
          },
          corrections: [{
            geohash: 'dpz83r',
            lat: 43.7001,
            lng: -79.4001,
            limitKmh: 40,
            source: 'user_entered_estimate',
            note: 'saved estimate',
            validFrom: '2026-08-01T12:00:00.000Z',
            validFromDate: '2026-08-01',
          }],
          excludedSections: [{
            id: 'excluded-imported-road',
            geohash: 'dpz83q',
            lat: 43.7001,
            lng: -79.4001,
            roadName: 'Imported parking road',
            reason: 'parking_private',
            sectionPoints: [
              { lat: 43.7001, lng: -79.4001 },
              { lat: 43.7003, lng: -79.4003 },
            ],
          }],
        },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = await speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY);

    expect(imported).toMatchObject({
      speedKnowledgeCells: 1,
      speedKnowledgeCorrections: 1,
      excludedSpeedSections: 1,
      speedKnowledgeRestored: true,
    });
    expect(restored.corrections[0]).toMatchObject({
      geohash: 'dpz83r',
      limitKmh: 40,
      note: 'saved estimate',
      validFrom: '2026-08-01T12:00:00.000Z',
      validFromDate: '2026-08-01',
    });
    expect(restored).toMatchObject({
      schemaVersion: 2,
      knowledgeUpdatedAt: expect.any(String),
      excludedSections: [expect.objectContaining({
        id: expect.stringMatching(/^excluded-/),
        roadName: 'Imported parking road',
      })],
    });
    expect(restored.knowledgeRevision).toBeGreaterThan(7);
  });

  it('restores persisted learning exclusions even when the backup has no saved limits', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        speed_knowledge: {
          cells: {},
          corrections: [],
          excludedSections: [{
            id: 'exclusion-only-road',
            geohash: geohashEncode(44.1001, -80.1001),
            lat: 44.1001,
            lng: -80.1001,
            reason: 'parking_private',
          }],
        },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = await speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY);

    expect(imported).toMatchObject({
      speedKnowledgeCells: 0,
      speedKnowledgeCorrections: 0,
      excludedSpeedSections: 1,
      speedKnowledgeRestored: true,
    });
    expect(restored.excludedSections).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^excluded-/), reason: 'parking_private' }),
    ]);
  });

  it('keeps imported old and new correction versions linked through routine pruning', async () => {
    const geohash = geohashEncode(44.2001, -80.2001);
    const coordinate = { lat: 44.2001, lng: -80.2001 };
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        speed_knowledge: {
          cells: {},
          corrections: [{
            id: 'old-version',
            geohash,
            ...coordinate,
            limitKmh: 40,
            source: 'user_entered_estimate',
            validFrom: '2025-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:00:00.000Z',
            historicalVersion: true,
            supersededAt: '2026-01-01T00:00:00.000Z',
            supersededByCorrectionId: 'new-version',
            versionRootId: 'old-version',
          }, {
            id: 'new-version',
            geohash,
            ...coordinate,
            limitKmh: 50,
            source: 'user_confirmed_posted_sign',
            validFrom: '2026-01-01T00:00:00.000Z',
            supersedesCorrectionId: 'old-version',
            versionRootId: 'old-version',
          }],
        },
      })),
    };

    await importDriveSenseBackup(file);
    const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
    await knowledge.prune(1);
    const versions = await knowledge.listUserCorrections();

    expect(versions).toHaveLength(2);
    expect(versions.find((item) => item.id === 'old-version')).toMatchObject({
      historicalVersion: true,
      supersededByCorrectionId: 'new-version',
      versionRootId: 'old-version',
    });
    expect(versions.find((item) => item.id === 'new-version')).toMatchObject({
      historicalVersion: false,
      supersedesCorrectionId: 'old-version',
      versionRootId: 'old-version',
    });
  });
});

describe('backup export privacy', () => {
  it('cancels between trip transforms without creating a download', async () => {
    const controller = new AbortController();
    const progress = [];

    await expect(exportDriveSenseBackup({
      trips: [
        { id: 'trip-cancel-1', status: 'completed', route_points: [{ lat: 43.65, lng: -79.38 }] },
        { id: 'trip-cancel-2', status: 'completed', route_points: [{ lat: 43.66, lng: -79.39 }] },
      ],
      vehicles: [],
      settings: { privacy_zones: [] },
      signal: controller.signal,
      onProgress: (entry) => {
        progress.push(entry);
        if (entry.phase === 'protecting' && entry.completed === 1) controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(progress).toContainEqual(expect.objectContaining({
      phase: 'protecting',
      completed: 1,
      total: 2,
    }));
  });

  it('logs full-backup exports from the actual signed payload shape', async () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    const clicked = vi.fn();
    const anchor = {
      href: '',
      download: '',
      style: {},
      click: clicked,
      remove: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    });
    const RealURL = globalThis.URL;
    const createObjectURL = vi.fn(() => 'blob:road-sage-backup');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class TestURL extends RealURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });

    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
    };
    const result = await exportDriveSenseBackup({
      trips: [],
      vehicles: [],
      settings,
      filename: 'backup.json',
    });

    const payloadText = JSON.stringify(result.signedBackup);
    const [entry] = await loadTransmissionLog();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(payloadText).not.toContain('"lat"');
    expect(payloadText).not.toContain('"lng"');
    expect(payloadText).not.toContain('"radius_m"');
    expect(payloadText).not.toContain('"label":"Home"');
    expect(entry).toMatchObject({
      service: 'export',
      coordinateDisclosure: 'committed',
      privacyTransformVerified: true,
      privacyTransformSource: 'dataBackup.js:buildDriveSenseBackup',
      privacyVerificationEvidence: [
        'backup payload was inspected for zone coordinate and radius fields',
        'privacy zones are exported as coordinate-free commitments',
      ],
      sentCoords: '0 - zone coordinates and ranges excluded, boundary points committed',
      bytesOut: payloadText.length,
      status: 'safe',
      zonesSuppressed: ['Private area'],
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });

  it('replaces exported privacy boundaries with opaque placeholders', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
      last_map_center: { lat: 43.65, lng: -79.38, source: 'privacy-zone-review' },
    };
    const trip = {
      id: 'trip-private-boundary',
      status: 'completed',
      start_time: '2026-01-01T12:00:00.000Z',
      avg_speed_kmh: 80,
      avg_running_speed_kmh: 85,
      max_speed_kmh: 120,
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z', speed_kmh: 120, heading: 45 },
        { lat: 43.6522, lng: -79.38, timestamp: '2026-01-01T12:00:20.000Z', speed_kmh: 20, radius_m: 999 },
        { lat: 43.6532, lng: -79.38, timestamp: '2026-01-01T12:00:40.000Z', speed_kmh: 40 },
      ],
      driving_events: [],
    };
    const exactBoundary = maskTripForPrivacy(trip, settings).route_points.find((point) => point.privacy_boundary);

    const backup = await buildDriveSenseBackup({ trips: [trip], vehicles: [], settings });
    const exportedPlaceholder = backup.trips[0].route_points.find((point) => point.privacy_export_placeholder);
    const [zoneCommitment] = backup.zone_commitments;

    expect(backup.trips[0].route_points.some((point) => point.privacy_boundary)).toBe(false);
    expect(backup.privacy_export).toMatchObject({
      timestamp_fuzzing_enabled: true,
      timestamp_shift_policy: 'bounded_private_zone_noise',
      zone_commitment_scheme: 'sha256_zone_center_export_salt_v2',
      zone_commitment_count: 1,
      zone_placeholder_count: 1,
      shifted_trip_count: 1,
      boundary_placeholder_count: 1,
      shifted_trip_ids: ['trip-private-boundary'],
    });
    expect(backup.trips[0]).toMatchObject({
      avg_speed_kmh: 30,
      avg_running_speed_kmh: 30,
      max_speed_kmh: 40,
      privacy_time_shifted: true,
      privacy_time_shifted_fields: ['start_time'],
    });
    expect(exportedPlaceholder).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
      privacy_zone_id: 'private_area',
      privacy_zone_label: 'Private area',
    });
    expect(JSON.stringify(backup.trips[0].route_points)).not.toContain(String(exactBoundary.lat));
    expect(exportedPlaceholder.radius_m).toBeUndefined();
    expect(backup.settings.privacy_zones[0]).toMatchObject({
      id: 'private_area_1',
      label: 'Private area',
      masked_for_privacy: true,
      reconfiguration_required: true,
    });
    expect(backup.settings.privacy_zones[0].radius_m).toBeUndefined();
    expect(backup.settings.privacy_zones[0].privacy_cell_hashes).toBeUndefined();
    expect(backup.settings.last_map_center).toBeUndefined();
    expect(JSON.stringify(backup.settings.privacy_zones)).not.toContain('privacy_cell_hashes');
    expect(JSON.stringify(backup.settings)).not.toContain('privacy-zone-review');
    expect(zoneCommitment).toMatchObject({
      zone_ref: 'private_area',
      export_id: backup.export_id,
    });
    expect(zoneCommitment.commitment).toEqual(expect.any(String));
    expect(zoneCommitment).not.toHaveProperty('zone_id');
    expect(zoneCommitment).not.toHaveProperty('zone_label');
    expect(zoneCommitment).not.toHaveProperty('zone_radius_m');
    expect(zoneCommitment).not.toHaveProperty('lat');
    expect(zoneCommitment).not.toHaveProperty('lng');
    expect(zoneCommitment).not.toHaveProperty('latitude');
    expect(zoneCommitment).not.toHaveProperty('longitude');
    expect(zoneCommitment).not.toHaveProperty('salt');
    expect(JSON.stringify(backup.zone_commitments)).not.toContain('43.65');
    expect(JSON.stringify(backup.zone_commitments)).not.toContain('-79.38');
    expect(JSON.stringify(backup)).not.toContain('"radius_m":100');
    expect(JSON.stringify(backup)).not.toContain('"zone_radius_m"');
    expect(JSON.stringify(backup)).not.toContain('"label":"Home"');
  });

  it('generates unlinkable privacy-zone commitments for repeated exports', async () => {
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
    };

    const first = await buildDriveSenseBackup({ trips: [], vehicles: [], settings });
    const second = await buildDriveSenseBackup({ trips: [], vehicles: [], settings });

    expect(first.export_id).not.toBe(second.export_id);
    expect(first.zone_commitments[0].commitment).not.toBe(second.zone_commitments[0].commitment);
    expect(first.zone_commitments[0].export_id).toBe(first.export_id);
    expect(second.zone_commitments[0].export_id).toBe(second.export_id);
  });
});
