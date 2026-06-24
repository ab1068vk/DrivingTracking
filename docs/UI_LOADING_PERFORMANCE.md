# Road Sage UI and Loading Performance Guide

Last reviewed: 2026-06-22

This document explains why the Road Sage UI can feel laggy across the whole app, with extra focus on the Saved road speeds page because it is one of the heaviest screens. It is written as an implementation guide and incident playbook: it shows the current code paths, likely bottlenecks, emergency triage steps, and the specific UI and data-loading patterns that should be used when improving the app.

The main goal is simple: every page should show useful content quickly, keep already loaded content visible during background refreshes, and avoid rebuilding expensive map or trip data unless the user actually needs it.

## Quick Summary

The app already has several good foundations:

- React route-level code splitting is enabled with `lazy()` and `Suspense`.
- React Query is configured globally with caching, stale time, retry behavior, and disabled focus refetch.
- Trip summaries are separated from full trip details in the local repository.
- Maps already cap some route point rendering to protect mobile performance.
- Several pages already use skeleton loading states.

The biggest lag risks are:

- The Saved road speeds page loads saved speed rules first, then schedules a full trip list load of up to 500 trips.
- The same page builds speed-map sections from trips and saved rules on the main thread.
- The speed map clears and redraws all Leaflet layers every time the visible section array changes.
- Map fitting runs whenever the filtered section list changes, so filtering can cause visual jumps and extra map work.
- Some whole-app pages request all trip summaries or many full trip details, then run large `useMemo` computations immediately after data arrives.
- Some loading states replace content instead of keeping stale content visible with a small refresh indicator.
- Settings changes can trigger broad re-renders because `useLocalSettings()` compares full settings objects with `JSON.stringify`.

The most important product rule:

> Do not block the first paint of a page on data that is only needed for secondary panels, maps, diagnostics, or background recalculation.

## Current Incident Update

User report on 2026-06-22: the whole app feels very laggy, not just the Saved road speeds page. Treat this as an app-wide performance incident until proven otherwise.

Important clarification: adding or editing `docs/UI_LOADING_PERFORMANCE.md` does not by itself slow the production app unless the document is imported, rendered, indexed, or processed by a running app screen or build task. A markdown file sitting in `docs/` is not part of the React runtime bundle by default. The more likely issue is that the same underlying heavy code paths described here are now being noticed across normal navigation.

The incident hypothesis is:

1. App startup and resume are doing too much background work close to first paint.
2. Multiple pages request broad trip history or full trip detail data.
3. Maps and playback components rebuild many Leaflet layers on the main thread.
4. Settings and storage listeners can cause wide re-renders.
5. Saved road speed analysis can load hundreds of full trips and rebuild map sections.
6. Some loading states still block or replace content instead of keeping stale UI visible.

Immediate operating rule while fixing this:

> No new page should call `tripService.list()`, `tripService.listAll()`, or `tripService.listAllSummaries()` during first paint unless the first visible screen truly needs that entire data set.

## Stop-The-Bleed Checklist

Use this checklist before deeper refactors. It is meant to reduce obvious app-wide lag quickly.

1. Check whether a page is using full trips when summaries are enough.

Bad for first paint:

```js
tripService.list({ sort: '-start_time', limit: 500 })
tripService.listAll({ sort: '-start_time' })
```

Better for first paint:

```js
tripService.listSummaries({ sort: '-start_time', limit: 50 })
```

2. Keep existing UI visible during refresh.

Bad:

```jsx
{isLoading ? <FullPageLoading /> : <PageContent />}
```

Better:

```jsx
{isInitialLoading ? <PageSkeleton /> : <PageContent refreshing={isFetching} />}
```

3. Defer maps, playback, diagnostics, and health checks until after primary content.

```js
const [enhancementsReady, setEnhancementsReady] = useState(false);

useEffect(() => {
  const timer = window.setTimeout(() => setEnhancementsReady(true), 0);
  return () => window.clearTimeout(timer);
}, []);
```

4. Disable automatic map fitting after the first draw.

Map fitting is useful, but repeated `fitBounds` during filters or refreshes makes the UI feel jumpy and expensive.

5. Add measurements before rewriting large modules.

```js
performance.mark('page-heavy-work:start');
// expensive work
performance.mark('page-heavy-work:end');
performance.measure('page-heavy-work', 'page-heavy-work:start', 'page-heavy-work:end');
```

6. Prefer a temporary feature gate over shipping a half-refactor.

For example, a temporary `showMap={false}` or `loadMapOnOpen={false}` mode can prove whether maps are the cause of app-wide jank before changing storage or scoring code.

## Global Lag Suspects

These are app-wide suspects that can make every page feel slow even when a single page is not obviously broken.

### Startup and resume work

`src/App.jsx` performs several tasks around startup and app resume. Some are already deferred, but several resume paths can still run close to user interaction.

```jsx
if (isActive) {
  syncNativeCompletedTripsToLocalStore()
    .catch((error) => logSystemFailure('app_resume_native_completed_trips_sync', error));
  checkAndRotateEncryptionKey()
    .catch((error) => logSystemFailure('app_resume_key_rotation_check', error));
  import('@/lib/roadContextQueue')
    .then(({ resumePendingRoadContextJobs }) => resumePendingRoadContextJobs())
    .catch((error) => logSystemFailure('app_resume_road_context_queue', error));
  import('@/lib/localTripRepository')
    .then(({ enforceRawGpsRetention }) => enforceRawGpsRetention())
    .catch((error) => logSystemFailure('app_resume_raw_gps_retention', error));
}
```

Risk:

- App resume can trigger native trip sync, key rotation, road context queue work, and raw GPS retention.
- If any of those touches large trip storage, the app can feel slow immediately after opening or switching back.

Recommended:

- Keep security-critical checks.
- Move large storage maintenance to idle time.
- Record how long each resume task takes.
- Never block route rendering on retention, queue resume, or completed-trip import unless data correctness requires it.

### Route logging on every navigation

`RouteLogger` records every route change:

```jsx
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
```

Risk:

- If `recordSystemEvent` writes to storage synchronously or does expensive sanitization, every navigation can feel delayed.

Recommended:

- Fire-and-forget route logging behind `requestIdleCallback`.
- Batch route events.
- Drop route logging entirely in performance emergency builds if needed.

Example:

```js
const recordRouteChangeIdle = (event) => {
  const run = () => recordSystemEvent('route_changed', event, {
    title: 'Page opened',
    category: 'navigation',
  });
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2000 });
  } else {
    window.setTimeout(run, 250);
  }
};
```

### Shared settings refreshes

`useLocalSettings()` reads the full settings object and compares it with `JSON.stringify`.

```jsx
setSettings((current) => (
  JSON.stringify(current) === JSON.stringify(next) ? current : next
));
```

Risk:

- Any focus, storage, or settings change can make many components compare and potentially re-render.
- Hot map and dashboard components use settings, so broad settings updates can amplify lag.

Recommended:

- Add selector-based settings hooks for hot components.
- Avoid full-object compare in components that only need one value such as `units`, `show_privacy_circles`, or `speed_warning_enabled`.

### Layout polling

`Layout` checks tracking state every 5 seconds and on focus/storage changes:

