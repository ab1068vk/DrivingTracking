// @ts-check
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App as CapacitorApp } from '@capacitor/app';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { activeTripStore, applyThemeMode, localSettings, SETTINGS_CHANGED_EVENT } from '@/lib/trackingStore';
import { loadPrivacyZonesFromStorage, sweepExpiredPrivacyZones } from '@/lib/privacyZones';
import { isAndroid } from '@/lib/nativePlatform';
import { startNativeAutoTracking } from '@/lib/activityRecognition';
import { tripQueryKeys } from '@/api/trips';
import { openExportLocation } from '@/lib/nativeDownloads';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { setScreenCaptureAllowed } from '@/lib/screenSecurity';
import { APP_LOCK_SETTING_EVENT, authenticateDevice } from '@/lib/biometricGate';
import { checkIntegrity } from '@/lib/rasp';
import { checkAndRotateEncryptionKey } from '@/lib/keyRotationManager';
import { Lock, Route as RouteIcon } from 'lucide-react';
import { beginMeasure, measureAsync, measureSync } from '@/lib/performanceTriage';

import Layout from '@/components/Layout';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import LegalNoticeDialog from '@/components/LegalNoticeDialog';
import PageLoadingSkeleton from '@/components/PageLoadingSkeleton';
import { LEGAL_NOTICE_ACK_VERSION } from '@/lib/legalDisclaimers';
import { AppDialogHost } from '@/lib/appDialog';

async function syncNativeCompletedTripsToLocalStore() {
  if (!isAndroid()) return;
  const result = await measureAsync('app.nativeTripSync', async () => {
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');
    return syncNativeCompletedTrips();
  });
  if (result.importedTrips.length) {
    queryClientInstance.invalidateQueries({ queryKey: tripQueryKeys.summaries }).catch(() => {});
  }
  recordSystemEvent('native_completed_trips_synced', {
    trip_count: result.importedTrips.length,
    matched_active_manual_trip: Boolean(result.matchedActiveTrip),
  }, {
    category: 'background',
    source: 'android',
    title: 'Native completed trips imported',
  });
}

let privacyZoneExpirySweep = null;
const pendingIdleResumeTasks = new Set();
const scheduleIdleResumeTask = (name, task, source) => {
  if (pendingIdleResumeTasks.has(name)) return;
  pendingIdleResumeTasks.add(name);
  const run = () => {
    pendingIdleResumeTasks.delete(name);
    measureAsync(`app.resume.${name}`, task, { source })
      .catch((error) => logSystemFailure(`app_resume_${name}`, error));
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2000 });
  } else {
    window.setTimeout(run, 250);
  }
};
const sweepExpiredZonesOnForeground = () => {
  if (!privacyZoneExpirySweep) {
    privacyZoneExpirySweep = sweepExpiredPrivacyZones()
      .finally(() => {
        privacyZoneExpirySweep = null;
      });
  }
  return privacyZoneExpirySweep;
};

const showDebugRoutes = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEBUG_ROUTES === 'true';
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TripHistory = lazy(() => import('@/pages/TripHistory'));
const Trip3DReplay = lazy(() => import('@/pages/Trip3DReplay'));
const TripDetail = lazy(() => import('@/pages/TripDetail'));
const TripDrive3DPage = lazy(() => import('@/pages/TripDrive3DPage'));
const SpeedAnalysis = lazy(() => import('@/pages/SpeedAnalysis'));
const MapScreen = lazy(() => import('@/pages/MapScreen'));
const Reports = lazy(() => import('@/pages/Report'));
const Settings = lazy(() => import('@/pages/Settings'));
const SpeedLimits = lazy(() => import('@/pages/SpeedLimits'));
const PrivacyIntelligence = lazy(() => import('@/pages/PrivacyIntelligence'));
const AndroidReference = showDebugRoutes ? lazy(() => import('@/pages/AndroidReference')) : null;
const Vehicles = lazy(() => import('@/pages/Vehicles'));
const Achievements = lazy(() => import('@/pages/Achievements'));
const DrivingCoach = lazy(() => import('@/pages/DrivingCoach'));
const Diagnostics = lazy(() => import('@/pages/Diagnostics'));
const SystemLogs = lazy(() => import('@/pages/SystemLogs'));
const Insights = lazy(() => import('@/pages/Insights'));

