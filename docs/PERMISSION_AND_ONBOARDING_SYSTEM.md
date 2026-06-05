# Permission And Onboarding System Contract

Last reviewed: 2026-06-05

This document is the source-of-truth guide for Road Sage first-run onboarding, runtime permissions, Android setup handoffs, post-onboarding permission UI, and the code paths that keep those states synchronized. Use it when changing onboarding copy, adding a permission, reviewing Android tracking readiness, or debugging why a feature is shown as unavailable after onboarding.

## Scope

This system includes:

- First-run onboarding in `src/pages/Onboarding.jsx`.
- Permission status reads and request functions in `src/lib/permissions.js`.
- Permission state normalization in `src/lib/permissionStateMachine.js`.
- App-wide permission context in `src/lib/permissions/PermissionContext.jsx`.
- Settings and marker persistence in `src/lib/trackingStore.js`, `src/lib/mobileStorage.js`, and the native encrypted storage mirror.
- Android permission declarations and service gates in `android/app/src/main/AndroidManifest.xml`.
- Native plugin permission/status/settings bridge in `android/app/src/main/java/com/roadsage/app/DriveSenseActivityRecognitionPlugin.java`.
- Post-onboarding surfaces in Dashboard, Settings, Trip Detail, Diagnostics, and Android quick settings.

Onboarding is complete only when Road Sage saves:

```text
localSettings.onboarding_completed = true
localStorage[road_sage_onboarding_completed_v1] = true
mobileStorage[road_sage_onboarding_completed_v1] = true
EncryptedCapacitorPlugin[road_sage_onboarding_completed_v1] = true when available
```

The completion marker is intentionally duplicated because Android native hydration may lag behind WebView startup.

## Core Files

| File | Responsibility |
| --- | --- |
| `src/App.jsx` | Decides whether to show onboarding, reads completion markers, wraps the app in `PermissionProvider`, starts native auto tracking after launch hydration when appropriate. |
| `src/pages/Onboarding.jsx` | First-run wizard, visible permission buttons, tracking mode choice, data-leaving-app opt-ins, setup checklist, completion persistence. |
| `src/lib/permissions.js` | Permission cache, native/browser status reads, request functions, denial escalation, stored setting patches, permission explanations. |
| `src/lib/permissionStateMachine.js` | Canonical states and allowed transitions. |
| `src/lib/permissions/PermissionContext.jsx` | Shared permission snapshot and refresh behavior after focus/visibility changes. |
| `src/lib/permissions/usePermissionRequest.js` | Reusable rationale/request hook for permission-request UI. |
| `src/hooks/usePermissionMonitor.js` | Dashboard monitor for missing tracking requirements after onboarding. |
| `src/settings/sections/TrackingSettings.jsx` | Settings UI for tracking mode, Android permissions, feature-permission explanations, notifications. |
| `src/components/PermissionWarningBanner.jsx` | Dashboard warning when background/auto tracking requirements are missing. |
| `src/components/PhoneUsePermissionBanner.jsx` | Trip Detail prompt when Android Usage Access is missing for phone-use scoring. |
| `src/components/TrackingHealthChip.jsx` | Compact background tracking health indicator. |
| `src/pages/Diagnostics.jsx` | Developer diagnostics for permission, native service, battery, and motion sensor readiness. |
| `android/app/src/main/AndroidManifest.xml` | Android permission declarations, foreground services, receivers, quick settings tile permission gates. |
| `android/app/src/main/java/com/roadsage/app/DriveSenseActivityRecognitionPlugin.java` | Native methods called by JS for activity/background/battery/usage-access status and settings. |

## Launch Flow

`src/App.jsx` owns the launch decision.

```text
AuthenticatedApp mounts
  -> configureNotificationChannels()
  -> localSettings.get()
  -> hasCompletedOnboarding(settings)
    -> true if settings.onboarding_completed === true
    -> else true if localStorage[ONBOARDING_COMPLETED_KEY] === true
    -> else true if mobileStorage marker returns true before timeout
  -> if false: render <Onboarding onComplete={...} />
  -> if true: render normal app routes inside Layout
```