```jsx
const interval = setInterval(checkTrackingWhenVisible, 5000);
window.addEventListener('storage', checkTracking);
window.addEventListener('focus', checkTracking);
document.addEventListener('visibilitychange', checkTrackingWhenVisible);
```

Risk:

- This should be cheap if `activeTripStore.get()` is cheap.
- If active trip storage grows or parsing gets heavier, this becomes app-wide recurring work.

Recommended:

- Confirm `activeTripStore.get()` is memory-backed or cheap.
- Prefer event-driven active-trip changes over polling if this shows up in measurements.

### All-summary queries on first paint

Several pages use `tripSummaryQueryOptions()`, which currently asks for all summaries:

```js
export const tripSummaryQueryOptions = () => ({
  queryKey: tripQueryKeys.summaries,
  queryFn: () => tripService.listAllSummaries({ sort: '-start_time' }),
  staleTime: 5 * 60 * 1000,
});
```

Risk:

- On a large local history, even summaries can be expensive to decrypt, sort, map, and analyze.
- Pages then run their own `useMemo` filters and summaries after the query resolves.

Recommended:

- Add a separate limited query option for first paint:

```js
export const limitedTripSummaryQueryOptions = (limit = 50) => ({
  queryKey: [...tripQueryKeys.summaries, 'limited', limit],
  queryFn: () => tripService.listSummaries({ sort: '-start_time', limit }),
  staleTime: 2 * 60 * 1000,
});
```

- Use all summaries only for reports, full history, and analytics sections that visibly need all history.

## AI Implementation Handoff

This section is written for another coding agent or assistant that is asked to implement the fixes from this document.

### Short answer

Yes, this document should be enough for an experienced coding agent to start improving the app, but it should not jump straight into a broad rewrite. The safest path is to first add measurement, then make one or two low-risk loading changes, then verify whether the app feels better.

The agent should treat this as a performance-debugging task, not a design refresh.

### Current branch and scope

Expected branch:

```text
codex/laggy-fix
```

Current documentation files:

```text
docs/UI_LOADING_PERFORMANCE.md
docs/README.md
README.md
```

Primary code areas to inspect before editing:

```text
src/App.jsx
src/lib/query-client.js
src/api/trips.js
src/lib/localTripRepository.js
src/hooks/useLocalSettings.jsx
src/pages/Dashboard.jsx
src/pages/TripHistory.jsx
src/pages/MapScreen.jsx
src/pages/SpeedLimits.jsx
src/components/SpeedLimitEditorMap.jsx
src/components/TripMap.jsx
src/lib/speedLimitMapSections.js
```

### First prompt to give another AI

Use this prompt if handing the work to another assistant:

```text
You are working in the Road Sage React/Vite/Capacitor app. The whole app feels laggy, especially Saved road speeds, Map, Dashboard, Settings toggles/check marks, and trip-history-related screens. Read docs/UI_LOADING_PERFORMANCE.md first and follow its Phase 0 incident triage before making broad changes.

Goal: implement the lowest-risk performance fixes that improve perceived responsiveness without changing scoring, storage correctness, privacy behavior, or trip data semantics.

Start by inspecting these files: src/App.jsx, src/api/trips.js, src/lib/localTripRepository.js, src/pages/Dashboard.jsx, src/pages/Settings.jsx, src/pages/SpeedLimits.jsx, src/components/SpeedLimitEditorMap.jsx, src/components/TripMap.jsx, src/hooks/useLocalSettings.jsx, and src/lib/trackingStore.js.

Make small changes in this order:
1. Add or use lightweight performance marks around app bootstrap/resume, route logging, trip summary queries, full trip list queries, SpeedLimit map-section building, and map drawing.
2. Make route logging and non-critical resume work idle/deferred if it is not already.
3. Add a limited trip summary query for first-paint Dashboard usage instead of all summaries.
4. Change Saved road speeds so saved rows load separately from the heavy map model, and show a map-building state instead of blocking or blanking the page.
5. Avoid mounting or drawing the speed map when the active workspace does not need it.
6. Stop automatic map fit-bounds from running on every filter/layer change.
7. Fix Settings toggle/check mark responsiveness with selector-based setting reads, optimistic local toggle state, and deferred persistence/side effects after paint.

Do not rewrite scoring, trip persistence, encryption, privacy-zone handling, or native Android services unless measurements prove they are the top cause. Preserve tests and existing behavior.

After each change, run the relevant tests/build and report exactly what changed, what was measured, and what remains risky.
```

### Required agent behavior

The agent should:

- Read the relevant code before editing.
- Preserve all privacy, encryption, scoring, and trip-storage behavior.
- Prefer small commits or small patches.
- Keep stale UI visible during background refresh.
- Add page-local skeletons or inline refresh badges instead of full-screen blockers.
- Use summaries for first paint and full trips only for selected maps/playback/export/recalculation paths.
- Verify with tests or a build after code changes.

The agent should not:

- Rewrite the app shell.
- Replace React Query.
- Change scoring formulas.
- Change trip schema or migrations.
- Remove security checks.
- Delete route logging permanently without a clear product decision.
- Turn off privacy protections to make maps faster.
- Load every full trip during app startup.

### Minimum useful implementation

If the agent only has time for one safe pass, implement these three changes:

1. Defer route logging with `requestIdleCallback`.
2. Add a limited dashboard summary query using `tripService.listSummaries({ sort: '-start_time', limit: 50 })`.
3. Split Saved road speeds into row loading and map-model loading, with a visible "Building map..." state.

This minimum pass should improve perceived responsiveness without touching scoring or persistence internals.

### What extra information helps

If available, give the agent:

- A video or description of which screen freezes first.
- Whether lag happens on cold launch, after app resume, after opening Saved road speeds, or after switching tabs.
- Approximate trip count and whether many trips have route points.
- Android device model and OS version.
- Whether the app is running as Vite dev, web build, or installed Android app.
- Console logs from performance marks.
- Any React error or warning logs.

Without that information, the agent should still begin with Phase 0 measurement and the low-risk fixes above.

## Source Map

| Area | Main files |
| --- | --- |
| App bootstrap and route loading | `src/App.jsx` |
| Shared shell and nav | `src/components/Layout.jsx` |
| React Query defaults | `src/lib/query-client.js` |
| Trip service facade | `src/api/trips.js` |
| Local trip repository | `src/lib/localTripRepository.js` |
| Local settings hook | `src/hooks/useLocalSettings.jsx` |
| Saved road speeds page | `src/pages/SpeedLimits.jsx` |
| Saved road speed map | `src/components/SpeedLimitEditorMap.jsx` |
| Speed map section builder | `src/lib/speedLimitMapSections.js` |
| Main trip map | `src/components/TripMap.jsx` |
| Trip playback map | `src/components/TripPlayback.jsx` |

## Current App Loading Architecture

### Route-level code splitting

The app lazy-loads page modules in `src/App.jsx`. This means each route can be downloaded separately instead of putting every page into the first JavaScript chunk.

