/**
 * Always-on production lifecycle authority.
 *
 * This module owns the sole definition of effective foreground state. P0 may
 * mirror its events for diagnostics, but probe enablement/freeze state never
 * gates these transitions.
 */

export const LIFECYCLE_SIGNAL_SOURCES = Object.freeze({
  DOCUMENT: 'visibilitychange',
  NATIVE: 'appStateChange',
});

const VALID_SIGNAL_STATES = new Map([
  ['visibilitychange', new Set(['visible', 'hidden'])],
  ['appStateChange', new Set(['active', 'inactive'])],
]);

export const isSupportedLifecycleSignal = (source, state) =>
  VALID_SIGNAL_STATES.get(source)?.has(state) === true;

const initialDocumentVisible = () => {
  try {
    return typeof document === 'undefined' || !document.visibilityState
      ? true
      : document.visibilityState === 'visible';
  } catch {
    return true;
  }
};

const listeners = new Set();
let rawSequence = 0;
const initialVisible = initialDocumentVisible();
let lifecycleState = Object.freeze({
  documentVisible: initialVisible,
  nativeActive: true,
  effectiveForeground: initialVisible,
  epoch: 0,
  rawSequence: 0,
});

const assertSignal = (source, state) => {
  if (!isSupportedLifecycleSignal(source, state)) {
    throw new TypeError(`Unsupported lifecycle signal: ${String(source)}:${String(state)}`);
  }
};

/**
 * Record one raw platform lifecycle signal and return its authoritative event.
 * Every valid raw signal is observable, even when it does not change the
 * effective foreground state or epoch.
 */
export function recordLifecycleSignal(source, state) {
  assertSignal(source, state);

  const documentVisible = source === LIFECYCLE_SIGNAL_SOURCES.DOCUMENT
    ? state === 'visible'
    : lifecycleState.documentVisible;
  const nativeActive = source === LIFECYCLE_SIGNAL_SOURCES.NATIVE
    ? state === 'active'
    : lifecycleState.nativeActive;
  const effectiveForeground = documentVisible && nativeActive;
  const changed = effectiveForeground !== lifecycleState.effectiveForeground;
  rawSequence += 1;

  lifecycleState = Object.freeze({
    documentVisible,
    nativeActive,
    effectiveForeground,
    epoch: lifecycleState.epoch + (changed ? 1 : 0),
    rawSequence,
  });

  const event = Object.freeze({
    source,
    state,
    sequence: rawSequence,
    effectiveChanged: changed,
    ...lifecycleState,
  });

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Observers cannot break production lifecycle state advancement.
    }
  }
  return event;
}

/** Returns the immutable current state without allocating a second model. */
export const getLifecycleSnapshot = () => lifecycleState;
export const effectiveLifecycleEpoch = () => lifecycleState.epoch;
export const isEffectivelyForeground = () => lifecycleState.effectiveForeground;

/** Observe every raw signal. The returned function removes the observer. */
export function subscribeLifecycleSignals(listener) {
  if (typeof listener !== 'function') throw new TypeError('Lifecycle observer must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset; production code must never reset the monotonic epoch. */
export function __resetLifecycleAuthorityForTests({
  documentVisible = true,
  nativeActive = true,
  epoch = 0,
} = {}) {
  rawSequence = 0;
  lifecycleState = Object.freeze({
    documentVisible: documentVisible === true,
    nativeActive: nativeActive === true,
    effectiveForeground: documentVisible === true && nativeActive === true,
    epoch: Math.max(0, Math.floor(Number(epoch) || 0)),
    rawSequence: 0,
  });
  listeners.clear();
}
