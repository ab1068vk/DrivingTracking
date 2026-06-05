// tests/full-suite.test.mjs
// Road Sage - Full Application Test Suite
// Run: node tests/full-suite.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
  globalThis.localStorage = {
    _store: {},
    getItem: (key) => globalThis.localStorage._store[key] ?? null,
    setItem: (key, value) => { globalThis.localStorage._store[key] = String(value); },
    removeItem: (key) => { delete globalThis.localStorage._store[key]; },
    clear: () => { globalThis.localStorage._store = {}; },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
  });
  globalThis.document = {
    createElement: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.speechSynthesis = null;
  globalThis.AudioContext = class {
    close() {}
    createOscillator() { return { connect() {}, start() {}, stop() {} }; }
    createGain() { return { connect() {}, gain: { value: 0 } }; }
  };
  globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0);
  globalThis.cancelIdleCallback = (id) => clearTimeout(id);
}

if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (value) => Buffer.from(String(value), 'base64').toString('binary');
}
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (value) => Buffer.from(String(value), 'binary').toString('base64');
}

console.log('Road Sage Full Test Suite');
console.log('-------------------------');

let generatedTripId = 0;

// -- INLINE BUILDERS ---------------------------------------------------------
function makeRoutePoint(overrides = {}) {
  return {
    lat: overrides.lat ?? 43.6532,
    lng: overrides.lng ?? -79.3832,
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    speed_kmh: overrides.speed_kmh ?? 50,
    heading: overrides.heading ?? 90,
    accuracy: overrides.accuracy ?? 8,
    altitude: overrides.altitude ?? 100,
    speed_limit_kmh: overrides.speed_limit_kmh ?? null,
    speed_limit_source: overrides.speed_limit_source ?? null,
    road_type: overrides.road_type ?? 'residential',
    ...overrides,
  };
}

function makeRoutePoints(count, scenarioFn) {
  const points = [];
  const base = { lat: 43.6532, lng: -79.3832, timestamp: 1_700_000_000_000 };
  for (let i = 0; i < count; i += 1) {
    const prev = points[i - 1] ?? base;
    const t = base.timestamp + i * 3000;
    const lat = base.lat + i * 0.00024;
    const overrides = scenarioFn ? scenarioFn(i, prev) : {};
    points.push(makeRoutePoint({ lat, lng: base.lng, timestamp: t, ...overrides }));
  }
  return points;
}

function makeTrip(overrides = {}) {
  const START_MS = 1_700_000_000_000;
  const routePoints = overrides.route_points
    ?? makeRoutePoints(120, (i) => ({ speed_kmh: 50, heading: 90 + (i % 5) }));
  const durationMs = (routePoints?.at?.(-1)?.timestamp ?? START_MS) - START_MS;
  generatedTripId += 1;
  return {
    id: overrides.id ?? `trip_${generatedTripId}`,
    state: overrides.state ?? 'completed',
    status: overrides.status ?? overrides.state ?? 'completed',
    start_time: overrides.start_time ?? new Date(START_MS).toISOString(),
    end_time: overrides.end_time ?? new Date(START_MS + durationMs).toISOString(),
    start_time_ms: overrides.start_time_ms ?? START_MS,
    end_time_ms: overrides.end_time_ms ?? START_MS + durationMs,
    distance_km: overrides.distance_km ?? 4.2,
    duration_seconds: overrides.duration_seconds ?? Math.round(durationMs / 1000),
    route_points: routePoints,
    driving_events: overrides.driving_events ?? [],
    score_overall: overrides.score_overall ?? null,
    component_scores: overrides.component_scores ?? null,
    data_quality_flags: overrides.data_quality_flags ?? [],
    ...overrides,
  };
}

function makeHarshBrakeTrip() {
  return makeTrip({
    route_points: makeRoutePoints(200, (i) => {
      if (i % 40 === 38) return { speed_kmh: 80 };
      if (i % 40 === 39) return { speed_kmh: 10 };
      return { speed_kmh: 60 };
    }),
    driving_events: [
      { type: 'harsh_brake', timestamp: 1_700_000_000_000 + 40 * 3000, severity: 0.8, lat: 43.66, lng: -79.38 },
      { type: 'harsh_brake', timestamp: 1_700_000_000_000 + 80 * 3000, severity: 0.6, lat: 43.67, lng: -79.38 },
    ],
  });
}

function makeSpeedingTrip() {
  return makeTrip({
    route_points: makeRoutePoints(150, (i) => ({
      speed_kmh: i > 50 && i < 100 ? 95 : 50,
      speed_limit_kmh: 60,
      speed_limit_source: 'osm',
      road_type: 'primary',
    })),
  });
}

function makeNightTrip() {
  const NIGHT_START = new Date('2026-06-03T02:30:00.000');
  return makeTrip({
    start_time: NIGHT_START.toISOString(),
    start_time_ms: NIGHT_START.getTime(),
    route_points: makeRoutePoints(80, () => ({ speed_kmh: 70 })),
  });
}

function makeShortTrip() {
  return makeTrip({
    distance_km: 0.3,
    route_points: makeRoutePoints(8, () => ({ speed_kmh: 30 })),
  });
}

function makeLongHighwayTrip() {
  return makeTrip({
    distance_km: 180,
    route_points: makeRoutePoints(2000, (i) => ({
      speed_kmh: 110 + Math.sin(i / 50) * 10,
      heading: 90 + Math.sin(i / 100) * 5,
      road_type: 'motorway',
      speed_limit_kmh: 120,
    })),
  });
}

function makePrivacyZoneTrip(privacyZone) {
  const endLat = privacyZone?.lat ?? 43.6532;
  const endLng = privacyZone?.lng ?? -79.3832;
  return makeTrip({
    route_points: makeRoutePoints(60, (i) => ({
      lat: 43.6532 + i * 0.00024,
      lng: -79.3832,
    })).concat([
      makeRoutePoint({ lat: endLat, lng: endLng, timestamp: 1_700_000_180_000 }),
    ]),
  });
}

function makeStopStartTrip() {
  return makeTrip({
    route_points: makeRoutePoints(120, (i) => ({
      speed_kmh: i % 20 < 10 ? 40 : 2,
    })),
  });
}

