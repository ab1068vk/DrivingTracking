# Android Quick Button Complete Implementation

Last reviewed: 2026-06-05

This document explains the full Android Quick Settings button for Road Sage auto tracking. It includes the native Android tile code, settings keys, React settings toggles, dashboard UI behavior, and Android security rules that must stay true.

Use this file when changing:

- Android Quick Settings tile behavior.
- Settings toggles for Manual, Auto-Detect, Background Auto, or Pause All Tracking.
- Dashboard status text that tells the user whether trips are Manual, Auto-Detect, Background Auto, or Paused.
- Native encrypted settings storage used by the tile.
- Android permission or service declarations related to background auto tracking.

## Goal

The quick button must be one shared control over the same state the app uses everywhere.

```text
Android Quick Settings tile click
  -> NativeSettingsStore.updateSettingsFields(...)
  -> encrypted Android settings snapshot
  -> RoadSageAutoTrackingService.start(...) or stop(...)
  -> React localSettings.hydrateFromNative()
  -> Settings toggles update
  -> Dashboard mode/readiness panels update
  -> Trips record start_source as manual, auto, or native_auto
```

The tile must not maintain a second private mode. The source of truth is the settings snapshot.

## Source Files

| Area | File |
| --- | --- |
| Quick Settings tile | `android/app/src/main/java/com/roadsage/app/DriveSenseAutoTrackingTileService.java` |
| Native encrypted settings | `android/app/src/main/java/com/roadsage/app/NativeSettingsStore.java` |
| Auto tracking foreground service | `android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java` |
| Android manifest | `android/app/src/main/AndroidManifest.xml` |
| Tile label string | `android/app/src/main/res/values/strings.xml` |
| JS settings defaults and hydration | `src/lib/trackingStore.js` |
| Settings toggles | `src/settings/sections/TrackingSettings.jsx` and `src/pages/Settings.jsx` |
| Dashboard status | `src/pages/Dashboard.jsx` and `src/lib/trackingDiagnostics.js` |
| Trip cards and trip source display | `src/components/TripCard.jsx`, `src/pages/TripDetail.jsx`, `src/pages/TripHistory.jsx` |

## Settings Contract

These fields move together:

| Field | Manual | Auto-Detect | Background Auto On | Background Auto Paused |
| --- | --- | --- | --- | --- |
| `tracking_mode` | `manual` | `auto_detect` | `background_auto` | `background_auto` |
| `auto_tracking_enabled` | `false` | `true` | `true` | `true` |
| `background_tracking_enabled` | `false` | `false` | `true` | `true` |
| `tracking_paused` | `false` | `false` | `false` | `true` |
| Android service | stopped | stopped | started | stopped |
| Dashboard label | Manual | Auto-Detect | Background Auto | Paused |

Current defaults in `src/lib/trackingStore.js`:

```js
export const DEFAULT_SETTINGS = {
  settings_defaults_version: CURRENT_SETTINGS_DEFAULTS_VERSION,
  _settings_revision: 0,
  _settings_updated_at: '',
  tracking_mode: 'manual',
  background_tracking_enabled: false,
  auto_tracking_enabled: false,
  activity_permission_granted: false,
  location_permission_granted: false,
  background_location_granted: false,
  tracking_paused: false,
  live_coaching_enabled: true,
};

const SETTINGS_ENUMS = {
  tracking_mode: ['manual', 'auto_detect', 'background_auto'],
};

const IMPORT_ENUMS = {
  ...SETTINGS_ENUMS,
  tracking_mode: ['manual', 'auto_detect'],
};
```

Important security detail: backup import must not silently restore `background_auto`. A different device must re-grant Android background location, activity, notification, and battery setup before background auto can run.

## Native Quick Settings Tile

Current implementation in `DriveSenseAutoTrackingTileService.java`:

```java
package com.roadsage.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import androidx.core.content.ContextCompat;

import java.util.HashMap;
import java.util.Map;

import org.json.JSONObject;

public class DriveSenseAutoTrackingTileService extends TileService {
    @Override
    public void onStartListening() {
        super.onStartListening();
        updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        if (isBackgroundAutoActive()) {
            setBackgroundAutoPaused();
            RoadSageAutoTrackingService.stop(this);
            updateTile("Auto off", Tile.STATE_INACTIVE);
            return;
        }

        if (!hasNativeAutoTrackingPermissions()) {
            updateTile("Setup needed", Tile.STATE_INACTIVE);
            return;
        }

        setBackgroundAutoEnabled();
        RoadSageAutoTrackingService.start(this);
        updateTile("Auto on", Tile.STATE_ACTIVE);
    }

    private void updateTile() {
        boolean enabled = isBackgroundAutoActive();
        updateTile(enabled ? "Auto on" : "Auto off", enabled ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    }

    private void updateTile(String label, int state) {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setLabel(label);
        tile.setState(state);
        tile.updateTile();
    }

    private JSONObject getSettings() {
        String raw = NativeSettingsStore.getSettingsJson(this);
        if (raw == null || raw.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private void setBackgroundAutoEnabled() {
        Map<String, Object> updates = new HashMap<>();
        updates.put("tracking_mode", "background_auto");
        updates.put("auto_tracking_enabled", true);
        updates.put("background_tracking_enabled", true);
        updates.put("tracking_paused", false);
        NativeSettingsStore.updateSettingsFields(this, updates);
    }

    private void setBackgroundAutoPaused() {
        Map<String, Object> updates = new HashMap<>();
        updates.put("tracking_mode", "background_auto");
        updates.put("auto_tracking_enabled", true);
        updates.put("background_tracking_enabled", true);
        updates.put("tracking_paused", true);
        NativeSettingsStore.updateSettingsFields(this, updates);
    }

    private boolean isBackgroundAutoActive() {
        JSONObject settings = getSettings();
        boolean backgroundAuto = "background_auto".equals(settings.optString("tracking_mode", "manual"));
        boolean paused = settings.optBoolean("tracking_paused", false);
        return backgroundAuto && !paused && DriveSenseNativeTripStore.isServiceEnabled(this);
    }

    private boolean hasNativeAutoTrackingPermissions() {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return false;
        if (!hasPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            !hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)) return false;
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            hasPermission(Manifest.permission.POST_NOTIFICATIONS);
    }

    private boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }
}
```

Behavior:

- If background auto is active, the tile pauses tracking and stops the service.
- If background auto is not active, the tile checks Android permissions before starting.
- If setup is incomplete, the tile shows `Setup needed` and does not start the service.
- The tile writes `_settings_revision` and `_settings_updated_at` through `NativeSettingsStore`, so React hydration can choose the newest native state.

## Native Settings Store

The quick button writes to encrypted Android storage through `NativeSettingsStore.java`:

```java
final class NativeSettingsStore {
    private static final String SETTINGS_PREFS_ENCRYPTED = "road_sage_native_settings_v2";
    private static final String SETTINGS_KEY = "road_sage_settings";

    static String getSettingsJson(Context context) {
        return prefs(context).getString(SETTINGS_KEY, null);
    }

    static boolean saveSettingsJson(Context context, String settingsJson) {
        if (settingsJson == null || settingsJson.trim().isEmpty()) return false;
        return prefs(context).edit().putString(SETTINGS_KEY, settingsJson).commit();
    }

    static boolean updateSettingsFields(Context context, Map<String, Object> updates) {
        if (updates == null || updates.isEmpty()) return false;
        String current = getSettingsJson(context);
        try {
            return saveSettingsJson(context, stampedSettingsJson(current, updates));
        } catch (JSONException error) {
            Log.e(TAG, "updateSettingsFields: failed to stamp settings", error);
            return false;
        }
    }

    static String stampedSettingsJson(String current, Map<String, Object> updates) throws JSONException {
        JSONObject settings = current == null || current.trim().isEmpty()
            ? new JSONObject()
            : new JSONObject(current);

        for (Map.Entry<String, Object> entry : updates.entrySet()) {
            settings.put(entry.getKey(), entry.getValue());
        }

        int revision = settings.optInt("_settings_revision", 0);
        settings.put("_settings_revision", revision + 1);
        settings.put("_settings_updated_at", isoNowUtc());
        return settings.toString();
    }

    private static SharedPreferences prefs(Context context) {
        return EncryptedPreferenceStore.open(context, SETTINGS_PREFS_ENCRYPTED);
    }
}
```

Security requirement:

- Use encrypted prefs, not plaintext SharedPreferences.
- Use `commit()` for quick button writes so the tile knows whether the change was durably saved.
- Stamp every native update so app hydration can resolve conflicts.

## Android Manifest

Required tile service declaration:

