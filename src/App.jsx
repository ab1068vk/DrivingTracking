import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useNavigate } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { lazy, Suspense, useEffect, useState } from 'react';
import { applyThemeMode, localSettings } from '@/lib/trackingStore';
import { PermissionProvider } from '@/lib/permissions/PermissionContext';
import { configureNotificationChannels, syncReminderNotifications } from '@/lib/notificationService';
import { getNativeAutoTrackingStatus, startNativeAutoTracking } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { openExportLocation } from '@/lib/nativeDownloads';
import { logError } from '@/lib/errorReporting';
import { notifyUserError } from '@/lib/userFeedback';
import { reverifyConfiguredOsrmEndpoint } from '@/lib/osrmEndpointVerifier';
import {
  BIOMETRIC_LOCK_STATE_CHANGE_EVENT,
  isBiometricLockEnabled,
  isLocked,
  lock,
  markUnlocked,
  msUntilAutoLock,
  setBiometricLockEnabled,
} from '@/lib/biometricLock';
import { authenticateBiometricGate } from '@/lib/nativeBiometricGate';
import { BIOMETRIC_AUTH_TIMEOUT_MS } from '@/lib/appConstants';
import { toast } from '@/components/ui/use-toast';
import { Route as RouteIcon } from 'lucide-react';

import Layout from '@/components/Layout';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import { PageSkeleton } from '@/components/PageSkeleton';

// Debug routes are only available in Vite development mode.
// import.meta.env.DEV is a compile-time constant set to true by the Vite dev
// server and false in every npm run build output.
const showDebugRoutes = import.meta.env.DEV;
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TripHistory = lazy(() => import('@/pages/TripHistory'));
const TripDetail = lazy(() => import('@/pages/TripDetail'));
const SurveyPage = lazy(() => import('@/pages/SurveyPage'));
const MapScreen = lazy(() => import('@/pages/MapScreen'));
const Reports = lazy(() => import('@/pages/Report'));
const Settings = lazy(() => import('@/pages/Settings'));
const AndroidReference = showDebugRoutes ? lazy(() => import('@/pages/AndroidReference')) : null;
const Vehicles = lazy(() => import('@/pages/Vehicles'));
const Achievements = lazy(() => import('@/pages/Achievements'));
const DrivingCoach = lazy(() => import('@/pages/DrivingCoach'));
const Diagnostics = showDebugRoutes ? lazy(() => import('@/pages/Diagnostics')) : null;
const Insights = lazy(() => import('@/pages/Insights'));

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

const persistBiometricLockDisabled = () => {
  try {
    localSettings.update({ biometric_lock_enabled: false });
  } catch (err) {
    logError('biometric_lock_disable_persist', err);
  }
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

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const [onboardingDone, setOnboardingDone] = useState(() => localSettings.get().onboarding_completed);
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
      const cachedSettings = localSettings.get();
      setBiometricLockEnabled(cachedSettings?.biometric_lock_enabled === true);
      setOnboardingDone(cachedSettings.onboarding_completed);
      applyThemeMode(cachedSettings.dark_mode);

      scheduleDataRetentionPrune(cachedSettings.data_retention_months);
      reverifyConfiguredOsrmEndpoint(cachedSettings).then(({ result }) => {
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
      syncReminderNotifications(cachedSettings, { requestPermission: false }).catch((err) => {
        notifyUserError('reminder_notification_sync', err, {
          title: 'Reminder sync delayed',
          description: 'Reminder notifications could not be refreshed. Road Sage will try again when settings reload.',
          extra: { tracking_mode: cachedSettings.tracking_mode },
        });
      });
      nativeHydrationTimer = window.setTimeout(async () => {
        const settings = await withLaunchTimeout(
          localSettings.hydrateFromNative(),
          cachedSettings,
          'settings_hydrate_deferred_timeout',
          2500,
          { logTimeout: false }
        );
        setBiometricLockEnabled(settings?.biometric_lock_enabled === true);
        setOnboardingDone(settings.onboarding_completed);
        applyThemeMode(settings.dark_mode);
        scheduleDataRetentionPrune(settings.data_retention_months);
        await ensureNativeAutoTrackingStarted(settings, 'native_auto_tracking_start_after_hydration');
      }, 2500);
    };
    bootstrapSettings();
    return () => {
      if (nativeHydrationTimer !== null) window.clearTimeout(nativeHydrationTimer);
    };
  }, []);

  useEffect(() => {
    const lockOnHidden = () => {
      if (document.visibilityState === 'hidden' && isBiometricLockEnabled()) lock();
    };
    document.addEventListener('visibilitychange', lockOnHidden);

    let appStateListener;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive && isBiometricLockEnabled()) lock();
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

  return (
    <Suspense fallback={<PageSkeleton />}>
    <Routes>
      {/* Onboarding (no layout) - only shown to new users */}
      {!onboardingDone && <Route path="*" element={<Onboarding onComplete={() => setOnboardingDone(true)} />} />}

      {/* Main App with shared Layout */}
      <Route element={<BiometricRouteGuard><Layout /></BiometricRouteGuard>}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/trips" element={<TripHistory />} />
        <Route path="/survey/:tripId" element={<SurveyPage />} />
        <Route path="/trips/:id" element={(
          <SectionErrorBoundary
            context="trip_detail_page"
            title="Trip detail unavailable"
            message="Something went wrong while opening this trip. Reload to try again."
          >
            <TripDetail />
          </SectionErrorBoundary>
        )} />
        <Route path="/map" element={<MapScreen />} />
        <Route path="/coach" element={<DrivingCoach />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/achievements" element={<Achievements />} />
        <Route path="/reports" element={<Reports />} />
        {showDebugRoutes && Diagnostics && <Route path="/diagnostics" element={<Diagnostics />} />}
        <Route path="/settings" element={(
          <SectionErrorBoundary context="settings_page">
            <Settings />
          </SectionErrorBoundary>
        )} />
        {showDebugRoutes && AndroidReference && <Route path="/android" element={<AndroidReference />} />}
        <Route path="/vehicles" element={<Vehicles />} />
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
    </Suspense>
  );
};

function BiometricRouteGuard({ children }) {
  const [authState, setAuthState] = useState('unlocked');
  const [unlockRequest, setUnlockRequest] = useState(0);

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
        if (err?.message === 'auth_timeout' || err?.message === 'unavailable') {
          clearAutoLockTimer();
          setBiometricLockEnabled(false);
          persistBiometricLockDisabled();
          markUnlocked();
          setAuthState('unlocked');
          console.warn('[biometricLock] auth unavailable, lock disabled:', err.message);
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

    verify();
    document.addEventListener('visibilitychange', verifyOnVisible);
    window.addEventListener(BIOMETRIC_LOCK_STATE_CHANGE_EVENT, verifyOnBiometricSettingsChange);
    return () => {
      cancelled = true;
      clearAutoLockTimer();
      document.removeEventListener('visibilitychange', verifyOnVisible);
      window.removeEventListener(BIOMETRIC_LOCK_STATE_CHANGE_EVENT, verifyOnBiometricSettingsChange);
    };
  }, [unlockRequest]);

  if (authState === 'unlocked') return children;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background px-4">
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