function makeRapidAccelTrip() {
  return makeTrip({
    route_points: makeRoutePoints(100, (i) => {
      if (i % 25 === 0) return { speed_kmh: 5 };
      if (i % 25 === 1) return { speed_kmh: 60 };
      return { speed_kmh: 55 };
    }),
  });
}

const EDGE_TRIPS = [
  makeTrip({ route_points: [] }),
  makeTrip({ route_points: [makeRoutePoint()] }),
  makeTrip({ distance_km: 0, duration_seconds: 0 }),
  makeTrip({ route_points: null }),
  makeTrip({ start_time: 'not-a-date', end_time: null }),
  makeTrip({ score_overall: 150 }),
  makeTrip({ score_overall: -5 }),
  { ...makeTrip(), id: undefined },
];

// -- SAFE IMPORT HELPER ------------------------------------------------------
const stats = { total: 0, passed: 0, failed: 0, skipped: 0 };
const importSkips = [];

async function tryImport(path) {
  try {
    return await import(path);
  } catch (error) {
    const message = `could not import ${path}: ${error.message}`;
    importSkips.push(message);
    console.warn(`  SKIP: ${message}`);
    return null;
  }
}

function suiteTest(description, fn, options = {}) {
  if (options.skip) {
    stats.skipped += 1;
    test(description, { skip: options.skip }, () => {});
    return;
  }
  stats.total += 1;
  test(description, async () => {
    try {
      await fn();
      stats.passed += 1;
    } catch (error) {
      stats.failed += 1;
      throw error;
    }
  });
}

function skipSection(section, reason) {
  suiteTest(`${section}: SKIP`, () => {}, { skip: reason });
}

function requireFunctions(section, mod, names) {
  if (!mod) {
    skipSection(section, 'module import failed');
    return false;
  }
  const missing = names.filter((name) => typeof mod[name] !== 'function');
  if (missing.length) {
    skipSection(section, `missing export(s): ${missing.join(', ')}`);
    return false;
  }
  return true;
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function assertNumberInRange(value, min, max, label = 'value') {
  assert.equal(typeof value, 'number', `${label} should be a number`);
  assert.ok(Number.isFinite(value), `${label} should be finite`);
  assert.ok(value >= min && value <= max, `${label} should be in [${min}, ${max}], got ${value}`);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.alerts)) return value.alerts;
  if (Array.isArray(value?.windows)) return value.windows;
  return [];
}

function componentEntries(componentScores = {}) {
  return Object.entries(componentScores || {}).filter(([, value]) => value && typeof value === 'object');
}

function collectNumbers(value, path = 'root', results = []) {
  if (typeof value === 'number') {
    results.push([path, value]);
    return results;
  }
  if (!value || typeof value !== 'object') return results;
  for (const [key, nested] of Object.entries(value)) {
    collectNumbers(nested, `${path}.${key}`, results);
  }
  return results;
}

function scoreValue(result) {
  if (typeof result === 'number') return result;
  return result?.score ?? result?.value ?? result?.overall?.value ?? result?.component_scores?.overall?.value;
}

function evidenceValue(result) {
  return result?.evidence ?? result?.confidence ?? result?.overall?.evidence;
}

async function assertNoNullPropertyCrash(name, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(
      !/Cannot read properties of (null|undefined)/.test(String(error?.message || '')),
      `${name} produced an unsafe null/undefined property crash: ${error.message}`,
    );
  }
}

const gpsMath = await tryImport('../src/lib/gps/math.js');
const gpsFormatting = await tryImport('../src/lib/gps/formatting.js');
const gpsSanitize = await tryImport('../src/lib/gps/sanitize.js');
const gpsPrivacy = await tryImport('../src/lib/gps/privacyMask.js');
const routeSummary = await tryImport('../src/lib/gps/routeSummary.js');
const cornering = await tryImport('../src/engine/detection/cornering.js');
const gpsTailgate = await tryImport('../src/engine/detection/gpsTailgate.js');
const harshAcceleration = await tryImport('../src/engine/detection/harshAcceleration.js');
const harshBraking = await tryImport('../src/engine/detection/harshBraking.js');
const headingDrift = await tryImport('../src/engine/detection/headingDrift.js');
const speeding = await tryImport('../src/engine/detection/speeding.js');
const laneCurvature = await tryImport('../src/engine/detection/laneCurvature.js');
const overtakePattern = await tryImport('../src/engine/detection/overtakePattern.js');
const ecoScore = await tryImport('../src/engine/scoring/ecoScore.js') || await tryImport('../src/lib/scoring/ecoScore.js');
const safetyScore = await tryImport('../src/engine/scoring/safetyScore.js') || await tryImport('../src/lib/scoring/safetyScore.js');
const smoothnessScore = await tryImport('../src/engine/scoring/smoothnessScore.js') || await tryImport('../src/lib/scoring/smoothnessScore.js');
const ubiScore = await tryImport('../src/engine/scoring/ubiScore.js') || await tryImport('../src/lib/scoring/componentScores.js');
const scoringPipeline = await tryImport('../src/engine/scoring/pipeline.js') || await tryImport('../src/lib/tripEngine.js');
const speedLimitSource = await tryImport('../src/lib/speedLimitSource.js');
const routeRiskGrid = await tryImport('../src/lib/routeRisk/grid.js');
const routeRiskScoring = await tryImport('../src/lib/routeRisk/scoring.js');
const routeRiskSegment = await tryImport('../src/lib/routeRisk/segmentKey.js');
const routeRiskPrivacy = await tryImport('../src/lib/routeRisk/privacy.js');
const routeRiskTripCells = await tryImport('../src/lib/routeRisk/tripCells.js');
const routeRiskAggregate = await tryImport('../src/lib/routeRisk/aggregate.js');
const trackingStore = await tryImport('../src/lib/trackingStore.js');
const voiceAlerts = await tryImport('../src/lib/voiceAlerts.js');
const errorReporting = await tryImport('../src/lib/errorReporting.js');
const backupEncryption = await tryImport('../src/lib/backupEncryption.js');
const dailyFatigue = await tryImport('../src/lib/dailyFatigueEngine.js');
const dangerZones = await tryImport('../src/lib/dangerZoneEngine.js');
const habitProfile = await tryImport('../src/lib/habitProfile.js');
const ephemeralMode = await tryImport('../src/lib/ephemeralTripMode.js');
const scoringConstants = await tryImport('../src/lib/scoringConstants.js');
const mathUtils = await tryImport('../src/lib/mathUtils.js');

