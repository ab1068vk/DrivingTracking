# Manual Start Trip Discarded As No Real Movement

Created: 2026-06-15

## Summary

Manual trip start is still failing for at least one real-world Android drive. The user tapped **Start Trip**, did not close the app, drove, then tapped **End Trip**. The app discarded the trip with this message:

```text
Trip was not saved because Road Sage did not detect real movement. Start again when you begin driving.
```

This means the Start Trip button did create an active trip, but by the time End Trip ran, the active trip did not contain enough accepted movement evidence to pass the manual-trip save gate.

Additional symptoms reported for the same manual-tracking area:

- A manual trip once saved, but the map route line was a straight line instead of following roads.
- It is unclear whether pressing Start Trip and then fully closing the app should keep tracking.
- One successful run showed an impossible-looking `250 km` value, either speed or distance.

## Severity

- Severity: High
- User impact: Real manual drives can be lost.
- Data impact: The active trip is cleared after discard, so unsaved route evidence is not available from normal trip history.
- Affected mode: Manual tracking, especially Android foreground tracking.
- Reported condition: App was not closed during the drive.

## Exact User-Visible Failure

1. User taps **Start Trip**.
2. Dashboard switches into active tracking state.
3. User drives with the app still open.
4. User taps **End Trip**.
5. Dashboard runs the manual save review.
6. Manual save review returns `manual_no_movement_evidence`.
7. Dashboard clears the active trip and shows the no-real-movement message.

## Important Clarification

"The app was not closed" is not sufficient evidence that the foreground GPS watcher stayed alive. In manual mode, this app starts the foreground Capacitor/Web geolocation watcher, not the Android native auto-tracking service, unless background tracking is enabled. On Android, GPS updates may still stop or become sparse if the app is backgrounded, the screen is locked, permissions are changed, battery optimization intervenes, or the WebView/geolocation provider fails to deliver usable points.

## Should Manual Tracking Continue After The App Is Fully Closed?

Current expected behavior depends on what "closed" means:

- If the app stays open in the foreground, manual tracking should keep collecting GPS points.
- If the user leaves the app but the app process remains alive, foreground manual tracking may be unreliable unless background tracking is enabled.
- If the user fully closes/swipes away/force-stops the app process, plain manual foreground tracking should not be assumed to continue.
- If Android background/native tracking is enabled, a foreground service exists and can continue while the app UI is not visible, but that is the background/auto-tracking path, not the normal manual-only foreground path.
- If Android kills the service or the user force-stops the app, even native tracking can be stopped by the OS.

Manual Start Trip currently calls `createDrivingTrackingService()` from the web/Capacitor layer. It only uses the background geolocation plugin when `background_tracking_enabled` is true or tracking mode is `background_auto`.

```jsx
const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
if (!locationService.current) {
  locationService.current = createDrivingTrackingService({
    background: useBackground,
    privateMode: isPrivateTrip(activeTripRef.current),
  });
}
```

The Android manifest does declare foreground/background location services:

```xml
<service
    android:name="com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService"
    android:exported="false"
    android:foregroundServiceType="location" />

<service
    android:name=".DriveSenseAutoTrackingService"
    android:enabled="true"
    android:exported="false"
    android:foregroundServiceType="location" />

<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
```

The native auto-tracking service is sticky when started:

```java
return START_STICKY;
```

But on destroy it ends its active trip:

```java
@Override
public void onDestroy() {
    finishTrip("service_destroyed", false);
    removeActivityUpdates();
    stopLocationUpdates();
    stopMotionSensors();
    DriveSenseNativeTripStore.setServiceEnabled(this, false);
    super.onDestroy();
}
```

Conclusion: if the product requirement is "manual trip keeps tracking even after the user fully closes the app", manual Start Trip needs to explicitly start a native foreground/background manual-trip service, not only a foreground WebView GPS watcher.

## Source Files Involved

- `src/pages/Dashboard.jsx`
  - Manual start handler.
  - Active trip state writes.
  - GPS point append path.
  - End trip save/discard decision.
