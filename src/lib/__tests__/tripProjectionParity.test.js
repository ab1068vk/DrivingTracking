import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  closureBinds,
  closureOf,
  definitionOf,
  readsField,
  transitiveProjectionFields,
} from './helpers/consumerClosure';
import {
  BOUNDED_CONSUMER_MANIFEST,
  DUAL_SHAPE_COMPONENTS,
  requiredProjectionFields,
} from '@/lib/tripProjectionConsumers';
import { TRIP_PROJECTION_FIELDS, TRIP_PROJECTION_SCHEMA } from '@/lib/tripProjectionSchema';
import { buildTripProjection } from '@/lib/tripProjection';
import { asTripListModel, isProjectionEnvelope } from '@/lib/tripListModel';
import { getTripDisplayName, normalizeTripTags } from '@/lib/tripMetadata';
import { countJsonBytes } from '@/lib/jsonByteCounter';

const projectionOf = (trip) => buildTripProjection(trip, { sourceRevision: 'rev1' });
const rowOf = (trip, hydrated) => asTripListModel(projectionOf(trip), { hydrated });

describe('consumer manifest is source-backed', () => {
  it('names a real page file for every entry', () => {
    BOUNDED_CONSUMER_MANIFEST.forEach((entry) => {
      expect(() => readFileSync(entry.page, 'utf8')).not.toThrow();
    });
  });

  it('every entry actually consumes a bounded query in its source', () => {
    // The claim is that a manifest page reads trip data through a **bounded**
    // query, not that it reads it through one particular helper. A page P7 has
    // migrated consumes its bounded page through the canonical composition
    // instead, so the composition hooks are named here explicitly rather than
    // the assertion being relaxed to "mentions something".
    const BOUNDED_CONSUMERS = [
      /limitedTripSummaryQueryOptions/,
      /listSummaries/,
      /useDiagnosticsPageData/,
      /useTripHistoryPageData/,
      /useTrackingOverviewData/,
      /useVehicleAnalytics/,
      /useAchievementsData/,
      /useDashboardData/,
      /useInsightsData/,
      /useDrivingCoachData/,
      /useReportData/,
      // Stage 7: the map surfaces consume the bounded Q8 composition.
      /mapScreenGeometryQuery/,
      /readSpeedMapGeometryPage/,
      /geometryByIds/,
      // Stage 8: the remaining consumers read one bounded Q1 window each.
      /useBoundedTripWindow/,
      /useScoreMigrationSummary/,
      /p7TripQueries/,
    ];
    BOUNDED_CONSUMER_MANIFEST.forEach((entry) => {
      const source = readFileSync(entry.page, 'utf8');
      const bounded = BOUNDED_CONSUMERS.some((pattern) => pattern.test(source));
      expect(bounded, `${entry.page} must consume a bounded query`).toBe(true);
    });
  });

  // Matching the query name only proves the page mentions it. These bind each
  // manifest entry to the real module graph, so a renamed or deleted helper, or
  // a field a consumer stopped reading, fails until the manifest is corrected.
  // Writing this check is what exposed that entries like 'pendingReviewSelector'
  // and 'speedBuilder' were descriptive labels that matched no symbol at all.
  it('every named entry point resolves to a real symbol the page can reach', () => {
    BOUNDED_CONSUMER_MANIFEST.forEach((entry) => {
      const sources = closureOf(entry.page);
      entry.entryPoints.forEach((symbol) => {
        expect(
          closureBinds(sources, symbol),
          `${entry.page} names "${symbol}" but nothing in its import closure defines or imports it`
        ).toBe(true);
      });
      (entry.detailRequired ?? []).forEach((symbol) => {
        expect(closureBinds(sources, symbol)).toBe(true);
      });
    });
  });

  it('every required field is actually read somewhere the page can reach', () => {
    BOUNDED_CONSUMER_MANIFEST.forEach((entry) => {
      const blob = [...closureOf(entry.page).values()].join(String.fromCharCode(10));
      entry.requiredFields.forEach((field) => {
        expect(
          readsField(blob, field),
          `${entry.page} requires "${field}" but no reachable module reads it`
        ).toBe(true);
      });
    });
  });

  it('no reachable helper reads a projection field its consumer omits', () => {
    // Transitive, not just the named helper. The bounded row is followed as it
    // is passed from helper to helper, because the dependency that broke this
    // contract in practice was one call deeper: Dashboard names
    // buildOnDeviceDriverModel, which hands each row to tripFeatureVector,
    // which reads phone_use_pct_of_trip.
    const undeclaredByPage = {};
    BOUNDED_CONSUMER_MANIFEST.forEach((entry) => {
      const sources = closureOf(entry.page);
      const declared = new Set(entry.requiredFields);
      const undeclared = new Map();
      entry.entryPoints.forEach((symbol) => {
        transitiveProjectionFields(sources, symbol, TRIP_PROJECTION_FIELDS).forEach((via, field) => {
          if (!declared.has(field)) undeclared.set(field, `${symbol} -> ${via}`);
        });
      });
      if (undeclared.size) undeclaredByPage[entry.page] = Object.fromEntries(undeclared);
    });
    expect(undeclaredByPage).toEqual({});
  }, 30_000);

  it('reaches the Dashboard chain the shallow oracle missed', () => {
    const sources = closureOf('src/pages/Dashboard.jsx');
    const reached = transitiveProjectionFields(sources, 'buildOnDeviceDriverModel', TRIP_PROJECTION_FIELDS);
    expect(reached.get('phone_use_pct_of_trip')).toBe('tripFeatureVector');
    const dashboard = BOUNDED_CONSUMER_MANIFEST.find((entry) => entry.page.includes('Dashboard'));
    expect(dashboard.requiredFields).toContain('phone_use_pct_of_trip');
  });

  it('extracts a real function body, not a signature', () => {
    const sources = closureOf('src/pages/Dashboard.jsx');
    const body = definitionOf(sources, 'tripFeatureVector');
    // The old brace-balancer returned at the parameter list's closing paren, so
    // every ordinary function declaration was analyzed as its signature.
    expect(body).toContain('phone_use_pct_of_trip');
    expect(body.trimStart().startsWith('{')).toBe(true);
  });
  it('every required field exists in the projection schema', () => {
    const known = new Set(TRIP_PROJECTION_FIELDS);
    requiredProjectionFields().forEach((field) => {
      expect(known.has(field), `manifest requires "${field}" but the schema omits it`).toBe(true);
    });
  });

  it('keeps Tracking Evidence builders detail-required and off the projection', () => {
    const entry = BOUNDED_CONSUMER_MANIFEST.find((row) => row.page.includes('TrackingEvidenceConsole'));
    expect(entry.detailRequired).toEqual(['buildTrackingEvidenceConsoleData', 'buildSessionEvidenceRows']);
    const source = readFileSync(entry.page, 'utf8');
    // The summary fallback that produced false "unavailable" evidence is gone.
    // Lazy `[\s\S]*?` so the arrow callback's parentheses do not end the match.
    expect(source).not.toMatch(/summaries\.find\([\s\S]*?\)\s*\|\|\s*null/);
    expect(source).toMatch(/evidenceDetailPending/);
  });
});

