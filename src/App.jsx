import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useNavigate } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { applyThemeMode, localSettings } from '@/lib/trackingStore';
import { PermissionProvider } from '@/lib/permissions/PermissionContext';
import { configureNotificationChannels, syncReminderNotifications } from '@/lib/notificationService';
import { getNativeAutoTrackingStatus, startNativeAutoTracking } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { openExportLocation } from '@/lib/nativeDownloads';
import { logError } from '@/lib/errorReporting';
import { notifyUserError } from '@/lib/userFeedback';
import { reverifyConfiguredOsrmEndpoint } from '@/lib/osrmEndpointVerifier';
import { getJson } from '@/lib/mobileStorage';
import { clearImportSessionMarker, readInterruptedImportSession } from '@/lib/dataBackup';
import {
  BIOMETRIC_LOCK_STATE_CHANGE_EVENT,
  isBiometricLockEnabled,
  isLocked,
  lockWhenBiometricEnabled,
  markUserActivity,
  markUnlocked,
  msUntilAutoLock,
  setBiometricLockEnabled,
} from '@/lib/biometricLock';
import { authenticateBiometricGate } from '@/lib/nativeBiometricGate';
import { BIOMETRIC_AUTH_TIMEOUT_MS, ONBOARDING_COMPLETED_KEY } from '@/lib/appConstants';
import { toast } from '@/components/ui/use-toast';
import { Route as RouteIcon } from 'lucide-react';

import Layout from '@/components/Layout';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import { PageSkeleton } from '@/components/PageSkeleton';

// Debug routes are only available in Vite development mode.
// import.meta.env.DEV is a compile-time constant set to true by the Vite dev
// server and false in every npm run build output.
const showDebugRoutes = import.meta.env.DEV;
const lazyWithPreload = (loader) => {
  let loadPromise;
  const load = () => {
    loadPromise ||= loader();
    return loadPromise;
  };
  const Component = lazy(load);
  Component.preload = load;
  return Component;
};

const Onboarding = lazyWithPreload(() => import('@/pages/Onboarding'));
const Dashboard = lazyWithPreload(() => import('@/pages/Dashboard'));
const TripHistory = lazyWithPreload(() => import('@/pages/TripHistory'));
const TripDetail = lazyWithPreload(() => import('@/pages/TripDetail'));
const SurveyPage = lazyWithPreload(() => import('@/pages/SurveyPage'));
const MapScreen = lazyWithPreload(() => import('@/pages/MapScreen'));
const Reports = lazyWithPreload(() => import('@/pages/Report'));
const Settings = lazyWithPreload(() => import('@/pages/Settings'));
const AndroidReference = showDebugRoutes ? lazyWithPreload(() => import('@/pages/AndroidReference')) : null;
const Vehicles = lazyWithPreload(() => import('@/pages/Vehicles'));
const Achievements = lazyWithPreload(() => import('@/pages/Achievements'));
const DrivingCoach = lazyWithPreload(() => import('@/pages/DrivingCoach'));
const Diagnostics = showDebugRoutes ? lazyWithPreload(() => import('@/pages/Diagnostics')) : null;
const Insights = lazyWithPreload(() => import('@/pages/Insights'));

const primaryPreloadRoutes = [
  Dashboard,
  TripHistory,
  MapScreen,
  Settings,
];
const LAUNCH_NATIVE_SETTINGS_TIMEOUT_MS = 1_500;
const LAUNCH_ONBOARDING_MARKER_TIMEOUT_MS = 2_000;
const DEFERRED_NATIVE_SETTINGS_DELAY_MS = 2_500;
const DEFERRED_NATIVE_SETTINGS_TIMEOUT_MS = 10_000;
const NATIVE_SETTINGS_APP_POLL_MS = 2_000;
const TILE_BACKGROUND_AUTO_ACTION_KEY = 'road_sage_tile_action_request_background_auto';
const IMPORT_STAGE_LABELS = {
  retention: 'retention protection',
  trips: 'trip import',
  vehicles: 'vehicle import',
  settings: 'settings restore',
  filters: 'saved filter restore',
};

const formatInterruptedImportStartedAt = (startedAt) => {
  const timestamp = Date.parse(startedAt || '');
  if (!Number.isFinite(timestamp)) return 'recently';
  return new Date(timestamp).toLocaleString();
};