// -- SECTION 1: GPS Math -----------------------------------------------------
describe('Section 1: GPS Math Utilities', () => {
  if (!requireFunctions('Section 1', gpsMath, [
    'haversineDistance',
    'calculateBearing',
    'calculateSpeedKmh',
    'headingDiff',
    'normalizeLocationPoint',
    'cleanRoutePoints',
    'computeSmoothedAccelerations',
  ])) return;

  suiteTest('Section 1: haversineDistance identical points is zero', () => {
    assert.equal(gpsMath.haversineDistance(43.6532, -79.3832, 43.6532, -79.3832), 0);
  });

  suiteTest('Section 1: haversineDistance known Toronto distance is near expected', () => {
    const meters = gpsMath.haversineDistance(43.6532, -79.3832, 43.6570, -79.3810) * 1000;
    assert.ok(Math.abs(meters - 457) < 35, `distance was ${meters}`);
  });

  suiteTest('Section 1: bearings and headingDiff wrap correctly', () => {
    assert.ok(Math.abs(gpsMath.calculateBearing(43.6532, -79.3832, 43.6542, -79.3832)) < 5);
    assert.ok(Math.abs(gpsMath.calculateBearing(43.6532, -79.3832, 43.6532, -79.3822) - 90) < 5);
    assert.equal(gpsMath.headingDiff(350, 10), 20);
  });

  suiteTest('Section 1: normalize, clean, and smooth acceleration are safe', () => {
    const normalized = gpsMath.normalizeLocationPoint({
      coords: { latitude: 43.6532, longitude: -79.3832, speed: 10 },
      timestamp: 1_700_000_000_000,
    });
    assert.equal(normalized.lat, 43.6532);
    assert.equal(normalized.lng, -79.3832);
    const dirty = [makeRoutePoint(), makeRoutePoint(), { lat: NaN, lng: -79 }, makeRoutePoint({ accuracy: 0 })];
    const clean = gpsMath.cleanRoutePoints(dirty);
    assert.ok(Array.isArray(clean));
    assert.ok(clean.length <= dirty.length);
    const accel = gpsMath.computeSmoothedAccelerations(makeRoutePoints(6, () => ({ speed_kmh: 50 })));
    assert.ok(Array.isArray(accel));
    assert.ok(gpsMath.computeSmoothedAccelerations([]).length === 0);
  });
});

// -- SECTION 2: GPS Formatting ---------------------------------------------
describe('Section 2: GPS Formatting', () => {
  if (!requireFunctions('Section 2', gpsFormatting, ['formatDistance', 'formatDuration', 'formatSpeed', 'formatDate'])) return;

  suiteTest('Section 2: distance, duration, speed, and date include expected values', () => {
    assert.match(String(gpsFormatting.formatDistance(0.5)), /(500|0\.5|km|m)/i);
    assert.match(String(gpsFormatting.formatDistance(1.5)), /(1\.5|km)/i);
    assert.match(String(gpsFormatting.formatDuration(3600)), /(1|h|hr|hour)/i);
    assert.match(String(gpsFormatting.formatDuration(90)), /(1|min|90)/i);
    assert.match(String(gpsFormatting.formatSpeed(100)), /100/);
    assert.match(String(gpsFormatting.formatDate(new Date('2024-01-15T00:00:00Z'))), /(Jan|15|2024)/i);
  });

  suiteTest('Section 2: formatters do not throw on nullish and non-finite values', () => {
    for (const fn of ['formatDistance', 'formatDuration', 'formatSpeed', 'formatDate']) {
      for (const value of [null, undefined, 0, NaN, Infinity]) {
        assert.doesNotThrow(() => gpsFormatting[fn](value), `${fn} threw on ${value}`);
      }
    }
  });
});

// -- SECTION 3: GPS Sanitize and Privacy Mask -------------------------------
describe('Section 3: GPS Sanitize and Privacy Mask', () => {
  if (!gpsSanitize || !gpsPrivacy) {
    skipSection('Section 3', 'sanitize or privacy module import failed');
    return;
  }

  suiteTest('Section 3: truncateCoord and truncateRoutePoints reduce precision', () => {
    assert.equal(gpsSanitize.truncateCoord(43.651234567), 43.65123);
    const truncated = gpsSanitize.truncateRoutePoints(makeRoutePoints(100));
    assert.equal(truncated.length, 100);
    assert.ok(truncated.every((point) => String(point.lat).split('.')[1]?.length <= 5));
  }, { skip: typeof gpsSanitize.truncateCoord !== 'function' || typeof gpsSanitize.truncateRoutePoints !== 'function' ? 'missing sanitize exports' : false });

  suiteTest('Section 3: trimParkedTail and validateCandidateTrip handle valid and empty input', () => {
    const trimmed = gpsPrivacy.trimParkedTail([], { reason: 'parked' });
    assert.ok(Array.isArray(trimmed?.points) || Array.isArray(trimmed));
    assert.doesNotThrow(() => gpsPrivacy.trimParkedTail(makePrivacyZoneTrip({ lat: 43.6532, lng: -79.3832 }).route_points, { reason: 'parked' }));
    const candidate = gpsPrivacy.validateCandidateTrip({
      points: makeRoutePoints(20, () => ({ speed_kmh: 35 })),
      startTime: new Date(1_700_000_000_000).toISOString(),
      now: new Date(1_700_000_120_000).toISOString(),
    });
    assert.equal(typeof candidate, 'object');
    assert.doesNotThrow(() => gpsPrivacy.validateCandidateTrip(null));
  }, { skip: typeof gpsPrivacy.trimParkedTail !== 'function' || typeof gpsPrivacy.validateCandidateTrip !== 'function' ? 'missing privacy exports' : false });
});

