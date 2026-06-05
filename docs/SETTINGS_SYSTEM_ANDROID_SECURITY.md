# Road Sage Settings System and Android Security Notes

Last reviewed: 2026-06-04

This is the Android/security companion to `docs/COMPLETE_SETTINGS_SYSTEM.md`. Use the complete settings contract first; use this file when a setting saves in the UI but appears blocked, reset, or ineffective on Android.

## Current Save Path

The Settings page saves through the async durable path:

```text
Settings UI
  -> updateCfg(patch)
  -> validateSettingsPatch(patch)
  -> optimistic React cfg state
  -> await localSettings.setAsync(optimistic)
  -> browser/local runtime mirror
  -> encrypted Capacitor mirror
  -> DriveSenseActivityRecognition.saveSettings(settingsJson)
  -> NativeSettingsStore.saveSettingsJson(...)
  -> EncryptedSharedPreferences.commit()
  -> Android Keystore MasterKey
```

Current UI code shape:

```jsx
const updateCfg = useCallback(async (patch) => {
  const validation = validateSettingsPatch(patch);
  if (!validation.valid) return cfg;

  const currentCfg = normalizeSettingsSnapshot(cfg);
  const optimistic = normalizeSettingsSnapshot({ ...currentCfg, ...patch });
  setCfg(optimistic);

  try {
    const updated = normalizeSettingsSnapshot(await localSettings.setAsync(optimistic));
    setCfg(updated);
    setSaved(true);
    return updated;
  } catch (error) {
    setCfg(currentCfg);
    notifyUserError('settings_save', error, {
      title: 'Setting not saved',
      description: 'Road Sage could not write this setting to secure storage. Try again.',
    });
    return currentCfg;
  }
}, [cfg]);
```

Current store code shape:

```js
async setAsync(data) {
  const current = memorySettings || this.get();
  const stamped = stampSettingsSnapshot(data, current);
  const serialized = JSON.stringify(stamped);

  settingsMutationCounter += 1;
  writeBrowserSettingsMirror(serialized);
  persistOnboardingCompletedMarker(stamped);

  await enqueueSettingsWrite(async () => {
    try {
      await setJson(SETTINGS_KEY, stamped);
    } catch (err) {
      logError('settings_encrypted_save_async', err);
    }
    await syncSettingsForNativeAsync(stamped);
  });

  memorySettings = stamped;
  return stamped;
}
```

Important detail: `setJson(...)` encrypted mirror failures are logged, but `syncSettingsForNativeAsync(...)` must succeed for the awaited Settings UI path to report durable success on Android.

## Detailed Code Reference For AI Reviewers

This section intentionally includes the important code shapes directly in the Markdown so another AI tool can review the setting system without guessing where behavior lives. Keep these snippets current when the code changes.

### Settings UI save contract

Source: `src/pages/Settings.jsx`

```jsx
const updateCfg = useCallback(async (patch) => {
  const validation = validateSettingsPatch(patch);
  if (!validation.valid) {
    toast({
      title: 'Setting not saved',
      description: validation.errors[0],
      variant: 'destructive',
    });
    return cfg;
  }

  const currentCfg = normalizeSettingsSnapshot(cfg);
  const optimistic = normalizeSettingsSnapshot({ ...currentCfg, ...patch });
  const touchesEcoMultipliers = Object.prototype.hasOwnProperty.call(patch, 'eco_cruise_score_multiplier') ||
    Object.prototype.hasOwnProperty.call(patch, 'eco_idle_penalty_multiplier');
  if (touchesEcoMultipliers && wouldDisableEcoScore(optimistic)) {
    toast({
      title: 'Eco setting not saved',
      description: 'Eco scoring needs either the cruise multiplier or idle multiplier above 0.',
      variant: 'destructive',
    });
    return cfg;
  }

  const saveGeneration = settingsSaveGenerationRef.current + 1;
  settingsSaveGenerationRef.current = saveGeneration;
  setCfg(optimistic);

  try {
    const updated = normalizeSettingsSnapshot(await localSettings.setAsync(optimistic));
    if (settingsSaveGenerationRef.current === saveGeneration) {
      setCfg(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
    return updated;
  } catch (error) {
    if (settingsSaveGenerationRef.current === saveGeneration) {
      setCfg(currentCfg);
    }
    notifyUserError('settings_save', error, {
      title: 'Setting not saved',
      description: 'Road Sage could not write this setting to secure storage. Try again.',
    });
    return currentCfg;
  }
}, [cfg]);
```