Important launch details:

- Android marker read timeout is intentionally short: `LAUNCH_ONBOARDING_MARKER_TIMEOUT_MS = 500`.
- Android native settings hydration happens once quickly, then again after a delay.
- If hydrated settings show `tracking_mode === 'background_auto'` and tracking is not paused, `ensureNativeAutoTrackingStarted()` tries to arm native auto tracking.
- The entire app is wrapped in `<PermissionProvider>` after auth/query providers.

Relevant code:

```jsx
if (!onboardingDone) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="*" element={<Onboarding onComplete={() => setOnboardingDone(true)} />} />
      </Routes>
    </Suspense>
  );
}
```

## First-Run Onboarding Screens

The onboarding step list is defined in `src/pages/Onboarding.jsx` at `STEPS`.

| Order | Step id | User-visible title | Purpose | Main buttons and controls |
| ---: | --- | --- | --- | --- |
| 1 | `welcome` | `Welcome to Road Sage` | Introduces local-first driving companion. | `Continue` |
| 2 | `location` | `Location Access` | Requests foreground location for route, speed, distance, events, and parking. | `Grant Location Access`, `Continue`, `Skip for now` |
| 3 | `data_leaving` | `Data Leaving App` | Lets the user opt into optional external map/road/weather/route-snapping requests. | Option buttons for `Maps`, `Road/weather context`, `Route snapping`, `Continue`, `Skip for now` |
| 4 | `activity` | `Motion & Activity` | Requests motion sensor permission where required and Android Physical Activity. | `Enable Motion & Activity` on Android, `Enable Motion Sensors` elsewhere, `Continue`, `Skip for now` |
| 5 | `notifications` | `Notifications` | Requests notification permission for trip, safety, reminder, and report notices. | `Enable Notifications`, `Continue`, `Skip for now` |
| 6 | `tracking_mode` | `Tracking Mode` | Selects tracking behavior and exposes the full setup checklist. | `Enable all recommended permissions`, `Open Phone Usage Access` on Android, mode buttons, checklist row buttons, `Get Started` |

### Data Leaving App Choices

All optional external-data choices start off.

| Choice id | User label | Leaves the device | Receiver | Saved setting |
| --- | --- | --- | --- | --- |
| `maps` | `Maps` | Visible map tile areas and network metadata. | OpenStreetMap tile hosts. | `map_tiles_enabled` |
| `road_weather` | `Road/weather context` | Route-area boxes for road data and one privacy-guarded point/date for weather. | OpenStreetMap Overpass and Open-Meteo. | `speed_limit_lookup_enabled`, `weather_context_enabled` |
| `route_snapping` | `Route snapping` | Sampled GPS coordinate pairs from selected trips after endpoint setup. | User-verified OSRM endpoint. | `map_matching_enabled` |

The final tracking-mode checklist also has `Automatic road data`, which writes:

```js
external_context_auto_fetch_enabled: roadDataAutoFetch === true && dataLeavingChoices.road_weather === true
```

This protects against enabling automatic external road/weather fetches unless the broader road/weather choice is also enabled.

### Tracking Mode Choices

| Mode id | User label | User copy | Default/recommendation | Saved behavior |
| --- | --- | --- | --- | --- |
| `manual` | `Manual Only` | `Tap "Start Trip" to begin tracking. No background activity.` | Not recommended. | `auto_tracking_enabled = false`, `background_tracking_enabled = false` |
| `auto_detect` | `Auto-Detect` | `App detects when you start driving while open in foreground.` | Recommended on non-Android. | `auto_tracking_enabled = true`, `background_tracking_enabled = false` |
| `background_auto` | `Background Auto` | `Tracks trips automatically, even when app is closed. Uses more battery.` | Default on Android. | `auto_tracking_enabled = true`, `background_tracking_enabled = true` |

### Setup Checklist Rows

These rows are shown on the final onboarding screen. They remain the clearest single inventory of what Road Sage believes must be ready.