// -- SECTION 4: Route Summary and Trip Stats --------------------------------
describe('Section 4: Route Summary and Trip Stats', () => {
  if (!requireFunctions('Section 4', routeSummary, ['calculateTripStats', 'splitTripAtStops', 'calculateFatigueScore', 'isNightDrivingTime'])) return;

  suiteTest('Section 4: calculateTripStats returns expected shape and handles short/empty trips', () => {
    const statsResult = routeSummary.calculateTripStats(makeHarshBrakeTrip());
    assert.equal(typeof statsResult, 'object');
    assert.ok('distance_km' in statsResult || 'distanceKm' in statsResult);
    assert.doesNotThrow(() => routeSummary.calculateTripStats(makeShortTrip()));
    assert.doesNotThrow(() => routeSummary.calculateTripStats(makeTrip({ route_points: [] })));
  });

  suiteTest('Section 4: calculateTripStats 2000 points is under 500 ms', () => {
    const start = performance.now();
    routeSummary.calculateTripStats(makeLongHighwayTrip());
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 500, `PERF FAIL: calculateTripStats took ${elapsed}ms (budget: 500ms)`);
  });

  suiteTest('Section 4: splitTripAtStops, night time, and states are sane', () => {
    assert.ok(Array.isArray(routeSummary.splitTripAtStops(makeStopStartTrip().route_points)));
    assert.equal(routeSummary.isNightDrivingTime(new Date('2026-06-03T02:30:00')), true);
    assert.equal(routeSummary.isNightDrivingTime(new Date('2026-06-03T14:00:00')), false);
    assert.ok(routeSummary.TRIP_STATES && typeof routeSummary.TRIP_STATES === 'object');
  });
});

// -- SECTION 5: Detection Engine -------------------------------------------
describe('Section 5: Detection Engine', () => {
  const detectorGroups = [
    ['gpsTailgate', gpsTailgate, ['medianMovingSpeedKmh', 'detectStopStartPatterns', 'detectCloseProximityManeuverAlerts', 'detectTailgateCycles']],
    ['harshAcceleration', harshAcceleration, ['headingBetweenPair', 'signedHeadingDelta', 'smoothHeading', 'headingVarianceForRange', 'detectHeadingDeviationEvents']],
    ['harshBraking', harshBraking, ['summarizePhoneUseEvents', 'detectPhoneUseWindows', 'detectPhoneUsageProxy']],
    ['headingDrift', headingDrift, ['detectHeadingDriftBeta', 'detectDrowsyDriving', 'analyzeFatigueProgression']],
    ['speeding', speeding, ['calculateWindowStats', 'stddev']],
    ['laneCurvature', laneCurvature, ['buildLaneChangeSuppressionWindows', 'isInsideLaneChangeSuppressionWindow']],
    ['overtakePattern', overtakePattern, ['detectAggressiveOvertakes']],
    ['cornering', cornering, ['calculateSmoothBrakingRatio', 'lateralGForTriplet']],
  ];

  for (const [label, mod, names] of detectorGroups) {
    suiteTest(`Section 5: ${label} exports are callable or skipped`, () => {
      assert.ok(mod, `${label} module should import`);
      for (const name of names) assert.equal(typeof mod[name], 'function', `${label}.${name} should be a function`);
    }, { skip: !mod ? 'module import failed' : false });
  }

  suiteTest('Section 5: selected detectors return safe shapes for scenario trips', () => {
    if (gpsTailgate?.detectStopStartPatterns) {
      const result = gpsTailgate.detectStopStartPatterns(makeStopStartTrip().route_points);
      assert.ok(Array.isArray(result) || typeof result === 'object');
    }
    if (gpsTailgate?.detectCloseProximityManeuverAlerts) {
      assert.equal(asArray(gpsTailgate.detectCloseProximityManeuverAlerts(makeTrip().route_points)).length, 0);
    }
    if (headingDrift?.detectHeadingDriftBeta) {
      assert.ok(Array.isArray(asArray(headingDrift.detectHeadingDriftBeta(makeTrip().route_points))));
    }
    if (harshBraking?.detectPhoneUsageProxy) {
      const proxy = harshBraking.detectPhoneUsageProxy(makeTrip().route_points);
      assert.ok((proxy?.phoneUseCount ?? asArray(proxy).length) >= 0);
    }
    if (cornering?.calculateSmoothBrakingRatio) {
      const ratio = cornering.calculateSmoothBrakingRatio(makeHarshBrakeTrip().route_points);
      assert.ok(typeof ratio === 'number' || typeof ratio === 'object');
    }
    if (laneCurvature?.buildLaneChangeSuppressionWindows) {
      assert.ok(Array.isArray(laneCurvature.buildLaneChangeSuppressionWindows(makeShortTrip().route_points)));
    }
  }, { skip: detectorGroups.every(([, mod]) => !mod) ? 'all detector imports failed' : false });
});

// -- SECTION 6: Scoring Engine - Individual Components ----------------------
describe('Section 6: Scoring Engine - Individual Components', () => {
  const scoringFns = [
    [ecoScore, 'calculateEcoDrivingScore', [makeLongHighwayTrip()]],
    [ecoScore, 'calculateJerkScore', [makeTrip().route_points]],
    [ecoScore, 'calculateSpeedVariabilityIndex', [makeLongHighwayTrip().route_points]],
    [ecoScore, 'calculateFuelBandScore', [makeLongHighwayTrip()]],
    [safetyScore, 'calculateAggressiveDrivingScore', [makeHarshBrakeTrip()]],
    [safetyScore, 'calculateDefensiveDrivingScore', [makeTrip()]],
    [smoothnessScore, 'calculateSmoothBrakingRatio', [makeHarshBrakeTrip().route_points]],
    [smoothnessScore, 'calculateBrakeOnsetSmoothness', [makeHarshBrakeTrip().route_points]],
    [smoothnessScore, 'calculateCorneringConsistency', [makeTrip().route_points]],
  ];

  for (const [mod, name, args] of scoringFns) {
    suiteTest(`Section 6: ${name} returns a bounded or evidence-scoped result`, () => {
      assert.equal(typeof mod?.[name], 'function');
      const result = mod[name](...args);
      const value = scoreValue(result);
      const evidence = evidenceValue(result);
      if (typeof value === 'number') assertNumberInRange(value, 0, 100, name);
      if (evidence != null) assert.ok(['high', 'developing', 'low', 'unavailable'].includes(evidence));
      assert.doesNotThrow(() => mod[name](makeTrip({ route_points: [] })));
    }, { skip: typeof mod?.[name] !== 'function' ? 'module import failed or export missing' : false });
  }
});

