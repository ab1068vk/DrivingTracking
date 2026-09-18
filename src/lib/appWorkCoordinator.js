/**
 * P4 application work coordinator foundation.
 *
 * It owns application admission and bounded-turn mechanics only; domain
 * storage, checkpoints, retries, crypto, and durability stay elsewhere.
 */

export const APP_WORK_CLASSES = Object.freeze({
  DURABILITY_CRITICAL_NATIVE_OWNED: 'DURABILITY_CRITICAL_NATIVE_OWNED',
  INTERACTIVE_EXPLICIT: 'INTERACTIVE_EXPLICIT',
  SUSPENDIBLE_BACKGROUND: 'SUSPENDIBLE_BACKGROUND',
});

export const APP_WORK_TURN_RESULTS = Object.freeze({
  DONE: 'done',
  HAS_MORE: 'hasMore',
  DEFERRED: 'deferred',
  BACKOFF: 'backoff',
  FAILING: 'failing',
  OBSOLETE: 'obsolete',
});

export const APP_WORK_NEW_EPOCH_POLICIES = Object.freeze({
  PRESERVE_INSTANCE: 'PRESERVE_INSTANCE',
  TERMINATE_AND_READMIT: 'TERMINATE_AND_READMIT',
});

const WORK_CLASS_VALUES = new Set(Object.values(APP_WORK_CLASSES));
const TURN_RESULT_VALUES = new Set(Object.values(APP_WORK_TURN_RESULTS));
const NEW_EPOCH_POLICY_VALUES = new Set(Object.values(APP_WORK_NEW_EPOCH_POLICIES));
const TERMINAL_OUTCOMES = new Set([
  APP_WORK_TURN_RESULTS.DONE,
  APP_WORK_TURN_RESULTS.FAILING,
  APP_WORK_TURN_RESULTS.OBSOLETE,
]);
const ACTIVE_FOLLOW_UP_STATES = new Set(['running', 'yielded', 'continuing']);

const DEFAULT_TELEMETRY_LIMIT = 128;
const DEFAULT_DRAIN_TURN_LIMIT = 10_000;
/**
 * M20: coordinator-level admission attempt policy only. Domain systems keep
 * their own durable retry state, attempt counts, classification and quarantine;
 * this ceiling governs how many times the *scheduler* re-admits a job whose
 * turns keep failing, so a broken job cannot retry forever.
 */
const DEFAULT_FAILURE_CEILING = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
/** Bounded per-epoch background-complete history. */
const EPOCH_HISTORY = 16;
/**
 * M6/DN13. A background instance that has waited this long gets exactly one
 * bounded admission opportunity even while interactive work keeps arriving.
 * This is an aging deadline, not a weight or a ratio.
 */
const DEFAULT_BACKGROUND_DEADLINE_MS = 2_000;
/**
 * DN13(c). The declared interactive latency gate, kept as an *observational*
 * expectation only.
 *
 * The latency guarantee is structural, not numeric: an aged background
 * admission costs at most one bounded background turn before pending
 * interactive work regains precedence (see `_dequeueNext`). This number
 * therefore enforces nothing at registration time - P4-A fixed elapsed
 * `timeMs` as a yield/telemetry target whose overrun can never invalidate a
 * safe `done`/`hasMore`, and a declared time target is optional in the first
 * place, so rejecting a declaration for exceeding it would reject a legitimate
 * bounded job while an identical job that declares no target passed freely.
 *
 * What it does instead is give the declared gate a truthful measurement: an
 * interactive turn whose queue wait exceeded it is marked in telemetry, so the
 * claim is observed rather than asserted.
 */
const DEFAULT_INTERACTIVE_LATENCY_GATE_MS = 250;
const MAX_ADMISSION_TOKEN_FIELDS = 16;
const MAX_ADMISSION_TOKEN_TEXT = 256;

export class AppWorkBudgetExceededError extends Error {
  constructor(dimension, declared, attempted) {
    super(`Application work turn exceeded ${dimension} budget (${attempted} > ${declared})`);
    this.name = 'AppWorkBudgetExceededError';
    this.code = 'APP_WORK_BUDGET_EXCEEDED';
    this.dimension = dimension;
    this.declared = declared;
    this.attempted = attempted;
  }
}

/**
 * P4-C-F10. A violation of the *coordinator's own* turn contract: a malformed
 * turn result, a deferred/backoff outcome with no typed wake, an unusable
 * admission decision or token, or a domain misuse of a coordinator-supplied
 * API. Ownership - not JavaScript error class - is what makes a failure
 * immediately terminal, so this is raised only from coordinator-owned
 * validation. It extends `TypeError` because that is what the contract has
 * always surfaced to callers, and the classification now keys on this type
 * rather than on `TypeError` itself, so a `TypeError` escaping domain code
 * stays an ordinary retryable domain failure.
 */
export class AppWorkContractViolationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'AppWorkContractViolationError';
    this.code = 'APP_WORK_CONTRACT_VIOLATION';
  }
}

export class AppWorkAccountingContractError extends Error {
  constructor(message = 'Application work turn did not report its accounting disposition') {
    super(message);
    this.name = 'AppWorkAccountingContractError';
    this.code = 'APP_WORK_ACCOUNTING_REQUIRED';
  }
}

class FixedTelemetryRing {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit) || DEFAULT_TELEMETRY_LIMIT));
    this.rows = new Array(this.limit);
    this.count = 0;
    this.writeIndex = 0;
    this.dropped = 0;
  }

  push(row) {
    if (this.count === this.limit) this.dropped += 1;
    else this.count += 1;
    this.rows[this.writeIndex] = Object.freeze(row);
    this.writeIndex = (this.writeIndex + 1) % this.limit;
  }

  snapshot() {
    const values = [];
    const start = this.count < this.limit ? 0 : this.writeIndex;
    for (let index = 0; index < this.count; index += 1) {
      values.push(this.rows[(start + index) % this.limit]);
    }
    return Object.freeze({
      limit: this.limit,
      dropped: this.dropped,
      events: Object.freeze(values),
    });
  }
}

const finiteLimit = (value, name) => {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new TypeError(`Application work ${name} budget must be a non-negative finite number`);
  }
  return numeric;
};

const normalizeBudget = (budget, workClass) => {
  if (!budget || typeof budget !== 'object') {
    if (workClass === APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND) {
      throw new TypeError('Suspendible background jobs require a declared turn budget');
    }
    budget = {};
  }
  const turns = finiteLimit(budget.turns, 'turns');
  if (turns !== null && (!Number.isSafeInteger(turns) || turns === 0)) {
    throw new TypeError('Application work turns budget must be a positive safe integer');
  }
  const normalized = Object.freeze({
    timeMs: finiteLimit(budget.timeMs, 'timeMs'),
    items: finiteLimit(budget.items, 'items'),
    bytes: finiteLimit(budget.bytes, 'bytes'),
    work: finiteLimit(budget.work, 'work'),
    turns,
  });
  const declaredDimensions = Object.values(normalized).filter((value) => value !== null);
  if (
    workClass === APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND &&
    declaredDimensions.length === 0
  ) {
    throw new TypeError('Suspendible background jobs require at least one finite turn-budget dimension');
  }
  if (declaredDimensions.length > 0 && declaredDimensions.every((value) => value === 0)) {
    throw new TypeError('Application work budget must permit progress in at least one dimension');
  }
  return normalized;
};