```jsx
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TripHistory = lazy(() => import('@/pages/TripHistory'));
const TripDetail = lazy(() => import('@/pages/TripDetail'));
const SpeedAnalysis = lazy(() => import('@/pages/SpeedAnalysis'));
const MapScreen = lazy(() => import('@/pages/MapScreen'));
const Reports = lazy(() => import('@/pages/Report'));
const Settings = lazy(() => import('@/pages/Settings'));
const SpeedLimits = lazy(() => import('@/pages/SpeedLimits'));
```

The current fallback is full-screen:

```jsx
<Suspense fallback={<AppLoading />}>
  <Routes>
    {/* routes */}
  </Routes>
</Suspense>
```

This is good for first app launch, but route changes can feel heavier than needed because the fallback takes over the whole app. A smoother route-change pattern is to keep the shell visible and show page-local skeletons where possible.

Recommended direction:

```jsx
<Route element={<Layout />}>
  <Route
    path="/speed-limits"
    element={
      <AppRouteBoundary context="speed_limits_page" title="Saved road speeds unavailable">
        <Suspense fallback={<PageSkeleton title="Saved road speeds" />}>
          <SpeedLimits />
        </Suspense>
      </AppRouteBoundary>
    }
  />
</Route>
```

The important UX detail is that the layout, header, and navigation should stay stable while the page body loads.

### App bootstrap

The app waits for authentication, public settings, and local settings before rendering the main routes.

```jsx
if (isLoadingPublicSettings || isLoadingAuth || onboardingDone === null) {
  return <AppLoading />;
}
```

The bootstrap also performs useful background setup:

```jsx
const settings = await localSettings.hydrateFromNative();
setAppLockEnabled(lockEnabled);
setAppLocked(lockEnabled);
setOnboardingDone(settings.onboarding_completed);
applyThemeMode(settings.dark_mode);

setScreenCaptureAllowed(settings.allow_screen_capture === true)
  .catch((error) => logSystemFailure('screen_capture_policy_apply', error));
checkIntegrity()
  .catch((error) => logSystemFailure('device_integrity_check', error));
loadPrivacyZonesFromStorage(settings)
  .catch((error) => logSystemFailure('privacy_zones_load', error));
activeTripStore.hydrate()
  .catch((error) => logSystemFailure('active_trip_hydrate', error));
syncNativeCompletedTripsToLocalStore()
  .catch((error) => logSystemFailure('native_completed_trips_boot_sync', error));
```

Deferred maintenance is already pushed to idle time:

```jsx
if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(runDeferredMaintenance, { timeout: 1500 });
} else {
  window.setTimeout(runDeferredMaintenance, 0);
}
```

Keep this pattern. Anything that does not change the first visible screen should run after the first paint, during idle time, or behind an explicit user action.

### React Query cache defaults

The shared query client is configured in `src/lib/query-client.js`:

```js
export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 60 * 1000,
      gcTime: 30 * 60 * 1000,
    },
  },
});
```

This is a good base. For expensive local queries, prefer longer `staleTime` and `placeholderData`/`keepPreviousData` style behavior so page content does not disappear during refresh.

## Shared Loading Rules

Use these rules across the whole app.

### Rule 1: split critical data from enhancement data

Critical data is the minimum needed to render the first useful screen. Enhancement data powers maps, charts, recommendations, diagnostics, or previews.

Example for Saved road speeds:

- Critical: saved speed corrections, history state, health summary.
- Enhancement: up to 500 full trips, map sections, conflict previews, affected-trip estimates.

Critical data should load immediately. Enhancement data should load after the page is visible.

### Rule 2: keep previous content visible during refresh

Avoid replacing a populated page with a loading card unless this is the first load.

Recommended state shape:

```js
const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
const [refreshing, setRefreshing] = useState(false);

const loadRows = async ({ silent = false } = {}) => {
  if (!hasLoadedOnce && !silent) setLoading(true);
  if (hasLoadedOnce || silent) setRefreshing(true);
  try {
    // fetch data
    setHasLoadedOnce(true);
  } finally {
    setLoading(false);
    setRefreshing(false);
  }
};
```

Then render:

```jsx
{loading && !hasLoadedOnce ? (
  <SavedSpeedsSkeleton />
) : (
  <>
    {refreshing && <InlineRefreshBadge label="Refreshing saved speeds" />}
    <SavedSpeedContent rows={rows} />
  </>
)}
```

### Rule 3: page skeletons should match final layout

A single text card like `Loading saved speeds...` is honest, but it does not reduce perceived wait. Use skeletons that reserve the same space as the final UI.

Current Saved road speeds loading state:

```jsx
{loading ? (
  <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
    Loading saved speeds...
  </div>
) : rows.length === 0 ? (
  // empty state
) : (
  // content
)}
```

Better page-local loading state:

```jsx
function SavedSpeedsSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading saved road speeds">
      <div className="h-24 rounded-2xl bg-secondary/50 animate-pulse" />
      <div className="h-[28rem] rounded-2xl bg-secondary/50 animate-pulse" />
      {[1, 2, 3].map((item) => (
        <div key={item} className="h-32 rounded-xl bg-secondary/50 animate-pulse" />
      ))}
    </div>
  );
}
```

### Rule 4: use `aria-live` for loading changes

For long or background loads, include screen-reader status without visually noisy copy.

```jsx
<div className="sr-only" aria-live="polite">
  {loading ? 'Loading saved road speeds' : `${rows.length} saved road speeds loaded`}
</div>
```

Trip History already has this pattern:

```jsx
<div className="sr-only" aria-live="polite">
  {isLoading ? 'Loading trip history' : `${sorted.length} trips shown`}
</div>
```

### Rule 5: maps should not be the blocking first paint

Maps are expensive because they load Leaflet, allocate layers, draw polylines, fit bounds, and sometimes request tiles. The page should render controls and summaries first, then mount or populate the map.

Recommended pattern:

```jsx
const [mapEnabled, setMapEnabled] = useState(activeWorkspace === 'map');

useEffect(() => {
  if (activeWorkspace === 'map') {
    const timer = window.setTimeout(() => setMapEnabled(true), 0);
    return () => window.clearTimeout(timer);
  }
}, [activeWorkspace]);

{activeWorkspace === 'map' && (
  mapEnabled ? <SpeedLimitEditorMap {...props} /> : <MapSkeleton />
)}
```

### Rule 6: debounce text filters before expensive filtering

For filters that rebuild map sections or route layers, debounce the query.

```js
function useDebouncedValue(value, delayMs = 150) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}
```

Use it like this:

```js
const debouncedMapQuery = useDebouncedValue(mapQuery, 180);
```

Then pass `debouncedMapQuery` to the map.

## Saved Road Speeds Deep Dive

The Saved road speeds page is the most important lag target because it combines local storage, full trip data, conflict detection, map aggregation, editing controls, and Leaflet rendering.

### Current state

The page creates a local speed knowledge instance:

```jsx
const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
const [rows, setRows] = useState([]);
const [loading, setLoading] = useState(true);
const [mapTrips, setMapTrips] = useState([]);
```

It builds all map sections from `mapTrips` and `rows`:

```jsx
const mapSections = useMemo(() => buildSpeedMapSections(mapTrips, rows), [mapTrips, rows]);
const mapStats = useMemo(() => summarizeSpeedMapSections(mapSections), [mapSections]);
```