| Row | Visible detail | Ready when | Action |
| --- | --- | --- | --- |
| `Location` | `Required for routes, speed, distance, and parking.` | `foregroundLocation === 'granted'` | `handleLocationRequest()` |
| `Motion and activity` | Android: `Confirms driving and powers Android auto detection.` Else: `Improves movement and incident detection where available.` | Motion granted and Android activity granted where needed. | `handleMotionActivityRequest()` |
| `Notifications` | `Shows trip, safety, reminder, and report updates.` | `notifications === 'granted'` | `handleNotificationRequest()` |
| `Background location` | `Needed for automatic trip capture while the app sleeps.` | Android background location granted. Only shown on Android when `trackingMode === 'background_auto'`. | `handleBackgroundLocationRequest()` |
| `Battery unrestricted` | `Helps Android keep background auto tracking alive.` | Android battery optimization ignored. Only shown on Android background auto. | `handleBatterySetup()` |
| `Phone Usage Access` | `Optional, but makes phone-use detection measured instead of inferred.` | Android Usage Access granted. | `handleUsageAccessSetup()` |
| `Automatic road data` | External road/weather auto fetch copy. | `roadDataAutoFetch === true` | `enableRoadDataAutoFetch()` |

The row component renders either a green `Ready` badge or a button with `Set up`, `Open`, or `Enable`.

## Completion Persistence

`persistOnboardingComplete()` updates settings and completion markers:

```jsx
localSettings.update({
  onboarding_completed: true,
  tracking_mode: trackingMode,
  auto_tracking_enabled: trackingMode !== 'manual',
  background_tracking_enabled: trackingMode === 'background_auto',
  map_tiles_enabled: dataLeavingChoices.maps === true,
  map_tiles_first_prompt_seen: true,
  speed_limit_lookup_enabled: dataLeavingChoices.road_weather === true,
  weather_context_enabled: dataLeavingChoices.road_weather === true,
  external_context_auto_fetch_enabled: roadDataAutoFetch === true && dataLeavingChoices.road_weather === true,
  map_matching_enabled: dataLeavingChoices.route_snapping === true,
});

localStorage.setItem(ONBOARDING_COMPLETED_KEY, JSON.stringify(true));
await setJson(ONBOARDING_COMPLETED_KEY, true);
await encryptedPlugin.set({ key: ONBOARDING_COMPLETED_KEY, value: JSON.stringify(true) });
```

Completion does not require every permission to be granted. The user can skip and finish later in Settings. If `trackingMode === 'background_auto'` and background location is already granted, onboarding calls `startNativeAutoTracking()` during finalization.

## Permission State Model

Canonical states live in `src/lib/permissionStateMachine.js`:

```js
export const PERMISSION_STATES = Object.freeze({
  UNKNOWN: 'unknown',
  REQUESTING: 'requesting',
  GRANTED: 'granted',
  DENIED: 'denied',
  NEEDS_SETTINGS: 'needs_settings',
  NOT_REQUESTED: 'not_requested',
  UNAVAILABLE: 'unavailable',
});
```

Important rules:

- `true` normalizes to `granted`.
- `false` and `null` normalize to `unknown`, not `denied`.
- `needs_settings` is a first-class state and should not be converted to `denied`.
- The reducer in `PermissionContext` uses `transitionPermissionState()` for single updates and `normalizePermissionState()` for full refreshes.
- `needs_settings -> requesting` is not valid. A permission in `needs_settings` should open settings instead of showing another prompt.

## Permission Status Read Pipeline

`getPermissionStatus(permissionType, options)` is the shared status read function.

Key behavior:

- Status cache TTL is 10 seconds.
- `force: true` bypasses cache.
- Concurrent non-forced reads share `statusRefreshInFlight`.
- Reads persist a settings patch by default, unless `persist: false`.
- Stored setting fallback is used when native/browser status is unknown.
- Denials may be promoted to `needs_settings` if the stored setting has already reached that state.

Status object shape:

```js
{
  foregroundLocation: 'unknown',
  backgroundLocation: 'unknown',
  activityRecognition: 'unknown',
  notifications: 'unknown',
  phoneUsageAccess: 'unknown',
  motionSensors: 'unknown',
  bluetooth: 'unknown',
}
```

