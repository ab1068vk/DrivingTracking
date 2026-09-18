import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { P7_BROAD_INVENTORY, P7_REDUCER_REGISTRY } from '@/lib/tripQueryContracts';
import { P7_CONSUMER_LEDGER } from '@/lib/tripProjectionConsumers';
import { P7_REDUCER_IMPLEMENTATIONS } from '@/lib/tripQueryReducers';
import { P7_POPULATION_PREDICATES } from '@/lib/queryReducers/populations';
import { MAX_MISMATCH_PREVIEW, P7_SCORE_MIGRATION_SUMMARY_SHAPE } from '@/lib/queryContracts/reducers';
import { scoreMigrationRatio } from '@/hooks/useScoreMigrationSummary';
import { boundedWindowLabel } from '@/hooks/useBoundedTripWindow';
import {
  EXCLUDE_DEFINITIONS,
  SRC_ROOT,
  findSymbolCallEdges,
  isRoutineEdge,
  withoutComments,
} from './helpers/p7ReleaseAudit';

/**
 * P7 Stage 8 — the remaining consumers.
 *
 * What these five pages had in common was one call: `tripService.list({limit})`.
 * It reads **every trip in the store** through `getAllTrips()`, decrypts each
 * one in full, sorts the whole array in memory, and then slices `limit` rows
 * off the front. The limit described the output and never the work, so a
 * driver with 5 000 trips paid 5 000 full-record decrypts for a page showing
 * 100 rows — and four pages did it on mount.
 */

const source = (relative) => withoutComments(
  readFileSync(path.join(SRC_ROOT, relative), 'utf8')
);

describe('P7-V02 / V22 — the broad reads have no routine caller left', () => {
  it('retires every routine tripService.list caller', () => {
    const edges = findSymbolCallEdges(['tripService.list'], { exclude: EXCLUDE_DEFINITIONS });
    expect(edges.filter(isRoutineEdge)).toEqual([]);
    // And none at all outside a definition site: B5's explicit corridor read
    // was the last one, and Stage 8 replaced it with a bounded Q1 page.
    expect(edges).toEqual([]);
  });

  it('retires the routine score-migration summary (B9)', () => {
    const edges = findSymbolCallEdges(['getScoreMigrationSummary'], { exclude: EXCLUDE_DEFINITIONS });
    expect(edges.filter(isRoutineEdge)).toEqual([]);

    const entry = P7_BROAD_INVENTORY.find((row) => row.id === 'B9');
    expect(entry.scope).toBe('P7-SCOPE-ROUTINE');
  });

  it('keeps the three explicit reads, which Annex B retains', () => {
    // B7 backup export, B8 data-rights erase, B10 user-initiated rescore are
    // *retained*, legal only from their exact intentional user action. Stage 8
    // must not have removed them along with the routine reads.
    for (const symbol of ['listAllForExport', 'eraseAll', 'rescoreCompletedTrips']) {
      const edges = findSymbolCallEdges([symbol], { exclude: EXCLUDE_DEFINITIONS });
      expect(edges.length, symbol).toBeGreaterThan(0);
      expect(edges.every((edge) => !isRoutineEdge(edge)), symbol).toBe(true);
    }
  });
});

describe('P7 Stage 8 — each consumer reads the bounded shape its ledger declares', () => {
  const cases = [
    ['pages/TrackingEvents.jsx', 'src/pages/TrackingEvents.jsx', 1],
    ['pages/TrackingEvidenceConsole.jsx', 'src/pages/TrackingEvidenceConsole.jsx', 1],
    ['pages/TrackingReplayPro.jsx', 'src/pages/TrackingReplayPro.jsx', 2],
  ];

  it.each(cases)('%s reads one bounded Q1 window plus its capped detail', (relative, consumer, detailCap) => {
    const text = source(relative);
    expect(text).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(text).not.toMatch(/tripService\.list\s*\(/);
    expect(text).toContain('useBoundedTripWindow');
    // No fan-out: the detail reads are the selected ones, fixed by UX.
    expect(text).not.toMatch(/useQueries/);

    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === consumer);
    expect(entry.caps.detail).toBe(detailCap);
  });

  it('the replay picker performs zero full-trip decrypts', () => {
    const text = source('pages/TrackingReplayPro.jsx');
    // Availability and the point count come from the projection fields the
    // ledger names, not from a decrypted route.
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TrackingReplayPro.jsx');
    expect(entry.projection.requiredFields).toContain('route_points_map_count');
    expect(entry.projection.requiredFields).toContain('route_replay_available');
    expect(text).not.toMatch(/getFullById/);
  });

  it('a bounded window is labelled as a window, never as everything', () => {
    expect(boundedWindowLabel(50, false)).toBe('latest 50 trips');
    expect(boundedWindowLabel(50, true)).toBe('50 trips');
    expect(boundedWindowLabel(1, true)).toBe('1 trip');
  });
});