This means any change to `mapTrips` or saved rows can rebuild the entire speed map section model.

### Current row load

Current `loadRows()` reads three speed-knowledge values in parallel:

```jsx
const loadRows = useCallback(async ({ silent = false } = {}) => {
  if (!silent) setLoading(true);
  const [nextRows, nextHistory, rawKnowledge] = await Promise.all([
    knowledge.listUserCorrections().catch(() => []),
    knowledge.getHistoryState().catch(() => ({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' })),
    knowledge.exportData().catch(() => ({ cells: {}, corrections: [] })),
  ]);
  const safeRows = (Array.isArray(nextRows) ? nextRows : []).filter(Boolean);
  setRows(safeRows);
  setHistoryState(nextHistory);
  setHealth(inspectSpeedKnowledgeHealth(rawKnowledge));
  // draft hydration
  if (!silent) setLoading(false);

  const loadId = mapTripsLoadRef.current + 1;
  mapTripsLoadRef.current = loadId;
  scheduleIdleWork(() => {
    tripService.list({ sort: '-start_time', limit: 500 })
      .then((nextTrips) => {
        if (mapTripsLoadRef.current === loadId) setMapTrips(nextTrips);
      });
  });
}, [knowledge]);
```

This is mostly well-intentioned: it loads saved rows first and delays full trip loading. The problem is that once the trip data arrives, `buildSpeedMapSections(mapTrips, rows)` can perform a lot of work on the main thread.

### Why the page feels laggy

The slow path looks like this:

1. Page opens.
2. Saved rows load.
3. The UI renders controls, attention items, workspaces, saved row cards, and the empty or partial map.
4. Idle work loads up to 500 full trips with route points.
5. `mapTrips` updates.
6. `buildSpeedMapSections(mapTrips, rows)` loops through trip route points, groups them by geohash, merges candidates, detects conflicts, and sorts results.
7. `SpeedLimitEditorMap` receives a new `sections` array.
8. The Leaflet layer effect clears all section layers and adds them again.
9. The map fit-bounds effect recalculates bounds from all visible section points.

The expensive code in `src/lib/speedLimitMapSections.js`:

```js
export function buildSpeedMapSections(trips = [], corrections = []) {
  const candidates = new Map();

  for (const trip of trips || []) {
    if (trip?.status && trip.status !== 'completed') continue;
    const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
    let currentHash = '';
    let currentPoints = [];

    const flush = () => {
      if (!currentHash || !currentPoints.length) return;
      const candidate = sectionCandidate(currentHash, currentPoints, trip?.id);
      if (candidate) candidates.set(currentHash, mergeCandidates(candidates.get(currentHash), candidate));
    };

    for (const point of points) {
      if (!isPublicPoint(point)) {
        flush();
        currentHash = '';
        currentPoints = [];
        continue;
      }
      const geohash = geohashEncode(point.lat, point.lng);
      if (geohash !== currentHash) {
        flush();
        currentHash = geohash;
        currentPoints = [point];
      } else {
        currentPoints.push(point);
      }
    }
    flush();
  }

  // combine trip candidates with saved corrections
}
```

The expensive map redraw in `src/components/SpeedLimitEditorMap.jsx`:

```jsx
useEffect(() => {
  const map = mapRef.current;
  const layers = sectionLayersRef.current;
  if (!mapReady || !map || !layers) return;

  stopLeafletMap(map);
  safeLeafletCall(() => layers.clearLayers());

  sections.forEach((section) => {
    addSectionToLayer({
      section,
      layerGroup: layers,
      selected: false,
      showPermanentLabel: permanentLabelKeys.has(sectionKey(section)),
      addMode: false,
      onSelect: (section) => {
        if (!addModeRef.current) onSelectRef.current?.(section);
      },
    });
  });
}, [mapReady, permanentLabelKeys, sections]);
```

The map also refits whenever `sections` changes:

```jsx
useEffect(() => {
  const map = mapRef.current;
  if (!mapReady || !map) return;
  const points = sections.flatMap(sectionPositions);
  if (!points.length) {
    safeMapSetView(map, center, 13);
    return;
  }
  if (points.length === 1) {
    safeMapSetView(map, points[0], 15);
    return;
  }
  safeMapFitBounds(map, L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
}, [center, mapReady, sections]);
```

### Recommended Saved road speeds load model

The page should have three independent load layers:

| Layer | Data | UI behavior |
| --- | --- | --- |
| Critical | saved corrections, history, health | blocks only first row/card skeleton |
| Map model | full trips, map sections, conflicts | loads after first paint and shows map skeleton/progress |
| Recalculation | affected trip score refreshes | never blocks page; shows inline background status |

Suggested state model:

```js
const [rowsState, setRowsState] = useState({
  loading: true,
  refreshing: false,
  loadedOnce: false,
  rows: [],
  history: { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' },
  health: null,
});

const [mapState, setMapState] = useState({
  loading: false,
  loadedOnce: false,
  trips: [],
  sections: [],
  error: null,
});
```

Suggested critical loader:

```js
const loadSpeedRows = useCallback(async ({ silent = false } = {}) => {
  setRowsState((current) => ({
    ...current,
    loading: !current.loadedOnce && !silent,
    refreshing: current.loadedOnce || silent,
  }));

  try {
    const [nextRows, nextHistory, rawKnowledge] = await Promise.all([
      knowledge.listUserCorrections().catch(() => []),
      knowledge.getHistoryState().catch(() => ({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' })),
      knowledge.exportData().catch(() => ({ cells: {}, corrections: [] })),
    ]);

    setRowsState({
      loading: false,
      refreshing: false,
      loadedOnce: true,
      rows: (Array.isArray(nextRows) ? nextRows : []).filter(Boolean),
      history: nextHistory,
      health: inspectSpeedKnowledgeHealth(rawKnowledge),
    });
  } catch (error) {
    setRowsState((current) => ({
      ...current,
      loading: false,
      refreshing: false,
      loadedOnce: true,
      error,
    }));
  }
}, [knowledge]);
```

Suggested map loader:

```js
const loadSpeedMapModel = useCallback(async ({ rows }) => {
  const loadId = mapTripsLoadRef.current + 1;
  mapTripsLoadRef.current = loadId;

  setMapState((current) => ({
    ...current,
    loading: !current.loadedOnce,
    refreshing: current.loadedOnce,
    error: null,
  }));

  scheduleIdleWork(async () => {
    try {
      const trips = await tripService.list({ sort: '-start_time', limit: 500 });
      if (mapTripsLoadRef.current !== loadId) return;

      const sections = buildSpeedMapSections(trips, rows);
      if (mapTripsLoadRef.current !== loadId) return;

      setMapState({
        loading: false,
        refreshing: false,
        loadedOnce: true,
        trips,
        sections,
        error: null,
      });
    } catch (error) {
      setMapState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        loadedOnce: true,
        error,
      }));
    }
  });
}, []);
```

This still uses the main thread, but it makes the load phases explicit and prevents the saved rows from looking stuck while the map model is being built.

### Better long-term map model

For larger data sets, move section building out of React render and preferably off the main thread.

Worker shape:

```js
// speedMapSections.worker.js
import { buildSpeedMapSections } from '@/lib/speedLimitMapSections';

self.onmessage = (event) => {
  const { requestId, trips, rows } = event.data;
  const sections = buildSpeedMapSections(trips, rows);
  self.postMessage({ requestId, sections });
};
```

React wrapper:

```js
const buildSectionsInWorker = ({ trips, rows }) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./speedMapSections.worker.js', import.meta.url), {
    type: 'module',
  });
  const requestId = crypto.randomUUID();

  worker.onmessage = (event) => {
    if (event.data?.requestId !== requestId) return;
    worker.terminate();
    resolve(event.data.sections);
  };
  worker.onerror = (error) => {
    worker.terminate();
    reject(error);
  };
  worker.postMessage({ requestId, trips, rows });
});
```

If worker setup is too much for the first pass, an idle chunking helper is the next best option.

### Do not mount all workspaces equally

The Saved road speeds page has Map, Needs review, and Saved roads workspaces. The map workspace is the heaviest. The saved table is also heavy because each row calculates evidence, recommendation, impact, and preview.

Recommended rendering contract:

- Always render the header, workspace tabs, summary, and current status.
- Render only the active workspace body.
- Load map trips only when the Map or Needs review workspace needs them.
- Keep saved row pagination small.
- Keep details collapsed until the user opens a row.

Current workspace values:

```js
const SPEED_WORKSPACES = [
  { value: 'map', label: 'Map', Icon: MapIcon },
  { value: 'review', label: 'Needs review', Icon: AlertTriangle },
  { value: 'saved', label: 'Saved roads', Icon: SlidersHorizontal },
];
```

Recommended gate:

```jsx
{activeWorkspace === 'map' && (
  <SpeedMapWorkspace
    loading={mapState.loading}
    sections={mapState.sections}
    trips={mapState.trips}
  />
)}

{activeWorkspace === 'review' && (
  <ReviewWorkspace
    loading={mapState.loading && !mapState.loadedOnce}
    attentionItems={attentionItems}
  />
)}

{activeWorkspace === 'saved' && (
  <SavedRowsWorkspace
    rows={visibleRows}
    page={page}
  />
)}
```

### Reduce row-card CPU work

The saved row render calculates several things inside the render loop:

- `correctionSectionIdentity(row)`
- `assessSpeedLimitEvidence(row)`
- `buildSpeedLimitRecommendation({ ...row, conflict })`
- `buildCorrectionImpactPreview(mapTrips, ...)`
- `RoadSectionPreview`

For 10 rows per page this is acceptable, but it still competes with map section building. Memoize the prepared visible rows:

```js
const visibleRowModels = useMemo(() => visibleRows.map((row) => {
  const key = correctionKey(row);
  const conflict = conflictsByGeohash.get(key) || null;
  const draft = drafts[key] || {};
  return {
    key,
    row,
    conflict,
    draft,
    identity: correctionSectionIdentity(row),
    evidence: assessSpeedLimitEvidence(row),
    recommendation: buildSpeedLimitRecommendation({ ...row, conflict }),
    impact: buildCorrectionImpactPreview(mapTrips, {
      ...row,
      limitKmh: Number(draft.limitKmh || row.limitKmh),
      directionMode: draft.directionMode || row.directionMode,
      timeRule: timeRuleFromDraft(draft),
    }, draft.limitKmh || row.limitKmh),
  };
}), [conflictsByGeohash, drafts, mapTrips, visibleRows]);
```

Then render `visibleRowModels`. This makes the heavy work visible and easier to move later.

### Improve refresh behavior after edits

Several edit actions call `loadRows({ silent: true })` after recalculating matching trips. That is good because the page should not blank out. The doc-level rule is:

- Edits should optimistically update the visible row if possible.
- Background recalculation should use a status badge.
- Full row reload should be debounced and silent.
- The map model should refresh after row reload, but only once per burst of changes.

Current change event debounce:

```jsx
useEffect(() => {
  const onKnowledgeChanged = () => {
    window.clearTimeout(knowledgeReloadTimerRef.current);
    knowledgeReloadTimerRef.current = window.setTimeout(() => {
      loadRows({ silent: true });
    }, 80);
  };
  window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
  return () => {
    window.clearTimeout(knowledgeReloadTimerRef.current);
    window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
  };
}, [loadRows]);
```

The debounce is useful. Increase it to around 150 to 250 ms if bulk actions still produce jank.

## Whole App Page Audit

### Dashboard

Main files:

- `src/pages/Dashboard.jsx`
- `src/components/TripMap.jsx`
- `src/lib/trackingStore.js`

Current query:

```jsx
const { data: recentTrips = [], refetch } = useQuery({
  ...tripSummaryQueryOptions(),
});
```

`tripSummaryQueryOptions()` loads all local trip summaries:

```js
export const tripSummaryQueryOptions = () => ({
  queryKey: tripQueryKeys.summaries,
  queryFn: () => tripService.listAllSummaries({ sort: '-start_time' }),
  staleTime: 5 * 60 * 1000,
});
```

Risk:

- Dashboard uses all summaries when it may only need recent summaries for first paint.
- Active trip UI, maps, coaching, fatigue, route risk, and live alerts can all compute after the data arrives.

Recommended:

- First paint should use active trip state and latest 20 to 50 summaries.
- Expensive coaching/fatigue/route-risk sections should compute after summary cards render.
- The live active trip panel should never wait for history analysis.

Suggested split:

```js
const recentTripsQuery = useQuery({
  queryKey: ['dashboard-trip-summaries', 50],
  queryFn: () => tripService.listSummaries({ sort: '-start_time', limit: 50 }),
  staleTime: 2 * 60 * 1000,
});

const fullHistoryQuery = useQuery({
  queryKey: ['dashboard-full-history'],
  queryFn: () => tripService.listAllSummaries({ sort: '-start_time' }),
  enabled: recentTripsQuery.isSuccess,
  staleTime: 10 * 60 * 1000,
});
```

### Trip History

Main file:

- `src/pages/TripHistory.jsx`

Current query:

```jsx
const { data: trips = [], isLoading } = useQuery({
  ...tripSummaryQueryOptions(),
});
```

Current UI strengths:

- Uses skeleton cards.
- Uses `visibleCount` pagination.
- Has `aria-live` loading status.

Current CPU work:

```jsx
const sorted = useMemo(() => {
  const filtered = completed.filter((trip) => {
    if (!matchesQuickFilter(trip, filterBy)) return false;
    if (selectedTag !== 'all' && !normalizeTripTags(trip).includes(selectedTag)) return false;
    if (normalizedSearch) {
      const vehicle = vehicleById.get(String(trip.vehicle_id));
      if (!buildTripSearchText(trip, vehicle).includes(normalizedSearch)) return false;
    }
    return true;
  });
  // sort logic
}, [completed, filterBy, normalizedSearch, selectedTag, sortBy, vehicleById]);
```

Recommended:

- Debounce `search`.
- Keep skeletons, but preserve previous result list when a background refetch happens.
- Consider precomputing each trip search string once when summaries load.

Suggested search index:

```js
const tripSearchIndex = useMemo(() => new Map(
  completed.map((trip) => [
    trip.id,
    buildTripSearchText(trip, vehicleById.get(String(trip.vehicle_id))),
  ])
), [completed, vehicleById]);
```

