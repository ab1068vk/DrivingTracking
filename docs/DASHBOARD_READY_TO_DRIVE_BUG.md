# Dashboard Ready To Drive Bug

## Summary

The Dashboard idle trip card displays the copy `Ready to drive?` above the `Start a new trip` action when no trip is currently tracking.

This card lives in `src/pages/Dashboard.jsx` and is the first manual-start affordance users see on the Dashboard. It also renders `TrackingHealthChip`, which can warn that background tracking is degraded.

## Whole Box Info

The box is the idle branch of the Dashboard `AnimatePresence` block. It only appears when `tracking` is false.

| Box part | Current value | Source |
| --- | --- | --- |
| Container | `motion.div` with `key="idle"` | `src/pages/Dashboard.jsx` |
| Animation in | `{ opacity: 0, scale: 0.96 }` to `{ opacity: 1, scale: 1 }` | Framer Motion |
| Animation out | `{ opacity: 0, scale: 0.96 }` | Framer Motion |
| Card styling | `bg-card border border-border rounded-3xl p-6 shadow-sm` | Tailwind classes |
| Top label | `Ready to drive?` | Hard-coded text |
| Main title | `Start a new trip` | Hard-coded text |
| Helper text | `Tap to begin tracking your route` | Hard-coded text |
| Health chip | `TrackingHealthChip` | Uses `trackingStatusContext`, `trackingHealthPermissions`, and `effectiveTrackingMode` |
| Button | 64px square gradient button | Calls `handleStartTrip()` |
| Button icon | `Play` icon | Lucide icon |

The current box does not use the already-computed `trackingReadiness.headline` or `trackingReadiness.detail` for its visible text.

## Major Bug

The card headline always says `Ready to drive?` even when Road Sage is not actually ready to start or auto-detect a trip.

Examples of blocked or degraded states include:

- Tracking is paused in Settings.
- Location permission is missing.
- Android Physical Activity permission is missing.
- Background location is missing while `background_auto` is selected.
- Notifications are missing while `background_auto` is selected.
- Android native background tracking is not armed.
- Battery optimization may restrict Android background auto tracking.

The result is a misleading Dashboard state: the primary card can invite the user to start driving while nearby internal readiness checks know the setup is blocked or degraded.

## User Impact

- Users may believe Road Sage is ready when trip start will be blocked.
- Background-auto users may drive away without realizing the Android native service, battery setting, or permissions are not ready.
- Manual start may show a generic failure after tapping the play button instead of explaining the readiness issue before the action.
- E2E tests currently assert that `Ready to drive?` is visible, which can lock in the misleading state.

## Whole Box Code

File: `src/pages/Dashboard.jsx`

```jsx
{/* Active Trip Card */}
<AnimatePresence mode="wait">
  {tracking ? (
    <ActiveTripPanel
      fallbackTrip={activeTrip}
      hazardMessage={hazardMessage}
      onAcknowledgeEmergency={acknowledgeEmergencyWorkflow}
      onEndTrip={() => handleEndTrip().catch((error) => {
        const message = 'Road Sage could not finish saving this trip. Keep the app open and try ending again.';
        setLocationError(message);
        notifyUserError('dashboard_end_trip', error, {
          title: 'Trip not saved yet',
          description: message,
        });
      })}
      parkedLocation={parkedLocation}
      settings={settings}
      stealthTripActive={stealthTripActive}
      units={units}
    />
  ) : (
    <motion.div
      key="idle"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className="bg-card border border-border rounded-3xl p-6 shadow-sm"
    >
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="text-muted-foreground text-sm mb-1">Ready to drive?</div>
          <div className="font-grotesk font-bold text-xl">Start a new trip</div>
          <div className="text-muted-foreground text-xs mt-1">Tap to begin tracking your route</div>
          <TrackingHealthChip
            nativeStatus={trackingStatusContext.nativeStatus}
            permissions={trackingHealthPermissions}
            trackingMode={effectiveTrackingMode}
          />
        </div>
        <button
          onClick={() => handleStartTrip().catch((error) => {
            const message = 'Road Sage could not start this trip. Check permissions and try again.';
            setLocationError(message);
            notifyUserError('dashboard_start_trip', error, {
              title: 'Trip did not start',
              description: message,
            });
          })}
          className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg hover:opacity-90 transition-opacity"
        >
          <Play className="w-7 h-7 text-white ml-0.5" />
        </button>
      </div>
    </motion.div>
  )}
</AnimatePresence>
```

The bug is the hard-coded line:

```jsx
<div className="text-muted-foreground text-sm mb-1">Ready to drive?</div>
```

It does not use `trackingReadiness`, `trackingExplanation`, or `TrackingHealthChip` state to decide whether the Dashboard should say ready, blocked, paused, or degraded.

## Readiness State Already Exists

`Dashboard.jsx` already computes `effectiveTrackingMode` and a `trackingReadiness` object.

```jsx
const effectiveTrackingMode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');
```

```jsx
const trackingReadiness = (() => {
  const mode = effectiveTrackingMode;
  const checks = [
    {
      label: 'Tracking mode',
      ready: mode !== 'paused',
      action: null,
      detail: mode === 'paused'
        ? 'All tracking is paused in Settings.'
        : mode === 'manual'
          ? 'Manual start is available.'
          : mode === 'background_auto'
            ? 'Background auto is selected.'
            : 'Foreground auto-detect is selected.',
    },
    {
      label: 'Location',
      ready: settings.location_permission_granted === true,
      action: 'location',
      detail: settings.location_permission_granted
        ? 'Location permission is recorded as granted.'
        : mode === 'manual'
          ? 'Location permission is needed before a manual trip can record GPS.'
          : 'Location permission is needed before automatic tracking can start.',
    },
    {
      label: 'Activity',
      ready: !isAndroid() || settings.activity_permission_granted === true,
      action: 'activity',
      detail: isAndroid()
        ? settings.activity_permission_granted
          ? 'Physical Activity is ready.'
          : mode === 'manual'
            ? 'Physical Activity improves trip context and keeps setup honest for switching to auto later.'
            : 'Physical Activity helps auto tracking tell driving from walking or still time.'
        : 'Activity permission is not required on this platform.',
    },
    {
      label: 'Background',
      ready: mode !== 'background_auto' || settings.background_location_granted === true,
      action: 'background',
      detail: mode === 'background_auto'
        ? settings.background_location_granted ? 'Background location is ready.' : 'Allow all-the-time location for background auto tracking.'
        : 'Background location is not needed for this mode.',
    },
    {
      label: 'Notifications',
      ready: mode !== 'background_auto' || settings.notification_permission_granted === true,
      action: 'notifications',
      detail: mode === 'background_auto'
        ? settings.notification_permission_granted ? 'Foreground service notifications are ready.' : 'Android background tracking needs notifications for its persistent status.'
        : 'Notifications improve trip summaries and safety alerts.',
    },
    {
      label: 'Battery',
      ready: !isAndroid() || mode !== 'background_auto' || trackingStatusContext.batteryStatus?.batteryOptimizationIgnored === true,
      action: 'battery',
      detail: isAndroid() && mode === 'background_auto'
        ? trackingStatusContext.batteryStatus?.batteryOptimizationIgnored ? 'Battery optimization is unrestricted.' : 'Unrestricted battery helps Android keep background auto tracking alive.'
        : 'Battery setup is only needed for Android background auto.',
    },
    {
      label: 'Native service',
      ready: !isAndroid() || mode !== 'background_auto' || trackingStatusContext.nativeStatus?.enabled === true,
      action: 'native',
      detail: isAndroid() && mode === 'background_auto'
        ? trackingStatusContext.nativeStatus?.enabled ? 'Native auto tracking is armed.' : 'Start the native service so Android can detect drives while the app sleeps.'
        : 'Native service is only used for Android background auto.',
    },
  ];
  const blockers = checks.filter((item) => !item.ready);
  return {
    mode,
    checks,
    ready: blockers.length === 0,
    headline: blockers.length === 0 ? 'Tracking is ready' : `${blockers.length} tracking setup item${blockers.length === 1 ? '' : 's'} need attention`,
    detail: blockers.length === 0
      ? mode === 'manual' ? 'Manual trips can start with GPS recording.' : 'Auto tracking has the recorded permissions it needs.'
      : blockers[0].detail,
  };
})();
```