/**
 * P4-D-F05 — the single source of truth for registration semantics.
 *
 * `registerJob` below calls this, and so does the frozen P5-P7 contract guard
 * in `appLifecycleWork.js`. There is deliberately no second work-class set, no
 * second new-epoch policy enum and no second budget law anywhere: a future
 * declaration the coordinator would reject cannot be certified by the contract
 * guard, because both ask this one function.
 *
 * Pure: it validates and normalizes, and touches no coordinator state.
 */
export function validateRegistrationSemantics({ workClass, newEpochPolicy, budget } = {}) {
  if (!WORK_CLASS_VALUES.has(workClass)) {
    throw new TypeError(`Unsupported application work class: ${workClass}`);
  }
  if (!NEW_EPOCH_POLICY_VALUES.has(newEpochPolicy)) {
    throw new TypeError('Every coordinator job must declare a supported new-epoch policy');
  }
  return Object.freeze({
    workClass,
    newEpochPolicy,
    budget: normalizeBudget(budget, workClass),
  });
}

/**
 * P4-B-F01-3-A. Domain follow-up is an explicit registration capability, not an
 * ambient coordinator power.
 *
 * A registration that declares nothing here cannot be domain-followed-up at
 * all, and one that declares reasons can only be followed up for exactly the
 * domain events it named. The allowlist is a frozen array fixed at
 * registration time - deliberately not a caller-supplied token or capability
 * object, so no arbitrary caller can mint the authority at admission time.
 */
const NO_DOMAIN_FOLLOW_UP_REASONS = Object.freeze([]);

const normalizeDomainFollowUpReasons = (reasons, workClass) => {
  if (reasons === null || reasons === undefined) return NO_DOMAIN_FOLLOW_UP_REASONS;
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new TypeError('Declared domain follow-up reasons must be a non-empty array of domain event names');
  }
  if (workClass === APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED) {
    throw new TypeError('Native-owned durability work cannot declare domain follow-up reasons');
  }
  const normalized = reasons.map((reason) => {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new TypeError('Every declared domain follow-up reason must be a non-empty string');
    }
    return reason.trim();
  });
  return Object.freeze([...new Set(normalized)]);
};

const normalizeEpoch = (epoch) => {
  const numeric = Number(epoch);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TypeError('Application work lifecycle epoch must be a non-negative safe integer');
  }
  return numeric;
};

const normalizeWake = (outcome, wake) => {
  if (!wake || typeof wake !== 'object' || typeof wake.type !== 'string' || !wake.type.trim()) {
    throw new AppWorkContractViolationError(`${outcome} requires a typed wake condition`);
  }
  if (outcome === APP_WORK_TURN_RESULTS.BACKOFF) {
    const eligibleAt = Number(wake.eligibleAt);
    if (!Number.isFinite(eligibleAt)) throw new AppWorkContractViolationError('backoff requires a finite wake.eligibleAt');
  }
  return Object.freeze({
    type: wake.type.trim(),
    ...(wake.key === undefined ? {} : { key: String(wake.key) }),
    ...(wake.eligibleAt === undefined ? {} : { eligibleAt: Number(wake.eligibleAt) }),
  });
};

const normalizeTurnResult = (result) => {
  const value = typeof result === 'string' ? { outcome: result } : result;
  if (!value || typeof value !== 'object' || !TURN_RESULT_VALUES.has(value.outcome)) {
    throw new AppWorkContractViolationError('A bounded turn must return exactly one supported turn outcome');
  }
  if (
    value.outcome === APP_WORK_TURN_RESULTS.DEFERRED ||
    value.outcome === APP_WORK_TURN_RESULTS.BACKOFF
  ) {
    return Object.freeze({ outcome: value.outcome, wake: normalizeWake(value.outcome, value.wake) });
  }
  // M20 already distinguishes a transient failure (bounded scheduler backoff)
  // from one no re-admission can fix (immediate terminal). A domain that has
  // spent its own bounded retry allowance knows it is in the second case, so it
  // may say so; omitting the flag keeps the historical retryable behaviour.
  if (value.outcome === APP_WORK_TURN_RESULTS.FAILING && value.retryable === false) {
    return Object.freeze({ outcome: value.outcome, retryable: false });
  }
  return Object.freeze({ outcome: value.outcome });
};