Read sources:

| Permission key | Browser source | Native Android source | Stored fallback |
| --- | --- | --- | --- |
| `foregroundLocation` | `navigator.permissions.query({ name: 'geolocation' })` | `Geolocation.checkPermissions().location` | `location_permission_granted` |
| `backgroundLocation` | Not available | `ActivityRecognition.checkPermissions().backgroundLocation` | `background_location_granted` |
| `activityRecognition` | Not available | `ActivityRecognition.checkPermissions().activityRecognition` | `activity_permission_granted` |
| `notifications` | `Notification.permission` | `LocalNotifications.checkPermissions().display` | `notification_permission_granted` |
| `phoneUsageAccess` | Not available | `ActivityRecognition.usageAccessStatus().usageAccessGranted` | `phone_usage_access_granted` |
| `motionSensors` | `getMotionSensorSupport().status` | Same JS support helper, Android usually no separate prompt | No dedicated persisted key |
| `bluetooth` | `getObdBluetoothSupport()` | `ActivityRecognition.checkPermissions().bluetoothConnect` | Feature support fallback |

Stored patch mapping:

```js
{
  location_permission_granted,
  notification_permission_granted,
  activity_permission_granted,
  background_location_granted,
  phone_usage_access_granted,
}
```

## Permission Request Functions

| Function | Platform | Writes | Denial behavior | Special behavior |
| --- | --- | --- | --- | --- |
| `requestForegroundLocationPermission()` | Browser and native | `location_permission_granted`, `_location_denial_count` | On Android, second denial becomes `needs_settings`. | Browser uses `navigator.geolocation.getCurrentPosition()` to trigger prompt. |
| `requestNotificationPermission()` | Browser and native | `notification_permission_granted`, `_notification_denial_count` | On Android, second denial becomes `needs_settings`. | Native uses Capacitor Local Notifications. |
| `requestActivityRecognitionPermission()` | Android only | `activity_permission_granted`, `_activity_denial_count` | Second denial becomes `needs_settings`. | Returns `false` off Android. |
| `requestBackgroundLocationPermission()` | Android and fallback | `background_location_granted` | Failed Android setup stores `needs_settings`. | Requires foreground location, then notifications, then requests background location. Opens app location settings when not granted. |
| `requestBluetoothPermission()` | Android and fallback | Cache only | Returns false on plugin errors. | Used for optional OBD-II Bluetooth/Nearby Devices path. |

The background location request order is deliberate:

```text
invalidate cache
  -> if background already granted, save true
  -> request foreground location
  -> request notifications
  -> ActivityRecognition.requestBackgroundLocation()
  -> if still not granted, save needs_settings and open app location settings
```

Onboarding adds an extra guard before background location:

- Foreground location must already be granted.
- Notifications must already be granted.
- Android permission prompts are serialized with `permissionRequestInFlightRef`.
- Each setup request has a 25 second timeout and a 650 ms settle delay.

## Android Manifest Permission Surface

Declared permissions in `android/app/src/main/AndroidManifest.xml`:

| Android permission | Why it exists |
| --- | --- |
| `android.permission.INTERNET` | Map tiles, optional open road/weather context, endpoint health checks, app network needs. |
| `android.permission.ACCESS_NETWORK_STATE` | Network-aware fetch behavior and diagnostics. |
| `android.permission.ACCESS_FINE_LOCATION` | Precise trip tracking, speed, distance, routes, parking location. |
| `android.permission.ACCESS_COARSE_LOCATION` | Android location permission compatibility. |
| `android.permission.ACCESS_BACKGROUND_LOCATION` | Background auto tracking when app is minimized or closed. |
| `android.permission.ACTIVITY_RECOGNITION` | Physical Activity signals for native auto tracking. |
| `android.permission.POST_NOTIFICATIONS` | Android 13+ persistent tracking notification and app notifications. |
| `android.permission.BLUETOOTH`, `BLUETOOTH_ADMIN` | Legacy Bluetooth support through Android 11. |
| `android.permission.BLUETOOTH_CONNECT` | Android 12+ OBD-II Bluetooth connection support. |
| `android.permission.BLUETOOTH_SCAN` with `neverForLocation` | Bluetooth scan without using scan results as location. |
| `android.permission.FOREGROUND_SERVICE` | Foreground tracking service. |
| `android.permission.FOREGROUND_SERVICE_LOCATION` | Android foreground service location type. |
| `android.permission.RECEIVE_BOOT_COMPLETED` | Resume native tracking/widget behavior after reboot. |
| `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | User handoff to unrestricted battery settings. |
| `android.permission.SCHEDULE_EXACT_ALARM` | Reminder/notification scheduling where needed. |
| `android.permission.PACKAGE_USAGE_STATS` | Protected Usage Access for measured phone-use evidence. |

Exported Android components and permission gates:

| Component | Exported | Permission gate |
| --- | --- | --- |
| `.MainActivity` | `true` | Launcher activity. |
| `.DriveSenseActivityReceiver` | `false` | `com.google.android.gms.permission.ACTIVITY_RECOGNITION` |
| `.ParkedCarWidgetProvider` | `true` | `android.permission.BIND_APPWIDGET` |
| `com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService` | `false` | Foreground service type `location`. |
| `.RoadSageAutoTrackingService` | `false` | Foreground service type `location`. |
| `.DriveSenseAutoTrackingTileService` | `true` | `android.permission.BIND_QUICK_SETTINGS_TILE` |

The app must not add broad storage permissions such as `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, or `MANAGE_EXTERNAL_STORAGE`.

## Native Bridge Contract

`src/lib/driveSenseNativePlugin.js` registers:

```js
const DriveSenseActivityRecognition = registerPlugin('DriveSenseActivityRecognition');
```

JS callers in `src/lib/activityRecognition.js` and `src/lib/permissions.js` use these native methods:

| Native method | JS wrapper/caller | Purpose |
| --- | --- | --- |
| `checkPermissions()` | `getPermissionStatus()`, `currentPermissionState()` | Reads activity, background location, and Bluetooth permission status. |
| `requestPermissions()` | `requestActivityRecognitionPermission()` | Requests Physical Activity. |
| `requestBackgroundLocation()` | `requestBackgroundLocationPermission()` | Requests or routes user toward Android background location setup. |
| `requestBluetoothPermission()` | `requestBluetoothPermission()` | Requests Bluetooth/Nearby Devices for OBD-II. |
| `startNativeAutoTracking()` | `startNativeAutoTracking()` | Arms native auto tracking. |
| `nativeAutoTrackingStatus()` | `getNativeAutoTrackingStatus()` | Reads whether native auto tracking is armed. |
| `openAppLocationSettings()` | background location failure path, `openAndroidLocationSettings()` | Opens app location settings. |
| `openBatteryOptimizationSettings()` | `openAndroidBatteryOptimizationSettings()` | Opens Android battery settings. |
| `batteryOptimizationStatus()` | `getAndroidBatteryOptimizationStatus()` | Reads unrestricted battery state. |
| `usageAccessStatus()` | `getAndroidUsageAccessStatus()`, permission status read | Reads Usage Access. |
| `openUsageAccessSettings()` | `openAndroidUsageAccessSettings()` | Opens Android Usage Access screen. |
| `saveSettings(settingsJson)` | `localSettings.setAsync()` native mirror | Saves settings to encrypted Android preferences. |

## Settings Keys

These are the permission/onboarding keys in `DEFAULT_SETTINGS` and related settings.