This means the Dashboard already has the data needed to avoid showing an unconditional ready message.

## Tracking Health Chip Code

File: `src/components/TrackingHealthChip.jsx`

```jsx
export function TrackingHealthChip({ nativeStatus, permissions, trackingMode }) {
  if (trackingMode !== 'background_auto') return null;

  const nativeRunning = nativeStatus?.running ?? nativeStatus?.enabled;
  const batteryOptimizationIgnored =
    permissions?.batteryOptimizationIgnored ?? nativeStatus?.batteryOptimizationIgnored;

  const isHealthy =
    nativeRunning === true &&
    permissions?.backgroundLocation === 'granted' &&
    permissions?.activityRecognition === 'granted' &&
    batteryOptimizationIgnored === true;

  if (isHealthy) return null;

  const problems = [
    nativeRunning !== true && 'service not running',
    permissions?.backgroundLocation !== 'granted' && 'background location denied',
    permissions?.activityRecognition !== 'granted' && 'activity permission missing',
    batteryOptimizationIgnored !== true && 'battery restricted',
  ].filter(Boolean);

  return (
    <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Tracking degraded - {problems[0]}
    </div>
  );
}
```

This chip can show a degraded state directly underneath the unconditional `Ready to drive?` label, creating contradictory UI.

## Button Click Flow

When the play button is clicked, this exact handler runs:

```jsx
onClick={() => handleStartTrip().catch((error) => {
  const message = 'Road Sage could not start this trip. Check permissions and try again.';
  setLocationError(message);
  notifyUserError('dashboard_start_trip', error, {
    title: 'Trip did not start',
    description: message,
  });
})}
```

Click sequence:

1. If a trip is already tracking, `handleStartTrip` returns immediately.
2. Auto-ending and permission-ending refs are reset.
3. Current settings are loaded from `localSettings`.
4. If stealth-next-trip mode is enabled, the old temporary result is cleared.
5. If this is a manual start and daily fatigue says to warn, the fatigue modal opens instead of starting the trip.
6. If tracking is paused, a diagnostic is recorded, the Dashboard status context refreshes, an error message is stored, and a destructive toast says the trip did not start.
7. If Android background/native auto tracking needs to pause for a manual or stealth trip, the native service is stopped.
8. If Android activity permission is required, the handler requests it. If denied, the trip is blocked and native auto may be resumed.
9. The handler requests background or foreground location permission depending on mode. If denied, the trip is blocked and native auto may be resumed.
10. Stealth trip mode is consumed if requested.
11. A pre-trip readiness context is built and a readiness signal snapshot is recorded.
12. Android phone usage access is checked.
13. The active trip object is created with route, tracking, candidate, native, phone-usage, and readiness metadata.
14. The active trip is persisted to `activeTripStore`.
15. A tracking diagnostic is recorded: `trip_started` for manual starts or `candidate_started` for candidates.
16. Dashboard tracking status context refreshes.
17. Refs and React state are updated: `activeTripRef`, `trackingRef`, `setActiveTrip`, and `setTracking(true)`.
18. Sensor fusion starts when enabled.
19. Android activity recognition starts when required.
20. The elapsed timer starts.
21. GPS tracking starts.
22. For confirmed, non-stealth trips, the user gets a `Trip started` success toast, a trip-started notification, and a long-trip reminder.
23. Because `tracking` becomes true, the idle box is replaced by `ActiveTripPanel`.

## Full Start Handler Code

File: `src/pages/Dashboard.jsx`