- `src/lib/trackingService.js`
  - Foreground/background geolocation watcher setup.
  - Initial point capture.
  - Point normalization and pre-filtering.
- `src/lib/tripEngine.js`
  - Location point normalization.
  - Location acceptance filter.
  - Route cleaning.
  - Distance, duration, and max-speed calculation.
- `src/lib/scoringConstants.js`
  - Minimum trip and GPS-quality thresholds.
- `src/components/TripMap.jsx`
  - Route line rendering.
  - Segment splitting for tracking gaps.
- `src/lib/mapPlaybackInsights.js`
  - Visual map route filtering, smoothing, downsampling, and playback telemetry.
- `src/lib/trackingDiagnostics.js`
  - Diagnostic events that should show the save/discard path.
- `src/pages/Diagnostics.jsx`
  - UI for tracking diagnostics.
- `src/pages/SystemLogs.jsx`
  - Exportable logs including diagnostics.

## Start Trip Code Path

Manual start is handled in `src/pages/Dashboard.jsx`. A non-auto trip gets `start_source: 'manual'`, `trip_state: ConfirmedTrip`, and an initially empty route unless an initial point was supplied.

```jsx
const tripData = {
  start_time: startTime,
  status: 'active',
  trip_state: candidate ? TRIP_STATES.CANDIDATE : TRIP_STATES.CONFIRMED,
  route_points: storedInitialPoint ? [storedInitialPoint] : [],
  driving_events: [],
  background_tracking: useBackground,
  start_source: autoStarted ? 'auto' : 'manual',
};

activeTripStore.set(tripData);
activeTripRef.current = tripData;
trackingRef.current = true;
setActiveTrip(tripData);
setTracking(true);
startTimer(new Date(startTime));
startGPS();
```

The diagnostic event for a successful manual start is:

```jsx
recordTrackingDiagnostic({
  type: 'trip_started',
  title: autoStarted ? 'In-app auto trip started' : 'Manual trip started',
  reason: autoStarted ? 'auto_detection' : 'manual_button',
  trip_state: TRIP_STATES.CONFIRMED,
  background_tracking: useBackground,
});
```

## GPS Recording Code Path

`Dashboard.startGPS()` creates `createDrivingTrackingService()` and appends every accepted point to `route_points`.

```jsx
const startGPS = useCallback(() => {
  const cfg = localSettings.get();
  const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
  if (!locationService.current) {
    locationService.current = createDrivingTrackingService({
      background: useBackground,
      privateMode: isPrivateTrip(activeTripRef.current),
    });
  }
  locationService.current.start(
    async (point) => {
      setCurrentLocation(point);
      setLocationError(null);
      if (endingTripRef.current || !trackingRef.current || !activeTripRef.current) return;

      const tripBeforePoint = activeTripRef.current;
      const storedPoint = redactRoutePointForPrivacyStorage(point, latestPrivacyZones);
      const routePointsWithLatest = [...(tripBeforePoint?.route_points || []), storedPoint];

      const updated = { ...tripBeforePoint, route_points: routePointsWithLatest };
      activeTripStore.set(updated);
      activeTripRef.current = updated;
      setActiveTrip(updated);
    },
    handleLocationTrackingError
  );
}, [handleLocationTrackingError, promoteCandidateTrip]);
```

If the trip later fails as no real movement, one of these was probably true:

- `startGPS()` did not actually start the watcher.
- The watcher started but never emitted points after the first fix.
- Points were emitted but rejected before reaching `Dashboard`.
- Points were appended but later cleaned out as noisy/inaccurate.
- The drive had points but computed distance remained below the save threshold and no sparse-GPS speed fallback was satisfied.

## Tracking Service Code Path

The tracking service requests permission, emits one initial point, then starts a watcher.

