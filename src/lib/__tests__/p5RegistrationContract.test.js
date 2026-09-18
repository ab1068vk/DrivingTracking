import { describe, expect, it } from 'vitest';

import {
  APP_WORK_EXTENTS,
  APP_WORK_TRIGGER_ORIGINS,
  P5_REGISTRATION_CONTRACT,
  assertP5RegistrationContract,
  createP4LifecycleWorkRuntime,
  createLifecycleWorkRegistrationBoundary,
} from '@/lib/appLifecycleWork';
import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
  validateRegistrationSemantics,
} from '@/lib/appWorkCoordinator';

/**
 * V28 — the frozen P5–P7 registration contract (M24).
 *
 * These fixtures test the *contract*, not any future feature code. P4
 * registers no P5–P7 job; it freezes the shape and the guard.
 */

const compliant = (overrides = {}) => ({
  jobKey: 'p5-future-job',
  triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.RESUME],
  workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
  workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
  newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
  budget: { items: 25, turns: 8 },
  domainStateOwner: 'DriveSenseArchiveRetention (native)',
  runTurn: async ({ budget }) => {
    budget.reportZeroWork();
    return APP_WORK_TURN_RESULTS.DONE;
  },
  ...overrides,
});

describe('V28: P5–P7 registration contract', () => {
  it('the contract itself is stable, machine-readable and frozen', () => {
    expect(Object.isFrozen(P5_REGISTRATION_CONTRACT)).toBe(true);
    expect(P5_REGISTRATION_CONTRACT.version).toBe(1);
    expect(P5_REGISTRATION_CONTRACT.required).toEqual([
      'jobKey',
      'triggerOrigins',
      'workExtent',
      'workClass',
      'runTurn',
      'budget',
      'newEpochPolicy',
    ]);
    expect(P5_REGISTRATION_CONTRACT.forbidden.length).toBeGreaterThanOrEqual(7);
  });

  it('a compliant future job passes and can be registered for real', () => {
    const declaration = assertP5RegistrationContract(compliant());
    expect(declaration).toMatchObject({
      jobKey: 'p5-future-job',
      workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      domainStateOwner: 'DriveSenseArchiveRetention (native)',
    });
    expect(Object.isFrozen(declaration)).toBe(true);

    const boundary = createLifecycleWorkRegistrationBoundary(
      createAppWorkCoordinator({ autoStart: false })
    );
    expect(() => boundary.register(compliant())).not.toThrow();
  });

  it.each([
    [
      'lifecycle-triggered FULL_HISTORY work',
      { workExtent: APP_WORK_EXTENTS.FULL_HISTORY },
      /Full-history work cannot be registered/,
    ],
    [
      'a missing bounded-turn callback',
      { runTurn: undefined },
      /missing required declaration "runTurn"/,
    ],
    [
      'a non-callable turn interface',
      { runTurn: 'runEverything' },
      /runTurn must be a bounded-turn callback/,
    ],
    [
      'a private next-turn scheduler',
      { selfSchedules: true },
      /may not schedule its own next coordinated turn/,
    ],
    [
      'a duplicate durable coordinator checkpoint',
      { coordinatorCheckpoint: { cursor: null } },
      /durable checkpoints stay with the domain owner/,
    ],
    [
      'an arbitrary priority ratio',
      { priorityRatio: 3 },
      /numeric priority ratios and weights are rejected/,
    ],
    [
      'a weighted priority class',
      { priorityWeight: 7 },
      /numeric priority ratios and weights are rejected/,
    ],
    [
      'a secureBridge priority class',
      { bridgePriority: 'foreground' },
      /secureBridge and native-writer priority classes are rejected/,
    ],
    [
      'a native writer priority',
      { nativeWriterPriority: 'high' },
      /secureBridge and native-writer priority classes are rejected/,
    ],
    [
      'a supplied but unnamed domain state owner',
      { domainStateOwner: '   ' },
      /a declared domain state owner must name its owner/,
    ],
    [
      'a missing budget declaration',
      { budget: undefined },
      /missing required declaration "budget"/,
    ],
    [
      'an unsupported semantic work class',
      { workClass: 'HIGH_PRIORITY' },
      /unsupported application work class|unsupported semantic work class/i,
    ],
    [
      'a missing new-epoch policy',
      { newEpochPolicy: undefined },
      /missing required declaration "newEpochPolicy"/,
    ],
  ])('rejects %s', (_label, override, expected) => {
    expect(() => assertP5RegistrationContract(compliant(override))).toThrow(expected);
  });

  it('the guard is fail-closed on an empty or malformed declaration', () => {
    expect(() => assertP5RegistrationContract()).toThrow(/missing required declaration/);
    expect(() => assertP5RegistrationContract({})).toThrow(/missing required declaration/);
  });

  it('releases production P6 as exactly J1-J3, with P5 and the reviewed runtime unchanged', async () => {
    const { admitP6ReviewedWork, getP4LifecycleRegistrations } = await import('@/lib/appLifecycleWork');
    const keys = getP4LifecycleRegistrations().map((entry) => entry.jobKey);
    expect(keys).not.toContain('p5-future-job');
    expect(keys.filter((key) => /^p5/i.test(key)).sort()).toEqual([
      'p5ArchiveIntegrityCheckpoint',
      'p5ArchiveResidueGc',
      'p5JournalManifestReconcile',
      'p5NativeRawGpsRetention',
    ]);
    // The release gate is now true, so production carries the three frozen P6
    // lifecycle jobs and no fourth.
    expect(keys.filter((key) => /^p6/i.test(key)).sort()).toEqual([
      'p6AffectedTripSelection',
      'p6RoadMemoryUpdates',
      'p6TripDerivedUpdates',
    ]);
    expect(keys.some((key) => /^p7/i.test(key))).toBe(false);
    // An enabled runtime admits reviewed P6 work; the job-key guard still
    // refuses anything that is not one of the three.
    expect(admitP6ReviewedWork('p6TripDerivedUpdates')).not.toMatchObject({
      reason: 'P6_IMPLEMENTATION_NOT_ENABLED',
    });
    expect(() => admitP6ReviewedWork('p6SomethingElse')).toThrow('P6_JOB_KEY_INVALID');

    const reviewed = createP4LifecycleWorkRuntime({
      coordinator: createAppWorkCoordinator({ autoStart: false }),
      nativeAuthorityAvailable: () => false,
      readHealth: async () => ({ state: 'UNAVAILABLE' }),
      enableP6Registrations: true,
    });
    const reviewedKeys = reviewed.boundary.snapshot().map((entry) => entry.jobKey);
    expect(reviewedKeys.filter((key) => /^p6/i.test(key)).sort()).toEqual([
      'p6AffectedTripSelection',
      'p6RoadMemoryUpdates',
      'p6TripDerivedUpdates',
    ]);
    expect(reviewedKeys.some((key) => /^p7/i.test(key))).toBe(false);
  });
});

