import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { getPermissionStatus, invalidatePermissionCache } from '@/lib/permissions';
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

const initialState = Object.freeze({
  ...Object.fromEntries(PERMISSION_KEYS.map((key) => [key, PERMISSION_STATES.UNKNOWN])),
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

  const refresh = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', value: true });
    try {
      const statuses = await getPermissionStatus();
      dispatch({ type: 'SET_ALL', statuses, checkedAt: new Date().toISOString() });
      return statuses;
    } finally {
      dispatch({ type: 'SET_LOADING', value: false });
    }
  }, []);

  const setOne = useCallback((key, status) => {
    dispatch({ type: 'SET_ONE', key, status });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = ({ force = false } = {}) => {
      if (force) invalidatePermissionCache();
      if (!cancelled) refresh().catch(() => null);
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

  const value = useMemo(() => ({ ...state, refresh, setOne }), [refresh, setOne, state]);

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