```xml
<service
    android:name=".DriveSenseAutoTrackingTileService"
    android:enabled="true"
    android:exported="true"
    android:icon="@drawable/ic_qs_roadsage"
    android:label="@string/quick_settings_resume_auto_tracking"
    android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
    <intent-filter>
        <action android:name="android.service.quicksettings.action.QS_TILE" />
    </intent-filter>
    <meta-data
        android:name="android.service.quicksettings.TOGGLEABLE_TILE"
        android:value="true" />
</service>
```

Required auto tracking service declaration:

```xml
<service
    android:name=".RoadSageAutoTrackingService"
    android:enabled="true"
    android:exported="false"
    android:foregroundServiceType="location" />
```

Required permissions:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
```

Tile label:

```xml
<string name="quick_settings_resume_auto_tracking">Auto Tracking</string>
```

Security rules:

- The quick tile service can be `exported="true"` only because Android binds it using `android.permission.BIND_QUICK_SETTINGS_TILE`.
- `RoadSageAutoTrackingService` must stay `exported="false"` so outside apps cannot start location tracking directly.
- Background auto requires runtime checks for foreground location, background location, activity recognition, and Android 13+ notifications.
- The foreground service must use `foregroundServiceType="location"`.

## React Settings Toggle Flow

Settings page code in `src/pages/Settings.jsx`:

```jsx
const updateTrackingPaused = async (paused) => {
  const updated = await updateCfg({ tracking_paused: paused });
  if (!isAndroid()) return;

  if (paused) {
    const stopped = await stopNativeAutoTrackingSafely('Auto tracking could not be paused');
    if (!stopped) await updateCfg({ tracking_paused: false });
    return;
  }

  if (updated.tracking_mode === 'background_auto') {
    try {
      await startNativeAutoTracking();
      await refreshPermissions();
    } catch (error) {
      await updateCfg({ tracking_paused: true });
      toast({
        title: 'Background tracking could not resume',
        description: error.message || 'Check Location, Physical Activity, Notifications, and Battery Optimization settings.',
        variant: 'destructive',
      });
      await refreshPermissions();
    }
  }
};