```js
export function createDrivingTrackingService({ background = false, privateMode = false } = {}) {
  let watcherId = null;
  let webWatcherId = null;
  let previousPoint = null;

  const emitPoint = (rawPoint, onPoint) => {
    const point = normalizeLocationPoint(rawPoint);
    if (!shouldAcceptLocationPoint(point, previousPoint)) return;
    const segment = calculateSegmentMetrics(previousPoint, point);
    const normalizedPoint = previousPoint
      ? {
          ...point,
          speed_kmh: segment.reliableSpeedKmh,
          ...(segment.dt > ROUTE_GAP_SECONDS ? { tracking_gap: true } : {}),
        }
      : { ...point, speed_kmh: point.speed_kmh != null && point.speed_kmh >= 5 ? point.speed_kmh : 0 };
    previousPoint = normalizedPoint;
    onPoint(normalizedPoint);
  };
```

Foreground Android uses Capacitor Geolocation:

```js
if (isNativePlatform()) {
  watcherId = await Geolocation.watchPosition(watchOptions, (position, error) => {
    if (error) {
      logSystemFailure('native_location_watcher', error, { code: error.code });
      onError?.({ message: error.message || 'Location failed', code: error.code });
      return;
    }
    emitPoint(position, onPoint);
  });
  recordSystemEvent('tracking_service_started', {
    background_tracking: false,
    native_platform: true,
  }, { category: 'background', source: 'native', title: 'Tracking service started' });
  return;
}
```

Background mode uses the community background geolocation watcher with `distanceFilter: 5`, but manual foreground mode does not use this branch unless background tracking is enabled.

## Manual Map Route Code Path

The map does not independently reconstruct the road route. It draws the saved `route_points`. If only a few points were stored, the visual line will connect those points directly.

`TripMap` prepares points and determines whether a route exists:

```jsx
const selectedRoutePoints = useMemo(
  () => prepareMapRoutePoints(selectedRoute.route_points || [], { maxPoints: null, smooth: smoothRoute }),
  [selectedRoute, smoothRoute]
);
const telemetry = useMemo(() => routeTelemetry(selectedRoutePoints), [selectedRoutePoints]);
const hasRoute = telemetry.pointCount > 1;
```

Before drawing, it masks privacy zones, prepares map points, and filters out routes with fewer than two points:

```jsx
const validRoutes = routeSets
  .map((route) => {
    const maskedPoints = maskRoutePointsForPrivacy(route.route_points || [], privacySettings);
    return {
      ...route,
      route_points: prepareMapRoutePoints(maskedPoints, {
        maxPoints: route.selected ? 900 : 450,
        smooth: smoothRoute,
      }),
    };
  })
  .filter((route) => route.route_points.length > 1);
```

The route is then split only at explicit tracking gaps or gaps over two minutes:

```jsx
const isRouteGapSegment = (prev, curr) => {
  if (!prev || !curr) return false;
  if (curr.tracking_gap === true || curr.route_gap === true) return true;
  const prevMs = timeMs(prev.timestamp ?? prev.time);
  const currMs = timeMs(curr.timestamp ?? curr.time);
  return prevMs != null && currMs != null && currMs > prevMs &&
    (currMs - prevMs) / 1000 > ROUTE_GAP_SECONDS;
};
```

Leaflet draws each segment as a polyline:

```jsx
window.L.polyline(segmentLatLngs, {
  color: '#0f172a',
  weight: route.selected ? 9 : 6,
  opacity: route.selected ? 0.18 : 0.10,
  smoothFactor: 1.5,
  lineCap: 'round',
  lineJoin: 'round',
}).addTo(layers);
```

Therefore a straight map line can happen when:

- The trip has only two accepted GPS points.
- There are many missing samples between two accepted points but no `tracking_gap` marker.
- Map matching is disabled or has not been manually requested.
- OSRM map matching is unavailable, not configured, or blocked by consent/privacy rules.
- GPS jumps were not filtered from the visual route.
- Privacy masking removed intermediate coordinates.

This is expected rendering behavior for sparse geometry, but it is not good trip-tracking behavior. A real manual trip should record enough points that the route follows the driven path, or it should mark gaps so the map does not draw one misleading continuous line.

## Map Matching Is Not Automatic For Manual Trips

The saved route is the raw/sanitized GPS polyline unless map matching is later requested. The app stores map matching status as `manual_required` when OSRM could be used but was not run automatically.