### Map

Main files:

- `src/pages/MapScreen.jsx`
- `src/components/TripMap.jsx`

Current behavior:

```jsx
const { data: trips = [], isLoading: tripsLoading } = useQuery({
  queryKey: tripQueryKeys.map,
  queryFn: () => tripService.listSummaries({ sort: '-start_time', limit: 500 }),
  staleTime: 2 * 60 * 1000,
});
```

When no trip is selected, the page loads a limited number of full trip details for overview routes:

```jsx
const overviewTripsForMap = useMemo(
  () => selectedTripId ? [] : completed.slice(0, MAP_OVERVIEW_ROUTE_LIMIT),
  [completed, selectedTripId]
);

const overviewTripDetails = useQueries({
  queries: overviewTripsForMap.map((trip) => ({
    queryKey: tripQueryKeys.detail(trip.id),
    queryFn: () => tripService.getById(trip.id),
    staleTime: 2 * 60 * 1000,
  })),
});
```

Current UI strength:

```jsx
Drawing the most recent {overviewTripsForMap.length} routes first for a faster map. Select any trip below for the full route.
```

This is the right product behavior. Preserve it.

Risks:

- `useQueries` can still request several full trips at once.
- `TripMap` can draw many polylines and segments.
- Selecting route overlays can trigger map redraw and route detail loading.

Recommended:

- Keep overview detail limit low.
- Consider staggering detail queries or only loading overview details after map container is visible.
- Keep selected trip detail separate and higher priority than overview routes.

### Trip Detail

Main files:

- `src/pages/TripDetail.jsx`
- `src/components/TripMap.jsx`
- `src/components/TripPlayback.jsx`

Current query:

```jsx
const { data: trip, isLoading } = useQuery({
  queryKey: tripQueryKeys.detail(id),
  queryFn: () => tripService.getById(id),
});
```

Current UI strength:

- Uses skeletons while full trip detail loads.
- Lazy-loads map and playback.

Risk:

- Full trip detail can include route points, driving events, sensor summaries, metadata, and score details.
- Trip map and playback both process route points.

Recommended:

- Keep the top summary card renderable from cached summary data if available.
- Mount playback only when its section is visible or expanded.
- Avoid rendering both static map and playback at once on small devices unless the user opens playback.

### Speed Analysis

Main files:

- `src/pages/SpeedAnalysis.jsx`
- `src/components/TripPlayback.jsx`

Current strengths:

- Lazy-loads `TripPlayback`.
- Uses a page skeleton:

```jsx
if (isLoading) {
  return (
    <div className="space-y-4">
      <div className="h-10 w-40 animate-pulse rounded-xl bg-secondary/50" />
      <div className="h-96 animate-pulse rounded-3xl bg-secondary/50" />
    </div>
  );
}
```

Risk:

- Speed analytics are route-point heavy.
- Playback map can create many segment layers.

Recommended:

- Keep analytics summary visible before playback mounts.
- Load playback after user scrolls near it or taps a replay button on mobile.

### Reports

Main file:

- `src/pages/Report.jsx`

Current query:

```jsx
const { data: allTrips = [], isLoading } = useQuery({
  queryKey: ['report-trips'],
  queryFn: () => tripService.listAllSummaries({ sort: '-start_time' }),
});
```

Risks:

- Reports need broad history, so all summaries are reasonable.
- PDF/CSV/UBI exports should be explicit user actions and never run during page load.

Recommended:

- Keep all summaries as cached data.
- Use disabled buttons plus progress text for exports.
- Do not compute heavy PDF data until the user clicks export.

### Settings

Main files:

- `src/pages/Settings.jsx`
- `src/hooks/useLocalSettings.jsx`
- `src/lib/trackingStore.js`

Risk:

- Settings is a large page.
- It loads score migration summary, all trips, vehicles, privacy delete impact, calibration analysis, and settings search.

Current local settings hook:

```jsx
export default function useLocalSettings() {
  const [settings, setSettings] = useState(() => localSettings.get());

  useEffect(() => {
    const refresh = (event) => {
      const next = event?.detail?.settings || localSettings.get();
      setSettings((current) => (
        JSON.stringify(current) === JSON.stringify(next) ? current : next
      ));
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return settings;
}
```

Risk:

- `JSON.stringify` on every settings refresh can cost more as settings grows.
- All consumers re-render when any setting changes.

Recommended:

- Add a selector-based hook for hot paths.
- Keep the existing hook for simple pages.
- Treat freezing toggles, checkboxes, and check marks as a separate high-priority settings performance bug.

Suggested hook:

```js
export function useLocalSettingSelector(selector, isEqual = Object.is) {
  const [value, setValue] = useState(() => selector(localSettings.get()));

  useEffect(() => {
    const refresh = (event) => {
      const settings = event?.detail?.settings || localSettings.get();
      const next = selector(settings);
      setValue((current) => (isEqual(current, next) ? current : next));
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [isEqual, selector]);

  return value;
}
```

Example:

```js
const units = useLocalSettingSelector((settings) => settings.units || 'metric');
```

### Settings freezes, toggles, and check marks

User report on 2026-06-22: Settings interactions are also laggy or freezing, especially toggles and check marks. This matters because Settings is not just a read-only page; it contains high-frequency controls where the UI must respond immediately.

Likely causes:

1. A toggle calls `localSettings.update()` or another persistence path synchronously on the same interaction tick.
2. A setting change dispatches `SETTINGS_CHANGED_EVENT`, causing many settings subscribers to re-read and compare the full settings object.
3. The Settings page re-renders a very large component tree after every small checkbox/toggle change.
4. Expensive derived values such as settings search results, trip summaries, migration summaries, privacy delete impact, vehicles, calibration coverage, or report/export state recompute after unrelated setting changes.
5. Native settings sync, secure storage, or system logging runs too close to the input event.

Current broad settings hook:

```jsx
export default function useLocalSettings() {
  const [settings, setSettings] = useState(() => localSettings.get());

  useEffect(() => {
    const refresh = (event) => {
      const next = event?.detail?.settings || localSettings.get();
      setSettings((current) => (
        JSON.stringify(current) === JSON.stringify(next) ? current : next
      ));
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return settings;
}
```

Why this can freeze toggles:

- A tiny checkbox change can create a whole new settings object.
- The whole Settings page sees the new object.
- Any component using `useLocalSettings()` sees the entire object as changed.
- `JSON.stringify` itself can be non-trivial as settings grow.
- The browser may not paint the checked state until after persistence, event dispatch, and re-render work finish.

Recommended UX contract for toggles:

> The visible toggle/check mark should update immediately. Persistence, native sync, logging, and heavyweight recalculation should happen after the paint.

Preferred local toggle pattern:

```jsx
function SettingsToggle({ settingKey, label }) {
  const value = useLocalSettingSelector((settings) => settings[settingKey] === true);
  const [optimisticValue, setOptimisticValue] = useState(value);

  useEffect(() => {
    setOptimisticValue(value);
  }, [value]);

  const onChange = (nextValue) => {
    setOptimisticValue(nextValue);
    window.setTimeout(() => {
      localSettings.update({ [settingKey]: nextValue });
    }, 0);
  };

  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={optimisticValue}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
```