```jsx
const handleStartTrip = useCallback(async ({
  autoStarted = false,
  bypassFatigueWarning = false,
  candidate = false,
  initialPoint = null,
  nearParkedLocation = false,
  triggerReason = null,
} = {}) => {
  if (trackingRef.current) return;
  autoEndingTripRef.current = false;
  locationPermissionEndingRef.current = false;

  const cfg = localSettings.get();
  const stealthRequested = isStealthNextTripEnabled();
  if (stealthRequested) setEphemeralTripResult(null);
  if (!autoStarted && !bypassFatigueWarning && dailyFatigue.shouldWarnBeforeTrip) {
    setPendingStartOptions({ autoStarted, candidate, initialPoint, nearParkedLocation, triggerReason });
    setFatigueDialogOpen(true);
    return;
  }
  if (cfg.tracking_paused) {
    recordTrackingDiagnostic({
      type: 'auto_blocked',
      title: autoStarted ? 'Auto tracking blocked' : 'Trip start blocked',
      reason: 'tracking_paused',
    });
    refreshTrackingStatusContext();
    const message = 'Tracking is paused in Settings.';
    setLocationError(message);
    notifyUserMessage('dashboard_start_trip_blocked_paused', {
      title: 'Trip did not start',
      description: message,
      variant: 'destructive',
    });
    return;
  }

  const useBackground = stealthRequested ? false : (cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto');
  let pausedNativeAuto = false;
  if (stealthRequested && isAndroid()) {
    await stopNativeAutoTracking().catch((err) => {
      logNativeAutoStopFailure(err, cfg, { reason: 'stealth_trip_start_pause_native_auto' });
    });
    pausedNativeAuto = true;
  } else if (!autoStarted && useBackground && isAndroid()) {
    await stopNativeAutoTracking().catch((err) => {
      logNativeAutoStopFailure(err, cfg, { reason: 'manual_trip_start_pause_native_auto' });
    });
    pausedNativeAuto = true;
  }

  if ((autoStarted || cfg.auto_tracking_enabled || cfg.tracking_mode !== 'manual') && isAndroid()) {
    const activityGranted = await requestActivityRecognitionPermission();
    if (!activityGranted) {
      if (pausedNativeAuto && !stealthRequested) await startNativeAutoTracking().catch((err) => {
        logNativeAutoStartFailure(err, cfg, { reason: 'resume_after_activity_permission_denied' });
      });
      recordTrackingDiagnostic({
        type: 'auto_blocked',
        title: autoStarted ? 'Auto tracking blocked' : 'Trip start blocked',
        reason: 'activity_permission_denied',
      });
      refreshTrackingStatusContext();
      const message = 'Physical activity permission is required for auto trip detection.';
      setLocationError(message);
      notifyUserMessage('dashboard_start_trip_activity_denied', {
        title: 'Trip did not start',
        description: message,
        variant: 'destructive',
      });
      return;
    }
  }

  const granted = useBackground
    ? await requestBackgroundLocationPermission()
    : await requestForegroundLocationPermission();

  if (!granted) {
    if (pausedNativeAuto && !stealthRequested) await startNativeAutoTracking().catch((err) => {
      logNativeAutoStartFailure(err, cfg, { reason: 'resume_after_location_permission_denied' });
    });
    recordTrackingDiagnostic({
      type: 'auto_blocked',
      title: autoStarted ? 'Auto tracking blocked' : 'Trip start blocked',
      reason: useBackground ? 'background_location_or_notification_denied' : 'location_permission_denied',
    });
    refreshTrackingStatusContext();
    const message = useBackground
      ? 'Background tracking needs location and notification permission before a trip can start.'
      : 'Location permission denied. Please enable location to start a trip.';
    setLocationError(message);
    notifyUserMessage('dashboard_start_trip_location_denied', {
      title: 'Trip did not start',
      description: message,
      variant: 'destructive',
    });
    return;
  }

  const ephemeralTrip = stealthRequested ? await consumeStealthNextTrip() : false;
  if (ephemeralTrip) {
    activeTripStore.clear();
  }

  const startTime = initialPoint?.timestamp || new Date().toISOString();
  const startDate = new Date(startTime);
  const preTripReadinessContext = buildPreTripReadinessContext(
    Number.isFinite(startDate.getTime()) ? startDate : new Date()
  );
  const readinessSignalRecordId = await recordReadinessSnapshot(
    preTripReadinessContext.signals,
    preTripReadinessContext.compositeRisk ?? preTripReadinessContext.bootstrapRisk,
    preTripReadinessContext.weights
  ).catch((err) => {
    logError('readiness_signal_snapshot_record', err);
    return null;
  });
  if (readinessSignalRecordId) {
    preTripReadinessContext.signalHistoryRecordId = readinessSignalRecordId;
  }
  const phoneUsageAccessStatus = isAndroid()
    ? await getAndroidUsageAccessStatus().catch(() => null)
    : null;
  const phoneUsageAccessGrantedAtStart = phoneUsageAccessStatus?.usageAccessGranted === true;
  const tripData = {
    start_time: startTime,
    status: 'active',
    trip_state: candidate ? TRIP_STATES.CANDIDATE : TRIP_STATES.CONFIRMED,
    route_points: initialPoint ? [initialPoint] : [],
    driving_events: [],
    ephemeral_trip: ephemeralTrip,
    background_tracking: ephemeralTrip ? false : useBackground,
    start_source: autoStarted ? 'auto' : 'manual',
    resume_native_auto: !ephemeralTrip && !autoStarted && useBackground && isAndroid(),
    candidate_started_at: candidate ? startTime : null,
    candidate_first_point: candidate && initialPoint ? initialPoint : null,
    candidate_near_parked: candidate ? nearParkedLocation === true : false,
    candidate_trigger_reason: triggerReason,
    native_phone_usage_access_granted: phoneUsageAccessGrantedAtStart,
    native_phone_usage_access_checked_at: phoneUsageAccessStatus ? new Date().toISOString() : null,
    pre_trip_readiness_context: preTripReadinessContext,
    readiness_signal_record_id: readinessSignalRecordId,
  };

  activeTripStore.set(tripData);
  if (candidate) {
    recordTrackingDiagnostic({
      type: 'candidate_started',
      title: 'Candidate started: speed >= 5 km/h for 2 seconds',
      reason: triggerReason || 'sustained_gps_movement',
      trip_state: TRIP_STATES.CANDIDATE,
      speed_kmh: Math.round(initialPoint?.speed_kmh || 0),
      background_tracking: useBackground,
    });
    if (nearParkedLocation) {
      recordTrackingDiagnostic({
        type: 'candidate_hidden_parking_cooldown',
        title: 'Candidate hidden due to parking cooldown zone',
        reason: 'near_last_parked_location',
        trip_state: TRIP_STATES.CANDIDATE,
        speed_kmh: Math.round(initialPoint?.speed_kmh || 0),
      });
    }
  } else {
    recordTrackingDiagnostic({
      type: 'trip_started',
      title: autoStarted ? 'In-app auto trip started' : 'Manual trip started',
      reason: autoStarted ? 'auto_detection' : 'manual_button',
      trip_state: TRIP_STATES.CONFIRMED,
      background_tracking: useBackground,
    });
  }
  refreshTrackingStatusContext();
  activeTripRef.current = tripData;
  trackingRef.current = true;
  setActiveTrip(tripData);
  setTracking(true);
  if (cfg.sensor_fusion_enabled !== false) {
    sensorFusionRef.current = createMotionSensorFusion();
    sensorFusionRef.current.start().catch((err) => {
      logError('sensor_fusion_start', err, { mode: cfg.tracking_mode });
    });
  }
  if (isAndroid() && !activityStopRef.current && (candidate || autoStarted || cfg.auto_tracking_enabled || cfg.tracking_mode !== 'manual')) {
    activityStopRef.current = await startActivityRecognition(
      (activity) => {
        latestActivityRef.current = activity;
      },
      (err) => setLocationError(err.message)
    );
  }
  startTimer(new Date(startTime));
  startGPS();
  if (!candidate && !ephemeralTrip) {
    notifyUserSuccess('dashboard_start_trip', {
      title: 'Trip started',
      description: useBackground ? 'Road Sage is recording with background tracking enabled.' : 'Road Sage is recording this drive now.',
    });
    notifyTripStarted(tripData).catch((err) => {
      logError('trip_started_notification', err, { start_source: tripData.start_source });
    });
    scheduleLongTripReminder(tripData.start_time);
  }
}, [buildPreTripReadinessContext, dailyFatigue.shouldWarnBeforeTrip, refreshTrackingStatusContext, startGPS]);
```

