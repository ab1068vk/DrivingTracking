import { describe, expect, it } from 'vitest';
import {
  BOUNDED_CONSUMER_MANIFEST,
  P7_CONSUMER_LEDGER,
  P7_LEDGER_CAP_LAWS,
  p7ConsumerPaths,
} from '@/lib/tripProjectionConsumers';
import {
  MAX_MISMATCH_PREVIEW,
  P6_READINESS_QUERY_PATHS,
  P7_BROAD_INVENTORY,
  P7_COMPLETENESS,
  P7_CURSOR_REJECTION_MATRIX,
  P7_CURSOR_VERSION,
  P7_EXPLICIT_ONLY_SYMBOLS,
  P7_FROZEN_COUNTS,
  P7_HISTORICAL_REQUIREMENTS,
  P7_MUTATION_INVALIDATION_MATRIX,
  P7_PUBLIC_PAGE_LIMIT,
  P7_QUERY_OUTCOMES,
  P7_QUERY_PATHS,
  P7_QUERY_PATH_CONTRACTS,
  P7_REDUCER_BY_IDENTITY,
  P7_REDUCER_IDENTITIES,
  P7_REVISION_ADVANCE_MECHANISM,
  P7_REVISION_ADVANCING_EVENTS,
  P7_ROUTINE_FORBIDDEN_SYMBOLS,
  P7_OUTPUT_MATRIX,
  P7_SCORE_MIGRATION_SUMMARY_SHAPE,
  P7QueryContractError,
  assertP7PublicLimit,
  p7EnvelopeViolations,
  p7OwnerCapabilityViolations,
  p7ReducerReferenceViolations,
} from '@/lib/tripQueryContracts';

/**
 * P7 Stage 1 — the contracts, the ledger and the semantics are frozen in source
 * before any query implementation.
 *
 * These assertions exist so a Stage 2-10 implementer cannot invent an envelope
 * field, a cursor field, a reducer, a key family, an invalidation rule, a
 * projection field set or a fetch topology. Each sweep is paired with a negative
 * control proving the sweep detects the violation it claims to detect.
 */
describe('P7 Stage 1 — frozen contracts', () => {
  it('records exactly one historical requirement with its four clauses', () => {
    expect(P7_HISTORICAL_REQUIREMENTS).toHaveLength(1);
    const [h01] = P7_HISTORICAL_REQUIREMENTS;
    expect(h01.id).toBe('P7-H01');
    expect(h01.classification).toBe('STILL');
    expect(Object.keys(h01.clauses)).toEqual(['a', 'b', 'c', 'd']);
    // H02-H04 exist only as a removal record; no clause was lost.
    expect(h01.removedIndependentIds).toEqual(['P7-H02', 'P7-H03', 'P7-H04']);
    for (const clause of Object.keys(h01.clauses)) {
      expect(h01.clauseDelivery[clause].musts.length).toBeGreaterThan(0);
      expect(h01.clauseDelivery[clause].validations.length).toBeGreaterThan(0);
    }
  });

  it('keeps the frozen headline accounting', () => {
    expect(P7_FROZEN_COUNTS).toMatchObject({
      historical: 1, still: 1, newRequirements: 8, must: 16, should: 1, validations: 24,
      lifecycleJobs: 0, coordinatorRegistrations: 0, explicitOperations: 0,
      consumers: 30, broadInventory: 10, queryPaths: 10, reducerIdentities: 16,
    });
    expect(Object.keys(P7_QUERY_PATHS)).toHaveLength(P7_FROZEN_COUNTS.queryPaths);
    expect(Object.keys(P7_QUERY_PATH_CONTRACTS)).toHaveLength(P7_FROZEN_COUNTS.queryPaths);
    expect(P7_REDUCER_IDENTITIES).toHaveLength(P7_FROZEN_COUNTS.reducerIdentities);
    expect(P7_BROAD_INVENTORY).toHaveLength(P7_FROZEN_COUNTS.broadInventory);
    expect(P7_BROAD_INVENTORY.filter((e) => e.scope.startsWith('P7-SCOPE')))
      .toHaveLength(P7_FROZEN_COUNTS.broadP7Scope);
    expect(P7_BROAD_INVENTORY.filter((e) => e.scope.startsWith('EXPLICIT')))
      .toHaveLength(P7_FROZEN_COUNTS.broadExplicitClosedOwner);
    // There is no Q11 and no V25+.
    expect(P7_QUERY_PATHS.Q11).toBeUndefined();
  });
});

