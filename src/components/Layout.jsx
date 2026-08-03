// @ts-check
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Activity,
  Award,
  Bell,
  Brain,
  Car,
  ClipboardList,
  Database,
  Gauge,
  LayoutDashboard,
  History,
  Map,
  MapPin,
  BarChart3,
  Settings,
  Menu,
  X,
  TrendingUp,
  Route,
  Cuboid,
  Play,
  Radio,
  Search,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { LEGAL_DISCLAIMER_SHORT } from '@/lib/legalDisclaimers';
import { ACTIVE_TRIP_CHANGED_EVENT, activeTripStore, isTrackingExperienceMode } from '@/lib/trackingStore';
import { isAndroid } from '@/lib/nativePlatform';
import { useLocalSettingSelector } from '@/hooks/useLocalSettings';
import { cn } from '@/lib/utils';

const AppCommandDialog = /** @type {any} */ (CommandDialog);
const AppCommandEmpty = /** @type {any} */ (CommandEmpty);
const AppCommandGroup = /** @type {any} */ (CommandGroup);
const AppCommandInput = /** @type {any} */ (CommandInput);
const AppCommandItem = /** @type {any} */ (CommandItem);
const AppCommandList = /** @type {any} */ (CommandList);
const AppCommandSeparator = /** @type {any} */ (CommandSeparator);
const AppCommandShortcut = /** @type {any} */ (CommandShortcut);
const AppDropdownMenuContent = /** @type {any} */ (DropdownMenuContent);
const AppDropdownMenuItem = /** @type {any} */ (DropdownMenuItem);
const AppDropdownMenuLabel = /** @type {any} */ (DropdownMenuLabel);

const navSections = [
  {
    label: 'Today',
    description: 'Start here and see what needs attention now.',
    defaultPath: '/',
    icon: LayoutDashboard,
    items: [
      { path: '/', label: 'Dashboard', icon: LayoutDashboard },
      { path: '/parking', label: 'Parking', icon: MapPin },
      { path: '/map', label: 'Map', icon: Map },
    ],
  },
  {
    label: 'Drive',
    description: 'Record, coach, vehicles, and saved speed rules.',
    defaultPath: '/trips',
    icon: Route,
    items: [
      { path: '/trips', label: 'Trips', icon: History },
      { path: '/coach', label: 'Coach', icon: Brain },
      { path: '/speed-limits', label: 'Speed rules', icon: Gauge },
      { path: '/vehicles', label: 'Vehicles', icon: Car },
    ],
  },
  {
    label: 'Review',
    description: 'Analyze progress, reports, milestones, and replays.',
    defaultPath: '/insights',
    icon: TrendingUp,
    items: [
      { path: '/insights', label: 'Insights', icon: TrendingUp },
      { path: '/reports', label: 'Reports', icon: BarChart3 },
      { path: '/achievements', label: 'Milestones', icon: Award },
      { path: '/3d-replay', label: '3D Replay', icon: Cuboid },
    ],
  },
  {
    label: 'Settings',
    description: 'Privacy, diagnostics, logs, and app setup.',
    defaultPath: '/settings',
    icon: Settings,
    items: [
      { path: '/settings', label: 'Settings', icon: Settings },
      { path: '/privacy-intelligence', label: 'Privacy', icon: ShieldCheck },
      { path: '/diagnostics', label: 'Diagnostics', icon: Activity },
      { path: '/system-logs', label: 'Logs', icon: ClipboardList },
    ],
  },
];

function isPathActive(pathname, path) {
  if (path === '/') return pathname === '/';
  if (path === '/tracking') return pathname === '/tracking';
  return pathname === path || pathname.startsWith(`${path}/`);
}