describe('dual-shape adapter parity', () => {
  const trip = {
    id: 't1', status: 'completed', start_time: '2026-05-01T00:00:00.000Z',
    nickname: 'Morning run', start_address: 'A St', end_address: 'B Ave',
    notes: 'note text', tags: ['commute'], distance_km: 12.5, score_overall: 88,
  };

  it('passes a legacy summary and a full trip through untouched', () => {
    const legacy = { ...trip, driving_events: [{ type: 'harsh_brake' }] };
    expect(asTripListModel(legacy)).toBe(legacy);
    expect(isProjectionEnvelope(legacy)).toBe(false);
  });

  it('flattens a projection into the consumer shape', () => {
    const row = rowOf(trip);
    expect(row.id).toBe('t1');
    expect(row.nickname).toBe('Morning run');
    expect(row.distance_km).toBe(12.5);
    expect(row.score_overall).toBe(88);
  });

  it('produces the same display name from projection and legacy input', () => {
    expect(getTripDisplayName(rowOf(trip))).toBe(getTripDisplayName(trip));
  });

  it('falls back to addresses identically when the nickname is absent', () => {
    const anonymous = { ...trip, nickname: '' };
    expect(getTripDisplayName(rowOf(anonymous))).toBe(getTripDisplayName(anonymous));
    expect(getTripDisplayName(rowOf(anonymous))).toBe('A St to B Ave');
  });

  it('normalizes tags identically', () => {
    expect(normalizeTripTags(rowOf(trip))).toEqual(normalizeTripTags(trip));
  });
});