const normalizeAdmissionToken = (token) => {
  if (!token || typeof token !== 'object' || Array.isArray(token)) {
    throw new AppWorkContractViolationError('Authority-sensitive work requires a bounded admission token object');
  }
  const entries = Object.entries(token);
  if (!entries.length || entries.length > MAX_ADMISSION_TOKEN_FIELDS) {
    throw new AppWorkContractViolationError('Admission tokens must contain 1-16 scalar fields');
  }
  const normalized = {};
  for (const [key, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!key || key.length > 64 || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new AppWorkContractViolationError('Admission tokens may contain only bounded scalar fields');
    }
    if (typeof value === 'string' && value.length > MAX_ADMISSION_TOKEN_TEXT) {
      throw new AppWorkContractViolationError('Admission token text is too large');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new AppWorkContractViolationError('Admission token numbers must be finite');
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
};

const admissionTokenKey = (token) => JSON.stringify(token);

const normalizeAdmissionDecision = (decision) => {
  if (!decision || typeof decision !== 'object') {
    throw new AppWorkContractViolationError('Admission guard must return a typed decision');
  }
  if (decision.outcome === 'ready') {
    const token = normalizeAdmissionToken(decision.token);
    return Object.freeze({ outcome: 'ready', token, tokenKey: admissionTokenKey(token) });
  }
  if (decision.outcome === APP_WORK_TURN_RESULTS.OBSOLETE) {
    return Object.freeze({ outcome: APP_WORK_TURN_RESULTS.OBSOLETE });
  }
  if (
    decision.outcome === APP_WORK_TURN_RESULTS.DEFERRED ||
    decision.outcome === APP_WORK_TURN_RESULTS.BACKOFF
  ) {
    return Object.freeze({
      outcome: decision.outcome,
      wake: normalizeWake(decision.outcome, decision.wake),
    });
  }
  throw new AppWorkContractViolationError(`Unsupported admission decision: ${String(decision.outcome)}`);
};

const wakeMatches = (wake, signal, now) => {
  if (!wake) return false;
  if (wake.type === 'time' && Number.isFinite(wake.eligibleAt) && now >= wake.eligibleAt) return true;
  if (!signal || signal.type !== wake.type) return false;
  return wake.key === undefined || String(signal.key) === wake.key;
};

const createBudgetTracker = (declared, now) => {
  const startedAt = now();
  const consumed = { turns: 1, items: 0, bytes: 0, work: 0 };
  let accountingDisposition = null;

  const elapsedMs = () => Math.max(0, Number(now()) - Number(startedAt));
  const checkDimension = (dimension, delta) => {
    const numeric = Number(delta) || 0;
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new AppWorkContractViolationError(`Consumed ${dimension} must be a non-negative finite number`);
    }
    const attempted = consumed[dimension] + numeric;
    const limit = declared[dimension];
    if (limit !== null && attempted > limit) {
      throw new AppWorkBudgetExceededError(dimension, limit, attempted);
    }
    return { numeric, attempted };
  };

  const tryConsume = (delta = {}) => {
    if (accountingDisposition === 'zero') {
      throw new AppWorkAccountingContractError('Cannot consume work after reporting explicit zero work');
    }
    try {
      for (const dimension of ['items', 'bytes', 'work']) checkDimension(dimension, delta[dimension]);
    } catch (error) {
      if (error instanceof AppWorkBudgetExceededError) return false;
      throw error;
    }
    for (const dimension of ['items', 'bytes', 'work']) {
      consumed[dimension] += Number(delta[dimension]) || 0;
    }
    if (['items', 'bytes', 'work'].some((dimension) => (Number(delta[dimension]) || 0) > 0)) {
      accountingDisposition = 'reported';
    }
    return true;
  };

  const consume = (delta = {}) => {
    if (accountingDisposition === 'zero') {
      throw new AppWorkAccountingContractError('Cannot consume work after reporting explicit zero work');
    }
    const checked = {};
    for (const dimension of ['items', 'bytes', 'work']) {
      checked[dimension] = checkDimension(dimension, delta[dimension]);
    }
    for (const dimension of ['items', 'bytes', 'work']) {
      consumed[dimension] = checked[dimension].attempted;
    }
    if (['items', 'bytes', 'work'].some((dimension) => checked[dimension].numeric > 0)) {
      accountingDisposition = 'reported';
    }
    return snapshot();
  };

  const reportZeroWork = () => {
    if (accountingDisposition === 'reported') {
      throw new AppWorkAccountingContractError('Cannot report zero work after reporting consumption');
    }
    accountingDisposition = 'zero';
  };

  const assertAccounting = (outcome) => {
    if (outcome !== APP_WORK_TURN_RESULTS.OBSOLETE && accountingDisposition === null) {
      throw new AppWorkAccountingContractError();
    }
  };

  const snapshot = () => Object.freeze({
    turns: consumed.turns,
    items: consumed.items,
    bytes: consumed.bytes,
    work: consumed.work,
    timeMs: elapsedMs(),
    accounting: accountingDisposition || 'missing',
  });

  return Object.freeze({
    declared,
    tryConsume,
    consume,
    reportZeroWork,
    assertAccounting,
    snapshot,
  });
};

const createCompletion = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

export class AppWorkCoordinator {
  constructor({
    now = () => Date.now(),
    yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
    scheduleDispatch = (callback) => queueMicrotask(callback),
    telemetryLimit = DEFAULT_TELEMETRY_LIMIT,
    autoStart = true,
    failureCeiling = DEFAULT_FAILURE_CEILING,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    backgroundDeadlineMs = DEFAULT_BACKGROUND_DEADLINE_MS,
    interactiveLatencyGateMs = DEFAULT_INTERACTIVE_LATENCY_GATE_MS,
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('Coordinator now must be a function');
    if (typeof yieldControl !== 'function') throw new TypeError('Coordinator yieldControl must be a function');
    if (typeof scheduleDispatch !== 'function') throw new TypeError('Coordinator scheduleDispatch must be a function');
    this.now = now;
    this.yieldControl = yieldControl;
    this.scheduleDispatch = scheduleDispatch;
    this.autoStart = autoStart === true;
    this.telemetry = new FixedTelemetryRing(telemetryLimit);
    this.registry = new Map();
    this.queues = {
      interactive: [],
      critical: [],
      background: [],
    };
    this.nextInstanceId = 1;
    this.pumpScheduled = false;
    this.pumping = false;
    this.turnInProgress = false;
    this.backgroundYieldRequired = false;
    this.effectiveForeground = true;
    this.lifecycleEpoch = 0;
    this.failureCeiling = Math.max(1, Math.floor(Number(failureCeiling) || DEFAULT_FAILURE_CEILING));
    this.backoffBaseMs = Math.max(1, Math.floor(Number(backoffBaseMs) || DEFAULT_BACKOFF_BASE_MS));
    this.backoffMaxMs = Math.max(this.backoffBaseMs, Math.floor(Number(backoffMaxMs) || DEFAULT_BACKOFF_MAX_MS));
    // M19/DN5: one bounded record per tracked epoch, pruned to the newest few.
    this.epochs = new Map();
    this.publishedEpochs = new Map();
    this.backgroundDeadlineMs = Math.max(0, Math.floor(Number(backgroundDeadlineMs) || 0));
    this.interactiveLatencyGateMs = Math.max(1, Math.floor(Number(interactiveLatencyGateMs) || DEFAULT_INTERACTIVE_LATENCY_GATE_MS));
    this.agedAdmissions = 0;
    /**
     * P4-D-F01. One bit of coordinator-local scheduling state: whether the one
     * aged background opportunity has already been spent since the last
     * interactive opportunity. It carries no domain payload, is never
     * persisted, and is not a counter, ratio or weight - it is only how
     * "exactly one aged exception, then interactive precedence again" is
     * represented.
     */
    this.agedOpportunityConsumed = false;
  }

  /**
   * M19/DN5: `background-complete(E)` over the finite set of logical instances
   * admitted to epoch E. Monotonic — once published true it stays true, and a
   * later wake is a separately observable admission under its own epoch.
   */
  backgroundComplete(epoch) {
    const target = normalizeEpoch(epoch);
    if (this.publishedEpochs.has(target)) return this.publishedEpochs.get(target);
    const record = this.epochs.get(target);
    if (!record) return false;
    for (const instanceId of record.admitted) {
      if (!record.terminal.has(instanceId)) return false;
    }
    const complete = record.admitted.size > 0;
    if (complete) this.publishedEpochs.set(target, true);
    return complete;
  }

  getEpochSnapshot(epoch) {
    const target = normalizeEpoch(epoch);
    const record = this.epochs.get(target);
    return Object.freeze({
      epoch: target,
      admitted: record ? record.admitted.size : 0,
      terminal: record ? record.terminal.size : 0,
      complete: this.backgroundComplete(target),
      published: this.publishedEpochs.get(target) === true,
    });
  }

  _epochRecord(epoch) {
    let record = this.epochs.get(epoch);
    if (!record) {
      record = { admitted: new Set(), terminal: new Map() };
      this.epochs.set(epoch, record);
      // Bounded: only the newest EPOCH_HISTORY epochs are retained.
      while (this.epochs.size > EPOCH_HISTORY) {
        const oldest = this.epochs.keys().next().value;
        this.epochs.delete(oldest);
        this.publishedEpochs.delete(oldest);
      }
    }
    return record;
  }

  registerJob({
    jobKey,
    workClass,
    runTurn,
    budget = null,
    newEpochPolicy,
    admissionGuard = null,
    domainFollowUpReasons = null,
  } = {}) {
    if (typeof jobKey !== 'string' || !jobKey.trim()) throw new TypeError('Coordinator jobKey is required');
    if (this.registry.has(jobKey)) throw new Error(`Coordinator job already registered: ${jobKey}`);
    if (!WORK_CLASS_VALUES.has(workClass)) throw new TypeError(`Unsupported application work class: ${workClass}`);
    if (
      workClass === APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED &&
      runTurn !== undefined &&
      runTurn !== null
    ) {
      throw new TypeError('Native-owned durability work is observe-only and cannot provide a coordinator turn');
    }
    if (
      workClass !== APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED &&
      typeof runTurn !== 'function'
    ) {
      throw new TypeError('Coordinator runTurn callback is required');
    }
    // P4-D-F05: policy and budget semantics come from the one shared validator.
    const { budget: normalizedBudget } = validateRegistrationSemantics({
      workClass,
      newEpochPolicy,
      budget,
    });
    // P4-D-F02: there is deliberately no `timeMs > gate` registration
    // exclusion here. Interactive latency is protected by the fairness
    // mechanism in `_dequeueNext` - one bounded aged turn, then interactive
    // precedence again - not by an optional, unenforceable declaration.
    if (admissionGuard !== null && typeof admissionGuard !== 'function') {
      throw new TypeError('Coordinator admissionGuard must be a function');
    }
    const declaredDomainFollowUpReasons = normalizeDomainFollowUpReasons(domainFollowUpReasons, workClass);
    const registration = {
      jobKey,
      workClass,
      runTurn,
      budget: normalizedBudget,
      newEpochPolicy,
      admissionGuard,
      // Immutable, closed allowlist of domain events permitted to hand this
      // job a same-epoch follow-up. Empty means domain follow-up is refused.
      domainFollowUpReasons: declaredDomainFollowUpReasons,
      active: null,
      sleeping: null,
      latestExternalEpoch: null,
      pendingEpoch: null,
      lastTerminal: null,
      // M20 scheduler-level attempt policy. Two scalars, no durable store.
      consecutiveFailures: 0,
      failureCeilingReached: false,
    };
    this.registry.set(jobKey, registration);
    return () => {
      if (registration.active || registration.sleeping) {
        throw new Error(`Cannot unregister active coordinator job: ${jobKey}`);
      }
      this.registry.delete(jobKey);
    };
  }

  setLifecycleState({ effectiveForeground, epoch } = {}) {
    const nextEpoch = normalizeEpoch(epoch);
    this.effectiveForeground = effectiveForeground === true;
    this.lifecycleEpoch = Math.max(this.lifecycleEpoch, nextEpoch);
    if (this.effectiveForeground) this._requestPump();
    return Object.freeze({
      effectiveForeground: this.effectiveForeground,
      epoch: this.lifecycleEpoch,
    });
  }

  invalidateJob(jobKey, { reason = 'authority_changed' } = {}) {
    const registration = this.registry.get(jobKey);
    if (!registration) throw new Error(`Coordinator job is not registered: ${jobKey}`);
    const active = registration.active;
    if (!active) return false;
    active.forcedObsoleteReason = String(reason || 'authority_changed').slice(0, 128);
    this._requestPump();
    return true;
  }

  admit(jobKey, { epoch, trigger = 'external', wake = null } = {}) {
    const registration = this.registry.get(jobKey);
    if (!registration) throw new Error(`Coordinator job is not registered: ${jobKey}`);
    if (registration.workClass === APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED) {
      throw new Error(`Native-owned durability work is observe-only and cannot be admitted: ${jobKey}`);
    }
    const admittedEpoch = normalizeEpoch(epoch);

    if (registration.sleeping) {
      const sleepingInstance = registration.sleeping.instance;
      if (admittedEpoch < sleepingInstance.epoch) {
        return this._admissionResult('coalesced_stale_epoch', sleepingInstance);
      }
      const laterEpoch = admittedEpoch > sleepingInstance.epoch;
      const wakeSatisfied = wakeMatches(registration.sleeping.wake, wake, this.now());
      const timeWakePending = registration.sleeping.wake.type === 'time' &&
        !wakeSatisfied;
      if ((!laterEpoch || timeWakePending) && !wakeSatisfied) {
        return this._admissionResult('coalesced_wake', sleepingInstance);
      }
      const pendingRescopeEpoch = sleepingInstance.pendingRescopeEpoch;
      const wakeEpoch = pendingRescopeEpoch === null
        ? admittedEpoch
        : Math.max(admittedEpoch, pendingRescopeEpoch);
      registration.sleeping = null;
      const instance = this._createInstance(registration, wakeEpoch, 'wake');
      return this._admissionResult('admitted_wake', instance);
    }

    const active = registration.active;
    if (active) {
      if (admittedEpoch < active.epoch) return this._admissionResult('coalesced_stale_epoch', active);
      if (admittedEpoch > active.epoch) {
        if (registration.newEpochPolicy === APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE) {
          active.pendingRescopeEpoch = Math.max(active.pendingRescopeEpoch ?? admittedEpoch, admittedEpoch);
          if (active.state === 'queued') {
            const rescopedTo = active.pendingRescopeEpoch;
            active.pendingRescopeEpoch = null;
            this._rescopeInstanceEpoch(active, rescopedTo);
          }
          return this._admissionResult('coalesced_rescoped_epoch', active);
        }
        registration.pendingEpoch = Math.max(registration.pendingEpoch ?? admittedEpoch, admittedEpoch);
        return this._admissionResult('followup_new_epoch', active);
      }

      if (ACTIVE_FOLLOW_UP_STATES.has(active.state)) {
        active.followUpRequested = true;
        return this._admissionResult('followup_recorded', active);
      }
      return this._admissionResult('coalesced_queued', active);
    }

    if (
      registration.latestExternalEpoch !== null &&
      admittedEpoch <= registration.latestExternalEpoch
    ) {
      return Object.freeze({
        status: admittedEpoch === registration.latestExternalEpoch ? 'already_admitted' : 'stale_epoch',
        jobKey,
        epoch: admittedEpoch,
        instanceId: registration.lastTerminal?.instanceId || null,
        completion: Promise.resolve(registration.lastTerminal),
      });
    }

    const instance = this._createInstance(registration, admittedEpoch, String(trigger || 'external'));
    return this._admissionResult('admitted', instance);
  }

  /**
   * A domain-owned follow-up admission for work this coordinator already ran in
   * the current epoch.
   *
   * P4-B-F01-3-A. `admit` is the *lifecycle* entry point and enforces one
   * external admission per job per epoch: once an instance has settled,
   * re-admitting the same epoch answers `already_admitted` and creates nothing.
   * That law is correct for lifecycle triggers and is not changed here. It
   * simply cannot express the different fact a domain reports through this
   * method - "the precondition that made the settled instance defer part of its
   * obligation is now satisfied" - which is why this is a separately named,
   * explicitly domain-completion-scoped entry point rather than a weakening of
   * `admit`.
   *
   * It is deliberately narrow:
   *
   *  - it never advances, rescopes or invents a lifecycle epoch; the follow-up
   *    runs under the epoch the job already holds, so epoch authority and the
   *    published `background-complete(E)` snapshot are untouched;
   *  - it never creates a second concurrent instance: an active or queued
   *    instance coalesces exactly as a same-epoch lifecycle admission does, so
   *    repeated completion signals produce one reconciliation, not a storm;
   *  - it cannot be used for native-owned durability work;
   *  - and it is refused outright unless the *registration* declared this exact
   *    domain event in `domainFollowUpReasons`. Default is deny: a job that
   *    declares nothing has no follow-up entry point, so this is not a general
   *    same-epoch run-again for arbitrary callers. The authorization check runs
   *    before any state is read for mutation, so a refused call is entirely
   *    side-effect free - it does not wake a sleeping registration, discard or
   *    rewrite its typed wake, create an instance, or touch epoch/admission
   *    state.
   */
  admitDomainFollowUp(jobKey, { reason = 'domain_followup' } = {}) {
    const registration = this.registry.get(jobKey);
    if (!registration) throw new Error(`Coordinator job is not registered: ${jobKey}`);
    if (registration.workClass === APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED) {
      throw new Error(`Native-owned durability work is observe-only and cannot be admitted: ${jobKey}`);
    }
    const requestedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!requestedReason || !registration.domainFollowUpReasons.includes(requestedReason)) {
      return this._unauthorizedDomainFollowUp(registration, requestedReason);
    }
    const active = registration.active;
    if (active) {
      if (ACTIVE_FOLLOW_UP_STATES.has(active.state)) {
        active.followUpRequested = true;
        return this._admissionResult('followup_recorded', active);
      }
      return this._admissionResult('coalesced_queued', active);
    }
    const sleeping = registration.sleeping?.instance || null;
    const epoch = sleeping
      ? sleeping.epoch
      : Math.max(this.lifecycleEpoch, registration.latestExternalEpoch ?? this.lifecycleEpoch);
    registration.sleeping = null;
    const instance = this._createInstance(registration, epoch, requestedReason.slice(0, 64));
    return this._admissionResult('admitted_domain_followup', instance);
  }

  /**
   * A refusal, reported rather than thrown so a domain caller can inspect the
   * status exactly as it inspects a coalescing one. It reads state only; it
   * mutates nothing.
   */
  _unauthorizedDomainFollowUp(registration, reason) {
    const current = registration.active || registration.sleeping?.instance || null;
    return Object.freeze({
      status: 'domain_followup_unauthorized',
      jobKey: registration.jobKey,
      epoch: current ? current.epoch : (registration.latestExternalEpoch ?? this.lifecycleEpoch),
      instanceId: null,
      reason: reason || null,
      completion: Promise.resolve(registration.lastTerminal),
    });
  }

  async runNextTurn() {
    if (this.turnInProgress) throw new Error('A coordinator turn is already running');
    this.turnInProgress = true;
    try {
      return await this._runNextTurnExclusive();
    } finally {
      this.turnInProgress = false;
    }
  }

  async _runNextTurnExclusive() {
    if (
      this.backgroundYieldRequired &&
      this.queues.interactive.length === 0 &&
      this.queues.background.length > 0
    ) {
      await this.yieldControl();
      this.backgroundYieldRequired = false;
      for (const instance of this.queues.background) {
        if (instance.state === 'yielded') instance.state = 'continuing';
      }
    }

    const instance = this._dequeueNext();
    if (!instance) return null;
    const result = await this._executeTurn(instance);
    if (instance.registration.workClass === APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND) {
      // Hold this across an empty queue as well: whenever another background
      // turn arrives, it must cross an actual scheduler-yield boundary first.
      this.backgroundYieldRequired = true;
      if (instance.queued && instance.state === 'continuing') instance.state = 'yielded';
    }
    return result;
  }

  observeNativeOwned(jobKey, { epoch, state = 'observed' } = {}) {
    const registration = this.registry.get(jobKey);
    if (!registration) throw new Error(`Coordinator job is not registered: ${jobKey}`);
    if (registration.workClass !== APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED) {
      throw new TypeError(`Coordinator job is not native-owned observation work: ${jobKey}`);
    }
    const observedEpoch = normalizeEpoch(epoch);
    this.telemetry.push({
      jobKey,
      instanceId: null,
      lifecycleEpoch: observedEpoch,
      turnCount: 0,
      workClass: registration.workClass,
      queueWaitMs: 0,
      declaredBudget: registration.budget,
      consumedBudget: Object.freeze({ turns: 0, items: 0, bytes: 0, work: 0, timeMs: 0 }),
      turnOutcome: null,
      convergenceState: String(state || 'observed'),
      backlog: this._queueDepth(),
      failed: false,
    });
  }

  async drain({ maxTurns = DEFAULT_DRAIN_TURN_LIMIT } = {}) {
    const limit = Math.max(1, Math.floor(Number(maxTurns) || DEFAULT_DRAIN_TURN_LIMIT));
    const turnsByJob = new Map();
    let turns = 0;
    let turnBudgetExhausted = false;
    while (this._hasQueuedWork() && turns < limit) {
      const result = await this.runNextTurn();
      if (!result) break;
      turns += 1;
      const jobTurns = (turnsByJob.get(result.jobKey) || 0) + 1;
      turnsByJob.set(result.jobKey, jobTurns);
      const registration = this.registry.get(result.jobKey);
      if (
        registration?.budget.turns !== null &&
        jobTurns >= registration.budget.turns &&
        registration.active?.queued
      ) {
        // The scheduler run ends, but the same logical instance remains at the
        // tail for a later yielded run. A turns budget is never terminal work.
        turnBudgetExhausted = true;
        break;
      }
    }
    return Object.freeze({ turns, hasMore: this._hasQueuedWork(), turnBudgetExhausted });
  }

  getJobSnapshot(jobKey) {
    const registration = this.registry.get(jobKey);
    if (!registration) return null;
    const active = registration.active;
    return Object.freeze({
      jobKey,
      workClass: registration.workClass,
      newEpochPolicy: registration.newEpochPolicy,
      active: active ? Object.freeze({
        instanceId: active.instanceId,
        epoch: active.epoch,
        state: active.state,
        turnCount: active.turnCount,
        followUpRequested: active.followUpRequested,
      }) : null,
      wake: registration.sleeping?.wake || active?.pendingWake || null,
      pendingEpoch: registration.pendingEpoch,
      lastTerminal: registration.lastTerminal,
      consecutiveFailures: registration.consecutiveFailures,
      failing: registration.failureCeilingReached,
    });
  }

  getCoordinatorSnapshot() {
    let activeInstances = 0;
    let sleepingInstances = 0;
    for (const registration of this.registry.values()) {
      if (registration.active) activeInstances += 1;
      if (registration.sleeping) sleepingInstances += 1;
    }
    return Object.freeze({
      registeredJobs: this.registry.size,
      lifecycleEpoch: this.lifecycleEpoch,
      activeInstances,
      sleepingInstances,
      backlog: this._queueDepth(),
      runnableBacklog: this._runnableQueueDepth(),
      effectiveForeground: this.effectiveForeground,
      telemetry: Object.freeze({
        limit: this.telemetry.limit,
        count: this.telemetry.count,
        dropped: this.telemetry.dropped,
      }),
    });
  }

  getTelemetrySnapshot() {
    return this.telemetry.snapshot();
  }

  _createInstance(registration, epoch, trigger) {
    const completion = createCompletion();
    const instance = {
      registration,
      instanceId: `${registration.jobKey}:${epoch}:${this.nextInstanceId}`,
      epoch,
      trigger,
      state: 'queued',
      queued: false,
      queuedAt: this.now(),
      turnCount: 0,
      followUpRequested: false,
      pendingRescopeEpoch: null,
      pendingWake: null,
      admittedByAging: false,
      admissionToken: null,
      admissionTokenKey: null,
      forcedObsoleteReason: null,
      criticalDepth: 0,
      completion,
    };
    this.nextInstanceId += 1;
    registration.latestExternalEpoch = Math.max(registration.latestExternalEpoch ?? epoch, epoch);
    // M19: this instance joins the finite admitted set for its epoch. A later
    // wake creates its own instance under its own epoch and cannot reopen a
    // snapshot that has already been published.
    this._epochRecord(epoch).admitted.add(instance.instanceId);
    registration.active = instance;
    this._enqueue(instance);
    this._requestPump();
    return instance;
  }

  _admissionResult(status, instance) {
    return Object.freeze({
      status,
      jobKey: instance.registration.jobKey,
      epoch: instance.epoch,
      instanceId: instance.instanceId,
      completion: instance.completion.promise,
    });
  }

  _queueFor(workClass) {
    if (workClass === APP_WORK_CLASSES.INTERACTIVE_EXPLICIT) return this.queues.interactive;
    if (workClass === APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED) return this.queues.critical;
    return this.queues.background;
  }

  _enqueue(instance) {
    if (instance.queued) return;
    instance.queued = true;
    instance.queuedAt = this.now();
    this._queueFor(instance.registration.workClass).push(instance);
  }

  /**
   * M6/DN13 fairness, in four deterministic parts and no numeric priority:
   *
   * (a) interactive/explicit work is served before the next ordinary
   *     suspendible background turn;
   * (b) a background instance that has waited longer than the declared
   *     background deadline gets exactly one bounded admission opportunity,
   *     so it still converges under sustained interactive traffic;
   * (c) P4-D-F01 - that opportunity is *one* turn. Once it has been spent,
   *     pending interactive work regains precedence before any further aged
   *     opportunity is evaluated, so two aged background admissions can never
   *     run back to back while runnable interactive work is still waiting.
   *     This is what makes the delay one bounded background turn rather than
   *     one per overdue registration: aging is recomputed from the background
   *     head, and without (c) the *next* overdue head simply inherited the
   *     exception;
   * (d) an interactive opportunity restores the exception. Neither side can
   *     starve: interactive waits at most one bounded background turn, and a
   *     background head that keeps ageing gets one turn after every
   *     interactive turn.
   *
   * There is no weighting, no ratio, no token bucket and no class number
   * anywhere in this: the decisions are `age >= deadline` against the
   * injectable clock, and a single boolean saying whether the one exception is
   * currently spent.
   */
  _backgroundIsOverdue() {
    const head = this.queues.background[0];
    if (!head) return false;
    return Number(this.now()) - Number(head.queuedAt) >= this.backgroundDeadlineMs;
  }

  _dequeueNext() {
    const backgroundRunnable = this.effectiveForeground && this.queues.background.length > 0;
    const aged = backgroundRunnable &&
      this.queues.interactive.length > 0 &&
      // (c): the single aged exception is not available again until interactive
      // precedence has actually been restored by an interactive turn.
      !this.agedOpportunityConsumed &&
      this._backgroundIsOverdue();
    if (aged) {
      this.agedAdmissions += 1;
      this.agedOpportunityConsumed = true;
    }

    const queue = aged
      ? this.queues.background
      : this.queues.interactive.length
        ? this.queues.interactive
        : this.queues.critical.length
          ? this.queues.critical
          : backgroundRunnable
            ? this.queues.background
            : [];
    const instance = queue.shift() || null;
    if (instance) {
      instance.queued = false;
      instance.admittedByAging = aged;
      // (d): an interactive opportunity occurred, so aging may be evaluated
      // again on the next admission decision.
      if (queue === this.queues.interactive) this.agedOpportunityConsumed = false;
    }
    return instance;
  }

  _hasQueuedWork() {
    return this.queues.interactive.length > 0 ||
      this.queues.critical.length > 0 ||
      this.queues.background.length > 0;
  }

  _hasRunnableWork() {
    return this.queues.interactive.length > 0 ||
      this.queues.critical.length > 0 ||
      (this.effectiveForeground && this.queues.background.length > 0);
  }

  _queueDepth() {
    return this.queues.interactive.length + this.queues.critical.length + this.queues.background.length;
  }

  _runnableQueueDepth() {
    return this.queues.interactive.length + this.queues.critical.length +
      (this.effectiveForeground ? this.queues.background.length : 0);
  }

  _requestPump() {
    if (!this.autoStart || !this._hasRunnableWork() || this.pumpScheduled || this.pumping) return;
    this.pumpScheduled = true;
    this.scheduleDispatch(() => {
      this.pumpScheduled = false;
      void this._pump();
    });
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.drain();
    } finally {
      this.pumping = false;
      if (this._hasRunnableWork()) this._requestPump();
    }
  }

  async _executeTurn(instance) {
    const registration = instance.registration;
    if (instance.pendingRescopeEpoch !== null) {
      const rescopedTo = instance.pendingRescopeEpoch;
      instance.pendingRescopeEpoch = null;
      // The new epoch owns this identity before its first turn under that epoch
      // executes, never after (P4-C-F11).
      this._rescopeInstanceEpoch(instance, rescopedTo);
    }
    instance.pendingWake = null;
    instance.state = 'running';
    instance.turnCount += 1;
    const turnEpoch = instance.epoch;
    const startedAt = this.now();
    const queueWaitMs = Math.max(0, Number(startedAt) - Number(instance.queuedAt));
    const budget = createBudgetTracker(registration.budget, this.now);
    let result;
    let error = null;
    let admissionRefusal = false;

    try {
      if (instance.forcedObsoleteReason !== null) {
        admissionRefusal = true;
        result = Object.freeze({ outcome: APP_WORK_TURN_RESULTS.OBSOLETE });
      } else if (registration.admissionGuard) {
        const decision = normalizeAdmissionDecision(await registration.admissionGuard(Object.freeze({
          jobKey: registration.jobKey,
          instanceId: instance.instanceId,
          lifecycleEpoch: turnEpoch,
          turnNumber: instance.turnCount,
          capturedToken: instance.admissionToken,
        })));
        if (decision.outcome !== 'ready') {
          admissionRefusal = true;
          result = decision;
        } else if (
          instance.admissionTokenKey !== null &&
          decision.tokenKey !== instance.admissionTokenKey
        ) {
          admissionRefusal = true;
          result = Object.freeze({ outcome: APP_WORK_TURN_RESULTS.OBSOLETE });
        } else {
          if (instance.admissionToken === null) {
            instance.admissionToken = decision.token;
            instance.admissionTokenKey = decision.tokenKey;
          }
        }
      }

      if (!result) {
        const criticalSection = Object.freeze({
          run: async (callback) => {
            if (typeof callback !== 'function') throw new AppWorkContractViolationError('Critical section callback is required');
            instance.criticalDepth += 1;
            try {
              return await callback();
            } finally {
              instance.criticalDepth -= 1;
            }
          },
        });
        result = normalizeTurnResult(await registration.runTurn(Object.freeze({
          jobKey: registration.jobKey,
          instanceId: instance.instanceId,
          lifecycleEpoch: turnEpoch,
          turnNumber: instance.turnCount,
          workClass: registration.workClass,
          admissionToken: instance.admissionToken,
          budget,
          criticalSection,
        })));
        budget.assertAccounting(result.outcome);
      }
    } catch (caught) {
      error = caught;
      result = Object.freeze({ outcome: APP_WORK_TURN_RESULTS.FAILING });
    }

    // M20: scheduler-level attempt policy. A turn that failed for a reason the
    // coordinator owns is retried with bounded backoff until the ceiling, then
    // surfaced as `failing` and not retried again. Domain retry state, attempt
    // counts and quarantine are untouched and remain authoritative.
    // A violation of the coordinator's own contract — an unreported or
    // over-budget turn, a malformed result, a missing wake — is a defect in the
    // job, not a transient condition. Retrying it identically would only hide
    // it, so it stays an immediate typed `failing` (P4-A F03/F04).
    //
    // P4-C-F10: the test is *ownership*, not JavaScript error class. Only
    // errors raised by coordinator-owned validation qualify; a `TypeError` that
    // merely escaped the domain callback (a parser, an API shape, a null
    // dereference in domain code) is an ordinary domain failure and gets the
    // bounded retry policy every other domain failure gets. A domain that knows
    // its failure is permanent still says so with `retryable: false`.
    const contractViolation = error instanceof AppWorkBudgetExceededError ||
      error instanceof AppWorkAccountingContractError ||
      error instanceof AppWorkContractViolationError;
    // A turn that declared its failure non-retryable has already exhausted the
    // domain's own bounded allowance. Scheduling another scheduler-level retry
    // would only park it on a wake nothing can satisfy, so it takes the same
    // immediate-terminal path a contract violation does.
    const nonRetryableFailure = result.outcome === APP_WORK_TURN_RESULTS.FAILING &&
      result.retryable === false;

    // The reported turn outcome is never rewritten: `failing` stays `failing`
    // in the turn result and in telemetry. What the ceiling controls is whether
    // a typed backoff wake is installed so the job can be re-admitted.
    let failureWake = null;
    if (result.outcome === APP_WORK_TURN_RESULTS.FAILING && !contractViolation && !nonRetryableFailure) {
      registration.consecutiveFailures += 1;
      if (registration.consecutiveFailures >= this.failureCeiling) {
        registration.failureCeilingReached = true;
      } else {
        const delay = Math.min(
          this.backoffMaxMs,
          this.backoffBaseMs * (2 ** (registration.consecutiveFailures - 1))
        );
        failureWake = Object.freeze({ type: 'time', eligibleAt: Number(this.now()) + delay });
      }
    } else if (result.outcome === APP_WORK_TURN_RESULTS.FAILING) {
      registration.consecutiveFailures += 1;
      registration.failureCeilingReached = true;
    } else if (!admissionRefusal) {
      registration.consecutiveFailures = 0;
      registration.failureCeilingReached = false;
    }

    const turnOutcome = result.outcome;
    const terminateForNewEpoch = registration.pendingEpoch !== null &&
      registration.newEpochPolicy === APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT;
    const pendingRescope = instance.pendingRescopeEpoch !== null &&
      registration.newEpochPolicy === APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE;
    const pendingIntent = instance.followUpRequested || pendingRescope;
    const timeWakePending = (
      turnOutcome === APP_WORK_TURN_RESULTS.DEFERRED ||
      turnOutcome === APP_WORK_TURN_RESULTS.BACKOFF
    ) && result.wake?.type === 'time' && !wakeMatches(result.wake, null, this.now());
    const continueForIntent = turnOutcome !== APP_WORK_TURN_RESULTS.HAS_MORE &&
      pendingIntent && !timeWakePending;

    if (terminateForNewEpoch) {
      const terminalOutcome = TERMINAL_OUTCOMES.has(turnOutcome)
        ? turnOutcome
        : APP_WORK_TURN_RESULTS.OBSOLETE;
      this._finalize(instance, terminalOutcome, error);
    } else if (turnOutcome === APP_WORK_TURN_RESULTS.HAS_MORE || continueForIntent) {
      if (continueForIntent) {
        // A newly responsible epoch turn also satisfies one coalesced same-epoch
        // follow-up; neither intent can disappear behind a terminal callback.
        instance.followUpRequested = false;
        if (
          turnOutcome === APP_WORK_TURN_RESULTS.DEFERRED ||
          turnOutcome === APP_WORK_TURN_RESULTS.BACKOFF
        ) {
          instance.pendingWake = result.wake;
        }
      }
      instance.state = 'continuing';
      this._enqueue(instance);
    } else if (
      turnOutcome === APP_WORK_TURN_RESULTS.DEFERRED ||
      turnOutcome === APP_WORK_TURN_RESULTS.BACKOFF
    ) {
      this._sleep(instance, turnOutcome, result.wake);
    } else if (turnOutcome === APP_WORK_TURN_RESULTS.FAILING && failureWake) {
      // Terminal for this epoch as `failing`, with a typed next-eligibility
      // record so the scheduler may re-admit it under bounded backoff.
      this._sleep(instance, turnOutcome, failureWake);
    } else {
      this._finalize(instance, turnOutcome, error);
    }

    const consumed = budget.snapshot();
    // P4-A: elapsed overrun is observational. It is reported, and it never
    // rewrites the domain's own `done`/`hasMore` result.
    const timeBudgetOverrun = registration.budget.timeMs !== null &&
      consumed.timeMs > registration.budget.timeMs;
    // P4-D-F02/DN13(c): the declared interactive latency gate, measured rather
    // than asserted. This records that an interactive operation waited longer
    // than the declared gate; it changes no scheduling decision.
    const interactiveLatencyGateExceeded =
      registration.workClass === APP_WORK_CLASSES.INTERACTIVE_EXPLICIT &&
      queueWaitMs > this.interactiveLatencyGateMs;
    const convergenceState = registration.active === instance
      ? instance.state
      : registration.lastTerminal?.outcome || turnOutcome;
    this.telemetry.push({
      jobKey: registration.jobKey,
      instanceId: instance.instanceId,
      lifecycleEpoch: turnEpoch,
      turnCount: instance.turnCount,
      workClass: registration.workClass,
      queueWaitMs,
      declaredBudget: registration.budget,
      consumedBudget: consumed,
      turnOutcome,
      timeBudgetOverrun,
      interactiveLatencyGateMs: this.interactiveLatencyGateMs,
      interactiveLatencyGateExceeded,
      admissionRefusal,
      admittedByAging: instance.admittedByAging === true,
      // M21 close-out: bounded scalar evidence for failure/backoff and
      // per-epoch convergence. No payload, no unbounded history, no
      // persistence scheduled through the coordinator itself.
      consecutiveFailures: registration.consecutiveFailures,
      failureCeilingReached: registration.failureCeilingReached,
      backgroundComplete: this.backgroundComplete(turnEpoch),
      convergenceState,
      backlog: this._queueDepth(),
      failed: error !== null,
    });

    return Object.freeze({
      jobKey: registration.jobKey,
      instanceId: instance.instanceId,
      lifecycleEpoch: turnEpoch,
      turnNumber: instance.turnCount,
      outcome: turnOutcome,
      consumedBudget: consumed,
      timeBudgetOverrun,
      admissionRefusal,
      error,
    });
  }

  _sleep(instance, outcome, wake) {
    const registration = instance.registration;
    instance.state = outcome;
    registration.active = null;
    registration.sleeping = Object.freeze({
      instance,
      wake,
      outcome,
    });
    const terminal = Object.freeze({
      jobKey: registration.jobKey,
      instanceId: instance.instanceId,
      epoch: instance.epoch,
      outcome,
      wake,
      turnCount: instance.turnCount,
    });
    registration.lastTerminal = terminal;
    // DN5: `deferred`/`backoff` close epoch E only because a typed wake record
    // is installed here; without one `normalizeTurnResult` would have failed.
    this._markTerminalForEpoch(instance, outcome);
    instance.completion.resolve(terminal);
    this._startPendingEpoch(registration);
  }

  _finalize(instance, outcome, error) {
    const registration = instance.registration;
    instance.state = outcome;
    registration.active = null;
    const terminal = Object.freeze({
      jobKey: registration.jobKey,
      instanceId: instance.instanceId,
      epoch: instance.epoch,
      outcome,
      turnCount: instance.turnCount,
      failed: error !== null,
      consecutiveFailures: registration.consecutiveFailures,
      failureCeilingReached: registration.failureCeilingReached,
    });
    registration.lastTerminal = terminal;
    this._markTerminalForEpoch(instance, outcome);
    instance.completion.resolve(terminal);
    this._startPendingEpoch(registration);
  }

  /**
   * P4-C-F11. Move one preserved logical instance's responsibility from the
   * epoch it was admitted under to a later effective epoch, atomically and
   * without duplicating the identity.
   *
   * `PRESERVE_INSTANCE` deliberately keeps the same `instanceId` across a
   * lifecycle epoch change, so the epoch field alone cannot carry the
   * bookkeeping: mutating it used to orphan the old epoch (admitted, never
   * terminal) and leave the new one with untracked work, so `backgroundComplete`
   * converged for neither. The transfer therefore does both halves at once:
   *
   *  - E reaches its terminal-for-E state as `rescoped` - the identity has
   *    genuinely finished being E's responsibility - which can only move E from
   *    incomplete to complete, so published snapshots stay monotonic;
   *  - E2 records the same identity as admitted *before* any turn runs under
   *    E2, so the new epoch is never observed complete while its work is still
   *    outstanding.
   *
   * E's completeness is published here, before `_epochRecord` can prune it, so
   * bounded epoch retention cannot turn a settled epoch back into an unknown
   * one.
   */
  _rescopeInstanceEpoch(instance, nextEpoch) {
    const previousEpoch = instance.epoch;
    if (nextEpoch === previousEpoch) return;
    const previous = this.epochs.get(previousEpoch);
    if (previous?.admitted.has(instance.instanceId) && !previous.terminal.has(instance.instanceId)) {
      previous.terminal.set(instance.instanceId, 'rescoped');
      this.backgroundComplete(previousEpoch);
    }
    instance.epoch = nextEpoch;
    this._epochRecord(nextEpoch).admitted.add(instance.instanceId);
    const registration = instance.registration;
    registration.latestExternalEpoch = Math.max(
      registration.latestExternalEpoch ?? nextEpoch,
      nextEpoch
    );
  }

  _markTerminalForEpoch(instance, outcome) {
    const record = this.epochs.get(instance.epoch);
    if (record?.admitted.has(instance.instanceId)) {
      record.terminal.set(instance.instanceId, outcome);
    }
  }

  _startPendingEpoch(registration) {
    if (registration.pendingEpoch === null) return;
    const epoch = registration.pendingEpoch;
    registration.pendingEpoch = null;
    registration.sleeping = null;
    this._createInstance(registration, epoch, 'new_epoch_followup');
  }
}

export const createAppWorkCoordinator = (options) => new AppWorkCoordinator(options);
