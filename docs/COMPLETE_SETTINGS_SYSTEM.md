# Complete Settings System Contract

Last reviewed: 2026-06-04

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
node --experimental-vm-modules scripts/settingsFullTest.mjs
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

Last local audit command:

```powershell
node --experimental-vm-modules scripts/settingsFullTest.mjs
```

Result on 2026-06-04:

```text
243 passed
10 failed
4 skipped
```

Known failures to investigate before claiming the whole settings system is fully verified:

```text
migrateDefaultSettings(null) throws instead of falling back.
migrateDefaultSettings can transfer dangerous unknown keys such as __proto__.
Biometric timeout calculation can become NaN for a malformed setting.
Currency import/normalization currently rejects or fails euro/yen cases expected by the audit.
Backup encryption test passwords no longer satisfy the current stronger password policy.
sanitize/import security audit reports constructor surviving.
privacyZoneFormatting.zoneKey(null) throws.
Some imports fail because TypeScript/JS modules are not consumable by the settings audit script: calibrationBaseline, useSettingsVersion, and localTripRepository.
```

Known skips:

```text
enforceDataRetention checks skip because localTripRepository import fails in this script.
buildDrivingThresholds checks skip because the requested module export is unavailable.
settings version lifecycle checks skip because useSettingsVersion import fails.
```

Reviewer instruction: treat these as open issues in the current code or audit harness. They do not invalidate this documentation update, but they do mean the settings system should not be called fully proven until these failures are fixed or intentionally reclassified with tests.

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
