import { useMemo, useRef, useSyncExternalStore } from 'react';
import { localSettings, SETTINGS_CHANGED_EVENT, SETTINGS_KEY } from '@/lib/trackingStore';

/** @type {Record<string, any>} */
let settingsSnapshot = localSettings.get();
let settingsSerialized = JSON.stringify(settingsSnapshot);
const subscribers = new Set();
let listening = false;

const refreshSnapshot = (event) => {
  const next = event?.detail?.settings || localSettings.get();
  if (next === settingsSnapshot) return;
  const serialized = JSON.stringify(next);
  if (serialized === settingsSerialized) return;
  settingsSnapshot = next;
  settingsSerialized = serialized;
  subscribers.forEach((subscriber) => subscriber());
};

const refreshStorageSnapshot = (event) => {
  if (event.key !== SETTINGS_KEY) return;
  refreshSnapshot(event);
};

const ensureListening = () => {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(SETTINGS_CHANGED_EVENT, refreshSnapshot);
  window.addEventListener('storage', refreshStorageSnapshot);
  window.addEventListener('focus', refreshSnapshot);
};

const subscribe = (subscriber) => {
  ensureListening();
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
};

/** @returns {Record<string, any>} */
const getSnapshot = () => settingsSnapshot;

export function useLocalSettingSelector(selector, isEqual = Object.is) {
  const selectorRef = useRef(selector);
  const equalityRef = useRef(isEqual);
  const selectedRef = useRef();
  const initializedRef = useRef(false);
  selectorRef.current = selector;
  equalityRef.current = isEqual;

  const getSelectedSnapshot = () => {
    const selected = selectorRef.current(getSnapshot());
    if (initializedRef.current && equalityRef.current(selectedRef.current, selected)) {
      return selectedRef.current;
    }
    initializedRef.current = true;
    selectedRef.current = selected;
    return selected;
  };

  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
}

/**
 * Project the settings snapshot through the keys a component has actually read.
 *
 * `'*'` means the component enumerated the object, so it depends on all of it and
 * the snapshot itself is the projection.
 */
export function projectAccessedSettings(accessedKeys, settings) {
  const keys = [...accessedKeys].sort();
  if (keys.includes('*')) return settings;
  return keys.map((key) => settings[key]);
}

/**
 * Two projections are the same when they cover the same number of keys and every
 * value is identical. A different *length* means the read-set changed, which is
 * why the set that feeds `projectAccessedSettings` must accumulate rather than
 * reset — see the note in `useLocalSettings` (DPD-026).
 */
export function sameAccessedProjection(previous, next) {
  if (Object.is(previous, next)) return true;
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}

/** @returns {Record<string, any>} */
export default function useLocalSettings() {
  const accessedKeysRef = useRef(new Set());
  const selectedValues = useLocalSettingSelector(
    (settings) => projectAccessedSettings(accessedKeysRef.current, settings),
    sameAccessedProjection
  );

  // DPD-026: this set is deliberately NOT cleared between renders.
  //
  // `useSyncExternalStore` requires `getSnapshot` to be a pure function of the
  // store. Clearing the set here made it a function of *what the component
  // rendered last* instead: the selector projects `settings` through whichever
  // keys happened to be read, so a component whose output decides which settings
  // it reads could produce a different projection on each call. The equality
  // check then failed, `selectedValues` took a new identity, and the memo below
  // handed out a new Proxy on every render.
  //
  // On Trip Detail that closed a loop — new Proxy -> `privacyZones` recomputed to
  // a fresh array -> the effect that depends on it re-ran -> `setRouteRiskIndex`
  // wrote a new Map -> re-render — which rebuilt the whole route layer several
  // times a second while the page sat idle (master §40).
  //
  // Accumulating instead makes the key set monotonic, so it converges after the
  // first render or two and the projection settles. The cost is that a component
  // stays subscribed to a key it once read even if it stops reading it: strictly
  // more re-renders on a real settings change, never fewer, and never a missed
  // update.
  return useMemo(() => /** @type {Record<string, any>} */ (new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'string') accessedKeysRef.current.add(key);
      return typeof key === 'string' ? settingsSnapshot[key] : undefined;
    },
    has(_target, key) {
      if (typeof key === 'string') accessedKeysRef.current.add(key);
      return key in settingsSnapshot;
    },
    ownKeys() {
      accessedKeysRef.current.add('*');
      return Reflect.ownKeys(settingsSnapshot);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string') return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: settingsSnapshot[key],
      };
    },
    // The proxy closes over settingsSnapshot rather than referencing
    // selectedValues directly; selectedValues is the intentional invalidation
    // key that tells us the tracked settings actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [selectedValues]);
}