Review checks:

```text
Does each UI control call updateCfg(...) or a documented alternate save path?
Does the patch key exactly match DEFAULT_SETTINGS?
Does the UI handle async rejection by rolling back or showing an error?
Does the generation guard avoid older async saves overwriting newer UI changes?
Does any special handler bypass validateSettingsPatch(...)?
```

### Notification setting save contract

Source: `src/pages/Settings.jsx`

```jsx
const updateNotificationSetting = async (patch) => {
  const updated = await updateCfg(patch);
  try {
    await syncReminderNotifications(updated);
  } catch (error) {
    notifyUserError('notification_settings_sync', error, {
      title: 'Notification setting saved',
      description: 'Road Sage saved the setting but could not refresh reminder notifications yet.',
    });
  }
  return updated;
};
```

Expected behavior:

```text
The setting still saves if notification rescheduling fails.
The user is told that notification refresh failed.
Tests should separate settings persistence from notification scheduling.
```

### Data retention save contract

Source: `src/pages/Settings.jsx`

```jsx
const updateRetention = async (months) => {
  const updated = await updateCfg({ data_retention_months: months });
  try {
    const deleted = await enforceDataRetention(updated.data_retention_months);
    if (deleted > 0) {
      toast({
        title: 'Old trips removed',
        description: `${deleted} completed trip${deleted === 1 ? '' : 's'} exceeded your retention window.`,
      });
    }
  } catch (error) {
    notifyUserError('data_retention_enforce', error, {
      title: 'Retention saved',
      description: 'Road Sage saved the retention setting but could not prune older trips yet.',
    });
  }
  return updated;
};
```

Expected behavior:

```text
Changing the setting persists the retention window.
Pruning is a follow-up side effect and may fail independently.
0 means never auto-delete completed trips.
Deleting trips is destructive and must be covered by focused tests.
```

### Async durable settings store

Source: `src/lib/trackingStore.js`

```js
const enqueueSettingsWrite = (writeTask) => {
  const run = settingsWriteQueue.catch(() => null).then(writeTask);
  settingsWriteQueue = run.catch(() => null);
  return run;
};

async setAsync(data) {
  const current = memorySettings || this.get();
  const stamped = stampSettingsSnapshot(data, current);
  const serialized = JSON.stringify(stamped);
  const storage = settingsStorage();

  if (storage) storage.setItem(SETTINGS_STORAGE_KEY, serialized);
  else if (!Capacitor.isNativePlatform()) memorySettings = stamped;

  settingsMutationCounter += 1;
  writeBrowserSettingsMirror(serialized);
  persistOnboardingCompletedMarker(stamped);

  await enqueueSettingsWrite(async () => {
    try {
      await setJson(SETTINGS_KEY, stamped);
    } catch (err) {
      logError('settings_encrypted_save_async', err);
    }
    await syncSettingsForNativeAsync(stamped);
  });

  if (!storage) memorySettings = stamped;
  return stamped;
}
```

Review checks:

```text
settingsMutationCounter must increase for every durable settings save.
_settings_revision and _settings_updated_at must be stamped.
Writes must be queued so rapid toggles do not reorder native persistence.
Encrypted mirror errors are logged but do not stop native save attempts.
Native save errors must reject setAsync on Android.
memorySettings is updated only after queued native writes complete on native platforms.
```

### Native sync code

Source: `src/lib/trackingStore.js`

```js
async function syncSettingsForNativeAsync(settings) {
  if (typeof window === 'undefined' || !Capacitor.isNativePlatform()) return;

  const serialized = typeof settings === 'string' ? settings : JSON.stringify(settings);
  if (serialized === lastNativeSettingsSync) return;
  pendingNativeSettingsSync = serialized;

  const nativePlugin = await androidNativeDriveSensePlugin().catch((err) => {
    logError('native_settings_sync_module_load', err);
    return null;
  });
  if (!nativePlugin?.saveSettings) {
    throw new Error('Native settings plugin unavailable');
  }

  try {
    await nativePlugin.saveSettings({ settingsJson: serialized });
    lastNativeSettingsSync = serialized;
    if (pendingNativeSettingsSync === serialized) pendingNativeSettingsSync = '';
  } catch (err) {
    pendingNativeSettingsSync = serialized;
    logError('native_settings_sync_async', err, { key: SETTINGS_STORAGE_KEY });
    throw err;
  }
}
```

