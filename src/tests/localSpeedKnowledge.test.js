import { describe, expect, it } from 'vitest';

import { geohashEncode, LocalSpeedKnowledge, STORAGE_KEY, timeToBucket } from '@/lib/localSpeedKnowledge';
import { applySafetyGuards } from '@/lib/speedLimitSource';

// CHANGES (session):
// - Added Category D LocalSpeedKnowledge tests for privacy, learning, corrections, pruning, safety guards, and misses.
// - Added Phase 3 tests for time-of-day buckets and conflict detection/resolution.
// - Split user correction tests into posted-sign and user-entered estimate confidence.
// - Added learned-cache source allowlist tests.

class MockStore {
  constructor(initial = {}) {
    this.data = { ...initial };
  }

  async get(key) {
    return this.data[key] ?? null;
  }

  async set(key, value) {
    this.data[key] = value;
  }
}

const privacyZones = [{ lat: 43.7, lng: -79.4, radius_m: 200 }];

describe('LocalSpeedKnowledge', () => {
  it('does not cache points inside privacy zones', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip(
      [{ lat: 43.7001, lng: -79.4001, limitKmh: 60, source: 'openstreetmap' }],
      privacyZones
    );
    const data = await store.get(STORAGE_KEY);
    expect(Object.keys(data.cells)).toHaveLength(0);
  });

  it('does not learn from regional defaults, GPS inference, or user-entered estimates', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([
      { lat: 43.65, lng: -79.38, limitKmh: 50, source: 'region_default_estimate' },
      { lat: 43.66, lng: -79.38, limitKmh: 50, source: 'inferred' },
      { lat: 43.67, lng: -79.38, limitKmh: 50, source: 'user_entered_estimate' },
    ], []);
    const data = await store.get(STORAGE_KEY);
    expect(Object.keys(data.cells)).toHaveLength(0);
  });

  it('learns from user-confirmed posted signs', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([
      { lat: 43.65, lng: -79.38, limitKmh: 50, source: 'user_confirmed_posted_sign' },
    ], []);
    const result = await lsk.getForPoint(43.65, -79.38);
    expect(result.limitKmh).toBe(50);
    expect(result.source).toBe('trip_consensus');
  });

  it('grows confidence from 0.55 to 0.85 over 10 trips', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    for (let i = 0; i < 10; i++) {
      await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    }
    const cell = await lsk.getForPoint(43.65, -79.38);
    expect(cell.tripCount).toBe(10);
    expect(cell.confidence).toBeCloseTo(0.85, 3);
  });

  it('lowers confidence on conflicting limit reports', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 50, source: 'openstreetmap' }], []);
    const cell = await lsk.getForPoint(43.65, -79.38);
    expect(cell.confidence).toBeCloseTo(0.43, 3);
  });

  it('user correction takes priority over cell', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.saveUserCorrection(43.65, -79.38, 40, 'School zone', null, []);
    const result = await lsk.getForPoint(43.65, -79.38);
    expect(result.source).toBe('user_entered_estimate');
    expect(result.limitKmh).toBe(40);
  });

  it('matches a curved saved road section near its traced polyline, not a broad point radius', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(
      43.6505,
      -79.3805,
      40,
      'Curved road',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        sectionPoints: [
          { lat: 43.6500, lng: -79.3810 },
          { lat: 43.6504, lng: -79.3806 },
          { lat: 43.6508, lng: -79.3808 },
        ],
      }
    );

    await expect(lsk.getForPoint(43.65045, -79.38062)).resolves.toMatchObject({
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6504, lng: -79.3806 },
        { lat: 43.6508, lng: -79.3808 },
      ],
    });
    await expect(lsk.getForPoint(43.6545, -79.3806)).resolves.toBeNull();
  });

  it('matches review cells by their highlighted section when the anchor point misses a saved trace', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const sectionPoints = [
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6502, lng: -79.3807 },
      { lat: 43.6504, lng: -79.3804 },
      { lat: 43.6506, lng: -79.3801 },
    ];
    await lsk.saveUserCorrection(
      43.6503,
      -79.38055,
      50,
      'Saved road trace',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints }
    );

    await expect(lsk.getForPoint(43.6512, -79.38055)).resolves.toBeNull();

    const [match] = await lsk.getForPoints([{
      lat: 43.6512,
      lng: -79.38055,
      sectionPoints,
    }]);

    expect(match).toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      matchReason: 'matched_traced_section',
    });
  });

  it('does not apply a traced road rule to a parallel road more than 45 metres away', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(
      43.6500,
      -79.3805,
      40,
      'Main road',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        sectionPoints: [
          { lat: 43.6500, lng: -79.3810 },
          { lat: 43.6500, lng: -79.3800 },
        ],
      }
    );

    await expect(lsk.getForPoint(43.65030, -79.3805)).resolves.toMatchObject({ limitKmh: 40 });
    await expect(lsk.getForPoint(43.65050, -79.3805)).resolves.toBeNull();
  });

  it('enforces direction-specific saved road sections when heading is available', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(
      43.6500,
      -79.3805,
      50,
      'Eastbound only',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        directionMode: 'forward',
        sectionPoints: [
          { lat: 43.6500, lng: -79.3810 },
          { lat: 43.6500, lng: -79.3800 },
        ],
      }
    );

    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 90 })).resolves.toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
    });
    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 270 })).resolves.toBeNull();
  });

  it('keeps independent speed rules for opposite directions in the same road cell', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const sectionPoints = [
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6500, lng: -79.3800 },
    ];

    await lsk.saveUserCorrection(43.6500, -79.3805, 50, 'Eastbound', null, [], 'user_confirmed_posted_sign', {
      directionMode: 'forward',
      sectionPoints,
    });
    await lsk.saveUserCorrection(43.6500, -79.3805, 60, 'Westbound', null, [], 'user_confirmed_posted_sign', {
      directionMode: 'reverse',
      sectionPoints,
    });

    const corrections = await lsk.listUserCorrections();
    expect(corrections).toHaveLength(2);
    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 90 })).resolves.toMatchObject({ limitKmh: 50 });
    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 270 })).resolves.toMatchObject({ limitKmh: 60 });

    const eastbound = corrections.find((correction) => correction.directionMode === 'forward');
    await expect(lsk.updateUserCorrection(eastbound.id, 40, 'user_confirmed_posted_sign')).resolves.toBe(true);
    await expect(lsk.removeUserCorrection(eastbound.id)).resolves.toBe(true);
    await expect(lsk.listUserCorrections()).resolves.toHaveLength(1);
    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 270 })).resolves.toMatchObject({ limitKmh: 60 });
  });

  it('updates a saved correction center when snapped geometry moves', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);

    await lsk.saveUserCorrection(43.6500, -79.3805, 50, 'Original', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    });
    const [saved] = await lsk.listUserCorrections();

    await expect(lsk.updateUserCorrection(saved.id, 50, 'user_confirmed_posted_sign', 'Snapped', {
      lat: 43.6510,
      lng: -79.3790,
      sectionPoints: [
        { lat: 43.6510, lng: -79.3795 },
        { lat: 43.6510, lng: -79.3785 },
      ],
    })).resolves.toBe(true);

    const [updated] = await lsk.listUserCorrections();
    expect(updated.lat).toBeCloseTo(43.6510);
    expect(updated.lng).toBeCloseTo(-79.3790);
    expect(updated.geohash).toBe(geohashEncode(43.6510, -79.3790));
    expect(updated.sectionPoints).toEqual([
      { lat: 43.6510, lng: -79.3795 },
      { lat: 43.6510, lng: -79.3785 },
    ]);
  });

  it('does not match a directional rule when heading differs by more than 60 degrees', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(43.6500, -79.3805, 50, 'Eastbound', null, [], 'user_confirmed_posted_sign', {
      directionMode: 'forward',
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    });

    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 149 })).resolves.toMatchObject({ limitKmh: 50 });
    await expect(lsk.getForPoint(43.6500, -79.3805, null, { headingDeg: 151 })).resolves.toBeNull();
  });

  it('enforces active day and time windows for saved road sections', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(
      43.6500,
      -79.3805,
      30,
      'School hours',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        timeRule: {
          enabled: true,
          days: [1, 2, 3, 4, 5],
          startTime: '07:00',
          endTime: '09:00',
        },
        sectionPoints: [
          { lat: 43.6500, lng: -79.3810 },
          { lat: 43.6500, lng: -79.3800 },
        ],
      }
    );

    await expect(lsk.getForPoint(43.6500, -79.3805, new Date(2026, 0, 5, 8, 0).getTime())).resolves.toMatchObject({
      limitKmh: 30,
    });
    await expect(lsk.getForPoint(43.6500, -79.3805, new Date(2026, 0, 5, 10, 0).getTime())).resolves.toBeNull();
    await expect(lsk.getForPoint(43.6500, -79.3805, new Date(2026, 0, 4, 8, 0).getTime())).resolves.toBeNull();
  });

  it('does not save null-island user corrections or section points', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);

    await expect(lsk.saveUserCorrection(0, 0, 50, 'Bad GPS', null, [])).resolves.toBe(false);
    await expect(lsk.saveUserCorrection(43.65, -79.38, 50, '', null, [], 'user_entered_estimate', {
      sectionPoints: [
        { lat: 43.65, lng: -79.38 },
        { lat: 0, lng: 0 },
      ],
    })).resolves.toMatchObject({
      id: expect.any(String),
      limitKmh: 50,
      source: 'user_entered_estimate',
      sectionPoints: [{ lat: 43.65, lng: -79.38 }],
    });

    const [saved] = await lsk.listUserCorrections();
    expect(saved.sectionPoints).toEqual([{ lat: 43.65, lng: -79.38 }]);
  });

  it('prune removes stale low-confidence cells', async () => {
    const store = new MockStore({
      [STORAGE_KEY]: {
        cells: {
          abc123: {
            limitKmh: 60,
            confidence: 0.40,
            tripCount: 1,
            lastUpdatedAt: new Date(Date.now() - 100 * 86400000).toISOString(),
          },
        },
        corrections: [],
      },
    });
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.prune(90);
    const data = await store.get(STORAGE_KEY);
    expect(Object.keys(data.cells)).toHaveLength(0);
  });

  it('safety guard prevents learned limit from exceeding map default by > 10', () => {
    const learned = { tier: 'LEARNED_LOCAL', limitKmh: 90, source: 'learned_local' };
    const map = { tier: 'MAP_ESTIMATED', limitKmh: 60, source: 'osm_highway_default' };
    const result = applySafetyGuards(learned, [learned, map]);
    expect(result.tier).toBe('MAP_ESTIMATED');
    expect(result.evidence.suppressedLearnedHigherLimit).toBe(90);
  });

  it('user-entered estimate confidence is 0.75 regardless of trip count', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.saveUserCorrection(43.65, -79.38, 50, '', null, []);
    const result = await lsk.getForPoint(43.65, -79.38);
    expect(result.source).toBe('user_entered_estimate');
    expect(result.confidence).toBe(0.75);
  });

  it('posted-sign correction confidence is 0.92 regardless of trip count', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Posted sign confirmed', null, [], 'user_confirmed_posted_sign');
    const result = await lsk.getForPoint(43.65, -79.38);
    expect(result.source).toBe('user_confirmed_posted_sign');
    expect(result.confidence).toBe(0.92);
  });

  it('replaces an older user correction for the same road cell', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Old sign', null, [], 'user_confirmed_posted_sign');
    await lsk.saveUserCorrection(43.65, -79.38, 40, 'Changed sign', null, [], 'user_confirmed_posted_sign');

    const result = await lsk.getForPoint(43.65, -79.38);
    const data = await store.get(STORAGE_KEY);
    expect(result.limitKmh).toBe(40);
    expect(result.source).toBe('user_confirmed_posted_sign');
    expect(data.corrections).toHaveLength(1);
  });

  it('keeps separate traced road sections in the same cell', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);

    await lsk.saveUserCorrection(43.6500, -79.3805, 40, 'First trace', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    });
    await lsk.saveUserCorrection(43.6501, -79.3805, 50, 'Nearby trace', null, [], 'user_entered_estimate', {
      sectionPoints: [
        { lat: 43.6501, lng: -79.3810 },
        { lat: 43.6501, lng: -79.3800 },
      ],
    });

    const corrections = await lsk.listUserCorrections();
    expect(corrections).toHaveLength(2);
    expect(corrections.map((correction) => correction.limitKmh).sort()).toEqual([40, 50]);
  });

  it('replaces a matching traced road section instead of duplicating it', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const sectionPoints = [
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6500, lng: -79.3800 },
    ];

    await lsk.saveUserCorrection(43.6500, -79.3805, 40, 'First trace', null, [], 'user_entered_estimate', {
      sectionPoints,
    });
    await lsk.saveUserCorrection(43.6500, -79.3805, 50, 'Same trace', null, [], 'user_confirmed_posted_sign', {
      sectionPoints,
    });

    const corrections = await lsk.listUserCorrections();
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
    });
  });

  it('repairs expired and duplicate saved speed rules without merging distinct traces', async () => {
    const sectionPoints = [
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6500, lng: -79.3800 },
    ];
    const store = new MockStore({
      [STORAGE_KEY]: {
        cells: {},
        corrections: [
          {
            id: 'old-estimate',
            geohash: geohashEncode(43.6500, -79.3805),
            lat: 43.6500,
            lng: -79.3805,
            limitKmh: 40,
            source: 'user_entered_estimate',
            appliedAt: '2026-01-01T00:00:00.000Z',
            sectionPoints,
          },
          {
            id: 'new-posted',
            geohash: geohashEncode(43.6500, -79.3805),
            lat: 43.6500,
            lng: -79.3805,
            limitKmh: 40,
            source: 'user_confirmed_posted_sign',
            appliedAt: '2026-02-01T00:00:00.000Z',
            sectionPoints,
          },
          {
            id: 'nearby-trace',
            geohash: geohashEncode(43.6501, -79.3805),
            lat: 43.6501,
            lng: -79.3805,
            limitKmh: 50,
            source: 'user_entered_estimate',
            appliedAt: '2026-02-01T00:00:00.000Z',
            sectionPoints: [
              { lat: 43.6501, lng: -79.3810 },
              { lat: 43.6501, lng: -79.3800 },
            ],
          },
          {
            id: 'expired',
            geohash: geohashEncode(43.6600, -79.3900),
            lat: 43.6600,
            lng: -79.3900,
            limitKmh: 30,
            source: 'user_entered_estimate',
            appliedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    });
    const lsk = new LocalSpeedKnowledge(store);

    await expect(lsk.repairSavedSpeedData()).resolves.toMatchObject({
      changed: true,
      removedDuplicates: 1,
      removedExpired: 1,
      keptCorrections: 2,
    });
    const corrections = await lsk.listUserCorrections();
    expect(corrections).toHaveLength(2);
    expect(corrections.map((correction) => correction.id).sort()).toEqual(['nearby-trace', 'new-posted']);
  });

  it('lists, updates, and removes user corrections', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Initial', null, [], 'user_entered_estimate');

    const [saved] = await lsk.listUserCorrections();
    expect(saved).toMatchObject({
      limitKmh: 50,
      source: 'user_entered_estimate',
      note: 'Initial',
      lat: 43.65,
      lng: -79.38,
      coordinateSource: 'driven_route_sample',
    });
    expect(saved.geohash).toBeTruthy();
    expect(Number.isFinite(saved.lat)).toBe(true);
    expect(Number.isFinite(saved.lng)).toBe(true);
    expect(saved.verificationStatus).toBe('user_estimate');
    expect(saved.auditTrail[0]).toMatchObject({ action: 'created', limitKmh: 50 });

    await expect(lsk.updateUserCorrection(saved.geohash, 40, 'user_confirmed_posted_sign', 'Changed sign')).resolves.toBe(true);
    const updated = await lsk.getForPoint(43.65, -79.38);
    expect(updated).toMatchObject({
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
    });
    const [updatedCorrection] = await lsk.listUserCorrections();
    expect(updatedCorrection.verificationStatus).toBe('confirmed_posted_sign');
    expect(updatedCorrection.auditTrail.at(-1)).toMatchObject({
      action: 'updated',
      previousLimitKmh: 50,
      nextLimitKmh: 40,
    });

    await expect(lsk.removeUserCorrection(saved.geohash)).resolves.toBe(true);
    await expect(lsk.listUserCorrections()).resolves.toHaveLength(0);
  });

  it('marks legacy corrections without stored coordinates as approximate cell centers', async () => {
    const store = new MockStore({
      [STORAGE_KEY]: {
        cells: {},
        corrections: [{
          geohash: 'dpz83f',
          limitKmh: 50,
          source: 'user_entered_estimate',
          appliedAt: new Date().toISOString(),
        }],
      },
    });
    const lsk = new LocalSpeedKnowledge(store);
    const [saved] = await lsk.listUserCorrections();
    expect(saved.coordinateSource).toBe('geohash_cell_center_legacy');
    expect(Number.isFinite(saved.lat)).toBe(true);
    expect(Number.isFinite(saved.lng)).toBe(true);
  });

  it('returns null for a point in an area with no cells and no corrections', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await expect(lsk.getForPoint(44.1, -80.2)).resolves.toBeNull();
  });

  it('maps timestamps to 2-hour local buckets', () => {
    expect(timeToBucket(new Date(2026, 0, 1, 15, 30).getTime())).toBe('14-16');
  });

  it('records time-of-day driving evidence without treating traffic speed as the speed limit', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const timestamp = new Date(2026, 0, 1, 15, 0).getTime();
    await lsk.learnFromTrip([{
      lat: 43.65,
      lng: -79.38,
      limitKmh: 60,
      speed_kmh: 42,
      timestamp,
      source: 'openstreetmap',
    }], []);
    const result = await lsk.getForPoint(43.65, -79.38, timestamp);
    expect(result.source).toBe('trip_consensus');
    expect(result.limitKmh).toBe(60);
    expect(result.observedTimeOfDayP85Kmh).toBe(42);
    expect(result.timeOfDayBuckets['14-16']).toMatchObject({ p85Kmh: 42, count: 1 });
  });

  it('flags > 10 km/h conflicts and resolves them as posted-sign confirmations', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 80, source: 'openstreetmap' }], []);
    const conflicted = await lsk.getConflictedCells();
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].conflictDetails).toMatchObject({ existingLimitKmh: 60, newLimitKmh: 80 });
    const lookup = await lsk.getForPoint(43.65, -79.38);
    expect(lookup.conflict).toBe(true);
    expect(await lsk.resolveConflict(conflicted[0].geohash, 70)).toBe(true);
    const resolved = await lsk.getForPoint(43.65, -79.38);
    expect(resolved.limitKmh).toBe(70);
    expect(resolved.conflict).toBe(false);
    expect(resolved.source).toBe('user_confirmed_posted_sign');
    expect(resolved.confidence).toBe(0.92);
  });

  it('can resolve conflicts as user-entered estimates', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 80, source: 'openstreetmap' }], []);
    const [conflict] = await lsk.getConflictedCells();
    expect(await lsk.resolveConflict(conflict.geohash, 70, 'user_entered_estimate')).toBe(true);
    const resolved = await lsk.getForPoint(43.65, -79.38);
    expect(resolved.source).toBe('user_entered_estimate');
    expect(resolved.confidence).toBe(0.75);
  });

  it('undoes and redoes saved rule changes', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Initial', null, [], 'user_entered_estimate');
    const [saved] = await lsk.listUserCorrections();
    await lsk.updateUserCorrection(saved.geohash, 60, 'user_confirmed_posted_sign', 'Sign checked');

    expect((await lsk.listUserCorrections())[0].limitKmh).toBe(60);
    expect(await lsk.undo()).toBe(true);
    expect((await lsk.listUserCorrections())[0].limitKmh).toBe(50);
    expect(await lsk.redo()).toBe(true);
    expect((await lsk.listUserCorrections())[0].limitKmh).toBe(60);
  });

  it('undoes a grouped bulk operation in one step', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const historyGroup = 'bulk-create';
    await lsk.saveUserCorrection(43.65, -79.38, 50, '', null, [], 'user_entered_estimate', { historyGroup });
    await lsk.saveUserCorrection(43.67, -79.40, 60, '', null, [], 'user_entered_estimate', { historyGroup });

    expect(await lsk.listUserCorrections()).toHaveLength(2);
    expect(await lsk.undo()).toBe(true);
    expect(await lsk.listUserCorrections()).toHaveLength(0);
  });

  it('restores imported speed knowledge and can undo the restore', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(43.65, -79.38, 50);
    await lsk.replaceData({
      cells: {},
      corrections: [{
        geohash: 'dpz88z',
        lat: 43.7,
        lng: -79.4,
        limitKmh: 70,
        source: 'user_confirmed_posted_sign',
        appliedAt: new Date().toISOString(),
      }],
    });

    expect((await lsk.listUserCorrections())[0].limitKmh).toBe(70);
    expect(await lsk.undo()).toBe(true);
    expect((await lsk.listUserCorrections())[0].limitKmh).toBe(50);
  });
});
