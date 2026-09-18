/**
 * P7 Stage 1 — the broad / unbounded inventory, B1-B10 (plan § Search for Broad
 * / Expensive Read Patterns).
 *
 * This is an inventory of **root mechanisms and live caller instances**, not a
 * count of unique storage roots. The mixed convention is deliberate: it is what
 * retirement needs. 10 mixed entries: 7 P7-scope (B1-B6, B9), 3
 * explicit/closed-owner (B7, B8, B10).
 *
 * The release audit (Annex B §B5.2) classifies legality by **symbol and caller
 * context**, not by repository filename:
 *   routine  = reachable from mount, render, effect, focus, resume, or cache invalidation
 *   explicit = reachable only from a named intentional user action
 */

const b = (id, path, symbol, callers, scope, replacement) => Object.freeze({
  id, path, symbol, callers: Object.freeze(callers), scope, replacement,
});

export const P7_BROAD_INVENTORY = Object.freeze([
  b('B1', 'localTripRepository.list()', 'localTripRepository.list',
    [], 'P7-SCOPE',
    'Q1 (+ Q2 where geometry is genuinely needed); a limit-shaped API that is not storage-bound — it reads and decrypts the whole retained history, sorts it, then slices, and runs retention and event-type migration inline'),
  b('B2', 'components/speedLimits/SpeedIntelligenceConsole.jsx:47', 'tripService.list',
    ['src/components/speedLimits/SpeedIntelligenceConsole.jsx'], 'P7-SCOPE',
    'Q1 candidate projections + Q8 D2 by-id batch (Annex B §B4.1)'),
  b('B3', 'pages/TrackingReportsLab.jsx:45', 'tripService.list',
    ['src/pages/TrackingReportsLab.jsx'], 'P7-SCOPE',
    'Q4 + Q5 + Q10 at render, bounded one-resident export stream (Annex B §B4.3)'),
  b('B4', 'pages/TrackingReplayPro.jsx:43', 'tripService.list',
    ['src/pages/TrackingReplayPro.jsx'], 'P7-SCOPE',
    'Q1 picker projections + <=2 Q2 for the selected pair (Annex B §B4.2)'),
  b('B5', 'pages/Settings.jsx:2348', 'tripService.list',
    ['src/pages/Settings.jsx'], 'P7-SCOPE',
    'Q1 recent bounded ids + capped Q3 corridor overviews (Annex B §B4.4)'),
  b('B6', 'localTripRepository.listForSpeedMap()', 'listForSpeedMap',
    ['src/pages/SpeedLimits.jsx', 'src/lib/speedGeometryIndex.js'], 'P7-SCOPE',
    'Q8 — routine use retired on both authorities; the explicit v1 rebuild survives only inside speedGeometryIndex under its already-existing compatibility rule'),
  b('B7', 'pages/Settings.jsx:759 backup export', 'tripService.listAllForExport',
    ['src/pages/Settings.jsx'], 'EXPLICIT',
    'retained — legal only from its exact intentional user action; must be proven unreachable from mount/render/effect/focus/resume/invalidation'),
  b('B8', 'localTripRepository.eraseAll()', 'eraseAll',
    ['src/lib/dataRights.js'], 'EXPLICIT-CLOSED-OWNER',
    'retained — explicit data-rights erase, P3.5/P5 owner'),
  b('B9', 'pages/Settings.jsx:754 -> browser whole-history score-migration summary', 'getScoreMigrationSummary',
    ['src/pages/Settings.jsx'], 'P7-SCOPE-ROUTINE',
    'Q10 p7.settings.scoreMigrationSummary@1 — a bounded named reducer whose accumulator and returned payload are both fixed in size with respect to N'),
  b('B10', 'pages/Settings.jsx:1613 user-initiated rescore', 'rescoreCompletedTrips',
    ['src/pages/Settings.jsx'], 'EXPLICIT-CLOSED-OWNER',
    'retained — legal ONLY behind its intentional user action; excluded from every routine page budget'),
]);

/**
 * Symbols whose **routine** call edge fails release after migration
 * (Annex B §B5.2). Blanket repository-file exemptions must not shield them.
 */
export const P7_ROUTINE_FORBIDDEN_SYMBOLS = Object.freeze([
  'tripService.list',
  'localTripRepository.list',
  'listForSpeedMap',
  'getScoreMigrationSummary',
  'listAllSummaries',
  'listAll',
  'getCurrentTripSummaries',
  'tripSummaryQueryOptions',
]);

/** Symbols legal only at their exact intentional user-action call edges. */
export const P7_EXPLICIT_ONLY_SYMBOLS = Object.freeze([
  'listAllForExport',   // B7
  'eraseAll',           // B8
  'rescoreCompletedTrips', // B10
]);

/** Caller-context classification used by the release audit. */
export const P7_CALLER_CONTEXTS = Object.freeze({
  ROUTINE: 'reachable from mount, render, effect, focus, resume, or cache invalidation',
  EXPLICIT: 'reachable only from a named intentional user action',
});

/** Retirement order and proof (plan § Legacy Path Retirement, M13). */
export const P7_RETIREMENT_PLAN = Object.freeze([
  Object.freeze({ path: 'tripSummaryQueryOptions', replacement: 'already unused', proof: 'delete the export; assert absence' }),
  Object.freeze({ path: 'localTripRepository.list', replacement: 'Q1 (+Q2)', proof: '4 callers migrated; add \\btripService\\.list\\s*\\( to UNBOUNDED_PATTERNS' }),
  Object.freeze({ path: 'listForSpeedMap routine use', replacement: 'Q8', proof: 'SpeedLimits.jsx migrated; speedGeometryIndex.js remains only inside the explicit v1 rebuild' }),
  Object.freeze({ path: 'listAllSummaries, listAll', replacement: 'none needed — already callerless', proof: 'move the release-audit classification A -> D (typed refusal) on browser' }),
  Object.freeze({ path: 'browser getScoreMigrationSummary routine use (B9)', replacement: 'Q10 p7.settings.scoreMigrationSummary@1', proof: 'the Settings production graph performs no getAllTrips, retention/migration sweep or unbounded decrypt when the surface opens/renders' }),
  Object.freeze({ path: 'getCurrentTripSummaries', replacement: 'removed with its last caller', proof: 'assert historySorts === 0 and wholeStoreGetAlls === 0' }),
  Object.freeze({ path: 'the 50+200 duplicate pairs (7 pages)', replacement: 'one top-level composition per page', proof: 'per-page composition-count assertion' }),
]);

/**
 * A VERIFIED new bounded path must never silently fall back to a retired
 * unbounded one. This mirrors the P6 §6l correction exactly.
 */
export const P7_FALLBACK_LAW = Object.freeze({
  silentFallbackToRetiredPath: false,
  onFailure: 'raise a NAMED refusal / typed state, logged through logSystemFailure',
  compatibilityRouteReachableBy: 'only an unnamed refusal from a path that never claimed coverage',
  newProductionFeatureGate: false,
});