Bug patterns:

```text
If nativePlugin.saveSettings is unavailable, Android settings can look saved in memory but fail persistence.
If lastNativeSettingsSync is incorrectly set, a needed native save can be skipped.
If pendingNativeSettingsSync is not reconciled during hydration, a new save can lose to an older native value.
If sync errors are swallowed by a UI save path, "Saved" can be shown for a non-durable value.
```

### Hydration candidate choice

Source: `src/lib/trackingStore.js`

```js
export function chooseSettingsHydrationCandidate(candidates = []) {
  const normalized = candidates.filter(Boolean);
  if (!normalized.length) return null;
  return normalized.sort((a, b) => (
    (b.revision - a.revision) ||
    (b.updatedAtMs - a.updatedAtMs) ||
    (b.onboardingCompleted - a.onboardingCompleted) ||
    (b.deltaCount - a.deltaCount)
  ))[0];
}
```

Hydration sources:

```text
DriveSenseActivityRecognition.getSettings().settingsJson
pendingNativeSettingsSync
encryptedCapacitorStorage road_sage_settings
browser localStorage mirror
plain Capacitor Preferences legacy fallback
```

Bug patterns:

```text
A stale snapshot with a higher _settings_revision can win.
A browser mirror can win if native hydration fails.
A pending in-memory native sync must protect newer local mutations.
Malformed timestamps can affect updatedAtMs ordering.
New default settings can increase delta count and alter fallback ordering.
```

### Settings stamping

Source: `src/lib/trackingStore.js`

```js
const stampSettingsSnapshot = (settings = {}, previousSettings = null) => {
  const previousRevision = Math.max(
    settingsRevisionNumber(previousSettings),
    settingsRevisionNumber(settings)
  );
  return {
    ...settings,
    _settings_revision: previousRevision + 1,
    _settings_updated_at: new Date().toISOString(),
  };
};
```

Expected behavior:

```text
Every durable save increments revision.
Every durable save updates timestamp.
Imported settings should strip revision/timestamp before merging so backups cannot dominate hydration.
```

### Validation code

Source: `src/lib/trackingStore.js`

```js
export function validateSettingsPatch(patch = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, errors: ['Settings update must be an object.'] };
  }

  Object.entries(patch).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
    if (key === 'last_map_center') {
      if (value !== null && !sanitizeMapCenter(value)) errors.push('last_map_center must contain valid lat and lng coordinates.');
      return;
    }
    if (key === 'osrm_map_matching_url') {
      const endpoint = String(value || '').trim();
      if (!endpoint) return;
      const trust = evaluateOsrmEndpointTrust(endpoint);
      if (!trust.ok) errors.push(trust.error || 'osrm_map_matching_url must be a trusted HTTPS URL.');
      return;
    }
    if (SETTINGS_ENUMS[key] && !SETTINGS_ENUMS[key].includes(value)) {
      errors.push(`${key} must be one of: ${SETTINGS_ENUMS[key].join(', ')}.`);
      return;
    }
    if (IMPORT_NUMBER_RANGES[key]) {
      const number = Number(value);
      const [min, max] = IMPORT_NUMBER_RANGES[key];
      if (!Number.isFinite(number) || number < min || number > max) {
        errors.push(`${key} must be between ${min} and ${max}.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}
