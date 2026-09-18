/**
 * P7 canonical query contracts — the frozen Stage 1 transcription.
 *
 * This module is the single public entry point for the approved P7 contracts.
 * It **declares**; it does not query. Importing it changes no production
 * behaviour, and Stage 1 lands no behaviour change by design.
 *
 * The approved plan set it transcribes, and which may not be re-decided by any
 * later stage:
 *   - `agent-roadmap-rebase/P7/P7_REBASED_PLAN.md`        (inventories, stages, V matrix)
 *   - `agent-roadmap-rebase/P7/P7_CONTRACTS_ANNEX.md`     (Annex A — envelope, cursor v2, Q10, composition)
 *   - `agent-roadmap-rebase/P7/P7_CONSUMER_LEDGER.md`     (Annex B — the 30-consumer ledger)
 *   - `agent-roadmap-rebase/P7/P7_OUTPUT_SEMANTICS_MATRIX.md` (Annex C — per-output semantics)
 *
 * Plan approval authority: `CODEX_P7_F05_FINAL_CLOSURE.md` — FINAL VERDICT PASS,
 * all ten plan findings closed, implementation authorized.
 *
 * **No Stage 2-10 implementer may invent** an envelope field, cursor field,
 * reducer, key family, invalidation rule, projection field set, or fetch
 * topology that is not fixed here or in the consumer ledger.
 */

export * from './queryContracts/envelope.js';
export * from './queryContracts/cursor.js';
export * from './queryContracts/reducers.js';
export * from './queryContracts/composition.js';
export * from './queryContracts/populations.js';
export * from './queryContracts/qpaths.js';
export * from './queryContracts/broadInventory.js';
export * from './queryContracts/outputs.js';
export * from './queryContracts/outputsReport.js';

import {
  P7_OUTPUTS_TOTALS, P7_OUTPUTS_EVENTS, P7_OUTPUTS_WINDOWS, P7_OUTPUTS_CHARTS,
  P7_OUTPUTS_PROGRESSION, P7_OUTPUTS_GEOMETRY,
} from './queryContracts/outputs.js';
import {
  P7_OUTPUTS_REPORT_BODY, P7_OUTPUT_SETTINGS_MIGRATION, P7_OUTPUTS_REPORT_INSIGHTS,
} from './queryContracts/outputsReport.js';
import { P7_REDUCER_BY_IDENTITY } from './queryContracts/reducers.js';
import { P7_FORBIDDEN_DRIVER_SOURCES, P7_FORBIDDEN_COMPLETED_SOURCES } from './queryContracts/populations.js';

/**
 * P7-H01 — the **one** historical requirement, with its four clauses.
 *
 * `SHARED_INVESTIGATION.md` §9.9 is one numbered architecture item; §11 is that
 * item's phase description and acceptance elaboration, not three additional
 * numbered requirements. Clauses (a)-(d) are clauses of H01, **not** independent
 * historical IDs: the earlier plan's P7-H02/H03/H04 are removed as IDs and no
 * clause is lost.
 */
export const P7_HISTORICAL_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: 'P7-H01',
    source: '§9.9 (line 322) as elaborated by §11 (lines 411-412)',
    classification: 'STILL',
    clauses: Object.freeze({
      a: 'each page obtains its trip data through one canonical bounded page composition',
      b: 'existing incremental persisted rollups are consumed where they define the requested metric',
      c: 'full detail is fetched only by stable ID where needed',
      d: 'legacy page paths retire only after semantic, parity and migration verification',
    }),
    removedIndependentIds: Object.freeze(['P7-H02', 'P7-H03', 'P7-H04']),
    clauseDelivery: Object.freeze({
      a: Object.freeze({ musts: ['P7-M03'], validations: ['P7-V03', 'P7-V04', 'P7-V05', 'P7-V18'] }),
      b: Object.freeze({ musts: ['P7-M05', 'P7-M06', 'P7-M09'], validations: ['P7-V08', 'P7-V09', 'P7-V10', 'P7-V15', 'P7-V16'] }),
      c: Object.freeze({ musts: ['P7-M04', 'P7-M07'], validations: ['P7-V06', 'P7-V07', 'P7-V11', 'P7-V12'] }),
      d: Object.freeze({ musts: ['P7-M13', 'P7-M08', 'P7-M16'], validations: ['P7-V12', 'P7-V13', 'P7-V22', 'P7-V24'] }),
    }),
  }),
]);