```jsx
const mapMatchingContext = {
  provider: 'osrm',
  status: cfg.map_matching_enabled !== false &&
    cfg.osrm_map_matching_url &&
    cfg.osrm_data_sharing_consented === true ? 'manual_required' : 'disabled',
  confidence: null,
  snapped_coverage: 0,
  isOsrmDemoUrl: isPublicOsrmDemoUrl(cfg.osrm_map_matching_url),
};
```

This means "straight line instead of following roads" can be a recording problem, a map-matching-not-run problem, or both.

## Location Acceptance Filters

Before a location becomes a route point, it must pass `shouldAcceptLocationPoint()`.

```js
export function shouldAcceptLocationPoint(point, previousPoint = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!point || !hasValidCoordinates(point)) return false;
  if (point.accuracy != null && point.accuracy > thresholds.MAX_GPS_ACCURACY_M) return false;
  if (Number.isFinite(Number(point.speed_kmh)) && Number(point.speed_kmh) > MAX_REASONABLE_GPS_SPEED_KMH) return false;
  if (Number.isFinite(Number(point.obd_speed_kmh)) && Number(point.obd_speed_kmh) > MAX_REASONABLE_OBD_SPEED_KMH) return false;
  if (!previousPoint) return true;

  const dt = (new Date(point.timestamp).getTime() - new Date(previousPoint.timestamp).getTime()) / 1000;
  if (dt <= 0) return false;

  const segment = calculateSegmentMetrics(previousPoint, point, thresholds);
  if (segment.isNoise && dt < 45) return false;

  const impliedSpeed = segment.impliedSpeedKmh;
  const reportedSpeed = segment.reportedSpeedKmh ?? impliedSpeed;
  if (impliedSpeed > MAX_REASONABLE_GPS_SPEED_KMH || reportedSpeed > MAX_REASONABLE_GPS_SPEED_KMH) return false;

  return true;
}
```

Relevant constants:

```js
MIN_TRIP_DISTANCE_KM: 0.1,
MIN_TRIP_DURATION_SECONDS: 30,
MAX_GPS_ACCURACY_M: 50,
MIN_POINT_DISTANCE_M: 8,
MIN_TRUSTED_SPEED_KMH: 18,
STATIONARY_SPEED_KMH: 5,
```

This matters because real driving can still produce rejected samples when:

- Android reports accuracy worse than 50 m.
- GPS samples are duplicated or timestamped out of order.
- Distance between updates is below the noise floor.
- Reported speed says stationary and displacement also looks stationary.
- The watcher only provides one accepted point.

## Impossible 250 km / 250 km/h Values

The reported `250 km` symptom needs to be captured exactly in the next reproduction because it could mean either:

- `250 km/h` speed, which indicates a GPS speed/jump spike or OBD-speed sample.
- `250 km` distance, which indicates one or more long-distance GPS jumps were counted or displayed.

The JavaScript trip engine currently rejects GPS samples above 220 km/h and OBD speed above 260 km/h:

```js
const MAX_REASONABLE_GPS_SPEED_KMH = 220;
const MAX_REASONABLE_OBD_SPEED_KMH = 260;

if (Number.isFinite(Number(point.speed_kmh)) && Number(point.speed_kmh) > MAX_REASONABLE_GPS_SPEED_KMH) return false;
if (Number.isFinite(Number(point.obd_speed_kmh)) && Number(point.obd_speed_kmh) > MAX_REASONABLE_OBD_SPEED_KMH) return false;
```

The Android native service also rejects implied or reported speeds above 220 km/h:

```java
private static final double MAX_SPEED_KMH = 220d;

if (impliedSpeed > MAX_SPEED_KMH || reportedSpeed > MAX_SPEED_KMH) continue;
```

The map playback layer uses a separate visual filter:

```js
const MAX_VISUAL_SPEED_KMH = 230;
const MAX_SEGMENT_JUMP_SPEED_KMH = 240;

if (Number.isFinite(point.speed_kmh) && point.speed_kmh > MAX_VISUAL_SPEED_KMH) return false;
if (impliedSpeedKmh > MAX_SEGMENT_JUMP_SPEED_KMH && !reportedAllowsJump) return false;
```

