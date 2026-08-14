/**
 * Evaluating a hazard used to decrypt the whole zone blob on every GPS fix and
 * then scan it linearly. These tests pin the two properties that replaced that:
 * the knowledge is read once per drive, and the spatial index returns a superset
 * of what the linear scan would have found, so narrowing costs no recall.
 *
 * They also cover the gap the snapshot closes rather than mirrors: stored danger
 * zones have never been privacy-filtered anywhere in the pipeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const encrypted = new Map();

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => (encrypted.has(key) ? encrypted.get(key) : fallback)),
  removeEncryptedJson: vi.fn(async (key) => encrypted.delete(key)),
  setEncryptedJson: vi.fn(async (key, value) => encrypted.set(key, structuredClone(value))),
}));

const { getEncryptedJson } = await import('@/lib/securePayloadCrypto');
const { DANGER_ZONES_KEY } = await import('@/lib/dangerZoneEngine');
const { ROUTE_RISK_INDEX_KEY } = await import('@/lib/routeRiskIndex');
const { projectHazardPath, relativeToProjectedPath } = await import('@/lib/hazard/hazardPathProjection');
const {
  __resetHazardHorizonSnapshot,
  getHazardHorizonSnapshot,
  hazardHorizonSnapshotCached,
  invalidateHazardHorizonSnapshot,
  queryHazardCorridor,
} = await import('@/lib/hazard/hazardHorizonSnapshot');
const { HAZARD_HORIZON_ALERT_SECONDS } = await import('@/lib/appConstants');

const M_PER_DEG = 111320;
const ORIGIN = { lat: 45.42, lng: -75.69 };

/** Deterministic PRNG so a failure is reproducible. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const zoneAt = (id, lat, lng, extra = {}) => ({
  id, lat, lng, radiusM: 96, eventCount: 4, severityScore: 8,
  riskLevel: 'high', dominantType: 'harsh_brake', typeBreakdown: { harsh_brake: 4 },
  lastSeen: '2026-07-01T10:00:00.000Z', ...extra,
});

const seedZones = (zones) => encrypted.set(DANGER_ZONES_KEY, zones);
const seedSegments = (segments) => encrypted.set(
  ROUTE_RISK_INDEX_KEY,
  segments.map((segment, index) => [`segment-${index}`, segment])
);

const pathFrom = (headingDeg = 90, speedKmh = 90) => projectHazardPath({
  ...ORIGIN, headingDeg, speedKmh, horizonSeconds: HAZARD_HORIZON_ALERT_SECONDS,
});

beforeEach(() => {
  encrypted.clear();
  __resetHazardHorizonSnapshot();
  vi.clearAllMocks();
});

describe('getHazardHorizonSnapshot', () => {
  it('reads the encrypted stores once no matter how many fixes arrive', async () => {
    seedZones([zoneAt('a', ORIGIN.lat, ORIGIN.lng + 0.001)]);
    for (let fix = 0; fix < 25; fix += 1) await getHazardHorizonSnapshot({ privacyZones: [] });

    // Two reads total: the zone blob and the route-risk index. Before this the
    // count would have been 25.
    expect(getEncryptedJson).toHaveBeenCalledTimes(2);
    expect(hazardHorizonSnapshotCached([])).toBe(true);
  });

  it('rebuilds after an explicit invalidation', async () => {
    seedZones([zoneAt('a', ORIGIN.lat, ORIGIN.lng + 0.001)]);
    await getHazardHorizonSnapshot({ privacyZones: [] });
    invalidateHazardHorizonSnapshot();
    expect(hazardHorizonSnapshotCached([])).toBe(false);

    seedZones([zoneAt('a', ORIGIN.lat, ORIGIN.lng + 0.001), zoneAt('b', ORIGIN.lat, ORIGIN.lng + 0.002)]);
    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [] });
    expect(snapshot.zones).toHaveLength(2);
  });

  it('does not install a snapshot built from knowledge that was superseded mid-build', async () => {
    seedZones([zoneAt('stale', ORIGIN.lat, ORIGIN.lng + 0.001)]);
    const pending = getHazardHorizonSnapshot({ privacyZones: [] });
    invalidateHazardHorizonSnapshot();
    await pending;

    expect(hazardHorizonSnapshotCached([])).toBe(false);
  });

  it('rebuilds when the privacy zone set changes', async () => {
    seedZones([zoneAt('a', ORIGIN.lat, ORIGIN.lng + 0.001)]);
    await getHazardHorizonSnapshot({ privacyZones: [] });
    expect(hazardHorizonSnapshotCached([{ id: 'z', lat: 1, lng: 1, radius_m: 100 }])).toBe(false);
  });

  it('drops zones inside a privacy zone and its guard ring', async () => {
    const home = { id: 'home', lat: ORIGIN.lat, lng: ORIGIN.lng, radius_m: 180 };
    seedZones([
      zoneAt('inside', ORIGIN.lat, ORIGIN.lng),
      // 200 m out: outside the 180 m radius but inside the 50 m guard.
      zoneAt('guard', ORIGIN.lat + 200 / M_PER_DEG, ORIGIN.lng),
      zoneAt('away', ORIGIN.lat + 900 / M_PER_DEG, ORIGIN.lng),
    ]);

    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [home] });
    expect(snapshot.zones.map((zone) => zone.id)).toEqual(['away']);
    expect(snapshot.stats.privacyFilteredZones).toBe(2);
  });

  it('returns an empty but usable snapshot when nothing has been stored', async () => {
    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [] });
    expect(snapshot.zones).toEqual([]);
    expect(snapshot.segments).toEqual([]);
    expect(queryHazardCorridor(snapshot, pathFrom())).toEqual([]);
  });

  it('carries route-risk segments alongside zones', async () => {
    seedZones([]);
    seedSegments([{ lat: ORIGIN.lat, lng: ORIGIN.lng + 0.002, tripCount: 7, harshCount: 3, avgSpeed: 52, riskScore: 64, riskLevel: 'high', eventTypes: { harsh_brake: 3 } }]);
    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [] });
    expect(snapshot.segments).toHaveLength(1);
    expect(snapshot.stats.segmentCount).toBe(1);
  });
});

describe('queryHazardCorridor', () => {
  it('returns a superset of every zone a linear along/cross-track scan would accept', async () => {
    const random = seededRandom(20260807);
    const zones = Array.from({ length: 400 }, (_, index) => zoneAt(
      `zone-${index}`,
      ORIGIN.lat + (random() - 0.5) * 0.02,
      ORIGIN.lng + (random() - 0.5) * 0.02
    ));
    seedZones(zones);
    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [] });

    let checkedCorridors = 0;
    for (let probe = 0; probe < 120; probe += 1) {
      const path = projectHazardPath({
        lat: ORIGIN.lat + (random() - 0.5) * 0.01,
        lng: ORIGIN.lng + (random() - 0.5) * 0.01,
        headingDeg: random() * 360,
        speedKmh: 40 + random() * 70,
        horizonSeconds: HAZARD_HORIZON_ALERT_SECONDS,
      });
      const returned = new Set(queryHazardCorridor(snapshot, path).map((record) => record.zone?.id));
      const linearHits = zones.filter((zone) => relativeToProjectedPath(path, zone).onPath);
      for (const hit of linearHits) expect(returned.has(hit.id)).toBe(true);
      checkedCorridors += linearHits.length ? 1 : 0;
    }
    // A vacuous pass would prove nothing.
    expect(checkedCorridors).toBeGreaterThan(20);
  });

  it('narrows the candidate set far below a full scan', async () => {
    const random = seededRandom(99);
    const zones = Array.from({ length: 400 }, (_, index) => zoneAt(
      `zone-${index}`,
      ORIGIN.lat + (random() - 0.5) * 0.02,
      ORIGIN.lng + (random() - 0.5) * 0.02
    ));
    seedZones(zones);
    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [] });
    expect(queryHazardCorridor(snapshot, pathFrom()).length).toBeLessThan(zones.length / 5);
  });

  it('finds a zone at the very end of the corridor', async () => {
    const path = pathFrom(90, 90);
    const endpoint = path.points[path.points.length - 1];
    seedZones([zoneAt('end', endpoint.lat, endpoint.lng)]);
    const snapshot = await getHazardHorizonSnapshot({ privacyZones: [] });
    expect(queryHazardCorridor(snapshot, path).map((record) => record.zone.id)).toContain('end');
  });
});