| Key | Default | Written by | Consumed by |
| --- | --- | --- | --- |
| `onboarding_completed` | `false` | Onboarding completion, privacy wipe/migrations | App launch route gate |
| `tracking_mode` | `manual` | Onboarding, Settings tracking mode | Dashboard, tracking service, native auto tracking |
| `auto_tracking_enabled` | mode-derived | Onboarding, Settings | Dashboard auto detection |
| `background_tracking_enabled` | mode-derived | Onboarding, Settings | Dashboard/native background tracking |
| `tracking_paused` | false unless changed | Settings | Dashboard and permission monitor |
| `location_permission_granted` | `false` | Permission status/request flows | Dashboard setup readiness, tracking status |
| `background_location_granted` | `false` | Permission status/request flows | Background tracking setup, diagnostics |
| `activity_permission_granted` | `false` | Permission status/request flows | Auto tracking readiness |
| `notification_permission_granted` | `false` | Permission status/request flows | Notifications settings, background service requirements |
| `phone_usage_access_granted` | `false` | Permission status read | Phone-use scoring availability |
| `_location_denial_count` | implicit | Foreground location request | Denial escalation |
| `_notification_denial_count` | implicit | Notification request | Denial escalation |
| `_activity_denial_count` | implicit | Activity request | Denial escalation |
| `map_tiles_enabled` | `false` | Data Leaving App choice | Map rendering/network policy |
| `map_tiles_first_prompt_seen` | `false` or unset before first consent | Onboarding | Map consent UX |
| `speed_limit_lookup_enabled` | `false` | Data Leaving App choice | Road/speed-limit context |
| `weather_context_enabled` | `false` | Data Leaving App choice | Weather context |
| `external_context_auto_fetch_enabled` | `false` | Onboarding road data row, Settings | Automatic open road/weather fetch |
| `map_matching_enabled` | `false` | Data Leaving App choice, Settings | OSRM route matching |

## Post-Onboarding UI Surfaces

### Settings: Tracking

Located in `src/settings/sections/TrackingSettings.jsx`.

Visible controls:

- `Tracking Mode` buttons: `Manual Only`, `Auto-Detect`, `Background Auto`.
- `Pause All Tracking` toggle.
- `Auto-Tracking` toggle.
- `Background Tracking` toggle.

`enableTrackingMode(mode)` in `src/pages/Settings.jsx` requests needed permissions before saving the mode. For `background_auto`, it requests foreground location, Android activity, notifications, and background location, then tries to start native auto tracking.

### Settings: Android Permissions

Visible rows:

- `Native Auto Tracking` badge.
- `Location` badge and `Enable` button.
- `Background Location` badge and `Enable` button.
- `Physical Activity` badge and `Enable` button.
- `Notifications` badge and `Enable` button.
- `Motion Sensors` badge and `Enable` button.
- `Bluetooth / Nearby Devices` badge and `Enable` button.
- `Phone Usage Access` badge and `Enable` button on Android.
- `Battery Optimization` row with chevron to open Android battery settings.

Each row uses `PermissionBadge` and refreshes status after the action.

### Settings: Feature Permissions

Visible rows explain whether feature groups require any extra Android prompt:

- Trip history/search/tags/notes/favorites/calendar/weekly summary/goals/costs: no new prompt.
- Route comparison/commute detection/road types/parking/repeated event areas: location.
- Maintenance reminders and weekly driver digests: notifications only for reminder notifications.
- Background auto tracking: background location, activity, notifications.
- Sensor fusion/crash detection/phone movement/incident check-in: motion and activity context.
- Real speed limits/weather/OSRM/offline route previews: network or cached route data, with OSRM off until endpoint setup.
- Live voice alerts and driving coach summaries: on-device, no microphone/cloud permission.
- OBD-II Bluetooth diagnostics: optional Bluetooth/Nearby Devices.

### Dashboard Permission Warning

`usePermissionMonitor(effectiveTrackingMode)` runs:

- Immediately on mount.
- Every 60 seconds.
- On window focus.
- On document visibility returning to visible.

It builds issues for:

- Missing foreground location.
- Missing Android Physical Activity.
- Missing background location in background auto.
- Missing notifications in background auto.
- Battery optimization restricting Road Sage in background auto.
- Permission check failure.

`PermissionWarningBanner` shows:

- Title: `Background tracking may be unreliable`.
- Summary count.
- `Re-check` button.
- Expandable details with Android settings hints.

### Tracking Health Chip

