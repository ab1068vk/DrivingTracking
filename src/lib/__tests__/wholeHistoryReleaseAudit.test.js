import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_WORK_EXTENTS,
  APP_WORK_TRIGGER_ORIGINS,
  createLifecycleWorkRegistrationBoundary,
  getP4LifecycleRegistrations,
} from '@/lib/appLifecycleWork';
import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';
import { P7_BROAD_INVENTORY, P7_EXPLICIT_ONLY_SYMBOLS, P7_ROUTINE_FORBIDDEN_SYMBOLS } from '@/lib/tripQueryContracts';
import { P7_CONSUMER_LEDGER, p7ConsumerPaths } from '@/lib/tripProjectionConsumers';
import {
  CALLER_CONTEXT,
  EXCLUDE_DEFINITIONS,
  findDuplicateHistoryAcquisitions,
  findSymbolCallEdges,
  findUndeclaredConsumerFiles,
  isRoutineEdge,
  productionSourceFiles,
} from './helpers/p7ReleaseAudit';

/**
 * P3.5 whole-history release audit.
 *
 * Every production path that could materialize the complete trip history or
 * the complete saved-road model is enumerated here and classified. The release
 * gate is that **category C is empty**: no Android/native feature path may
 * depend on an unbounded query.
 *
 * This is a source audit on purpose. A runtime assertion only fires on the
 * paths a test happens to exercise; a source sweep catches a reintroduced
 * `listAll()` in a feature nobody wrote a test for.
 *
 *   A — explicit browser/dev/test backend only (native never reaches it)
 *   B — explicit bounded streamed job (paged, one payload at a time)
 *   C — Android/native feature path still requiring an unbounded query
 *   D — dead or forbidden (typed refusal)
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Unbounded-query call shapes, as they appear in source. */
const UNBOUNDED_PATTERNS = [
  // P7 Stage 9 (retirement plan, entry 2): `list` joins the unbounded shapes
  // the source sweep refuses. Its `limit` argument described the output while
  // the work scaled with the whole store, which is exactly the shape this
  // audit exists to catch.
  /\btripService\.list\s*\(/,
  /\btripService\.listAll\s*\(/,
  /\btripService\.listAllSummaries\s*\(/,
  /\btripService\.listAllForExport\s*\(/,
  /\blocalTripRepository\.listAll\s*\(/,
  /\breadAllNativeSpeedKnowledge\s*\(/,
  /\bgetAllTrips\s*\(\s*\)/,
  /\bgetAllTripSummaries\s*\(\s*\)/,
];

/**
 * Files allowed to contain an unbounded shape, each with the reason.
 *
 * Repository internals define the queries; the service layer routes them; the
 * native repository refuses them. Everything else must be bounded.
 */
const CLASSIFIED = new Map([
  ['lib/localTripRepository.js', {
    category: 'A',
    reason: 'browser/dev IndexedDB backend defines these; native authority never selects it',
    marker: 'const getAllTrips = async',
  }],
  ['api/trips.js', {
    category: 'A',
    reason: 'service layer routes to whichever repository is selected',
    marker: 'repository().listAll(',
  }],
  // P7 Stage 9 moved the browser `list` classification A -> D. It is no longer
  // "a backend the native authority never selects"; it is a **typed refusal**,
  // the same disposition `nativeTripRepository` has always had. The two
  // authorities now agree, so no selection can reach an unbounded page read.
  ['lib/localTripRepository.js#list', {
    category: 'D',
    reason: 'P7 Stage 9 typed UNBOUNDED_QUERY_FORBIDDEN refusal on the browser authority',
    marker: "query: 'list' }",
  }],
  ['lib/nativeTripRepository.js', {
    category: 'D',
    reason: 'typed UNBOUNDED_QUERY_FORBIDDEN refusals',
    marker: "listAll: () => forbidden('listAll')",
  }],
  ['lib/nativeSpeedKnowledgeStore.js', {
    category: 'A',
    reason: 'browser/dev merge helper; native reads go through bucket cursors',
    marker: 'export async function readAllNativeSpeedKnowledge',
  }],
  ['pages/Settings.jsx', {
    category: 'A',
    reason: 'backup export passes undefined on Android, which uses the native stream backup',
    marker: 'tripService.listAllForExport(',
  }],
]);

const sourceFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['__tests__', '__fixtures__', 'node_modules'].includes(entry)) continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(js|jsx)$/.test(entry) && !/\.test\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
};

/** Strip comments so documentation of the old pattern is not read as a call. */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('P3.5 whole-history release audit', () => {
  it('has no category-C unbounded query in any production path', () => {
    const findings = [];
    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const pattern of UNBOUNDED_PATTERNS) {
        if (!pattern.test(source)) continue;
        if (CLASSIFIED.has(relative)) continue;
        findings.push(`${relative}: ${pattern}`);
      }
    }
    // A failure here means a feature was wired to an unbounded query. Either
    // convert it to a bounded job, or classify it above with the reason it can
    // never run under native authority.
    expect(findings).toEqual([]);
  });

  it('keeps every classified exemption present, so stale entries are noticed', () => {
    // An exemption that no longer matches anything is worse than no exemption:
    // it silently widens what the audit permits.
    const stale = [];
    for (const [relative, entry] of CLASSIFIED) {
      // A `#suffix` names a specific disposition inside a file, so one file can
      // carry two classifications — which is exactly what a typed refusal
      // beside a legitimate backend method looks like.
      const file = relative.split('#')[0];
      const source = withoutComments(readFileSync(path.join(SRC, file), 'utf8'));
      if (!source.includes(entry.marker)) stale.push(`${relative} (${entry.category}: ${entry.reason})`);
    }
    expect(stale).toEqual([]);
  });

  it('refuses whole-model speed reads and writes under native authority', () => {
    const source = readFileSync(path.join(SRC, 'lib/speedKnowledgeRepository.js'), 'utf8');
    expect(source).toContain('NATIVE_SPEED_FULL_MODEL_FORBIDDEN');
    expect(source).toContain('NATIVE_SPEED_BUCKET_SCOPED_WRITE_REQUIRED');
  });

  it('refuses unbounded trip queries under native authority', () => {
    const source = readFileSync(path.join(SRC, 'lib/nativeTripRepository.js'), 'utf8');
    expect(source).toContain('UNBOUNDED_QUERY_FORBIDDEN');
    for (const method of ['listAll', 'listAllSummaries', 'listAllForExport']) {
      expect(source).toMatch(new RegExp(`${method}:\\s*\\(\\)\\s*=>\\s*forbidden`));
    }
  });

  it('V19: keeps unregistered full-history jobs out of the lifecycle file until they are adopted', () => {
    // The structural boundary only governs work that goes *through* it. These
    // four full-history jobs are not registered until frozen step 12, so the
    // historical source assertion stays as their guard rather than being
    // deleted with nothing covering the gap.
    const lifecycle = withoutComments(readFileSync(path.join(SRC, 'App.jsx'), 'utf8'));
    for (const jobEntry of [
      'runBoundedTripJob',
      'runCalibrationJob',
      'runPrivacyArchiveScan',
      'rebuildAchievementAggregates',
    ]) {
      expect(lifecycle, `${jobEntry} must enter through the registration boundary`).not.toContain(jobEntry);
    }
  });

  it('V19: audits actual production lifecycle registrations by immutable work semantics', () => {
    const registrations = getP4LifecycleRegistrations();
    expect(registrations.length).toBeGreaterThan(0);
    for (const registration of registrations) {
      expect(Object.isFrozen(registration)).toBe(true);
      expect(registration.workExtent).toBe(APP_WORK_EXTENTS.BOUNDED_TURN);
      expect(registration.triggerOrigins).not.toContain(APP_WORK_TRIGGER_ORIGINS.PAGE_OPEN);
      expect(registration.workExtent).not.toBe(APP_WORK_EXTENTS.FULL_HISTORY);
    }
  });

  it.each([
    ['direct', (job) => job],
    ['alias', (job) => job],
    ['wrapper', (job) => (...args) => job(...args)],
    ['newly named helper', () => async function innocentLookingTask() {}],
  ])('V31: rejects a %s full-history lifecycle callback without inspecting its name', (_label, wrap) => {
    const boundary = createLifecycleWorkRegistrationBoundary(
      createAppWorkCoordinator({ autoStart: false })
    );
    const historicalPass = async ({ budget }) => {
      budget.reportZeroWork();
      return APP_WORK_TURN_RESULTS.DONE;
    };
    expect(() => boundary.register({
      jobKey: `negative-${_label}`,
      triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP],
      workExtent: APP_WORK_EXTENTS.FULL_HISTORY,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      budget: { items: 1 },
      runTurn: wrap(historicalPass),
    })).toThrow(/Full-history work cannot be registered/);
  });
});

/**
 * P7 release audit — by symbol and caller context (Annex B §B5.2), plus the
 * Stage 1 negative controls for P7-V01, P7-V02 and P7-V18.
 *
 * The P3.5 audit above classifies by repository *filename*. P7 adds the
 * caller-context classifier so a blanket repository exemption can no longer
 * shield a routine page caller.
 *
 * **Why some assertions below are `it.fails`.** Stage 1 is contract
 * transcription: not one consumer has been migrated yet, so the release law
 * these gates express is *supposed* to be violated by the current source. The
 * pairing is deliberate:
 *
 *   - the **baseline** tests pass today and assert the detector finds *exactly*
 *     the known pre-migration state — a new violation fails them immediately,
 *     and a violation that disappears fails them too, forcing the baseline to
 *     shrink as Stages 2-9 land;
 *   - the **release gates** are `it.fails`, so they pass while the source is
 *     unmigrated and start failing loudly the moment migration completes, which
 *     is when Stage 9/10 flips each one to `it`.
 *
 * Neither assertion is weakened to accommodate the unmigrated source.
 */

/** The exact pre-migration state, enumerated. Every entry must disappear by Stage 9. */
const P7_PREMIGRATION_ROUTINE_EDGES = Object.freeze([
  // EMPTY AS OF STAGE 8. Every entry disappeared as its consumer was migrated,
  // and each removal is recorded here rather than silently dropped:
  //
  //   `pages/SpeedLimits.jsx:1099` and `:1158` `listForSpeedMap` (B6) — Stage 7
  //     replaced the offset-paged map model with the bounded Q8 composition.
  //   `lib/speedGeometryIndex.js:140 listForSpeedMap` (B6) — the explicit v1
  //     rebuild. It is reached only from the "Load full road history" action,
  //     and Stage 8 gave it the caller-context annotation that classifies it,
  //     so the fail-closed UNCLASSIFIED -> ROUTINE default no longer applies.
  //   `components/speedLimits/SpeedIntelligenceConsole.jsx:47` (B2),
  //   `pages/TrackingReplayPro.jsx:43` (B4) and
  //   `pages/TrackingReportsLab.jsx:45` (B3) `tripService.list` — Stage 8
  //     replaced all three. Each read **every** trip in the store, decrypted
  //     each one in full, sorted the whole array and sliced `limit` rows off
  //     the front; the limit described the output, never the work.
  //   `pages/Settings.jsx:754 getScoreMigrationSummary` (B9) — Stage 8 replaced
  //     it with `p7.settings.scoreMigrationSummary@1`, whose output is fixed in
  //     size where the old summary returned one entry per mismatched trip.
  //
  // The detector was never weakened. It still finds every one of these shapes.
  //
  // `lib/speedGeometryIndex.js:140 listForSpeedMap` (B6's explicit v1 rebuild)
  // was the last entry. Stage 9 did not retire it — Annex B retains it under
  // its existing compatibility rule — it **proved** it explicit by making the
  // classifier see two things it was blind to:
  //
  //   1. `useCallback` handlers. `const onThing = useCallback(() => {` bound no
  //      name, so every call inside it attributed to the component function,
  //      and a component always contains a `useQuery`. Real explicit handlers
  //      were reported routine.
  //   2. cross-module attribution. An edge whose enclosing *exported* function
  //      is called only from explicit sites in other files is explicit.
  //
  // Both only ever add information, and only ever upward: a `ROUTINE` verdict
  // is never revisited, an edge with no importer or one routine importer stays
  // `UNCLASSIFIED`, and `UNCLASSIFIED` is still treated as routine. The gate
  // was not relaxed to reach zero; the detector was made able to see.
]);

/** Call edges that are legal only from their exact intentional user action. */
const P7_PREMIGRATION_EXPLICIT_EDGES = Object.freeze([
  // B6's explicit v1 rebuild, reached only from the "Load full road history"
  // button in `SpeedLimits.jsx`. Annex B retains it under its existing
  // compatibility rule; the rebuild also returns the D2 answer outright
  // whenever the geometry domain has claimed coverage, so the v1 loader runs
  // only on the compatibility path.
  'lib/speedGeometryIndex.js listForSpeedMap',  // B6 explicit v1 rebuild
  'pages/Settings.jsx listAllForExport',        // B7 backup export
  'pages/Settings.jsx rescoreCompletedTrips',  // B10 user-initiated rescore
  'pages/Settings.jsx eraseAll',               // B8 data-rights erase
  // `pages/Settings.jsx:2348 tripService.list` (B5) was here, reached from the
  // "use a recent trip for this corridor" action. Stage 8 replaced it with a
  // bounded Q1 page plus the capped per-trip overview reads, so the detector
  // stopped finding it.
]);

/** Pages that acquire retained trip data more than once per render (P7-N04). */
const P7_PREMIGRATION_DUPLICATE_ACQUISITIONS = Object.freeze({
  // `pages/Achievements.jsx` was here at 2 acquisitions (a `(50)` page plus a
  // `(200)` page). Stage 6.3 migrated it to one bounded Q1 window plus the
  // lifetime owners, and the detector stopped finding it.
  // `pages/Dashboard.jsx` was here at 4 acquisitions (a `(50)` page, an
  // idle-gated `(200)` page and two ad-hoc `listSummaries({limit:50})` lookups
  // on the trip-ending paths). Stage 6.4 collapsed all four into one canonical
  // composition, and the detector stopped finding it.
  //
  // `pages/Diagnostics.jsx` was here at 3 acquisitions (two *identical*
  // `listSummaries({limit:20})` calls plus a 200-row sweep). Stage 3 migrated
  // it to one canonical composition, so the detector stopped finding it and
  // this baseline shrank — which is the only legal way an entry leaves.
  // `pages/DrivingCoach.jsx` was here at 2 acquisitions (a `(50)` page plus a
  // `(200)` page gated only on the first having loaded, so the second always
  // fired). Stage 6.6 replaced both with one labelled Q1 window plus the
  // lifetime owners, and the detector stopped finding it.
  // `pages/Insights.jsx` was here at 2 acquisitions (a `(50)` page plus an
  // ungated `(200)` page). Stage 6.5 replaced both with bounded Q1 date-range
  // scans of the windows the page actually presents, and the detector stopped
  // finding it.
  // `pages/SpeedLimits.jsx` was the last entry here, at 2 acquisitions (an
  // offset-paged `listForSpeedMap` plus a second geometry index read). Stage 7
  // replaced both with one bounded Q8 page, and the detector stopped finding
  // it. The baseline is now empty, which is why the V18 release gate below is
  // an `it` rather than an `it.fails`.
  // `pages/TripHistory.jsx` was here at 2 acquisitions (a `(100)` page plus a
  // gated `(200)` page). Stage 4 migrated it to one cursor-paged Q1
  // composition, so the detector stopped finding it and this baseline shrank.
  //
  // `pages/Vehicles.jsx` was here at 2 (a `(100)` page plus an idle-gated
  // `(200)` page). Stage 6.2 migrated it to one bounded Q1 page plus Q4 per
  // vehicle over the D1 owner's buckets, and the detector stopped finding it.
});

const describeEdge = (edge) => `${edge.file}:${edge.line} ${edge.symbol}`;
const describeStableEdge = (edge) => `${edge.file} ${edge.symbol}`;

const frozenSymbolEdges = () => findSymbolCallEdges(
  [...P7_ROUTINE_FORBIDDEN_SYMBOLS, ...P7_EXPLICIT_ONLY_SYMBOLS],
  { exclude: EXCLUDE_DEFINITIONS },
);

describe('P7 release audit — symbol and caller context', () => {
  it('knows the frozen 30-consumer ledger and the B1-B10 inventory', () => {
    expect(P7_CONSUMER_LEDGER).toHaveLength(30);
    expect(P7_BROAD_INVENTORY).toHaveLength(10);
    // Every P7-scope broad entry names a replacement; every explicit one says so.
    for (const item of P7_BROAD_INVENTORY) {
      expect(item.replacement, `${item.id} replacement`).toBeTruthy();
      expect(['P7-SCOPE', 'P7-SCOPE-ROUTINE', 'EXPLICIT', 'EXPLICIT-CLOSED-OWNER'])
        .toContain(item.scope);
    }
  });

  it('classifies the explicit B7/B8/B10 edges as intentional user actions, not routine', () => {
    const explicit = frozenSymbolEdges()
      .filter((edge) => edge.context === CALLER_CONTEXT.EXPLICIT)
      .map(describeStableEdge)
      .sort();
    expect(explicit).toEqual([...P7_PREMIGRATION_EXPLICIT_EDGES].sort());
  });

  it('NEGATIVE CONTROL: detects exactly the known routine legacy edges', () => {
    // Passing here proves the measuring system works. A *new* routine edge or a
    // disappeared one both fail, so the baseline can only shrink deliberately.
    const routine = frozenSymbolEdges().filter(isRoutineEdge).map(describeEdge).sort();
    expect(routine).toEqual([...P7_PREMIGRATION_ROUTINE_EDGES].sort());
  });

  it('NEGATIVE CONTROL: detects exactly the known duplicate page acquisitions', () => {
    const found = Object.fromEntries(
      findDuplicateHistoryAcquisitions().map((item) => [item.file, item.acquisitions])
    );
    expect(found).toEqual({ ...P7_PREMIGRATION_DUPLICATE_ACQUISITIONS });
  });

  it('NEGATIVE CONTROL: detects a consumer that is missing from the ledger', () => {
    // Feed the completeness sweep a ledger with one consumer removed; it must
    // notice. This is what proves V02 measures something.
    const shortened = p7ConsumerPaths().filter((entry) => !entry.includes('TripHistory.jsx'));
    expect(findUndeclaredConsumerFiles(shortened)).toContain('src/pages/TripHistory.jsx');
  });

  it('P7-V02: every production trip-read consumer appears in the ledger', () => {
    expect(findUndeclaredConsumerFiles(p7ConsumerPaths())).toEqual([]);
  });

  it('P7-V01: no stale independent P7-H02/H03/H04 reference survives in source', () => {
    const stale = [];
    for (const file of productionSourceFiles()) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      const source = readFileSync(file, 'utf8');
      // The single legal mention is the removal record on P7-H01 itself.
      const isRemovalRecord = relative === 'lib/tripQueryContracts.js'
        && /removedIndependentIds/.test(source);
      if (isRemovalRecord) continue;
      for (const match of source.match(/P7-H0[2-9]/g) ?? []) stale.push(`${relative}: ${match}`);
    }
    expect(stale).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Release gates. EXPECTED TO FAIL until the stage named on each flips it.
  // ---------------------------------------------------------------------

  // Stage 8 removed the last four routine edges to a frozen legacy symbol
  // (B2, B3, B4 and B9), each replaced by its bounded successor. The three explicit edges above — B7 backup export, B8
  // data-rights erase, B10 user-initiated rescore — are **retained** by Annex B
  // and are legal only from their exact intentional user action, which the
  // paired baseline test above asserts by caller context.
  //
  // FLIPPED IN STAGE 9. Not one routine call edge to a frozen legacy symbol
  // survives. The three explicit edges above — B7 backup export, B8
  // data-rights erase, B10 user-initiated rescore — plus B6's explicit v1
  // rebuild are **retained** by Annex B and are legal only from their exact
  // intentional user action, which the paired baseline test asserts by caller
  // context.
  //
  // Stage 9 also owns the *deletions* Stage 8 makes possible: removing
  // `tripSummaryQueryOptions`, typed-refusing `list`/`listAllSummaries`/
  // `listAll` on the browser authority, and moving the release audit's
  // `CLASSIFIED` entries from A to D.
  it('P7-V22 (Stage 9): no routine call edge to a frozen legacy symbol survives', () => {
    const routine = frozenSymbolEdges().filter(isRoutineEdge).map(describeEdge);
    expect(routine).toEqual([]);
  });

  // FLIPPED IN STAGE 7. Every page that held a duplicate history acquisition
  // has been migrated — TripHistory (Stage 4), Vehicles, Achievements,
  // Dashboard, Insights, DrivingCoach (Stage 6) and SpeedLimits (Stage 7) —
  // and the detector now finds none. It was never weakened to get here: each
  // baseline entry was removed only after its page genuinely left, with the
  // reason recorded inline. Stage 10 asserts it again at scale.
  it('P7-V18 (Stage 4-8): no page performs a duplicate history acquisition', () => {
    expect(findDuplicateHistoryAcquisitions()).toEqual([]);
  });
});
