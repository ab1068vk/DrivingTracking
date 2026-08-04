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

/** @returns {Record<string, any>} */
export default function useLocalSettings() {
  const accessedKeysRef = useRef(new Set());
  const selectedValues = useLocalSettingSelector((settings) => {
    const keys = [...accessedKeysRef.current].sort();
    if (keys.includes('*')) return settings;
    return keys.map((key) => settings[key]);
  }, (previous, next) => {
    if (Object.is(previous, next)) return true;
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false;
    return previous.every((value, index) => Object.is(value, next[index]));
  });

  accessedKeysRef.current = new Set();
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
