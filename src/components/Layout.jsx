// @ts-check
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Activity, Brain, Car, ClipboardList, Gauge, LayoutDashboard, History, Map, BarChart3, Settings, Menu, X, TrendingUp, Route, Cuboid, MoreHorizontal, Trophy, ShieldCheck } from 'lucide-react';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { LEGAL_DISCLAIMER_SHORT } from '@/lib/legalDisclaimers';
import { activeTripStore } from '@/lib/trackingStore';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const AppDropdownMenu = /** @type {any} */ (DropdownMenu);
const AppDropdownMenuContent = /** @type {any} */ (DropdownMenuContent);
const AppDropdownMenuItem = /** @type {any} */ (DropdownMenuItem);
const AppDropdownMenuLabel = /** @type {any} */ (DropdownMenuLabel);
const AppDropdownMenuSeparator = /** @type {any} */ (DropdownMenuSeparator);
const AppDropdownMenuTrigger = /** @type {any} */ (DropdownMenuTrigger);

const settingsNavItem = { path: '/settings', label: 'Settings', icon: Settings };

const primaryNavItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/trips', label: 'Trips', icon: History },
  { path: '/map', label: 'Map', icon: Map },
  { path: '/coach', label: 'Coach', icon: Brain },
  { path: '/insights', label: 'Insights', icon: TrendingUp },
  { path: '/reports', label: 'Reports', icon: BarChart3 },
  { path: '/speed-limits', label: 'Speeds', icon: Gauge },
  settingsNavItem,
];

const moreNavItems = [
  { path: '/3d-replay', label: '3D Replay', icon: Cuboid },
  { path: '/achievements', label: 'Milestones', icon: Trophy },
  { path: '/privacy-intelligence', label: 'Privacy', icon: ShieldCheck },
  { path: '/diagnostics', label: 'Diagnostics', icon: Activity },
  { path: '/system-logs', label: 'Logs', icon: ClipboardList },
  { path: '/vehicles', label: 'Vehicles', icon: Car },
];

const navItems = [...primaryNavItems, ...moreNavItems];

const navSections = [
  { label: 'Drive', items: primaryNavItems.filter((item) => item.path !== '/settings') },
  { label: 'Explore', items: moreNavItems.slice(0, 3) },
  { label: 'Manage', items: [...moreNavItems.slice(3), settingsNavItem] },
];

function BrandMark({ className = '' }) {
  return (
    <div className={`relative grid place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-teal-500 via-cyan-500 to-slate-900 shadow-lg ${className}`}>
      <Route className="h-4 w-4 text-white" />
      <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-lime-300" />
    </div>
  );
}

function NavItemLink({ item, variant = 'desktop' }) {
  const Icon = item.icon;
  const isMobile = variant === 'mobile';

  return (
    <NavLink
      key={item.path}
      to={item.path}
      end={item.path === '/'}
      title={!isMobile ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center font-medium transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          isMobile
            ? 'min-h-12 gap-3 rounded-xl px-3 py-2.5 text-sm'
            : 'h-10 gap-2 rounded-full px-3 text-sm',
          isActive
            ? isMobile
              ? 'bg-primary/10 text-foreground shadow-sm ring-1 ring-primary/15'
              : 'bg-card text-foreground shadow-sm ring-1 ring-border/70'
            : isMobile
              ? 'text-muted-foreground hover:bg-secondary/80 hover:text-foreground'
              : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'grid shrink-0 place-items-center rounded-full transition-colors',
              isMobile ? 'h-8 w-8' : 'h-7 w-7',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground group-hover:text-foreground',
            )}
          >
            <Icon className={isMobile ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
          </span>
          <span className="truncate">{item.label}</span>
          {!isMobile && isActive && (
            <span className="absolute inset-x-4 -bottom-1 h-0.5 rounded-full bg-primary" />
          )}
        </>
      )}
    </NavLink>
  );
}

function navItemMatches(pathname, item) {
  return item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
}