Known risk: the visual map layer allows a large jump if the reported speed is above 120 km/h:

```js
const reportedAllowsJump = reportedSpeed != null && reportedSpeed > 120;
if (impliedSpeedKmh > MAX_SEGMENT_JUMP_SPEED_KMH && !reportedAllowsJump) return false;
```

That can explain a straight or very long line when GPS reports a high speed and the coordinates jump. It should be reviewed because a reported high speed should not automatically make a giant coordinate jump visually trustworthy.

Stats distance is calculated only for segments with `dt <= 120` and `!segment.isNoise`:

```js
function calculateRouteDistanceKm(points = [], thresholds = DEFAULT_THRESHOLDS) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt > 0 && segment.dt <= 120 && !segment.isNoise) distance += segment.distanceKm;
  }
  return distance + calculateEstimatedPrivateDistanceKm(points, { includeAdjacentBoundaries: false });
}
```

Action needed: add a trip anomaly diagnostic when any accepted segment implies speed above 160 km/h, distance above a realistic per-sample threshold, or route jump distance is far larger than reported speed permits.

## End Trip Save Gate

When the user taps **End Trip**, `handleEndTrip()` calculates preliminary stats and then calls `reviewManualTripSave()` for manual trips.

```jsx
const preliminaryStats = calculateTripStats(cleanedPoints, tripToEnd.start_time, endTime, thresholds);

const isManualTrip = tripToEnd.start_source !== 'auto';
const manualSaveReview = isManualTrip
  ? reviewManualTripSave({
    points: cleanedPoints,
    stats: preliminaryStats,
    startTime: tripToEnd.start_time,
    endTime,
    thresholds,
  })
  : null;
const shouldDiscard = isManualTrip
  ? !manualSaveReview.shouldSave
  : preliminaryStats.distance_km < DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM ||
    preliminaryStats.duration_seconds < DEFAULT_THRESHOLDS.MIN_TRIP_DURATION_SECONDS;
```

The manual save review is:

```jsx
function reviewManualTripSave({ points = [], stats = {}, startTime, endTime, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const wallClockSeconds = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 1000))
    : 0;
  const durationSeconds = Math.max(Number(stats.duration_seconds) || 0, wallClockSeconds);
  const distanceKm = Number(stats.distance_km) || 0;
  const coordinatePoints = (points || []).filter((point) => hasUsableCoordinates(point, thresholds));
  const movingSpeedSamples = coordinatePoints.filter((point) => (
    Number(point?.speed_kmh) >= MANUAL_SPARSE_GPS_MIN_SPEED_KMH
  ));

  if (durationSeconds < MIN_MANUAL_SAVE_SECONDS) {
    return { shouldSave: false, reason: 'manual_duration_too_short' };
  }

  if (distanceKm >= DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM) {
    return { shouldSave: true, reason: 'manual_distance_confirmed' };
  }

  if (
    durationSeconds >= MANUAL_SPARSE_GPS_MIN_SECONDS &&
    coordinatePoints.length >= 2 &&
    (
      movingSpeedSamples.length >= 2 ||
      Number(stats.max_speed_kmh) >= MANUAL_SPARSE_GPS_MIN_SPEED_KMH
    )
  ) {
    return { shouldSave: true, reason: 'manual_sparse_gps_vehicle_speed' };
  }

  return { shouldSave: false, reason: 'manual_no_movement_evidence' };
}
```

Manual save succeeds only if:

- Duration is at least 30 seconds, and
- Either calculated distance is at least 0.1 km, or
- Sparse GPS fallback passes with at least two usable coordinate points and vehicle-speed evidence of at least 10 km/h.

The reported failure specifically means:

```js
manualSaveReview = { shouldSave: false, reason: 'manual_no_movement_evidence' }
```

## Discard Branch

The discard branch records diagnostics, clears the active trip, resets UI state, and shows the error.

