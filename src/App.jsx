// @ts-check
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion';
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App as CapacitorApp } from '@capacitor/app';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { activeTripStore, applyThemeMode, isTrackingExperienceMode, localSettings, SETTINGS_CHANGED_EVENT } from '@/lib/trackingStore';
import { loadPrivacyZonesFromStorage, sweepExpiredPrivacyZones } from '@/lib/privacyZones';
import { isAndroid } from '@/lib/nativePlatform';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { APP_LOCK_SETTING_EVENT } from '@/lib/appConstants';
import { Lock, Route as RouteIcon } from 'lucide-react';
import { beginMeasure, measureAsync, measureSync } from '@/lib/performanceTriage';

import Layout from '@/components/Layout';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import LegalNoticeDialog from '@/components/LegalNoticeDialog';
import PageLoadingSkeleton from '@/components/PageLoadingSkeleton';
import AppInteractionFeedback from '@/components/AppInteractionFeedback';
import { AppDialogHost } from '@/lib/appDialog';
import { LEGAL_NOTICE_ACK_VERSION } from '@/lib/legalDisclaimers';
import { useLocalSettingSelector } from '@/hooks/useLocalSettings';
import {
  createInitialAppUrlConsumer,
  pathForNotificationExtra,
  pathFromAppUrl,
} from '@/lib/appNavigation';

const TRIP_SUMMARIES_QUERY_KEY = ['trip-summaries'];
const consumeInitialAppUrl = createInitialAppUrlConsumer();

const startNativeAutoTrackingFromApp = () => import('@/lib/activityRecognition')
  .then(({ startNativeAutoTracking }) => startNativeAutoTracking());

const checkAndRotateEncryptionKeyFromApp = () => import('@/lib/keyRotationManager')
  .then(({ checkAndRotateEncryptionKey }) => checkAndRotateEncryptionKey());

const setScreenCaptureAllowedFromApp = (allowed) => import('@/lib/screenSecurity')
  .then(({ setScreenCaptureAllowed }) => setScreenCaptureAllowed(allowed));

const checkIntegrityFromApp = () => import('@/lib/rasp')
  .then(({ checkIntegrity }) => checkIntegrity());

const authenticateDeviceFromApp = (reason) => import('@/lib/biometricGate')
  .then(({ authenticateDevice }) => authenticateDevice(reason));

const openExportLocationFromApp = (options) => import('@/lib/nativeDownloads')
  .then(({ openExportLocation }) => openExportLocation(options));