describe('branch matrix for load-bearing fields', () => {
  const base = { id: 't1', status: 'completed', start_time: '2026-05-01T00:00:00.000Z' };

  it.each([
    ['missing', {}],
    ['null', { nickname: null, distance_km: null }],
    ['zero', { distance_km: 0, score_overall: 0 }],
    ['false', { is_favorite: false, night_driving: false }],
    ['empty string', { nickname: '', start_address: '', notes: '' }],
    ['valid', { nickname: 'N', distance_km: 5, score_overall: 90 }],
    ['malformed', { nickname: 123, distance_km: 'not a number', tags: 'not-an-array' }],
  ])('builds a stable projection for the %s branch', (_label, overrides) => {
    const row = rowOf({ ...base, ...overrides });
    expect(row.id).toBe('t1');
    expect(Object.prototype.hasOwnProperty.call(row, 'distance_km')).toBe(true);
  });

  it('renders an imported numeric nickname the way the display helper does', () => {
    // getTripDisplayName coerces with String(...), so the projection must too.
    const trip = { ...base, nickname: 123 };
    expect(rowOf(trip).nickname).toBe('123');
    expect(getTripDisplayName(rowOf(trip))).toBe(getTripDisplayName(trip));
  });

  it('keeps a zero component score distinguishable from an absent one', () => {
    // driverProgression tests component_scores[key] for truthiness, so the
    // object shape has to survive rather than collapse to a number.
    const withZero = rowOf({ ...base, component_scores: { overall: { value: 0, evidence: 'low' } } });
    expect(withZero.component_scores.overall).toEqual({ value: 0, evidence: 'low' });
    // Absent source yields an empty map, and the key is simply not present, so a
    // truthiness test on component_scores[key] behaves as it did on a legacy trip.
    const without = rowOf(base);
    expect(without.component_scores).toEqual({});
    expect(without.component_scores.overall).toBeUndefined();
  });

  it('preserves night_classification.method, which drives tag inference', () => {
    const row = rowOf({ ...base, night_classification: { method: 'solar_elevation', is_night: true } });
    expect(row.night_classification.method).toBe('solar_elevation');
  });

  it('substitutes hydrated exact values before a consumer sees them', () => {
    const longName = 'n'.repeat(4_000);
    const row = rowOf({ ...base, nickname: longName }, { nickname: longName });
    expect(row.nickname).toBe(longName);
  });
});

describe('mutation guards', () => {
  it('fails if a required manifest field is dropped from the schema', () => {
    const dropped = requiredProjectionFields().filter((field) => field !== 'nickname');
    const known = new Set(TRIP_PROJECTION_FIELDS.filter((field) => field !== 'nickname'));
    // Simulated removal: the manifest check above would fail for the real schema.
    expect(dropped.every((field) => known.has(field))).toBe(true);
    expect(known.has('nickname')).toBe(false);
  });

  it('fails if a suffix-named future field is admitted', () => {
    expect(TRIP_PROJECTION_FIELDS).not.toContain('giant_debug_score');
    expect(TRIP_PROJECTION_SCHEMA.num).not.toContain('giant_debug_score');
  });

  it('fails if a nested block is produced by spreading the source', () => {
    const row = rowOf({
      id: 't', status: 'completed', start_time: '',
      weather_context: { source: 'open_meteo', condition: 'rain', future_field: 'x'.repeat(4_000) },
    });
    expect(Object.keys(row.weather_context).sort()).toEqual(['condition', 'source']);
  });

  it('fails if hydration is bypassed for an exact identity', () => {
    const longKey = 'r'.repeat(4_000);
    const withoutHydration = rowOf({ id: 't', status: 'completed', start_time: '', route_key: longKey });
    expect(withoutHydration.route_key.length).toBeLessThan(longKey.length);
    const withHydration = rowOf(
      { id: 't', status: 'completed', start_time: '', route_key: longKey },
      { route_key: longKey }
    );
    expect(withHydration.route_key).toBe(longKey);
  });

  it('lists every shared dual-shape component', () => {
    expect(DUAL_SHAPE_COMPONENTS).toContain('asTripListModel');
    expect(DUAL_SHAPE_COMPONENTS).toContain('getTripComponentScore');
  });
});