/** Frozen headline accounting. These counts may not be changed by implementation. */
export const P7_FROZEN_COUNTS = Object.freeze({
  historical: 1, already: 0, still: 1, superseded: 0,
  newRequirements: 8, must: 16, should: 1, validations: 24,
  lifecycleJobs: 0, coordinatorRegistrations: 0, explicitOperations: 0,
  consumers: 30, broadInventory: 10, broadP7Scope: 7, broadExplicitClosedOwner: 3,
  queryPaths: 10, reducerIdentities: 16, planFindings: 10, planBlockers: 0,
});

/**
 * Closed-phase preservation invariants P7 must not disturb (M14, M15, V20, V23).
 */
export const P7_CLOSED_PHASE_INVARIANTS = Object.freeze({
  p7LifecycleJobs: 0,
  p7CoordinatorRegistrations: 0,
  p7ExplicitOperations: 0,
  p5RegistrationContractRejectsP7Keys: true,
  p6LifecycleJobs: Object.freeze(['p6TripDerivedUpdates', 'p6RoadMemoryUpdates', 'p6AffectedTripSelection']),
  p6ExplicitOperationsNonLifecycle: 4,
  enableP6Registrations: true,
  forbiddenReads: Object.freeze([
    'speedKnowledgeStore.get()',
    'readAchievementBadges',
    'readCalibrationProgressFromAggregates',
  ]),
});

/** Every Annex C output row, in one list, for the §C5.4 mechanical sweeps. */
export const P7_OUTPUT_MATRIX = Object.freeze([
  ...P7_OUTPUTS_TOTALS, ...P7_OUTPUTS_EVENTS, ...P7_OUTPUTS_WINDOWS, ...P7_OUTPUTS_CHARTS,
  ...P7_OUTPUTS_PROGRESSION, ...P7_OUTPUTS_GEOMETRY,
  ...P7_OUTPUTS_REPORT_BODY, P7_OUTPUT_SETTINGS_MIGRATION, ...P7_OUTPUTS_REPORT_INSIGHTS,
]);

const mentionsSource = (row, token) => {
  const haystack = `${row.browserSource ?? ''} ${row.nativeSource ?? ''} ${row.source ?? ''}`;
  // "never N-TOT ..." and "no Q4" are explicit prohibitions, not source claims.
  const cleaned = haystack
    .replace(/never [^;]*/gi, '')
    .replace(/\bno Q4\b/gi, '')
    .replace(/NOT\s+\S+/g, '');
  if (token === 'Q4' || token === 'Q5') {
    return new RegExp(`\\b${token}\\b`).test(cleaned) || (row.qGraph ?? []).includes(token);
  }
  return new RegExp(token.replace('-', '\\-')).test(cleaned);
};

/**
 * §C5.4 sweep 1 + 4 — owner capability.
 * A `P-DRIVER` row may not name B-D1 / N-TOT / N-BKT / Q4 / Q5; no row may name
 * N-TOT as an exact `P-COMPLETED` source.
 * @returns {string[]} violations; empty means the matrix conforms
 */
export function p7OwnerCapabilityViolations(rows = P7_OUTPUT_MATRIX) {
  const violations = [];
  for (const row of rows) {
    if (row.population === 'P-DRIVER') {
      for (const forbidden of P7_FORBIDDEN_DRIVER_SOURCES) {
        if (mentionsSource(row, forbidden)) violations.push(`${row.id}: P-DRIVER row names ${forbidden}`);
      }
    }
    if (String(row.population).startsWith('P-COMPLETED')) {
      for (const forbidden of P7_FORBIDDEN_COMPLETED_SOURCES) {
        if (mentionsSource(row, forbidden)) violations.push(`${row.id}: P-COMPLETED row names ${forbidden}`);
      }
    }
  }
  return violations;
}

/**
 * §C5.4 sweep 2 — reducer-term declaration. Every `p7.*@n` identity a row
 * references must exist in the Annex A §A3.1 registry.
 * @returns {string[]} violations
 */
export function p7ReducerReferenceViolations(rows = P7_OUTPUT_MATRIX) {
  const violations = [];
  for (const row of rows) {
    for (const identity of row.reducers ?? []) {
      if (!P7_REDUCER_BY_IDENTITY[identity]) violations.push(`${row.id}: undeclared reducer ${identity}`);
    }
    const referenced = `${row.browserSource ?? ''} ${row.nativeSource ?? ''} ${row.source ?? ''}`
      .match(/p7\.[a-zA-Z.]+@\d+/g) ?? [];
    for (const identity of referenced) {
      if (!P7_REDUCER_BY_IDENTITY[identity]) violations.push(`${row.id}: undeclared reducer ${identity}`);
      else if (!(row.reducers ?? []).includes(identity)) {
        violations.push(`${row.id}: reducer ${identity} named in prose but not in the row reducer list`);
      }
    }
  }
  return violations;
}