/**
 * P4-D-F04 — `domainStateOwner` is conditional, exactly as the frozen contract
 * says. A bounded job with no durable domain state has no ownership that could
 * be duplicated, so the guard must not invent an owner requirement for it.
 */
describe('P4-D-F04: domainStateOwner is conditional, not mandatory', () => {
  /** The same compliant job, with the conditional field simply absent. */
  const stateless = (overrides = {}) => {
    const definition = compliant(overrides);
    delete definition.domainStateOwner;
    return definition;
  };

  it('accepts a compliant stateless job that declares no domain state owner', () => {
    expect(Object.keys(stateless())).not.toContain('domainStateOwner');
    expect(P5_REGISTRATION_CONTRACT.conditional).toContain('domainStateOwner');

    const declaration = assertP5RegistrationContract(stateless());

    expect(declaration).toMatchObject({
      jobKey: 'p5-future-job',
      workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
      domainStateOwner: null,
    });
    // And it is a real registration, not merely a guard that shrugged.
    const boundary = createLifecycleWorkRegistrationBoundary(
      createAppWorkCoordinator({ autoStart: false })
    );
    expect(() => boundary.register(stateless())).not.toThrow();
  });

  it('still accepts - and still validates - a job that does declare one', () => {
    expect(assertP5RegistrationContract(compliant())).toMatchObject({
      domainStateOwner: 'DriveSenseArchiveRetention (native)',
    });
    // Trimmed, so a padded declaration is normalized rather than accepted raw.
    expect(assertP5RegistrationContract(compliant({ domainStateOwner: '  Native archive  ' })))
      .toMatchObject({ domainStateOwner: 'Native archive' });
  });

  it.each([
    ['an empty owner', ''],
    ['a whitespace-only owner', '   '],
    ['a non-string owner', 42],
    ['an object owner', { owner: 'native' }],
  ])('rejects %s once one is supplied', (_label, domainStateOwner) => {
    expect(() => assertP5RegistrationContract(compliant({ domainStateOwner })))
      .toThrow(/a declared domain state owner must name its owner/);
  });

  it('still refuses coordinator-owned durable checkpoints, owner or not', () => {
    // The prohibition that actually protects domain ownership is unconditional.
    expect(() => assertP5RegistrationContract(compliant({ coordinatorCheckpoint: { cursor: null } })))
      .toThrow(/durable checkpoints stay with the domain owner/);
    expect(() => assertP5RegistrationContract(stateless({ coordinatorCheckpoint: { cursor: 12 } })))
      .toThrow(/durable checkpoints stay with the domain owner/);
    // Including a declaration that merely names the field: presence is the
    // violation, so an "empty" coordinator checkpoint is refused too.
    expect(() => assertP5RegistrationContract(stateless({ coordinatorCheckpoint: null })))
      .toThrow(/durable checkpoints stay with the domain owner/);
  });
});

/**
 * P4-D-F05 — the guard validates the *semantics* of every required
 * declaration, using the same validator real registration uses.
 */