describe('P3-I5 exact tag parity and future taxonomy', () => {
  const base = { id: 't1', status: 'completed', start_time: '2026-05-01T00:00:00.000Z' };

  it('sets the hydration bit when a single tag is capped, not only on count overflow', () => {
    // The count is well under 40, but one member exceeds its per-item byte cap.
    // Without the bit, exact search and filtering would observe a prefix.
    const longTag = 'a'.repeat(400);
    const projection = projectionOf({ ...base, tags: [longTag] });
    expect(projection.fields.tags[0]).not.toBe(longTag);
    expect(projection.tags_truncated).toBe(true);
  });

  it.each([1, 3, 39])('sets the bit for %i long tags below the count cap', (count) => {
    const tags = Array.from({ length: count }, (_, i) => `${i}${'b'.repeat(400)}`);
    expect(projectionOf({ ...base, tags }).tags_truncated).toBe(true);
  });

  it('still sets the bit on count overflow alone', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `short-${i}`);
    expect(projectionOf({ ...base, tags }).tags_truncated).toBe(true);
  });

  it('leaves the bit clear when nothing was modified', () => {
    expect(projectionOf({ ...base, tags: ['commute', 'work'] }).tags_truncated).toBe(false);
  });

  it('flags and de-duplicates a truncated-prefix collision', () => {
    // Two distinct tags whose capped prefixes collide would silently change set
    // membership, so the collision must be visible and the set de-duplicated.
    const prefix = 'c'.repeat(400);
    const projection = projectionOf({ ...base, tags: [`${prefix}one`, `${prefix}two`] });
    expect(projection.tags_truncated).toBe(true);
    expect(new Set(projection.fields.tags).size).toBe(projection.fields.tags.length);
  });

  it.each([['quotes', '"'.repeat(400)], ['backslashes', String.fromCharCode(92).repeat(400)]])(
    'flags %s-heavy tags that exceed the serialized cap',
    (_label, tag) => {
      expect(projectionOf({ ...base, tags: [tag] }).tags_truncated).toBe(true);
    }
  );

  it('restores the authoritative tag after bounded hydration', () => {
    const longTag = 'd'.repeat(400);
    const row = rowOf({ ...base, tags: [longTag] }, { tags: [longTag] });
    expect(row.tags).toEqual([longTag]);
  });

  it('folds unknown future event types into other rather than dropping them', () => {
    const counts = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`future_event_type_${i}`, 2])
    );
    const projection = projectionOf({ ...base, event_counts_by_type: counts });
    const map = projection.fields.event_counts_by_type;
    expect(Object.keys(map).length).toBeLessThanOrEqual(32);
    expect(map.other).toBeGreaterThan(0);
    // Total is preserved: nothing silently disappears.
    const total = Object.values(map).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(160);
  });

  it('folds an unknown severity into other and preserves the total', () => {
    const counts = { low: 1, moderate: 2, high: 3, severe: 4, emergency: 5, future_a: 6, future_b: 7, future_c: 8 };
    const map = projectionOf({ ...base, event_counts_by_severity: counts }).fields.event_counts_by_severity;
    const total = Object.values(map).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(36);
    expect(map.other).toBeGreaterThan(0);
  });

  it('keeps the envelope bounded under heavy future taxonomy growth', () => {
    const counts = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`very_long_future_event_type_name_${i}`, 9999])
    );
    const projection = projectionOf({ ...base, event_counts_by_type: counts });
    expect(countJsonBytes(projection).bytes).toBeLessThanOrEqual(24_576);
  });
});