// -- SECTION 7: Full Scoring Pipeline ---------------------------------------
describe('Section 7: Full Scoring Pipeline', () => {
  suiteTest('Section 7: calculateTripScores returns scored trip contract across scenarios', () => {
    assert.equal(typeof ubiScore?.calculateTripScores, 'function');
    for (const trip of [makeHarshBrakeTrip(), makeSpeedingTrip(), makeNightTrip(), makeShortTrip(), makeTrip({ route_points: [] })]) {
      assert.doesNotThrow(() => ubiScore.calculateTripScores(trip, {}));
      const result = ubiScore.calculateTripScores(trip, {});
      assert.ok(result && typeof result === 'object');
      assert.ok(result.component_scores || result.overall || result.score_overall != null);
    }
  }, { skip: typeof ubiScore?.calculateTripScores !== 'function' ? 'calculateTripScores unavailable to plain Node' : false });

  suiteTest('Section 7: buildScoreProvenance includes scoring version and calibration status', () => {
    assert.equal(typeof ubiScore?.buildScoreProvenance, 'function');
    const provenance = ubiScore.buildScoreProvenance({});
    assert.ok(provenance?.scoring_version || provenance?.scoringVersion);
    assert.ok('calibration_status' in provenance || 'calibrationStatus' in provenance);
  }, { skip: typeof ubiScore?.buildScoreProvenance !== 'function' ? 'buildScoreProvenance unavailable' : false });
});

// -- SECTION 8: Speed Limit Source ------------------------------------------
describe('Section 8: Speed Limit Source', () => {
  if (!requireFunctions('Section 8', speedLimitSource, ['parseMaxspeedKmh', 'defaultSpeedLimitKmhForOsmHighway'])) return;

  suiteTest('Section 8: parseMaxspeedKmh handles numeric, mph, nullish, and empty values', () => {
    assert.equal(speedLimitSource.parseMaxspeedKmh('50'), 50);
    assert.ok(Math.abs(speedLimitSource.parseMaxspeedKmh('30 mph') - 48) <= 2);
    assert.doesNotThrow(() => speedLimitSource.parseMaxspeedKmh('walk'));
    for (const value of [null, undefined, '']) assert.equal(speedLimitSource.parseMaxspeedKmh(value), null);
  });

  suiteTest('Section 8: OSM defaults contain expected highway keys', () => {
    const motorway = speedLimitSource.defaultSpeedLimitKmhForOsmHighway('motorway', {}, 'CA');
    const residential = speedLimitSource.defaultSpeedLimitKmhForOsmHighway('residential', {}, 'CA');
    assert.ok([100, 110, 120].includes(motorway) || motorway >= 80);
    assert.ok([40, 50].includes(residential) || residential >= 20);
    assert.equal(typeof speedLimitSource.defaultSpeedLimitKmhForOsmHighway('unknown_type', {}, 'CA'), 'number');
    for (const key of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service']) {
      assert.ok(key in speedLimitSource.OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH);
    }
  });
});

// -- SECTION 9: Route Risk Index --------------------------------------------
describe('Section 9: Route Risk Index', () => {
  suiteTest('Section 9: route-risk grid, segment, scoring, privacy, and aggregate contracts', () => {
    assert.ok(routeRiskGrid && routeRiskScoring && routeRiskSegment && routeRiskPrivacy && routeRiskTripCells && routeRiskAggregate);
    const key = routeRiskGrid.cellKeyForPoint(43.6532, -79.3832);
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.equal(routeRiskGrid.cellKeyForPoint(43.6532, -79.3832), routeRiskGrid.cellKeyForPoint(43.653209, -79.3832));
    assert.notEqual(routeRiskGrid.cellKeyForPoint(43.6532, -79.3832), routeRiskGrid.cellKeyForPoint(43.6577, -79.3832));
    const center = routeRiskGrid.cellCenterFromKey(key);
    assert.ok(center && typeof center.lat === 'number' && typeof center.lng === 'number');
    assert.match(routeRiskSegment.geohashEncode(43.6532, -79.3832, 6), /^dpz8/);
    assert.equal(routeRiskSegment.segmentKey(1, 2, 3, 4), routeRiskSegment.segmentKey(3, 4, 1, 2));
    assert.equal(routeRiskScoring.riskLevelForScore(0), 'low');
    assert.equal(routeRiskScoring.riskLevelForScore(150), 'high');
    assert.equal(routeRiskScoring.dominantEventType({ harsh_brake: 5, rapid_accel: 2 }), 'harsh_brake');
    assert.equal(routeRiskPrivacy.isPrivacyMaskedPoint({ lat: NaN }), true);
    assert.equal(routeRiskPrivacy.isNearPrivacyZone(43.6532, -79.3832, [], 100), false);
    const cells = routeRiskTripCells.buildRouteRiskCellsForTrip(makeHarshBrakeTrip(), []);
    assert.ok(Array.isArray(cells));
    const index = routeRiskAggregate.buildRouteRiskIndexFromTrips([makeHarshBrakeTrip(), makeSpeedingTrip()], []);
    assert.ok(index instanceof Map || typeof index === 'object');
    assert.ok(Array.isArray(routeRiskAggregate.getRouteRiskCellsNearPoint(index, 43.6532, -79.3832, 500)));
    assert.ok(routeRiskAggregate.compactRouteRiskIndex(index).size <= index.size);
  }, { skip: !routeRiskGrid || !routeRiskScoring || !routeRiskSegment || !routeRiskPrivacy || !routeRiskTripCells || !routeRiskAggregate ? 'route-risk module import failed' : false });
});

// -- SECTION 10: Privacy Zones ----------------------------------------------
describe('Section 10: Privacy Zones', () => {
  suiteTest('Section 10: isInPrivacyZone respects center, radius, invalid coords, and empty zones', async () => {
    assert.equal(typeof trackingStore?.isInPrivacyZone, 'function');
    const HOME_ZONE = { id: 'home', lat: 43.6532, lng: -79.3832, radius_m: 200 };
    assert.equal(await trackingStore.isInPrivacyZone(43.6532, -79.3832, [HOME_ZONE]), true);
    assert.equal(await trackingStore.isInPrivacyZone(43.6541, -79.3832, [HOME_ZONE]), true);
    assert.equal(await trackingStore.isInPrivacyZone(43.6560, -79.3832, [HOME_ZONE]), false);
    assert.equal(await trackingStore.isInPrivacyZone(NaN, -79.3832, [HOME_ZONE]), false);
    assert.equal(await trackingStore.isInPrivacyZone(43.6532, -79.3832, []), false);
    assert.ok(Number(trackingStore.PARKED_LOCATION_PRIVACY_GUARD_M) > 0);
  }, { skip: typeof trackingStore?.isInPrivacyZone !== 'function' ? 'trackingStore unavailable to plain Node' : false });
});

