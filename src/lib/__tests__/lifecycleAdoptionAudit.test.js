import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  APP_WORK_EXTENTS,
  APP_WORK_TRIGGER_ORIGINS,
  P4_LIFECYCLE_ALLOWLIST,
  P4_LIFECYCLE_JOB_KEYS,
  P5_LIFECYCLE_JOB_KEYS,
  createP4LifecycleWorkRuntime,
  getP4LifecycleRegistrations,
} from '@/lib/appLifecycleWork';
import { createAppWorkCoordinator } from '@/lib/appWorkCoordinator';
import { P6_EXPLICIT_OPERATION_TYPES, P6_JOB_KEYS } from '@/lib/p6Contracts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(path.join(SRC, relative), 'utf8');

/** Executable source only: a comment naming a call is not a call. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * V27 — exhaustive adoption audit (M23).
 *
 * Every current lifecycle-owned suspendible background trigger either enters
 * the coordinator as one bounded turn, or appears in the reviewed allowlist
 * with a concrete ownership reason. The audit is driven by the actual frozen
 * registration semantics, not by grepping for function names.
 */
const REQUIRED_ADOPTIONS = [
  ['migration read trigger', P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION],
  ['road-context continuation', P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT],
  ['rescoring continuation', P4_LIFECYCLE_JOB_KEYS.RESCORING],
  ['native projection', P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION],
  ['journal ingest', P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST],
  ['speed maintenance', P4_LIFECYCLE_JOB_KEYS.SPEED_MAINTENANCE],
  ['KEK batches', P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION],
  ['repository/projection maintenance', P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE],
  ['milestone reconciliation', P4_LIFECYCLE_JOB_KEYS.MILESTONE_RECONCILIATION],
  ['native raw-GPS retention', P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION],
  ['journal manifest reconcile', P5_LIFECYCLE_JOB_KEYS.JOURNAL_MANIFEST_RECONCILE],
  ['archive integrity checkpoint', P5_LIFECYCLE_JOB_KEYS.ARCHIVE_INTEGRITY_CHECKPOINT],
  ['archive residue GC', P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC],
];

const REVIEWED_P6_ADOPTIONS = [
  ['P6 trip derived updates', P6_JOB_KEYS.TRIP_DERIVED_UPDATES],
  ['P6 road memory updates', P6_JOB_KEYS.ROAD_MEMORY_UPDATES],
  ['P6 affected-trip selection', P6_JOB_KEYS.AFFECTED_TRIP_SELECTION],
];

const p6EnabledRegistrations = () => createP4LifecycleWorkRuntime({
  coordinator: createAppWorkCoordinator({ autoStart: false }),
  nativeAuthorityAvailable: () => false,
  readHealth: async () => ({ state: 'UNAVAILABLE' }),
  enableP6Registrations: true,
}).boundary.snapshot();

