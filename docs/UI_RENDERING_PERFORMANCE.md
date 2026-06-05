# UI Rendering and Performance Guide

This guide explains how the Road Sage UI renders today and how to improve it without making the app feel laggy, especially on Android through Capacitor.

## Quick Summary

Road Sage is a Vite + React 18 app rendered inside the web shell and wrapped by Capacitor for Android. The UI already has several performance protections:

- Route-level lazy loading in `src/App.jsx`.
- Idle route preloading after onboarding.
- TanStack Query for cached async data.
- Virtualized trip history rows in `src/pages/TripHistory.jsx`.
- Route point cleaning and down-sampling before Leaflet map rendering.
- Error boundaries around expensive map/settings/detail sections.
- Small SVG score rings instead of canvas-heavy widgets.

The main performance risks are:

- Re-rendering large dashboard sections while live GPS tracking updates.
- Rebuilding Leaflet layers too often in `TripMap`.
- Rendering too many charts or animated cards at once.
- Doing trip scoring, route-risk, search, filter, and map overlay calculations on the main thread during navigation.
- Adding visual effects like blur, large shadows, always-on animations, or nested glass panels across long lists.

## Current UI Stack

| Layer | Current implementation | Performance note |
| --- | --- | --- |
| App runtime | Vite, React 18, React Router | Fast startup, route chunks possible. |
| Mobile wrapper | Capacitor Android | Web rendering cost matters more on low-end devices. |
| Styling | Tailwind CSS tokens in `src/index.css` | Cheap when classes are static. Avoid generating dynamic class strings from unbounded data. |
| Data fetching | `@tanstack/react-query` in `src/lib/query-client.js` | Caching avoids refetch lag. Default `refetchOnWindowFocus: false`. |
| Maps | Leaflet in `src/components/TripMap.jsx` | Heavy layer rebuilds are the biggest visual risk. |
| Charts | Recharts | Fine for small charts. Avoid many animated charts in the same viewport. |
| Animations | Framer Motion | Useful for transitions. Keep motion limited in lists and repeated cards. |
| Lists | `@tanstack/react-virtual` in Trip History | Good pattern to reuse for any long scroll list. |

## Render Tree

The primary render path starts in `src/main.jsx`:

```jsx
ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
```

`src/App.jsx` wraps the app with global providers:

```jsx
function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <PermissionProvider>
          <Router>
            <AuthenticatedApp />
          </Router>
        </PermissionProvider>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}
```

After auth, onboarding, settings hydration, theme application, and biometric gating, normal pages render through:

```jsx
<Route element={<BiometricRouteGuard><Layout /></BiometricRouteGuard>}>
  <Route path="/" element={<LazyRoute><Dashboard /></LazyRoute>} />
  <Route path="/trips" element={<LazyRoute><TripHistory /></LazyRoute>} />
  <Route path="/trips/:id" element={<LazyRoute><TripDetail /></LazyRoute>} />
  <Route path="/map" element={<LazyRoute><MapScreen /></LazyRoute>} />
  <Route path="/settings" element={<LazyRoute><Settings /></LazyRoute>} />
</Route>
```

The shared shell is `src/components/Layout.jsx`:

- Header and nav render on every page.
- Mobile drawer uses `AnimatePresence` and `motion.div`.
- `Outlet` renders the current route.
- Header polls active trip state every 2 seconds to show the `Recording` badge.

## Route Loading

`src/App.jsx` uses a local helper that combines `React.lazy` with manual preload support:

```jsx
const lazyWithPreload = (loader) => {
  let loadPromise;
  const load = () => {
    loadPromise ||= loader();
    return loadPromise;
  };
  const Component = lazy(load);
  Component.preload = load;
  return Component;
};
```

After onboarding, primary routes are preloaded during idle time:

```jsx
primaryPreloadRoutes.forEach((RouteComponent, index) => {
  runWhenIdle(() => {
    if (!cancelled) RouteComponent.preload?.();
  }, 350 + index * 250);
});
```

The layout also preloads pages on hover/focus/touch:

```jsx
const routePreloaders = {
  '/': () => import('@/pages/Dashboard'),
  '/trips': () => import('@/pages/TripHistory'),
  '/map': () => import('@/pages/MapScreen'),
  '/settings': () => import('@/pages/Settings'),
};
```

Recommended improvement: keep this pattern. If a new page is heavy, make it a lazy route and add it to hover/touch preload only if it is commonly used.

## Data and State Flow

### Server/local data

Pages use TanStack Query:

```jsx
const { data: trips = [], isLoading } = useQuery({
  queryKey: ['all-trips'],
  queryFn: () => tripService.list({ sort: '-start_time', limit: 1000 }),
});
```

Global defaults in `src/lib/query-client.js`:

```jsx
defaultOptions: {
  queries: {
    refetchOnWindowFocus: false,
    retry: 1,
  },
},
```

Performance guidance:

- Prefer query cache invalidation over local duplicate fetches.
- Keep query keys specific: `['trip', id]`, `['all-trips']`, `['vehicles']`.
- Avoid refetching on every tab switch or route mount unless the data is truly stale.

### Settings

Settings are read from `localSettings` in many pages. This is cheap when read once, but changes will not always cause automatic render updates unless the page subscribes through a hook such as `useSettingsVersion`.

Good pattern:

```jsx
const settings = localSettings.get();
const settingsVersion = useSettingsVersion(settings);
```

Use this when derived UI must refresh after settings change. Do not add broad settings subscriptions to every component.

### Live trip state

The dashboard uses `useSyncExternalStore` for active trip snapshots:

```jsx
function useActiveTripSnapshot() {
  const subscribe = activeTripStore.subscribe || (() => () => {});
  const getSnapshot = activeTripStore.getSnapshot || (() => ({
    trip: activeTripStore.get?.() || null,
    version: 0,
  }));
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
```

This is the right pattern for live tracking because it lets React subscribe to an external store without manually polling inside large components.

Recommended improvement: use this subscription pattern instead of new `setInterval` polling for UI that depends on active trip state.

## Page Rendering Notes

### Dashboard

File: `src/pages/Dashboard.jsx`

Dashboard is the heaviest page. It handles live tracking, current route, scoring, notifications, readiness, danger zones, fatigue, and recent trips.

Existing performance protections:

- `memo` on `ActiveTripPanel`, `ElapsedClock`, `LiveCoachOverlaySubscriber`, and `DashboardRiskPanel`.
- `useSyncExternalStore` for active trip snapshots.
- `useMemo` for expensive derived metrics.
- `ElapsedClock` writes directly to a `ref` once per second so the whole dashboard does not re-render for the timer.
- Live map rendering passes `smoothRoute={false}` for active trips.

Example timer pattern:

```jsx
const ElapsedClock = memo(function ElapsedClock({ startTime }) {
  const elapsedRef = useRef(null);

  useEffect(() => {
    const update = () => {
      if (!elapsedRef.current) return;
      const seconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      elapsedRef.current.textContent = formatDuration(seconds);
    };

    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [startTime]);

  return <span ref={elapsedRef}>{formatDuration(0)}</span>;
});
```

Improvement priorities:

- Keep live GPS updates isolated to small components.
- Avoid adding animated charts to the live tracking panel.
- Move any expensive trip calculations into `useMemo`, idle callbacks, or a worker if they process many route points.
- Do not pass newly created object/array props into memoized components unless they are wrapped in `useMemo`.

### Trip History

File: `src/pages/TripHistory.jsx`

Trip History is already built for larger datasets.

Existing performance protections:

- `useDeferredValue(search)` delays heavy filtering while typing.
- `useMemo` for completed trips, sparkline data, filters, sorting, score deltas, and vehicle maps.
- `useVirtualizer` renders only visible rows.

Current virtualization pattern:

```jsx
const rowVirtualizer = useVirtualizer({
  count: sorted.length,
  getScrollElement: () => tripListRef.current,
  estimateSize: () => TRIP_CARD_ESTIMATED_HEIGHT,
  getItemKey: (index) => sorted[index]?.id ?? index,
  initialRect: { width: 0, height: 720 },
  overscan: TRIP_LIST_OVERSCAN,
});
```