const enableTrackingMode = async (mode) => {
  if (cfg.tracking_paused && mode !== 'manual') {
    await updateCfg({ tracking_paused: false });
  }

  if (mode === 'manual') {
    const stopped = await stopNativeAutoTrackingSafely('Manual mode could not stop background tracking');
    if (!stopped) return;
    await updateCfg({
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    });
    return;
  }

  const locationGranted = await requestForegroundLocationPermission();
  if (!locationGranted) return;

  const activityGranted = !isAndroid() || await requestActivityRecognitionPermission();
  if (!activityGranted) return;

  if (mode === 'background_auto') {
    const backgroundGranted = await requestBackgroundLocationPermission();
    if (!backgroundGranted) return;

    if (isAndroid()) {
      try {
        await startNativeAutoTracking();
      } catch (error) {
        await refreshPermissions();
        return;
      }
    }
  }

  if (mode !== 'background_auto') {
    const stopped = await stopNativeAutoTrackingSafely('Background tracking could not be turned off');
    if (!stopped) return;
  }

  await updateCfg({
    tracking_mode: mode,
    auto_tracking_enabled: mode !== 'manual',
    background_tracking_enabled: mode === 'background_auto',
    tracking_paused: false,
  });
  await refreshPermissions();
};
```

Settings UI code in `src/settings/sections/TrackingSettings.jsx`:

```jsx
{[
  { id: 'manual', label: 'Manual Only', sub: 'Start/stop trips manually' },
  { id: 'auto_detect', label: 'Auto-Detect', sub: 'Detects driving when app is open' },
  { id: 'background_auto', label: 'Background Auto', sub: 'Uses more battery' },
].map(opt => (
  <button
    key={opt.id}
    onClick={() => enableTrackingMode(opt.id)}
    className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
      effectiveTrackingMode === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
    }`}
  >
    <div>
      <div className="text-sm font-medium">{opt.label}</div>
      <div className="text-xs text-muted-foreground">{opt.sub}</div>
    </div>
    {effectiveTrackingMode === opt.id && <Check className="w-4 h-4 text-primary" />}
  </button>
))}

<SettingRow icon={AlertTriangle} label="Pause All Tracking" sublabel="Temporarily disable trip detection">
  <Toggle value={cfg.tracking_paused} onChange={updateTrackingPaused} />
</SettingRow>

<SettingRow
  icon={Shield}
  label="Auto-Tracking"
  sublabel={cfg.tracking_paused ? 'Paused until Pause All Tracking is turned off' : 'Start only after you enable it and driving signals are strong'}
>
  <Toggle value={!cfg.tracking_paused && cfg.auto_tracking_enabled} onChange={async v => {
    if (v) {
      await enableTrackingMode('auto_detect');
      return;
    }
    const stopped = await stopNativeAutoTrackingSafely('Auto tracking could not be turned off');
    if (!stopped) return;
    updateCfg({ auto_tracking_enabled: false, tracking_mode: 'manual' });
  }} />
</SettingRow>

<SettingRow
  icon={Shield}
  label="Background Tracking"
  sublabel={cfg.tracking_paused ? 'Paused until Pause All Tracking is turned off' : nativeTrackingStatus?.enabled ? 'Native background auto tracking is running' : 'Keeps recording after the app is minimized with a persistent notification'}
>
  <Toggle value={!cfg.tracking_paused && cfg.background_tracking_enabled} onChange={async v => {
    if (v) {
      await enableTrackingMode('background_auto');
      return;
    }
    const stopped = await stopNativeAutoTrackingSafely('Background tracking could not be turned off');
    if (!stopped) return;
    updateCfg({ background_tracking_enabled: false, auto_tracking_enabled: false, tracking_mode: 'manual' });
    await refreshPermissions();
  }} />
</SettingRow>
```

## Sync From Tile Clicks Into React

The tile can be clicked while the app is backgrounded. When the app becomes visible, React must hydrate from native settings.

Current Dashboard pattern:

```jsx
const [settings, setSettings] = useState(() => localSettings.get());
const effectiveTrackingMode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');

const refreshTrackingStatusContext = useCallback(async () => {
  const latestSettings = await localSettings.hydrateFromNative();
  setSettings(latestSettings);
  // Then refresh permission/native/battery status.
}, []);

useEffect(() => {
  const handleFocus = () => refreshTrackingStatusContext();
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') refreshTrackingStatusContext();
  };
  const interval = isAndroid()
    ? window.setInterval(refreshTrackingStatusContext, 2000)
    : null;
  window.addEventListener('focus', handleFocus);
  document.addEventListener('visibilitychange', handleVisibility);
  return () => {
    if (interval) window.clearInterval(interval);
    window.removeEventListener('focus', handleFocus);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}, [refreshTrackingStatusContext]);
```

Recommended helper if this logic needs to be shared by Settings, Dashboard, and Map:

```jsx
import { useCallback, useEffect, useState } from 'react';
import { isAndroid } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';

export function useNativeSyncedSettings(intervalMs = 2000) {
  const [settings, setSettings] = useState(() => localSettings.get());

  const refreshSettings = useCallback(async () => {
    const latest = await localSettings.hydrateFromNative();
    setSettings(latest);
    return latest;
  }, []);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshSettings();
    };
    window.addEventListener('focus', refreshSettings);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const timer = isAndroid() ? window.setInterval(refreshSettings, intervalMs) : null;
    return () => {
      if (timer) window.clearInterval(timer);
      window.removeEventListener('focus', refreshSettings);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [intervalMs, refreshSettings]);

  return { settings, setSettings, refreshSettings };
}
```

## Dashboard UI That Changes With Quick Button

Dashboard currently derives mode like this:

```jsx
const effectiveTrackingMode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');
```

The diagnostic panel is keyed by the mode and related settings:

```jsx
const trackingExplanationKey = useMemo(() => JSON.stringify({
  mode: effectiveTrackingMode,
  tracking,
  native: trackingStatusContext.nativeStatus || null,
  battery: trackingStatusContext.batteryStatus || null,
  settings: {
    paused: settings.tracking_paused === true,
    mode: settings.tracking_mode,
    auto: settings.auto_tracking_enabled === true,
    background: settings.background_tracking_enabled === true,
    backgroundLocation: settings.background_location_granted === true,
    location: settings.location_permission_granted === true,
    activity: settings.activity_permission_granted === true,
    notifications: settings.notification_permission_granted === true,
  },
}), [
  effectiveTrackingMode,
  settings.auto_tracking_enabled,
  settings.background_tracking_enabled,
  settings.background_location_granted,
  settings.location_permission_granted,
  settings.activity_permission_granted,
  settings.notification_permission_granted,
  settings.tracking_mode,
  settings.tracking_paused,
  tracking,
  trackingStatusContext.nativeStatus,
  trackingStatusContext.batteryStatus,
]);
```

`buildDashboardTrackingExplanation(...)` turns that into user-facing facts:

```js
const mode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');
const autoEnabled = !settings.tracking_paused && (
  settings.auto_tracking_enabled ||
  mode === 'auto_detect' ||
  mode === 'background_auto'
);
const backgroundAuto = mode === 'background_auto';

const facts = [
  autoEnabled ? `Mode: ${backgroundAuto ? 'Background auto' : mode === 'auto_detect' ? 'Auto-detect' : 'Auto enabled'}` : `Mode: ${mode === 'manual' ? 'Manual' : mode}`,
  `Location: ${foregroundLocation}`,
  isAndroidPlatform ? `Activity: ${activityRecognition}` : null,
  backgroundAuto ? `Background: ${backgroundLocation}` : null,
  backgroundAuto ? `Notifications: ${notifications}` : null,
  backgroundAuto && isAndroidPlatform ? `Native service: ${nativeStatus?.enabled ? 'armed' : 'not armed'}` : null,
  backgroundAuto && isAndroidPlatform ? `Battery: ${batteryStatus?.batteryOptimizationIgnored ? 'unrestricted' : 'may restrict'}` : null,
].filter(Boolean);
```

Recommended visible dashboard badge:

```jsx
const TRACKING_MODE_META = {
  manual: {
    label: 'Manual',
    detail: 'Trips start only from Start Trip.',
    tone: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200',
  },
  auto_detect: {
    label: 'Auto-Detect',
    detail: 'Detects driving while the app is open.',
    tone: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200',
  },
  background_auto: {
    label: 'Background Auto',
    detail: 'Android service can detect trips in the background.',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200',
  },
  paused: {
    label: 'Paused',
    detail: 'Tracking is paused from Settings or the quick button.',
    tone: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200',
  },
};

function DashboardTrackingModeBadge({ settings, nativeStatus }) {
  const mode = settings.tracking_paused ? 'paused' : (settings.tracking_mode || 'manual');
  const meta = TRACKING_MODE_META[mode] || TRACKING_MODE_META.manual;
  const serviceText = mode === 'background_auto'
    ? nativeStatus?.enabled ? 'Service armed' : 'Service not armed'
    : null;

  return (
    <div className={`rounded-2xl border px-3 py-2 text-xs ${meta.tone}`}>
      <div className="font-bold">{meta.label}</div>
      <div className="mt-0.5 text-[11px] opacity-80">{serviceText || meta.detail}</div>
    </div>
  );
}
```

Place the badge near the dashboard header:

```jsx
<div className="flex items-start justify-between gap-3">
  <div>
    <h1 className="text-2xl font-grotesk font-bold">Dashboard</h1>
    <p className="text-sm text-muted-foreground">Your driving summary</p>
  </div>
  <DashboardTrackingModeBadge
    settings={settings}
    nativeStatus={trackingStatusContext.nativeStatus}
  />
</div>
```

Expected quick button UI result:

- Tile turns on: Dashboard badge changes to `Background Auto`, Settings selects Background Auto, Background Tracking toggle turns on.
- Tile turns off: Dashboard badge changes to `Paused`, Settings keeps Background Auto selected but Pause All Tracking turns on.
- User switches Manual in Settings: tile shows inactive on next `onStartListening`, Dashboard badge changes to `Manual`.
- User switches Auto-Detect in Settings: native service stops, Dashboard badge changes to `Auto-Detect`.

## Trip Source Display

Trips should preserve how they started:

| `start_source` | Meaning | Display |
| --- | --- | --- |
| `manual` or missing | User tapped Start Trip | Manual |
| `auto` | In-app auto-detect started the trip | Auto-Detect |
| `native_auto` | Android background service started the trip | Background Auto |

Recommended shared formatter:

```js
export function describeTripStartSource(trip = {}) {
  if (trip.start_source === 'native_auto') {
    return {
      label: 'Background Auto',
      detail: 'Started by Android background tracking',
      tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
    };
  }
  if (trip.start_source === 'auto') {
    return {
      label: 'Auto-Detect',
      detail: 'Started by in-app motion detection',
      tone: 'bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300',
    };
  }
  return {
    label: 'Manual',
    detail: 'Started from the app',
    tone: 'bg-secondary text-muted-foreground',
  };
}
```

Recommended TripCard badge:

```jsx
const source = describeTripStartSource(trip);

<span
  title={source.detail}
  className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${source.tone}`}
>
  {source.label}
</span>
```

Recommended Trip Detail text:

```jsx
const source = describeTripStartSource(trip);

<div className="rounded-xl border border-border bg-secondary/40 p-3">
  <div className="text-xs font-bold uppercase text-muted-foreground">Trip source</div>
  <div className="mt-1 text-sm font-semibold">{source.label}</div>
  <div className="text-xs text-muted-foreground">{source.detail}</div>
</div>
```

## Android Security Checklist

Before release, verify all items:

- Tile service has `android.permission.BIND_QUICK_SETTINGS_TILE`.
- Auto tracking service is `exported="false"`.
- Tile start path checks foreground location, background location, activity recognition, and Android 13+ notification permission.
- Service starts as a location foreground service with a persistent notification.
- Settings writes use encrypted prefs through `EncryptedPreferenceStore.open(...)`.
- Encrypted prefs use AndroidX Security `MasterKey` with AES-256 schemes.
- Tile writes stamp `_settings_revision` and `_settings_updated_at`.
- Backup import strips or blocks `background_auto`.
- Web/React does not treat stale browser mirror settings as newer than stamped native settings.
- Dashboard and Settings hydrate from native on focus/visibility and at a short Android polling interval.
- If native settings cannot be parsed, the tile falls back to inactive/manual behavior.
- If permissions are missing, tile shows `Setup needed` and does not start tracking.

## Testing Checklist

Manual Android test:

```text
1. Install app fresh.
2. Add the Road Sage Auto Tracking tile to Quick Settings.
3. Open Settings > Tracking.
4. Confirm default mode is Manual.
5. Tap tile with missing permissions.
6. Confirm tile says Setup needed and service does not start.
7. Grant Location, Background Location, Physical Activity, Notifications.
8. Tap tile on.
9. Confirm tile says Auto on.
10. Open app.
11. Confirm Settings shows Background Auto and Background Tracking on.
12. Confirm Dashboard shows Background Auto and service armed.
13. Tap tile off.
14. Return to app.
15. Confirm Settings shows Pause All Tracking on.
16. Confirm Dashboard shows Paused.
17. Start a manual trip from Dashboard.
18. End it and confirm trip source displays Manual.
19. Enable Auto-Detect and simulate in-app auto start.
20. Confirm completed trip source displays Auto-Detect.
21. Enable Background Auto and trigger native auto start.
22. Confirm completed trip source displays Background Auto.
```

Automated commands:

```powershell
npm.cmd test
npm.cmd run build
.\gradlew.bat assembleDebug
.\gradlew.bat connectedDebugAndroidTest
```

Focused files to cover with unit or instrumentation tests:

- `android/app/src/test/java/com/roadsage/app/RoadSageAutoTrackingServiceTest.java`
- `src/components/__tests__/TripCard.test.jsx`
- `src/components/__tests__/TrackingHealthChip.test.jsx`
- `src/hooks/__tests__/usePermissionMonitor.test.js`
- `src/lib/__tests__/trackingStoreDefaults.test.js`
- `tests/android-uiautomator-settings-full.mjs`
- `tests/android-uiautomator-full-app.mjs`

## Failure Modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tile says `Setup needed` | Missing background location, activity recognition, or notifications | Go through Settings > Android Permissions and grant missing setup |
| Tile says `Auto on`, dashboard says Manual | React did not hydrate latest native settings | Call `localSettings.hydrateFromNative()` on focus/visibility or poll on Android |
| Settings shows Background Auto, tile says off | Native service was stopped or killed | Refresh native status and call `startNativeAutoTracking()` if settings allow it |
| Dashboard says service not armed | `getNativeAutoTrackingStatus()` returned disabled | Re-arm service or show setup action |
| Imported backup enables auto unexpectedly | Import sanitizer allowed `background_auto` | Keep import enum limited to `manual` and `auto_detect` |
| Service starts without notification on Android 13+ | Missing notification permission check | Keep `POST_NOTIFICATIONS` gate in tile and Settings flow |

## Acceptance Criteria

The quick button is complete only when:

- One click can arm background auto after required Android permissions are already granted.
- One click can pause background auto and stop the native service.
- Settings toggles show the same state after the quick button is clicked.
- Dashboard visibly shows Manual, Auto-Detect, Background Auto, or Paused.
- Recent trips and detail pages show whether the trip started manually, from in-app auto detection, or from native background auto.
- Android security checks fail closed when permissions or encrypted settings are unavailable.
- Tests or manual proof cover tile on, tile off, Settings sync, Dashboard sync, and trip source display.