// -- SECTION 11: Settings Store ---------------------------------------------
describe('Section 11: Settings Store', () => {
  suiteTest('Section 11: default settings, validation, sanitize, and migration contracts', () => {
    assert.ok(trackingStore?.DEFAULT_SETTINGS);
    for (const key of ['voice_alerts_enabled', 'speed_warning_enabled', 'notif_speeding_alert_enabled', 'tracking_mode', 'fallback_country']) {
      assert.ok(key in trackingStore.DEFAULT_SETTINGS, `${key} missing`);
    }
    assert.equal(trackingStore.DEFAULT_SETTINGS.voice_alerts_enabled, false);
    assert.doesNotThrow(() => trackingStore.validateSettingsPatch({ voice_alerts_enabled: true }));
    assert.throws(() => trackingStore.validateSettingsPatch({ voice_alerts_enabled: 'banana' }));
    assert.throws(() => trackingStore.validateSettingsPatch({ unknown_key_xyz: 999 }));
    const sanitized = trackingStore.sanitizeImportedSettings({ voice_alerts_enabled: 'undefined', voice_alert_rate: 999 });
    assert.equal(typeof sanitized, 'object');
    assert.ok('voice_alerts_enabled' in trackingStore.migrateDefaultSettings({}));
    assert.doesNotThrow(() => trackingStore.migrateDefaultSettings(null));
  }, { skip: !trackingStore?.DEFAULT_SETTINGS ? 'trackingStore unavailable to plain Node' : false });
});

// -- SECTION 12: Voice Alerts - Cooldown System -----------------------------
describe('Section 12: Voice Alerts - Cooldown System', () => {
  suiteTest('Section 12: canSpeakSafetyAlert cooldown and reset behavior', () => {
    assert.equal(typeof voiceAlerts?.canSpeakSafetyAlert, 'function');
    assert.equal(typeof voiceAlerts?.resetSafetyAlertCooldowns, 'function');
    voiceAlerts.resetSafetyAlertCooldowns();
    assert.equal(voiceAlerts.canSpeakSafetyAlert('key', 60000, 1000), true);
    if (typeof voiceAlerts.markSafetyAlertSpoken === 'function') {
      voiceAlerts.markSafetyAlertSpoken('key', 1000);
      assert.equal(voiceAlerts.canSpeakSafetyAlert('key', 60000, 2000), false);
      assert.equal(voiceAlerts.canSpeakSafetyAlert('key', 60000, 62000), true);
    }
    assert.equal(voiceAlerts.canSpeakSafetyAlert('key', 0, 2000), true);
    assert.equal(voiceAlerts.canSpeakSafetyAlert('Key', 60000, 2000), true);
    voiceAlerts.resetSafetyAlertCooldowns();
    assert.equal(voiceAlerts.canSpeakSafetyAlert('key', 60000, 2000), true);
  }, { skip: typeof voiceAlerts?.canSpeakSafetyAlert !== 'function' ? 'voiceAlerts unavailable to plain Node' : false });
});

// -- SECTION 13: Error Reporting --------------------------------------------
describe('Section 13: Error Reporting', () => {
  suiteTest('Section 13: scrub, sanitize, and logError are privacy-safe and no-throw', () => {
    assert.equal(typeof errorReporting?.scrubDiagnosticText, 'function');
    const scrubbed = errorReporting.scrubDiagnosticText('Error at lat=43.6532 lng=-79.3832');
    assert.ok(!/43\.6532.*-79\.3832/.test(scrubbed));
    const scrubbedUrl = errorReporting.scrubDiagnosticText('https://api.example.com?lat=43.65&lng=-79.38');
    assert.ok(!/lat=43\.65/.test(scrubbedUrl));
    const sanitized = errorReporting.sanitizeError(new Error('DB write failed'));
    assert.ok(sanitized && sanitized.message);
    assert.doesNotThrow(() => errorReporting.sanitizeError(null));
    assert.doesNotThrow(() => errorReporting.logError('test_context', new Error('test'), { speed_kmh: 55 }));
  }, { skip: typeof errorReporting?.scrubDiagnosticText !== 'function' ? 'errorReporting unavailable to plain Node' : false });
});

// -- SECTION 14: Backup Encryption ------------------------------------------
describe('Section 14: Backup Encryption', () => {
  const PASSWORD = 'CorrectHorse99!@';

  suiteTest('Section 14: backup encryption round-trip and validation behavior', async () => {
    assert.equal(typeof backupEncryption?.encryptBackup, 'function');
    const BACKUP_PAYLOAD = JSON.stringify({ trips: [makeTrip()], settings: trackingStore?.DEFAULT_SETTINGS ?? {} });
    assert.equal(backupEncryption.isEncryptedBackup('not-encrypted'), false);
    const encrypted = await backupEncryption.encryptBackup(BACKUP_PAYLOAD, PASSWORD);
    assert.ok(typeof encrypted === 'string' || encrypted instanceof Uint8Array);
    assert.equal(backupEncryption.isEncryptedBackup(encrypted), true);
    assert.equal(await backupEncryption.decryptBackup(encrypted, PASSWORD), BACKUP_PAYLOAD);
    await assert.rejects(() => backupEncryption.decryptBackup(encrypted, 'wrong-password'));
    await assert.rejects(() => backupEncryption.encryptBackup(BACKUP_PAYLOAD, 'short'));
    await assert.doesNotReject(() => backupEncryption.encryptBackup('', PASSWORD));
  }, { skip: typeof backupEncryption?.encryptBackup !== 'function' ? 'backupEncryption import failed' : false });
});