```jsx
if (shouldDiscard) {
  recordTrackingDiagnostic({
    type: 'trip_discarded',
    title: 'Trip discarded',
    reason: isManualTrip ? manualSaveReview.reason : 'auto_too_short',
    duration_seconds: Math.round(preliminaryStats.duration_seconds || 0),
    distance_km: preliminaryStats.distance_km || 0,
  });
  await activityStopRef.current?.();
  activityStopRef.current = null;
  latestActivityRef.current = null;
  activeTripStore.clear();
  await activeTripStore.flush();
  activeTripRef.current = null;
  trackingRef.current = false;
  setActiveTrip(null);
  setTracking(false);
  setElapsed(0);
  refreshTrackingStatusContext();
  setLocationError(isManualTrip
    ? 'Trip was not saved because Road Sage did not detect real movement. Start again when you begin driving.'
    : 'Auto-detected trip was ignored because it was too short.');
  return;
}
```

## Most Likely Failure Points

### 1. Foreground watcher started, but Android stopped delivering usable GPS

Manual foreground tracking uses `Geolocation.watchPosition()`. If the screen locked, the app was backgrounded, Android restricted location, or battery optimization paused the WebView, the watcher may have produced too few points.

Evidence to look for:

- System log: `tracking_service_started` with `source: native`.
- No matching stream of route-point growth during the drive.
- Final diagnostic: `trip_discarded` with `reason: manual_no_movement_evidence`, low `distance_km`, and low route point count.

### 2. GPS points were rejected for accuracy or noise

Any point with `accuracy > 50` is rejected before storage. Real drives in poor GPS conditions can get filtered out.

Evidence to look for:

- System logs around `native_location_watcher`.
- Diagnostics showing `route_points_raw_count` and `route_points_clean_count` very low.
- No explicit rejected-point diagnostic currently exists, so this may require added instrumentation.

### 3. Only one accepted point was stored

`calculateTripStats()` returns zero distance and max speed when fewer than two valid route points exist.

```js
if (!routePoints || routePoints.length < 2) {
  return {
    distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
    avg_speed_kmh: 0,
    max_speed_kmh: 0,
    duration_seconds: Math.round(wallClockDurationSeconds),
  };
}
```

This will fail the manual save gate unless sparse GPS fallback has at least two usable coordinate points and speed evidence.

### 4. Points exist, but distance was filtered as noise

`calculateSegmentMetrics()` can mark segments as noise if movement is below the GPS noise floor or the reported speed/displacement combination looks stationary.

```js
const tinyMovement = distanceM < noiseFloorM;
const displacementSaysStill = impliedSpeedKmh < stationarySpeed && distanceM < noiseFloorM * 1.5;
const reportedDisagreesWithDisplacement = reportedSpeedKmh != null &&
  reportedSpeedKmh < trustedSpeed &&
  displacementSaysStill;
const isNoise = tinyMovement || reportedDisagreesWithDisplacement;
```

### 5. Manual mode is being treated like foreground-only tracking

The settings defaults are:

```js
tracking_mode: 'manual',
background_tracking_enabled: false,
auto_tracking_enabled: false,
```

Manual foreground tracking should work while the app is truly foregrounded, but it is not as resilient as background/native tracking for real-world driving.

### 6. Map route is drawn from sparse points

If a saved manual trip contains only a start point and an end point, TripMap will draw a straight polyline between them. That is not evidence that map rendering is broken by itself. It is evidence that route point capture was too sparse or that gaps were not marked.

Evidence to look for:

- `route_points_raw_count` is very low.
- `route_points_map_count` is very low.
- The saved trip has no `tracking_gap` markers even though timestamps jump by more than expected.
- Map matching context is `manual_required` or `disabled`.

### 7. GPS jump or bad speed sample produced an impossible route/speed

If the app displayed `250 km/h` or `250 km`, the route may include a bad GPS jump, a high reported-speed sample, or an OBD-speed value. The JS/native stats filters reject many impossible samples, but visual map filtering and stats filtering are separate. A bad point might affect the map even if it is excluded from stats, or it might survive if its reported speed looks plausible enough under current thresholds.

Evidence to look for:

- A pair of consecutive points with a very large coordinate jump.
- Segment implied speed above 160 km/h, 220 km/h, or 240 km/h.
- Point `speed_kmh` near 220-230.
- Point `obd_speed_kmh` near 250-260.
- `tracking_gap` missing on a long time gap.
- Map playback telemetry differs from saved trip `distance_km`.

