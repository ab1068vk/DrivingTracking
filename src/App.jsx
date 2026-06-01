import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useNavigate } from 'react-router-dom';
import { LocalNotifications } from '@capacitor/local-notifications';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { lazy, Suspense, useEffect, useState } from 'react';
import { applyThemeMode, localSettings } from '@/lib/trackingStore';
import { configureNotificationChannels, syncReminderNotifications } from '@/lib/notificationService';
import { startNativeAutoTracking } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { openExportLocation } from '@/lib/nativeDownloads';
import { logError } from '@/lib/errorReporting';
import { reverifyConfiguredOsrmEndpoint } from '@/lib/osrmEndpointVerifier';
import { toast } from '@/components/ui/use-toast';
import { Route as RouteIcon } from 'lucide-react';

import Layout from '@/components/Layout';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import { PageSkeleton } from '@/components/PageSkeleton';

const showDebugRoutes = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEBUG_ROUTES === 'true';
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
const Diagnostics = lazy(() => import('@/pages/Diagnostics'));
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
  const navigate = useNavigate();

  useEffect(() => {
    const bootstrapSettings = async () => {
      configureNotificationChannels().catch((err) => {
        logError('notification_channel_configure', err);
      });
      const settings = await localSettings.hydrateFromNative();
      reverifyConfiguredOsrmEndpoint(settings).then(({ result }) => {
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
      syncReminderNotifications(settings, { requestPermission: false }).catch((err) => {
        logError('reminder_notification_sync', err, { tracking_mode: settings.tracking_mode });
      });
      setOnboardingDone(settings.onboarding_completed);
      if (isAndroid() && settings.tracking_mode === 'background_auto' && !settings.tracking_paused) {
        startNativeAutoTracking().catch((err) => {
          logError('native_auto_tracking_start_bootstrap', err, { mode: settings.tracking_mode });
        });
      }

      applyThemeMode(settings.dark_mode);
    };
    bootstrapSettings();
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
          logError('export_location_open', err, { uri: extra.uri, mimeType: extra.mimeType });
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
      <Route element={<Layout />}>
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
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/settings" element={<Settings />} />
        {showDebugRoutes && AndroidReference && <Route path="/android" element={<AndroidReference />} />}
        <Route path="/vehicles" element={<Vehicles />} />
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
    </Suspense>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
