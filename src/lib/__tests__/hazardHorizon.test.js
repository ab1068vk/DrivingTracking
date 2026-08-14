/**
 * The behaviour these tests exist to protect is mostly *silence*. The warning
 * they replaced fired on any stored zone within 300 m in any direction, so the
 * cases that matter are the ones that must now stay quiet: behind the vehicle,
 * on the parallel road, too far out, too late to act, inside a private place,
 * and on a fix too rough to say which road you are on.
 *
 * Every rejection carries a named reason, so "why did it not warn me" is
 * answerable from the diagnostics rather than by guessing.
 */
import { describe, expect, it } from 'vitest';
import { buildSpeedSpatialIndex } from '@/lib/speed/speedSpatialIndex';
import { rankHazardCandidates } from '@/lib/hazard/hazardCandidates';
import { buildHazardHorizon, resolveHorizonSeconds } from '@/lib/hazard/hazardHorizon';
import {
  HAZARD_HORIZON_ALERT_SECONDS,
  HAZARD_HORIZON_MAX_SECONDS,
  HAZARD_HORIZON_MIN_SECONDS_SETTING,
} from '@/lib/appConstants';

const M_PER_DEG = 111320;
const ORIGIN = { lat: 45.42, lng: -75.69 };

const pointAt = (origin, bearingDeg, distanceM) => {
  const rad = (bearingDeg * Math.PI) / 180;
  const cosLat = Math.abs(Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: origin.lat + (Math.cos(rad) * distanceM) / M_PER_DEG,
    lng: origin.lng + (Math.sin(rad) * distanceM) / (M_PER_DEG * cosLat),
  };
};

const zoneAt = (id, bearingDeg, distanceM, overrides = {}) => ({
  id,
  ...pointAt(ORIGIN, bearingDeg, distanceM),
  radiusM: 96,
  eventCount: 6,
  severityScore: 12,
  riskLevel: 'high',
  dominantType: 'harsh_brake',
  typeBreakdown: { harsh_brake: 6 },
  lastSeen: '2026-07-01T10:00:00.000Z',
  ...overrides,
});

const segmentAt = (bearingDeg, distanceM, overrides = {}) => ({
  ...pointAt(ORIGIN, bearingDeg, distanceM),
  tripCount: 8,
  harshCount: 4,
  totalEvents: 4,
  avgSpeed: 50,
  riskScore: 62,
  riskLevel: 'high',
  eventTypes: { harsh_brake: 4 },
  ...overrides,
});

/** Builds the same record/index shape the real snapshot produces. */
const snapshotOf = ({ zones = [], segments = [] } = {}) => {
  const records = [
    ...zones.map((zone) => ({ kind: 'zone', zone })),
    ...segments.map((segment) => ({ kind: 'segment', segment })),
  ];
  const index = buildSpeedSpatialIndex(
    records,
    (record) => [record.zone || record.segment],
    0.2
  );
  return {
    builtAt: Date.now(),
    zones,
    segments,
    index,
    stats: { zoneCount: zones.length, segmentCount: segments.length, ...index.stats() },
  };
};

/** Six fixes running due east into ORIGIN, so a heading is derivable without GPS bearing. */
const eastboundTrack = (speedKmh = 70) => {
  const startMs = 1_770_000_000_000;
  return Array.from({ length: 6 }, (_, i) => ({
    ...pointAt(ORIGIN, 270, (5 - i) * 8),
    speed_kmh: speedKmh,
    accuracy: 8,
    timestamp: new Date(startMs + i * 1000).toISOString(),
  }));
};

const run = (snapshot, { speedKmh = 70, overrides = {}, ...rest } = {}) => {
  const recentPoints = eastboundTrack(speedKmh);
  const point = { ...recentPoints[recentPoints.length - 1], ...overrides };
  return buildHazardHorizon({
    point,
    recentPoints: [...recentPoints.slice(0, -1), point],
    snapshot,
    nowMs: Date.parse(point.timestamp),
    ...rest,
  });
};

const reasonsOf = (result) => result.suppressed.map((entry) => entry.reason);

describe('resolveHorizonSeconds', () => {
  it('falls back to the default and clamps hostile values', () => {
    expect(resolveHorizonSeconds({})).toBe(HAZARD_HORIZON_ALERT_SECONDS);
    expect(resolveHorizonSeconds({ hazard_horizon_seconds: 999 })).toBe(HAZARD_HORIZON_MAX_SECONDS);
    expect(resolveHorizonSeconds({ hazard_horizon_seconds: 1 })).toBe(HAZARD_HORIZON_MIN_SECONDS_SETTING);
    // Number(null) is 0, which must not read as a zero-second horizon.
    expect(resolveHorizonSeconds({ hazard_horizon_seconds: null })).toBe(HAZARD_HORIZON_ALERT_SECONDS);
  });
});