This confirms the UI can say `Ready to drive?` while `handleStartTrip` may immediately block the trip because tracking is paused, activity permission is denied, or location/background permission is denied.

## Complete After-Click Runtime Map

This is the full runtime path after the play button calls `handleStartTrip()`.

| Step | Code path | What happens |
| --- | --- | --- |
| 1 | `handleStartTrip()` guard | Returns if `trackingRef.current` is already true. |
| 2 | fatigue warning | Opens the fatigue modal and does not start yet when `dailyFatigue.shouldWarnBeforeTrip` is true. |
| 3 | paused tracking check | Records `auto_blocked`, refreshes status, sets `locationError`, and shows `Trip did not start`. |
| 4 | native auto pause | Stops Android native auto tracking for manual background trips or stealth trips. |
| 5 | activity permission | Requests Android Physical Activity permission when needed; denial blocks start and may resume native auto. |
| 6 | location/background permission | Requests foreground or background location. Background permission also requests notifications. Denial blocks start and may resume native auto. |
| 7 | stealth mode | Consumes stealth-next-trip state and clears persistent active trip storage if needed. |
| 8 | readiness capture | Builds `pre_trip_readiness_context` and records `readiness_signal_record_id`. |
| 9 | phone usage access | Checks Android usage access and stores whether it was granted at trip start. |
| 10 | active trip draft | Builds `tripData` with trip state, source, route points, native flags, candidate flags, and readiness metadata. |
| 11 | active store | Persists `tripData` to `activeTripStore`. |
| 12 | diagnostics | Records `trip_started`, `candidate_started`, or `candidate_hidden_parking_cooldown`. |
| 13 | React state | Sets `activeTripRef.current`, `trackingRef.current`, `setActiveTrip(tripData)`, and `setTracking(true)`. |
| 14 | sensor fusion | Starts `createMotionSensorFusion()` unless disabled. |
| 15 | activity recognition | Starts Android activity recognition for auto/candidate/non-manual modes. |
| 16 | timer | `startTimer()` begins periodic active-trip metadata persistence every 30 seconds. |
| 17 | GPS service | `startGPS()` creates/starts the driving tracking service. |
| 18 | success messages | Confirmed non-stealth trips show `Trip started`, send trip-start notification, and schedule long-trip reminder. |
| 19 | UI swap | Because `tracking` is true, the idle box is replaced by `ActiveTripPanel`. |
| 20 | live GPS updates | Every point updates current location, active route, map center, speed warnings, danger-zone warnings, candidate validation, crash checks, and parked auto-stop. |
| 21 | auto-stop or End Trip | Auto-stop or the active panel's `End Trip` button calls `handleEndTrip()`. |
| 22 | trip completion | `handleEndTrip()` cleans route points, trims parked tail, detects events, scores the trip, saves it or discards it, clears active state, refreshes queries, and may resume Android native auto tracking. |

## Permission Helpers Reached By The Click

The play button can call these permission helpers through `handleStartTrip`.

```js
export async function requestForegroundLocationPermission() {
  invalidatePermissionCache();
  if (await currentPermissionState('foregroundLocation') === PERMISSION_STATES.GRANTED) {
    localSettings.update({ location_permission_granted: true, _location_denial_count: 0 });
    return true;
  }
  if (isNativePlatform()) {
    const settings = localSettings.get();
    const priorDenials = Number(settings._location_denial_count || 0);
    try {
      const result = await Geolocation.requestPermissions({ permissions: ['location'] });
      const granted = result.location === PERMISSION_STATES.GRANTED;
      if (granted) {
        localSettings.update({ location_permission_granted: true, _location_denial_count: 0 });
        invalidatePermissionCache();
        return true;
      }

      const denialCount = priorDenials + 1;
      const state = isAndroid() && denialCount >= 2
        ? PERMISSION_STATES.NEEDS_SETTINGS
        : PERMISSION_STATES.DENIED;
      localSettings.update({
        location_permission_granted: state,
        _location_denial_count: denialCount,
      });
      invalidatePermissionCache();
      return false;
    } catch (err) {
      logError('foreground_location_permission_request', err);
      localSettings.update({ location_permission_granted: PERMISSION_STATES.UNKNOWN });
      invalidatePermissionCache();
      return false;
    }
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => {
        localSettings.update({ location_permission_granted: true, _location_denial_count: 0 });
        invalidatePermissionCache();
        resolve(true);
      },
      () => {
        localSettings.update({ location_permission_granted: PERMISSION_STATES.DENIED });
        invalidatePermissionCache();
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}
```

```js
export async function requestActivityRecognitionPermission() {
  if (!isAndroid()) return false;
  invalidatePermissionCache();
  if (await currentPermissionState('activityRecognition') === PERMISSION_STATES.GRANTED) {
    localSettings.update({ activity_permission_granted: true, _activity_denial_count: 0 });
    return true;
  }
  const settings = localSettings.get();
  const priorDenials = Number(settings._activity_denial_count || 0);
  try {
    const result = await ActivityRecognition.requestPermissions();
    const granted = result.activityRecognition === PERMISSION_STATES.GRANTED;
    if (granted) {
      localSettings.update({ activity_permission_granted: true, _activity_denial_count: 0 });
      invalidatePermissionCache();
      return true;
    }
    const denialCount = priorDenials + 1;
    const state = denialCount >= 2 ? PERMISSION_STATES.NEEDS_SETTINGS : PERMISSION_STATES.DENIED;
    localSettings.update({
      activity_permission_granted: state,
      _activity_denial_count: denialCount,
    });
    invalidatePermissionCache();
    return granted;
  } catch (err) {
    logError('activity_recognition_permission_request', err);
    localSettings.update({ activity_permission_granted: PERMISSION_STATES.UNKNOWN });
    invalidatePermissionCache();
    return false;
  }
}
```

```js
export async function requestBackgroundLocationPermission() {
  invalidatePermissionCache();
  if (await currentPermissionState('backgroundLocation') === PERMISSION_STATES.GRANTED) {
    localSettings.update({ background_location_granted: true });
    return true;
  }
  const foregroundGranted = await requestForegroundLocationPermission();
  if (!foregroundGranted) return false;

  const notificationsGranted = await requestNotificationPermission();
  if (!notificationsGranted) return false;

  if (isAndroid()) {
    try {
      let status = await ActivityRecognition.checkPermissions();
      if (status.backgroundLocation === PERMISSION_STATES.GRANTED) {
        localSettings.update({ background_location_granted: true });
        invalidatePermissionCache();
        return true;
      }

      const result = await ActivityRecognition.requestBackgroundLocation();
      const granted = result.backgroundLocation === PERMISSION_STATES.GRANTED;
      localSettings.update({
        background_location_granted: granted ? true : PERMISSION_STATES.NEEDS_SETTINGS,
      });
      if (!granted) {
        await ActivityRecognition.openAppLocationSettings();
      }
      invalidatePermissionCache();
      return granted;
    } catch (err) {
      logError('background_location_permission_request', err);
      try {
        await ActivityRecognition.openAppLocationSettings();
      } catch (settingsErr) {
        logError('background_location_settings_open', settingsErr);
      }
      localSettings.update({ background_location_granted: PERMISSION_STATES.NEEDS_SETTINGS });
      invalidatePermissionCache();
      return false;
    }
  }

  localSettings.update({ background_location_granted: true });
  invalidatePermissionCache();
  return true;
}
```