```

Important detail:

```text
Unknown keys are ignored by validation. This protects compatibility but can hide typos.
A new real setting must be added to DEFAULT_SETTINGS and tested.
Security-sensitive settings may need stricter validation than generic enum/number checks.
```

### Local-only enforcement code

Source: `src/lib/privacyControls.js`

```js
export const externalServiceAllowed = (settings = {}, service) => {
  if (isLocalOnlyMode(settings)) return false;
  if (service === 'osm_speed_limits') return settings.speed_limit_lookup_enabled === true;
  if (service === 'open_meteo_weather') return settings.weather_context_enabled === true;
  if (service === 'osrm_route_snapping') return settings.map_matching_enabled === true && settings.osrm_data_sharing_consented === true;
  if (service === 'nominatim_reverse_geocoding') return settings.reverse_geocoding_enabled === true;
  if (service === 'map_tiles') return mapTilesAllowed(settings);
  if (service === 'calibration_upload') return settings.calibration_sharing_enabled === true;
  if (service === 'backend_sync') return settings.backend_sync_enabled === true;
  return !isLocalOnlyMode(settings);
};

export const enforceLocalOnlyPatch = (patch = {}) => (
  patch.external_requests_local_only === true
    ? {
      ...patch,
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
      external_context_auto_fetch_enabled: false,
      map_matching_enabled: false,
      osrm_data_sharing_consented: false,
      calibration_sharing_enabled: false,
      backend_sync_enabled: false,
      reverse_geocoding_enabled: false,
      map_tiles_enabled: false,
    }
    : patch
);
```

Expected behavior:

```text
When local-only is enabled, all external-service toggles are forced off.
External consumers must call externalServiceAllowed(...) or mapTilesAllowed(...).
UI must disable dependent toggles while local-only is on.
Backup import and migrations must preserve the same local-only safety.
```

### Backup import sanitizer contract

Source: `src/lib/trackingStore.js`

```text
sanitizeImportedSettings(raw)
  -> accepts only DEFAULT_SETTINGS keys
  -> strips IMPORT_STRIPPED_KEYS
  -> clamps number ranges
  -> validates enums
  -> sanitizes privacy zones
  -> strips revision metadata
  -> strips OSRM endpoint/trust/consent/health fields
  -> strips or downgrades unsafe background tracking imports
```

Review checks:

```text
Can a backup import silently turn on external data sharing?
Can it restore an OSRM endpoint or consent timestamp?
Can it set background_auto without permission/onboarding context?
Can it inject __proto__, constructor, prototype, script strings, or unsafe currency values?
Can it restore exact privacy-zone center coordinates when the export/import contract says those are stripped?
```

## Key Files

```text
src/pages/Settings.jsx
src/lib/trackingStore.js
src/lib/mobileStorage.js
src/lib/encryptedCapacitorStorage.js
src/lib/driveSenseNativePlugin.js
src/lib/storageKeyMigration.js
src/lib/privacyControls.js
android/app/src/main/java/com/roadsage/app/DriveSenseActivityRecognitionPlugin.java
android/app/src/main/java/com/roadsage/app/NativeSettingsStore.java
android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java
android/app/src/main/java/com/roadsage/app/EncryptedCapacitorPlugin.java
android/app/src/main/java/com/roadsage/app/MainActivity.java
android/app/src/main/res/xml/network_security_config.xml
android/app/src/main/res/xml/backup_rules.xml
android/app/src/main/res/xml/data_extraction_rules.xml
```

## Storage Keys

The internal compatibility key remains:

```js
const SETTINGS_KEY = 'drivesense_settings';
```

The current physical key is resolved through `resolveStorageKey(...)`:

```text
drivesense_settings -> road_sage_settings
```

Reviewers should not hard-code either name in new code. Use existing storage helpers.

## Native Settings Bridge

The Android bridge validates JSON and writes through `NativeSettingsStore`:

```java
@PluginMethod
public void saveSettings(PluginCall call) {
    String settingsJson = call.getString("settingsJson");
    if (settingsJson == null || settingsJson.trim().isEmpty()) {
        call.reject("settingsJson is required.");
        return;
    }

    try {
        new JSONObject(settingsJson);
    } catch (JSONException error) {
        call.reject("settingsJson must be valid JSON.", error);
        return;
    }

    new Thread(() -> {
        boolean saved = NativeSettingsStore.saveSettingsJson(appContext, settingsJson);
        if (!saved) {
            resolveSettingsSaveFailure(call, "Settings could not be saved to encrypted native storage.", null);
            return;
        }
        resolveSettingsSaveSuccess(call);
    }).start();
}
```

The native store uses synchronous `commit()`:

```java
static boolean saveSettingsJson(Context context, String settingsJson) {
    if (settingsJson == null || settingsJson.trim().isEmpty()) return false;
    return prefs(context).edit().putString(SETTINGS_KEY, settingsJson).commit();
}
```

The encrypted Capacitor mirror also uses `commit()`:

```java
boolean success = prefs().edit()
    .putString(key, value == null ? "null" : value)
    .commit();
