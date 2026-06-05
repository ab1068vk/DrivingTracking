# Complete Settings System Contract

Last reviewed: 2026-06-05

This document is the source-of-truth guide for the Road Sage settings system. It explains what the settings UI changes, where the values are stored, what code consumes them, how Android secure storage affects persistence, and how another AI or reviewer should verify that every setting actually changes the intended behavior.

## Purpose

Use this file when changing, testing, or reviewing any setting. A setting is complete only when all of these are true:

1. The key exists in `DEFAULT_SETTINGS`.
2. The UI control writes the correct key.
3. `validateSettingsPatch()` accepts valid values and rejects unsafe values.
4. `migrateDefaultSettings()` preserves or upgrades old values correctly.
5. `sanitizeImportedSettings()` imports only safe values.
6. The value is saved through `localSettings.setAsync()` or a deliberately documented alternate store.
7. The behavior code reads the saved key and changes output.
8. Unit, integration, UI, or Android persistence tests prove the change.

This document intentionally covers the whole settings system, including UI controls, storage, native Android mirrors, security restrictions, backup/import behavior, expected user-visible results, and the review procedure for another AI. If a setting path is not listed here, treat that as a documentation gap and update this file before accepting the setting change.

## No-Omission Boundary

The settings system includes more than ordinary toggles. Reviewers must include every path below:

```text
Settings page controls in src/pages/Settings.jsx and src/settings/sections/*
Settings search metadata in src/features/settings/hooks/useSettingsSections.js
DEFAULT_SETTINGS, migrations, validation, import sanitization, and localSettings in src/lib/trackingStore.js
Privacy/local-only enforcement in src/lib/privacyControls.js
Android permission state and stored permission markers
Android native settings bridge and encrypted preference stores
Settings-like side stores such as privacy zones, calibration profiles, stealth mode, OSRM endpoint draft/consent, and backup passwords
Behavior consumers that read settings outside the Settings page
Tests that prove persistence, migration/import safety, and actual behavior change
```

Do not call a setting complete only because the Settings screen visually changes. The durable value and the behavior consumer must both change.

## Key Files

Settings UI:

```text
src/pages/Settings.jsx
src/settings/SettingsNavigator.jsx
src/settings/settingsComponents.jsx
src/settings/sections/TrackingSettings.jsx
src/settings/sections/VoiceAlertSettings.jsx
src/settings/sections/ScoringSettings.jsx
src/settings/sections/CalibrationSettings.jsx
src/settings/sections/PrivacySettings.jsx
src/settings/PrivacyZonesSettings.jsx
src/settings/sections/VehicleSettings.jsx
src/settings/sections/UBISettings.jsx
src/settings/sections/AdvancedSettings.jsx
src/features/settings/components/SettingsNav.jsx
src/features/settings/hooks/useSettingsSections.js
```

Settings persistence and validation:

```text
src/lib/trackingStore.js
src/lib/mobileStorage.js
src/lib/encryptedCapacitorStorage.js
src/lib/driveSenseNativePlugin.js
src/lib/storageKeyMigration.js
src/lib/privacyControls.js
src/lib/dataBackup.js
```

Android native storage and security:

```text
android/app/src/main/java/com/roadsage/app/DriveSenseActivityRecognitionPlugin.java
android/app/src/main/java/com/roadsage/app/NativeSettingsStore.java
android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java
android/app/src/main/java/com/roadsage/app/EncryptedCapacitorPlugin.java
android/app/src/main/java/com/roadsage/app/MainActivity.java
android/app/src/main/AndroidManifest.xml
android/app/src/main/res/xml/backup_rules.xml
android/app/src/main/res/xml/data_extraction_rules.xml
android/app/src/main/res/xml/network_security_config.xml
```

Behavior consumers:

```text
src/pages/Dashboard.jsx
src/pages/Diagnostics.jsx
src/components/LiveCoachOverlay.jsx
src/components/TripPlayback.jsx
src/lib/localTripRepository.js
src/lib/notificationService.js
src/lib/voiceAlerts.js
src/lib/voiceAlertQueue.js
src/lib/mapMatching.js
src/lib/openSourceTripContext.js
src/lib/osrmEndpointTrust.js
src/lib/osrmEndpointHealth.js
src/lib/permissions.js
src/lib/biometricLock.js
src/lib/privacyZones.js
src/lib/privacyWipe.js
src/lib/tripInsights.js
src/engine/calibration/baseline.js
src/lib/scoring/componentScores.ts
android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java
android/app/src/main/java/com/roadsage/app/MapTileFetchWorker.java
android/app/src/main/java/com/roadsage/app/DriveSenseAutoTrackingTileService.java
```

Tests:

```text
scripts/settingsFullTest.mjs
src/lib/__tests__/trackingStoreDefaults.test.js
src/lib/__tests__/settingsImportSecurity.test.js
src/features/settings/hooks/__tests__/useSettingsSections.test.js
src/settings/sections/__tests__/ScoringSettings.test.jsx
src/lib/__tests__/voiceAlerts.test.js
src/lib/__tests__/voiceProfileGate.test.js
src/lib/__tests__/trackingStorePrivacyZones.test.js
src/lib/__tests__/trackingStoreDefaults.test.js
src/lib/__tests__/storageKeyMigration.test.js
src/lib/__tests__/schemaMigrations.test.js
src/lib/__tests__/dataBackupImportSecurity.test.js
tests/android-uiautomator-settings-full.mjs
```

## End-To-End Save Flow

The main settings snapshot is owned by `src/lib/trackingStore.js` and displayed by `src/pages/Settings.jsx`.

```text
Settings section control
  -> ctx.updateCfg(patch)
  -> validateSettingsPatch(patch)
  -> optimistic cfg state update
  -> localSettings.setAsync(optimistic)
  -> browser/local runtime mirror
  -> encrypted Capacitor mirror
  -> DriveSenseActivityRecognition.saveSettings(settingsJson)
  -> NativeSettingsStore.saveSettingsJson(...)
  -> EncryptedSharedPreferences.commit()
  -> Android Keystore-backed MasterKey
```

The save function in `src/pages/Settings.jsx` is intentionally async and rollback-capable:

```jsx
const updateCfg = useCallback(async (patch) => {
  const validation = validateSettingsPatch(patch);
  if (!validation.valid) {
    toast({ title: 'Setting not saved', description: validation.errors[0], variant: 'destructive' });
    return cfg;
  }

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

The durable store path in `src/lib/trackingStore.js` queues async writes:

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

Android persistence is confirmed by native `commit()`:

```java
static boolean saveSettingsJson(Context context, String settingsJson) {
    if (settingsJson == null || settingsJson.trim().isEmpty()) return false;
    return prefs(context).edit().putString(SETTINGS_KEY, settingsJson).commit();
}
```

## Storage Layers

The code keeps `SETTINGS_KEY = 'drivesense_settings'` for migration compatibility, then resolves it through `resolveStorageKey(...)`. The current stored key is `road_sage_settings`. The legacy key is `drivesense_settings`. Code should use the storage helpers instead of hard-coding either key.

Storage layers:

```text
Web:
  localStorage road_sage_settings

Native Android:
  memorySettings during runtime
  browser localStorage mirror for recovery
  EncryptedCapacitorPlugin road_sage_capacitor_preferences_v2
  DriveSenseActivityRecognition native settings store road_sage_native_settings_v2
  plain Capacitor Preferences only as legacy migration fallback