## Timer Started By The Click

`handleStartTrip()` calls `startTimer(new Date(startTime))`. In this file, that timer is not the visual elapsed clock. It persists active-trip metadata every 30 seconds.

```jsx
const startTimer = (startTime) => {
  stopTimer();
  metaPersistTimerRef.current = setInterval(() => {
    persistActiveTripMeta(activeTripRef.current);
  }, 30000);
};

const stopTimer = () => {
  if (metaPersistTimerRef.current) {
    clearInterval(metaPersistTimerRef.current);
    metaPersistTimerRef.current = null;
  }
};
```

The visible timer in the active card comes from `ElapsedClock`, which updates independently in the active panel.

## GPS Updates After The Click

`handleStartTrip()` calls `startGPS()`. This is the main downstream path after the button click succeeds.

What `startGPS()` does after each location point:

- stores the latest point in `currentLocationRef`
- clears location errors
- saves last map center unless stealth mode is active
- appends the point to `activeTripStore`
- infers speed zones and speed limits
- shows speed warnings and voice alerts when over the effective limit
- checks repeated-event danger zones and alerts the user
- promotes or discards candidate trips
- detects possible crash/incidents
- updates active trip emergency workflow state
- watches for stopped/parked conditions
- records auto-stop diagnostics
- calls `endTripRef.current?.()` when parked auto-stop triggers

Key code:

```jsx
const startGPS = useCallback(() => {
  const cfg = localSettings.get();
  const useBackground = cfg.background_tracking_enabled || cfg.tracking_mode === 'background_auto';
  if (!locationService.current) {
    locationService.current = createDrivingTrackingService({ background: useBackground });
  }
  locationService.current.start(
    async (point) => {
      currentLocationRef.current = point;
      setLocationError(null);
      const latestSettings = localSettings.get();
      if (!isEphemeralModeActive() && !isStealthNextTripEnabled()) {
        saveLastMapCenter({
          ...point,
          tripId: activeTripRef.current?.id ?? null,
          source: 'tracking',
        });
      }
      const tripBeforePoint = activeTripRef.current;
      const isCandidateTrip = tripBeforePoint?.trip_state === TRIP_STATES.CANDIDATE;
      const latestPrivacyZones = getPrivacyZones(latestSettings);
      const pointInPrivacyZone = isInsidePrivacyZone(point.lat, point.lng, latestPrivacyZones);
      if (!isEphemeralModeActive() && !isCandidateTrip && !pointInPrivacyZone && latestSettings.danger_zone_alerts_enabled !== false) {
        const zones = await loadDangerZones();
        const nearby = checkDangerZoneProximity(point.lat, point.lng, zones, 300);
        if (nearby.length > 0 && Date.now() - lastProximityAlertRef.current > 60 * 1000) {
          const zone = nearby[0];
          lastProximityAlertRef.current = Date.now();
          const typeLabel = String(zone.dominantType || 'risk event').replace(/_/g, ' ');
          const body = `${typeLabel} repeated-event area ${Math.round(zone.distanceM || 0)} m ahead`;
          setHazardMessage({ body, at: Date.now() });
          notifyStayAlert({
            id: 4007,
            title: 'Repeated event area ahead',
            body,
            extra: { type: 'repeated_event_area', zoneId: zone.id },
          }).catch((err) => {
            logError('repeated_event_area_notification', err, { zoneId: zone.id, dominantType: zone.dominantType });
          });
          queueVoiceAlertForKey({
            key: 'repeated_event_area',
            ctx: { typeLabel },
            settings: latestSettings,
            cooldownMs: 60 * 1000,
          });
        }
      }
      const updatedTripWithPoint = tripBeforePoint ? activeTripStore.addPoint(point) : null;
      const routePointsWithLatest = updatedTripWithPoint?.route_points ||
        (tripBeforePoint ? [...(tripBeforePoint.route_points || []), point] : [point]);
      const speed = Number(point.speed_kmh) || 0;
      const thresholds = buildDrivingThresholds(latestSettings);
      inferredSpeedZonesRef.current = inferSpeedZones(routePointsWithLatest, thresholds);
      const postedLimitKmh = Number(point.speed_limit_kmh);
      const currentPointLimitKmh = Number.isFinite(postedLimitKmh) && postedLimitKmh > 0 ? postedLimitKmh : null;
      const currentInferredLimit = currentPointLimitKmh
        ?? getInferredLimitForPoint(routePointsWithLatest, point, thresholds, inferredSpeedZonesRef.current);
      const speedLimitContext = resolveEffectiveSpeedLimitForIndex(
        routePointsWithLatest,
        routePointsWithLatest.length - 1,
        thresholds,
        { inferredZones: inferredSpeedZonesRef.current }
      );
      const fallbackSpeedLimitKmh = Number(latestSettings.threshold_speeding_kmh);
      const speedLimitKmh = currentInferredLimit ?? speedLimitContext.effectiveLimitKmh ?? (Number.isFinite(fallbackSpeedLimitKmh) ? fallbackSpeedLimitKmh : 100);
      const speedLimitSource = currentPointLimitKmh != null
        ? point.speed_limit_source || 'openstreetmap'
        : currentInferredLimit != null
          ? 'inferred'
          : speedLimitContext.limitSource;
      const speedLimitLabel = speedLimitSource === 'inferred' ? 'estimated limit' : 'limit';
      const speedMarginKmh = Number(latestSettings.threshold_speed_over_kmh ?? 5);
      const shouldWarnForSpeed = (
        !isCandidateTrip &&
        !isEphemeralModeActive() &&
        latestSettings.speed_warning_enabled !== false &&
        isAlertAllowedByProfile('speeding', latestSettings) &&
        speed > speedLimitKmh + speedMarginKmh
      );
      if (shouldWarnForSpeed) {
        const overKmh = speed - speedLimitKmh;
        setHazardMessage({
          body: `Speed warning: ${Math.round(speed)} km/h over ${speedLimitLabel} ${Math.round(speedLimitKmh)} km/h`,
          at: Date.now(),
        });
        queueVoiceAlertForKey({
          key: 'speeding',
          ctx: {
            speedKmh: speed,
            limitKmh: speedLimitKmh,
            overKmh,
          },
          settings: latestSettings,
          cooldownMs: 60 * 1000,
        });
      } else if (latestSettings.speed_warning_enabled !== false && speed <= speedLimitKmh + speedMarginKmh) {
        recordImprovement('speeding');
      }
      if (tripBeforePoint) {
        const updated = { ...(updatedTripWithPoint || tripBeforePoint), route_points: routePointsWithLatest };
        activeTripRef.current = updated;
      }
      const trip = activeTripRef.current;
      if (!trip || !trackingRef.current || autoEndingTripRef.current) return;
      if (trip.trip_state === TRIP_STATES.CANDIDATE) {
        const decision = validateCandidateTrip({
          points: trip.route_points || [],
          startTime: trip.start_time,
          now: point.timestamp || new Date().toISOString(),
          activity: latestActivityRef.current,
          nearParkedLocation: trip.candidate_near_parked === true,
          thresholds: buildDrivingThresholds(latestSettings),
        });
        if (decision.confirmed) {
          promoteCandidateTrip(trip, decision);
        } else if (decision.discarded) {
          await discardCandidateTrip(trip, decision);
        }
        return;
      }
      const incident = detectCrashIncident({
        routePoints: trip.route_points || [],
        motionSamples: sensorFusionRef.current?.getSamples?.() || [],
        activity: latestActivityRef.current,
        settings: latestSettings,
      });
      if (!isEphemeralModeActive() && incident && Date.now() - incidentAlertRef.current > 5 * 60 * 1000) {
        incidentAlertRef.current = Date.now();
        const emergencyWorkflow = latestSettings.emergency_workflow_enabled === true;
        const workflowBody = emergencyWorkflow
          ? 'Possible incident signal recorded. Emergency check-in is active until you end or review the trip.'
          : 'Possible incident signal recorded. Check in now.';
        const incidentEvent = {
          ...incident,
          emergency_workflow_pending: emergencyWorkflow,
        };
        setHazardMessage({ body: workflowBody, at: Date.now(), persistent: emergencyWorkflow });
        notifyStayAlert({
          id: 4011,
          title: 'Possible Incident Signal',
          body: emergencyWorkflow
            ? 'Impact-like motion and little movement were recorded. Open Road Sage to check in.'
            : 'Road Sage recorded impact-like motion followed by little movement.',
          extra: { type: 'possible_crash', severity: incident.severity, emergencyWorkflow },
        }).catch((err) => {
          logError('possible_incident_notification', err, { emergencyWorkflow });
        });
        queueVoiceAlertForKey({
          key: 'possible_incident',
          ctx: { emergencyWorkflow },
          settings: latestSettings,
          cooldownMs: 5 * 60 * 1000,
        });
        setActiveTrip(prev => {
          if (!prev) return prev;
          const updated = {
            ...prev,
            driving_events: [...(prev.driving_events || []), incidentEvent],
            emergency_workflow_pending: emergencyWorkflow,
          };
          activeTripStore.set(updated);
          activeTripRef.current = updated;
          return updated;
        });
      }

      const nowMs = Date.now();
      if (speed >= 15) {
        lastMovingSpeedRef.current = speed;
        stillSinceRef.current = null;
        stoppedAnchorRef.current = null;
        return;
      }
      if (speed >= 5) {
        lastMovingSpeedRef.current = speed;
      }

      stillSinceRef.current ??= nowMs;
      stoppedAnchorRef.current ??= { lat: point.lat, lng: point.lng };
      const stillSeconds = (nowMs - stillSinceRef.current) / 1000;
      const recentPoints = (trip.route_points || []).filter((routePoint) => (
        new Date(routePoint.timestamp).getTime() >= stillSinceRef.current - 5000
      ));
      const gpsPositionDriftM = computeGpsPositionDrift(
        stoppedAnchorRef.current.lat,
        stoppedAnchorRef.current.lng,
        recentPoints
      );
      const activity = latestActivityRef.current;
      const activityStopDecision = shouldAutoStopTracking({
        activity,
        currentSpeedKmh: speed,
        stillSeconds,
        gpsPositionDriftM,
        lastMovingSpeedKmh: lastMovingSpeedRef.current,
        nowMs,
        returnReason: true,
      });
      const activityParked = activityStopDecision.shouldStop;
      const gpsParked = speed < 2 && (
        (stillSeconds >= 90 && gpsPositionDriftM < 5) ||
        (stillSeconds >= 180 && gpsPositionDriftM < 20) ||
        stillSeconds >= 300
      );

      if (activityParked || gpsParked) {
        if (activityStopDecision.reason === 'activity_recognition_stale') {
          recordTrackingDiagnostic({
            type: 'activity_recognition_stale',
            title: 'Activity recognition stale; GPS-only stop fallback used',
            reason: 'activity_state_stale',
            speed_kmh: Math.round(speed),
            stopped_seconds: Math.round(stillSeconds),
            drift_m: Math.round(gpsPositionDriftM),
          });
        }
        recordTrackingDiagnostic({
          type: 'auto_stop',
          title: 'In-app trip auto-ended',
          reason: activityParked ? activityStopDecision.reason || 'activity_parked' : 'gps_parked',
          speed_kmh: Math.round(speed),
          stopped_seconds: Math.round(stillSeconds),
          drift_m: Math.round(gpsPositionDriftM),
        });
        autoEndingTripRef.current = true;
        endTripRef.current?.();
      }
    },
    handleLocationTrackingError
  );
}, [discardCandidateTrip, handleLocationTrackingError, promoteCandidateTrip]);
```

## GPS Error Path After The Click

If GPS tracking fails because permission is denied during an active trip, the app marks the trip with data-quality flags and ends the trip.

```jsx
const markActiveTripLocationPermissionLoss = useCallback((reason = 'web_geolocation_permission_denied') => {
  const current = activeTripRef.current;
  if (!current) return null;
  const flags = new Set(Array.isArray(current.data_quality_flags) ? current.data_quality_flags : []);
  flags.add('location_permission_loss');
  const timeline = Array.isArray(current.timeline) ? current.timeline : [];
  const updated = {
    ...current,
    data_quality_flags: Array.from(flags),
    score_confidence_flag: 'data_gap_detected',
    timeline: [
      ...timeline,
      {
        type: 'location_permission_lost',
        timestamp: new Date().toISOString(),
        reason,
      },
    ],
  };
  activeTripStore.set(updated);
  activeTripRef.current = updated;
  setActiveTrip(updated);
  return updated;
}, []);

const handleLocationTrackingError = useCallback(async (err) => {
  if (err?.type !== 'permission_denied') {
    setLocationError(err?.message || 'Location tracking failed.');
    return;
  }

  setLocationError(err.message || 'Location permission was denied.');
  if (!trackingRef.current || !activeTripRef.current || locationPermissionEndingRef.current) return;

  const updated = markActiveTripLocationPermissionLoss('web_geolocation_permission_denied');
  recordTrackingDiagnostic({
    type: 'location_permission_lost',
    title: 'Location permission lost during trip',
    reason: 'web_geolocation_permission_denied',
    trip_state: updated?.trip_state || null,
    speed_kmh: Math.round(currentLocationRef.current?.speed_kmh || 0),
  });
  locationPermissionEndingRef.current = true;
  await endTripRef.current?.();
}, [markActiveTripLocationPermissionLoss]);
```

