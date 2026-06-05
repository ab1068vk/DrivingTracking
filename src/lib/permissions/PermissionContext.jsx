import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { getPermissionStatus, invalidatePermissionCache } from '@/lib/permissions';
import { localSettings } from '@/lib/trackingStore';
import {
  PERMISSION_STATES,
  normalizePermissionState,
  transitionPermissionState,
} from '@/lib/permissionStateMachine';

export const PERMISSION_KEYS = Object.freeze([
  'foregroundLocation',
  'backgroundLocation',
  'notifications',
  'activityRecognition',
  'phoneUsageAccess',
  'bluetooth',
  'motionSensors',
]);

const PermissionContext = createContext(null);

function storedMarkerStatus(value) {
  if (value === true) return PERMISSION_STATES.GRANTED;
  if (value === PERMISSION_STATES.NEEDS_SETTINGS) return PERMISSION_STATES.NEEDS_SETTINGS;
  if (value === PERMISSION_STATES.DENIED) return PERMISSION_STATES.DENIED;
  return PERMISSION_STATES.UNKNOWN;
}

function initialPermissionsFromStore() {
  try {
    const stored = localSettings.get();
    return {
      foregroundLocation: storedMarkerStatus(stored.location_permission_granted),
      backgroundLocation: storedMarkerStatus(stored.background_location_granted),
      notifications: storedMarkerStatus(stored.notification_permission_granted),
      activityRecognition: storedMarkerStatus(stored.activity_permission_granted),
      phoneUsageAccess: stored.phone_usage_access_granted === true
        ? PERMISSION_STATES.GRANTED
        : PERMISSION_STATES.UNKNOWN,
      bluetooth: PERMISSION_STATES.UNKNOWN,
      motionSensors: PERMISSION_STATES.UNKNOWN,
    };
  } catch {
    return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, PERMISSION_STATES.UNKNOWN]));
  }
}

const initialState = Object.freeze({
  ...initialPermissionsFromStore(),
  _loading: false,
  _lastCheckedAt: null,
});

function reducer(state, action) {
  switch (action.type) {
    case 'SET_ONE':
      if (!PERMISSION_KEYS.includes(action.key)) return state;
      return {
        ...state,
        [action.key]: transitionPermissionState(state[action.key], action.status),
      };
    case 'SET_ALL': {
      const next = { ...state };
      for (const key of PERMISSION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(action.statuses || {}, key)) {
          next[key] = normalizePermissionState(action.statuses[key]);
        }
      }
      next._lastCheckedAt = action.checkedAt || new Date().toISOString();
      return next;
    }
    case 'SET_LOADING':
      return { ...state, _loading: action.value === true };
    default:
      return state;
  }
}

export function PermissionProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const refreshInFlightRef = useRef(null);
  const refreshVersionRef = useRef(0);
  const mountedRef = useRef(false);

  const refresh = useCallback(async ({ force = false } = {}) => {
    if (!force && refreshInFlightRef.current) return refreshInFlightRef.current;

    const version = ++refreshVersionRef.current;
    if (mountedRef.current) dispatch({ type: 'SET_LOADING', value: true });

    const task = getPermissionStatus(null, { force })
      .then((statuses) => {
        if (mountedRef.current && version === refreshVersionRef.current) {
          dispatch({ type: 'SET_ALL', statuses, checkedAt: new Date().toISOString() });
        }
        return statuses;
      })
      .finally(() => {
        if (refreshInFlightRef.current === task) {
          refreshInFlightRef.current = null;
        }
        if (mountedRef.current && version === refreshVersionRef.current) {
          dispatch({ type: 'SET_LOADING', value: false });
        }
      });

    refreshInFlightRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshVersionRef.current += 1;
    };
  }, []);

  const refreshNow = useCallback(async () => {
    if (mountedRef.current) {
      return refresh({ force: true }).catch(() => null);
    }
    return null;
  }, [refresh]);

  const setOne = useCallback((key, status) => {
    dispatch({ type: 'SET_ONE', key, status });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = ({ force = false } = {}) => {
      if (force) invalidatePermissionCache();
      if (!cancelled) refresh({ force }).catch(() => null);
    };

    run();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') run({ force: true });
    };
    const onFocus = () => run({ force: true });

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const value = useMemo(() => ({ ...state, refresh, refreshNow, setOne }), [refresh, refreshNow, setOne, state]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx) throw new Error('usePermissions must be used inside <PermissionProvider>');
  return ctx;
}

export function useOptionalPermissions() {
  return useContext(PermissionContext);
}