const commandGroups = [
  {
    label: 'Go to',
    items: [
      { path: '/', label: 'Dashboard', hint: 'Today', icon: LayoutDashboard, keywords: ['home', 'today', 'start'] },
      { path: '/parking', label: 'Parking', hint: 'Where I parked', icon: MapPin, keywords: ['parked car', 'where i parked', 'parking history', 'save parking'] },
      { path: '/trips', label: 'Trips', hint: 'History', icon: History, keywords: ['drive history', 'trip log', 'recent drives'] },
      { path: '/reports', label: 'Reports', hint: 'Review', icon: BarChart3, keywords: ['exports', 'summary', 'review'] },
      { path: '/settings', label: 'Settings', hint: 'Setup', icon: Settings, keywords: ['preferences', 'options', 'configure'] },
      { path: '/vehicles', label: 'Vehicles', hint: 'Fleet', icon: Car, keywords: ['car', 'maintenance', 'fleet'] },
      { path: '/speed-limits', label: 'Speed rules', hint: 'Road data', icon: Gauge, keywords: ['speeds', 'saved roads', 'limits'] },
    ],
  },
  {
    label: 'Explore',
    items: [
      { path: '/coach', label: 'Coach', hint: 'Drive', icon: Brain, keywords: ['coaching', 'habits', 'feedback'] },
      { path: '/insights', label: 'Insights', hint: 'Review', icon: TrendingUp, keywords: ['trends', 'analytics', 'patterns'] },
      { path: '/privacy-intelligence', label: 'Privacy', hint: 'Settings', icon: ShieldCheck, keywords: ['zones', 'private', 'data'] },
      { path: '/diagnostics', label: 'Diagnostics', hint: 'Tools', icon: Wrench, keywords: ['debug', 'health', 'status'] },
    ],
  },
];

const trackingNavItems = [
  { path: '/tracking', label: 'Live tracking', hint: 'Now', icon: Activity, keywords: ['overview', 'live', 'recording', 'telemetry'] },
  { path: '/tracking/recorder', label: 'Record a drive', hint: 'Start or stop', icon: Radio, keywords: ['manual', 'record', 'start trip', 'end trip', 'live'] },
  { path: '/trips', label: 'My trips', hint: 'History', icon: History, keywords: ['history', 'drive log', 'recorded trips'] },
  { path: '/tracking/map', label: 'Route map', hint: 'Explore', icon: Map, keywords: ['route', 'gps', 'workspace'] },
  { path: '/tracking/replay', label: 'Compare drives', hint: 'Replay', icon: Play, keywords: ['compare', 'replay', '3d', 'playback'] },
  { path: '/tracking/events', label: 'Drive events', hint: 'Timeline', icon: ClipboardList, keywords: ['events', 'timeline', 'telemetry'] },
  { path: '/tracking/alerts', label: 'Driving alerts', hint: 'Voice', icon: Bell, keywords: ['voice', 'speech', 'cooldowns', 'alerts'] },
  { path: '/tracking/evidence', label: 'Data quality', hint: 'Sources', icon: Database, keywords: ['data quality', 'evidence', 'provenance', 'sources'] },
  { path: '/tracking/speed', label: 'Road speeds', hint: 'Limits', icon: Gauge, keywords: ['speed rules', 'limits', 'markers', 'confidence'] },
  { path: '/tracking/privacy', label: 'Trip privacy', hint: 'Zones', icon: ShieldCheck, keywords: ['privacy zones', 'masking', 'audit'] },
  { path: '/tracking/reports', label: 'Share & export', hint: 'Reports', icon: BarChart3, keywords: ['reports', 'csv', 'pdf', 'export'] },
  { path: '/settings', label: 'Settings', hint: 'Preferences', icon: Settings, keywords: ['settings', 'preferences', 'mode'] },
];

const trackingNavSections = [
  {
    label: 'Track now',
    description: 'See recording status or start a drive.',
    items: trackingNavItems.slice(0, 2),
  },
  {
    label: 'Trips & routes',
    description: 'Revisit recorded drives, routes, and replays.',
    items: trackingNavItems.slice(2, 5),
  },
  {
    label: 'Driving details',
    description: 'Review events, alerts, data quality, and road speeds.',
    items: trackingNavItems.slice(5, 9),
  },
  {
    label: 'Manage',
    description: 'Control trip privacy, sharing, and preferences.',
    items: trackingNavItems.slice(9),
  },
];
const trackingCommandGroups = trackingNavSections.map(({ label, items }) => ({ label, items }));

function BrandMark({ className = '' }) {
  return (
    <div className={`relative grid place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-teal-500 via-cyan-500 to-slate-900 shadow-lg ${className}`}>
      <Route className="h-4 w-4 text-white" />
      <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-lime-300" />
    </div>
  );
}