```

### Native encrypted preference store code

Source: `android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java`

```java
static SharedPreferences open(Context context, String prefsName) {
    SharedPreferences cached = cachedPrefs(prefsName);
    if (cached != null) return cached;

    Context appContext = context.getApplicationContext();
    MasterKey masterKey = masterKey(appContext);

    try {
        SharedPreferences prefs = openEncryptedPrefs(appContext, prefsName, masterKey);
        return cachePrefs(prefsName, prefs);
    } catch (GeneralSecurityException | IOException firstOpenError) {
        SecureDelete.wipePlaintextPrefs(appContext, prefsName);
        try {
            SharedPreferences prefs = openEncryptedPrefs(appContext, prefsName, masterKey);
            return cachePrefs(prefsName, prefs);
        } catch (GeneralSecurityException | IOException secondOpenError) {
            throw new IllegalStateException("Encrypted preferences are unavailable.", secondOpenError);
        }
    }
}
```

Expected behavior:

```text
Cached encrypted prefs avoid repeated expensive opens.
First open failure triggers recovery.
Second open failure is a hard error and should surface through save/get failures.
Settings should not silently fall back to insecure plaintext persistence.
```

Master key behavior:

```java
private static MasterKey buildHardwareMasterKey(Context context)
        throws GeneralSecurityException, IOException {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        try {
            return buildMasterKey(context, true);
        } catch (StrongBoxUnavailableException ignored) {}
    }

    return buildMasterKey(context, false);
}
```

Expected behavior:

```text
StrongBox is optional.
No device should lose settings only because StrongBox is unavailable.
If this code changes to hard-require StrongBox, Android settings persistence will fail on many devices and emulators.
```

### MainActivity plugin allowlist

Source: `android/app/src/main/java/com/roadsage/app/MainActivity.java`

```java
private static final List<Class<? extends Plugin>> ROAD_SAGE_PLUGIN_ALLOWLIST = Arrays.asList(
    DriveSenseActivityRecognitionPlugin.class,
    ClipboardPlugin.class,
    SecureKeyPlugin.class,
    EncryptedCapacitorPlugin.class,
    BiometricGatePlugin.class,
    PlayIntegrityPlugin.class
);
```

Review checks:

```text
DriveSenseActivityRecognitionPlugin must remain registered for native settings save/get.
EncryptedCapacitorPlugin must remain registered for encrypted mirror storage.
BiometricGatePlugin must remain registered for app-lock behavior.
PlayIntegrityPlugin must remain registered if runtime integrity status is surfaced.
Removing or renaming any plugin must update tests and docs.
```

### Native settings consumers

Settings that must reach Android native code are read through `NativeSettingsStore.getSettingsJson(...)`.

Native consumers:

```text
RoadSageAutoTrackingService.java
  Reads phone_use_detection_enabled
  Reads notifications_enabled
  Reads notif_safety_alerts_enabled
  Reads notif_phone_use_alert_enabled
  Reads phone_use_live_alert_enabled
  Reads trip_end_notification
  Reads voice_alerts_enabled

MapTileFetchWorker.java
  Reads external_requests_local_only
  Reads map_tiles_enabled
  Reads reverse_geocoding_enabled

DriveSenseAutoTrackingTileService.java
  Reads tracking_mode
  Reads auto_tracking_enabled
  Reads background_tracking_enabled
  Reads tracking_paused
  Writes updated tile-controlled settings through NativeSettingsStore.saveSettingsJson(...)