## Existing Diagnostics To Collect

Use these immediately after reproducing the failure, before clearing logs:

1. Open **Diagnostics**.
2. Refresh diagnostics.
3. Capture the recent event list, especially:
   - `trip_started`
   - `ending_review`
   - `trip_discarded`
   - any `location_permission_lost`
   - any native diagnostics from Android
4. Open **System Logs**.
5. Export JSON or CSV.
6. Look for:
   - `tracking_service_started`
   - `tracking_service_stopped`
   - `native_location_watcher`
   - `tracking_initial_location`
   - `permission_request_foreground_location`
   - `document_visibility`
   - `page_hidden`
   - `page_unloading`

## Missing Diagnostics

The current code does not appear to log enough detail to explain every manual failure. Add diagnostic events for:

- GPS watcher start success including watcher type and active mode.
- Initial GPS point accepted/rejected.
- Every rejected point reason, sampled or rate-limited:
  - invalid coordinates
  - accuracy too poor
  - timestamp non-increasing
  - noise floor
  - unreasonable speed
- Route point count while tracking.
- End-trip raw route count and clean route count in the final discard event.
- Manual save review details:
  - duration seconds
  - wall-clock seconds
  - distance km
  - max speed km/h
  - coordinate point count
  - moving speed sample count
  - decision reason
- Manual map review details:
  - displayed point count
  - saved raw route count
  - saved map route count
  - tracking gap count
  - privacy gap count
  - map matching status
  - straight-line segment count
  - longest visual segment distance
  - highest visual implied speed
- GPS anomaly details:
  - rejected point count by reason
  - accepted point count
  - max accepted GPS speed
  - max accepted OBD speed
  - max segment implied speed
  - max segment distance
  - whether a high-speed reported sample allowed a visual segment jump

Suggested diagnostic payload:

```js
recordTrackingDiagnostic({
  type: 'manual_save_review',
  title: 'Manual save review completed',
  reason: manualSaveReview.reason,
  duration_seconds: Math.round(preliminaryStats.duration_seconds || 0),
  wall_clock_duration_seconds: Math.round(preliminaryStats.wall_clock_duration_seconds || 0),
  distance_km: preliminaryStats.distance_km || 0,
  max_speed_kmh: Math.round(preliminaryStats.max_speed_kmh || 0),
  route_points_raw_count: rawPoints.length,
  route_points_clean_count: cleanedPoints.length,
});
```

Suggested map/anomaly payload:

```js
recordTrackingDiagnostic({
  type: 'manual_route_geometry_review',
  title: 'Manual route geometry reviewed',
  route_points_raw_count: rawPoints.length,
  route_points_clean_count: cleanedPoints.length,
  route_points_map_count: pts.length,
  tracking_gap_count: pts.filter((point) => point?.tracking_gap === true).length,
  map_matching_status: mapMatchingContext.status,
  longest_segment_km: routeGeometryReview.longestSegmentKm,
  highest_implied_speed_kmh: routeGeometryReview.highestImpliedSpeedKmh,
  suspicious_segment_count: routeGeometryReview.suspiciousSegmentCount,
});
```

## Regression Tests Needed

There are lower-level tests for tracking and trip-engine movement, but there is no direct Dashboard regression for the reported manual workflow.

Existing related coverage:

- `src/lib/__tests__/trackingService.test.js`
  - Confirms web watcher emits a typed permission error.
  - Confirms speed can be derived from coordinate movement when reported speed is zero.
- `src/lib/__tests__/tripEngineCalculationCoverage.test.js`
  - Confirms candidate trips validate with movement, duration, and distance.
  - Confirms trip stats infer movement from coordinates even when reported GPS speed is zero.

Missing tests:

- Manual Dashboard trip with start button, two or more moving GPS points, End Trip, and saved trip assertion.
- Manual Dashboard trip with GPS speed reported as zero but coordinate displacement indicating driving.
- Manual Dashboard trip with one initial stationary point followed by real movement.
- Manual Dashboard trip where the screen/app visibility changes but foreground watcher still emits points.
- Manual discard diagnostics assert raw/clean point counts and review reason.
- Manual saved trip with sparse points marks route gaps so TripMap does not draw one misleading continuous straight line.
- TripMap does not draw giant visual jump segments when implied speed is impossible, even if reported speed is high.
- Manual saved trip with map matching `manual_required` shows raw GPS geometry but does not claim the route follows roads.
- Manual Android foreground tracking behavior is tested separately from background/native tracking behavior.
- Manual "app fully closed" expectation is documented and tested as unsupported unless a native manual foreground service is implemented.

## Proposed Fix Direction

The safest fix is not to simply remove the movement gate. The app needs to prevent accidental stationary saves, but it must not discard real drives because Android delivered sparse GPS.

Recommended implementation plan:

1. Add detailed manual-save diagnostics before changing thresholds.
2. Export or display the active trip route point count during tracking.
3. Add a direct Dashboard regression test for manual start/end.
4. Add a sparse manual-drive preservation path that saves a reviewable trip when:
   - wall-clock duration is at least 30 seconds, and
   - there are at least two accepted coordinates, and
   - either displacement, derived speed, OBD speed, or Android activity suggests vehicle movement.
5. If route evidence is insufficient but the watcher failed or permission was lost, save a `review_required`/`data_gap_detected` trip record instead of silently discarding a user-confirmed manual drive.
6. Consider using native/background location for manual Android trips while the trip is active, even when automatic background tracking is disabled.

## Acceptance Criteria

A fix should pass all of these:

- Manual Start Trip creates an active trip with `start_source: 'manual'`.
- Foreground Android manual tracking records route points while the app remains visible.
- A real drive with GPS speed reported as zero but coordinate movement above 0.1 km saves successfully.
- A sparse GPS drive with at least two usable points and speed evidence saves successfully with reason `manual_sparse_gps_vehicle_speed`.
- A true stationary manual session under 30 seconds is still discarded.
- A true stationary session over 30 seconds with no movement evidence is either discarded with clear diagnostics or saved only if the user explicitly chooses a review/save-anyway action.
- The discard diagnostic includes the manual review reason, route point counts, duration, distance, and max speed.
- System Logs export contains enough information to distinguish watcher failure from movement-filter failure.
- Manual map rendering shows a multi-point driven path when GPS samples were recorded.
- If route samples are sparse, the map marks gaps or splits segments instead of drawing a misleading continuous line.
- A saved manual trip does not show impossible `250 km/h` speed unless the source is explicitly identified and accepted by filters.
- A saved manual trip does not show impossible `250 km` distance caused by GPS jumps.
- Map playback distance and saved trip distance are either consistent or the UI labels why they differ.
- Pressing Start Trip and fully closing the app has a defined product behavior:
  - either unsupported and clearly warned in UI/docs, or
  - supported by a native foreground manual-trip service with notification, persistence, and tests.

## Debugging Checklist For The Next Real Device Run

Before driving:

- Confirm Settings -> Tracking mode is Manual Only.
- Confirm location permission is allowed.
- Disable battery optimization for Road Sage if testing Android foreground reliability.
- Open Diagnostics and clear diagnostics only if a clean run is needed.

During the drive:

- Tap Start Trip.
- Confirm the tracking UI shows an active trip timer.
- Keep the screen awake for one run.
- Run a second test with the screen locked only after the foreground test is understood.

After End Trip:

- If saved, inspect Trip Detail route point count and distance.
- If discarded, immediately export System Logs.
- Capture Diagnostics recent events.
- Check whether `trip_discarded.reason` is `manual_no_movement_evidence` or `manual_duration_too_short`.
- Check `distance_km`, `route_points_raw_count`, and `route_points_clean_count` if available.

## Bottom Line

The reported failure is not the Start Trip button being ignored. The current evidence points to the active manual trip reaching End Trip without enough accepted GPS movement evidence. The fragile area is the path between Android foreground geolocation updates, the point acceptance filters, route cleaning, and the manual save gate.