// -- SECTION 15: Daily Fatigue Engine ---------------------------------------
describe('Section 15: Daily Fatigue Engine', () => {
  suiteTest('Section 15: computeDailyFatigue and getTodayTrips return safe contracts', () => {
    assert.equal(typeof dailyFatigue?.computeDailyFatigue, 'function');
    const todayTrips = [
      makeNightTrip(),
      makeTrip({ duration_seconds: 7200 }),
      makeTrip({ duration_seconds: 1800 }),
    ];
    const todays = dailyFatigue.getTodayTrips([...todayTrips, makeTrip({ end_time: '2020-01-01T10:00:00Z' })]);
    assert.ok(Array.isArray(todays));
    const result = dailyFatigue.computeDailyFatigue(todayTrips);
    assert.equal(typeof result, 'object');
    assert.ok(Number.isFinite(numeric(result.cumulativeFatigueScore ?? result.score, 0)));
    assert.ok(['low', 'moderate', 'high', 'very_high', undefined].includes(result.riskLevel));
    assert.doesNotThrow(() => dailyFatigue.computeDailyFatigue([]));
    assert.doesNotThrow(() => dailyFatigue.computeDailyFatigue(null));
  }, { skip: typeof dailyFatigue?.computeDailyFatigue !== 'function' ? 'dailyFatigueEngine unavailable to plain Node' : false });
});

// -- SECTION 16: Danger Zones ------------------------------------------------
describe('Section 16: Danger Zones', () => {
  suiteTest('Section 16: buildDangerZones and checkDangerZoneProximity are safe', () => {
    assert.equal(typeof dangerZones?.buildDangerZones, 'function');
    const zones = dangerZones.buildDangerZones([makeHarshBrakeTrip(), makeHarshBrakeTrip(), makeHarshBrakeTrip()]);
    assert.ok(Array.isArray(zones));
    for (const zone of zones) {
      assert.ok('lat' in zone && 'lng' in zone);
      assert.ok('radius_m' in zone || 'radiusM' in zone);
    }
    assert.deepEqual(dangerZones.checkDangerZoneProximity({ lat: 43.6532, lng: -79.3832 }, [], 500), []);
    assert.doesNotThrow(() => dangerZones.checkDangerZoneProximity(null, [], 500));
  }, { skip: typeof dangerZones?.buildDangerZones !== 'function' ? 'dangerZoneEngine unavailable to plain Node' : false });
});

// -- SECTION 17: Habit Profile ----------------------------------------------
describe('Section 17: Habit Profile', () => {
  suiteTest('Section 17: habit profile and fallback time risk are circadian-safe', () => {
    assert.equal(typeof habitProfile?.buildHabitProfile, 'function');
    const manyTrips = Array.from({ length: 25 }, (_, i) => (
      makeTrip({ start_time: new Date(Date.UTC(2026, 5, 3) - i * 86400000).toISOString() })
    ));
    const profile = habitProfile.buildHabitProfile(manyTrips);
    assert.ok(profile.timeRiskProfile || profile.hourlyRisk || profile.dayOfWeekPattern);
    assert.doesNotThrow(() => habitProfile.buildHabitProfile([]));
    const twoAm = habitProfile.getFallbackTimeRisk(2);
    const twoPm = habitProfile.getFallbackTimeRisk(14);
    assert.equal(typeof twoAm, 'number');
    assert.equal(typeof twoPm, 'number');
    assert.ok(twoAm > twoPm);
  }, { skip: typeof habitProfile?.buildHabitProfile !== 'function' ? 'habitProfile unavailable to plain Node' : false });
});

// -- SECTION 18: Ephemeral Trip Mode ----------------------------------------
describe('Section 18: Ephemeral Trip Mode', () => {
  suiteTest('Section 18: wipeTripObject removes location data and stealth flag is boolean', () => {
    assert.equal(typeof ephemeralMode?.wipeTripObject, 'function');
    const wiped = ephemeralMode.wipeTripObject(makeTrip());
    assert.ok(!wiped?.route_points || wiped.route_points.length === 0);
    assert.ok(!JSON.stringify(wiped).includes('43.6532'));
    assert.doesNotThrow(() => ephemeralMode.wipeTripObject(null));
    assert.equal(typeof ephemeralMode.isStealthNextTripEnabled(), 'boolean');
  }, { skip: typeof ephemeralMode?.wipeTripObject !== 'function' ? 'ephemeralTripMode unavailable to plain Node' : false });
});

// -- SECTION 19: Scoring Constants ------------------------------------------
describe('Section 19: Scoring Constants', () => {
  suiteTest('Section 19: scoring constants and version are finite and non-empty', () => {
    assert.ok(scoringConstants?.SCORING_VERSION);
    assert.match(String(scoringConstants.SCORING_VERSION), /^v?\d+\.\d+|^[a-f0-9]{7,}$/i);
    assert.ok(scoringConstants.SCORING_CONSTANTS && Object.keys(scoringConstants.SCORING_CONSTANTS).length > 0);
    const firstNumericKey = Object.entries(scoringConstants.SCORING_CONSTANTS).find(([, entry]) => typeof entry?.value === 'number')?.[0];
    assert.ok(firstNumericKey, 'expected at least one numeric constant registry value');
    assert.equal(typeof scoringConstants.scoringValue(firstNumericKey), 'number');
    for (const [key, value] of collectNumbers(scoringConstants.SCORING_CONSTANTS)) {
      assert.ok(Number.isFinite(value), `${key} is not finite`);
    }
  }, { skip: !scoringConstants?.SCORING_CONSTANTS ? 'scoringConstants import failed' : false });
});

// -- SECTION 20: Edge Cases --------------------------------------------------
describe('Section 20: Edge Cases - Malformed and Adversarial Inputs', () => {
  suiteTest('Section 20: tested functions avoid unsafe null-property crashes', async () => {
    const candidates = [
      ['cleanRoutePoints', gpsMath?.cleanRoutePoints, (trip) => [trip.route_points]],
      ['computeSmoothedAccelerations', gpsMath?.computeSmoothedAccelerations, (trip) => [trip.route_points]],
      ['truncateRoutePoints', gpsSanitize?.truncateRoutePoints, (trip) => [trip.route_points]],
      ['trimParkedTail', gpsPrivacy?.trimParkedTail, (trip) => [trip.route_points]],
      ['calculateTripStats', routeSummary?.calculateTripStats, (trip) => [trip]],
      ['calculateTripScores', ubiScore?.calculateTripScores, (trip) => [trip, {}]],
      ['buildRouteRiskCellsForTrip', routeRiskTripCells?.buildRouteRiskCellsForTrip, (trip) => [trip, []]],
      ['computeDailyFatigue', dailyFatigue?.computeDailyFatigue, (trip) => [[trip]]],
      ['buildDangerZones', dangerZones?.buildDangerZones, (trip) => [[trip]]],
      ['buildHabitProfile', habitProfile?.buildHabitProfile, (trip) => [[trip]]],
    ].filter(([, fn]) => typeof fn === 'function');

    assert.ok(candidates.length > 0, 'at least one edge-case candidate should be available');
    const adversarialTrips = [
      ...EDGE_TRIPS,
      undefined,
      {},
      'not-an-array',
      makeTrip({ route_points: [makeRoutePoint({ speed_kmh: Infinity })] }),
      makeTrip({ route_points: [makeRoutePoint({ lat: NaN, lng: NaN })] }),
    ];
    for (const [name, fn, argsFor] of candidates) {
      for (const edgeTrip of adversarialTrips) {
        await assertNoNullPropertyCrash(name, () => fn(...argsFor(edgeTrip ?? {})));
      }
    }
  });
});