## Trip Completion Path After The Click

Once the play-button start succeeds, the trip can end in two ways:

- The active panel `End Trip` button calls `onEndTrip`, which is wired to `handleEndTrip()`.
- `startGPS()` detects parked/stopped conditions, records `auto_stop`, sets `autoEndingTripRef.current = true`, and calls `endTripRef.current?.()`.

`handleEndTrip()` then performs the full trip completion pipeline.

| Completion step | What happens |
| --- | --- |
| Stop live services | Stops location tracking, sensor fusion, timer, and long-trip reminder. |
| Load settings | Reads latest settings and driving thresholds. |
| Clean route | Uses `cleanRoutePoints()` to sanitize route points. |
| Candidate validation | Candidate trips are confirmed or discarded before saving. |
| Ending review | Records `ending_review` diagnostic. |
| Parked-tail trim | Uses `trimParkedTail()` to remove walking/GPS drift after parking. |
| Too-short discard | Discards manual or auto trips that do not meet duration/distance requirements. |
| External context | Optionally fetches speed limits and weather context. |
| Event detection | Detects driving events, phone use, crash/incident events, and sensor-fusion context. |
| Scoring | Calculates trip stats, component scores, weather-adjusted scores, economics, anomaly, and route-risk cells. |
| Stealth ending | If stealth mode is active, stores only an ephemeral summary, wipes trip objects, clears active state, and does not save history. |
| Save normal trip | Calls `tripService.create(completedTrip)`. |
| Post-save diagnostics | Records `trip_ended` with duration, distance, and parking information. |
| Parked location | Saves last parked location when the trip ends stopped. |
| Notifications | Sends trip-completed, phone-use pattern, style-shift, achievement, and fatigue notifications when applicable. |
| Cleanup | Stops activity recognition, clears `activeTripStore`, refs, state, and current location. |
| Resume Android auto | Restarts native auto tracking when appropriate. |
| Dashboard refresh | Refreshes tracking status and trip queries. |
| User message | Shows `Trip saved` or the relevant discard/stealth message. |

Key end wiring from the active panel:

```jsx
<button
  onClick={onEndTrip}
  className="w-full py-3 bg-white/15 hover:bg-white/25 backdrop-blur rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
>
  <Square className="w-4 h-4" />
  End Trip
</button>
```

Key Dashboard wiring:

```jsx
<ActiveTripPanel
  fallbackTrip={activeTrip}
  hazardMessage={hazardMessage}
  onAcknowledgeEmergency={acknowledgeEmergencyWorkflow}
  onEndTrip={() => handleEndTrip().catch((error) => {
    const message = 'Road Sage could not finish saving this trip. Keep the app open and try ending again.';
    setLocationError(message);
    notifyUserError('dashboard_end_trip', error, {
      title: 'Trip not saved yet',
      description: message,
    });
  })}
  parkedLocation={parkedLocation}
  settings={settings}
  stealthTripActive={stealthTripActive}
  units={units}
/>
```

Key auto-stop wiring from `startGPS()`:

```jsx
if (activityParked || gpsParked) {
  if (activityStopDecision.reason === 'activity_recognition_stale') {
    recordTrackingDiagnostic({
      type: 'activity_recognition_stale',
      title: 'Activity recognition stale; GPS-only stop fallback used',
      reason: 'activity_state_stale',
      speed_kmh: Math.round(speed),
      stopped_seconds: Math.round(stillSeconds),
      drift_m: Math.round(gpsPositionDriftM),
    });
  }
  recordTrackingDiagnostic({
    type: 'auto_stop',
    title: 'In-app trip auto-ended',
    reason: activityParked ? activityStopDecision.reason || 'activity_parked' : 'gps_parked',
    speed_kmh: Math.round(speed),
    stopped_seconds: Math.round(stillSeconds),
    drift_m: Math.round(gpsPositionDriftM),
  });
  autoEndingTripRef.current = true;
  endTripRef.current?.();
}
```

Key normal-save code:

```jsx
const savedTrip = await tripService.create(completedTrip);
recordTrackingDiagnostic({
  type: 'trip_ended',
  title: 'Trip saved',
  reason: completedTrip.parking_stop_detected ? 'ended_parked' : 'ended_manual_or_moving',
  tripId: savedTrip?.id || completedTrip.id,
  duration_seconds: Math.round(completedTrip.duration_seconds || 0),
  distance_km: completedTrip.distance_km || 0,
  parking_stop_duration_seconds: completedTrip.parking_stop_duration_seconds || 0,
});
await invalidateDangerZoneCache();
```

Key final cleanup code:

```jsx
await activityStopRef.current?.();
activityStopRef.current = null;
latestActivityRef.current = null;
activeTripStore.clear();
activeTripRef.current = null;
trackingRef.current = false;
autoEndingTripRef.current = false;
locationPermissionEndingRef.current = false;
setActiveTrip(null);
setTracking(false);
currentLocationRef.current = null;
if (isAndroid() && !cfg.tracking_paused && (tripToEnd.resume_native_auto || cfg.tracking_mode === 'background_auto')) {
  await startNativeAutoTracking().catch((err) => {
    logNativeAutoStartFailure(err, cfg, { reason: 'resume_after_trip_saved' });
  });
}
refreshTrackingStatusContext();
refetch();
notifyUserSuccess('dashboard_end_trip', {
  title: 'Trip saved',
  description: 'Your drive is now available in Trip History.',
});
```

## After Successful Click

When `setTracking(true)` runs, the Dashboard switches from the idle box to `ActiveTripPanel`.

The active box shows:

| Active box part | Display |
| --- | --- |
| Status | `Trip Active`, `Checking Movement`, or `Stealth Trip Active` |
| Timer | Live elapsed duration from `ElapsedClock` |
| Detail | Stealth warning, candidate validation text, trip distance/average speed, or `Getting GPS signal...` |
| Icon | `Car` |
| Speed row | Current speed, over-limit warning, GPS accuracy |
| Map | `TripMap` with route points and current location |
| Fatigue alert | Appears on long trips if recent driving quality dips |
| Hazard message | Appears for recent or persistent live safety warnings |
| Emergency check-in | Appears when a possible crash event is pending |
| End button | Calls `onEndTrip`, which is wired to `handleEndTrip()` |

Relevant active panel code:

```jsx
const ActiveTripPanel = memo(function ActiveTripPanel({
  fallbackTrip,
  hazardMessage,
  onAcknowledgeEmergency,
  onEndTrip,
  parkedLocation,
  settings,
  stealthTripActive,
  units,
}) {
  const activeTripSnapshot = useActiveTripSnapshot();
  const subscribedTrip = activeTripSnapshot.trip;
  const liveVersion = activeTripSnapshot.version;
  const activeTrip = subscribedTrip || fallbackTrip;
  const routePoints = activeTrip?.route_points || [];
  const currentLocation = routePoints.at(-1) || null;
  const activeTripIsCandidate = activeTrip?.trip_state === TRIP_STATES.CANDIDATE;
  const thresholds = useMemo(() => buildDrivingThresholds(settings), [settings]);
  const tripStats = useMemo(() => (
    routePoints.length
      ? calculateTripStats(routePoints, activeTrip.start_time, new Date().toISOString(), thresholds)
      : null
  ), [activeTrip?.start_time, liveVersion, routePoints, thresholds]);

  return (
    <motion.div
      key="active"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-3xl p-6 text-white shadow-2xl"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 bg-red-400 rounded-full animate-pulse" />
            <span className="text-white/80 text-sm font-medium">
              {stealthTripActive ? 'Stealth Trip Active' : activeTripIsCandidate ? 'Checking Movement' : 'Trip Active'}
            </span>
          </div>
          <div className="font-grotesk font-bold text-4xl">
            <ElapsedClock startTime={activeTrip?.start_time} />
          </div>
          <div className="text-white/70 text-sm mt-1">
            {stealthTripActive ? (
              'RAM-only recording. It will be erased if the app closes or backgrounds.'
            ) : activeTripIsCandidate ? (
              activeTrip?.candidate_near_parked
                ? 'Hidden candidate near parked car'
                : 'Hidden candidate validating movement'
            ) : tripStats ? (
              `${formatDistance(tripStats.distance_km, units)} - ${formatSpeed(tripStats.avg_speed_kmh, units)} avg`
            ) : 'Getting GPS signal...'}
          </div>
        </div>
        <div className="p-3 bg-white/10 rounded-2xl">
          <Car className="w-8 h-8" />
        </div>
      </div>

      {currentLocation && (() => {
        const spd = currentLocation.speed_kmh || 0;
        const overLimit = settings.threshold_speeding_kmh || 100;
        const warnOffset = settings.threshold_speed_over_kmh ?? 5;
        const speedWarningsEnabled = settings.speed_warning_enabled !== false;
        const isOverWarn = speedWarningsEnabled && spd > overLimit + warnOffset;
        return (
          <div className="flex items-center gap-2 text-sm mb-4">
            <MapPin className="w-3.5 h-3.5 text-white/70" />
            <span className={`font-semibold ${isOverWarn ? 'text-red-300 animate-pulse' : 'text-white/70'}`}>
              {formatSpeed(spd, units)}{isOverWarn ? ' Over limit!' : ''}
            </span>
            <span className="opacity-50 text-white/70">-</span>
            <span className="text-white/70">Acc: {Math.round(currentLocation.accuracy || 0)}m</span>
          </div>
        );
      })()}

      {(routePoints.length > 0 || currentLocation) && (
        <div className="mb-4 overflow-hidden rounded-2xl border border-white/15 bg-white/10">
          <TripMap
            routePoints={routePoints}
            currentLocation={currentLocation}
            showCurrentLocation
            parkedLocation={activeTripIsCandidate ? parkedLocation : null}
            smoothRoute={false}
            height="220px"
          />
        </div>
      )}
    </motion.div>
  );
});
```

## Diagnostics Explanation Code

File: `src/lib/trackingDiagnostics.js`

```js
if (!autoEnabled) {
  return {
    status: mode === 'paused' ? 'bad' : 'warn',
    headline: mode === 'paused' ? 'Tracking will not start' : 'Auto tracking is off',
    detail: mode === 'paused'
      ? 'Unpause tracking in Settings before manual or automatic trips can start.'
      : 'Manual mode will not start trips by itself. Tap Start Trip or switch to auto-detect/background auto.',
    facts,
    lastDecision,
  };
}

if (blockerDetails.length > 0) {
  return {
    status: blockerDetails.some((detail) => detail.includes('not granted') || detail.includes('paused')) ? 'bad' : 'warn',
    headline: 'Auto tracking did not start',
    detail: blockerDetails[0],
    facts: [...facts, ...blockerDetails.slice(1)],
    lastDecision,
  };
}
```

The diagnostics layer can already produce a bad or warning state. The idle card does not consume that state for its headline.

## Reproduction Path

1. Open the Dashboard while no trip is active.
2. Pause tracking in Settings, or select Android background auto with one required permission or native-service state missing.
3. Return to Dashboard.
4. Observe that the idle card still says `Ready to drive?`.
5. Optional: tap the play button while tracking is paused.
6. Observe that `handleStartTrip` blocks the trip and reports `Tracking is paused in Settings.`

## Expected Behavior

The idle card should derive its label and supporting copy from readiness state.

Suggested mapping:

| State | Headline |
| --- | --- |
| `trackingReadiness.ready === true` | `Ready to drive?` |
| `effectiveTrackingMode === 'paused'` | `Tracking is paused` |
| Missing required manual-start permission | `Setup needed before driving` |
| Background-auto degraded | `Background tracking needs attention` |
| Native Android service not armed | `Background service is not armed` |

The start button should also consider a disabled or setup-action state when the first blocker is actionable.

## Likely Fix Area

Update the idle card in `src/pages/Dashboard.jsx` to use `trackingReadiness` and/or `trackingExplanation` for:

- top label
- primary title
- helper text
- button enabled state or action
- status tone

The smallest possible fix is to replace the hard-coded label with a derived value:

```jsx
const idleTripLabel = trackingReadiness.ready ? 'Ready to drive?' : trackingReadiness.headline;
const idleTripDetail = trackingReadiness.ready
  ? 'Tap to begin tracking your route'
  : trackingReadiness.detail;
```

Then render:

```jsx
<div className="text-muted-foreground text-sm mb-1">{idleTripLabel}</div>
<div className="font-grotesk font-bold text-xl">
  {trackingReadiness.ready ? 'Start a new trip' : 'Check tracking setup'}
</div>
<div className="text-muted-foreground text-xs mt-1">{idleTripDetail}</div>
```

## Tests To Update

Current tests assert the static text:

```js
await expect(page.getByText(/Ready to drive|Recent Trips|Driving Score/i).first()).toBeVisible();
```

```js
{ path: '/', label: 'Dashboard', requiredText: ['Dashboard', 'Ready to drive?', 'Recent Trips'] }
```

Tests should include at least:

- ready manual-start state shows `Ready to drive?`
- paused tracking state does not show `Ready to drive?`
- paused tracking state shows `Tracking is paused`
- background-auto degraded state shows a setup-needed message
- tapping start while paused surfaces the blocked state without implying readiness