describe('buildHazardHorizon', () => {
  it('warns about a zone genuinely ahead on the road being driven', () => {
    const result = run(snapshotOf({ zones: [zoneAt('ahead', 90, 200)] }));
    expect(result.top?.id).toBe('zone:ahead');
    expect(result.top.etaSeconds).toBeGreaterThan(0);
    expect(result.top.etaSeconds).toBeLessThan(HAZARD_HORIZON_ALERT_SECONDS);
    expect(result.diagnostics.headingSource).toBe('derived');
  });

  it('stays silent about a zone behind the vehicle', () => {
    const result = run(snapshotOf({ zones: [zoneAt('behind', 270, 150)] }));
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['behind']);
  });

  it('stays silent about a zone on the parallel road', () => {
    const beside = pointAt(pointAt(ORIGIN, 90, 200), 180, 65);
    const result = run(snapshotOf({ zones: [{ ...zoneAt('parallel', 90, 200), ...beside }] }));
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['off_path']);
  });

  it('stays silent about a zone still beyond the warning window', () => {
    const result = run(snapshotOf({ zones: [zoneAt('far', 90, 340)] }), { speedKmh: 70 });
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['beyond_horizon']);
  });

  it('stays silent once it is too late for a warning to help', () => {
    const result = run(snapshotOf({ zones: [zoneAt('imminent', 90, 20)] }));
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['too_late']);
  });

  it('does not read hazard knowledge at all inside a private place', () => {
    const snapshot = snapshotOf({ zones: [zoneAt('ahead', 90, 200)] });
    let queried = false;
    const spied = { ...snapshot, index: { ...snapshot.index, query: (...args) => { queried = true; return snapshot.index.query(...args); } } };
    const result = run(spied, { privacyZones: [{ id: 'home', lat: ORIGIN.lat, lng: ORIGIN.lng, radius_m: 180 }] });
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['inside_privacy_zone']);
    expect(queried).toBe(false);
  });

  it('abstains on a fix too rough to say which road you are on', () => {
    const result = run(snapshotOf({ zones: [zoneAt('ahead', 90, 200)] }), { overrides: { accuracy: 60 } });
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['low_accuracy']);
  });

  it('abstains below the minimum speed', () => {
    const result = run(snapshotOf({ zones: [zoneAt('ahead', 90, 200)] }), { speedKmh: 8 });
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['below_min_speed']);
  });

  it('abstains when no heading can be recovered', () => {
    const point = { ...ORIGIN, speed_kmh: 70, accuracy: 8, timestamp: new Date(1_770_000_000_000).toISOString() };
    const result = buildHazardHorizon({
      point, recentPoints: [point], snapshot: snapshotOf({ zones: [zoneAt('ahead', 90, 200)] }),
    });
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['no_heading']);
  });

  it('ranks the more severe zone above a milder one closer to hand', () => {
    const result = run(snapshotOf({
      zones: [
        zoneAt('critical', 90, 210, { riskLevel: 'critical', eventCount: 9 }),
        zoneAt('low', 90, 140, { riskLevel: 'low', eventCount: 3 }),
      ],
    }));
    expect(result.hazards.map((hazard) => hazard.id)).toEqual(['zone:critical', 'zone:low']);
  });

  it('prefers a repeated-event area over a well-evidenced braking habit at the same spot', () => {
    // A place several detectors fired at outranks advice about a habit, even
    // when the habit has more evidence behind it.
    const result = run(snapshotOf({
      zones: [zoneAt('area', 90, 200, { riskLevel: 'medium', eventCount: 4 })],
      segments: [segmentAt(90, 200)],
    }));
    expect(result.hazards.length).toBeGreaterThan(1);
    expect(result.top.kind).toBe('repeated_event_area');
  });

  it('never promotes a route-risk segment to a hazard on its own evidence', () => {
    // Segments cover every road driven more than twice. Only the late-braking
    // advisory can speak for one, and only when its own gates pass.
    const result = run(snapshotOf({ segments: [segmentAt(90, 200, { tripCount: 3, harshCount: 1, eventTypes: { harsh_brake: 1 } })] }));
    expect(result.top).toBeNull();
    expect(reasonsOf(result)).toEqual(['insufficient_passes']);
  });

  it('speaks for a braking habit when the segment evidence earns it', () => {
    const result = run(snapshotOf({ segments: [segmentAt(90, 200)] }));
    expect(result.top?.kind).toBe('late_braking_pattern');
    expect(result.top.evidence.passes).toBe(8);
  });

  it('breaks a genuine urgency tie by kind, then by imminence', () => {
    const tied = (id, kind, etaSeconds) => ({ id, kind, urgency: 0.5, etaSeconds });
    expect(rankHazardCandidates([
      tied('habit', 'late_braking_pattern', 9),
      tied('area', 'repeated_event_area', 9),
    ]).map((hazard) => hazard.id)).toEqual(['area', 'habit']);
    expect(rankHazardCandidates([
      tied('later', 'repeated_event_area', 11),
      tied('sooner', 'repeated_event_area', 5),
    ]).map((hazard) => hazard.id)).toEqual(['sooner', 'later']);
  });

  it('reports what it knows so a quiet drive can be explained', () => {
    const result = run(snapshotOf({ zones: [zoneAt('behind', 270, 150)] }));
    expect(result.diagnostics.knownZones).toBe(1);
    expect(result.diagnostics.reasonCounts).toEqual({ behind: 1 });
    expect(result.diagnostics.corridorLengthM).toBeGreaterThan(0);
  });
});