describe('P7-O37 — speed coverage is unknown, never zero', () => {
  it('reads coverage from the one D2 batch, and says so when it cannot', () => {
    const text = source('components/speedLimits/SpeedIntelligenceConsole.jsx');
    expect(text).not.toMatch(/tripService\.list\s*\(/);
    expect(text).toContain('mapScreenGeometryQuery');
    expect(text).toContain('coverageKnown');
    expect(text).toContain('Unknown');

    const entry = P7_CONSUMER_LEDGER.find(
      (e) => e.consumer === 'src/components/speedLimits/SpeedIntelligenceConsole.jsx'
    );
    expect(entry.qGraph).toEqual(['Q1 (candidate ids/projections)', 'Q8 D2 by-id batch']);
    expect(entry.caps.detail).toBe(0);
  });

  it('distinguishes a measured zero from an unprepared trip', async () => {
    const { buildTrackingSpeedConsoleData } = await import('@/lib/trackingSpeedConsole');

    const rows = buildTrackingSpeedConsoleData({
      trips: [
        // Covered by the batch: it has preview points, so its coverage is a
        // measurement — including a measurement of zero.
        {
          id: 'covered', status: 'completed', start_time: '2026-05-02T09:00:00.000Z',
          route_points: [{ lat: 51, lng: -0.1 }, { lat: 51.001, lng: -0.1 }],
        },
        // Not covered: the owner has no preview for it. That is not 0%.
        { id: 'unprepared', status: 'completed', start_time: '2026-05-03T09:00:00.000Z', route_points: null },
      ],
      speedKnowledgeData: { cells: {}, corrections: [] },
    }).tripCoverageRows;

    const byId = Object.fromEntries(rows.map((row) => [row.tripId, row]));
    expect(byId.covered.coverageKnown).toBe(true);
    expect(byId.covered.coveragePercent).toEqual(expect.any(Number));

    expect(byId.unprepared.coverageKnown).toBe(false);
    expect(byId.unprepared.coveragePercent).toBeNull();
    // The distinction the row exists to preserve: not a zero.
    expect(byId.unprepared.coveragePercent).not.toBe(0);
  });
});

describe('P7-O61 — the score-migration summary is fixed in size', () => {
  const implementation = P7_REDUCER_IMPLEMENTATIONS['p7.settings.scoreMigrationSummary@1'];

  const fold = (rows, context) => {
    const predicate = P7_POPULATION_PREDICATES[implementation.population];
    return implementation.finish(
      rows.filter((row) => predicate(row, {}))
        .reduce((acc, row) => implementation.fold(acc, row, context), implementation.init(context))
    );
  };

  it('replaces the unbounded trips array with a four-slot preview and a count', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `m-${index}`,
      status: 'completed',
      start_time: new Date(Date.UTC(2026, 4, 1 + index)).toISOString(),
      nickname: `Trip ${index}`,
      score_overall: 70,
      score_version: 'old-version',
      route_replay_available: true,
    }));

    const terms = fold(rows, { scoring_version: 'current-version' });

    expect(terms.mismatch_count).toBe(40);
    // The payload does not grow with the history: forty mismatches, four rows.
    expect(terms.mismatch_preview).toHaveLength(MAX_MISMATCH_PREVIEW);
    expect(MAX_MISMATCH_PREVIEW).toBe(4);
    expect(terms.mismatch_preview[0]).toEqual(expect.objectContaining({
      id: expect.any(String), start_time: expect.any(String),
    }));

    // "+N more" is derived, not carried.
    expect(terms.mismatch_count - terms.mismatch_preview.length).toBe(36);
    expect(Object.keys(terms)).not.toContain('trips');
  });

  it('reports an unknown legacy score as its own fact, not as a mismatch count', () => {
    const terms = fold([
      { id: 'legacy', status: 'completed', start_time: '2026-05-01T09:00:00.000Z', score_version: null, route_replay_available: true },
      { id: 'known', status: 'completed', start_time: '2026-05-02T09:00:00.000Z', score_version: 'old', route_replay_available: true },
    ], { scoring_version: 'current' });

    expect(terms.has_unknown_legacy_unrescored).toBe(true);
    expect(terms.mismatch_count).toBe(2);

    const noLegacy = fold([
      { id: 'known', status: 'completed', start_time: '2026-05-02T09:00:00.000Z', score_version: 'old', route_replay_available: true },
    ], { scoring_version: 'current' });
    expect(noLegacy.has_unknown_legacy_unrescored).toBe(false);
  });

  it('derives the recent ratio, and recommends only from a finished tally', () => {
    const terms = { recent_completed_count: 8, recent_mismatch_count: 6 };
    expect(scoreMigrationRatio(terms)).toBeCloseTo(0.75, 6);
    // No recent rows is not a 100% mismatch ratio.
    expect(scoreMigrationRatio({ recent_completed_count: 0, recent_mismatch_count: 0 })).toBe(0);

    const hook = withoutComments(
      readFileSync(path.join(SRC_ROOT, 'hooks/useScoreMigrationSummary.js'), 'utf8')
    );
    // A partial ratio could cross the threshold on the rows read so far and
    // fall back below it once the rest are counted, so the recommendation is
    // gated on the tally being exact.
    expect(hook).toContain('exact && ratio >');
  });

  it('matches the frozen shape contract, and the page renders it', () => {
    expect(P7_SCORE_MIGRATION_SUMMARY_SHAPE.previewCapacity).toBe(MAX_MISMATCH_PREVIEW);
    expect(P7_SCORE_MIGRATION_SUMMARY_SHAPE.moreCountDerivedFrom)
      .toBe('mismatch_count - mismatch_preview.length');
    expect(P7_REDUCER_REGISTRY.some((e) => e.identity === 'p7.settings.scoreMigrationSummary@1')).toBe(true);

    const settings = source('pages/Settings.jsx');
    expect(settings).not.toMatch(/getScoreMigrationSummary/);
    expect(settings).toContain('useScoreMigrationSummary');
    expect(settings).toContain('mismatch_preview');
    expect(settings).toContain('has_unknown_legacy_unrescored');
    // While PARTIAL the counts read "at least N" and nothing is exact.
    expect(settings).toContain('At least ');
    expect(settings).toContain('so far');
  });
});