```

Bug patterns:

```text
If React settings save only reaches browser/local memory, native services will keep old behavior after restart.
If Android tile writes settings but React hydration chooses an older candidate, the tile change can appear to revert.
If a new setting affects native behavior, add it to native JSON read helpers and Android tests.
```

### WebView hardening code

Source: `android/app/src/main/java/com/roadsage/app/MainActivity.java`

```java
settings.setAllowFileAccess(false);
settings.setAllowContentAccess(false);
settings.setAllowFileAccessFromFileURLs(false);
settings.setAllowUniversalAccessFromFileURLs(false);
settings.setGeolocationEnabled(false);
settings.setSaveFormData(false);
settings.setSavePassword(false);
settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
```

Expected behavior:

```text
Settings storage must not depend on WebView cache, form data, password storage, file access, or WebView geolocation.
Privacy-zone current-location features must use native-safe location code because WebView geolocation is disabled.
Network settings must respect mixed-content blocking.
```

### Runtime integrity behavior

Source: `android/app/src/main/java/com/roadsage/app/MainActivity.java`

```java
private void suspendTrackingOnCompromisedRuntime() {
    String status = RuntimeIntegrityCheck.status(this);
    if ("ok".equals(status)) return;
    Log.w(TAG, "Runtime integrity warning: " + status);
    if (BuildConfig.DEBUG && "adb;".equals(status)) return;
    DriveSenseNativeTripStore.setServiceEnabled(this, false);
}
```

Expected behavior:

```text
This disables native tracking service state on compromised runtimes.
It should not directly block settings persistence.
Tracking settings can save correctly while native tracking does nothing because integrity suspended service state.
```

### Android network security

Source: `android/app/src/main/res/xml/network_security_config.xml`

```xml
<base-config cleartextTrafficPermitted="false">
```

Expected behavior:

```text
Ordinary local settings save is unaffected by network security.
HTTP endpoints are blocked or rejected.
OSRM/map/external settings can appear ineffective if host, scheme, certificate, or CSP rules block the request.
```

### Android backup rules

Source: `android/app/src/main/AndroidManifest.xml`

```xml
<application
    android:allowBackup="false"
    android:dataExtractionRules="@xml/data_extraction_rules"
    android:fullBackupContent="@xml/backup_rules">
```

Expected behavior:

```text
Settings survive relaunch, force-stop, and normal app process death.
Settings are not expected to survive uninstall/reinstall.
Settings are not expected to survive Android Auto Backup restore.
Portable settings require Road Sage backup/import.
```

## Security That Can Change Settings Behavior

Security can affect settings in three different ways:

```text
Persistence failure:
  The value is not present after reload or Android force-stop/relaunch.

Security override:
  The value saved, but permissions, local-only mode, endpoint trust, network security, app lock, or runtime integrity intentionally blocks behavior.

Behavior wiring failure:
  The value saved and security allowed it, but the consumer does not read or apply the key.
```

### Android Keystore and encrypted preferences

Native settings depend on Android Keystore-backed `MasterKey` plus `EncryptedSharedPreferences`.

Expected behavior:

```text
Keystore available + commit true:
  settings survive force-stop and relaunch

Keystore unavailable or encrypted prefs unrecoverable:
  setAsync should reject through native save failure
  UI should roll back or show "Setting not saved"
  logs should contain native_settings_sync_async or encrypted preference failure details
```

### StrongBox

StrongBox is optional. The code requests it and falls back when unavailable:

```text
Android P+:
  try StrongBox-backed MasterKey
  fall back to normal MasterKey if StrongBoxUnavailableException occurs
```

Expected behavior: devices without StrongBox must still save settings.

### Plugin allowlist

`MainActivity.java` manually registers the app plugins. Android settings persistence needs:

```text
DriveSenseActivityRecognitionPlugin
EncryptedCapacitorPlugin
BiometricGatePlugin
PlayIntegrityPlugin
```

If the settings or encrypted-storage plugin is removed, the UI may work in memory but Android persistence and native service behavior can fail.

### WebView hardening

The app disables risky WebView features:

```java
settings.setAllowFileAccess(false);
settings.setAllowContentAccess(false);
settings.setAllowFileAccessFromFileURLs(false);
settings.setAllowUniversalAccessFromFileURLs(false);
settings.setGeolocationEnabled(false);
settings.setSaveFormData(false);
settings.setSavePassword(false);
settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
```

Expected behavior:

```text
WebView cache/form/password storage is not the settings source of truth.
WebView geolocation is disabled, so privacy-zone current-location capture must use native-safe location code.
Disabling file/content access must not block encrypted native settings saves.
```

### Android backup and device transfer

The manifest disables Android Auto Backup:

```xml
<application
    android:allowBackup="false"
    android:dataExtractionRules="@xml/data_extraction_rules"
    android:fullBackupContent="@xml/backup_rules">