Recommended improvement: reuse this pattern for any future long lists, such as event history, alerts, reports, backups, or diagnostics logs.

### Trip Detail

File: `src/pages/TripDetail.jsx`

Trip Detail renders score summaries, map layers, event lists, charts, metadata editing, road data status, and calibration prompts.

Existing performance protections:

- `EventRow` is memoized with a custom comparison.
- Map is isolated behind `TripMap` and a section error boundary.
- Event categories are split into scored, reviewed, and diagnostic rows.
- Some row sections have fixed max heights and scroll internally.

Potential lag sources:

- Multiple Recharts charts in one page.
- Long event lists if a route has many diagnostic events.
- Rebuilding event display arrays on every mutation.
- Large trip route point arrays flowing into `TripMap`.

Recommended improvement:

- Virtualize event rows if trips can have hundreds of events.
- Keep chart animations disabled or minimal on mobile.
- Derive event rows with `useMemo`.

### Map Screen

File: `src/pages/MapScreen.jsx`

Map Screen handles selected trip routes, all-trip route overlays, current location, parking, playback, repeated-event zones, route-risk layers, and speed-limit layers.

Existing performance protections:

- Loads at most 500 trips for map selection.
- Renders buttons for only the first 30 filtered trips.
- Uses `useMemo` for commute comparison, route-risk segments, privacy-zone filtering, and danger-zone display.
- Selected route mode renders one route; all-routes mode uses smaller route caps inside `TripMap`.

Good current cap:

```jsx
{completed.slice(0, 30).map(trip => (
  <button key={trip.id} onClick={() => setSelectedTripId(trip.id)}>
    ...
  </button>
))}
```

Recommended improvement:

- If the map selector grows, use virtualization instead of increasing the `slice(0, 30)`.
- Keep all-route map mode down-sampled and avoid showing events for every trip at once.
- Rebuild danger zones on idle or in a worker if the trip count gets high.

### Trip Map

File: `src/components/TripMap.jsx`

This is the most important rendering component for avoiding lag.

The component:

- Creates a Leaflet map once after mount.
- Stores map/layer objects in refs.
- Clears and redraws a Leaflet layer group when data changes.
- Masks privacy zones before drawing.
- Down-samples route points.
- Clusters nearby events.
- Falls back to a lightweight SVG route preview when tiles fail.

Current point caps:

```jsx
route_points: prepareMapRoutePoints(maskedPoints, {
  maxPoints: route.selected ? 900 : 450,
  smooth: smoothRoute,
}),
```

Route preparation in `src/lib/mapPlaybackInsights.js`:

```jsx
export function prepareMapRoutePoints(points = [], options = {}) {
  const {
    maxPoints = DEFAULT_RENDER_POINTS,
    smooth = true,
  } = options;
  const clean = cleanRoutePoints(restoreOriginalRouteGeometry(points));
  const visualPoints = smooth ? smoothRoutePoints(clean) : clean;
  if (!maxPoints || visualPoints.length <= maxPoints) return visualPoints;
  return downsampleRoutePoints(visualPoints, maxPoints);
}
```

Recommended improvement:

- Keep selected route caps near `700-900` points.
- Keep comparison/overview routes near `300-450` points.
- Do not draw every raw GPS reading unless in a dedicated diagnostics mode.
- Avoid putting React state inside loops that draw Leaflet markers.
- Keep HTML popup generation escaped through `escapeHtml`.

### Reports and Coach

Files: `src/pages/Report.jsx`, `src/pages/DrivingCoach.jsx`

These pages use more Recharts components. They are less risky than live map/tracking, but chart count can add up.

Recommended improvement:

- Disable animation on charts below the fold.
- Render chart sections only when the tab/section is open.
- Memoize chart data arrays.
- Keep export/PDF work outside critical render paths.

## Styling and Layout Performance

Global tokens live in `src/index.css`. The app uses CSS variables for light/dark colors:

```css
:root {
  --background: 220 20% 97%;
  --foreground: 220 25% 10%;
  --card: 0 0% 100%;
  --primary: 217 91% 50%;
}
```

Good UI improvement rules for this app:

- Prefer static Tailwind classes over dynamic inline styles.
- Use `rounded-xl` or `rounded-2xl` consistently; avoid making every section visually heavy.
- Avoid nested cards inside cards on dense pages.
- Use `border` and subtle background changes before large shadows.
- Avoid repeated `backdrop-blur-xl` inside scrollable lists. It can be expensive on Android.
- Use `will-change` only for active short animations, then reset it. The CSS already does this for score rings and live coach overlays.

Existing performance-aware CSS:

```css
.live-coach-overlay {
  transition: opacity 150ms ease, transform 150ms ease;
  will-change: opacity, transform;
}

.live-coach-overlay.idle,
.score-ring-animated.complete {
  will-change: auto;
}
```

## Safe UI Improvement Patterns

### 1. Memoize derived data, not JSX by default

Use `useMemo` for expensive arrays:

```jsx
const visibleTrips = useMemo(() => {
  return trips
    .filter((trip) => trip.status === 'completed')
    .filter((trip) => matchesFilter(trip, filter))
    .sort(sortTrips);
}, [trips, filter, sortTrips]);
```

Avoid:

```jsx
const visibleTrips = trips.filter(...).sort(...);
```

That recalculates on every render.

### 2. Keep props stable for memoized children

Good:

```jsx
const mapRoutes = useMemo(() => trips.map((trip) => ({
  id: trip.id,
  route_points: trip.route_points,
  color: '#3b82f6',
})), [trips]);

return <TripMap routes={mapRoutes} />;
```

Risky:

```jsx
return <TripMap routes={trips.map((trip) => ({ ...trip }))} />;
```

This creates a new array and new objects on every render.

### 3. Virtualize any long list

Use this when the list may exceed about 50 rows:

```jsx
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  getScrollElement: () => listRef.current,
  estimateSize: () => 96,
  getItemKey: (index) => rows[index]?.id ?? index,
  overscan: 5,
});
```

### 4. Defer typing-driven filters

Trip History already does this:

```jsx
const deferredSearch = useDeferredValue(search);
```

Use `deferredSearch` inside expensive search/filter `useMemo` blocks.

### 5. Keep live timers out of global render state

For labels that update every second, prefer a tiny component with a `ref` update instead of setting state in a parent page.

Good:

```jsx
const timerRef = useRef(null);
useEffect(() => {
  const id = setInterval(() => {
    timerRef.current.textContent = formatDuration(seconds());
  }, 1000);
  return () => clearInterval(id);
}, []);
```

Avoid:

```jsx
const [seconds, setSeconds] = useState(0);
setInterval(() => setSeconds(seconds + 1), 1000);
```

That can re-render a large page every second.

### 6. Make heavy panels lazy or conditional

For optional panels:

```jsx
{showAdvanced && <AdvancedPanel />}
```

For heavy routes:

```jsx
const HeavyPage = lazyWithPreload(() => import('@/pages/HeavyPage'));
```

### 7. Draw maps imperatively, keep React around controls

Leaflet should own map layers. React should own buttons, panels, and high-level props.

Good:

```jsx
const map = leafletMapRef.current;
const layers = layersRef.current;
layers.clearLayers();
window.L.polyline(latLngs, options).addTo(layers);
```

Avoid storing every marker as React state.

### 8. Cap render data before drawing

Use limits close to the current app defaults:

```jsx
const selectedRoutePoints = prepareMapRoutePoints(points, { maxPoints: 900 });
const overviewRoutePoints = prepareMapRoutePoints(points, { maxPoints: 450 });
const previewEvents = events.slice(0, 40);
```

## High-Impact Improvements To Consider

1. Convert `Layout` active trip polling to `useSyncExternalStore`.

Current layout checks active tracking every 2 seconds:

```jsx
const interval = setInterval(checkTracking, 2000);
```

Better:

```jsx
const activeTripSnapshot = useSyncExternalStore(
  activeTripStore.subscribe,
  activeTripStore.getSnapshot,
  activeTripStore.getSnapshot
);
const trackingActive = Boolean(activeTripSnapshot.trip);
```

This updates only when the store changes and removes a permanent interval from the app shell.

2. Memoize `mapRoutes` in `MapScreen`.

`mapRoutes` is built during render. Wrapping it in `useMemo` will reduce `TripMap` redraw pressure when unrelated UI state changes.

```jsx
const mapRoutes = useMemo(() => (
  selectedTrip
    ? [{
      id: selectedTrip.id,
      route_points: selectedTrip.route_points,
      rawPointCount: selectedTrip.route_points_raw_count,
      selected: true,
      color: '#3b82f6',
      label: formatDate(selectedTrip.start_time),
    }]
    : completed.map((trip, index) => ({
      id: trip.id,
      route_points: trip.route_points,
      rawPointCount: trip.route_points_raw_count,
      selected: false,
      color: MAP_ROUTE_COLORS[index % MAP_ROUTE_COLORS.length],
      label: formatDate(trip.start_time),
    }))
), [selectedTrip, completed]);
```

3. Add virtualized event rows in Trip Detail.

Use this if event counts grow beyond the current scroll-limited sections:

```jsx
const eventVirtualizer = useVirtualizer({
  count: displayEvents.length,
  getScrollElement: () => eventListRef.current,
  estimateSize: () => 74,
  overscan: 6,
});
```

4. Move expensive overlay rebuilds off the critical render path.

Map Screen currently rebuilds repeated-event zones and route risk after trip data changes. If this starts lagging, schedule it after paint or move it to a worker.

```jsx
const runIdle = (callback) => {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(callback, { timeout: 2000 });
    return;
  }
  window.setTimeout(callback, 50);
};
```

5. Reduce Framer Motion in repeated cards.

`TripCard` animates entry. That is fine for a few cards, but long virtualized lists should avoid delayed animation per row.

Good list rule:

```jsx
const shouldAnimate = index < 8;
```

## What Not To Do

- Do not render all trip cards on the map screen.
- Do not remove `prepareMapRoutePoints` caps to show every GPS point.
- Do not add always-running background animations to the dashboard.
- Do not put `backdrop-blur-xl` on every card in a scrolling list.
- Do not call `localSettings.get()` repeatedly inside large `.map()` loops.
- Do not create new arrays/objects inline when passing props into `memo` children.
- Do not fetch road context, weather, speed limits, or PDF data during initial page render unless the user explicitly asks.
- Do not add global state updates for tiny labels like clocks, progress text, or hover-only indicators.

## Measurement Checklist

Use this checklist before and after UI changes:

- Build succeeds: `npm run build`
- Core render tests pass: `npm test`
- Open key pages on mobile width: Dashboard, Trips, Trip Detail, Map, Settings.
- During live tracking, the Dashboard does not re-render large panels every second.
- Trip History search stays responsive with 500-1000 trips.
- Map interaction stays responsive with a selected trip of 900 rendered points.
- All-route map mode stays capped and does not try to draw every event for every trip.
- No new long-running calculations happen directly during render.

Useful browser checks:

```js
// Quick render marker while profiling in DevTools
performance.mark('ui-change-start');
// interact with the page
performance.mark('ui-change-end');
performance.measure('ui-change', 'ui-change-start', 'ui-change-end');
```

Use React DevTools Profiler for:

- Which components re-render after a state change.
- Whether `TripMap`, `TripCard`, or chart components render when unrelated controls change.
- Whether props are unstable and breaking memoization.

## Best Next UI Improvements

The lowest-risk path is:

1. Improve spacing, typography, and information hierarchy using existing Tailwind tokens.
2. Keep heavy data and map layers capped.
3. Reuse virtualization for any longer lists.
4. Convert remaining polling UI to subscriptions where stores already support it.
5. Memoize data arrays passed to `TripMap`, charts, and repeated cards.
6. Add richer controls only when they are conditional, lazy, or cheap to render.

This gives the app a better UI without trading away smooth navigation, touch response, or map performance.