const scheduleRoutePreloads = () => {
  if (typeof window === 'undefined') return () => {};

  const handles = [];
  let cancelled = false;
  const runWhenIdle = (callback, delay) => {
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      if ('requestIdleCallback' in window) {
        const idleId = window.requestIdleCallback(callback, { timeout: 2_000 });
        handles.push({ type: 'idle', id: idleId });
        return;
      }
      callback();
    }, delay);
    handles.push({ type: 'timeout', id: timeoutId });
  };

  primaryPreloadRoutes.forEach((RouteComponent, index) => {
    runWhenIdle(() => {
      if (!cancelled) RouteComponent.preload?.();
    }, 350 + index * 250);
  });

  return () => {
    cancelled = true;
    handles.forEach((handle) => {
      if (handle.type === 'idle') window.cancelIdleCallback?.(handle.id);
      else window.clearTimeout(handle.id);
    });
  };
};

const scheduleDataRetentionPrune = (retentionMonths) => {
  const prune = () => {
    import('@/lib/localTripRepository')
      .then(({ enforceDataRetention }) => enforceDataRetention(retentionMonths))
      .then((count) => {
        if (count > 0) {
          logError('data_retention_pruned', new Error('Retention pruning'), { deleted: count });
        }
      })
      .catch((err) => {
        logError('data_retention_prune_failed', err);
      });
  };

  if (typeof window === 'undefined') {
    prune();
    return;
  }
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(prune, { timeout: 10_000 });
    return;
  }
  window.setTimeout(prune, 3_000);
};

const withLaunchTimeout = (promise, fallback, context, timeoutMs = 2500, { logTimeout = true } = {}) => {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => {
      if (logTimeout) {
        logError(context, new Error(`Launch step timed out after ${timeoutMs}ms`));
      }
      resolve(fallback);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId);
  });
};

const routeAppDeepLink = (rawUrl, navigate) => {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname || '';
    const path = host === 'app'
      ? (url.pathname || '/')
      : `/${host}${url.pathname || ''}`.replace(/\/{2,}/g, '/');
    const normalizedPath = path === '/dashboard' ? '/' : path;

    if (url.searchParams.get('action') === 'request_background_auto') {
      try {
        sessionStorage.setItem(TILE_BACKGROUND_AUTO_ACTION_KEY, '1');
      } catch {
        // Best-effort handoff to Settings.
      }
    }

    if (normalizedPath === '/settings') {
      navigate('/settings');
      return true;
    }
    if (normalizedPath === '/') {
      navigate('/');
      return true;
    }
    if (normalizedPath.startsWith('/trips/')) {
      navigate(normalizedPath);
      return true;
    }
    if (normalizedPath.startsWith('/survey/')) {
      navigate(normalizedPath);
      return true;
    }
  } catch (err) {
    logError('app_deeplink_parse', err, { rawUrl });
  }
  return false;
};

const ensureNativeAutoTrackingStarted = async (settings, context) => {
  if (!isAndroid() || settings?.tracking_mode !== 'background_auto' || settings?.tracking_paused) return;
  try {
    const status = await getNativeAutoTrackingStatus();
    if (status?.enabled === true) return;
    await startNativeAutoTracking();
  } catch (err) {
    logError(context, err, { mode: settings?.tracking_mode });
  }
};

const hasCompletedOnboarding = async (
  settings,
  { persistMarker = true, markerTimeoutMs = LAUNCH_ONBOARDING_MARKER_TIMEOUT_MS } = {}
) => {
  if (settings?.onboarding_completed === true) return true;

  let browserMarker = false;
  try {
    const rawBrowserMarker = localStorage.getItem(ONBOARDING_COMPLETED_KEY);
    browserMarker = rawBrowserMarker === 'true' || JSON.parse(rawBrowserMarker || 'false') === true;
  } catch {
    browserMarker = false;
  }
  if (browserMarker) {
    if (persistMarker) localSettings.update({ onboarding_completed: true });
    return true;
  }

  const markerRead = getJson(ONBOARDING_COMPLETED_KEY, false).catch((err) => {
    logError('onboarding_completion_marker_read', err);
    return false;
  });
  const completedMarker = markerTimeoutMs > 0 && typeof window !== 'undefined'
    ? await withLaunchTimeout(
      markerRead,
      false,
      'onboarding_completion_marker_timeout',
      markerTimeoutMs,
      { logTimeout: false }
    )
    : await markerRead;

  if (completedMarker === true) {
    if (persistMarker) localSettings.update({ onboarding_completed: true });
    return true;
  }

  return false;
};

function AppLoading() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-teal-500 via-cyan-500 to-slate-900 flex items-center justify-center shadow-lg animate-pulse">
          <RouteIcon className="h-6 w-6 text-white" />
        </div>
        <div className="text-muted-foreground text-sm">Loading Road Sage...</div>
      </div>
    </div>
  );
}