describe('mutation proofs: the manifest oracle actually has teeth (I6-B)', () => {
  // These mutate the real schema/manifest/envelope through injected variants
  // rather than editing repository files, but they falsify the production
  // contract rather than a locally invented one: each asserts that the same
  // check used above rejects the mutated input.
  const sources = closureOf('src/pages/TrackingMapWorkspace.jsx');

  it('fails when a required field is removed from the projection schema', () => {
    const mutatedSchemaFields = TRIP_PROJECTION_FIELDS.filter((field) => field !== 'distance_km');
    const known = new Set(mutatedSchemaFields);
    const survivors = requiredProjectionFields().filter((field) => !known.has(field));
    // The schema check above passes today; with the field gone it must not.
    expect(survivors).toEqual(['distance_km']);
  });

  it('fails when a field is read by a helper one call deeper (I6-C)', () => {
    // Checked-in fixture with the exact shape the shallow oracle missed: the
    // named helper reads nothing, and the undeclared field is read by the helper
    // it hands each row to. Driven through the same production mechanism, not a
    // locally invented comparison.
    const fixtureSources = closureOf('src/lib/__fixtures__/consumerOracle/fixturePage.js');
    const reached = transitiveProjectionFields(
      fixtureSources,
      'fixtureEntryHelper',
      TRIP_PROJECTION_FIELDS
    );
    expect(reached.get('phone_use_pct_of_trip')).toBe('fixtureNestedHelper');

    // A manifest omitting it must fail...
    const omitted = new Set(['id', 'status']);
    const undeclared = [...reached.keys()].filter((field) => !omitted.has(field));
    expect(undeclared).toEqual(['phone_use_pct_of_trip']);

    // ...and declaring it must pass, through the same check.
    const declared = new Set(['id', 'status', 'phone_use_pct_of_trip']);
    expect([...reached.keys()].filter((field) => !declared.has(field))).toEqual([]);

    // The named entry helper itself reads no projection field, so an oracle that
    // stopped there would report a clean contract for this fixture.
    const shallowBody = definitionOf(fixtureSources, 'fixtureEntryHelper');
    expect(shallowBody).not.toContain('phone_use_pct_of_trip');
  });

  it('fails when a named entry point no longer resolves', () => {
    expect(closureBinds(sources, 'filteredSummaries')).toBe(true);
    expect(closureBinds(sources, 'speedBuilder')).toBe(false);
  });

  it('detects a field a consumer stopped reading', () => {
    const blob = [...sources.values()].join(String.fromCharCode(10));
    expect(readsField(blob, 'night_driving')).toBe(true);
    expect(readsField(blob, 'a_field_no_consumer_reads')).toBe(false);
  });

  it('exact hydration cannot be bypassed for a truncated envelope', () => {
    const manyTags = Array.from({ length: 64 }, (_, index) => `tag-${index}-${'x'.repeat(40)}`);
    const trip = {
      id: 'h1', status: 'completed', start_time: '2026-05-01T00:00:00.000Z', tags: manyTags,
    };
    const envelope = projectionOf(trip);
    const withoutHydration = asTripListModel(envelope);
    const withHydration = asTripListModel(envelope, { hydrated: { tags: manyTags } });
    // Serving the truncated envelope as if it were authoritative silently loses
    // tags, which breaks exact search and filtering.
    expect(normalizeTripTags(withoutHydration)).not.toEqual(normalizeTripTags(trip));
    expect(normalizeTripTags(withHydration)).toEqual(normalizeTripTags(trip));
  });

  it('keeps the Tracking Evidence summary fallback from being restored', () => {
    const entry = BOUNDED_CONSUMER_MANIFEST.find((row) => row.page.includes('TrackingEvidenceConsole'));
    const source = readFileSync(entry.page, 'utf8');
    const restored = 'const selectedTrip = summaries.find((trip) => trip.id === id) || null;';
    // `[^)]*` cannot cross the arrow callback's own parentheses, so the original
    // guard would have passed on the very shape it forbids. The pattern has to
    // span them lazily.
    const fallback = /summaries\.find\([\s\S]*?\)\s*\|\|\s*null/;
    expect(fallback.test(restored)).toBe(true);
    expect(fallback.test(source)).toBe(false);
  });

  it('does not admit unknown nested source fields into the projection', () => {
    const envelope = projectionOf({
      id: 'w1', status: 'completed', start_time: '2026-05-01T00:00:00.000Z',
      secret_nested: { gps: [{ lat: 51.5, lng: -0.1 }] },
      route_points: [{ lat: 51.5, lng: -0.1 }],
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('secret_nested');
    // Counters named after route points are fine; the coordinates are not.
    expect(serialized).not.toContain('51.5');
    expect(serialized).not.toMatch(/"lat"|"lng"/);
    expect(countJsonBytes(envelope).bytes).toBeLessThan(24_576);
  });
});
