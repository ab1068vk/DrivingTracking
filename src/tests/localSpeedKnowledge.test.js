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
const tracedSection = [
  { lat: 43.65, lng: -79.381 },
  { lat: 43.65, lng: -79.379 },
];

describe('LocalSpeedKnowledge', () => {
  it('does not cache points inside privacy zones', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip(
      [{ lat: 43.7001, lng: -79.4001, limitKmh: 60, source: 'openstreetmap' }],
      privacyZones
    );
    const data = await store.get(STORAGE_KEY);
    expect(Object.keys(data?.cells || {})).toHaveLength(0);
  });

  it('does not cache an outside point when its coarse cell overlaps a privacy zone', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const zone = { lat: 43.7, lng: -79.4, radius_m: 20 };
    const zoneHash = geohashEncode(zone.lat, zone.lng);
    const nearbyOutside = [1, -1]
      .flatMap((sign) => Array.from({ length: 20 }, (_, index) => ({
        lat: zone.lat + sign * (30 + index * 10) / 111_320,
        lng: zone.lng,
      })))
      .find((point) => geohashEncode(point.lat, point.lng) === zoneHash);
    expect(nearbyOutside).toBeTruthy();

    await lsk.learnFromTrip([{
      ...nearbyOutside,
      limitKmh: 60,
      source: 'openstreetmap',
    }], [zone], { tripId: 'outside-but-overlapping' });

    const data = await store.get(STORAGE_KEY);
    expect(Object.keys(data?.cells || {})).toHaveLength(0);
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
    expect(Object.keys(data?.cells || {})).toHaveLength(0);
  });

  it('keeps a learned cell in shadow mode until three independent trips agree', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([
      { lat: 43.65, lng: -79.38, limitKmh: 50, source: 'user_confirmed_posted_sign' },
    ], [], { tripId: 'trip-1' });
    const learned = await lsk.exportData();
    expect(Object.values(learned.cells)[0]).toMatchObject({
      limitKmh: 50,
      tripCount: 1,
      tripEvidenceIds: ['trip-1'],
    });
    await expect(lsk.getForPoint(43.65, -79.38)).resolves.toBeNull();

    await lsk.learnFromTrip([
      { lat: 43.65, lng: -79.38, limitKmh: 50, source: 'user_confirmed_posted_sign' },
    ], [], { tripId: 'trip-2' });
    await lsk.learnFromTrip([
      { lat: 43.65, lng: -79.38, limitKmh: 50, source: 'user_confirmed_posted_sign' },
    ], [], { tripId: 'trip-3' });
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

  it('counts a dense same-cell route as one independent trip', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const points = Array.from({ length: 100 }, (_, index) => ({
      lat: 43.65 + index * 0.000001,
      lng: -79.38,
      limitKmh: 60,
      source: 'openstreetmap',
    }));

    await lsk.learnFromTrip(points, [], { tripId: 'dense-trip' });
    await lsk.learnFromTrip(points, [], { tripId: 'dense-trip' });
    const data = await lsk.exportData();
    const cell = data.cells[geohashEncode(43.65, -79.38)];

    expect(cell.tripCount).toBe(1);
    expect(cell.evidenceCount).toBe(1);
    expect(cell.confidence).toBe(0.55);
    await expect(lsk.getForPoint(43.65, -79.38)).resolves.toBeNull();
  });

  it('lowers confidence on conflicting limit reports', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 50, source: 'openstreetmap' }], []);
    const data = await lsk.exportData();
    const cell = data.cells[geohashEncode(43.65, -79.38)];
    expect(cell.confidence).toBeCloseTo(0.43, 3);
    await expect(lsk.getForPoint(43.65, -79.38)).resolves.toBeNull();
  });

  it('skips an ineligible exact cell and uses an eligible fallback cell', async () => {
    const store = new MockStore();
    const exact = geohashEncode(43.65, -79.38, 6);
    const fallback = geohashEncode(43.65, -79.38, 5);
    await store.set(STORAGE_KEY, {
      cells: {
        [exact]: {
          limitKmh: 80,
          source: 'trip_consensus',
          confidence: 0.54,
          tripCount: 3,
          evidenceCount: 3,
          lastUpdatedAt: '2099-01-01T00:00:00.000Z',
        },
        [fallback]: {
          limitKmh: 50,
          source: 'trip_consensus',
          confidence: 0.68,
          tripCount: 3,
          evidenceCount: 3,
          lastUpdatedAt: '2099-01-01T00:00:00.000Z',
        },
      },
      corrections: [],
    });

    await expect(new LocalSpeedKnowledge(store).getForPoint(43.65, -79.38)).resolves.toMatchObject({
      geohash: fallback,
      limitKmh: 50,
      source: 'trip_consensus',
    });
  });

  it('user correction takes priority over cell', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.saveUserCorrection(43.65, -79.38, 40, 'School zone', null, [], 'user_entered_estimate', {
      sectionPoints: tracedSection,
    });
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

  it('prefers the heading-aligned saved road when traced speed sections cross at an intersection', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);

    await lsk.saveUserCorrection(43.6500, -79.3800, 50, 'North-south road', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: [
        { lat: 43.6490, lng: -79.3800 },
        { lat: 43.6510, lng: -79.3800 },
      ],
    });
    await lsk.saveUserCorrection(43.6500, -79.3800, 40, 'East-west side road', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3790 },
      ],
    });

    await expect(lsk.getForPoint(43.6500, -79.3800, null, { headingDeg: 0 })).resolves.toMatchObject({ limitKmh: 50 });
    await expect(lsk.getForPoint(43.6500, -79.3800, null, { headingDeg: 90 })).resolves.toMatchObject({ limitKmh: 40 });
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
    await lsk.saveUserCorrection(43.65, -79.38, 50, '', null, [], 'user_entered_estimate', {
      sectionPoints: tracedSection,
    });
    const result = await lsk.getForPoint(43.65, -79.38);
    expect(result.source).toBe('user_entered_estimate');
    expect(result.confidence).toBe(0.75);
  });

  it('posted-sign correction confidence is 0.92 regardless of trip count', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Posted sign confirmed', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: tracedSection,
    });
    const result = await lsk.getForPoint(43.65, -79.38);
    expect(result.source).toBe('user_confirmed_posted_sign');
    expect(result.confidence).toBe(0.92);
  });

  it('replaces an older user correction for the same road cell', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Old sign', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: tracedSection,
    });
    await lsk.saveUserCorrection(43.65, -79.38, 40, 'Changed sign', null, [], 'user_confirmed_posted_sign', {
      sectionPoints: tracedSection,
    });

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
    await lsk.saveUserCorrection(43.65, -79.38, 50, 'Initial', null, [], 'user_entered_estimate', {
      sectionPoints: tracedSection,
    });

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
    for (const tripId of ['bucket-trip-1', 'bucket-trip-2', 'bucket-trip-3']) {
      await lsk.learnFromTrip([{
        lat: 43.65,
        lng: -79.38,
        limitKmh: 60,
        speed_kmh: 42,
        timestamp,
        source: 'openstreetmap',
      }], [], { tripId });
    }
    const result = await lsk.getForPoint(43.65, -79.38, timestamp);
    expect(result.source).toBe('trip_consensus');
    expect(result.limitKmh).toBe(60);
    expect(result.observedTimeOfDayP85Kmh).toBe(42);
    expect(result.timeOfDayBuckets['14-16']).toMatchObject({ p85Kmh: 42, count: 3 });
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
    expect(lookup).toBeNull();
    await expect(lsk.resolveConflict(
      conflicted[0].geohash,
      70,
      'user_confirmed_posted_sign',
      'Confirmed on a traced road section',
      { lat: 43.65, lng: -79.38, sectionPoints: tracedSection }
    )).resolves.toMatchObject({ limitKmh: 70 });
    const resolved = await lsk.getForPoint(43.65, -79.38);
    expect(resolved.limitKmh).toBe(70);
    expect(resolved.source).toBe('user_confirmed_posted_sign');
    expect(resolved.confidence).toBe(0.92);
    expect((await lsk.getConflictedCells())).toHaveLength(0);
  });

  it('can resolve conflicts as user-entered estimates', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 60, source: 'openstreetmap' }], []);
    await lsk.learnFromTrip([{ lat: 43.65, lng: -79.38, limitKmh: 80, source: 'openstreetmap' }], []);
    const [conflict] = await lsk.getConflictedCells();
    await expect(lsk.resolveConflict(
      conflict.geohash,
      70,
      'user_entered_estimate',
      'Estimated on a traced road section',
      { lat: 43.65, lng: -79.38, sectionPoints: tracedSection }
    )).resolves.toMatchObject({ limitKmh: 70 });
    const resolved = await lsk.getForPoint(43.65, -79.38);
    expect(resolved.source).toBe('user_entered_estimate');
    expect(resolved.confidence).toBe(0.75);
  });

  it('keeps historical rule versions when a changed limit has an effective-from date', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const sectionPoints = [
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6500, lng: -79.3800 },
    ];
    const saved = await lsk.saveUserCorrection(
      43.65,
      -79.3805,
      50,
      'Old posted limit',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints }
    );

    await expect(lsk.updateUserCorrection(
      saved.id,
      40,
      'user_confirmed_posted_sign',
      'New sign effective in July',
      {
        sectionPoints,
        validFrom: '2026-07-01T00:00:00.000Z',
      }
    )).resolves.toBe(true);

    const versions = await lsk.listUserCorrections();
    expect(versions).toHaveLength(2);
    expect(versions.find((item) => item.limitKmh === 50)).toMatchObject({
      historicalVersion: true,
      supersededByCorrectionId: expect.any(String),
    });
    expect(versions.find((item) => item.limitKmh === 40)?.historicalVersion).toBe(false);
    expect(versions.find((item) => item.limitKmh === 50)?.expiresAt)
      .toBe('2026-07-01T00:00:00.000Z');
    expect(versions.find((item) => item.limitKmh === 40)?.validFrom)
      .toBe('2026-07-01T00:00:00.000Z');
    await expect(lsk.getForPoint(
      43.65,
      -79.3805,
      '2026-06-30T12:00:00.000Z'
    )).resolves.toMatchObject({ limitKmh: 50 });
    await expect(lsk.getForPoint(
      43.65,
      -79.3805,
      '2026-07-02T12:00:00.000Z'
    )).resolves.toMatchObject({ limitKmh: 40 });

    await expect(lsk.repairSavedSpeedData()).resolves.toMatchObject({ removedExpired: 0 });
    await lsk.prune(1);
    expect(await lsk.listUserCorrections()).toHaveLength(2);
    await expect(lsk.getForPoint(
      43.65,
      -79.3805,
      '2026-06-30T12:00:00.000Z'
    )).resolves.toMatchObject({ limitKmh: 50 });
  });

  it('versions authority and schedule changes when they receive a new effective date', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const saved = await lsk.saveUserCorrection(
      43.65,
      -79.3805,
      50,
      'Estimate',
      null,
      [],
      'user_entered_estimate',
      {
        sectionPoints: [
          { lat: 43.65, lng: -79.381 },
          { lat: 43.65, lng: -79.38 },
        ],
      }
    );

    await expect(lsk.updateUserCorrection(
      saved.id,
      50,
      'user_confirmed_posted_sign',
      'Posted sign with Friday hours',
      {
        validFrom: '2026-07-01T00:00:00.000Z',
        timeRule: { enabled: true, days: [5], startTime: '22:00', endTime: '06:00' },
      }
    )).resolves.toBe(true);

    const versions = await lsk.listUserCorrections();
    expect(versions).toHaveLength(2);
    expect(versions.find((item) => item.historicalVersion)?.source).toBe('user_entered_estimate');
    expect(versions.find((item) => !item.historicalVersion)).toMatchObject({
      source: 'user_confirmed_posted_sign',
      timeRule: expect.objectContaining({ days: [5] }),
    });
  });

  it('persists parking/private exclusions so they block scoring and relearning, not only UI display', async () => {
    const store = new MockStore();
    const lsk = new LocalSpeedKnowledge(store);
    const section = {
      lat: 43.65,
      lng: -79.3805,
      geohash: geohashEncode(43.65, -79.3805),
      roadName: 'Parking access',
      sectionPoints: [
        { lat: 43.65, lng: -79.381 },
        { lat: 43.65, lng: -79.38 },
      ],
    };
    await lsk.saveUserCorrection(
      section.lat,
      section.lng,
      30,
      'Incorrect parking-lot value',
      null,
      [],
      'user_entered_estimate',
      { sectionPoints: section.sectionPoints }
    );

    await expect(lsk.excludeSpeedSection(section)).resolves.toMatchObject({
      correctionsRemoved: 1,
    });
    await expect(lsk.getForPoint(section.lat, section.lng)).resolves.toBeNull();
    await expect(lsk.saveUserCorrection(
      section.lat,
      section.lng,
      30,
      '',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints: section.sectionPoints }
    )).resolves.toBe(false);

    await lsk.learnFromTrip([{
      lat: section.lat,
      lng: section.lng,
      limitKmh: 30,
      source: 'openstreetmap',
      timestamp: '2026-07-02T12:00:00.000Z',
    }], [], { tripId: 'parking-trip' });
    expect(Object.keys((await lsk.exportData()).cells)).toHaveLength(0);

    await expect(lsk.restoreExcludedSpeedSections()).resolves.toMatchObject({ restoredCount: 1 });
    await expect(lsk.saveUserCorrection(
      section.lat,
      section.lng,
      30,
      '',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints: section.sectionPoints }
    )).resolves.toBeTruthy();
  });

  it('blocks high-confidence learned cells after their evidence becomes stale', async () => {
    const store = new MockStore();
    const geohash = geohashEncode(43.65, -79.38);
    await store.set(STORAGE_KEY, {
      cells: {
        [geohash]: {
          limitKmh: 60,
          source: 'trip_consensus',
          confidence: 0.85,
          tripCount: 10,
          evidenceCount: 10,
          lastUpdatedAt: '2020-01-01T00:00:00.000Z',
        },
      },
      corrections: [],
    });
    const lsk = new LocalSpeedKnowledge(store);

    await expect(lsk.getForPoint(43.65, -79.38)).resolves.toBeNull();
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