```

Hydration on Android chooses the best candidate using:

```text
1. Highest _settings_revision
2. Latest _settings_updated_at
3. onboarding_completed true
4. Highest non-default setting delta count
```

The functions are:

```text
chooseSettingsHydrationCandidate(...)
chooseHydrationCandidateAfterLocalMutations(...)
reconcileSettingsHydrationSnapshot(...)
localSettings.hydrateFromNative()
```

Any settings reset bug must answer:

```text
Did updateCfg produce a new _settings_revision?
Did setJson finish?
Did DriveSenseActivityRecognition.saveSettings resolve?
Did NativeSettingsStore.commit() return true?
Did hydration later choose an older candidate?
```

Important compatibility rule:

```text
Settings UI saves must use localSettings.setAsync(...) or localSettings.updateAsync(...).
Legacy or secondary UI paths that still use localSettings.update(...) are best-effort and should be reviewed if they affect durable user preferences.
Android force-stop persistence depends on both encryptedCapacitorStorage.set(...) and DriveSenseActivityRecognition.saveSettings(...) completing.
```

## Defaults And Setting Keys

All normal settings must be in `DEFAULT_SETTINGS` in `src/lib/trackingStore.js`. Unknown keys may temporarily exist in an optimistic object, but they are not part of the supported settings contract and are dropped by backup import sanitization.

Current setting groups:

| Area | Keys |
| --- | --- |
| Metadata | `settings_defaults_version`, `_settings_revision`, `_settings_updated_at` |
| Tracking | `tracking_mode`, `auto_tracking_enabled`, `background_tracking_enabled`, `tracking_paused`, `live_coaching_enabled` |
| Permissions | `notification_permission_granted`, `activity_permission_granted`, `location_permission_granted`, `background_location_granted`, `phone_usage_access_granted` |
| Appearance | `units`, `currencySymbol`, `dark_mode` |
| Notifications legacy/master | `notifications_enabled`, `trip_start_notification`, `trip_end_notification`, `weekly_report_notification`, `achievement_notifications`, `safe_driving_reminder` |
| Notification channels | `notif_safety_alerts_enabled`, `notif_phone_use_alert_enabled`, `notif_heading_drift_alert_enabled`, `notif_speeding_alert_enabled`, `notif_post_trip_summary_enabled`, `notif_post_trip_score_change`, `notif_post_trip_phone_use`, `notif_post_trip_fuel_saving`, `notif_coaching_enabled`, `notif_streak_enabled`, `notif_weekly_pattern_enabled`, `notif_style_shift_enabled`, `notif_maintenance_enabled`, `notif_inactive_nudge_enabled`, `notif_inactive_nudge_days`, `notif_quiet_hours_enabled`, `notif_quiet_start`, `notif_quiet_end`, `notif_min_score_for_post_trip`, `danger_zone_alerts_enabled` |
| Voice alerts | `voice_alerts_enabled`, `voice_alert_rate`, `voice_alert_volume`, `voice_alerts_min_severity`, `voice_earcon_enabled`, `voice_quiet_hours_enabled`, `voice_quiet_hours_start`, `voice_quiet_hours_end` |
| App privacy/security | `biometric_lock_enabled`, `lock_timeout_minutes`, `data_retention_months`, `external_requests_local_only`, `backend_sync_enabled`, `calibration_sharing_enabled` |
| Map privacy | `privacy_zones`, `last_map_center`, `map_tiles_enabled`, `map_tiles_first_prompt_seen`, `reverse_geocoding_enabled`, `road_data_fetch_always_allow` |
| Scoring thresholds | `threshold_harsh_brake_ms2`, `threshold_rapid_accel_ms2`, `threshold_stop_start_decel_ms2`, `threshold_sharp_turn_g_low`, `threshold_sharp_turn_g_medium`, `threshold_sharp_turn_g_high`, `threshold_speeding_kmh`, `threshold_speed_over_kmh`, `threshold_idle_seconds`, `threshold_long_drive_minutes`, `min_speed_rapid_accel_kmh`, `min_speed_harsh_brake_kmh` |
| Eco scoring | `threshold_eco_cruise_min_kmh`, `threshold_eco_cruise_max_kmh`, `eco_cruise_score_multiplier`, `eco_idle_penalty_multiplier`, `eco_idle_max_penalty`, `eco_min_moving_kmh` |
| Night scoring | `night_detection_mode`, `night_start_time`, `night_end_time`, `night_sunset_offset_minutes`, `night_sunrise_offset_minutes` |
| Advanced safety | `threshold_manoeuvre_alert_brake_ms2`, `threshold_manoeuvre_alert_turn_degs`, `threshold_heading_drift_std_degs`, `threshold_speed_creep_kmh`, `threshold_overtake_accel_ms2`, `advanced_safety_detection_enabled`, `lane_change_score_enabled` |
| Phone use | `threshold_phone_proxy_oscillations`, `phone_use_detection_enabled`, `phone_use_live_alert_enabled`, `phone_use_show_on_map`, `phone_use_affects_score`, `phone_use_sensitivity`, `phone_micro_steer_count`, `phone_micro_steer_window_s`, `phone_proxy_max_accuracy_m`, `phone_creep_rate_kmh_s`, `phone_lane_drift_deg`, `phone_coupling_threshold`, `phone_confidence_threshold`, `phone_min_window_s` |
| External road/weather | `speed_limit_lookup_enabled`, `country_code`, `configurable_country_defaults`, `weather_context_enabled`, `external_context_auto_fetch_enabled` |
| OSRM | `map_matching_enabled`, `osrm_map_matching_url`, `osrm_public_demo_consent_at`, `osrm_data_sharing_consented`, `osrm_data_sharing_consented_at`, `osrm_health_status`, `osrm_last_health_checked_at`, `osrm_last_reachable_at`, `osrm_last_health_error`, `osrm_verified_endpoint`, `osrm_verified_origin`, `osrm_verified_domain`, `osrm_trust_verified_at`, `osrm_timeout_ms` |
| Goals and UBI | `weekly_goal_harsh_brakes`, `weekly_goal_speeding_events`, `weekly_goal_min_avg_score`, `weekly_goal_max_night_trips`, `weekly_goal_max_night_km`, `ubi_optimal_annual_km`, `ubi_mileage_score_spread_km` |
| Advanced models | `sensor_fusion_enabled`, `crash_detection_enabled`, `emergency_workflow_enabled`, `predictive_route_risk_enabled`, `route_risk_disclaimer_seen_count`, `obd_bluetooth_enabled` |
| Economics | `co2_baseline_kg_per_100km`, `default_ev_kwh_per_100km`, `grid_co2_kg_per_kwh`, `tree_co2_kg_per_year` |
| Onboarding/calibration | `onboarding_completed`, `calibration_profile_key` |

## UI Sections And Effects

| UI group | Section IDs | Primary files | What it changes |
| --- | --- | --- | --- |
| Tracking | `settings-tracking`, `settings-android-permissions`, `settings-feature-permissions` | `TrackingSettings.jsx`, `Settings.jsx`, `permissions.js`, `activityRecognition.js` | Tracking mode, Android permission state, native background service start/stop, pause state |
| Notifications | `settings-notifications`, `settings-voice-alerts`, `settings-driving-goals` | `TrackingSettings.jsx`, `VoiceAlertSettings.jsx`, `ScoringSettings.jsx`, `notificationService.js`, `voiceAlerts.js` | Notification scheduling, alert channels, spoken alerts, weekly goals |
| Scoring | `settings-detection-thresholds`, `settings-night-window`, `settings-speed-warning`, `settings-calibration`, `settings-advanced-models`, `settings-phone-use` | `ScoringSettings.jsx`, `AdvancedSettings.jsx`, `CalibrationSettings.jsx`, `componentScores.ts`, `baseline.js`, `localTripRepository.js` | Detection thresholds, scoring constants, rescoring provenance, road/weather context, phone-use gates |
| Privacy & Data | `settings-privacy-data` | `PrivacySettings.jsx`, `privacyControls.js`, `privacyWipe.js`, `dataBackup.js`, `biometricLock.js` | Local-only mode, app lock, retention, backup/import/export, trip map privacy zones, destructive data actions |
| Privacy zones | `settings-privacy-zones` | `PrivacyZonesSettings.jsx`, `usePrivacyZones.js`, `trackingStore.js`, Android `PrivacyZoneStore` | Parked-location privacy zones saved separately from `DEFAULT_SETTINGS.privacy_zones` |
| Appearance | `settings-appearance`, `settings-economics` | `VehicleSettings.jsx`, `trackingStore.js`, `tripInsights.js`, `pdfExport.js` | Theme, units, currency, emissions/economics calculations |
| UBI Coaching | `settings-ubi` | `UBISettings.jsx`, scoring/economics consumers | UBI-style coaching assumptions only |

## Complete Settings UI Control Inventory

This inventory is the literal user-facing settings surface as of 2026-06-05. It covers controls in `src/pages/Settings.jsx`, `src/settings/SettingsNavigator.jsx`, `src/settings/sections/*.jsx`, `src/settings/osrm/OsrmEndpointPanel.jsx`, and `src/settings/privacy-zones/*.jsx`.

Use it to answer "does every toggle, button, slider, input, field, selector, and dialog have a documented key or side effect?" If the UI adds a new control, add it here in the same change.

### Shared Control Shell

| Control | Type | Store or handler | Notes |
| --- | --- | --- | --- |
| Settings search | Text input | `settingsSearch` React state, `getSettingsSearchResults()` | Searches `SETTINGS_SECTIONS`; does not persist. |
| Clear settings search | Icon button | `setSettingsSearch('')` | Clears search and returns to normal section navigation. |
| Search result item | Button | `jumpToSection(sectionId)` | Switches active settings group and scrolls to a legacy section ID. |
| Settings group navigation | Button set | `SettingsNav` active group state | Groups are Tracking, Scoring, Privacy & Data, Privacy zones, Notifications, Appearance, UBI Coaching. |
| Saved indicator | Status chip | `saved` React state | Shows only after a successful settings write. |
| Lane-change migration notice | Button | `dismissHeadingEventMigrationNote()` | Writes `TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY` with `setJson()`. |
| Score estimate warning | Static note | `SCORE_ESTIMATE_NOTICE` | No control; required safety context for settings edits. |
| About block | Static metadata | `__APP_VERSION__` and app constants | No setting writes. |

The shared row and toggle controls are:

```jsx
export function SettingRow({ icon: Icon = null, label, sublabel = '', children = null, onClick = null, danger = false }) {
  return (
    <div onClick={onClick}>
      <div>{label}</div>
      {sublabel && <div>{sublabel}</div>}
      {children}
    </div>
  );
}

export function Toggle({ value, onChange, disabled = false }) {
  return (
    <button disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange(!value); }}>
      <div />
    </button>
  );
}
```

### Tracking Controls

| Label | Type | Key or side effect | Handler | Constraints and expected effect |
| --- | --- | --- | --- | --- |
| Manual Only | Segmented button | `tracking_mode`, `auto_tracking_enabled`, `background_tracking_enabled`, `tracking_paused` | `enableTrackingMode('manual')` | Stops native tracking on Android, sets manual mode, turns auto flags off. |
| Auto-Detect | Segmented button | `tracking_mode: 'auto_detect'`, `auto_tracking_enabled: true`, `background_tracking_enabled: false` | `enableTrackingMode('auto_detect')` | Requires foreground location and physical activity where Android applies. |
| Background Auto | Segmented button | `tracking_mode: 'background_auto'`, `auto_tracking_enabled: true`, `background_tracking_enabled: true` | `enableTrackingMode('background_auto')` | Requires foreground location, background location, physical activity, notifications, and native service start. |
| Pause All Tracking | Toggle | `tracking_paused` | `updateTrackingPaused()` | Pausing stops native background tracking. Unpausing can restart native tracking if mode is `background_auto`. |
| Auto-Tracking | Toggle | `auto_tracking_enabled`, `tracking_mode` | On: `enableTrackingMode('auto_detect')`; off: stop native then `updateCfg({ auto_tracking_enabled: false, tracking_mode: 'manual' })` | Disabled by pause state through value calculation. |
| Background Tracking | Toggle | `background_tracking_enabled`, `auto_tracking_enabled`, `tracking_mode` | On: `enableTrackingMode('background_auto')`; off: stop native then reset to manual | Refreshes permission/native status after disabling. |

Tracking mode writes are intentionally multi-key:

```jsx
await updateCfg({
  tracking_mode: 'manual',
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  tracking_paused: false,
});
```

### Android Permission Controls

| Label | Type | Key or side effect | Handler | Constraints and expected effect |
| --- | --- | --- | --- | --- |
| Native Auto Tracking | Status badge | Native service status | `getNativeAutoTrackingStatus()` through page context | Android only. Shows whether the native service is armed. |
| Location | Badge plus Enable button | Real OS permission and `location_permission_granted` marker | `requestForegroundLocationPermission()` then `refreshPermissions()` | Permission marker can be overwritten by OS refresh. |
| Background Location | Badge plus Enable button | Real OS permission and `background_location_granted` marker | `requestBackgroundLocationPermission()` then `refreshPermissions()` | Required only for background auto tracking. |
| Physical Activity | Badge plus Enable button | Real OS permission and `activity_permission_granted` marker | `requestActivityRecognitionPermission()` then `refreshPermissions()` | Required for Android activity recognition. |
| Notifications | Badge plus Enable button | Real OS permission and `notification_permission_granted` marker | `requestNotificationPermission()` then `refreshPermissions()` | Notification toggles cannot fully enable without OS grant. |
| Motion Sensors | Badge plus Enable button | Motion support and permission state | `handleMotionPermission()` | Only requests on platforms that require a motion permission. |
| Bluetooth / Nearby Devices | Badge plus Enable button | Bluetooth permission and OBD pairing support | `handleObdPairing()` | Also used by the OBD-II Bluetooth control. |
| Phone Usage Access | Badge plus Enable button | Android Usage Access state and `phone_usage_access_granted` marker | `openAndroidUsageAccessSettings()` then `refreshPermissions()` | Android only; required for confirmed phone-use scoring. |
| Battery Optimization | Row button | Battery optimization exemption status | `handleBatteryOptimization()` | Opens Android settings for unrestricted background activity. |

### Feature Permission Rows

These are explanatory rows with `FeaturePermissionBadge` and optional Enable buttons. They do not create new setting keys.

| Feature row | Type | Action |
| --- | --- | --- |
| Trip history, search, tags, notes, favorites, calendar, weekly summary, goals, costs | Badge only | No prompt. |
| Route comparison, commute detection, road types, parking reminder, repeated event areas | Badge plus Enable | `requestForegroundLocationPermission()`. |
| Maintenance reminders and weekly driver digests | Badge plus Enable | `requestNotificationPermission()`. |
| Background auto tracking for richer repeated-route history | Badge plus Enable | `requestBackgroundLocationPermission()`. |
| Sensor fusion, crash detection, phone movement, and incident check-in | Badge plus Enable | `handleMotionPermission()`. |
| Real speed limits, weather, optional OSRM matching, and offline route previews | Badge only | No prompt here; controlled by external-data settings. |
| Live voice alerts and rule-based driving coach summaries | Badge only | No microphone, cloud, or paid AI prompt. |
| OBD-II Bluetooth diagnostics | Badge plus Enable | `handleObdPairing()`. |

### Notification Controls

All controls in this group use `updateNotificationSetting(patch)`, which can request Android notification permission and calls `syncReminderNotifications(updated)` after saving.

| Label | Type | Key | Dependencies |
| --- | --- | --- | --- |
| Enable all notifications | Toggle | `notifications_enabled` | Effective value also requires real notification permission. |
| Quiet hours | Toggle | `notif_quiet_hours_enabled` | Disabled when master notifications are off. |
| Quiet hours Start | Time input | `notif_quiet_start` | Enabled only when `notif_quiet_hours_enabled` is true. |
| Quiet hours End | Time input | `notif_quiet_end` | Enabled only when `notif_quiet_hours_enabled` is true. |
| Safety alerts channel | Toggle | `notif_safety_alerts_enabled` | Master safety gate for non-safety while-driving alerts. |
| Phone use warning | Toggle | `notif_phone_use_alert_enabled` | Disabled when safety alerts channel is off. |
| Attention pattern warning | Toggle | `notif_heading_drift_alert_enabled` | Disabled when safety alerts channel is off. |
| Speeding alert | Toggle | `notif_speeding_alert_enabled` | Disabled when safety alerts channel is off. |
| Repeated event area alerts | Toggle | `danger_zone_alerts_enabled` | Disabled when safety alerts channel is off. |
| Live coaching overlay | Toggle | `live_coaching_enabled` | Disabled when safety alerts channel is off. |
| Trip started | Toggle | `trip_start_notification` | Disabled when master notifications are off. |
| Trip ended | Toggle | `trip_end_notification` | Disabled when master notifications are off. |
| Post-trip smart summary | Toggle | `notif_post_trip_summary_enabled` | Master gate for post-trip smart notification children. |
| Score improvements and declines | Toggle | `notif_post_trip_score_change` | Disabled when smart summary is off. |
| Phone use report | Toggle | `notif_post_trip_phone_use` | Disabled when smart summary is off. |
| Eco fuel savings | Toggle | `notif_post_trip_fuel_saving` | Disabled when smart summary is off. |
| Only notify if score is at least | Range slider | `notif_min_score_for_post_trip` | `0..100`, step `5`; `0` means always notify when a rule matches. |
| Coaching notifications | Toggle | `notif_coaching_enabled` | Master gate for coaching `notif_*` children. |
| Achievements | Toggle | `achievement_notifications` | Not a `notif_*` child; controlled by master notifications. |
| Streak milestones | Toggle | `notif_streak_enabled` | Disabled when coaching notifications are off. |
| Weekly driving summary | Toggle | `notif_weekly_pattern_enabled` | Disabled when coaching notifications are off. |
| Classic weekly report | Toggle | `weekly_report_notification` | Legacy weekly report. |
| Driving style shift alerts | Toggle | `notif_style_shift_enabled` | Disabled when coaching notifications are off. |
| Safe driving tips | Toggle | `safe_driving_reminder` | Occasional reminders. |
| Maintenance reminders | Toggle | `notif_maintenance_enabled` | Vehicle notification channel. |
| No-trip nudge | Toggle | `notif_inactive_nudge_enabled` | Enables inactive-trip reminder. |
| Nudge after | Select | `notif_inactive_nudge_days` | Options: `3`, `5`, `7`, `14` days; disabled when nudge is off. |

### Voice Alert Controls

| Label | Type | Key or side effect | Values |
| --- | --- | --- | --- |
| Test | Button | Calls `runVoiceTest()` and `testVoiceAlert(cfg)` | Disabled when `voice_alerts_enabled` is false. |
| Voice alerts | Toggle | `voice_alerts_enabled` | Master spoken-alert gate. |
| Alert speech rate | Select | `voice_alert_rate` | `0.7` Slow, `1.0` Normal, `1.2` Fast. |
| Alert volume | Select | `voice_alert_volume` | `0.3` Low, `0.6` Medium, `0.9` Loud, `1.0` Full. |
| Minimum alert level | Select | `voice_alerts_min_severity` | `0` All, `1` Warnings and above, `2` Danger and above, `3` Critical only. |
| Alert tone | Toggle | `voice_earcon_enabled` | Brief cue before speech. |
| Quiet hours | Toggle | `voice_quiet_hours_enabled` | Suppresses non-critical spoken alerts. |
| Voice quiet Start | Time input | `voice_quiet_hours_start` | Rendered only when voice quiet hours are on. |
| Voice quiet End | Time input | `voice_quiet_hours_end` | Rendered only when voice quiet hours are on. |

### Driving Goals Controls

All are range sliders saved with `updateCfg({ [key]: Number(value) })`.

| Label | Key | Min | Max | Step |
| --- | --- | --- | --- | --- |
| Max harsh brakes | `weekly_goal_harsh_brakes` | `0` | `20` | `1` |
| Max speeding events | `weekly_goal_speeding_events` | `0` | `20` | `1` |
| Minimum average score | `weekly_goal_min_avg_score` | `50` | `100` | `5` |
| Max night km | `weekly_goal_max_night_km` | `0` | `100` | `5` |
| Max night trips | `weekly_goal_max_night_trips` | `0` | `14` | `1` |

### Night Driving Window Controls

| Label | Type | Key | Constraints |
| --- | --- | --- | --- |
| Sunset | Segmented button | `night_detection_mode: 'sunset'` | Uses GPS/date when available; falls back to custom hours. |
| Custom | Segmented button | `night_detection_mode: 'custom'` | Enables custom start/end inputs. |
| Custom night hours Start | Time input | `night_start_time` | Disabled unless custom mode is selected. |
| Custom night hours End | Time input | `night_end_time` | Disabled unless custom mode is selected. |
| Sunset offset | Range slider | `night_sunset_offset_minutes` | UI `-120..120`, step `15`; validator allows `-180..180`. |
| Sunrise offset | Range slider | `night_sunrise_offset_minutes` | UI `-120..120`, step `15`; validator allows `-180..180`. |

### Detection Threshold Controls

| Label | Type | Key or side effect | Constraints |
| --- | --- | --- | --- |
| Driving Pattern Definitions | Row button | Opens `patternGuideOpen` dialog | Dialog explains scoring terms; no settings write. |
| Locked / Editing | Button | `thresholdEditingEnabled` React state | Unlocks detection sliders; not persisted. |
| Lane-change diagnostic | Toggle | `lane_change_score_enabled` | Diagnostic score gate; safety weight remains governed by graduation policy. |
| Analyse my driving / Re-analyze | Button | `runCalibration()` | Builds a calibration profile from local trips and current thresholds. |
| Apply suggested thresholds | Button | `applyCalibration()` | Saves suggested threshold keys and queues completed trips for re-score. |
| Dismiss | Button | `dismissCalibration()` | Clears calibration profile side store. |
| Re-score outdated/completed trips | Button | `rescoreTrips()` | Marks completed trips for re-score. |
| Calibration registry | Details disclosure | `PROVISIONAL_SCORING_CONSTANTS` | Read-only list of provisional constants. |

Detection sliders saved through `updateCfg()`:

| Label | Key | UI range | Step | Unit |
| --- | --- | --- | --- | --- |
| Harsh Braking | `threshold_harsh_brake_ms2` | `2..8` | `0.5` | `m/s^2` |
| Rapid Acceleration | `threshold_rapid_accel_ms2` | `1.5..6` | `0.5` | `m/s^2` |
| Stop-Start Decel | `threshold_stop_start_decel_ms2` | `1.5..5` | `0.25` | `m/s^2` |
| Sharp Turn Low | `threshold_sharp_turn_g_low` | `0.2..0.6` | `0.05` | `g` |
| Sharp Turn Medium | `threshold_sharp_turn_g_medium` | `0.25..0.8` | `0.05` | `g` |
| Sharp Turn High | `threshold_sharp_turn_g_high` | `0.35..1.0` | `0.05` | `g` |
| Speeding fallback | `threshold_speeding_kmh` | `80..160` | `5` | `km/h` |
| Idle Event | `threshold_idle_seconds` | `90..300` | `30` | `s` |
| Eco Cruise Min | `threshold_eco_cruise_min_kmh` | `20..90` | `5` | `km/h` |
| Eco Cruise Max | `threshold_eco_cruise_max_kmh` | `80..140` | `5` | `km/h` |
| Eco Moving Floor | `eco_min_moving_kmh` | `0..30` | `1` | `km/h` |
| Eco Cruise Multiplier | `eco_cruise_score_multiplier` | `50..200` | `5` | `x` |
| Eco Idle Multiplier | `eco_idle_penalty_multiplier` | `0..300` | `5` | `x` |
| Eco Idle Cap | `eco_idle_max_penalty` | `0..50` | `1` | `pts` |
| Harsh Brake Min Speed | `min_speed_harsh_brake_kmh` | `5..60` | `5` | `km/h` |
| Rapid Accel Min Speed | `min_speed_rapid_accel_kmh` | `0..40` | `5` | `km/h` |

Advanced safety controls:

| Label | Type | Key | Constraints |
| --- | --- | --- | --- |
| Advanced Safety Detection | Toggle | `advanced_safety_detection_enabled` | Disables score-affecting advanced safety signals while diagnostics may still collect. |
| Brake-Turn Alert Braking | Range slider | `threshold_manoeuvre_alert_brake_ms2` | `2.5..5.0`, step `0.5`, disabled unless editing and advanced safety are on. |
| Brake-Turn Alert Heading Rate | Range slider | `threshold_manoeuvre_alert_turn_degs` | `15..60`, step `5`, disabled unless editing and advanced safety are on. |
| GPS Attention Signal Threshold | Range slider | `threshold_heading_drift_std_degs` | `5..15`, step `1`, disabled unless editing and advanced safety are on. |
| Phone Proxy Sensitivity | Range slider | `threshold_phone_proxy_oscillations` | `6..8`, step `1`, diagnostic only. |
| Speed Creep Alert | Range slider | `threshold_speed_creep_kmh` | `5..25`, step `5`. |
| Overtake Development Diagnostic | Range slider | `threshold_overtake_accel_ms2` | `3.0..5.0`, step `0.5`, diagnostic only. |

### Speed Warning And External Road Data Controls

| Label | Type | Key or side effect | Constraints |
| --- | --- | --- | --- |
| Automatic road-data fetching | Toggle | `external_context_auto_fetch_enabled` | Uses `updateExternalContextAutoFetch()`, confirmation dialog, disabled by local-only mode. |
| Live Speed Warning | Toggle | `speed_warning_enabled` | Gates fallback speed warning. |
| Get posted speed limits | Toggle | `speed_limit_lookup_enabled` | Disabled by local-only mode; opt-in Overpass request. |
| Fallback limit country | Select | `country_code`, `configurable_country_defaults` | Options: Global, Canada, United States, United Kingdom, Germany, Australia, France. |
| Get trip weather | Toggle | `weather_context_enabled` | Disabled by local-only mode; opt-in Open-Meteo request. |
| Warn when over limit by | Range slider | `threshold_speed_over_kmh` | UI `5..30`, step `5`; disabled when live speed warning is off. |

### Coaching Calibration Controls

| Label | Type | Key or side effect | Notes |
| --- | --- | --- | --- |
| Rated trips progress | Progress bar | Query-derived markers | No setting write. |
| What does provisional mean? | Button | Opens `explainOpen` dialog | Dialog-only educational content. |
| Calibration sharing | Toggle | `calibration_sharing_enabled` | Same key also appears in Privacy & Data as a checkbox. |
| Rate recent unrated trips | Button | Navigates to `/trips?filter=unlabeled` | Rendered only when recent unrated trip count is high. |

### Advanced Model Controls

| Label | Type | Key or side effect | Constraints |
| --- | --- | --- | --- |
| Sensor fusion model | Toggle plus optional Enable button | `sensor_fusion_enabled`; `handleMotionPermission()` | Disabled when motion support is unavailable. |
| Crash / incident detection | Toggle | `crash_detection_enabled` | Disabled when sensor fusion is off. |
| Emergency workflow | Toggle | `emergency_workflow_enabled` | Disabled when crash detection is off. |
| Advanced: Route snapping (OSRM) | Details disclosure | None | Reveals OSRM controls. |
| Learn how to self-host OSRM | External link | Opens Project OSRM docs | No setting write. |
| Snap route to roads (OSRM) | Toggle | `map_matching_enabled` | `enableOsrmMapMatching()` requires local-only off and verified endpoint. |
| Network timeout | Range slider | `osrm_timeout_ms` | UI seconds `5..30`, step `1`, saved as milliseconds. |
| Trusted OSRM endpoint | Text input | `osrmEndpointDraft` until save | Placeholder `https://your-osrm.example`; not durable until consent and health check pass. |
| Save endpoint | Button | `requestSaveOsrmEndpoint()` | Requires trusted HTTPS endpoint, consent, and successful health check. |
| Turn off + clear | Button | Clears OSRM endpoint and trust fields | Calls `saveOsrmEndpoint('', true)`. |
| Historical context estimate | Toggle | `predictive_route_risk_enabled` | Controls route risk/history estimate. |
| OBD-II Bluetooth Pair | Button | `handleObdPairing()` | Requires Bluetooth support and permission. |
| OBD-II Bluetooth | Toggle | `obd_bluetooth_enabled` | Disabled when OBD BLE support is unavailable. |

OSRM clear writes this full safety reset:

```jsx
await updateCfg({
  map_matching_enabled: false,
  osrm_map_matching_url: '',
  osrm_public_demo_consent_at: '',
  osrm_data_sharing_consented: false,
  osrm_data_sharing_consented_at: '',
  osrm_health_status: '',
  osrm_last_health_checked_at: '',
  osrm_last_reachable_at: '',
  osrm_last_health_error: '',
  osrm_verified_endpoint: '',
  osrm_verified_origin: '',
  osrm_verified_domain: '',
  osrm_trust_verified_at: '',
});
```

### Phone Use Detection Controls

| Label | Type | Key or side effect | Constraints |
| --- | --- | --- | --- |
| Usage Access status | Badge plus Enable button | Android Usage Access state | Enable opens Android Usage Access settings then refreshes permissions. |
| Detect phone use while driving | Toggle | `phone_use_detection_enabled` | Master gate for phone-use UI and scoring. |
| Phone use live alert | Toggle | `phone_use_live_alert_enabled`, `notif_phone_use_alert_enabled` | Updates both phone-use live alert and notification channel. |
| Detection sensitivity Low | Segmented button | `phone_use_sensitivity: 'low'` | Disabled when phone-use detection is off. |
| Detection sensitivity Medium | Segmented button | `phone_use_sensitivity: 'medium'` | Default and recommended. |
| Detection sensitivity High | Segmented button | `phone_use_sensitivity: 'high'` | More sensitive. |
| Show on trip map | Toggle | `phone_use_show_on_map` | Disabled when phone-use detection is off. |
| Include in trip score | Toggle | `phone_use_affects_score` | Disabled when phone-use detection is off. |
| Expert phone-use tuning locked/editable badge | Status chip | `thresholdEditingEnabled` | Same non-persisted edit lock as threshold sliders. |
| Micro-steer count | Range slider | `phone_micro_steer_count` | `6..8`, step `1`, disabled unless editing and detection are on. |
| Speed creep rate | Range slider | `phone_creep_rate_kmh_s` | `0.5..4`, step `0.25`. |
| Lane drift angle | Range slider | `phone_lane_drift_deg` | `3..18`, step `1`. |
| Coupling threshold | Range slider | `phone_coupling_threshold` | `0.05..0.4`, step `0.05`. |
| Confidence threshold | Range slider | `phone_confidence_threshold` | `0.15..0.8`, step `0.05`. |
| Minimum window | Range slider | `phone_min_window_s` | `2..12`, step `1`. |

### Privacy And Data Controls

| Label | Type | Key or side effect | Constraints |
| --- | --- | --- | --- |
| Privacy, Legal & Safety | Row button | Opens privacy notice dialog | No settings write. |
| Share anonymized calibration labels | Checkbox | `calibration_sharing_enabled` | Disabled by local-only mode; badge switches local/external. |
| Local-only mode | Toggle | `external_requests_local_only` | Forces external request settings off through `enforceLocalOnlyPatch()`. |
| Load online map tiles | Toggle | `map_tiles_enabled`, `map_tiles_first_prompt_seen` | Disabled by local-only mode. |
| Reverse geocode parked locations | Toggle | `reverse_geocoding_enabled` | Disabled by local-only mode. |
| Backend sync | Toggle | `backend_sync_enabled` | Disabled by local-only mode. |
| Last external requests | Audit log panel | `readOutboundDataLog()` | Read-only local audit log of optional outbound services. |
| App lock (optional) | Toggle | `biometric_lock_enabled` plus biometric side store | On Android, authenticates device credential before enabling. |
| Auto-lock after | Select | `lock_timeout_minutes` | Options: `1`, default, `15`, max, `0` Never; disabled when app lock is off. |
| Stealth Trip Mode | Toggle | Runtime state in `ephemeralTripMode.js` | Not durable settings; disabled during an active or already ephemeral trip. |
| Trip Map Privacy Zones label | Text input | `privacyDraft.label` before save | Placeholder Home, work, school. |
| Trip Map Privacy Zones radius | Number input | `privacyDraft.radius_m` before save | `50..1000` m, step `10`, warns below recommended radius. |
| Add Current | Button | `savePrivacyZone(location, 'Current location')` | Saves current GPS zone to `privacy_zones`. |
| Add Parked | Button | `savePrivacyZone(parkedLocation, 'Parked location')` | Disabled without parked location. |
| Existing trip privacy zone radius | Number input | `privacy_zones[index].radius_m` | `50..1000` m, commits on blur or Enter. |
| Existing trip privacy zone delete | Icon button | Removes zone from `privacy_zones` | Uses `deletePrivacyZone(zone.id)`. |
| Export All Trips | Row button | Opens encrypted CSV export dialog | File leaves app. |
| Export Full Backup | Row button | Opens encrypted backup export dialog | File leaves app; backup masks privacy-zone centers. |
| Import Backup | File input | `handleBackupFileSelected()` then import dialog | Accepts `.json` and `.rsbackup`; merges safe data. |
| Data Retention | Select | `data_retention_months` | Options: `6`, `12`, `24`, `36`, `0`; calls `enforceDataRetention()`. |
| Delete All Trips | Danger row button | Deletes trip repository data | Confirmation handled by `handleDeleteAllTrips()`. |
| Wipe All Road Sage Data | Danger row button | Factory reset for local app data and native caches | Confirmation handled by `handleWipeAllData()`. |

### Parked Privacy Zones Controls

This is separate from trip-map `privacy_zones`. It uses `getPrivacyZones()` and `savePrivacyZones()` from `trackingStore.js`, backed by Android Preferences/native privacy-zone storage where available.

| Label | Type | Store or handler | Constraints |
| --- | --- | --- | --- |
| Add zone | Button | Opens `PrivacyZoneDialog` in add mode | No immediate write. |
| Edit privacy zone | Icon button | Opens dialog in edit mode | Per-zone row action. |
| Delete privacy zone | Icon button | `deleteZone(index)` after `confirm()` | Removes from parked privacy-zone side store. |
| Name | Text input | Dialog draft `name` | Required to save. |
| Privacy zone radius | Radix slider | Dialog draft `radius` | `ZONE_RADIUS_MIN_M..ZONE_RADIUS_MAX_M`, step `10`. |
| Use current location | Button | `getCurrentLocation()` into draft lat/lng | Required lat/lng before save. |
| Cancel | Button | Closes dialog | No write. |
| Save zone | Button | `addZone(zone)` or `updateZone(index, zone)` | Disabled until name and valid coordinates exist. |

### Appearance And Economics Controls

| Label | Type | Key | Values or range |
| --- | --- | --- | --- |
| Light | Theme button | `dark_mode: 'light'` | Applies theme immediately through `applyThemeMode()`. |
| Dark | Theme button | `dark_mode: 'dark'` | Applies theme immediately. |
| System | Theme button | `dark_mode: 'system'` | Follows OS preference. |
| Metric (km/h) | Units button | `units: 'metric'` | Affects display/export formatting. |
| Imperial (mph) | Units button | `units: 'imperial'` | Affects display/export formatting. |
| Currency symbol | Select | `currencySymbol` | `CURRENCY_SYMBOL_OPTIONS`. |
| Average vehicle CO2 baseline | Number input | `co2_baseline_kg_per_100km` | `0..50`, step `0.1`. |
| Default EV efficiency | Number input | `default_ev_kwh_per_100km` | `5..40`, step `0.1`. |
| Grid CO2 intensity | Number input | `grid_co2_kg_per_kwh` | `0..2`, step `0.001`. |
| Tree-year equivalent | Number input | `tree_co2_kg_per_year` | `1..100`, step `0.1`. |

### UBI Coaching Controls

| Label | Type | Key | Range |
| --- | --- | --- | --- |
| UBI optimal annual km | Range slider | `ubi_optimal_annual_km` | `3000..30000`, step `500`. |
| UBI mileage spread km | Range slider | `ubi_mileage_score_spread_km` | `2000..20000`, step `500`. |

### Dialogs, File Fields, And Consent Checkpoints

| Dialog | Control | Type | Store or handler |
| --- | --- | --- | --- |
| Export Backup / Export Trips | Export password | Password/text input | `backupExportPassword`, max `BACKUP_PASSWORD_MAX_LENGTH`, validates strength. |
| Export Backup / Export Trips | Show/hide export password | Icon button | `backupExportPasswordVisible`. |
| Export Backup / Export Trips | Confirm export password | Password/text input | `backupExportConfirm`, must match. |
| Export Backup / Export Trips | Cancel | Button | Closes dialog and clears password state. |
| Export Backup / Export Trips | Export Backup / Export Trips | Button | `performExportBackup()`, disabled until password is valid and matching. |
| Import Backup | Backup password | Password/text input | `backupImportPassword`, accepts old 12+ character backups. |
| Import Backup | Show/hide import password | Icon button | `backupImportPasswordVisible`. |
| Import Backup | Cancel | Button | Closes dialog and clears import state. |
| Import Backup | Import | Button | `handleImportPasswordSubmit()`, disabled until password validates. |
| OSRM consent | Consent checkbox | Checkbox | `osrmConsentChecked`. |
| OSRM consent | Cancel | Button | Closes consent dialog. |
| OSRM consent | Confirm and check endpoint | Button | `acceptOsrmDataSharingConsent()`, then endpoint health check and save. |
| Privacy notice | Done | Button | Closes privacy notice dialog. |
| Driving Pattern Definitions | Dialog close | Radix dialog close | No setting write. |
| Provisional calibration explanation | Dialog close | Radix dialog close | No setting write. |

### Validation, Import, And Local-Only Enforcement Code

Every control that writes `DEFAULT_SETTINGS` must pass `validateSettingsPatch()`. Unknown keys in a patch are ignored by validation but are not part of the supported settings contract and should not be written by settings UI.

```js
export function validateSettingsPatch(patch = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, errors: ['Settings update must be an object.'] };
  }

  Object.entries(patch).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
    if (SETTINGS_ENUMS[key] && !SETTINGS_ENUMS[key].includes(value)) {
      errors.push(`${key} must be one of: ${SETTINGS_ENUMS[key].join(', ')}.`);
      return;
    }
    if (IMPORT_NUMBER_RANGES[key]) {
      const number = finiteSettingsNumber(value);
      const [min, max] = IMPORT_NUMBER_RANGES[key];
      if (number == null || number < min || number > max) {
        errors.push(`${key} must be between ${min} and ${max}.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}
```

Current enum validation:

```js
const SETTINGS_ENUMS = {
  tracking_mode: ['manual', 'auto_detect', 'background_auto'],
  units: ['metric', 'imperial'],
  currencySymbol: CURRENCY_SYMBOL_OPTIONS.map((option) => option.value),
  dark_mode: ['system', 'light', 'dark'],
  night_detection_mode: ['sunset', 'custom'],
  phone_use_sensitivity: ['low', 'medium', 'high'],
  configurable_country_defaults: ['global', 'ca', 'us', 'gb', 'uk', 'de', 'au', 'fr'],
};
```

Import strips endpoint trust and revision metadata:

```js
const IMPORT_STRIPPED_KEYS = new Set([
  '_settings_revision',
  '_settings_updated_at',
  'settings_defaults_version',
  'osrm_map_matching_url',
  'osrm_public_demo_consent_at',
  'osrm_data_sharing_consented',
  'osrm_data_sharing_consented_at',
  'osrm_health_status',
  'osrm_last_health_checked_at',
  'osrm_last_reachable_at',
  'osrm_last_health_error',
  'osrm_verified_endpoint',
  'osrm_verified_origin',
  'osrm_verified_domain',
  'osrm_trust_verified_at',
]);
```

Local-only mode must stay a hard override. If either current settings or imported settings has `external_requests_local_only: true`, imported external toggles must return disabled:

```js
if (currentSettings.external_requests_local_only === true || raw.external_requests_local_only === true) {
  return enforceLocalOnlyPatch({ ...sanitized, external_requests_local_only: true });
}
```

## Additional Settings Writers Outside The Settings Page

The Settings page is not the only place settings can change. These paths are important when a value changes "by itself" or when a user claims Settings did not keep their choice.

| Writer | File | Keys or store changed | Why it exists |
| --- | --- | --- | --- |
| Onboarding completion | `src/pages/Onboarding.jsx` | `onboarding_completed`, `tracking_mode`, `auto_tracking_enabled`, `background_tracking_enabled`, `map_tiles_enabled`, `map_tiles_first_prompt_seen`, `speed_limit_lookup_enabled`, `weather_context_enabled`, `external_context_auto_fetch_enabled`, `map_matching_enabled` | Saves first-run setup choices and network/data-sharing choices before the user reaches Settings. |
| Onboarding location row | `src/pages/Onboarding.jsx` | `location_permission_granted` | Stores the latest foreground location prompt result. Real OS state can overwrite it later. |
| Onboarding motion/activity row | `src/pages/Onboarding.jsx` | `activity_permission_granted` | Stores the latest Android Physical Activity prompt result. Motion sensor state is platform-specific and not a durable normal setting. |
| Onboarding notification row | `src/pages/Onboarding.jsx` | `notification_permission_granted` | Stores the latest notification prompt result. Real OS state remains authoritative. |
| Onboarding road-data quick enable | `src/pages/Onboarding.jsx` | `external_context_auto_fetch_enabled`, `speed_limit_lookup_enabled`, `weather_context_enabled` | Lets onboarding opt into automatic OSM/Open-Meteo context for new trips. |
| App startup onboarding reconciliation | `src/App.jsx`, `src/lib/trackingStore.js` | `onboarding_completed` plus `ONBOARDING_COMPLETED_KEY` side marker | If the marker exists, startup can preserve onboarding completion even if a settings snapshot is older. |
| Trip map online tile prompt | `src/components/TripMap.jsx` | `map_tiles_enabled`, `map_tiles_first_prompt_seen` | First map tile load prompts for online tiles outside Settings; later tile enables skip the prompt. |
| Trip playback online tile prompt | `src/components/TripPlayback.jsx` | `map_tiles_enabled`, `map_tiles_first_prompt_seen` | Same tile-consent behavior for playback maps. |
| Trip playback last center persistence | `src/components/TripPlayback.jsx` | `last_map_center` | Stores a valid lat/lng center with `tripId`, `source`, and `updated_at` so future maps can open near useful context. |
| Tracking-store map center helper | `src/lib/trackingStore.js` | `last_map_center` | Persists sanitized map center from map/default location helpers. Invalid or `0,0` centers are rejected. |
| Map screen road-data consent | `src/pages/MapScreen.jsx` | `road_data_fetch_always_allow` | Allows repeated road-data fetches without prompting every time. Local-only mode forces this false. |
| Dashboard route-risk disclaimer | `src/pages/Dashboard.jsx` | `route_risk_disclaimer_seen_count` | Counts disclaimer display so the dashboard can avoid repeatedly interrupting the user. |
| Android Quick Settings tile | `DriveSenseAutoTrackingTileService.java` | `tracking_mode`, `auto_tracking_enabled`, `background_tracking_enabled`, `tracking_paused` | Native tile can arm background auto tracking or pause it without opening React. It writes through `NativeSettingsStore.updateSettingsFields(...)`. |
| Android permission refresh/request helpers | `src/lib/permissions.js` | Permission marker keys plus denial counters such as `_location_denial_count` | Synchronizes UI markers with real Android permission state. Denial counters are hidden operational metadata, not user preferences. |
| OSRM endpoint verifier | `src/lib/osrmEndpointVerifier.js`, `src/lib/osrmEndpointHealth.js` | OSRM health/trust fields | Can refresh health or trust metadata after checks. Import must still strip these fields. |
| Calibration profile application | `src/lib/thresholdCalibration.js` and Settings calibration flow | Threshold keys plus `calibration_profile_key` | Applying a calibration profile changes ordinary threshold settings and records which profile was applied. |
| Privacy wipe | `src/lib/privacyWipe.js` | Resets settings and keeps `onboarding_completed: true` | Factory reset behavior intentionally clears user data/settings but avoids forcing the whole onboarding route again. |

Hidden and operational settings that do not have a normal visible Settings control:

| Key or side store | Owner | Notes |
| --- | --- | --- |
| `settings_defaults_version` | `trackingStore.js` | Migration version. Users should never edit it. Backup import strips it. |
| `_settings_revision` | `trackingStore.js`, `NativeSettingsStore.java` | Stamped on writes so hydration can choose the newest snapshot. Backup import strips it. |
| `_settings_updated_at` | `trackingStore.js`, `NativeSettingsStore.java` | Timestamp companion to `_settings_revision`. Backup import strips it. |
| `onboarding_completed` | `Onboarding.jsx`, `App.jsx`, `trackingStore.js` | Has both settings snapshot storage and the `road_sage_onboarding_completed_v1` marker. |
| `last_map_center` | Map/playback helpers | Must be sanitized lat/lng; can include `tripId`, `source`, `updated_at`. |
| `map_tiles_first_prompt_seen` | Map components and Settings | Records whether the online-tile consent prompt was already shown. |
| `road_data_fetch_always_allow` | Map road-data flow | Local-only mode and migration force it false when external requests are disabled. |
| `route_risk_disclaimer_seen_count` | Dashboard route-risk UI | UX counter, not a scoring setting. |
| `calibration_profile_key` | Calibration profile flow | Records applied calibration profile identity. |
| Permission denial counters | `permissions.js` | Internal counters used to decide whether Android permission rows should say denied, needs settings, or unknown. |
| `OUTBOUND_DATA_LOG_KEY` | `privacyControls.js` | Audit log `road_sage_outbound_data_log_v1`, capped at 40 entries; not part of `DEFAULT_SETTINGS`. |
| Backup export/import passwords | Dialog React state only | Never saved. They exist only long enough to encrypt/decrypt the selected file. |
| Stealth Trip Mode state | `ephemeralTripMode.js` | Runtime-only next-trip privacy mode; not a durable settings key. |

Non-Settings writers should use the same safety rules as Settings:

```text
Durable preference writes should go through localSettings.setAsync(), localSettings.updateAsync(), localSettings.update(), or the documented native store path.
External request choices must obey external_requests_local_only.
Permission marker writes must be treated as cached OS state, not user preference.
Native writes must stamp _settings_revision and _settings_updated_at.
Backup import must not restore trust, consent, revision metadata, or unsafe external request state.
```

## Behavior Consumer Map

Use this map to verify that a changed setting affects real behavior.

| Setting family | Main consumers | Expected effect |
| --- | --- | --- |
| `tracking_mode`, `auto_tracking_enabled`, `background_tracking_enabled`, `tracking_paused` | `Dashboard.jsx`, `activityRecognition.js`, Android `RoadSageAutoTrackingService` | Changes manual, foreground auto-detect, or native background auto behavior. Pause blocks tracking start/resume. |
| Permission marker keys | `permissions.js`, `PermissionContext.jsx`, `TrackingSettings.jsx`, `Dashboard.jsx` | UI readiness and stored markers follow real Android permission state. These can be overwritten by permission refresh. |
| `dark_mode` | `Settings.jsx`, `applyThemeMode()` | Adds/removes the document `dark` class or follows system preference. |
| `units` | dashboard, coach, insights, PDF/export formatting | Changes displayed distance/speed units. |
| Notification keys | `notificationService.js`, `LiveCoachOverlay.jsx`, `TrackingSettings.jsx` | Enables/disables schedules and runtime notifications. Quiet hours suppress non-safety notification groups. |
| Voice keys | `voiceAlerts.js`, `voiceAlertQueue.js`, Android TTS plugin | Controls spoken alert gate, rate, volume, severity floor, earcon, and quiet-hours suppression. |
| Threshold keys | `componentScores.ts`, `baseline.js`, `localTripRepository.js`, `tripEngine.js` | Changes event detection, score calculation, score provenance, and whether completed trips need re-score. |
| `night_*` keys | scoring constants, trip insights, dashboard goals | Changes night-trip classification and night goals. Sunset mode uses GPS/date when available. |
| Phone-use keys | `phoneUsageAccess.js`, `LiveCoachOverlay.jsx`, scoring pipeline | Gates Android Usage Access evidence, map display, live alerts, and score penalties. GPS proxy remains diagnostic. |
| External request keys | `privacyControls.js`, `openSourceTripContext.js`, `mapMatching.js`, `osrmEndpointHealth.js`, `TripPlayback.jsx` | Controls whether OpenStreetMap, Open-Meteo, OSRM, map tiles, Nominatim, calibration upload, or backend sync can run. |
| `external_requests_local_only` | `privacyControls.js`, migrations, settings UI | Forces external request settings off and keeps dependent UI disabled. |
| OSRM keys | `osrmEndpointTrust.js`, `osrmEndpointHealth.js`, `mapMatching.js`, `openSourceTripContext.js` | Requires trusted HTTPS endpoint, user consent, health check, and verified domain before route snapping runs. |
| `privacy_zones` | `privacyZones.js`, `TripPlayback.jsx`, `dataBackup.js`, `trackingStore.js` parked location guard | Masks trip map/export/backup route data and blocks parked-location save inside protected zones. |
| parked privacy zones | `PrivacyZonesSettings.jsx`, `trackingStore.getPrivacyZones/savePrivacyZones`, Android `PrivacyZoneStore` | Separate Android preference-backed zones for parked-car/widget privacy. |
| `biometric_lock_enabled`, `lock_timeout_minutes` | `biometricLock.js`, `App.jsx`, `PrivacySettings.jsx` | Requires device credential after inactivity or backgrounding. |
| `data_retention_months` | `localTripRepository.enforceDataRetention()` | Deletes completed trips older than the selected retention window. |
| Economics keys | `tripInsights.js`, reports/PDF, dashboard cost summaries | Changes CO2, tree-year, EV, fuel/economic estimates. |
| UBI keys | UBI coaching score consumers | Changes UBI mileage assumptions only, not insurance/underwriting. |
| `sensor_fusion_enabled`, `crash_detection_enabled`, `emergency_workflow_enabled` | `Dashboard.jsx`, `sensorFusionModel.js` | Enables motion fusion, crash-like detection, and local incident workflow gates. |
| `predictive_route_risk_enabled`, `route_risk_disclaimer_seen_count` | `Dashboard.jsx`, route risk modules | Shows/hides historical context estimates and tracks disclaimer display count. |

## User Change Expected Results Matrix

Use this table to answer: "When the user changes this setting, what should actually happen?"

| User changes | Immediate expected result | Durable expected result | Security or permission modifier |
| --- | --- | --- | --- |
| Tracking mode/manual/auto/background | UI selection updates; pause/native controls reflect the mode. | Relaunch keeps the selected mode; Android quick settings tile reads the same mode from native settings. | Background auto is still ineffective until foreground location, background location, activity recognition, notifications, and battery behavior are acceptable. Runtime integrity can suspend native tracking even when settings saved. |
| Tracking pause | UI shows paused/unpaused state and start controls obey it. | Relaunch and native tile keep the paused state. | Native service state can still be stopped by OS restrictions or integrity checks. |
| Android permission request | Permission badge changes only after real OS state changes. | Stored permission markers are refreshed from Android state on later checks. | The OS is the authority; stored markers are not normal preferences and may be overwritten. |
| Units or currency | Distances, speeds, costs, summaries, and exports format with the selected values. | Relaunch keeps the formatting choice. | Existing raw trip data does not change; only display/export formatting changes. |
| Dark mode | Document theme changes to light, dark, or system. | Relaunch applies the same theme before the Settings page is opened. | WebView cache clearing must not be relied on for theme persistence; native/settings mirror is the durable source. |
| Notification master/channel toggles | UI toggles update; notification scheduling/gates are recalculated. | Relaunch keeps notification preferences and Android service reads native values. | Android notification permission can still block delivery even when app settings enable notifications. Quiet hours and per-channel toggles can suppress individual notifications. |
| Voice alert settings | Test alert, rate, volume, earcon, quiet hours, and severity gate follow the new values. | Native/JS alert paths read the same values after restart. | Android TTS, audio focus, silent mode, and notification/foreground service behavior can prevent audible output. |
| Detection/scoring thresholds | Future scoring/detection uses the new thresholds; affected completed trips can be marked for re-score. | Relaunch keeps thresholds and scoring-version hash changes when scoring settings change. | Invalid ranges are rejected. Eco multipliers cannot both be zero because that disables Eco scoring. |
| Night window mode/times | Night-trip classification and night goals use sunset or custom window rules. | Relaunch keeps the chosen night rule. | Sunset mode depends on route/date/location availability; missing GPS/date can fall back. |
| Phone-use detection/scoring/map toggles | Usage Access evidence, live alert, map display, and score penalty gates follow the toggles. | Relaunch and native service keep the selected gates. | Android Usage Access is required for true app-usage evidence. GPS proxy diagnostics must not become score penalties unless the intended score gate allows it. |
| Local-only mode | External toggles are forced off and disabled in UI. | Relaunch keeps local-only mode and dependent external toggles remain false. | This must block map tiles, OSM speed limits, Open-Meteo, OSRM, Nominatim reverse geocoding, calibration upload, and backend sync. |
| Map tiles/reverse geocoding/road/weather toggles | Maps/context panels show ON/OFF and fetch paths are allowed or skipped accordingly. | Relaunch keeps the selected network preferences unless local-only is on. | CSP, Android network security, endpoint trust, and privacy zones can still block requests. |
| OSRM endpoint/consent/map matching | Endpoint is saved only after trust, consent, health, and verified domain pass; route snapping becomes available. | Relaunch keeps trusted endpoint metadata only when saved by the explicit consent path. | Backup import strips endpoint, consent, health, and trust fields to prevent silent data redirection. HTTP and untrusted/private endpoints are rejected. |
| Privacy zones | Route/event/export masking and parked-location privacy respond to the zone set. | Relaunch keeps the appropriate zone store; Android widget uses native privacy-zone store. | Trip privacy zones and parked/widget privacy zones are related but not identical stores. Backup export strips private zone center coordinates. |
| Biometric/app lock | App requires device credential according to enabled state and timeout. | Relaunch keeps lock preference and applies it early in app startup. | If Android credential/biometric APIs are unavailable, the UI must report that clearly and avoid implying a working lock. |
| Retention window | Completed trips older than the selected window are pruned when retention enforcement runs. | Relaunch keeps the retention value. | `0` means no automatic deletion. Deletion is destructive and must be tested carefully. |
| Backup/export/import | Dialogs enforce password rules; export/import runs through sanitizer/encryption paths. | Imported safe settings persist; unsafe settings are stripped or clamped. | Passwords are never stored. Backup import cannot silently enable unsafe external endpoints or background auto tracking. |
| Stealth Trip Mode | The next trip is memory-only and route/event persistence is suppressed for that trip. | The armed state is runtime behavior, not a normal durable setting. | It must not corrupt ordinary settings persistence or backup/import behavior. |
| Calibration sharing/profile | Sharing toggle controls upload gate; applied profile updates threshold keys. | Relaunch keeps safe settings and applied threshold values. | Local-only mode disables sharing. Imported calibration/threshold values must be sanitized. |
| Vehicle/economics/UBI assumptions | Cost, CO2, EV, tree-year, mileage, and coaching assumptions recalculate. | Relaunch keeps the assumptions. | These are estimates only and must not be presented as official insurance or legal records. |

If the "Immediate expected result" works but the "Durable expected result" fails, inspect validation, `localSettings.setAsync(...)`, Android encrypted storage, native `commit()`, and hydration candidate selection. If the durable value works but behavior does not change, inspect the behavior consumer map for a key mismatch or missing read.

## Android Native Consumer Map

Some settings affect native Android code directly, not only the React/WebView app. Review these paths whenever Android tracking, notifications, voice, map tiles, or quick settings behavior changes.

| Native file | Settings read or written | Expected effect |
| --- | --- | --- |
| `RoadSageAutoTrackingService.java` | `phone_use_detection_enabled`, `notifications_enabled`, `notif_safety_alerts_enabled`, `notif_phone_use_alert_enabled`, `phone_use_live_alert_enabled`, `trip_end_notification`, `voice_alerts_enabled` | Gates native phone-use detection, live safety alerts, trip-complete notification, and native spoken alert forwarding. Notification precedence is master plus channel: `notifications_enabled` must be true and the specific channel toggle must also be true. |
| `MapTileFetchWorker.java` | `external_requests_local_only`, `map_tiles_enabled`, `reverse_geocoding_enabled` | Blocks tile fetches and reverse geocoding when local-only mode is on or the specific feature is off. |
| `DriveSenseAutoTrackingTileService.java` | `tracking_mode`, `auto_tracking_enabled`, `background_tracking_enabled`, `tracking_paused` | Android quick settings tile reads current native settings and writes background-auto/pause state through `NativeSettingsStore.updateSettingsFields(...)`, which stamps `_settings_revision` and `_settings_updated_at`. |

Native setting reads use `NativeSettingsStore.getSettingsJson(...)`, so a setting that only changes browser storage but not the native settings snapshot will not affect these services after process restart.

Notification precedence applies in both JS and native code: `notifications_enabled` is the master gate, and each channel toggle is a secondary gate. A channel fires only when both the master and that channel are enabled.

## Validation Rules

`validateSettingsPatch()` rejects invalid known keys and ignores unknown keys. Ignoring unknown keys is intentional but dangerous for new settings: a typo can appear to save in a transient object without becoming a real setting.

Known enum validations:

```text
tracking_mode: manual, auto_detect, background_auto
units: metric, imperial
currencySymbol: values from CURRENCY_SYMBOL_OPTIONS
dark_mode: system, light, dark
night_detection_mode: sunset, custom
phone_use_sensitivity: low, medium, high
configurable_country_defaults: global, ca, us, gb, uk, de, au, fr
```

Known numeric ranges are in `IMPORT_NUMBER_RANGES`. Important examples:

```text
data_retention_months: 0..120
lock_timeout_minutes: 0..30
voice_alert_rate: 0.7..1.2
voice_alert_volume: 0.3..1
voice_alerts_min_severity: 0..3
osrm_timeout_ms: 5000..30000
threshold_harsh_brake_ms2: 2..8
threshold_rapid_accel_ms2: 0.5..15
threshold_speed_over_kmh: 0..80
eco_cruise_score_multiplier: 50..200
eco_idle_penalty_multiplier: 0..300
```

Special validations:

```text
last_map_center must be a valid lat/lng object and cannot be 0,0.
osrm_map_matching_url must pass evaluateOsrmEndpointTrust().
Eco cruise and idle multipliers cannot both be zero because that disables Eco score.
Local-only mode rewrites related external request settings through enforceLocalOnlyPatch().
```

## Migration Rules

`CURRENT_SETTINGS_DEFAULTS_VERSION` is `12`. When changing defaults or renaming keys:

1. Increase `CURRENT_SETTINGS_DEFAULTS_VERSION`.
2. Add migration logic to `migrateDefaultSettings()`.
3. Add import alias logic to `sanitizeImportedSettings()` when old backups need to carry values forward.
4. Add tests in `src/lib/__tests__/trackingStoreDefaults.test.js`.

Current important migrations:

```text
v2 adjusts old threshold defaults.
v3 preserves custom night windows and updates default fixed night end.
v5 raises GPS phone proxy defaults and clamps overtake diagnostic floor.
legacy tailgate/near-miss/drowsy keys migrate to neutral metric names.
legacy data_retention_days migrates to data_retention_months.
v11 makes road/weather auto-fetch opt-in.
v12 makes external request toggles local-first and enforces local-only mode.
eco scoring repair restores defaults if both eco multipliers are zero or missing.
```

## Backup Import Security

Backup import is intentionally not a blind settings restore.

Backup/export flow:

```text
buildDriveSenseBackup(...)
  -> creates backup payload with trips, vehicles, safe settings, saved filters, metadata
exportDriveSenseBackup(...)
  -> JSON serializes
  -> encrypts when password is supplied
  -> writes/downloads `.rsbackup` or export payload
parseDriveSenseBackup(...)
  -> validates Road Sage backup shape
migrateBackup(...)
  -> upgrades old backup versions
importDriveSenseBackup(...)
  -> enforces MAX_BACKUP_BYTES
  -> decrypts password-protected backups
  -> calls sanitizeImportedSettings(...)
  -> merges safe settings into localSettings
```

Important file: `src/lib/dataBackup.js`.

`sanitizeImportedSettings()`:

```text
copies only keys present in DEFAULT_SETTINGS
drops unknown keys and prototype pollution attempts
clamps numbers
validates enums
masks or strips unsafe privacy data
strips settings revision metadata
strips OSRM endpoint, consent, health, and trust fields
does not import background_auto tracking mode
```

Stripped OSRM/security keys:

```text
_settings_revision
_settings_updated_at
osrm_map_matching_url
osrm_public_demo_consent_at
osrm_data_sharing_consented
osrm_data_sharing_consented_at
osrm_health_status
osrm_last_health_checked_at
osrm_last_reachable_at
osrm_last_health_error
osrm_verified_endpoint
osrm_verified_origin
osrm_verified_domain
osrm_trust_verified_at
```

Expected result: an imported backup can restore safe user preferences, but it cannot silently redirect GPS route samples to a new OSRM endpoint or re-enable background auto tracking.

## Android Security Contract

Android secure settings depend on:

```text
MainActivity plugin allowlist
  -> DriveSenseActivityRecognitionPlugin
  -> NativeSettingsStore
  -> EncryptedPreferenceStore
  -> EncryptedSharedPreferences
  -> Android Keystore MasterKey road_sage_master_key_v3
```

Required plugins in `MainActivity.java`:

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

The settings bridge must validate JSON before native save:

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

StrongBox is optional, not required:

```java
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    try {
        return buildMasterKey(context, true);
    } catch (StrongBoxUnavailableException ignored) {}
}
return buildMasterKey(context, false);
```

Encrypted preference recovery:

```text
First open fails
  -> wipe plaintext prefs
  -> wipe encrypted prefs
  -> reset master key alias
  -> retry with fresh key
Second open fails
  -> throw IllegalStateException
```

Expected Android behavior:

```text
Settings survive force-stop and relaunch if native commit succeeds.
Settings do not have to survive uninstall/reinstall or Android cloud restore.
Android backup rules intentionally exclude sensitive settings/storage.
Runtime integrity warnings can suspend native tracking, but should not directly block settings save.
```

## Security Effects On Settings Behavior

Yes: app security can affect whether a settings change saves, survives restart, or produces the expected behavior. Review security effects as part of every settings change.

| Security layer | What it can affect | Expected behavior |
| --- | --- | --- |
| Android Keystore and `EncryptedSharedPreferences` | `NativeSettingsStore`, `EncryptedCapacitorPlugin`, and native hydration. | If encrypted storage opens and `commit()` succeeds, durable settings should survive force-stop/relaunch. If encrypted storage fails, UI must not claim durable success for `setAsync()` saves. |
| StrongBox availability | Master key creation on Android P and newer. | StrongBox is requested opportunistically and falls back to a normal MasterKey. Lack of StrongBox must not block basic settings persistence. |
| Encrypted preference corruption or invalidated keys | Native settings read/write and encrypted mirror read/write. | First-open recovery can wipe/retry. If recovery fails, settings save should reject/log and the user may see a save failure. Do not silently reset user settings without an audit trail. |
| Plugin allowlist in `MainActivity.java` | Whether `DriveSenseActivityRecognition.saveSettings(...)`, privacy-zone bridge, encrypted storage, biometric gate, and Play Integrity are available. | Removing the settings or encrypted-storage plugin breaks Android persistence and must fail tests. |
| WebView hardening | Cache/form/password/geolocation/file access behavior. | Hardening must not be treated as settings persistence. WebView geolocation is disabled, so location-dependent settings must use native-safe location paths. |
| Android backup exclusions | Uninstall/reinstall, cloud restore, and device transfer expectations. | Settings are not expected to survive uninstall/reinstall or OS restore. Use Road Sage backup/import for portable settings. |
| Network security config and CSP | OSRM, map tiles, OSM, Open-Meteo, Nominatim, backend sync, and external context fetches. | Network security does not affect ordinary local settings persistence, but it can make network-related settings appear ineffective when hosts, cleartext, pins, or CSP rules block requests. |
| Runtime integrity checks | Native tracking service behavior on compromised or debug-like environments. | Integrity warnings can suspend native tracking, so tracking settings can save correctly while native tracking remains disabled. This is not a settings persistence failure. |
| Android runtime permissions | Permission marker settings and feature availability. | Real OS permission state wins. Permission marker keys can be overwritten by `refreshPermissionStatus(...)`. |
| Local-only privacy mode | Every external-data setting. | Enabling local-only mode rewrites dependent external toggles to false through `enforceLocalOnlyPatch(...)`; this is intended security behavior, not a save bug. |
| Backup/import sanitizer | Restored settings after backup import. | Unsafe or non-portable settings are stripped or clamped, including OSRM endpoint/trust metadata and background-auto imports. |
| Biometric/device credential availability | App lock behavior. | The setting can persist while the actual lock is unavailable. UI/tests must verify the Android credential path, not just the stored boolean. |

Security review rule:

```text
When a user says "the setting did not work," separate three cases:
1. Persistence failure: the saved value is not present after reload/restart.
2. Security override: the value saved, but security/permissions/local-only mode intentionally blocked behavior.
3. Behavior wiring failure: the value saved, security allowed it, but the consumer did not read or apply it.
```

## Settings That Are Not Plain Preferences

Some controls are related to settings but are not only values in `DEFAULT_SETTINGS`.

| Area | Store or source | Notes |
| --- | --- | --- |
| Android permissions | Android OS plus stored markers | `refreshPermissionStatus()` can overwrite markers with real OS state. |
| Parked privacy zones | `getPrivacyZones()`/`savePrivacyZones()` and Android `PrivacyZoneStore` | Separate from trip map `privacy_zones`. Used for parked-car/widget privacy. |
| Stealth Trip Mode | `ephemeralTripMode.js` runtime state | Arms one memory-only trip. It is not a durable normal setting. |
| Calibration profile | `thresholdCalibration.js` storage | Applying a profile saves threshold keys, but the profile itself is separate. |
| Backup export/import password | transient dialog state | Never stored as a setting. |
| OSRM endpoint draft | React state until consent and health pass | Only saved after trust, consent, and health checks succeed. |
| Data deletion/wipe | command paths | These mutate repositories/storage, not just settings. |

## Verification Commands

Run fast code-level checks:

```powershell
npm.cmd test -- src/lib/__tests__/trackingStoreDefaults.test.js
npm.cmd test -- src/lib/__tests__/settingsImportSecurity.test.js
npm.cmd test -- src/features/settings/hooks/__tests__/useSettingsSections.test.js
npm.cmd test -- src/settings/sections/__tests__/ScoringSettings.test.jsx
```

Run the full test suite:

```powershell
npm.cmd test
```

Build the app:

```powershell
npm.cmd run build
```

Android persistence audit, after installing the debug APK and connecting a device:

```powershell
npm.cmd run build
cd android
.\gradlew.bat installDebug
cd ..
npm.cmd run test:android:settings
```

The Android audit proves:

```text
Settings route renders.
Every settings group is visible.
Search finds important nested controls.
Major UI controls mutate real settings.
Native settings bridge receives the changes.
The changed settings survive force-stop and relaunch.
Launch logs have no fatal Android or JavaScript exceptions.
```

`scripts/settingsFullTest.mjs` is the broad non-device lifecycle audit. It checks default filling, migration, import sanitization, boolean round trips, theme/unit/retention round trips, OSRM timeout validation, calibration profile merge, settings search, settings-version hashing, UBI settings, notification settings, backup seal/verify/migrate behavior, privacy wipe reset simulation, ephemeral-mode interaction, and biometric integration.

Use it when a change is too broad for one targeted unit test:

```powershell
npm.cmd run test:settings-contract
```

The important settings-effect checks in that script are:

```text
DEFAULT_SETTINGS contains every migrated key.
migrateDefaultSettings(DEFAULT_SETTINGS) round-trips.
sanitizeImportedSettings() preserves safe known keys and strips unsafe keys.
localSettings round-trips boolean, enum, number, notification, UBI, and retention settings.
settingsVersionFromSnapshot() changes when a scoring setting changes.
Backup integrity includes sanitized settings.
Ephemeral trip mode does not block ordinary settings persistence.
Biometric lock state stays connected to settings.
```

## Current Local Audit Findings

Current local audit command:

```powershell
npm.cmd run test:settings-contract
```

Result on 2026-06-05:

```text
277 passed
0 failed
0 skipped
```

The current contract suite covers defaults, migrations, import sanitization, prototype-pollution defenses, settings validation, threshold bounds, voice-setting corruption recovery, themes, privacy zones, biometric timeout handling, Stealth Trip Mode, retention, currencies, speed-limit country fallback, OSRM trust, calibration profiles, settings navigation/search, scoring-version hashing, backup encryption/integrity, UBI settings, notification gates, clamp utilities, privacy-zone formatting, and a full settings lifecycle.

This script is a deterministic contract audit, not a replacement for Vitest, Playwright, Android instrumentation, or connected-device persistence checks.

## Manual Device Checks

Use when a user reports "settings say saved but reset later".

```powershell
adb logcat -c
adb shell am force-stop com.roadsage.app
adb shell monkey -p com.roadsage.app 1
adb logcat -d -v time RoadSage:V RoadSageSettings:V EncryptedPreferenceStore:V AndroidRuntime:E chromium:E *:S
```

Check for:

```text
saveSettings called
NativeSettingsStore.commit() result=true
settings native save confirmed
settings_hydrate_from_native
Encrypted preferences are unavailable
Native settings plugin unavailable
```

Use WebView debugger or the Android audit to compare:

```text
localStorage road_sage_settings
DriveSenseActivityRecognition.getSettings().settingsJson
```

The native value is the important restart survivor.

## New Setting Checklist

Use this exact checklist for every new setting:

```text
[ ] Add key and default to DEFAULT_SETTINGS.
[ ] Add validation in SETTINGS_ENUMS or IMPORT_NUMBER_RANGES if applicable.
[ ] Add special validation to validateSettingsPatch() if needed.
[ ] Add migration in migrateDefaultSettings() if the default changes or legacy keys exist.
[ ] Add backup import behavior in sanitizeImportedSettings().
[ ] Decide whether import should strip the setting for safety.
[ ] Add UI control in the correct settings section.
[ ] Ensure UI calls updateCfg(), updateNotificationSetting(), or an explicitly documented alternate save path.
[ ] Add search metadata in SETTINGS_SECTIONS if the setting should be discoverable.
[ ] Wire the behavior consumer to read the setting.
[ ] Add or update tests proving the setting changes behavior.
[ ] Add Android persistence coverage if the setting is user-visible and durable.
[ ] Confirm local-only, permissions, and privacy restrictions do not contradict the setting.
[ ] Confirm backup/export/import expectations are documented.
```

## AI Reviewer Prompt

Paste this into another AI reviewer when settings are changed:

```text
You are reviewing the Road Sage settings system. Inspect the repository and compare the change against docs/COMPLETE_SETTINGS_SYSTEM.md. Do not assume a setting works because the UI changes state. For every changed or added setting, verify:

1. The key exists in DEFAULT_SETTINGS in src/lib/trackingStore.js.
2. validateSettingsPatch() accepts valid values and rejects invalid or unsafe values.
3. migrateDefaultSettings() preserves old user data and updates defaults safely.
4. sanitizeImportedSettings() imports, clamps, or strips the key intentionally.
5. The UI writes the exact key through updateCfg(), updateNotificationSetting(), or a documented alternate store.
6. The behavior code reads the key and actually changes output or side effects.
7. Local-only mode, permission refresh, OSRM trust, privacy zones, and backup import cannot silently bypass privacy or consent.
8. Android native persistence still reaches DriveSenseActivityRecognition.saveSettings(), NativeSettingsStore.saveSettingsJson(), and EncryptedSharedPreferences.commit().
9. The expected result from docs/COMPLETE_SETTINGS_SYSTEM.md is testable: immediate UI result, durable restart result, behavior result, and security/permission override result are all clear.
10. Tests exist or should be added to prove UI save, import/migration, behavior effect, security override behavior, and Android force-stop persistence.

Return findings first, with file paths and line-level references. For each issue, say whether it is a broken setting, privacy/security risk, persistence risk, missing migration, missing validation, missing behavior consumer, or missing test.
```

## AI Bug-Hunting Playbook

Use this playbook when another AI tool is asked to find problems in the settings system. The goal is to prove cause and effect, not just confirm the UI moved.

### Step 1: Build a setting inventory

Ask the reviewer to extract these lists and compare them:

```text
All keys in DEFAULT_SETTINGS.
All keys mentioned in SETTINGS_ENUMS.
All keys mentioned in IMPORT_NUMBER_RANGES.
All keys mentioned in IMPORT_STRIPPED_KEYS.
All keys written by src/pages/Settings.jsx.
All keys written by src/settings/sections/*.jsx.
All keys listed in src/features/settings/hooks/useSettingsSections.js.
All keys read by behavior consumers in src/lib, src/pages, src/components, and android/app/src/main/java.
All keys included, stripped, or transformed by backup import/export.
```

Expected result:

```text
Every user-facing durable setting has a DEFAULT_SETTINGS entry.
Every constrained key has validation or a documented reason it does not need validation.
Every searchable setting is discoverable.
Every setting written by UI is read by behavior code or documented as display-only.
Every behavior key has a UI or documented non-UI source.
Every dangerous key is stripped or gated during backup import.
```

Bug examples:

```text
UI writes threshold_speeding_kmh but scoring reads threshold_speed_over_kmh.
DEFAULT_SETTINGS has backend_sync_enabled but no consumer ever checks externalServiceAllowed(settings, 'backend_sync').
Search metadata mentions a setting section that no longer renders.
Backup import restores osrm_map_matching_url and consent, redirecting route data.
Android service reads native settings but React never saves the key to NativeSettingsStore.
```

### Step 2: Trace each changed setting end to end

For every changed key, produce a trace:

```text
UI control:
  file and line
  exact patch object

Validation:
  enum/range/special case
  accepted examples
  rejected examples

Persistence:
  localSettings.setAsync/updateAsync path
  revision/timestamp behavior
  encrypted mirror
  native Android save if applicable

Migration/import:
  default version behavior
  old key aliases
  import sanitizer behavior
  stripped/clamped fields

Behavior:
  primary consumer file
  expected output before
  expected output after
  permission/security blockers

Tests:
  existing tests
  missing tests
  manual Android proof if needed
```

Review output template:

```text
Setting: <key>
UI write: <file:line> writes <patch>
Validation: <accepted/rejected behavior>
Persistence: <setAsync/native/hydration result>
Import/migration: <safe restore behavior>
Behavior consumer: <file:line> reads <key>
Expected user result: <immediate + durable + behavior result>
Security modifiers: <permissions/local-only/OSRM/etc>
Proof: <test/manual command>
Finding: PASS or issue category
```

### Step 3: Try contradiction tests

Have the reviewer intentionally look for contradictions:

```text
Can UI show ON while local-only mode forces behavior OFF?
Can a setting survive reload but not Android force-stop?
Can a backup import restore a value the UI would reject?
Can a native Android service read a stale value after React changed it?
Can permission refresh overwrite a user-facing setting and look like a save bug?
Can network security block a network setting and make it look broken?
Can a setting be saved but hidden from search?
Can a scoring setting change without marking trips for re-score or changing version hash?
Can a security setting persist while the underlying Android capability is unavailable?
```

Expected result: contradictions must either be fixed, covered by UI explanation, or documented as intentional security behavior.

### Step 4: Verify import/export safety

Settings import/export is a high-risk area because it crosses trust boundaries.

Required checks:

```text
Imported JSON cannot add unknown keys.
Imported JSON cannot pollute Object.prototype.
Imported JSON cannot restore _settings_revision or _settings_updated_at.
Imported JSON cannot restore OSRM endpoint, consent, health, or trust metadata.
Imported JSON cannot enable background_auto tracking without the app's current permission/onboarding context.
Imported JSON cannot set impossible thresholds that disable scoring or make all trips perfect/broken.
Imported privacy zones cannot expose private center coordinates if export stripped them.
Imported external-data toggles must obey external_requests_local_only.
Imported currency/theme/unit values must be valid enums/options.
```

Attack payload examples for tests:

```json
{
  "__proto__": { "polluted": true },
  "constructor": { "prototype": { "polluted": true } },
  "_settings_revision": 999999,
  "_settings_updated_at": "2999-01-01T00:00:00.000Z",
  "external_requests_local_only": true,
  "map_tiles_enabled": true,
  "speed_limit_lookup_enabled": true,
  "weather_context_enabled": true,
  "map_matching_enabled": true,
  "osrm_map_matching_url": "https://evil.example/osrm",
  "osrm_data_sharing_consented": true,
  "osrm_verified_domain": "evil.example",
  "threshold_harsh_brake_ms2": 0,
  "eco_cruise_score_multiplier": 0,
  "eco_idle_penalty_multiplier": 0,
  "privacy_zones": [
    { "id": "home", "label": "Home", "lat": 43.1, "lng": -79.1, "radius_m": 5000 }
  ]
}
```

Expected safe result:

```text
No prototype pollution.
Revision metadata stripped.
OSRM endpoint/trust/consent stripped.
Local-only dependent toggles forced false.
Dangerous thresholds clamped or defaulted.
Eco scoring not disabled by both multipliers being zero.
Privacy zone center coordinates stripped or sanitized according to the current backup contract.
```

### Step 5: Verify Android force-stop persistence

Use this when a setting is durable and user-visible on Android.

Procedure:

```powershell
npm.cmd run build
cd android
.\gradlew.bat installDebug
cd ..
adb logcat -c
adb shell monkey -p com.roadsage.app 1
```

Then change the setting in the app and inspect logs:

```powershell
adb logcat -d -v time RoadSage:V RoadSageSettings:V EncryptedPreferenceStore:V AndroidRuntime:E chromium:E *:S
```

Expected log evidence:

```text
saveSettings called
NativeSettingsStore.commit() result=true
settings native save confirmed
```

Then force-stop/relaunch:

```powershell
adb shell am force-stop com.roadsage.app
adb shell monkey -p com.roadsage.app 1
```

Expected app evidence:

```text
Settings UI displays the changed value.
DriveSenseActivityRecognition.getSettings().settingsJson contains the changed value.
Native consumers behave according to the changed value.
No fatal AndroidRuntime or chromium errors appear.
```

### Step 6: Verify behavior effect

A persisted setting is not complete until output changes.

Examples:

```text
units = imperial:
  Distance/speed labels use miles/mph in dashboard, trip details, and exports.

dark_mode = dark:
  document.documentElement has class "dark" after launch.

threshold_harsh_brake_ms2 increases:
  the same trip has fewer harsh-brake events or changed score provenance.

phone_use_affects_score = false:
  phone-use evidence may display, but focus/overall score penalty is removed.

external_requests_local_only = true:
  OSM, Open-Meteo, OSRM, map tiles, Nominatim, calibration upload, and backend sync all return disabled/local-only behavior.

map_matching_enabled = true without verified OSRM:
  route snapping still does not run and UI says verification/consent is required.

biometric_lock_enabled = true:
  app lock actually invokes Android credential gate when timeout/backgrounding rules require it.
```

### Step 7: Classify the bug precisely

Use the issue categories below. Do not write vague findings such as "settings may not work."

## AI Reviewer Issue Categories

Use these labels:

```text
BROKEN_SETTING: UI writes one key, behavior reads another.
NO_DEFAULT: key is not in DEFAULT_SETTINGS.
NO_VALIDATION: unsafe value can be saved.
NO_MIGRATION: older users lose or receive wrong values.
UNSAFE_IMPORT: backup import can enable unsafe behavior or redirect data.
NO_BEHAVIOR_EFFECT: setting persists but nothing reads it.
PERMISSION_CONFUSION: setting is overwritten by real OS permission state but UI implies preference control.
LOCAL_ONLY_BYPASS: external requests can still run under local-only mode.
ANDROID_PERSISTENCE_RISK: save does not reach native commit or hydration can choose stale data.
EXPECTED_RESULT_GAP: expected immediate, durable, behavior, or security result is unclear or untested.
NO_TEST: no test proves the intended change.
```

## Known High-Risk Areas

Treat these as mandatory review areas:

```text
OSRM endpoint, consent, health, and trust fields.
Local-only mode and all external request toggles.
Backup import/export and privacy-zone masking.
Android encrypted preference recovery.
Permission markers versus real Android permission state.
Background auto tracking because it requires foreground location, background location, activity recognition, notifications, and battery behavior.
Scoring thresholds because they affect trip score provenance and re-score requirements.
Phone-use settings because Usage Access evidence and GPS proxy diagnostics must not be conflated.
Biometric/app lock because Android credential availability affects UI and persistence.
Stealth Trip Mode because it is runtime state, not ordinary durable settings.
```

## Required Proof Matrix

| Change type | Minimum proof |
| --- | --- |
| New setting key | `DEFAULT_SETTINGS`, validation/import/migration tests, one behavior test |
| UI-only rearrangement | render/search tests plus manual or Playwright/Android smoke if route changes |
| Android settings persistence | `tests/android-uiautomator-settings-full.mjs` or equivalent force-stop/relaunch proof |
| Native Android service behavior | Native consumer inspection plus an Android test or logcat proof that `NativeSettingsStore.getSettingsJson(...)` sees the changed value |
| Privacy/external request setting | local-only test, import strip/clamp test, behavior consumer test |
| Scoring threshold | unit test showing changed threshold changes scoring/detection or score provenance |
| Notification setting | notificationService test showing schedule/send gate changes |
| Voice setting | voice alert queue/profile gate test showing alert behavior changes |
| Backup/import setting | import security test showing safe restore and unsafe strip |
| Permission setting | permission-state-machine or permission monitor test showing OS state wins correctly |

## Final Acceptance Gate

A settings change is accepted only when the reviewer can say:

```text
The UI writes the intended key.
The key is durable.
The key is safe to import or intentionally stripped.
The behavior consumer reads the key.
The behavior output changes when the key changes.
The Android native settings snapshot survives force-stop/relaunch when the setting is durable.
The tests prove all of the above or the remaining manual test is explicitly documented.
```