function LazyRoute({ children }) {
  return (
    <Suspense fallback={null}>
      {children}
    </Suspense>
  );
}

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const [_lockSettingsReady] = useState(() => {
    const launchSettings = localSettings.get();
    setBiometricLockEnabled(launchSettings?.biometric_lock_enabled === true);
    return true;
  });
  const [onboardingDone, setOnboardingDone] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let nativeHydrationTimer = null;

    const bootstrapSettings = async () => {
      configureNotificationChannels().catch((err) => {
        notifyUserError('notification_channel_configure', err, {
          title: 'Notification setup delayed',
          description: 'Road Sage could not finish notification setup. Trip tracking still works, but reminders may not appear yet.',
        });
      });
      const launchSettings = localSettings.get();
      setOnboardingDone(await hasCompletedOnboarding(launchSettings, {
        persistMarker: !isAndroid(),
        markerTimeoutMs: isAndroid() ? LAUNCH_ONBOARDING_MARKER_TIMEOUT_MS : 0,
      }));
      applyThemeMode(launchSettings.dark_mode);

      const interruptedImport = readInterruptedImportSession();
      if (interruptedImport) {
        clearImportSessionMarker();
        toast({
          title: 'Backup import was interrupted',
          description: `An import started ${formatInterruptedImportStartedAt(interruptedImport.startedAt)} reached the ${IMPORT_STAGE_LABELS[interruptedImport.stage] || 'import'} step. Some data may be partially restored; importing the same backup again updates matching trips instead of duplicating them.`,
          variant: 'destructive',
        });
      }

      scheduleDataRetentionPrune(launchSettings.data_retention_months);
      reverifyConfiguredOsrmEndpoint(launchSettings).then(({ result }) => {
        if (result && !result.ok) {
          toast({
            title: 'OSRM route snapping disabled',
            description: result.error || 'The configured OSRM endpoint did not pass verification.',
            variant: 'destructive',
          });
        }
      }).catch((err) => {
        logError('osrm_launch_reverify', err);
      });
      syncReminderNotifications(launchSettings, { requestPermission: false }).catch((err) => {
        notifyUserError('reminder_notification_sync', err, {
          title: 'Reminder sync delayed',
          description: 'Reminder notifications could not be refreshed. Road Sage will try again when settings reload.',
          extra: { tracking_mode: launchSettings.tracking_mode },
        });
      });

      const applyHydratedNativeSettings = async (settings, context) => {
        if (!settings) return;
        setBiometricLockEnabled(settings?.biometric_lock_enabled === true);
        const completed = await hasCompletedOnboarding(settings);
        setOnboardingDone((previous) => previous === true || completed);
        applyThemeMode(settings.dark_mode);
        scheduleDataRetentionPrune(settings.data_retention_months);
        await ensureNativeAutoTrackingStarted(settings, context);
      };

      const hydrateNativeSettings = async (promise, timeoutContext, autoTrackingContext, timeoutMs) => {
        const settings = await withLaunchTimeout(
          promise,
          null,
          timeoutContext,
          timeoutMs,
          { logTimeout: false }
        );
        await applyHydratedNativeSettings(settings, autoTrackingContext);
      };

      if (!isAndroid()) return;

      hydrateNativeSettings(
        localSettings.hydrateFromNative(),
        'settings_hydrate_launch_timeout',
        'native_auto_tracking_start_after_launch_hydration',
        LAUNCH_NATIVE_SETTINGS_TIMEOUT_MS
      ).catch((err) => {
        logError('settings_hydrate_launch', err);
      });

      nativeHydrationTimer = window.setTimeout(async () => {
        await hydrateNativeSettings(
          localSettings.hydrateFromNative(),
          'settings_hydrate_deferred_timeout',
          'native_auto_tracking_start_after_hydration',
          DEFERRED_NATIVE_SETTINGS_TIMEOUT_MS
        );
      }, DEFERRED_NATIVE_SETTINGS_DELAY_MS);
    };
    bootstrapSettings();
    return () => {
      if (nativeHydrationTimer !== null) window.clearTimeout(nativeHydrationTimer);
    };
  }, []);

  useEffect(() => {
    if (onboardingDone !== true) return undefined;
    return scheduleRoutePreloads();
  }, [onboardingDone]);

  useEffect(() => {
    let appUrlOpenListener;
    CapacitorApp.getLaunchUrl?.().then((launch) => {
      routeAppDeepLink(launch?.url, navigate);
    }).catch((err) => {
      logError('app_launch_url_read', err);
    });
    CapacitorApp.addListener('appUrlOpen', (event) => {
      routeAppDeepLink(event?.url, navigate);
    }).then((handle) => {
      appUrlOpenListener = handle;
    }).catch((err) => {
      logError('app_url_open_listener_register', err);
    });
    return () => {
      appUrlOpenListener?.remove?.();
    };
  }, [navigate]);

  useEffect(() => {
    if (!isAndroid() || onboardingDone !== true) return undefined;

    const pollNativeSettings = async () => {
      try {
        await localSettings.hydrateFromNative();
      } catch {
        // Keep app-wide native hydration best-effort.
      }
    };

    const timer = window.setInterval(pollNativeSettings, NATIVE_SETTINGS_APP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [onboardingDone]);

  useEffect(() => {
    const lockWhenEnabled = () => lockWhenBiometricEnabled();
    const lockOnHidden = () => {
      if (document.visibilityState === 'hidden') lockWhenEnabled();
    };
    document.addEventListener('visibilitychange', lockOnHidden);

    let appStateListener;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) lockWhenEnabled();
    }).then((handle) => {
      appStateListener = handle;
    }).catch((err) => {
      logError('biometric_lock_app_state_listener_register', err);
    });

    return () => {
      document.removeEventListener('visibilitychange', lockOnHidden);
      appStateListener?.remove?.();
    };
  }, []);

  useEffect(() => {
    let listener;
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const extra = action.notification?.extra ?? {};
      if (extra.type === 'trip_survey' && extra.tripId) navigate(`/survey/${extra.tripId}`);
      else if (extra.tripId) navigate(`/trips/${extra.tripId}`);
      else if (extra.type === 'phone_use_pattern') navigate('/coach');
      else if (extra.type === 'maintenance') navigate('/vehicles');
      else if (extra.type === 'export_saved') {
        openExportLocation({ uri: extra.uri, mimeType: extra.mimeType }).catch((err) => {
          notifyUserError('export_location_open', err, {
            title: 'Could not open export',
            description: 'The file was saved, but Road Sage could not open its location. Check Downloads from your device file manager.',
            extra: { uri: extra.uri, mimeType: extra.mimeType },
          });
          navigate('/reports');
        });
      }
    }).then((handle) => {
      listener = handle;
    }).catch((err) => {
      logError('notification_action_listener_register', err);
    });
    return () => {
      listener?.remove?.();
    };
  }, [navigate]);

  if (isLoadingPublicSettings || isLoadingAuth || onboardingDone === null) {
    return <AppLoading />;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') return <UserNotRegisteredError />;
    if (authError.type === 'auth_required') { navigateToLogin(); return null; }
    // For other errors (network, unknown), still render the app in public mode
  }

  if (!onboardingDone) {
    return (
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="*" element={<Onboarding onComplete={() => setOnboardingDone(true)} />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Routes>
      {/* Main App with shared Layout */}
      <Route element={<BiometricRouteGuard><Layout /></BiometricRouteGuard>}>
        <Route path="/" element={<LazyRoute><Dashboard /></LazyRoute>} />
        <Route path="/trips" element={<LazyRoute><TripHistory /></LazyRoute>} />
        <Route path="/survey/:tripId" element={<LazyRoute><SurveyPage /></LazyRoute>} />
        <Route path="/trips/:id" element={(
          <LazyRoute>
            <SectionErrorBoundary
              context="trip_detail_page"
              title="Trip detail unavailable"
              message="Something went wrong while opening this trip. Reload to try again."
            >
              <TripDetail />
            </SectionErrorBoundary>
          </LazyRoute>
        )} />
        <Route path="/map" element={<LazyRoute><MapScreen /></LazyRoute>} />
        <Route path="/coach" element={<LazyRoute><DrivingCoach /></LazyRoute>} />
        <Route path="/insights" element={<LazyRoute><Insights /></LazyRoute>} />
        <Route path="/achievements" element={<LazyRoute><Achievements /></LazyRoute>} />
        <Route path="/reports" element={<LazyRoute><Reports /></LazyRoute>} />
        {showDebugRoutes && Diagnostics && <Route path="/diagnostics" element={<LazyRoute><Diagnostics /></LazyRoute>} />}
        <Route path="/settings" element={(
          <LazyRoute>
            <SectionErrorBoundary context="settings_page">
              <Settings />
            </SectionErrorBoundary>
          </LazyRoute>
        )} />
        {showDebugRoutes && AndroidReference && <Route path="/android" element={<LazyRoute><AndroidReference /></LazyRoute>} />}
        <Route path="/vehicles" element={<LazyRoute><Vehicles /></LazyRoute>} />
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function BiometricRouteGuard({ children }) {
  const [authState, setAuthState] = useState(() => (
    isAndroid() && isBiometricLockEnabled() && isLocked(localSettings.get())
      ? 'checking'
      : 'unlocked'
  ));
  const [unlockRequest, setUnlockRequest] = useState(0);
  const authStateRef = useRef(authState);

  useEffect(() => {
    authStateRef.current = authState;
  }, [authState]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;

    const clearAutoLockTimer = () => {
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleAutoLockTimer = () => {
      clearAutoLockTimer();
      if (!isAndroid()) return;

      const delayMs = msUntilAutoLock(localSettings.get());
      if (!Number.isFinite(delayMs) || delayMs <= 0) return;
      timeoutId = window.setTimeout(() => {
        if (cancelled || document.visibilityState === 'hidden') return;
        if (isLocked(localSettings.get())) {
          setAuthState('checking');
          verify();
          return;
        }
        scheduleAutoLockTimer();
      }, Math.min(delayMs, 2_147_483_647));
    };

    const attemptUnlock = async () => {
      const timeout = new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('auth_timeout')), BIOMETRIC_AUTH_TIMEOUT_MS);
      });

      try {
        await Promise.race([authenticateBiometricGate(), timeout]);
        if (cancelled) return;
        markUnlocked();
        setAuthState('unlocked');
        scheduleAutoLockTimer();
      } catch (err) {
        if (cancelled) return;
        if (err?.message === 'auth_timeout') {
          setAuthState('locked');
          console.warn('[biometricLock] auth timed out, unlock retry required:', err.message);
          return;
        }
        if (err?.message === 'unavailable') {
          clearAutoLockTimer();
          setBiometricLockEnabled(false);
          markUnlocked();
          setAuthState('unlocked');
          console.warn('[biometricLock] auth unavailable, lock skipped for this session:', err.message);
          return;
        }
        if (err?.message === 'cancelled') {
          setAuthState('locked');
          return;
        }
        logError('biometric_gate_authenticate', err);
        setAuthState('locked');
      }
    };

    const verify = async () => {
      if (!isAndroid()) {
        clearAutoLockTimer();
        setBiometricLockEnabled(false);
        setAuthState('unlocked');
        return;
      }

      if (!isBiometricLockEnabled()) {
        clearAutoLockTimer();
        setAuthState('unlocked');
        return;
      }

      const settings = localSettings.get();
      if (!isLocked(settings)) {
        setAuthState('unlocked');
        scheduleAutoLockTimer();
        return;
      }

      setAuthState('checking');
      await attemptUnlock();
    };

    const verifyOnVisible = () => {
      if (document.visibilityState === 'visible') verify();
    };
    const verifyOnBiometricSettingsChange = () => {
      verify();
    };
    const recordActivity = () => {
      if (authStateRef.current !== 'unlocked' || !isBiometricLockEnabled()) return;
      markUserActivity();
      scheduleAutoLockTimer();
    };

    verify();
    const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, recordActivity, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', verifyOnVisible);
    window.addEventListener(BIOMETRIC_LOCK_STATE_CHANGE_EVENT, verifyOnBiometricSettingsChange);
    return () => {
      cancelled = true;
      clearAutoLockTimer();
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, recordActivity, { capture: true });
      });
      document.removeEventListener('visibilitychange', verifyOnVisible);
      window.removeEventListener(BIOMETRIC_LOCK_STATE_CHANGE_EVENT, verifyOnBiometricSettingsChange);
    };
  }, [unlockRequest]);

  if (authState === 'unlocked') return children;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background px-4">
      <div className="max-w-sm rounded-2xl border border-border bg-card p-5 text-center shadow">
        <div className="mb-2 font-semibold">{authState === 'locked' ? 'Road Sage is locked' : 'Unlocking Road Sage...'}</div>
        <div className="text-sm text-muted-foreground">
          {authState === 'locked'
            ? 'Confirm your device credential to continue.'
            : 'Confirm your device credential to access trip data.'}
        </div>
        {authState === 'locked' && (
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold text-foreground"
            onClick={() => {
              setAuthState('checking');
              setUnlockRequest((value) => value + 1);
            }}
          >
            Unlock
          </button>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <PermissionProvider>
          <Router>
            <AuthenticatedApp />
          </Router>
        </PermissionProvider>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