`TrackingHealthChip` appears only for `trackingMode === 'background_auto'`.

It reports ready only when:

```js
nativeStatus?.enabled === true &&
permissions?.backgroundLocation === 'granted' &&
permissions?.activityRecognition === 'granted' &&
batteryOptimizationIgnored === true
```

Otherwise it summarizes missing items such as background location, activity permission, native service off, or battery restricted.

### Trip Detail Phone Usage Access Banner

`PhoneUsePermissionBanner` appears when a trip cannot include confirmed Android phone-use evidence because Usage Access is missing.

Visible copy:

- `Phone use could not be measured for this trip - Android Usage Access is not enabled.`
- `Your Safety score does not include a phone-use signal.`
- Button: `Enable Usage Access`.

This banner calls `openAndroidUsageAccessSettings()`.

### Diagnostics

Diagnostics reads:

- `getPermissionStatus()`
- `getNativeAutoTrackingStatus()`
- `getAndroidBatteryOptimizationStatus()`
- Native diagnostics log
- Motion sensor diagnostics

It exposes a motion permission `Request permission` button when sensors are available but permission is not granted.

## Required Permission By Feature

| Feature | Required | Optional/enhancing | Missing behavior |
| --- | --- | --- | --- |
| Manual trip recording | Foreground location | Motion sensors | Start fails or records permission-denied error if location is missing. |
| Foreground auto detect | Foreground location | Physical Activity on Android, motion sensors | Auto detect may not start or may use GPS fallback. |
| Background auto tracking | Foreground location, background location, notifications, Physical Activity on Android, foreground service declarations | Battery unrestricted | Dashboard/Settings warn; native service may not arm or remain reliable. |
| Parking location | Foreground location | Widget receiver after app setup | Parking reminders unavailable without location. |
| Phone-use scoring | Android Usage Access | GPS proxy diagnostics | Safety score excludes confirmed phone-use signal; banner prompts user. |
| Motion/crash/sensor fusion | Motion sensor support and permission when platform requires it | Android Physical Activity context | Feature reports inactive reason `permission missing`. |
| OBD-II diagnostics | Bluetooth/Nearby Devices where Android requires it | Compatible adapter | OBD pairing unavailable or remains diagnostic-only. |
| Notifications/reminders | Notification permission for system notifications | Quiet hours/channel settings | In-app pages still work; notifications disabled or not scheduled. |
| Maps | User consent through `map_tiles_enabled` | Network availability | Map tiles are disabled or unavailable. |
| Road/weather context | User consent through speed/weather/external context settings | Privacy-zone eligibility | Context skipped or unavailable, not treated as low risk. |
| OSRM route snapping | Verified OSRM endpoint and `map_matching_enabled` | Endpoint health | Route snapping remains off. |

## Failure And Edge Cases

| Case | Expected behavior |
| --- | --- |
| User taps a permission button while another Android prompt is active | Onboarding throws `permission_request_busy` and keeps setup status visible. |
| Android prompt hangs longer than 25 seconds | Onboarding shows timeout copy and lets user retry the row or continue. |
| User denies location twice on Android | Stored state becomes `needs_settings`; later reusable request UI should open settings. |
| Background location requested before foreground location | Onboarding shows `Grant foreground location first, then retry background location.` |
| Background location requested before notifications | Onboarding shows `Enable notifications first, then retry background location.` |
| Background location not granted after native request | Store `needs_settings` and open app location settings. |
| Completion marker save to mobile storage fails | Setup is still saved in local settings; user sees a non-blocking error message. |
| Native settings hydration says onboarding false after local marker true | App keeps onboarding complete and updates settings marker. |
| Tracking mode background auto but battery restricted | App can finish onboarding, but Dashboard/Settings show reliability warnings. |
| Usage Access missing | Phone-use score is unavailable; GPS proxy remains diagnostic-only. |

## Code Snippets For Implementers

### Add A New Permission Key

