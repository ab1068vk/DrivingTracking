import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { LocalNotifications } from '@capacitor/local-notifications';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { lazy, Suspense, useEffect, useState } from 'react';
import { applyThemeMode, localSettings } from '@/lib/trackingStore';
import { isAndroid } from '@/lib/nativePlatform';
import { openExportLocation } from '@/lib/nativeDownloads';
import { recordSystemEvent } from '@/lib/systemLog';
import { Route as RouteIcon } from 'lucide-react';

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

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const [onboardingDone, setOnboardingDone] = useState(null);
  const [legalNoticeOpen, setLegalNoticeOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const bootstrapSettings = async () => {
      const notificationService = import('@/lib/notificationService');
      notificationService
        .then(({ configureNotificationChannels }) => configureNotificationChannels())
        .catch(() => {});
      const settings = await localSettings.hydrateFromNative();
      notificationService
        .then(({ syncReminderNotifications }) => syncReminderNotifications(settings, { requestPermission: false }))
        .catch(() => {});
      setOnboardingDone(settings.onboarding_completed);
      const shouldShowFirstLaunchLegalNotice = !settings.onboarding_completed &&
        Number(settings.legal_notice_ack_version) < LEGAL_NOTICE_ACK_VERSION;
      setLegalNoticeOpen(shouldShowFirstLaunchLegalNotice);
      if (isAndroid() && settings.tracking_mode === 'background_auto' && !settings.tracking_paused) {
        import('@/lib/activityRecognition')
          .then(({ startNativeAutoTracking }) => startNativeAutoTracking())
          .catch(() => {});
      }

      applyThemeMode(settings.dark_mode);
    };
    bootstrapSettings();
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