function AppRouteBoundary({ context, title = 'Page unavailable', message = 'Something went wrong while opening this page. Reload to try again.', children }) {
  return (
    <Suspense fallback={<PageLoadingSkeleton title={`Loading ${title.toLowerCase()}`} />}>
      <SectionErrorBoundary context={context} title={title} message={message}>
        {children}
      </SectionErrorBoundary>
    </Suspense>
  );
}

function PageRouteSuspense({ title, children }) {
  return <Suspense fallback={<PageLoadingSkeleton title={title} />}>{children}</Suspense>;
}

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

function AppLockScreen({ busy, error, onUnlock }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 text-center shadow-xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Lock className="h-7 w-7" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">Road Sage is locked</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Use your fingerprint, secure face unlock, or device screen lock to continue.
        </p>
        {error && <p className="mt-3 text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="button"
          onClick={onUnlock}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {busy ? 'Waiting for authentication...' : 'Unlock'}
        </button>
      </div>
    </div>
  );
}

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const [onboardingDone, setOnboardingDone] = useState(null);
  const [legalNoticeOpen, setLegalNoticeOpen] = useState(false);
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [appLocked, setAppLocked] = useState(false);
  const [appLockBusy, setAppLockBusy] = useState(false);
  const [appLockError, setAppLockError] = useState('');
  const unlockInProgressRef = useRef(false);
  const backgroundedAtRef = useRef(0);
  const navigate = useNavigate();

  useEffect(() => {
    const bootstrapSettings = async () => {
      const endBootstrap = beginMeasure('app.coldBootstrap');
      const notificationService = import('@/lib/notificationService');
      notificationService
        .then(({ configureNotificationChannels }) => configureNotificationChannels())
        .catch((error) => logSystemFailure('notification_channels_configure', error));
      const settings = await measureAsync('app.bootstrap.settingsHydrate', () => localSettings.hydrateFromNative());
      const lockEnabled = isAndroid() && settings.app_lock_enabled === true;
      setAppLockEnabled(lockEnabled);
      setAppLocked(lockEnabled);
      setOnboardingDone(settings.onboarding_completed);
      const shouldShowFirstLaunchLegalNotice =
        Number(settings.legal_notice_ack_version) < LEGAL_NOTICE_ACK_VERSION;
      setLegalNoticeOpen(shouldShowFirstLaunchLegalNotice);
      applyThemeMode(settings.dark_mode);

      setScreenCaptureAllowed(settings.allow_screen_capture === true)
        .catch((error) => logSystemFailure('screen_capture_policy_apply', error));
      checkIntegrity()
        .catch((error) => logSystemFailure('device_integrity_check', error));
      try {
        await loadPrivacyZonesFromStorage(settings);
        await sweepExpiredZonesOnForeground();
      } catch (error) {
        logSystemFailure('privacy_zones_load', error);
      }
      activeTripStore.hydrate()
        .catch((error) => logSystemFailure('active_trip_hydrate', error));
      syncNativeCompletedTripsToLocalStore()
        .catch((error) => logSystemFailure('native_completed_trips_boot_sync', error));
      notificationService
        .then(({ syncReminderNotifications }) => syncReminderNotifications(settings, { requestPermission: false }))
        .catch((error) => logSystemFailure('reminder_notifications_sync', error));
      if (isAndroid() && settings.tracking_mode === 'background_auto' && !settings.tracking_paused) {
        startNativeAutoTracking()
          .catch((error) => logSystemFailure('app_boot_native_auto_tracking_start', error));
      }

      const runDeferredMaintenance = async () => {
        await measureAsync('app.bootstrap.tripRepositoryMaintenance', () => import('@/lib/localTripRepository')
          .then(({ runTripRepositoryMaintenance }) => runTripRepositoryMaintenance()))
          .catch((error) => logSystemFailure('trip_repository_maintenance', error));
        await measureAsync('app.bootstrap.keyRotation', () => checkAndRotateEncryptionKey())
          .catch((error) => logSystemFailure('encryption_key_rotation_check', error));
        measureAsync('app.bootstrap.roadContextQueue', () => import('@/lib/roadContextQueue')
          .then(({ resumePendingRoadContextJobs }) => resumePendingRoadContextJobs()))
          .catch((error) => logSystemFailure('road_context_queue_resume', error));
        import('@/lib/rescoringWorker')
          .then(({ startRescoringWorker }) => startRescoringWorker())
          .catch((error) => logSystemFailure('rescoring_worker_start', error));
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(runDeferredMaintenance, { timeout: 1500 });
      } else {
        window.setTimeout(runDeferredMaintenance, 0);
      }
      endBootstrap({ outcome: 'success' });
    };
    bootstrapSettings().catch((error) => {
      logSystemFailure('app_bootstrap', error);
      const fallbackSettings = localSettings.get?.() || {};
      setAppLockEnabled(false);
      setAppLocked(false);
      setOnboardingDone(Boolean(fallbackSettings.onboarding_completed));
      applyThemeMode(fallbackSettings.dark_mode);
    });
  }, []);

  useEffect(() => {
    const onSettingsChanged = (event) => {
      applyThemeMode(event.detail?.settings?.dark_mode);
    };
    applyThemeMode(localSettings.get().dark_mode);
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
  }, []);

  const unlockApp = async () => {
    if (unlockInProgressRef.current) return;
    unlockInProgressRef.current = true;
    setAppLockBusy(true);
    setAppLockError('');
    try {
      const result = await authenticateDevice('Verify to open your private driving data');
      if (result.verified) {
        setAppLocked(false);
        backgroundedAtRef.current = 0;
      } else {
        setAppLockError(result.cancelled ? 'Authentication was cancelled.' : 'Authentication was not verified.');
      }
    } catch (error) {
      logSystemFailure('app_lock_authenticate', error);
      setAppLockError(error?.message || 'Device authentication is unavailable.');
    } finally {
      unlockInProgressRef.current = false;
      setAppLockBusy(false);
    }
  };

  useEffect(() => {
    if (appLocked) void unlockApp();
  }, [appLocked]);

  useEffect(() => {
    if (!isAndroid()) return undefined;
    let appStateListener;

    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        applyThemeMode(localSettings.get().dark_mode);
        measureAsync('app.resume.privacyZoneSweep', () => sweepExpiredZonesOnForeground(), { source: 'appStateChange' })
          .catch((error) => logSystemFailure('app_resume_privacy_zone_expiry', error));
        measureAsync('app.resume.nativeTripSync', () => syncNativeCompletedTripsToLocalStore(), { source: 'appStateChange' })
          .catch((error) => logSystemFailure('app_resume_native_completed_trips_sync', error));
        measureAsync('app.resume.keyRotation', () => checkAndRotateEncryptionKey(), { source: 'appStateChange' })
          .catch((error) => logSystemFailure('app_resume_key_rotation_check', error));
        scheduleIdleResumeTask('roadContextQueue', () => import('@/lib/roadContextQueue')
          .then(({ resumePendingRoadContextJobs }) => resumePendingRoadContextJobs()), 'appStateChange');
        scheduleIdleResumeTask('rawGpsRetention', () => import('@/lib/localTripRepository')
          .then(({ enforceRawGpsRetention }) => enforceRawGpsRetention()), 'appStateChange');
      }
      if (!appLockEnabled) return;
      if (!isActive) {
        backgroundedAtRef.current = Date.now();
        return;
      }
      const backgroundedAt = backgroundedAtRef.current;
      if (backgroundedAt && Date.now() - backgroundedAt >= 5 * 60 * 1000) {
        setAppLocked(true);
      }
      backgroundedAtRef.current = 0;
    }).then((listener) => {
      appStateListener = listener;
    }).catch((error) => logSystemFailure('app_state_listener_register', error));

    return () => {
      appStateListener?.remove?.();
    };
  }, [appLockEnabled]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        applyThemeMode(localSettings.get().dark_mode);
        measureAsync('app.resume.privacyZoneSweep', () => sweepExpiredZonesOnForeground(), { source: 'visibilitychange' })
          .catch((error) => logSystemFailure('visibility_privacy_zone_expiry', error));
        measureAsync('app.resume.keyRotation', () => checkAndRotateEncryptionKey(), { source: 'visibilitychange' })
          .catch((error) => logSystemFailure('visibility_key_rotation_check', error));
        scheduleIdleResumeTask('roadContextQueue', () => import('@/lib/roadContextQueue')
          .then(({ resumePendingRoadContextJobs }) => resumePendingRoadContextJobs()), 'visibilitychange');
        scheduleIdleResumeTask('rawGpsRetention', () => import('@/lib/localTripRepository')
          .then(({ enforceRawGpsRetention }) => enforceRawGpsRetention()), 'visibilitychange');
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    const onAppLockSettingChanged = (event) => {
      const enabled = event.detail?.enabled === true;
      setAppLockEnabled(enabled);
      setAppLocked(enabled && event.detail?.authenticated !== true);
      if (!enabled) setAppLockError('');
    };
    window.addEventListener(APP_LOCK_SETTING_EVENT, onAppLockSettingChanged);
    return () => window.removeEventListener(APP_LOCK_SETTING_EVENT, onAppLockSettingChanged);
  }, []);

  const acknowledgeLegalNotice = () => {
    const acknowledgedAt = new Date().toISOString();
    localSettings.update({
      legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
      legal_notice_acknowledged_at: acknowledgedAt,
    });
    recordSystemEvent('legal_notice_acknowledged', {
      notice_version: LEGAL_NOTICE_ACK_VERSION,
      acknowledged_at: acknowledgedAt,
    }, {
      title: 'Legal notice acknowledged',
      category: 'settings',
    });
    setLegalNoticeOpen(false);
  };

  useEffect(() => {
    let listener;
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const extra = action.notification?.extra ?? {};
      if (extra.tripId) navigate(`/trips/${extra.tripId}`);
      else if (extra.type === 'phone_use_pattern') navigate('/coach');
      else if (extra.type === 'maintenance') navigate('/vehicles');
      else if (extra.type === 'export_saved') {
        openExportLocation({ uri: extra.uri, mimeType: extra.mimeType }).catch((error) => {
          logSystemFailure('notification_export_location_open', error, {
            notification_type: extra.type,
            has_uri: Boolean(extra.uri),
          });
          navigate('/reports');
        });
      }
    }).then((handle) => {
      listener = handle;
    }).catch((error) => logSystemFailure('notification_action_listener_register', error));
    return () => {
      listener?.remove?.();
    };
  }, [navigate]);

  if (isLoadingPublicSettings || isLoadingAuth || onboardingDone === null) {
    return <AppLoading />;
  }

  if (appLocked) {
    return <AppLockScreen busy={appLockBusy} error={appLockError} onUnlock={unlockApp} />;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') return <UserNotRegisteredError />;
    if (authError.type === 'auth_required') { navigateToLogin(); return null; }
    // For other errors (network, unknown), still render the app in public mode
  }

  return (
    <>
      <Routes>
        {/* Onboarding (no layout) - only shown to new users */}
        {!onboardingDone && (
          <Route
            path="*"
            element={(
              <AppRouteBoundary context="onboarding_page" title="Onboarding unavailable">
                <Onboarding onComplete={() => setOnboardingDone(true)} />
              </AppRouteBoundary>
            )}
          />
        )}

        {/* Main App with shared Layout */}
        <Route element={<Layout />}>
          <Route path="/" element={(
            <AppRouteBoundary context="dashboard_page" title="Dashboard unavailable">
              <Dashboard />
            </AppRouteBoundary>
          )} />
          <Route path="/trips" element={(
            <AppRouteBoundary context="trip_history_page" title="Trip history unavailable">
              <TripHistory />
            </AppRouteBoundary>
          )} />
          <Route path="/3d-replay" element={(
            <AppRouteBoundary context="trip_3d_replay_page" title="3D replay unavailable">
              <Trip3DReplay />
            </AppRouteBoundary>
          )} />
          <Route path="/trips/:id" element={(
            <PageRouteSuspense title="Loading trip detail">
              <SectionErrorBoundary
                context="trip_detail_page"
                title="Trip detail unavailable"
                message="Something went wrong while opening this trip. Reload to try again."
              >
                <TripDetail />
              </SectionErrorBoundary>
            </PageRouteSuspense>
          )} />
          <Route path="/trips/:id/speed" element={(
            <PageRouteSuspense title="Loading speed analysis">
              <SectionErrorBoundary
                context="speed_analysis_page"
                title="Speed analysis unavailable"
                message="Something went wrong while opening speed analysis for this trip. Reload to try again."
              >
                <SpeedAnalysis />
              </SectionErrorBoundary>
            </PageRouteSuspense>
          )} />
          <Route path="/trips/:id/3d" element={(
            <PageRouteSuspense title="Loading 3D drive">
              <SectionErrorBoundary
                context="trip_3d_page"
                title="3D drive unavailable"
                message="Something went wrong while opening the 3D drive. Reload to try again."
              >
                <TripDrive3DPage />
              </SectionErrorBoundary>
            </PageRouteSuspense>
          )} />
          <Route path="/map" element={(
            <AppRouteBoundary context="map_page" title="Map unavailable">
              <MapScreen />
            </AppRouteBoundary>
          )} />
          <Route path="/coach" element={(
            <AppRouteBoundary context="driving_coach_page" title="Coach unavailable">
              <DrivingCoach />
            </AppRouteBoundary>
          )} />
          <Route path="/insights" element={(
            <AppRouteBoundary context="insights_page" title="Insights unavailable">
              <Insights />
            </AppRouteBoundary>
          )} />
          <Route path="/achievements" element={(
            <AppRouteBoundary context="achievements_page" title="Milestones unavailable">
              <Achievements />
            </AppRouteBoundary>
          )} />
          <Route path="/reports" element={(
            <AppRouteBoundary context="reports_page" title="Reports unavailable">
              <Reports />
            </AppRouteBoundary>
          )} />
          <Route path="/diagnostics" element={(
            <AppRouteBoundary context="diagnostics_page" title="Diagnostics unavailable">
              <Diagnostics />
            </AppRouteBoundary>
          )} />
          <Route path="/system-logs" element={(
            <AppRouteBoundary context="system_logs_page" title="System logs unavailable">
              <SystemLogs />
            </AppRouteBoundary>
          )} />
          <Route path="/settings" element={(
            <AppRouteBoundary context="settings_page" title="Settings unavailable">
              <Settings />
            </AppRouteBoundary>
          )} />
          <Route path="/speed-limits" element={(
            <AppRouteBoundary context="speed_limits_page" title="Saved road speeds unavailable">
              <SpeedLimits />
            </AppRouteBoundary>
          )} />
          <Route path="/privacy-intelligence" element={(
            <AppRouteBoundary context="privacy_intelligence_page" title="Privacy intelligence unavailable">
              <PrivacyIntelligence />
            </AppRouteBoundary>
          )} />
          {showDebugRoutes && AndroidReference && (
            <Route path="/android" element={(
              <AppRouteBoundary context="android_reference_page" title="Android reference unavailable">
                <AndroidReference />
              </AppRouteBoundary>
            )} />
          )}
          <Route path="/vehicles" element={(
            <AppRouteBoundary context="vehicles_page" title="Vehicles unavailable">
              <Vehicles />
            </AppRouteBoundary>
          )} />
        </Route>

        <Route path="*" element={(
          <AppRouteBoundary context="not_found_page" title="Page unavailable">
            <PageNotFound />
          </AppRouteBoundary>
        )} />
      </Routes>
      <LegalNoticeDialog
        open={legalNoticeOpen}
        onOpenChange={(open) => {
          if (open) setLegalNoticeOpen(true);
        }}
        onAcknowledge={acknowledgeLegalNotice}
      />
    </>
  );
};

function RouteLogger() {
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const payload = {
      pathname: location.pathname,
      has_search: Boolean(location.search),
      search_param_keys: [...params.keys()].slice(0, 20),
    };
    const run = () => measureSync('RouteLogger.recordSystemEvent', () => {
      recordSystemEvent('route_changed', payload, {
        title: 'Page opened',
        category: 'navigation',
      });
    }, { pathname: location.pathname });
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      window.setTimeout(run, 250);
    }
  }, [location.pathname, location.search]);

  return null;
}

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <RouteLogger />
          <AuthenticatedApp />
        </Router>
        <AppDialogHost />
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