For app settings with security or native side effects, keep validation but still separate immediate UI feedback from slow side effects:

```js
const updateSettingAfterPaint = (patch) => {
  const run = () => localSettings.update(patch);
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.setTimeout(run, 0));
  } else {
    window.setTimeout(run, 0);
  }
};
```

Settings page refactor target:

- Split `Settings.jsx` into smaller memoized sections.
- Use selector hooks for individual settings.
- Keep local optimistic state for toggles and checkboxes.
- Debounce settings search input.
- Defer expensive impact calculations until the relevant section is visible.
- Do not load all trip history just because Settings opened.
- Do not recompute calibration/report/privacy impact for every toggle.

Example section split:

```jsx
const PrivacySettingsSection = memo(function PrivacySettingsSection() {
  const allowScreenCapture = useLocalSettingSelector(
    (settings) => settings.allow_screen_capture === true
  );

  return (
    <SettingsSwitch
      checked={allowScreenCapture}
      settingKey="allow_screen_capture"
      label="Allow screenshots"
    />
  );
});
```

Settings-specific Phase 0 measurement:

```js
const measureSettingToggle = (settingKey, callback) => {
  performance.mark(`settings.${settingKey}:start`);
  try {
    callback();
  } finally {
    requestAnimationFrame(() => {
      performance.mark(`settings.${settingKey}:paint`);
      performance.measure(
        `settings.${settingKey}.toPaint`,
        `settings.${settingKey}:start`,
        `settings.${settingKey}:paint`
      );
    });
  }
};
```

Acceptance criteria for Settings:

- Tapping a toggle visibly changes the switch/check mark in under 100 ms.
- The page does not freeze after changing a checkbox.
- Search typing stays responsive.
- Settings sections that are not visible do not perform trip-history or calibration work.
- Security-sensitive settings still persist and sync correctly after the immediate UI update.
- A failed persistence path reverts the optimistic value and shows a compact error.

### Vehicles, Achievements, Insights, Coach, Diagnostics, Privacy Intelligence

These pages mostly follow the same pattern:

- Use React Query or local effects.
- Render skeleton cards while loading.
- Compute summaries from trip history.

Recommended shared standard:

- Do not load full trip details unless the page needs route points or raw events.
- Keep summary cards visible during background refetch.
- Use skeletons that match final card sizes.
- Use a short inline refresh indicator for stale data refresh.

## Local Storage and Repository Behavior

### Trip service

The trip service chooses local storage on native platforms or when no API URL is configured:

```js
export const shouldUseLocalStore = () => isNativePlatform() || !API_BASE_URL;

const repository = () => (shouldUseLocalStore() ? localTripRepository : null);
```

Summary and detail paths are separate:

```js
listSummaries: async ({ sort = "-start_time", limit = 100 } = {}) => {
  const local = repository();
  const trips = local
    ? await local.listSummaries({ sort, limit })
    : await apiClient.get("/trips", { query: { sort, limit } });
  return trips.map(buildTripSummary);
},

getById: (id) => {
  const local = repository();
  return local ? local.getById(id) : apiClient.get(`/trips/${encodeURIComponent(id)}`);
},
```

The performance rule is:

> Use summaries for page lists and dashboards. Use full details only for selected trips, maps, playback, exports, and recalculation.

### Local repository

The local repository already has summary-specific methods:

```js
async listSummaries({ sort = '-start_time', limit = 100 } = {}) {
  await importNativeCompletedTrips();
  return sortTrips(await getAllTripSummaries(), sort).slice(0, limit);
},

async listAllSummaries({ sort = '-start_time' } = {}) {
  await importNativeCompletedTrips();
  return sortTrips(await getAllTripSummaries(), sort);
},

async list({ sort = '-start_time', limit = 100 } = {}) {
  await importNativeCompletedTrips();
  await pruneExpiredTrips();
  await migrateRetiredTripEventTypesOnce();
  const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
  const trips = await rescoreTripsIfNeeded(taggedTrips);
  return sortTrips(trips, sort).slice(0, limit);
},
```

`list()` is much heavier than `listSummaries()` because it can prune, migrate, tag, rescore, and read full trip geometry. Avoid `list()` on first paint unless route points are absolutely required.

## Map Rendering Guidance

### Current TripMap behavior

`TripMap` reduces route point counts before rendering:

```jsx
const maskedRoutes = routeSets.map((route) => ({
  ...route,
  route_points: injectTimestampGapMarkers(prepareMapRoutePoints(
    maskRoutePointsForPrivacy(route.route_points || [], settings),
    { maxPoints: route.selected ? 900 : 450 }
  )).map(validLatLngPoint).filter(Boolean),
})).filter((route) => route.route_points.length > 1);
```

This is a good protection. Keep it.

Risk remains in layer creation:

```jsx
speedSegments.forEach((segment) => {
  window.L.polyline(
    [[from.lat, from.lng], [to.lat, to.lng]],
    {
      color,
      weight: route.selected ? 6 : 4,
      opacity: route.opacity,
      smoothFactor: 1.5,
      lineCap: 'round',
      lineJoin: 'round',
    }
  )
    .on('click', () => {
      if (segment.band) setSelectedSegment(displaySegment);
    })
    .addTo(layers);
});
```

Creating hundreds of Leaflet polylines is expensive. Use fewer segments for overview mode, and use detailed segment layers only for selected/focused trips.

### SpeedLimitEditorMap label cap

The saved speed map caps permanent labels:

```js
const MAX_PERMANENT_LABELS = 80;

const permanentLabelKeys = useMemo(() => {
  if (!sections.length) return new Set();
  const prioritized = [...sections].sort((a, b) => {
    const score = (section) => (
      (section.conflict ? 4 : 0) +
      (section.saved ? 3 : 0) +
      (Number(section.effectiveLimitKmh ?? section.limitKmh ?? section.observedLimitKmh) > 0 ? 1 : 0)
    );
    return score(b) - score(a);
  });
  return new Set(prioritized.slice(0, MAX_PERMANENT_LABELS).map(sectionKey));
}, [sections]);
```

This is good. If the map still janks, reduce this on mobile:

```js
const maxPermanentLabels = isMobile ? 30 : 80;
```

### Avoid automatic fit on every filter change

Fit bounds is useful on first load and when the selected trip changes. It can be annoying and expensive when the user is typing or toggling layers.

Recommended:

```js
const fitKey = selectedGeohash || (initialFitDone ? '' : sections.map(sectionKey).join('|'));

useEffect(() => {
  if (!fitKey) return;
  // fit once for initial load or selection
}, [fitKey, mapReady]);
```

Or expose a "Fit visible" button and stop fitting on every section change after initial load.

## Loading Components to Standardize

Add small shared components so pages feel consistent.

### Page skeleton

```jsx
export function PageSkeleton({ title = true, cards = 3, map = false }) {
  return (
    <div className="space-y-4" aria-label="Loading page">
      {title && <div className="h-9 w-48 rounded-xl bg-secondary/50 animate-pulse" />}
      {map && <div className="h-[22rem] rounded-2xl bg-secondary/50 animate-pulse" />}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: cards }).map((_, index) => (
          <div key={index} className="h-28 rounded-2xl bg-secondary/50 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
```