describe('P7 Stage 1 — generic query envelope (Annex A A1)', () => {
  it('carries P6 readiness on Q4/Q5/Q8/Q9 and nowhere else', () => {
    const carriers = Object.entries(P7_QUERY_OUTCOMES)
      .filter(([, outcome]) => outcome.p6Readiness)
      .map(([path]) => path);
    expect(carriers).toEqual(P6_READINESS_QUERY_PATHS);
  });

  it('never declares a PARTIAL outcome without a real continuation', () => {
    for (const [path, outcome] of Object.entries(P7_QUERY_OUTCOMES)) {
      if (outcome.partialContinuation === null) {
        expect(outcome.partialWhen, `${path} must not describe a PARTIAL case`).toBeNull();
      } else {
        expect(outcome.partialWhen, `${path} PARTIAL needs a stated cause`).toBeTruthy();
      }
    }
  });

  it('rejects the three impossible envelope shapes', () => {
    // PARTIAL without a continuation.
    expect(p7EnvelopeViolations('Q1', {
      data: [], completeness: P7_COMPLETENESS.PARTIAL, continuation: null,
    })).toContain('PARTIAL without a continuation');
    // A path that is never generic PARTIAL.
    expect(p7EnvelopeViolations('Q4', {
      data: {}, completeness: P7_COMPLETENESS.PARTIAL, continuation: 'x',
    })).toContain('Q4 is never generic PARTIAL');
    // An unavailable result that still carries data.
    expect(p7EnvelopeViolations('Q1', {
      data: [], unavailable: { code: 'STORAGE_UNAVAILABLE' },
    })).toContain('unavailable result carries data');
    // A generic path carrying P6 readiness.
    expect(p7EnvelopeViolations('Q1', {
      data: [], completeness: P7_COMPLETENESS.EXACT, continuation: null, p6Readiness: {},
    })).toContain('Q1 must not carry p6Readiness');
    // OWNER_NOT_READY without the verbatim readiness object.
    expect(p7EnvelopeViolations('Q9', {
      unavailable: { code: 'OWNER_NOT_READY' },
    })).toContain('OWNER_NOT_READY without the verbatim p6Readiness object');
  });

  it('accepts the structurally valid shapes', () => {
    expect(p7EnvelopeViolations('Q1', {
      data: [], completeness: P7_COMPLETENESS.EXACT, continuation: null,
    })).toEqual([]);
    expect(p7EnvelopeViolations('Q9', {
      unavailable: { code: 'OWNER_NOT_READY' }, p6Readiness: { domain: 'ANALYTICS', state: 'DIRTY' },
    })).toEqual([]);
  });

  it('validates the public [1,200] page limit instead of clamping it', () => {
    expect(P7_PUBLIC_PAGE_LIMIT).toEqual({ min: 1, max: 200 });
    expect(assertP7PublicLimit(1)).toBe(1);
    expect(assertP7PublicLimit(200)).toBe(200);
    for (const bad of [0, 201, 500, 1.5, '20', null, undefined, NaN, Infinity]) {
      let thrown = null;
      try { assertP7PublicLimit(bad); } catch (error) { thrown = error; }
      expect(thrown, `limit ${String(bad)} must be refused`).toBeInstanceOf(P7QueryContractError);
      expect(thrown.code).toBe('REQUEST_TOO_LARGE');
    }
  });
});

describe('P7 Stage 1 — cursor v2 (Annex A A2)', () => {
  it('is version 2 and refuses a v1 cursor rather than upgrading it', () => {
    expect(P7_CURSOR_VERSION).toBe(2);
    const legacy = P7_CURSOR_REJECTION_MATRIX[0];
    expect(legacy.code).toBe('CURSOR_VERSION_UNSUPPORTED');
    const codes = P7_CURSOR_REJECTION_MATRIX.map((row) => row.code);
    expect(codes).toEqual([
      'CURSOR_VERSION_UNSUPPORTED', 'CURSOR_MALFORMED', 'CURSOR_AUTHORITY_MISMATCH',
      'CURSOR_QUERY_MISMATCH', 'CURSOR_RESTART_REQUIRED', 'CURSOR_RESTART_REQUIRED',
    ]);
  });

  it('assigns every row-set-relevant mutation an advance mechanism', () => {
    for (const event of P7_REVISION_ADVANCING_EVENTS) {
      expect(['atomic', 'epoch']).toContain(P7_REVISION_ADVANCE_MECHANISM[event]);
    }
    expect(Object.keys(P7_REVISION_ADVANCE_MECHANISM).sort())
      .toEqual([...P7_REVISION_ADVANCING_EVENTS].sort());
  });
});