async function syncNativeCompletedTripsToLocalStore({ reconcileExisting = false } = {}) {
  if (!isAndroid()) return;
  const result = await measureAsync('app.nativeTripSync', async () => {
    const { syncNativeCompletedTripsAndMilestones } = await import('@/lib/milestoneNotificationCoordinator');
    return syncNativeCompletedTripsAndMilestones({ reconcileExisting });
  });
  if (result.importedTrips.length) {
    const { markLatestTripForPostDriveReview } = await import('@/lib/postDriveReview');
    await markLatestTripForPostDriveReview(result.importedTrips, 'native_background_import');
    queryClientInstance.invalidateQueries({ queryKey: TRIP_SUMMARIES_QUERY_KEY }).catch(() => {});
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
const scheduleAfterQuietPeriod = (task, { quietMs = 12_000 } = {}) => {
  let timerId = 0;
  let idleId = 0;
  let cancelled = false;

  const cancelScheduledRun = () => {
    window.clearTimeout(timerId);
    if (idleId && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
    }
    timerId = 0;
    idleId = 0;
  };

  const run = () => {
    if (cancelled) return;
    window.removeEventListener('app:user-interaction', schedule);
    void task();
  };

  function schedule() {
    if (cancelled) return;
    cancelScheduledRun();
    timerId = window.setTimeout(() => {
      timerId = 0;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(run);
      } else {
        timerId = window.setTimeout(run, 500);
      }
    }, quietMs);
  }

  window.addEventListener('app:user-interaction', schedule);
  schedule();

  return () => {
    cancelled = true;
    cancelScheduledRun();
    window.removeEventListener('app:user-interaction', schedule);
  };
};

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
const TrackingOverview = lazy(() => import('@/pages/TrackingOverview'));
const TrackingMapWorkspace = lazy(() => import('@/pages/TrackingMapWorkspace'));
const TrackingEvents = lazy(() => import('@/pages/TrackingEvents'));
const TrackingPrivacyConsole = lazy(() => import('@/pages/TrackingPrivacyConsole'));
const TrackingAlertsLab = lazy(() => import('@/pages/TrackingAlertsLab'));
const TrackingEvidenceConsole = lazy(() => import('@/pages/TrackingEvidenceConsole'));
const TrackingReportsLab = lazy(() => import('@/pages/TrackingReportsLab'));
const TrackingReplayPro = lazy(() => import('@/pages/TrackingReplayPro'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TripHistory = lazy(() => import('@/pages/TripHistory'));
const TrackingTripHistory = lazy(() => import('@/pages/TrackingTripHistory'));
const Trip3DReplay = lazy(() => import('@/pages/Trip3DReplay'));
const TripDetail = lazy(() => import('@/pages/TripDetail'));
const TrackingTripDetail = lazy(() => import('@/pages/TrackingTripDetail'));
const TripDrive3DPage = lazy(() => import('@/pages/TripDrive3DPage'));
const SpeedAnalysis = lazy(() => import('@/pages/SpeedAnalysis'));
const MapScreen = lazy(() => import('@/pages/MapScreen'));
const Parking = lazy(() => import('@/pages/Parking'));
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
  const loadingTitle = title.replace(/\s+unavailable$/i, '');
  return (
    <Suspense fallback={<PageLoadingSkeleton title={`Loading ${loadingTitle.toLowerCase()}`} />}>
      <SectionErrorBoundary context={context} title={title} message={message}>
        {children}
      </SectionErrorBoundary>
    </Suspense>
  );
}

function HomeRoute() {
  const trackingExperienceMode = useLocalSettingSelector(isTrackingExperienceMode);
  if (trackingExperienceMode) return <Navigate to="/tracking" replace />;
  return (
    <AppRouteBoundary context="dashboard_page" title="Dashboard unavailable">
      <Dashboard />
    </AppRouteBoundary>
  );
}

function TripHistoryRoute() {
  const trackingExperienceMode = useLocalSettingSelector(isTrackingExperienceMode);
  return trackingExperienceMode ? <TrackingTripHistory /> : <TripHistory />;
}

function TripDetailRoute() {
  const trackingExperienceMode = useLocalSettingSelector(isTrackingExperienceMode);
  return trackingExperienceMode ? <TrackingTripDetail /> : <TripDetail />;
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
    let disposed = false;
    const cancelDeferredTasks = [];
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

      setScreenCaptureAllowedFromApp(settings.allow_screen_capture === true)
        .catch((error) => logSystemFailure('screen_capture_policy_apply', error));
      checkIntegrityFromApp()
        .catch((error) => logSystemFailure('device_integrity_check', error));
      try {
        await loadPrivacyZonesFromStorage(settings);
        await sweepExpiredZonesOnForeground();
      } catch (error) {
        logSystemFailure('privacy_zones_load', error);
      }
      activeTripStore.hydrate()
        .catch((error) => logSystemFailure('active_trip_hydrate', error));
      // reconcileExisting so milestones crossed by locally-recorded trips (which
      // never appear in the native import list) are still evaluated.
      syncNativeCompletedTripsToLocalStore({ reconcileExisting: true })
        .catch((error) => logSystemFailure('native_completed_trips_boot_sync', error));
      notificationService
        .then(({ syncReminderNotifications }) => syncReminderNotifications(settings, { requestPermission: false }))
        .catch((error) => logSystemFailure('reminder_notifications_sync', error));
      if (isAndroid() && settings.tracking_mode === 'background_auto' && !settings.tracking_paused) {
        startNativeAutoTrackingFromApp()
          .catch((error) => logSystemFailure('app_boot_native_auto_tracking_start', error));
      }

      if (!disposed) {
        cancelDeferredTasks.push(
          scheduleAfterQuietPeriod(
            () => measureAsync('app.bootstrap.tripRepositoryMaintenance', () => import('@/lib/localTripRepository')
              .then(({ runTripRepositoryMaintenance }) => runTripRepositoryMaintenance()))
              .catch((error) => logSystemFailure('trip_repository_maintenance', error)),
            { quietMs: 12_000 }
          ),
          scheduleAfterQuietPeriod(
            () => measureAsync('app.bootstrap.keyRotation', () => checkAndRotateEncryptionKeyFromApp())
              .catch((error) => logSystemFailure('encryption_key_rotation_check', error)),
            { quietMs: 22_000 }
          ),
          scheduleAfterQuietPeriod(async () => {
            await measureAsync('app.bootstrap.roadContextQueue', () => import('@/lib/roadContextQueue')
              .then(({ resumePendingRoadContextJobs }) => resumePendingRoadContextJobs()))
              .catch((error) => logSystemFailure('road_context_queue_resume', error));
            await import('@/lib/rescoringWorker')
              .then(({ startRescoringWorker }) => startRescoringWorker())
              .catch((error) => logSystemFailure('rescoring_worker_start', error));
          }, { quietMs: 30_000 })
        );
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
    return () => {
      disposed = true;
      cancelDeferredTasks.forEach((cancel) => cancel());
    };
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
      const result = await authenticateDeviceFromApp('Verify to open your private driving data');
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
        localSettings.hydrateFromNative()
          .then((settings) => applyThemeMode(settings.dark_mode))
          .catch((error) => logSystemFailure('app_resume_settings_hydrate', error));
        measureAsync('app.resume.privacyZoneSweep', () => sweepExpiredZonesOnForeground(), { source: 'appStateChange' })
          .catch((error) => logSystemFailure('app_resume_privacy_zone_expiry', error));
        measureAsync('app.resume.nativeTripSync', () => syncNativeCompletedTripsToLocalStore({ reconcileExisting: true }), { source: 'appStateChange' })
          .catch((error) => logSystemFailure('app_resume_native_completed_trips_sync', error));
        measureAsync('app.resume.keyRotation', () => checkAndRotateEncryptionKeyFromApp(), { source: 'appStateChange' })
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
        localSettings.hydrateFromNative()
          .then((settings) => applyThemeMode(settings.dark_mode))
          .catch((error) => logSystemFailure('visibility_settings_hydrate', error));
        measureAsync('app.resume.privacyZoneSweep', () => sweepExpiredZonesOnForeground(), { source: 'visibilitychange' })
          .catch((error) => logSystemFailure('visibility_privacy_zone_expiry', error));
        measureAsync('app.resume.keyRotation', () => checkAndRotateEncryptionKeyFromApp(), { source: 'visibilitychange' })
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
      if (extra.type === 'parking_reminder' && action.actionId === 'snooze_15') {
        import('@/lib/notificationService')
          .then(({ snoozeParkingReminder }) => snoozeParkingReminder(15))
          .catch((error) => logSystemFailure('parking_reminder_snooze_15', error));
        return;
      }
      if (extra.type === 'parking_reminder' && action.actionId === 'snooze_60') {
        import('@/lib/notificationService')
          .then(({ snoozeParkingReminder }) => snoozeParkingReminder(60))
          .catch((error) => logSystemFailure('parking_reminder_snooze_60', error));
        return;
      }
      if (extra.type === 'parking_reminder' && action.actionId === 'parking_done') {
        import('@/lib/notificationService')
          .then(({ cancelParkingReminder }) => cancelParkingReminder())
          .catch((error) => logSystemFailure('parking_reminder_done', error));
        return;
      }
      if (extra.type === 'export_saved') {
        openExportLocationFromApp({ uri: extra.uri, mimeType: extra.mimeType }).catch((error) => {
          logSystemFailure('notification_export_location_open', error, {
            notification_type: extra.type,
            has_uri: Boolean(extra.uri),
          });
          navigate('/reports');
        });
        return;
      }
      const path = pathForNotificationExtra(extra);
      if (path) navigate(path);
    }).then((handle) => {
      listener = handle;
    }).catch((error) => logSystemFailure('notification_action_listener_register', error));
    return () => {
      listener?.remove?.();
    };
  }, [navigate]);

  useEffect(() => {
    let listener;
    let cancelled = false;
    /** @param {{url?: string}} [payload] */
    const openUrl = (payload = {}) => {
      const { url } = payload;
      const path = pathFromAppUrl(url);
      if (path) navigate(path);
    };
    /** @param {{url?: string}} [payload] */
    const openInitialUrl = (payload = {}) => {
      if (cancelled) return;
      const path = consumeInitialAppUrl(payload.url);
      if (path) navigate(path, { replace: true });
    };
    CapacitorApp.getLaunchUrl()
      .then((result) => openInitialUrl(result || {}))
      .catch((error) => logSystemFailure('app_launch_url_read', error));
    CapacitorApp.addListener('appUrlOpen', openUrl)
      .then((handle) => {
        if (cancelled) handle?.remove?.();
        else listener = handle;
      })
      .catch((error) => logSystemFailure('app_url_listener_register', error));
    return () => {
      cancelled = true;
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
          <Route path="/tracking" element={(
            <AppRouteBoundary context="tracking_overview_page" title="Tracking overview unavailable">
              <TrackingOverview />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/recorder" element={(
            <AppRouteBoundary context="tracking_recorder_page" title="Tracking recorder unavailable">
              <Dashboard />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/map" element={(
            <AppRouteBoundary context="tracking_map_workspace_page" title="Tracking map workspace unavailable">
              <TrackingMapWorkspace />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/events" element={(
            <AppRouteBoundary context="tracking_events_page" title="Tracking events unavailable">
              <TrackingEvents />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/alerts" element={(
            <AppRouteBoundary context="tracking_alerts_lab_page" title="Tracking alerts lab unavailable">
              <TrackingAlertsLab />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/evidence" element={(
            <AppRouteBoundary context="tracking_evidence_console_page" title="Tracking evidence console unavailable">
              <TrackingEvidenceConsole />
            </AppRouteBoundary>
          )} />
          {/* Merged into Saved Road Speeds as its Diagnostics workspace. Kept as
              a redirect rather than removed, so bookmarks and any link still
              pointing here land on the same content instead of a 404. */}
          <Route path="/tracking/speed" element={<Navigate to="/speed-limits?view=console" replace />} />
          <Route path="/tracking/privacy" element={(
            <AppRouteBoundary context="tracking_privacy_console_page" title="Tracking privacy console unavailable">
              <TrackingPrivacyConsole />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/reports" element={(
            <AppRouteBoundary context="tracking_reports_lab_page" title="Tracking reports lab unavailable">
              <TrackingReportsLab />
            </AppRouteBoundary>
          )} />
          <Route path="/tracking/replay" element={(
            <AppRouteBoundary context="tracking_replay_pro_page" title="Tracking replay pro unavailable">
              <TrackingReplayPro />
            </AppRouteBoundary>
          )} />
          <Route path="/" element={<HomeRoute />} />
          <Route path="/trips" element={(
            <AppRouteBoundary context="trip_history_page" title="Trip history unavailable">
              <TripHistoryRoute />
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
                <TripDetailRoute />
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
          <Route path="/parking" element={(
            <AppRouteBoundary context="parking_page" title="Parking unavailable">
              <Parking />
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
    const endFirstPaint = beginMeasure('page.firstPaint', { pathname: location.pathname });
    let firstFrame = 0;
    let secondFrame = 0;
    if (typeof window.requestAnimationFrame === 'function') {
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => endFirstPaint({ outcome: 'painted' }));
      });
    } else {
      secondFrame = window.setTimeout(() => endFirstPaint({ outcome: 'painted' }), 32);
    }
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
    return () => {
      if (firstFrame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(firstFrame);
      if (secondFrame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(secondFrame);
      else if (secondFrame) window.clearTimeout(secondFrame);
      endFirstPaint({ outcome: 'cancelled' });
    };
  }, [location.pathname, location.search]);

  return null;
}

function App() {
  return (
    // reducedMotion="user" honours the OS "reduce motion" setting for every framer-motion
    // animation in the app. It previously only applied inside Achievements, so the other
    // pages animated regardless of the user's accessibility preference.
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <RouteLogger />
            <AppInteractionFeedback />
            <AuthenticatedApp />
          </Router>
          <AppDialogHost />
          <Toaster />
        </QueryClientProvider>
      </AuthProvider>
    </MotionConfig>
  );
}

export default App;
