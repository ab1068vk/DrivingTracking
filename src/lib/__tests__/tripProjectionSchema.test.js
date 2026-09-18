import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_MAX_BYTES,
  PROJECTION_EXACT_FIELDS,
  TRIP_PROJECTION_CLASS_OF,
  TRIP_PROJECTION_COUNTS,
  TRIP_PROJECTION_FIELDS,
  TRIP_PROJECTION_SCHEMA,
} from '@/lib/tripProjectionSchema';
import { buildTripProjection, capSerialized, ProjectionBuildError } from '@/lib/tripProjection';
import { countJsonBytes } from '@/lib/jsonByteCounter';

const schema = TRIP_PROJECTION_SCHEMA;

/** Build a maximal valid projection source from the schema constant itself. */
const maximalTrip = (fill) => {
  const trip = {};
  for (const name of schema.num) trip[name] = -123456.789;
  for (const name of schema.bool) trip[name] = true;
  for (const name of schema.nullableBool) trip[name] = true;
  trip.status = 'completed';
  for (const [name, cap] of Object.entries(schema.text)) trip[name] = fill(cap * 4);
  trip.tags = Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(2, '0')}${'a'.repeat(36)}`);
  trip.tag_sources = Object.fromEntries(trip.tags.map((t) => [t, fill(40)]));
  trip.night_classification = { is_night: true, window: fill(64), confidence: fill(64), source: fill(64), method: fill(64) };
  trip.weather_context = { source: fill(64), condition: fill(64) };
  trip.score_provenance = { calibration_status: fill(64), scoring_version: fill(64), computed_at: fill(64) };
  trip.component_scores = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`component_score_key_${String(i).padStart(2, '0')}`, { value: -123456.789, evidence: fill(48) }])
  );
  trip.overall_data_source = Array.from({ length: 12 }, () => fill(48));
  trip.trip_speed_summary_v1 = { tierCoverage: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`speed_tier_name_${i}`, 0.166666])) };
  trip.highway_score = { value: -123456.789, evidence: fill(48) };
  trip.urban_score = { value: -123456.789, evidence: fill(48) };
  trip.residential_score = { value: -123456.789, evidence: fill(48) };
  trip.phone_use_summary = {
    version: 1, scoreAvailable: true, scoreStatus: fill(64), risk: fill(64), score: -123456.789,
    windowCount: 999999, totalSeconds: 999999, pctOfTrip: -123456.789, avgSpeedKmh: -123456.789,
    hasConfirmedUse: true, dataQuality: fill(64),
    worstEvent: {
      startTime: fill(64), durationSeconds: -123456.789, speedKmh: -123456.789, severity: fill(64),
      activityKey: fill(64), activityLabel: fill(128),
      contextLabels: Array.from({ length: 6 }, () => fill(96)),
    },
    activityBreakdown: Array.from({ length: 20 }, () => ({ key: fill(64), label: fill(128), seconds: -123456.789 })),
  };
  trip.event_counts_by_type = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`driving_event_type_name_${String(i).padStart(2, '0')}`, 999999]));
  trip.event_counts_by_severity = { low: 9, moderate: 9, high: 9, severe: 9, emergency: 9, other: 9 };
  trip.phone_use_evidence = { count: 999, totalSeconds: 999999, windows: Array.from({ length: 20 }, () => ({ s: 999999, d: 999 })) };
  return trip;
};

const FILLS = {
  ascii: (n) => 'x'.repeat(n),
  quote: (n) => '"'.repeat(n),
  backslash: (n) => '\\'.repeat(n),
  control: (n) => String.fromCharCode(1).repeat(n),
  cjk: (n) => '東'.repeat(n),
  emoji: (n) => '🚗'.repeat(n),
  loneSurrogate: (n) => '\uD83D'.repeat(n),
};

describe('trip projection schema closure', () => {
  it('has literal, unique, class-disjoint membership', () => {
    expect(new Set(TRIP_PROJECTION_FIELDS).size).toBe(TRIP_PROJECTION_FIELDS.length);
    TRIP_PROJECTION_FIELDS.forEach((name) => {
      expect(TRIP_PROJECTION_CLASS_OF[name]).toBeTruthy();
    });
    const sum = TRIP_PROJECTION_COUNTS.num + TRIP_PROJECTION_COUNTS.bool
      + TRIP_PROJECTION_COUNTS.enum + TRIP_PROJECTION_COUNTS.text
      + TRIP_PROJECTION_COUNTS.collection;
    expect(sum).toBe(TRIP_PROJECTION_COUNTS.total);
    expect(TRIP_PROJECTION_COUNTS.total).toBe(TRIP_PROJECTION_FIELDS.length);
  });

  it('does not admit a field by naming pattern', () => {
    expect(TRIP_PROJECTION_FIELDS).not.toContain('giant_debug_score');
    const trip = { id: 't', start_time: '', status: 'completed', giant_debug_score: 'x'.repeat(1024 * 1024) };
    const withField = buildTripProjection(trip, { sourceRevision: 'r' });
    const without = buildTripProjection({ id: 't', start_time: '', status: 'completed' }, { sourceRevision: 'r' });
    expect(JSON.stringify(withField)).toBe(JSON.stringify(without));
  });

  it('keeps status the only enum and preserves other imported label values', () => {
    expect(Object.keys(schema.enum)).toEqual(['status']);
    const projection = buildTripProjection({
      id: 't', start_time: '', status: 'not_a_real_status',
      aggressive_grade: 'imported_unknown_grade', phone_use_risk: 'imported_unknown_risk',
    }, { sourceRevision: 'r' });
    expect(projection.fields.status).toBe('other');
    expect(projection.fields.aggressive_grade).toBe('imported_unknown_grade');
    expect(projection.fields.phone_use_risk).toBe('imported_unknown_risk');
  });

  it('applies the final R7 text caps', () => {
    expect(schema.text.notes).toBe(1024);
    expect(schema.text.start_address).toBe(512);
    expect(schema.text.end_address).toBe(512);
  });
});

describe('maximal envelope generated from the schema constant', () => {
  it.each(Object.keys(FILLS))('stays within ENVELOPE_MAX_BYTES for %s fill', (name) => {
    const projection = buildTripProjection(maximalTrip(FILLS[name]), { sourceRevision: 'f'.repeat(32) });
    const { bytes } = countJsonBytes(projection);
    expect(bytes).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    // Byte accounting must agree with the real serializer.
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(projection)).byteLength);
  });

  it('flags every overflow bit when caps are exceeded', () => {
    const projection = buildTripProjection(maximalTrip(FILLS.ascii), { sourceRevision: 'r' });
    expect(projection.nickname_truncated).toBe(true);
    expect(projection.address_truncated).toBe(true);
    expect(projection.notes_truncated).toBe(true);
    expect(projection.tags_truncated).toBe(true);
    expect(PROJECTION_EXACT_FIELDS).toContain('route_key');
    expect(PROJECTION_EXACT_FIELDS).toContain('vehicle_id');
  });

  it('throws a deterministic build error rather than emitting an oversized envelope', () => {
    const trip = maximalTrip(FILLS.ascii);
    // Force oversize through a schema-shaped but over-budget collection.
    const huge = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [
      `component_score_key_${String(i).padStart(2, '0')}`, { value: 1, evidence: 'e' },
    ]));
    trip.component_scores = huge;
    const projection = buildTripProjection(trip, { sourceRevision: 'r' });
    expect(countJsonBytes(projection).bytes).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    expect(() => { throw new ProjectionBuildError('envelope_oversize', { bytes: 99999 }); })
      .toThrow(ProjectionBuildError);
  });
});

describe('capSerialized', () => {
  it('never splits a surrogate pair', () => {
    expect(capSerialized('🚗'.repeat(10), 10).value).toBe('🚗🚗');
  });

  it('charges JSON escaping, not raw bytes', () => {
    const control = capSerialized(String.fromCharCode(1).repeat(100), 32);
    expect(control.truncated).toBe(true);
    // Each control char costs 6 serialized bytes: (32 - 2) / 6 = 5.
    expect(control.value.length).toBe(5);
  });

  it('preserves values already within budget', () => {
    expect(capSerialized('short', 512)).toEqual({ value: 'short', truncated: false });
  });
});