describe('P4-D-F05: the P5 guard fails closed on invalid required semantics', () => {
  /** What real coordinator registration does with the identical declaration. */
  const registerForReal = (definition) => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    return () => coordinator.registerJob({
      jobKey: definition.jobKey,
      workClass: definition.workClass,
      runTurn: definition.runTurn,
      budget: definition.budget,
      newEpochPolicy: definition.newEpochPolicy,
    });
  };

  it.each([
    ['an invented new-epoch policy', { newEpochPolicy: 'NOT_A_POLICY' }],
    ['a lower-cased policy name', { newEpochPolicy: 'preserve_instance' }],
    ['a numeric policy', { newEpochPolicy: 1 }],
    ['an empty budget object', { budget: {} }],
    ['an all-zero budget', { budget: { items: 0, bytes: 0 } }],
    ['a NaN budget dimension', { budget: { items: Number.NaN } }],
    ['an infinite budget dimension', { budget: { items: Number.POSITIVE_INFINITY } }],
    ['a negative budget dimension', { budget: { items: -1 } }],
    ['a non-numeric budget dimension', { budget: { items: 'lots' } }],
    ['a zero turns budget', { budget: { items: 10, turns: 0 } }],
    ['a fractional turns budget', { budget: { items: 10, turns: 1.5 } }],
  ])('rejects %s in the guard itself', (_label, override) => {
    const definition = compliant(override);
    // The defect was that these reached only the later generic registration.
    expect(() => assertP5RegistrationContract(definition))
      .toThrow(/^P5 registration contract: /);
    // ... and the guard's verdict matches what registration would have said.
    expect(registerForReal(definition)).toThrow();
  });

  it.each([
    ['an items-only budget', { items: 25 }],
    ['a bytes-only budget', { bytes: 64 * 1024 }],
    ['a work-only budget', { work: 12 }],
    ['a time-only budget', { timeMs: 40 }],
    ['items, bytes, time and turns together', { items: 25, bytes: 1024, timeMs: 40, turns: 8 }],
    ['a budget with one zero dimension beside a positive one', { items: 25, bytes: 0 }],
  ])('accepts %s, exactly as coordinator registration does', (_label, budget) => {
    const definition = compliant({ budget });
    expect(() => assertP5RegistrationContract(definition)).not.toThrow();
    expect(registerForReal(definition)).not.toThrow();
    // The normalized budget is returned, not the caller's mutable literal.
    const declaration = assertP5RegistrationContract(definition);
    expect(Object.isFrozen(declaration.budget)).toBe(true);
  });

  it('validates the policy against the coordinator enum, not a private copy', () => {
    // Every supported policy passes ...
    for (const policy of Object.values(APP_WORK_NEW_EPOCH_POLICIES)) {
      expect(() => assertP5RegistrationContract(compliant({ newEpochPolicy: policy })))
        .not.toThrow();
      expect(assertP5RegistrationContract(compliant({ newEpochPolicy: policy })))
        .toMatchObject({ newEpochPolicy: policy });
    }
    // ... and the guard reaches the coordinator's own validator to say so, so a
    // second enum cannot be grown in `appLifecycleWork.js`.
    expect(() => assertP5RegistrationContract(compliant({ newEpochPolicy: 'TERMINATE' })))
      .toThrow(/supported new-epoch policy/);
    expect(() => validateRegistrationSemantics({
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      newEpochPolicy: 'TERMINATE',
      budget: { items: 1 },
    })).toThrow(/supported new-epoch policy/);
  });

  it.each([
    ['a blank jobKey', { jobKey: '   ' }, /requires a stable jobKey/],
    ['a non-string jobKey', { jobKey: 7 }, /requires a stable jobKey/],
    ['empty trigger origins', { triggerOrigins: [] }, /requires declared trigger origins/],
    ['a non-array trigger origin', { triggerOrigins: 'resume' }, /requires declared trigger origins/],
    ['an unsupported trigger origin', { triggerOrigins: ['whenever'] }, /unsupported trigger origin/],
    ['an unsupported work extent', { workExtent: 'everything' }, /supported work extent/],
    ['an unsupported work class', { workClass: 'HIGH_PRIORITY' }, /unsupported semantic work class/],
  ])('rejects %s', (_label, override, expected) => {
    expect(() => assertP5RegistrationContract(compliant(override))).toThrow(expected);
  });

  it('keeps explicit non-lifecycle full-history work legal', () => {
    // The prohibition is on *lifecycle-triggered* full history, not on the
    // existence of explicit full-history operations.
    const explicit = compliant({
      workExtent: APP_WORK_EXTENTS.FULL_HISTORY,
      triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.EXPLICIT_USER],
      workClass: APP_WORK_CLASSES.INTERACTIVE_EXPLICIT,
    });
    expect(assertP5RegistrationContract(explicit)).toMatchObject({
      workExtent: APP_WORK_EXTENTS.FULL_HISTORY,
      triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.EXPLICIT_USER],
    });

    for (const origin of [
      APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,
      APP_WORK_TRIGGER_ORIGINS.RESUME,
      APP_WORK_TRIGGER_ORIGINS.PAGE_OPEN,
    ]) {
      expect(() => assertP5RegistrationContract(compliant({
        workExtent: APP_WORK_EXTENTS.FULL_HISTORY,
        triggerOrigins: [origin],
      }))).toThrow(/Full-history work cannot be registered/);
    }
  });
});