describe('P7 Stage 1 — Q10 reducer registry (Annex A A3)', () => {
  it('declares exactly the sixteen approved identities, each with a fixed-size accumulator and output', () => {
    expect(P7_REDUCER_IDENTITIES).toEqual([
      'p7.report.eventTotals@1', 'p7.report.durationDistance@1', 'p7.report.nightExposure@1',
      'p7.report.economics@1', 'p7.report.bucketProfiles@1', 'p7.report.fatigue@1',
      'p7.report.dailySeries@1', 'p7.report.monthlyEventTrend@1', 'p7.report.summaryExtrema@1',
      'p7.report.scoreTipTotals@1', 'p7.ubi.terms@1', 'p7.progression.lifetimeStats@1',
      'p7.progression.records@1', 'p7.settings.scoreMigrationSummary@1',
      'p7.dashboard.activityStats@1', 'p7.history.filteredTotals@1',
    ]);
    for (const entry of Object.values(P7_REDUCER_BY_IDENTITY)) {
      expect(entry.output.length, `${entry.identity} declares no output`).toBeGreaterThan(0);
      expect(Object.isFrozen(entry.accumulator)).toBe(true);
    }
  });

  it('keeps the two clean-trip predicates separate and never interchangeable', () => {
    const events = P7_REDUCER_BY_IDENTITY['p7.report.eventTotals@1'];
    expect(events.output).toContain('clean_trip_count');
    expect(events.output).toContain('report_clean_trip_count');
    // O66's denominator is this reducer's own folded-row count, not trip_count.
    expect(events.output).toContain('completed_count');
    expect(events.output).not.toContain('trip_count');
    expect(P7_REDUCER_BY_IDENTITY['p7.report.durationDistance@1'].output).toContain('trip_count');
  });

  it('freezes the bounded B9 output shape at a 4-item preview', () => {
    expect(MAX_MISMATCH_PREVIEW).toBe(4);
    expect(P7_SCORE_MIGRATION_SUMMARY_SHAPE.previewCapacity).toBe(4);
    expect(P7_SCORE_MIGRATION_SUMMARY_SHAPE.previewItemFields)
      .toEqual(['id', 'start_time', 'nickname', 'scoring_version']);
    // The unbounded `trips` array is replaced, not carried.
    expect(P7_SCORE_MIGRATION_SUMMARY_SHAPE.scalars).not.toContain('trips');
    expect(P7_SCORE_MIGRATION_SUMMARY_SHAPE.hasUnknownLegacyUnrescored).toMatch(/boolean/);
  });
});

describe('P7 Stage 1 — invalidation matrix (Annex A A4.3)', () => {
  it('invalidates nothing when a detail is opened', () => {
    expect(Object.values(P7_MUTATION_INVALIDATION_MATRIX.open_detail))
      .toEqual(Array(9).fill('none'));
  });

  it('invalidates every semantically affected family on edit and delete', () => {
    for (const event of ['status_change', 'ordering_key_edit', 'delete', 'import', 'restore']) {
      const row = P7_MUTATION_INVALIDATION_MATRIX[event];
      expect(row.history, `${event} must reset history cursors`).toBe('invalidate+reset');
      expect(row.reduce, `${event} must reset Q10 accumulators`).toBe('reset');
      for (const family of ['page', 'aggregate', 'buckets', 'geometry', 'achievements']) {
        expect(row[family], `${event}.${family}`).not.toBe('none');
      }
    }
  });
});

describe('P7 Stage 1 — per-output semantics (Annex C C5.4 sweeps)', () => {
  it('binds every output row to an owner that can express its population', () => {
    expect(p7OwnerCapabilityViolations()).toEqual([]);
  });

  it('detects a P-DRIVER row wired to an aggregate owner (negative control)', () => {
    const planted = [{
      id: 'SYNTHETIC', population: 'P-DRIVER',
      browserSource: 'B-D1 completedCount', nativeSource: 'N-BKT range',
      qGraph: ['Q4'], reducers: [],
    }];
    const violations = p7OwnerCapabilityViolations(planted);
    expect(violations).toContain('SYNTHETIC: P-DRIVER row names B-D1');
    expect(violations).toContain('SYNTHETIC: P-DRIVER row names Q4');
  });

  it('detects an N-TOT row presented as an exact P-COMPLETED source (negative control)', () => {
    const planted = [{
      id: 'SYNTHETIC', population: 'P-COMPLETED',
      browserSource: '', nativeSource: 'N-TOT live_count', qGraph: ['Q4'], reducers: [],
    }];
    expect(p7OwnerCapabilityViolations(planted))
      .toContain('SYNTHETIC: P-COMPLETED row names N-TOT');
  });

  it('references only declared reducers and declared terms', () => {
    expect(p7ReducerReferenceViolations()).toEqual([]);
  });

  it('detects an undeclared reducer reference (negative control)', () => {
    const planted = [{
      id: 'SYNTHETIC', population: 'P-DRIVER',
      browserSource: 'R:p7.report.madeUp@1', nativeSource: '', qGraph: ['Q10'],
      reducers: ['p7.report.madeUp@1'],
    }];
    expect(p7ReducerReferenceViolations(planted))
      .toContain('SYNTHETIC: undeclared reducer p7.report.madeUp@1');
  });

  it('covers every enumerated output row exactly once', () => {
    const ids = P7_OUTPUT_MATRIX.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    // O01-O38 (less the three conformance rules O39-O41), O42-O61 and O62-O75.
    expect(ids).toContain('O01');
    expect(ids).toContain('O61');
    expect(ids).toContain('O75');
    expect(ids).not.toContain('O39');
    expect(ids).toHaveLength(72);
  });
});

