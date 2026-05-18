import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useNavigate } from 'react-router-dom';
import { LocalNotifications } from '@capacitor/local-notifications';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { useEffect, useState } from 'react';
import { applyThemeMode, localSettings } from '@/lib/trackingStore';
import { configureNotificationChannels, syncReminderNotifications } from '@/lib/notificationService';
import { startNativeAutoTracking } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { openExportLocation } from '@/lib/nativeDownloads';
import { Route as RouteIcon } from 'lucide-react';

// Page imports
import Layout from '@/components/Layout';
import Onboarding from '@/pages/Onboarding';
import Dashboard from '@/pages/Dashboard';
import TripHistory from '@/pages/TripHistory';
import TripDetail from '@/pages/TripDetail';
import MapScreen from '@/pages/MapScreen';
import Reports from '@/pages/Report';
import Settings from '@/pages/Settings';
import AndroidReference from '@/pages/AndroidReference';
import Vehicles from '@/pages/Vehicles';
import Achievements from '@/pages/Achievements';
import DrivingCoach from '@/pages/DrivingCoach';
import Diagnostics from '@/pages/Diagnostics';
import Insights from '@/pages/Insights';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const [onboardingDone, setOnboardingDone] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    configureNotificationChannels().catch(() => {});
    const settings = localSettings.get();
    syncReminderNotifications(settings, { requestPermission: false }).catch(() => {});
    setOnboardingDone(settings.onboarding_completed);
    if (isAndroid() && settings.tracking_mode === 'background_auto' && !settings.tracking_paused) {
      startNativeAutoTracking().catch(() => {});
    }

    applyThemeMode(settings.dark_mode);
  }, []);

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

  if (authError) {
    if (authError.type === 'user_not_registered') return <UserNotRegisteredError />;
    if (authError.type === 'auth_required') { navigateToLogin(); return null; }
    // For other errors (network, unknown), still render the app in public mode
  }

  return (
    <Routes>
      {/* Onboarding (no layout) — only shown to new users */}
      {!onboardingDone && <Route path="*" element={<Onboarding onComplete={() => setOnboardingDone(true)} />} />}

      {/* Main App with shared Layout */}
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/trips" element={<TripHistory />} />
        <Route path="/trips/:id" element={<TripDetail />} />
        <Route path="/map" element={<MapScreen />} />
        <Route path="/coach" element={<DrivingCoach />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/achievements" element={<Achievements />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/android" element={<AndroidReference />} />
        <Route path="/vehicles" element={<Vehicles />} />
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
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