describe('P7-O27 — the reports lab holds no trip array at render', () => {
  it('renders from an owner-backed count and streams every export', () => {
    const text = source('pages/TrackingReportsLab.jsx');
    expect(text).not.toMatch(/tripService\.list\s*\(/);
    // No render-time trip array at any size.
    expect(text).toContain('trips: [],');
    expect(text).toContain('lifetimeTripCount');
    // The exports scan explicitly, and refuse a scan short of terminal EOF.
    // HPR-019 retired `collectExportTrips`/`withExportTrips`: they accumulated
    // the whole population as PROJECTION rows and handed those to the evidence
    // builders, which is neither the "explicit bounded id/payload stream" nor the
    // "streams ids -> Q2, one resident" this ledger entry already declared. The
    // replacement is that declared contract, so the pin follows the symbol.
    expect(text).not.toMatch(/collectExportTrips|withExportTrips/);
    expect(text).toContain('streamTripEvidence');
    // The Wave 6 correction moved the walk onto the export read, which prepares
    // the record identically but does not persist that preparation — a writing
    // read would advance the very source identity the coherence check compares.
    expect(text).toContain('tripService.readFullByIdForExport');
    expect(text).toContain('tripService.readQuerySnapshot');
    expect(text).toContain('nothing was exported');
    // A row count only the scan can know is not guessed from a loaded sample.
    expect(text).toContain('Counted on export');

    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TrackingReportsLab.jsx');
    expect(entry.caps.detail).toBe('0 at render');
  });
});
