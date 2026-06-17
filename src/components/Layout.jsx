import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Activity, Award, Brain, Car, ClipboardList, Gauge, LayoutDashboard, History, Map, BarChart3, Settings, Menu, X, TrendingUp, Route } from 'lucide-react';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { LEGAL_DISCLAIMER_SHORT } from '@/lib/legalDisclaimers';
import { activeTripStore } from '@/lib/trackingStore';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/trips', label: 'Trips', icon: History },
  { path: '/map', label: 'Map', icon: Map },
  { path: '/coach', label: 'Coach', icon: Brain },
  { path: '/insights', label: 'Insights', icon: TrendingUp },
  { path: '/achievements', label: 'Awards', icon: Award },
  { path: '/reports', label: 'Reports', icon: BarChart3 },
  { path: '/speed-limits', label: 'Speeds', icon: Gauge },
  { path: '/diagnostics', label: 'Diagnostics', icon: Activity },
  { path: '/system-logs', label: 'Logs', icon: ClipboardList },
  { path: '/vehicles', label: 'Vehicles', icon: Car },
  { path: '/settings', label: 'Settings', icon: Settings },
];

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
  const [trackingActive, setTrackingActive] = useState(false);
  const [rescoreProgress, setRescoreProgress] = useState(null);
  const location = useLocation();

  // Listen for tracking state changes
  useEffect(() => {
    const checkTracking = () => {
      const nextActive = Boolean(activeTripStore.get());
      setTrackingActive((current) => (current === nextActive ? current : nextActive));
    };
    const checkTrackingWhenVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        checkTracking();
      }
    };
    checkTracking();
    const interval = setInterval(checkTrackingWhenVisible, 5000);
    window.addEventListener('storage', checkTracking);
    window.addEventListener('focus', checkTracking);
    document.addEventListener('visibilitychange', checkTrackingWhenVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('storage', checkTracking);
      window.removeEventListener('focus', checkTracking);
      document.removeEventListener('visibilitychange', checkTrackingWhenVisible);
    };
  }, []);

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
    <div className="min-h-screen min-w-0 bg-background flex flex-col">
      <a
        href="#main-content"
        className="sr-only fixed left-3 top-3 z-[70] rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground shadow-lg focus:not-sr-only"
      >
        Skip to main content
      </a>
      {/* Top Header */}
      <header className="min-w-0 bg-card/80 backdrop-blur-xl border-b border-border/50 px-4 h-16 flex items-center justify-between pt-[env(safe-area-inset-top)]">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark className="h-8 w-8" />
          <span className="truncate font-grotesk font-bold text-lg tracking-tight">Road Sage</span>
          {trackingActive && (
            <div className="flex items-center gap-1.5 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium px-2.5 py-1 rounded-full border border-red-200 dark:border-red-800/50">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
              Recording
            </div>
          )}
          {rescoreProgress && (
            <div className="hidden sm:flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              {rescoreProgress.status === 'complete'
                ? 'Trip history updated'
                : `Updating trips ${rescoreProgress.completed || 0}/${rescoreProgress.total || 0}`}
            </div>
          )}
        </div>

        {/* Desktop Nav */}
        <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-1">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
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
          className="min-h-11 min-w-11 rounded-lg p-2 hover:bg-secondary transition-colors md:hidden"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-navigation"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>

      {/* Mobile Menu Drawer */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div
            id="mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="fixed top-0 right-0 bottom-0 z-50 w-64 bg-card border-l border-border shadow-2xl md:hidden flex flex-col pt-16"
          >
            <nav aria-label="Mobile navigation" className="flex flex-col p-4 gap-1">
              {navItems.map(item => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
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
          </div>
        </>
      )}

      {/* Main Content */}
      <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 container max-w-6xl mx-auto px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-border/50 px-4 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
        {LEGAL_DISCLAIMER_SHORT} Obey posted signs and local laws.
      </footer>
    </div>
  );
}
