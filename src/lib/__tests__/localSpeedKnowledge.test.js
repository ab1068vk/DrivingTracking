import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';

const speedRefreshMocks = vi.hoisted(() => ({
  refreshCell: vi.fn(async () => []),
}));

vi.mock('@/lib/localSpeedScoreRefresh', () => ({
  refreshTripsCrossingLocalSpeedCell: (...args) => speedRefreshMocks.refreshCell(...args),
}));

vi.mock('@/lib/privacyZones', () => ({
  boundsOverlapPrivacyZone: vi.fn(() => false),
  getPrivacyZones: vi.fn(() => []),
  isInsidePrivacyZone: vi.fn(() => false),
  routeTouchesPrivacyZone: vi.fn(() => false),
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

function memoryStore() {
  const values = new Map();
  return {
    get: vi.fn(async (key, fallback) => values.get(key) ?? fallback),
    set: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
  };
}

describe('LocalSpeedKnowledge events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    speedRefreshMocks.refreshCell.mockClear();
    const target = new EventTarget();
    vi.stubGlobal('CustomEvent', class CustomEvent extends Event {
      constructor(type, params = {}) {
        super(type);
        this.detail = params.detail;
      }
    });
    vi.stubGlobal('window', {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    });
  });

  it('loads the complete Speed Limits screen snapshot with one storage read', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.saveUserCorrection(
      43.6501,
      -79.3801,
      50,
      'Main Street',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        roadName: 'Main Street',
        sectionPoints: [
          { lat: 43.6501, lng: -79.3803 },
          { lat: 43.6501, lng: -79.3799 },
        ],
      }
    );
    store.get.mockClear();

    const snapshot = await knowledge.getSpeedLimitsSnapshot();

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
    });
    expect(snapshot).toMatchObject({
      candidates: [],
      exclusions: [],
      history: { canUndo: true, canRedo: false },
      protection: { confirmedCorridorCount: 1, suppressedSuggestionCount: 0 },
    });
    expect(snapshot.rawKnowledge.corrections).toHaveLength(1);
  });

  it('resolves the Dashboard active speed with one storage read', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.saveUserCorrection(
      43.6501,
      -79.3801,
      50,
      'Main Street',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        roadName: 'Main Street',
        sectionPoints: [
          { lat: 43.6501, lng: -79.3803 },
          { lat: 43.6501, lng: -79.3799 },
        ],
      }
    );
    store.get.mockClear();

    const snapshot = await knowledge.getDashboardSpeedSnapshot({
      lat: 43.6501,
      lng: -79.3801,
      timestampMs: Date.now(),
    });

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(snapshot.activeDecision).toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      roadName: 'Main Street',
    });
  });

  it('emits a shared change event when user speed corrections are saved, updated, and removed', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    const listener = vi.fn();
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, listener);

    try {
      const saved = await knowledge.saveUserCorrection(
        43.6501,
        -79.3801,
        50,
        '',
        null,
        [],
        'user_confirmed_posted_sign'
      );
      const [correction] = await knowledge.listUserCorrections();
      const updated = await knowledge.updateUserCorrection(correction.geohash, 60, 'user_entered_estimate');
      const removed = await knowledge.removeUserCorrection(correction.geohash);

      expect(saved).toMatchObject({
        id: expect.any(String),
        geohash: correction.geohash,
        limitKmh: 50,
        source: 'user_confirmed_posted_sign',
        verificationStatus: 'confirmed_posted_sign',
      });
      expect(updated).toBe(true);
      expect(removed).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener.mock.calls[0][0].detail.correctionId).toBe(saved.id);
      expect(listener.mock.calls.map(([event]) => event.detail.action)).toEqual([
        'save_correction',
        'update_correction',
        'remove_correction',
      ]);
    } finally {
      window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, listener);
    }
  });

  it('serializes concurrent mutations across instances and advances one durable revision per write', async () => {
    const store = memoryStore();
    const firstInstance = new LocalSpeedKnowledge(store);
    const secondInstance = new LocalSpeedKnowledge(store);

    await Promise.all([
      firstInstance.saveUserCorrection(
        43.6501,
        -79.3801,
        40,
        'First road',
        null,
        [],
        'user_confirmed_posted_sign'
      ),
      secondInstance.saveUserCorrection(
        43.6601,
        -79.3901,
        60,
        'Second road',
        null,
        [],
        'user_confirmed_posted_sign'
      ),
    ]);

    const data = await firstInstance.exportData();
    expect(data.corrections.map((correction) => correction.limitKmh).sort()).toEqual([40, 60]);
    expect(data).toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 2,
      knowledgeUpdatedAt: expect.any(String),
    });
    await expect(secondInstance.getMetadata()).resolves.toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 2,
    });
  });

  it('matches adjacent user-labeled 50 and 60 km/h traced road sections with rule metadata', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.replaceData({
      cells: {},
      corrections: [
        {
          id: 'posted-50-section',
          geohash: geohashEncode(43.6532, -79.3857, 6),
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
          appliedAt: '2026-06-23T12:00:00.000Z',
          sectionPoints: [
            { lat: 43.6532, lng: -79.3860 },
            { lat: 43.6532, lng: -79.3852 },
          ],
        },
        {
          id: 'posted-60-section',
          geohash: geohashEncode(43.6532, -79.3827, 6),
          limitKmh: 60,
          source: 'user_confirmed_posted_sign',
          appliedAt: '2026-06-23T12:01:00.000Z',
          sectionPoints: [
            { lat: 43.6532, lng: -79.3830 },
            { lat: 43.6532, lng: -79.3822 },
          ],
        },
      ],
    });

    const firstHalf = await knowledge.getForPoint(43.6532, -79.38555);
    const secondHalf = await knowledge.getForPoint(43.6532, -79.38255);
    const gap = await knowledge.getForPoint(43.6532, -79.3841);

    expect(firstHalf).toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      correctionId: 'posted-50-section',
      matchType: 'traced_section',
      matchReason: 'matched_traced_section',
    });
    expect(secondHalf).toMatchObject({
      limitKmh: 60,
      source: 'user_confirmed_posted_sign',
      correctionId: 'posted-60-section',
      matchType: 'traced_section',
      matchReason: 'matched_traced_section',
    });
    expect(gap).toBeNull();
  });

  it('updates imported section-key corrections instead of duplicating them', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.replaceData({
      cells: {},
      corrections: [{
        sectionKey: 'imported-section-key',
        geohash: geohashEncode(43.6532, -79.3832, 6),
        lat: 43.6532,
        lng: -79.3832,
        limitKmh: 50,
        source: 'user_entered_estimate',
        appliedAt: '2026-06-23T12:00:00.000Z',
      }],
    });

    const updated = await knowledge.updateUserCorrection(
      'imported-section-key',
      50,
      'user_confirmed_posted_sign',
      'Confirmed posted sign'
    );
    const data = await knowledge.exportData();

    expect(updated).toBe(true);
    expect(data.corrections).toHaveLength(1);
    expect(data.corrections[0]).toMatchObject({
      id: 'imported-section-key',
      sectionKey: 'imported-section-key',
      source: 'user_confirmed_posted_sign',
      verificationStatus: 'confirmed_posted_sign',
    });
  });

  it('keeps coarse conflicts shadow-only until review supplies traced road geometry', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    const geohash = geohashEncode(43.6532, -79.3832, 6);
    await knowledge.replaceData({
      cells: {
        [geohash]: {
          limitKmh: 40,
          conflict: true,
          source: 'trip_consensus',
          lastUpdatedAt: new Date().toISOString(),
        },
      },
      corrections: [],
    });

    await expect(knowledge.resolveConflict(geohash, 50)).resolves.toBe(false);
    expect((await knowledge.exportData()).cells[geohash]?.conflict).toBe(true);

    const resolved = await knowledge.resolveConflict(
      geohash,
      50,
      'user_confirmed_posted_sign',
      'Confirmed on traced road',
      {
        lat: 43.6532,
        lng: -79.3832,
        sectionPoints: [
          { lat: 43.6532, lng: -79.3842 },
          { lat: 43.6532, lng: -79.3822 },
        ],
      }
    );
    const data = await knowledge.exportData();

    expect(resolved).toMatchObject({ limitKmh: 50, provenance: 'coarse_conflict_review' });
    expect(data.cells[geohash]).toBeUndefined();
    expect(data.corrections).toHaveLength(1);
    await expect(knowledge.getForPoint(43.6532, -79.3832)).resolves.toMatchObject({
      limitKmh: 50,
      matchType: 'traced_section',
    });
  });

  it.each([
    ['kept_saved_limit', 50, 'user_confirmed_posted_sign'],
    ['used_observed_limit', 60, 'user_entered_estimate'],
  ])('atomically clears an exact conflict when an existing traced rule is %s', async (
    resolutionAction,
    nextLimitKmh,
    source
  ) => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const lat = 43.6532;
    const lng = -79.3832;
    const geohash = geohashEncode(lat, lng, 6);
    const sectionPoints = [
      { lat, lng: -79.3842 },
      { lat, lng: -79.3822 },
    ];
    const saved = await knowledge.saveUserCorrection(
      lat,
      lng,
      50,
      'Original rule',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints }
    );
    const beforeConflict = await knowledge.exportData();
    await knowledge.replaceData({
      ...beforeConflict,
      cells: {
        ...beforeConflict.cells,
        [geohash]: {
          limitKmh: 60,
          conflict: true,
          source: 'trip_consensus',
          lastUpdatedAt: new Date().toISOString(),
        },
      },
      roadMemory: {
        version: 3,
        processedTrips: {},
        intelligence: null,
        candidates: [{
          id: 'matching-road-memory',
          sectionKey: 'matching-road-memory',
          geohash,
          lat,
          lng,
          limitKmh: 50,
          source: 'local_road_memory',
          confidence: 0.7,
          agreement: 1,
          tripCount: 3,
          evidenceCount: 3,
          tripIds: ['trip-1', 'trip-2', 'trip-3'],
          tripVotes: { 'trip-1': 50, 'trip-2': 50, 'trip-3': 50 },
          limitVotes: { 50: 3 },
          sectionPoints,
        }],
      },
    });

    await expect(knowledge.updateUserCorrection(
      saved.id,
      nextLimitKmh,
      source,
      'Reviewed conflict',
      {
        sectionPoints,
        resolvesConflictGeohash: geohash,
        conflictResolution: {
          savedLimitKmh: 50,
          observedLimitKmh: 60,
          deltaKmh: 10,
          action: resolutionAction,
        },
      }
    )).resolves.toBe(true);

    const resolved = await knowledge.exportData();
    expect(resolved.cells[geohash]).toBeUndefined();
    expect(resolved.corrections.filter((item) => item.historicalVersion !== true)).toHaveLength(1);
    expect(resolved.corrections[0]).toMatchObject({
      id: saved.id,
      limitKmh: nextLimitKmh,
      source,
      conflictResolution: { action: resolutionAction },
    });
    expect(await knowledge.getConflictedCells()).toHaveLength(0);
    if (resolutionAction === 'kept_saved_limit') {
      expect(resolved.roadMemory.candidates[0].reviewState).toBe('confirmed');
    }

    await expect(knowledge.undo()).resolves.toBe(true);
    const undone = await knowledge.exportData();
    expect(undone.cells[geohash]?.conflict).toBe(true);
    expect(undone.corrections).toHaveLength(1);
    expect(undone.corrections[0]).toMatchObject({ id: saved.id, limitKmh: 50 });
    expect(undone.roadMemory.candidates[0].reviewState).toBeUndefined();

    await expect(knowledge.redo()).resolves.toBe(true);
    const redone = await knowledge.exportData();
    expect(redone.cells[geohash]).toBeUndefined();
    if (resolutionAction === 'kept_saved_limit') {
      expect(redone.roadMemory.candidates[0].reviewState).toBe('confirmed');
    }
  });

  it('rejects a dynamic conflict decision for a point-only rule until its road is traced', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const saved = await knowledge.saveUserCorrection(
      43.6532,
      -79.3832,
      50,
      'Legacy point rule',
      null,
      [],
      'user_entered_estimate'
    );
    const conflictResolution = {
      savedLimitKmh: 50,
      observedLimitKmh: 60,
      deltaKmh: 10,
      action: 'used_observed_limit',
    };

    await expect(knowledge.updateUserCorrection(
      saved.id,
      60,
      'user_entered_estimate',
      'Reviewed trip evidence',
      { conflictResolution }
    )).resolves.toBe(false);
    expect((await knowledge.listUserCorrections())[0]).toMatchObject({ limitKmh: 50 });

    await expect(knowledge.updateUserCorrection(
      saved.id,
      60,
      'user_entered_estimate',
      'Reviewed trip evidence',
      {
        sectionPoints: [
          { lat: 43.6532, lng: -79.3842 },
          { lat: 43.6532, lng: -79.3822 },
        ],
        conflictResolution,
      }
    )).resolves.toBe(true);
    expect((await knowledge.listUserCorrections())[0]).toMatchObject({
      limitKmh: 60,
      conflictResolution: { action: 'used_observed_limit' },
    });
  });

  it('undoes and redoes standalone restore Road Memory as one exact transaction', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const candidate = (id, limitKmh) => ({
      id,
      sectionKey: id,
      geohash: 'dpz83q',
      lat: 43.6532,
      lng: -79.3832,
      limitKmh,
      source: 'local_road_memory',
      confidence: 0,
      agreement: 0,
      tripCount: 0,
      evidenceCount: 0,
      sectionPoints: [
        { lat: 43.6530, lng: -79.3834 },
        { lat: 43.6534, lng: -79.3830 },
      ],
    });
    const dataWithCandidate = (entry) => ({
      cells: {},
      corrections: [],
      excludedSections: [],
      roadMemory: {
        version: 3,
        processedTrips: {},
        intelligence: null,
        candidates: [entry],
      },
    });

    await knowledge.replaceData(dataWithCandidate(candidate('before-restore', 50)), 'seed');
    await knowledge.replaceData(
      dataWithCandidate(candidate('imported-shadow', 70)),
      'restore_speed_backup'
    );
    expect((await knowledge.exportData()).roadMemory.candidates[0].id).toBe('imported-shadow');

    await expect(knowledge.undo()).resolves.toBe(true);
    expect((await knowledge.exportData()).roadMemory.candidates[0].id).toBe('before-restore');

    await expect(knowledge.redo()).resolves.toBe(true);
    expect((await knowledge.exportData()).roadMemory.candidates[0].id).toBe('imported-shadow');
  });

  it('preserves a newer Road Memory review when undoing an unrelated correction removal', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const sectionPoints = [
      { lat: 43.6530, lng: -79.3834 },
      { lat: 43.6534, lng: -79.3830 },
    ];
    await knowledge.replaceData({
      cells: {},
      excludedSections: [],
      corrections: [{
        id: 'saved-rule',
        geohash: 'dpz83q',
        lat: 43.6532,
        lng: -79.3832,
        limitKmh: 50,
        source: 'user_entered_estimate',
        sectionPoints,
      }],
      roadMemory: {
        version: 3,
        processedTrips: {},
        intelligence: null,
        candidates: [{
          id: 'newer-review',
          sectionKey: 'newer-review',
          geohash: 'dpz83q',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          source: 'local_road_memory',
          confidence: 0.7,
          agreement: 1,
          tripCount: 3,
          evidenceCount: 3,
          sectionPoints,
          changeDetection: {
            status: 'possible_change',
            previousLimitKmh: 50,
            proposedLimitKmh: 60,
            detectedAt: '2026-07-20T12:00:00.000Z',
          },
        }],
      },
    }, 'seed');

    await expect(knowledge.removeUserCorrection('saved-rule')).resolves.toBe(true);
    await expect(knowledge.reviewRoadMemoryCandidate('newer-review', { action: 'reject' }))
      .resolves.toMatchObject({ reviewState: 'rejected' });
    await expect(knowledge.undo()).resolves.toBe(true);

    const restored = await knowledge.exportData();
    expect(restored.corrections).toEqual([expect.objectContaining({ id: 'saved-rule' })]);
    expect(restored.roadMemory.candidates[0]).toMatchObject({
      reviewState: 'rejected',
      changeDetection: { status: 'resolved' },
    });
  });

  it('does not roll back newer Road Memory reviews when undoing older feedback', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const sectionPoints = [
      { lat: 43.6530, lng: -79.3834 },
      { lat: 43.6534, lng: -79.3830 },
    ];
    const candidate = (id, lat, lng) => ({
      id,
      sectionKey: id,
      geohash: geohashEncode(lat, lng, 6),
      lat,
      lng,
      limitKmh: 50,
      source: 'local_road_memory',
      confidence: 0.7,
      agreement: 1,
      tripCount: 3,
      evidenceCount: 3,
      sectionPoints,
    });
    await knowledge.replaceData({
      cells: {},
      corrections: [],
      excludedSections: [],
      roadMemory: {
        version: 3,
        processedTrips: {},
        intelligence: null,
        candidates: [
          candidate('candidate-a', 43.6532, -79.3832),
          candidate('candidate-b', 44.2312, -76.4860),
        ],
      },
    }, 'seed');

    await expect(knowledge.saveUserCorrection(
      43.6532,
      -79.3832,
      50,
      'Posted sign',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints, roadMemoryCandidateId: 'candidate-a' }
    )).resolves.toMatchObject({ roadMemoryFeedbackRecorded: true });
    await expect(knowledge.reviewRoadMemoryCandidate('candidate-b', { action: 'reject' }))
      .resolves.toMatchObject({ reviewState: 'rejected' });
    await expect(knowledge.reviewRoadMemoryCandidate('candidate-a', { action: 'reject' }))
      .resolves.toMatchObject({ reviewState: 'rejected' });

    await expect(knowledge.undo()).resolves.toBe(true);
    const undone = await knowledge.exportData();
    expect(undone.corrections).toHaveLength(0);
    expect(Object.fromEntries(undone.roadMemory.candidates.map((item) => (
      [item.id, item.reviewState]
    )))).toEqual({
      'candidate-a': 'rejected',
      'candidate-b': 'rejected',
    });
  });

  it('does not resurrect a Road Memory candidate removed after correction feedback', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    const sectionPoints = [
      { lat: 43.6530, lng: -79.3834 },
      { lat: 43.6534, lng: -79.3830 },
    ];
    await knowledge.replaceData({
      cells: {},
      corrections: [],
      excludedSections: [],
      roadMemory: {
        version: 3,
        processedTrips: {},
        intelligence: null,
        candidates: [{
          id: 'candidate-removed-later',
          sectionKey: 'candidate-removed-later',
          geohash: 'dpz83q',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          source: 'local_road_memory',
          confidence: 0.7,
          agreement: 1,
          tripCount: 3,
          evidenceCount: 3,
          sectionPoints,
        }],
      },
    }, 'seed');
    await knowledge.saveUserCorrection(
      43.6532,
      -79.3832,
      50,
      'Posted sign',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints, roadMemoryCandidateId: 'candidate-removed-later' }
    );

    const [storageKey, persisted] = store.set.mock.calls.at(-1);
    const withoutCandidate = structuredClone(persisted);
    withoutCandidate.roadMemory.candidates = [];
    await store.set(storageKey, withoutCandidate);

    await expect(knowledge.undo()).resolves.toBe(true);
    expect((await knowledge.exportData()).roadMemory.candidates).toEqual([]);
  });

  it('rejects malformed explicit direction and time qualifiers before saving', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const sectionPoints = [
      { lat: 43.6532, lng: -79.3842 },
      { lat: 43.6532, lng: -79.3822 },
    ];

    await expect(knowledge.saveUserCorrection(
      43.6532, -79.3832, 50, '', null, [], 'user_confirmed_posted_sign',
      { directionMode: 'sideways', sectionPoints }
    )).resolves.toBe(false);
    await expect(knowledge.saveUserCorrection(
      43.6532, -79.3832, 50, '', null, [], 'user_confirmed_posted_sign',
      {
        sectionPoints,
        timeRule: { enabled: true, days: [1, 9], startMinutes: 420, endMinutes: 540 },
      }
    )).resolves.toBe(false);
    await expect(knowledge.saveUserCorrection(
      43.6532, -79.3832, 40, '', null, [], 'user_confirmed_posted_sign',
      { sectionPoints, qualifierStatus: 'conditional_temporary_work_zone' }
    )).resolves.toBe(false);
    await expect(knowledge.saveUserCorrection(
      43.6532, -79.3832, 30, '', null, [], 'user_confirmed_posted_sign',
      { sectionPoints, qualifierStatus: 'conditional_school_when_flashing' }
    )).resolves.toBe(false);
    await expect(knowledge.listUserCorrections()).resolves.toEqual([]);
  });

  it('restores one ignored road section without re-enabling every exclusion', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const first = await knowledge.excludeSpeedSection({
      lat: 43.6532,
      lng: -79.3832,
      roadName: 'First Road',
      sectionPoints: [
        { lat: 43.6532, lng: -79.3842 },
        { lat: 43.6532, lng: -79.3822 },
      ],
    });
    const second = await knowledge.excludeSpeedSection({
      lat: 45.4215,
      lng: -75.6972,
      roadName: 'Second Road',
      sectionPoints: [
        { lat: 45.4215, lng: -75.6982 },
        { lat: 45.4215, lng: -75.6962 },
      ],
    });

    const restored = await knowledge.restoreExcludedSpeedSections(first.exclusion.id);
    const remaining = await knowledge.listExcludedSpeedSections();

    expect(restored).toMatchObject({ restoredCount: 1 });
    expect(restored.restoredSections).toEqual([expect.objectContaining({ roadName: 'First Road' })]);
    expect(remaining).toEqual([expect.objectContaining({ id: second.exclusion.id, roadName: 'Second Road' })]);
  });

  it('activates a learned cell only on the third independent drive and queues rescoring once', async () => {
    const knowledge = new LocalSpeedKnowledge(memoryStore());
    const point = {
      lat: 43.6532,
      lng: -79.3832,
      limitKmh: 50,
      source: 'openstreetmap',
    };
    const geohash = geohashEncode(point.lat, point.lng);

    await expect(knowledge.learnFromTrip([point], [], { tripId: 'trip-1' }))
      .resolves.toEqual({ newlyEligibleCellGeohashes: [] });
    await expect(knowledge.getForPoint(point.lat, point.lng)).resolves.toBeNull();
    await expect(knowledge.learnFromTrip([point], [], { tripId: 'trip-2' }))
      .resolves.toEqual({ newlyEligibleCellGeohashes: [] });
    await expect(knowledge.getForPoint(point.lat, point.lng)).resolves.toBeNull();
    await expect(knowledge.learnFromTrip([point], [], { tripId: 'trip-3' }))
      .resolves.toEqual({ newlyEligibleCellGeohashes: [geohash] });
    await expect(knowledge.getForPoint(point.lat, point.lng)).resolves.toMatchObject({
      limitKmh: 50,
      source: 'trip_consensus',
      tripCount: 3,
    });
    await vi.waitFor(() => expect(speedRefreshMocks.refreshCell).toHaveBeenCalledWith(geohash));

    const revision = (await knowledge.getMetadata()).knowledgeRevision;
    await expect(knowledge.learnFromTrip([point], [], { tripId: 'trip-3' }))
      .resolves.toEqual({ newlyEligibleCellGeohashes: [] });
    expect((await knowledge.getMetadata()).knowledgeRevision).toBe(revision);
    expect(speedRefreshMocks.refreshCell).toHaveBeenCalledTimes(1);
  });
});
