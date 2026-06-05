import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useSyncExternalStore, useTransition } from 'react';
import { Activity, Award, Brain, Car, LayoutDashboard, History, Map, BarChart3, Settings, Menu, X, TrendingUp, Route } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { RESCORE_PROGRESS_EVENT } from '@/lib/rescoreEvents';
import { activeTripStore } from '@/lib/trackingStore';
import { LEGAL_DISCLAIMER_SHORT } from '@/lib/legalDisclaimers';

const debugNavItems = import.meta.env.DEV
  ? [{ path: '/diagnostics', label: 'Diagnostics', icon: Activity }]
  : [];

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/trips', label: 'Trips', icon: History },
  { path: '/map', label: 'Map', icon: Map },
  { path: '/coach', label: 'Coach', icon: Brain },
  { path: '/insights', label: 'Insights', icon: TrendingUp },
  { path: '/achievements', label: 'Awards', icon: Award },
  { path: '/reports', label: 'Reports', icon: BarChart3 },
  ...debugNavItems,
  { path: '/vehicles', label: 'Vehicles', icon: Car },
  { path: '/settings', label: 'Settings', icon: Settings },
];

const routePreloaders = {
  '/': () => import('@/pages/Dashboard'),
  '/trips': () => import('@/pages/TripHistory'),
  '/map': () => import('@/pages/MapScreen'),
  '/coach': () => import('@/pages/DrivingCoach'),
  '/insights': () => import('@/pages/Insights'),
  '/achievements': () => import('@/pages/Achievements'),
  '/reports': () => import('@/pages/Report'),
  '/vehicles': () => import('@/pages/Vehicles'),
  '/settings': () => import('@/pages/Settings'),
  ...(import.meta.env.DEV ? { '/diagnostics': () => import('@/pages/Diagnostics') } : {}),
};

const preloadRoute = (path) => {
  routePreloaders[path]?.();
};

const shouldUseNativeNavigation = (event) => (
  event.defaultPrevented ||
  event.button !== 0 ||
  event.metaKey ||
  event.altKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.currentTarget.target
);

function BrandMark({ className = '' }) {
  return (
    <div className={`relative grid place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-teal-500 via-cyan-500 to-slate-900 shadow-lg ${className}`}>
      <Route className="h-4 w-4 text-white" />
      <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-lime-300" />
    </div>
  );
}

export default function Layout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [rescoreProgress, setRescoreProgress] = useState(null);
  const [isPending, startTransition] = useTransition();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTripSnapshot = useSyncExternalStore(
    activeTripStore.subscribe,
    activeTripStore.getSnapshot,
    activeTripStore.getSnapshot
  );
  const [hadInitialActiveTrip] = useState(() => {
    try {
      return Boolean(activeTripStore.get?.());
    } catch {
      return false;
    }
  });
  const trackingActive = Boolean(activeTripSnapshot.trip) ||
    (activeTripSnapshot.version === 0 && hadInitialActiveTrip);

  const handleNavClick = (event, path) => {
    if (shouldUseNativeNavigation(event)) return;
    event.preventDefault();
    setMobileMenuOpen(false);
    startTransition(() => {
      navigate(path);
    });
  };

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  useEffect(() => {
    let clearTimer = null;
    const onProgress = (event) => {
      const detail = event.detail || {};
      setRescoreProgress(detail);
      if (detail.status === 'complete') {
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => setRescoreProgress(null), 2500);
      }
    };
    window.addEventListener(RESCORE_PROGRESS_EVENT, onProgress);
    return () => {
      clearTimeout(clearTimer);
      window.removeEventListener(RESCORE_PROGRESS_EVENT, onProgress);
    };
  }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {isPending && (
        <div
          className="fixed left-0 top-0 z-[60] h-0.5 bg-primary shadow-[0_0_10px_rgba(20,184,166,0.55)] motion-safe:animate-pulse"
          style={{ width: '70%', transition: 'width 0.3s ease' }}
        />
      )}
      {/* Top Header */}
      <header className="bg-card/80 backdrop-blur-xl border-b border-border/50 px-4 h-16 flex items-center justify-between pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-3">
          <BrandMark className="h-8 w-8" />
          <span className="font-grotesk font-bold text-lg tracking-tight">Road Sage</span>
          {trackingActive && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium px-2.5 py-1 rounded-full border border-red-200 dark:border-red-800/50"
            >
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
              Recording
            </motion.div>
          )}
          {rescoreProgress && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="hidden sm:flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              {rescoreProgress.status === 'complete'
                ? 'Trip history updated'
                : `Updating trips ${rescoreProgress.completed || 0}/${rescoreProgress.total || 0}`}
            </motion.div>
          )}
        </div>

        {/* Desktop Nav */}
        <nav className="hidden md:flex items-center gap-1">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={(event) => handleNavClick(event, item.path)}
                onFocus={() => preloadRoute(item.path)}
                onMouseEnter={() => preloadRoute(item.path)}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`
                }
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        {/* Mobile menu toggle */}
        <button
          className="md:hidden p-2 rounded-lg hover:bg-secondary transition-colors"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>

      {/* Mobile Menu Drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/40 md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 bottom-0 z-50 w-64 bg-card border-l border-border shadow-2xl md:hidden flex flex-col pt-16"
            >
              <nav className="flex flex-col p-4 gap-1">
                {navItems.map(item => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/'}
                      onClick={(event) => handleNavClick(event, item.path)}
                      onFocus={() => preloadRoute(item.path)}
                      onTouchStart={() => preloadRoute(item.path)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                        }`
                      }
                    >
                      <Icon className="w-5 h-5" />
                      {item.label}
                    </NavLink>
                  );
                })}
              </nav>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 container max-w-6xl mx-auto px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-border/50 bg-card/50 px-4 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
        {LEGAL_DISCLAIMER_SHORT} Obey posted signs and local laws.
      </footer>
    </div>
  );
}