### Inline refresh badge

```jsx
export function InlineRefreshBadge({ label = 'Refreshing' }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      {label}
    </div>
  );
}
```

### Error with retry

```jsx
export function InlineLoadError({ message, onRetry }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
      <div className="font-semibold">Could not load this section.</div>
      <div className="mt-1">{message}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white">
          Try again
        </button>
      )}
    </div>
  );
}
```

## Measurement Plan

Do not optimize by feel alone. Add lightweight marks around suspected slow paths.

### Performance marks

```js
const measureAsync = async (name, callback) => {
  performance.mark(`${name}:start`);
  try {
    return await callback();
  } finally {
    performance.mark(`${name}:end`);
    performance.measure(name, `${name}:start`, `${name}:end`);
    const entry = performance.getEntriesByName(name).at(-1);
    console.info(`[perf] ${name}: ${Math.round(entry.duration)}ms`);
  }
};
```

Use it on the saved speed page:

```js
const trips = await measureAsync('speedLimits.loadMapTrips', () => (
  tripService.list({ sort: '-start_time', limit: 500 })
));

const sections = await measureAsync('speedLimits.buildMapSections', () => (
  Promise.resolve(buildSpeedMapSections(trips, rows))
));
```

Use it in the map:

```js
performance.mark('speedMap.draw:start');
sections.forEach(addSection);
performance.mark('speedMap.draw:end');
performance.measure('speedMap.draw', 'speedMap.draw:start', 'speedMap.draw:end');
```

### Manual test matrix

Test with:

- 0 trips, 0 saved speeds.
- 10 trips, 5 saved speeds.
- 100 trips, 25 saved speeds.
- 500 trips, 100 saved speeds.
- A trip with dense route points.
- Offline mode.
- Android device after cold app launch.
- Android resume after the app has been backgrounded for more than 5 minutes.
- Saved road speeds opened directly from `/speed-limits?view=saved`.
- Saved road speeds opened from a trip context with `?tripId=...`.

### Targets

These are practical targets for a smooth mobile feel:

| Action | Target |
| --- | ---: |
| App shell first visible | under 1.5 seconds on a mid-range Android device |
| Route shell transition | under 300 ms after code chunk is cached |
| Saved speed rows visible | under 700 ms with normal local data |
| Saved speed map skeleton visible | immediately after rows |
| Speed map first useful draw | under 2 seconds for 500 trips |
| Typing in filters | no visible dropped input characters |
| Switching workspaces | under 150 ms if data is already loaded |

## Implementation Plan

### Phase 0: incident triage

Do this first when the whole app feels laggy.

1. Add temporary performance marks around app bootstrap, route logging, `tripSummaryQueryOptions()`, `tripService.list()`, `tripService.listAllSummaries()`, `TripMap` draw, `SpeedLimitEditorMap` draw, and `buildSpeedMapSections()`.
2. Open Dashboard, Trip History, Map, Saved road speeds, Settings, and Trip Detail on the same device and record the slowest mark for each page.
3. Temporarily disable map mounting on Saved road speeds and Map overview. If the app becomes responsive, prioritize map rendering and full-trip loading fixes.
4. Temporarily replace `tripSummaryQueryOptions()` usage on Dashboard with `tripService.listSummaries({ limit: 50 })`. If Dashboard becomes responsive, prioritize limited first-paint queries.
5. Move route logging and non-critical resume work behind `requestIdleCallback`.
6. Do not start major UI redesign work until the top two measured blockers are known.

Emergency code to prove whether route logging is contributing:

```jsx
function RouteLogger() {
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const payload = {
      pathname: location.pathname,
      has_search: Boolean(location.search),
      search_param_keys: [...params.keys()].slice(0, 20),
    };
    const run = () => recordSystemEvent('route_changed', payload, {
      title: 'Page opened',
      category: 'navigation',
    });
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      window.setTimeout(run, 250);
    }
  }, [location.pathname, location.search]);

  return null;
}
```

Emergency code to prove whether all-summary first paint is contributing:

```jsx
const { data: recentTrips = [], isLoading } = useQuery({
  queryKey: ['dashboard-trip-summaries', 50],
  queryFn: () => tripService.listSummaries({ sort: '-start_time', limit: 50 }),
  staleTime: 2 * 60 * 1000,
});
```

### Phase 1: quick UI wins

1. Replace `Loading saved speeds...` with a layout-matching skeleton.
2. Add `loadedOnce` and `refreshing` state to Saved road speeds so silent refreshes never blank content.
3. Debounce `mapQuery` and `rowQuery`.
4. Show a separate "Building map..." or "Refreshing map..." badge when full trip data is loading.
5. Avoid mounting the map workspace when the user is on Saved roads.
6. Keep the shared layout visible during page-level loading.
7. Add compact inline refresh badges instead of replacing full sections during background refetch.

### Phase 2: Saved road speeds data split

1. Split `loadRows()` into `loadSpeedRows()` and `loadSpeedMapModel()`.
2. Start map model loading after rows render.
3. Refresh map model only when rows change or when the user opens a map-dependent workspace.
4. Memoize visible row models.
5. Keep `buildCorrectionImpactPreview()` out of collapsed row details where possible.

### Phase 3: map rendering improvements

1. Stop fitting map bounds on every filter/layer change.
2. Add a "Fit visible" control for manual fit after initial load.
3. Reduce permanent labels on mobile.
4. Limit detailed layers to selected or high-priority sections.
5. Consider worker-based `buildSpeedMapSections()`.

### Phase 4: whole-app cleanup

1. Replace first-paint `listAllSummaries()` with smaller `listSummaries()` where the page does not need full history immediately.
2. Add background full-history queries only for analytics panels.
3. Add selector-based settings hooks for hot components.
4. Standardize page skeleton, inline refresh, and load error components.
5. Add performance marks behind a development flag.
6. Add a small performance regression checklist to future PRs that touch trip loading, map drawing, app bootstrap, settings, or storage maintenance.

## Acceptance Criteria

Incident triage is complete when:

- At least two measured slow paths are identified with timing numbers.
- One temporary disable test has confirmed or ruled out map rendering as the top cause.
- One limited-query test has confirmed or ruled out all-summary loading as the top cause.
- App resume is measured separately from cold launch.
- A narrow first fix can be chosen without guessing.

Saved road speeds should feel fixed when:

- The page header and workspace controls show quickly.
- Saved rows appear before map trip analysis finishes.
- The map area shows a proper skeleton or progress state while building.
- Switching to Saved roads does not wait for map data.
- Editing one speed does not blank the page.
- Bulk operations refresh rows silently and show clear status.
- Typing in search fields remains responsive.
- Map filters do not constantly jump the viewport.
- Offline mode still clearly shows saved data and explains missing tiles.

The whole app should feel fixed when:

- Navigation keeps the shell stable.
- Heavy charts, maps, and diagnostics do not block the page title and primary actions.
- Previous content remains visible during background refresh.
- Every long operation has a visible but compact status.
- Full trip detail is only loaded for selected trips or explicit exports.