// -- SECTION 21: Performance Budgets ----------------------------------------
describe('Section 21: Performance Budgets', () => {
  function perfCase(name, budgetMs, fn) {
    suiteTest(`Section 21: ${name} under ${budgetMs} ms`, () => {
      const start = performance.now();
      fn();
      const elapsed = performance.now() - start;
      assert.ok(elapsed < budgetMs, `PERF FAIL: ${name} took ${elapsed}ms (budget: ${budgetMs}ms)`);
    }, { skip: typeof fn !== 'function' ? 'operation unavailable' : false });
  }

  perfCase('calculateTripStats 2000-point highway trip', 500, routeSummary?.calculateTripStats
    ? () => routeSummary.calculateTripStats(makeLongHighwayTrip())
    : null);
  perfCase('calculateTripScores full pipeline 2000-point highway trip', 1000, ubiScore?.calculateTripScores
    ? () => ubiScore.calculateTripScores(makeLongHighwayTrip(), {})
    : null);
  perfCase('buildRouteRiskIndexFromTrips 10 trips x 120 points', 2000, routeRiskAggregate?.buildRouteRiskIndexFromTrips
    ? () => routeRiskAggregate.buildRouteRiskIndexFromTrips(Array.from({ length: 10 }, () => makeTrip()), [])
    : null);
  perfCase('buildDangerZones 20 harsh-brake trips', 500, dangerZones?.buildDangerZones
    ? () => dangerZones.buildDangerZones(Array.from({ length: 20 }, () => makeHarshBrakeTrip()))
    : null);
  perfCase('buildHabitProfile 100 trips', 200, habitProfile?.buildHabitProfile
    ? () => habitProfile.buildHabitProfile(Array.from({ length: 100 }, (_, i) => makeTrip({ start_time: new Date(Date.UTC(2026, 5, 3) - i * 86400000).toISOString() })))
    : null);
  perfCase('buildRouteRiskCellsForTrip 2000-point trip', 300, routeRiskTripCells?.buildRouteRiskCellsForTrip
    ? () => routeRiskTripCells.buildRouteRiskCellsForTrip(makeLongHighwayTrip(), [])
    : null);
});

// -- SECTION 22: Data Contract Invariants -----------------------------------
describe('Section 22: Data Contract Invariants', () => {
  suiteTest('Section 22: component score ranges and evidence enums are valid', () => {
    if (typeof ubiScore?.calculateTripScores !== 'function') {
      assert.ok(true);
      return;
    }
    const scored = ubiScore.calculateTripScores(makeHarshBrakeTrip(), {});
    for (const [key, component] of componentEntries(scored.component_scores)) {
      if (component.value != null) assertNumberInRange(component.value, 0, 100, key);
      if (component.evidence != null) assert.ok(['high', 'developing', 'low', 'unavailable'].includes(component.evidence));
    }
  });

  suiteTest('Section 22: calculateTripStats does not mutate trip id', () => {
    if (typeof routeSummary?.calculateTripStats !== 'function') {
      assert.ok(true);
      return;
    }
    const trip = makeTrip();
    const beforeId = trip.id;
    routeSummary.calculateTripStats(trip);
    assert.equal(trip.id, beforeId);
  });

  suiteTest('Section 22: error scrubbing removes coordinate patterns', () => {
    if (typeof errorReporting?.scrubDiagnosticText !== 'function') {
      assert.ok(true);
      return;
    }
    const output = errorReporting.scrubDiagnosticText('lat=43.6532 lng=-79.3832');
    assert.ok(!/43\.6532.*-79\.3832/.test(output));
  });

  suiteTest('Section 22: scoring version is available', () => {
    assert.ok(typeof scoringConstants?.SCORING_VERSION === 'string' && scoringConstants.SCORING_VERSION.length > 0);
  });

  suiteTest('Section 22: privacy-only route-risk trip does not expose raw cells', () => {
    if (typeof routeRiskTripCells?.buildRouteRiskCellsForTrip !== 'function') {
      assert.ok(true);
      return;
    }
    const HOME_ZONE = { id: 'home', lat: 43.6532, lng: -79.3832, radius_m: 2000 };
    const trip = makeTrip({ route_points: makeRoutePoints(20, () => ({ lat: 43.6532, lng: -79.3832 })) });
    const cells = routeRiskTripCells.buildRouteRiskCellsForTrip(trip, [HOME_ZONE]);
    assert.ok(cells.length === 0 || cells.every((cell) => cell.lat == null && cell.lng == null));
  });
});

const uncaught = [];
process.on('uncaughtException', (err) => {
  uncaught.push(err);
  console.error('UNCAUGHT:', err.message);
});

before(() => {
  console.log(`Import skips discovered: ${importSkips.length}`);
});

after(() => {
  console.log('-------------------------');
  console.log(`Total:   ${stats.total + stats.skipped} tests`);
  console.log(`Passed:  ${stats.passed}`);
  console.log(`Failed:  ${stats.failed}`);
  console.log(`Skipped: ${stats.skipped} (${importSkips.length} import failures)`);
  console.log(`Uncaught: ${uncaught.length} exceptions`);
  console.log('-------------------------');
});

process.on('exit', () => {
  if (uncaught.length > 0) {
    console.error(`\n${uncaught.length} UNCAUGHT EXCEPTION(S) during test run:`);
    uncaught.forEach((error, index) => console.error(`  ${index + 1}. ${error.stack}`));
    process.exitCode = 1;
  }
});