function NavItemLink({ item, variant = 'desktop', onNavigate = undefined }) {
  const Icon = item.icon;
  const isMobile = variant === 'mobile';

  return (
    <NavLink
      key={item.path}
      to={item.path}
      end={item.path === '/' || item.path === '/tracking'}
      title={!isMobile ? item.label : undefined}
      onClick={onNavigate ? () => {
        // Remove the modal before a lazy destination starts rendering.
        flushSync(onNavigate);
      } : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center font-medium transition-colors duration-150',
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
          <span className={cn('truncate', !isMobile && 'hidden min-[1380px]:inline')}>{item.label}</span>
          {!isMobile && isActive && (
            <span className="absolute inset-x-4 -bottom-1 h-0.5 rounded-full bg-primary" />
          )}
        </>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [trackingActive, setTrackingActive] = useState(false);
  const [rescoreProgress, setRescoreProgress] = useState(null);
  const trackingExperienceMode = useLocalSettingSelector(isTrackingExperienceMode);
  const location = useLocation();

  // Listen for both WebView and Android-native recording state changes.
  useEffect(() => {
    let cancelled = false;
    let checkInFlight = null;
    const checkTracking = () => {
      if (checkInFlight) return checkInFlight;
      checkInFlight = (async () => {
        let nextActive = Boolean(activeTripStore.get());
        if (!nextActive && isAndroid()) {
          const { getNativeAutoTrackingStatus } = await import('@/lib/activityRecognition');
          const nativeStatus = await getNativeAutoTrackingStatus().catch(() => null);
          nextActive = nativeStatus?.recordingActive === true;
        }
        if (!cancelled) {
          setTrackingActive((current) => (current === nextActive ? current : nextActive));
        }
      })().finally(() => {
        checkInFlight = null;
      });
      return checkInFlight;
    };
    const checkTrackingWhenVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void checkTracking();
      }
    };
    void checkTracking();
    const interval = setInterval(checkTrackingWhenVisible, 5000);
    window.addEventListener(ACTIVE_TRIP_CHANGED_EVENT, checkTracking);
    window.addEventListener('storage', checkTracking);
    window.addEventListener('focus', checkTracking);
    document.addEventListener('visibilitychange', checkTrackingWhenVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener(ACTIVE_TRIP_CHANGED_EVENT, checkTracking);
      window.removeEventListener('storage', checkTracking);
      window.removeEventListener('focus', checkTracking);
      document.removeEventListener('visibilitychange', checkTrackingWhenVisible);
    };
  }, []);


  useEffect(() => {
    if (trackingExperienceMode) return undefined;
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [trackingExperienceMode]);

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

  if (trackingExperienceMode) {
    return (
      <TrackingShell
        location={location}
        trackingActive={trackingActive}
        rescoreProgress={rescoreProgress}
      />
    );
  }

  return (
    <div className="min-h-dvh min-w-0 bg-background flex flex-col">
      <a
        href="#main-content"
        className="sr-only fixed left-3 top-3 z-[70] rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground shadow-lg focus:not-sr-only"
      >
        Skip to main content
      </a>
      {/* Top Header */}
      <header className="sticky top-0 z-50 min-w-0 border-b border-border/60 bg-background/88 px-4 pt-[env(safe-area-inset-top)] shadow-sm shadow-slate-900/5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-9 w-9 shrink-0" />
            <div className="min-w-0">
              <span className="block truncate font-grotesk text-lg font-bold tracking-normal">Road Sage</span>
              <span className="hidden text-[11px] font-medium uppercase tracking-normal text-muted-foreground sm:block">Drive intelligence</span>
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
            className="hidden min-w-0 items-center gap-1 rounded-full border border-border/70 bg-secondary/70 p-1 shadow-inner shadow-white/30 xl:flex dark:shadow-black/10"
          >
            {navSections.map(section => (
              <DesktopNavGroup key={section.label} section={section} pathname={location.pathname} />
            ))}
          </nav>

          <button
            type="button"
            className="hidden h-11 shrink-0 items-center gap-2 rounded-full border border-border/70 bg-card px-3 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:flex"
            onClick={() => setCommandOpen(true)}
            aria-label="Search app"
          >
            <Search className="h-4 w-4" />
            <span className="hidden min-[1120px]:inline">Search app</span>
            <kbd className="hidden rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground min-[1180px]:inline">
              Ctrl K
            </kbd>
          </button>

          {/* Mobile menu toggle */}
          <div className="flex shrink-0 items-center gap-2 xl:hidden">
            <button
              type="button"
              className="grid min-h-11 min-w-11 place-items-center rounded-full border border-border/70 bg-card text-foreground shadow-sm transition-colors hover:bg-secondary sm:hidden"
              onClick={() => setCommandOpen(true)}
              aria-label="Search app"
            >
              <Search className="h-5 w-5" />
            </button>
            <MobileNavigation trackingActive={trackingActive} />
          </div>
        </div>
      </header>
      <AppCommandPalette open={commandOpen} onOpenChange={setCommandOpen} />

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

/**
 * @param {{
 *   trackingActive: boolean,
 *   sections?: Array<{ label: string, items: any[] }>,
 *   title?: string,
 *   dialogLabel?: string,
 *   responsiveClassName?: string,
 * }} props
 */
function MobileNavigation({
  trackingActive,
  sections = navSections,
  title = 'Navigation',
  dialogLabel = 'Navigation menu',
  responsiveClassName = 'xl:hidden',
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    document.documentElement.dataset.mobileNavigationOpen = 'true';

    return () => {
      delete document.documentElement.dataset.mobileNavigationOpen;
    };
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn("grid min-h-11 min-w-11 place-items-center rounded-full border border-border/70 bg-card text-foreground shadow-sm transition-colors hover:bg-secondary", responsiveClassName)}
          aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={open}
          aria-controls="mobile-navigation"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn("mobile-navigation-backdrop fixed inset-0 z-[1000] bg-black/40", responsiveClassName)}
        />
        <DialogPrimitive.Content
          id="mobile-navigation"
          aria-label={dialogLabel}
          className={cn("mobile-navigation-drawer fixed bottom-0 right-0 top-0 z-[1010] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-l-3xl border-l border-border bg-card shadow-2xl focus:outline-none", responsiveClassName)}
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
            <div className="flex min-w-0 items-center gap-3">
              <BrandMark className="h-10 w-10 shrink-0" />
              <div className="min-w-0">
                <div className="truncate font-grotesk text-lg font-bold">Road Sage</div>
                <div className="text-xs font-medium text-muted-foreground">{title}</div>
              </div>
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Close navigation menu"
              >
                <X className="h-5 w-5" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <nav aria-label="Mobile navigation" className="mobile-navigation-scroll flex-1 overflow-y-auto px-4 py-5">
            {sections.map(section => (
              <div key={section.label} className="mb-5 last:mb-0">
                <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
                  {section.label}
                </div>
                <div className="grid gap-1">
                  {section.items.map(item => (
                    <NavItemLink
                      key={item.path}
                      item={item}
                      variant="mobile"
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
function DesktopNavGroup({ section, pathname }) {
  const Icon = section.icon;
  const activeItem = section.items.find((item) => isPathActive(pathname, item.path));
  const isActive = Boolean(activeItem);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'group flex h-11 min-w-[8.75rem] items-center gap-2 rounded-full px-3 text-left text-sm font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            isActive
              ? 'bg-card text-foreground shadow-sm ring-1 ring-border/70'
              : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
          )}
          aria-label={`${section.label} navigation`}
        >
          <span
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground group-hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate">{section.label}</span>
            <span className="block max-w-[7rem] truncate text-[11px] font-medium text-muted-foreground">
              {activeItem?.label || section.description}
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <AppDropdownMenuContent align="center" className="w-64 rounded-xl p-2">
        <AppDropdownMenuLabel className="px-2">
          <span className="block text-sm">{section.label}</span>
          <span className="block text-xs font-normal text-muted-foreground">{section.description}</span>
        </AppDropdownMenuLabel>
        <DropdownMenuSeparator />
        {section.items.map((item) => {
          const ItemIcon = item.icon;
          return (
            <AppDropdownMenuItem key={item.path} asChild className="rounded-lg p-0">
              <NavLink
                to={item.path}
                end={item.path === '/' || item.path === '/tracking'}
                className={({ isActive: itemActive }) =>
                  cn(
                    'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm',
                    itemActive ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
                  )
                }
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary">
                  <ItemIcon className="h-4 w-4" />
                </span>
                <span className="font-medium">{item.label}</span>
              </NavLink>
            </AppDropdownMenuItem>
          );
        })}
      </AppDropdownMenuContent>
    </DropdownMenu>
  );
}

function TrackingShell({ location, trackingActive, rescoreProgress }) {
  return (
    <div className="tracking-console-shell flex min-h-dvh min-w-0 flex-col bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only fixed left-3 top-3 z-[70] rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground shadow-lg focus:not-sr-only"
      >
        Skip to main content
      </a>
      <header className="tracking-console-toolbar sticky top-0 z-50 min-w-0 border-b border-border/60 bg-background/88 px-4 pt-[env(safe-area-inset-top)] shadow-sm shadow-slate-900/5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
        <div className="mx-auto flex h-16 max-w-7xl min-w-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-9 w-9 shrink-0" />
            <div className="min-w-0">
              <span className="block truncate font-grotesk text-lg font-bold tracking-normal">Road Sage</span>
              <span className="hidden text-[11px] font-semibold text-muted-foreground sm:block">Advanced trip tracking</span>
            </div>
            {trackingActive && (
              <div className="tracking-console-chip border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                Recording
              </div>
            )}
            {rescoreProgress && (
              <div className="tracking-console-chip hidden border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300 sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                {rescoreProgress.status === 'complete'
                  ? 'Trip history updated'
                  : `${rescoreProgress.completed || 0}/${rescoreProgress.total || 0} rescored`}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden items-center rounded-full border border-border bg-secondary/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground md:flex">
              Local-first data
            </div>
            <TrackingCommandLauncher location={location} />
            <MobileNavigation
              trackingActive={trackingActive}
              sections={trackingNavSections}
              title="Trip tracking"
              dialogLabel="Tracking navigation menu"
              responsiveClassName="md:hidden"
            />
          </div>
        </div>
      </header>

      <div className="tracking-console-frame flex min-h-0 flex-1">
        <aside className="tracking-console-rail hidden w-56 shrink-0 border-r border-border/70 bg-card/75 md:flex">
          <nav aria-label="Trip tracking navigation" className="flex min-h-0 w-full flex-col overflow-y-auto px-3 py-4">
            {trackingNavSections.map((section) => (
              <div key={section.label} className="mb-4 grid gap-1 last:mb-0">
                <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  <span>{section.label}</span>
                </div>
                {section.items.map((item) => (
                  <TrackingNavLink
                    key={item.path}
                    item={item}
                    pathname={location.pathname}
                  />
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <main id="main-content" tabIndex={-1} className="tracking-console-main max-w-none flex-1 min-w-0 overflow-x-clip px-3 py-3 sm:px-4 md:pb-4 lg:px-5">
          <Outlet />
        </main>
      </div>


      <footer className="tracking-console-footer border-t border-border/60 px-4 py-2 text-center text-[11px] leading-relaxed text-muted-foreground">
        {LEGAL_DISCLAIMER_SHORT} Obey posted signs and local laws.
      </footer>
    </div>
  );
}

function TrackingCommandLauncher({ location }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onClick={() => setOpen(true)}
        aria-label="Search app"
      >
        <Search className="h-4 w-4" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground lg:inline">
          Ctrl K
        </kbd>
      </button>
      <AppCommandPalette
        open={open}
        onOpenChange={setOpen}
        groups={trackingCommandGroups}
        placeholder="Search tracking, trips, map, events, speed, privacy..."
        currentPath={location.pathname}
      />
    </>
  );
}

function TrackingNavLink({ item, pathname }) {
  const Icon = item.icon;
  const active = isPathActive(pathname, item.path);
  return (
    <NavLink
      to={item.path}
      end={item.path === '/' || item.path === '/tracking'}
      title={item.label}
      className={cn(
        'tracking-console-nav-item flex min-h-11 items-center gap-3 rounded-lg px-2.5 text-sm font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}


function AppCommandPalette({
  open,
  onOpenChange,
  groups = commandGroups,
  placeholder = 'Search trips, reports, settings, vehicles, speed rules...',
  currentPath = '',
}) {
  const navigate = useNavigate();

  const openItem = (path) => {
    onOpenChange(false);
    if (isPathActive(currentPath, path)) return;
    requestAnimationFrame(() => {
      navigate(path);
    });
  };

  return (
    <AppCommandDialog open={open} onOpenChange={onOpenChange}>
      <AppCommandInput placeholder={placeholder} />
      <AppCommandList>
        <AppCommandEmpty>No matching app shortcut found.</AppCommandEmpty>
        {groups.map((group, groupIndex) => (
          <div key={group.label}>
            {groupIndex > 0 && <AppCommandSeparator />}
            <AppCommandGroup heading={group.label}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <AppCommandItem
                    key={item.path}
                    value={`${item.label} ${item.hint}`}
                    keywords={item.keywords}
                    onSelect={() => openItem(item.path)}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                    <AppCommandShortcut>{item.hint}</AppCommandShortcut>
                  </AppCommandItem>
                );
              })}
            </AppCommandGroup>
          </div>
        ))}
      </AppCommandList>
    </AppCommandDialog>
  );
}