describe('V27: exhaustive lifecycle adoption audit', () => {
  it.each(REQUIRED_ADOPTIONS)('%s enters the coordinator as one bounded turn', (_label, jobKey) => {
    const registration = getP4LifecycleRegistrations().find((entry) => entry.jobKey === jobKey);

    expect(registration, `${jobKey} is not registered at the lifecycle boundary`).toBeDefined();
    expect(registration.workExtent).toBe(APP_WORK_EXTENTS.BOUNDED_TURN);
    expect(registration.workExtent).not.toBe(APP_WORK_EXTENTS.FULL_HISTORY);
    expect(registration.triggerOrigins).not.toContain(APP_WORK_TRIGGER_ORIGINS.PAGE_OPEN);
    expect(Object.isFrozen(registration)).toBe(true);
  });

  it.each(REVIEWED_P6_ADOPTIONS)('%s is a legal bounded registration when P6 is explicitly enabled', (_label, jobKey) => {
    const registration = p6EnabledRegistrations().find((entry) => entry.jobKey === jobKey);

    expect(registration, `${jobKey} is not registered by the reviewed P6 boundary`).toBeDefined();
    expect(registration.workExtent).toBe(APP_WORK_EXTENTS.BOUNDED_TURN);
    expect(registration.workExtent).not.toBe(APP_WORK_EXTENTS.FULL_HISTORY);
    expect(registration.triggerOrigins).not.toContain(APP_WORK_TRIGGER_ORIGINS.PAGE_OPEN);
    expect(Object.isFrozen(registration)).toBe(true);
  });

  it('every registered lifecycle job is one of the audited targets', () => {
    const registered = getP4LifecycleRegistrations().map((entry) => entry.jobKey).sort();
    const audited = [...REQUIRED_ADOPTIONS, ...REVIEWED_P6_ADOPTIONS]
      .map(([, jobKey]) => jobKey).sort();
    // No unaudited lifecycle job may appear, and none may quietly disappear.
    expect(registered).toEqual(audited);
  });

  it('production now registers exactly J1-J3 and the reviewed boundary stays identical', () => {
    const production = getP4LifecycleRegistrations().map((entry) => entry.jobKey).sort();
    const reviewed = p6EnabledRegistrations().map((entry) => entry.jobKey).sort();
    const expectedReviewed = [
      ...REQUIRED_ADOPTIONS,
      ...REVIEWED_P6_ADOPTIONS,
    ].map(([, jobKey]) => jobKey).sort();

    // Exactly the three frozen P6 lifecycle jobs, and no fourth.
    expect(production.filter((jobKey) => /^p6/i.test(jobKey))).toEqual(
      REVIEWED_P6_ADOPTIONS.map(([, jobKey]) => jobKey).sort()
    );
    expect(production.filter((jobKey) => Object.values(P6_JOB_KEYS).includes(jobKey)))
      .toHaveLength(Object.keys(P6_JOB_KEYS).length);
    // The P4/P5 registrations are untouched by the P6 release.
    expect(production.filter((jobKey) => !/^p6/i.test(jobKey)))
      .toEqual(REQUIRED_ADOPTIONS.map(([, jobKey]) => jobKey).sort());
    // Enabling production changed nothing about what the reviewed runtime
    // declares: the release gate is the only difference between them.
    expect(reviewed).toEqual(expectedReviewed);
    expect(production).toEqual(reviewed);
  });

  it('E1-E4 remain explicit operations and never become lifecycle registrations', () => {
    const registered = new Set([
      ...getP4LifecycleRegistrations(),
      ...p6EnabledRegistrations(),
    ].map((entry) => entry.jobKey));

    for (const operationType of Object.values(P6_EXPLICIT_OPERATION_TYPES)) {
      expect(registered.has(operationType), `${operationType} entered lifecycle registration`).toBe(false);
    }
  });

  it('the reviewed allowlist is small and every entry states a concrete ownership reason', () => {
    expect(P4_LIFECYCLE_ALLOWLIST.length).toBeLessThanOrEqual(6);
    for (const entry of P4_LIFECYCLE_ALLOWLIST) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.entryPoint).toBeTruthy();
      // A reason must cite durability-critical/native ownership, an explicit
      // user operation, or a named ownerless finding — never convenience.
      expect(entry.reason).toMatch(/durability-critical|explicit user operation|ownerless/i);
      expect(entry.reason).not.toMatch(/inconvenient|too hard|later/i);
    }
  });

  it('the migration read trigger admits the coordinator job instead of running migration', () => {
    const source = read('api/trips.js');
    const code = stripComments(source);
    // The historical whole-migration await on the write path is gone.
    expect(source).not.toContain('await migrateLegacyTripsToNativeArchive()');
    // P4-C-F02: no direct domain-step call survives anywhere in the executable
    // source - the trigger is an admission of the coordinator-owned job, whose
    // real call-graph behaviour is asserted in p35MigrationBoundedTurns.
    expect(code).not.toContain('stepLegacyMigration');
    expect(code).not.toContain('@/lib/p35Migration');
    expect(code).toContain('ensureP4LegacyMigrationAdvancing');
    expect(code).toContain('MIGRATION_IN_PROGRESS');
  });

  it('the rescoring queue cannot privately self-schedule its next coordinated turn', () => {
    const source = read('lib/rescoringQueue.js');
    // The private idle scheduler still exists for explicit user flows, but a
    // coordinator-owned queue must return before reaching it.
    expect(source).toContain('setRescoringCoordinatorOwned');
    // P4-C-F07: the coordinator-ownership branch still returns before the
    // private idle/timer scheduler, and now also notifies the readiness
    // listener that re-admits the deferred obligation.
    expect(source).toMatch(
      /function scheduleWorker[\s\S]{0,900}if \(coordinatorOwned\)[\s\S]{0,500}return;[\s\S]{0,200}if \(scheduled \|\| running/
    );
    expect(source).toContain('setRescoringWorkerReadyListener');
  });

  it('road-context, speed and repository maintenance each expose one bounded unit', () => {
    expect(read('lib/roadContextQueue.js')).toContain('stepPendingRoadContextJobs');
    expect(read('lib/speedKnowledgeRepository.js')).toContain('stepMaintenanceTurn');
    expect(read('lib/localTripRepository.js')).toContain('stepTripRepositoryMaintenance');
    // The repository sequence is adapted one unit at a time, never as one turn.
    expect(read('lib/localTripRepository.js')).toContain('REPOSITORY_MAINTENANCE_UNITS');
  });

  it('KEK rotation no longer monopolises with a run-to-completion batch loop', () => {
    const source = read('lib/keyRotationManager.js');
    expect(source).toContain('stepEncryptionKeyRotation');
    // A non-final batch must return before any finalization can be reached.
    expect(source).toMatch(/if \(nativeResult\.complete !== true\)[\s\S]{0,600}hasMore: true/);
  });

  it('runBoundedTripJob offers a scheduler turn but is never lifecycle-registered', () => {
    const source = read('lib/boundedTripJob.js');
    expect(source).toContain('runBoundedTripJobTurn');
    // Full-history jobs stay explicit by contract: a turn interface is fine,
    // a lifecycle registration is not (DN9).
    const registered = getP4LifecycleRegistrations().map((entry) => entry.jobKey);
    expect(registered).not.toContain('boundedTripJob');
    expect(read('App.jsx')).not.toContain('runBoundedTripJob');
  });
});