describe('P7 Stage 1 — authoritative consumer ledger (Annex B)', () => {
  it('holds exactly 30 unique production consumers', () => {
    expect(P7_CONSUMER_LEDGER).toHaveLength(30);
    expect(new Set(P7_CONSUMER_LEDGER.map((e) => e.consumer)).size).toBe(30);
    expect(new Set(P7_CONSUMER_LEDGER.map((e) => e.n)).size).toBe(30);
    expect(p7ConsumerPaths()).toHaveLength(30);
    const pages = P7_CONSUMER_LEDGER.filter((e) => e.consumer.startsWith('src/pages/'));
    expect(pages).toHaveLength(25);
  });

  it('populates every mandatory ledger field for every entry', () => {
    for (const item of P7_CONSUMER_LEDGER) {
      expect(item.compositionKey, `#${item.n}`).toBeTruthy();
      expect(item.qGraph.length, `#${item.n} Q graph`).toBeGreaterThan(0);
      expect(item.projection, `#${item.n} projection subrecord`).toBeTruthy();
      expect(item.projection.source, `#${item.n} projection authority`).toBeTruthy();
      expect(item.semantics, `#${item.n} semantics`).toBeTruthy();
      expect(item.invalidation.length, `#${item.n} invalidation`).toBeGreaterThan(0);
      expect(item.authority, `#${item.n} authority`).toBe('both');
      expect(item.legacy, `#${item.n} legacy state`).toBeTruthy();
      for (const cap of ['detail', 'overview', 'd2', 'secondary', 'cold', 'refetch']) {
        expect(item.caps[cap], `#${item.n} cap ${cap}`).toBeDefined();
      }
    }
    // No entry may be left saying `unchanged`, and no field authority deferred.
    const text = JSON.stringify(P7_CONSUMER_LEDGER);
    expect(text).not.toMatch(/author in Stage 1|authored in Stage 1|decide in Stage 1/);
    expect(P7_CONSUMER_LEDGER.some((e) => e.caps.cold === 'unchanged')).toBe(false);
  });

  it('retains the P3 projection subrecord for the eleven manifest members', () => {
    const inherited = P7_CONSUMER_LEDGER
      .filter((e) => e.projection.source === 'BOUNDED_CONSUMER_MANIFEST')
      .map((e) => e.projection.page)
      .sort();
    const manifestPages = BOUNDED_CONSUMER_MANIFEST.map((e) => e.page).sort();
    expect(inherited).toEqual(manifestPages);
    expect(inherited).toHaveLength(11);
  });

  it('freezes a required-field set for every consumer that renders rows', () => {
    const rowConsumers = P7_CONSUMER_LEDGER.filter((e) => (
      e.projection.source.startsWith('B6.')
      && !e.projection.detailOnly
      // #8 and #18 are aggregate/reducer-only: they hold no trip array at all.
      && !['B6.2', 'B6.8'].includes(e.projection.source)
    ));
    for (const item of rowConsumers) {
      expect(item.projection.requiredFields.length, `#${item.n} field set`).toBeGreaterThan(0);
      expect(item.projection.requiredFields).toContain('id');
    }
  });

  it('keeps every list/picker consumer at zero full-trip decrypts', () => {
    expect(P7_LEDGER_CAP_LAWS[0]).toMatch(/fullTripDecrypts = 0/);
    // Speed / map / risk surfaces read geometry only through Q8.
    for (const n of [6, 11, 14, 26, 27]) {
      const item = P7_CONSUMER_LEDGER.find((e) => e.n === n);
      expect(item.qGraph.some((step) => step.startsWith('Q8')), `#${n} must use Q8`).toBe(true);
    }
    // The console and the risk panel decrypt no full trip at all.
    for (const n of [26, 27, 18]) {
      expect(String(P7_CONSUMER_LEDGER.find((e) => e.n === n).caps.detail)).toMatch(/^0/);
    }
  });

  it('records the frozen broad inventory and its symbol classes', () => {
    expect(P7_BROAD_INVENTORY.map((e) => e.id))
      .toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10']);
    expect(P7_ROUTINE_FORBIDDEN_SYMBOLS).toContain('getScoreMigrationSummary');
    expect(P7_ROUTINE_FORBIDDEN_SYMBOLS).toContain('listForSpeedMap');
    expect(P7_EXPLICIT_ONLY_SYMBOLS)
      .toEqual(['listAllForExport', 'eraseAll', 'rescoreCompletedTrips']);
  });
});
