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
import { activeTripStore, applyThemeMode, localSettings } from '@/lib/trackingStore';
import { loadPrivacyZonesFromStorage } from '@/lib/privacyZones';
import { isAndroid } from '@/lib/nativePlatform';
import { startNativeAutoTracking } from '@/lib/activityRecognition';
import { openExportLocation } from '@/lib/nativeDownloads';
import { recordSystemEvent } from '@/lib/systemLog';
import { setScreenCaptureAllowed } from '@/lib/screenSecurity';
import { APP_LOCK_SETTING_EVENT, authenticateDevice } from '@/lib/biometricGate';
import { checkIntegrity } from '@/lib/rasp';
import { Lock, Route as RouteIcon } from 'lucide-react';

import Layout from '@/components/Layout';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import LegalNoticeDialog from '@/components/LegalNoticeDialog';
import { LEGAL_NOTICE_ACK_VERSION } from '@/lib/legalDisclaimers';

const showDebugRoutes = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEBUG_ROUTES === 'true';
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TripHistory = lazy(() => import('@/pages/TripHistory'));
const TripDetail = lazy(() => import('@/pages/TripDetail'));
const MapScreen = lazy(() => import('@/pages/MapScreen'));
const Reports = lazy(() => import('@/pages/Report'));
const Settings = lazy(() => import('@/pages/Settings'));
const AndroidReference = showDebugRoutes ? lazy(() => import('@/pages/AndroidReference')) : null;
const Vehicles = lazy(() => import('@/pages/Vehicles'));
const Achievements = lazy(() => import('@/pages/Achievements'));
const DrivingCoach = lazy(() => import('@/pages/DrivingCoach'));
const Diagnostics = lazy(() => import('@/pages/Diagnostics'));
const SystemLogs = lazy(() => import('@/pages/SystemLogs'));
const Insights = lazy(() => import('@/pages/Insights'));

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
      const notificationService = import('@/lib/notificationService');
      notificationService
        .then(({ configureNotificationChannels }) => configureNotificationChannels())
        .catch(() => {});
      const settings = await localSettings.hydrateFromNative();
      await setScreenCaptureAllowed(settings.allow_screen_capture === true).catch(() => {});
      await checkIntegrity().catch(() => {});
      const lockEnabled = isAndroid() && settings.app_lock_enabled === true;
      setAppLockEnabled(lockEnabled);
      setAppLocked(lockEnabled);
      await loadPrivacyZonesFromStorage(settings);
      await import('@/lib/localTripRepository')
        .then(({ migrateLegacyTripStorageToEncrypted }) => migrateLegacyTripStorageToEncrypted())
        .catch(() => {});
      await activeTripStore.hydrate();
      import('@/lib/rescoringWorker')
        .then(({ startRescoringWorker }) => startRescoringWorker())
        .catch(() => {});
      notificationService
        .then(({ syncReminderNotifications }) => syncReminderNotifications(settings, { requestPermission: false }))
        .catch(() => {});
      setOnboardingDone(settings.onboarding_completed);
      const shouldShowFirstLaunchLegalNotice = !settings.onboarding_completed &&
        Number(settings.legal_notice_ack_version) < LEGAL_NOTICE_ACK_VERSION;
      setLegalNoticeOpen(shouldShowFirstLaunchLegalNotice);
      if (isAndroid() && settings.tracking_mode === 'background_auto' && !settings.tracking_paused) {
        startNativeAutoTracking().catch(() => {});
      }

      applyThemeMode(settings.dark_mode);
    };
    bootstrapSettings();
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
    }).catch(() => {});

    return () => {
      appStateListener?.remove?.();
    };
  }, [appLockEnabled]);

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
        openExportLocation({ uri: extra.uri, mimeType: extra.mimeType }).catch(() => {
          navigate('/reports');
        });
      }
    }).then((handle) => {
      listener = handle;
    }).catch(() => {});
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
      <Suspense fallback={<AppLoading />}>
      <Routes>
        {/* Onboarding (no layout) - only shown to new users */}
        {!onboardingDone && <Route path="*" element={<Onboarding onComplete={() => setOnboardingDone(true)} />} />}

        {/* Main App with shared Layout */}
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/trips" element={<TripHistory />} />
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
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/system-logs" element={<SystemLogs />} />
          <Route path="/settings" element={<Settings />} />
          {showDebugRoutes && AndroidReference && <Route path="/android" element={<AndroidReference />} />}
          <Route path="/vehicles" element={<Vehicles />} />
        </Route>

        <Route path="*" element={<PageNotFound />} />
      </Routes>
      </Suspense>
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
    recordSystemEvent('route_changed', {
      pathname: location.pathname,
      has_search: Boolean(location.search),
      search_param_keys: [...params.keys()].slice(0, 20),
    }, {
      title: 'Page opened',
      category: 'navigation',
    });
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
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
