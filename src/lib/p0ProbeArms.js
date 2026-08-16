/**
 * P0 experiment arm selection.
 *
 * Four arms, selectable from one build so both sides of the A/B see the same
 * device, the same data and the same code:
 *
 *   A  collection on; all three recurring persistence jobs on; checkpoints on; probe on
 *   B  collection on; the three jobs short-circuited *at entry*; checkpoints on; probe on
 *   C  as B, plus watchdog checkpoint bridge calls suppressed; probe on
 *   D  production persistence/checkpoints on; probe off (CDP is the measurement source)
 *
 * Two invariants this module exists to guarantee:
 *
 * 1. **Debug-gated.** Outside a debug build the resolver hard-returns `A` and
 *    every suppression predicate is `false`, regardless of what is in storage.
 *    A release user can never disable diagnostics persistence.
 * 2. **Boot-immutable.** The arm is read once and frozen for the process, so an
 *    arm change mid-run cannot split a dataset.
 */

import { ARMS } from '@/lib/p0Schema';

export const P0_ARM_STORAGE_KEY = 'roadsage_p0_arm';
export const P0_RUN_MARKER_STORAGE_KEY = 'roadsage_p0_run_marker';

/** Bumped whenever suppression semantics change, so `arm_config_id` shifts with it. */
export const P0_ARM_CONFIG_VERSION = 1;

const DEFAULT_ARM = 'A';

let resolvedArm = null;
let resolvedDebugEnabled = null;

const debugBuildEnabled = () => {
  try {
    return import.meta.env.DEV === true || import.meta.env.VITE_SHOW_DEBUG_ROUTES === 'true';
  } catch {
    return false;
  }
};

const readStoredArm = () => {
  try {
    if (typeof localStorage === 'undefined') return '';
    return String(localStorage.getItem(P0_ARM_STORAGE_KEY) || '').trim().toUpperCase();
  } catch {
    return '';
  }
};

const readEnvArm = () => {
  try {
    return String(import.meta.env.VITE_TRIAGE_P0_ARM || '').trim().toUpperCase();
  } catch {
    return '';
  }
};

/**
 * Resolve once, then freeze. Every later call returns the same value even if
 * storage changes underneath us.
 */
export function resolveP0Arm() {
  if (resolvedArm !== null) return resolvedArm;

  resolvedDebugEnabled = debugBuildEnabled();
  if (!resolvedDebugEnabled) {
    resolvedArm = DEFAULT_ARM;
    return resolvedArm;
  }

  const candidate = readStoredArm() || readEnvArm();
  resolvedArm = ARMS.includes(candidate) ? candidate : DEFAULT_ARM;
  return resolvedArm;
}

/** @returns {boolean} true only in a debug-routes-enabled build. */
export function isP0DebugBuild() {
  if (resolvedDebugEnabled === null) resolveP0Arm();
  return resolvedDebugEnabled === true;
}

/**
 * Stable identity for "which experiment configuration produced this export".
 * Any change to arm, suppression semantics or schema shifts it, so an export can
 * never be misfiled against the wrong configuration.
 */
export function p0ArmConfigId() {
  const arm = resolveP0Arm();
  const flags = [
    arm,
    `v${P0_ARM_CONFIG_VERSION}`,
    isP0DebugBuild() ? 'debug' : 'release',
    suppressDiagnosticsPersistence() ? 'nopersist' : 'persist',
    suppressWatchdogCheckpoints() ? 'nockpt' : 'ckpt',
    isProbeEnabled() ? 'probe' : 'noprobe',
  ].join(':');
  // Short non-cryptographic digest; this is a configuration label, not a secret.
  let hash = 0;
  for (let index = 0; index < flags.length; index += 1) {
    hash = (hash * 31 + flags.charCodeAt(index)) >>> 0;
  }
  return `${flags}#${hash.toString(36)}`;
}

/**
 * Arms B and C short-circuit the three recurring persistence jobs **at their
 * entry**, before the first storage read or any full-history transform.
 *
 * Suppressing only the `setItem` would leave the expensive work in place —
 * parse, sanitize, prune, sort and stringify over the whole retained store —
 * and could produce a false negative for the diagnostics hypothesis.
 */
export function suppressDiagnosticsPersistence() {
  if (!isP0DebugBuild()) return false;
  const arm = resolveP0Arm();
  return arm === 'B' || arm === 'C';
}

/** Arm C additionally suppresses the per-measurement watchdog bridge call. */
export function suppressWatchdogCheckpoints() {
  if (!isP0DebugBuild()) return false;
  return resolveP0Arm() === 'C';
}

/** Arm D turns the probe off entirely; CDP tracing is the measurement source. */
export function isProbeEnabled() {
  if (!isP0DebugBuild()) return false;
  return resolveP0Arm() !== 'D';
}

/**
 * Set the arm for the *next* process start. Deliberately does not affect the
 * current process: the running arm is frozen. No-op outside a debug build.
 *
 * @param {string} arm
 * @returns {boolean} whether the value was accepted
 */
export function setP0ArmForNextBoot(arm) {
  if (!isP0DebugBuild()) return false;
  const candidate = String(arm || '').trim().toUpperCase();
  if (!ARMS.includes(candidate)) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(P0_ARM_STORAGE_KEY, candidate);
    return true;
  } catch {
    return false;
  }
}

/** Test-only reset of the frozen resolution. */
export function __resetP0ArmResolutionForTests() {
  resolvedArm = null;
  resolvedDebugEnabled = null;
}