function DesktopMoreMenu({ pathname }) {
  const active = moreNavItems.some((item) => navItemMatches(pathname, item));

  return (
    <AppDropdownMenu>
      <AppDropdownMenuTrigger
        className={cn(
          'group relative flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          active
            ? 'bg-card text-foreground shadow-sm ring-1 ring-border/70'
            : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
        )}
        aria-label="Open more navigation"
      >
        <span className={cn(
          'grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors',
          active
            ? 'bg-primary text-primary-foreground'
            : 'bg-secondary text-muted-foreground group-hover:text-foreground',
        )}>
          <MoreHorizontal className="h-4 w-4" />
        </span>
        <span>More</span>
        {active && <span className="absolute inset-x-4 -bottom-1 h-0.5 rounded-full bg-primary" />}
      </AppDropdownMenuTrigger>
      <AppDropdownMenuContent align="end" className="w-56">
        <AppDropdownMenuLabel>Explore</AppDropdownMenuLabel>
        {moreNavItems.slice(0, 3).map((item) => {
          const Icon = item.icon;
          const itemActive = navItemMatches(pathname, item);
          return (
            <AppDropdownMenuItem key={item.path} asChild>
              <NavLink
                to={item.path}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                  itemActive && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </NavLink>
            </AppDropdownMenuItem>
          );
        })}
        <AppDropdownMenuSeparator />
        <AppDropdownMenuLabel>Manage</AppDropdownMenuLabel>
        {moreNavItems.slice(3).map((item) => {
          const Icon = item.icon;
          const itemActive = navItemMatches(pathname, item);
          return (
            <AppDropdownMenuItem key={item.path} asChild>
              <NavLink
                to={item.path}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                  itemActive && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </NavLink>
            </AppDropdownMenuItem>
          );
        })}
      </AppDropdownMenuContent>
    </AppDropdownMenu>
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
    <div className="cyber-app-shell min-h-dvh min-w-0 bg-background flex flex-col">
      <a
        href="#main-content"
        className="sr-only fixed left-3 top-3 z-[70] rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground shadow-lg focus:not-sr-only"
      >
        Skip to main content
      </a>
      {/* Top Header */}
      <header className="cyber-top-frame sticky top-0 z-50 min-w-0 border-b border-border/60 bg-background/88 px-4 pt-[env(safe-area-inset-top)] shadow-sm shadow-slate-900/5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
        <div className="cyber-header-inner mx-auto flex h-16 max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="cyber-brand-mark h-9 w-9 shrink-0" />
            <div className="cyber-brand-copy min-w-0">
              <span className="block truncate font-grotesk text-lg font-bold tracking-normal">Road Sage</span>
              <span className="hidden text-[11px] font-medium uppercase tracking-normal text-muted-foreground sm:block">Drive intelligence</span>
            </div>
            <div className="cyber-only cyber-status-strip" aria-hidden="true">
              <span className="cyber-status-cell"><Activity className="h-4 w-4" /></span>
              <span className="cyber-status-cell"><Gauge className="h-4 w-4" /></span>
            </div>
            {trackingActive && (
              <div className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 dark:border-red-800/50 dark:bg-red-950/40 dark:text-red-400">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                Recording
              </div>
            )}
            {rescoreProgress && (
              <div className="hidden items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300 sm:flex">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                {rescoreProgress.status === 'complete'
                  ? 'Trip history updated'
                  : `Updating trips ${rescoreProgress.completed || 0}/${rescoreProgress.total || 0}`}
              </div>
            )}
          </div>

          {/* Desktop Nav */}
          <nav
            aria-label="Primary navigation"
            className="cyber-nav-rack hidden min-w-0 items-center gap-1 rounded-full border border-border/70 bg-secondary/70 p-1 shadow-inner shadow-white/30 xl:flex dark:shadow-black/10"
          >
            {primaryNavItems.map(item => <NavItemLink key={item.path} item={item} />)}
            <DesktopMoreMenu pathname={location.pathname} />
          </nav>

          {/* Mobile menu toggle */}
          <button
            className="cyber-menu-button grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full border border-border/70 bg-card text-foreground shadow-sm transition-colors hover:bg-secondary xl:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Mobile Menu Drawer */}
      {mobileMenuOpen && (
        <>
          <div
            className="cyber-mobile-backdrop fixed inset-0 z-[1000] bg-black/40 xl:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div
            id="mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="cyber-mobile-drawer fixed bottom-0 right-0 top-0 z-[1010] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-l-3xl border-l border-border bg-card shadow-2xl xl:hidden"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
              <div className="flex min-w-0 items-center gap-3">
                <BrandMark className="cyber-brand-mark h-10 w-10 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate font-grotesk text-lg font-bold">Road Sage</div>
                  <div className="text-xs font-medium text-muted-foreground">Navigation</div>
                </div>
              </div>
              <button
                type="button"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav aria-label="Mobile navigation" className="flex-1 overflow-y-auto px-4 py-5">
              {navSections.map(section => (
                <div key={section.label} className="mb-5 last:mb-0">
                  <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
                    {section.label}
                  </div>
                  <div className="grid gap-1">
                    {section.items.map(item => <NavItemLink key={item.path} item={item} variant="mobile" />)}
                  </div>
                </div>
              ))}
            </nav>
            {trackingActive && (
              <div className="border-t border-border/70 p-4">
                <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600 dark:border-red-800/50 dark:bg-red-950/40 dark:text-red-400">
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                  Trip recording is active
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Main Content */}
      <main id="main-content" tabIndex={-1} className="cyber-main-content flex-1 min-w-0 container max-w-6xl mx-auto px-4 py-6">
        <Outlet />
      </main>
      <footer className="cyber-footer border-t border-border/50 px-4 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
        {LEGAL_DISCLAIMER_SHORT} Obey posted signs and local laws.
      </footer>
    </div>
  );
}