```js
// src/lib/permissions/PermissionContext.jsx
export const PERMISSION_KEYS = Object.freeze([
  'foregroundLocation',
  'backgroundLocation',
  'notifications',
  'activityRecognition',
  'phoneUsageAccess',
  'bluetooth',
  'motionSensors',
  'newPermissionKey',
]);
```

Then update:

```text
src/lib/permissions.js
  unknownPermissionStatus()
  readPermissionStatus()
  currentPermissionState()
  requestNewPermission()
  settingsPatchForStatus() if persisted
  getPermissionExplanation()

src/lib/trackingStore.js
  DEFAULT_SETTINGS
  validation/import/migration rules if persisted

src/pages/Onboarding.jsx
  setup checklist or step if first-run critical

src/settings/sections/TrackingSettings.jsx
  Android Permissions or Feature Permissions row

android/app/src/main/AndroidManifest.xml
  uses-permission when native Android needs it

tests
  permission state tests
  monitor tests
  Android UIAutomator coverage when visible in app
```

### Safe Button Pattern

```jsx
<button
  type="button"
  onClick={async (event) => {
    event.stopPropagation();
    await requestPermission();
    await refreshPermissions();
  }}
  disabled={requesting}
>
  Enable
</button>
```

### Recommended Setup Pattern

```text
set tracking mode to recommended platform default
request one permission at a time
refresh status after prompts
do not auto-open Usage Access settings in the same prompt chain
show remaining checklist rows instead of blocking completion
```

## Verification Matrix

| Layer | What to verify | Suggested command or test |
| --- | --- | --- |
| State machine | Normalization, `needs_settings` transitions | `npm.cmd test -- src/lib/__tests__/permissionStateMachine.test.js` |
| Permission monitor | Required issues by tracking mode | `npm.cmd test -- src/hooks/__tests__/usePermissionMonitor.test.js` |
| Tracking service | Permission denied behavior | `npm.cmd test -- src/lib/__tests__/trackingService.test.js` |
| Tracking diagnostics | Health output from permission/native/battery state | `npm.cmd test -- src/lib/__tests__/trackingDiagnostics.test.js` |
| Settings defaults/import | Permission/settings keys exist and sanitize correctly | `npm.cmd test -- src/lib/__tests__/trackingStoreDefaults.test.js src/lib/__tests__/settingsImportSecurity.test.js` |
| Android static manifest | Declared permissions and absence of broad storage permissions | Covered by `tests/android-uiautomator-full-app.mjs` static checks |
| Onboarding UI | Steps, skip, setup checklist, marker persistence, relaunch behavior | `node tests/android-uiautomator-onboarding.mjs` |
| Full app Android | Settings/search/permission/plugin contract remains visible | `node tests/android-uiautomator-full-app.mjs` |

## Review Checklist

Before accepting a permission or onboarding change:

1. Confirm every visible button has a real handler and a disabled/busy state where prompts can hang.
2. Confirm every Android runtime permission has a manifest declaration and a status read path.
3. Confirm every persisted setting key exists in `DEFAULT_SETTINGS` and is accepted by validation/import logic.
4. Confirm onboarding can be completed even when optional permissions are skipped.
5. Confirm required tracking permissions are still surfaced after onboarding in Settings and Dashboard.
6. Confirm `needs_settings` opens Android settings instead of looping prompts.
7. Confirm background tracking still requires location, background location, notifications, Physical Activity, and foreground service declarations.
8. Confirm Usage Access remains manual and optional because Android exposes it through a settings screen, not a normal runtime prompt.
9. Confirm completion markers are saved to both app settings and marker stores.
10. Confirm tests cover any new visible row, permission state, setting key, or native manifest declaration.

## AI Handoff Prompt

Use this prompt when asking another AI to review this area:

```text
Review Road Sage onboarding and permission behavior using docs/PERMISSION_AND_ONBOARDING_SYSTEM.md as the source map. Check first-run onboarding, permission request ordering, Android manifest declarations, native plugin methods, settings persistence, completion markers, Dashboard warnings, Settings permission rows, Trip Detail Usage Access banners, and tests. Return findings first with file paths and line references. Distinguish true permission bugs from intentional optional-permission behavior.
```