```

Expected behavior:

```text
Settings should survive app restart and force-stop.
Settings are not expected to survive uninstall/reinstall, OS cloud restore, or device transfer.
Portable settings require Road Sage backup/import.
```

### Network security, CSP, and endpoint trust

Network security does not affect ordinary local settings persistence, but it can make network-related settings appear ineffective.

Expected behavior:

```text
http:// endpoints are rejected or blocked.
OSRM requires trusted HTTPS endpoint, explicit consent, health check, and verified domain.
Local-only mode blocks every external service even when individual toggles were previously on.
Backup import strips OSRM endpoint, consent, health, and trust fields.
```

### Runtime integrity

Runtime integrity warnings can suspend native tracking:

```text
rooted device
emulator-like environment
debugger attached
ADB-enabled release build
```

Expected behavior: tracking settings can persist correctly while native tracking remains disabled. Treat that as a security override first, not a settings save failure.

### Android permissions

Permission keys are stored markers, but Android is the source of truth:

```text
refreshPermissionStatus()
  -> reads OS permission state
  -> updates localSettings marker keys
```

Expected behavior: a user cannot permanently "save" a granted permission marker if Android still denies the permission.

## Debug Procedure

When settings do not behave as expected:

```text
1. Check whether validateSettingsPatch(...) accepted the patch.
2. Check whether localSettings.setAsync(...) returned or rejected.
3. Check whether _settings_revision and _settings_updated_at advanced.
4. Check Android logs for saveSettings called and NativeSettingsStore.commit() result=true.
5. Force-stop and relaunch the app.
6. Compare the Settings UI value with DriveSenseActivityRecognition.getSettings().settingsJson.
7. If the value survived, inspect security overrides: permissions, local-only mode, OSRM trust, network security, runtime integrity, app lock availability.
8. If the value survived and no security override applies, inspect behavior consumers for wrong keys or missing reads.
```

Useful logcat command:

```powershell
adb logcat -c
adb shell am force-stop com.roadsage.app
adb shell monkey -p com.roadsage.app 1
adb logcat -d -v time RoadSage:V RoadSageSettings:V EncryptedPreferenceStore:V AndroidRuntime:E chromium:E *:S
```

Look for:

```text
saveSettings called
NativeSettingsStore.commit() result=true
settings native save confirmed
settings_hydrate_from_native
native_settings_sync_async
Encrypted preferences are unavailable
Native settings plugin unavailable
```

## Expected Results Checklist

For each setting changed by a user, verify:

```text
[ ] Immediate UI state changes to the selected value.
[ ] validateSettingsPatch(...) accepts valid values and rejects invalid values.
[ ] localSettings.setAsync(...) returns the stamped snapshot.
[ ] _settings_revision increases.
[ ] Android native save logs commit true on device.
[ ] Force-stop/relaunch keeps the value.
[ ] The behavior consumer reads the value and changes behavior.
[ ] Security layers either allow the behavior or visibly explain why it is blocked.
[ ] Backup import restores only safe settings and strips unsafe/consent-sensitive values.
```

## AI Reviewer Prompt

Use this focused prompt for Android/security reviews:

```text
Review Road Sage settings persistence and Android security behavior. Compare the code against docs/COMPLETE_SETTINGS_SYSTEM.md and docs/SETTINGS_SYSTEM_ANDROID_SECURITY.md. For each changed setting, determine whether any failure is a persistence failure, a security override, or a behavior wiring failure. Verify validateSettingsPatch, localSettings.setAsync, encryptedCapacitorStorage.set, DriveSenseActivityRecognition.saveSettings, NativeSettingsStore.saveSettingsJson commit, hydration candidate choice, local-only enforcement, permission refresh, OSRM trust, backup import stripping, and the behavior consumer. Return findings first with file paths and line references.
```
