# Road Sage Changes: Before And After Examples

This document summarizes the recent security, privacy, backup, trip-readiness, and voice-alert changes with real-world examples. It is written for review: what could happen before, what happens now, and which files enforce the behavior.

## Android Backup Lockdown

| Before | After |
| --- | --- |
| Android could include app data in system backup/export paths by default. Sensitive local data such as trip state, parked locations, privacy zones, WebView storage, and widget cache data could be copied during device backup or transfer. | App backup is disabled, and explicit backup/data-extraction rules exclude sensitive shared preferences, databases, and files. |

Real-world example:

A phone is plugged into a shared computer for debugging. Before this change, Android backup paths could expose Road Sage local data. Now the manifest disables app backup and the XML rules explicitly exclude sensitive storage from cloud backup and device transfer.

Key files:

- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/res/xml/backup_rules.xml`
- `android/app/src/main/res/xml/data_extraction_rules.xml`

## Network Security Configuration

| Before | After |
| --- | --- |
| The app relied on Android defaults for TLS trust and cleartext behavior. | The app uses `network_security_config.xml`, blocks cleartext by default, and defines the external domains Road Sage intentionally contacts. |

Real-world example:

On a network with an unexpected proxy or old device behavior, cleartext or overly broad trust assumptions can create avoidable exposure. Now Road Sage declares HTTPS-only defaults and avoids user-installed CA trust in release configuration.

Key files:

- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/res/xml/network_security_config.xml`

## Capacitor WebView CSP Headers

| Before | After |
| --- | --- |
| CSP was available as a Vite/meta policy, but header-only directives such as `frame-ancestors` are not enforced from a meta tag. | `MainActivity` injects CSP and security headers into Capacitor WebView local responses. |

Real-world example:

If a page is rendered inside a hostile frame, a meta CSP cannot reliably enforce `frame-ancestors`. Now the WebView receives a real CSP header, plus `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`.

Key file:

- `android/app/src/main/java/com/roadsage/app/MainActivity.java`

## Release Log Stripping

| Before | After |
| --- | --- |
| Release builds could retain `android.util.Log` calls and strings. | R8 strips `Log.d`, `Log.i`, `Log.w`, `Log.e`, `Log.v`, and `Log.wtf` calls from release builds. |

Real-world example:

If a diagnostic log ever included route timing, location hints, or phone-use state, it could appear in system logs on some devices. Now release builds remove those log calls during minification.

Key files:

- `android/app/proguard-rules.pro`
- `android/app/build.gradle`

## FLAG_SECURE

| Before | After |
| --- | --- |
| Android could capture Road Sage screens for the task switcher or screen recording. | `FLAG_SECURE` is set before `super.onCreate`, blocking recent-app screenshots and ordinary screen capture paths. |

Real-world example:

A user switches apps while viewing a live route map or privacy-zone map. Before, Android could store a thumbnail of that screen. Now the system is told not to capture Road Sage content.

Key file:

- `android/app/src/main/java/com/roadsage/app/MainActivity.java`

## PendingIntent Immutability

| Before | After |
| --- | --- |
| Some `PendingIntent` calls did not consistently centralize `FLAG_IMMUTABLE` or `FLAG_MUTABLE`. | `PendingIntentCompat` centralizes immutable flags for app-owned intents, with mutable flags only where an external API must fill intent data. |

Real-world example:

Android 12+ requires explicit mutability. A malicious app should not be able to alter app-owned PendingIntent contents. Road Sage now marks app-owned activity, service, and broadcast intents immutable.

Key files:

- `android/app/src/main/java/com/roadsage/app/PendingIntentCompat.java`
- `android/app/src/main/java/com/roadsage/app/DriveSenseActivityRecognitionPlugin.java`
- `android/app/src/main/java/com/roadsage/app/ParkedCarWidgetProvider.java`
- `android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java`

## Plaintext SharedPreferences Removal For Android Native Data

| Before | After |
| --- | --- |
| Some Java paths still opened plaintext SharedPreferences for legacy parked-location, privacy-zone, tracking, notification, or settings data. | Android production Java no longer opens plaintext SharedPreferences for those native datasets. Legacy native plaintext preference files are cleanup-only targets and are deleted by name without reading. |

Real-world example:

An old install has a parked location stored in a legacy plaintext preference. Before, native code could read and reconcile that value. Now Road Sage chooses the stricter privacy posture: it does not read legacy plaintext native data and instead uses encrypted native storage going forward.

Key files:

- `android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java`
- `android/app/src/main/java/com/roadsage/app/NativeSettingsStore.java`
- `android/app/src/main/java/com/roadsage/app/DriveSenseNativeTripStore.java`
- `android/app/src/main/java/com/roadsage/app/ParkedLocationPreferenceSource.java`
- `android/app/src/main/java/com/roadsage/app/ParkedLocationPreferenceReconciler.java`
- `android/app/src/main/java/com/roadsage/app/ParkingLocationClearer.java`
- `android/app/src/main/java/com/roadsage/app/PrivacyZoneStore.java`
- `android/app/src/main/java/com/roadsage/app/MapTileFetchWorker.java`
- `android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java`
- `src/lib/trackingStore.js`

## Weather Privacy Gate

| Before | After |
| --- | --- |
| Open-Meteo was skipped when all weather candidate points were private. A route that started in a privacy zone but had a public midpoint could still fetch weather. | Open-Meteo is skipped if all candidates are private or if the route origin, midpoint, or destination is inside the expanded weather privacy guard. |

Real-world example:

A trip starts at home, exits the privacy zone, and continues across town. Before, Road Sage could send a nearby public route coordinate and date to Open-Meteo. Now the origin is checked with a larger buffer, so the weather request is skipped instead of revealing a coordinate near the private place.

Key files:

- `src/lib/weatherContext.js`
- `src/lib/__tests__/externalContracts.test.js`
- `src/lib/openSourceTripContext.js`

## R8 Obfuscation And Shrinking

| Before | After |
| --- | --- |
| The release build settings were not fully documented, and ProGuard keep rules for bridge/runtime safety were not explicit. | Release builds use `minifyEnabled true`, `shrinkResources true`, R8 obfuscation, log stripping, and explicit keep rules for Capacitor reflection and native JSON model members. |

Real-world example:

Someone decompiles a release APK. Before, readable class and method names could make it easier to identify sensitive internals. Now R8 runs on release builds, shrinking and obfuscating internals while keeping the bridge pieces needed for runtime behavior.

Key files:

- `android/app/build.gradle`
- `android/app/proguard-rules.pro`

## Backup Encryption UI And Import Warnings

| Before | After |
| --- | --- |
| Backup encryption existed, but the UI copy and flow were less explicit about password confirmation, strength, wrong-password errors, corrupted encrypted backups, and legacy unencrypted JSON imports. | Export Backup now has password and confirm-password fields, a strength meter, a clear no-password warning, exact wrong-password copy, corrupted `.rsbackup` copy, and an unencrypted warning before importing legacy `.json` backups. |

Real-world example:

A user exports a full driving-history backup. Before, they could be less clear about whether the file was encrypted or what password error occurred. Now the dialog defaults toward encrypted `.rsbackup`, explains the no-password risk, and gives clearer import errors.

Key file:

- `src/pages/Settings.jsx`

## Trip Readiness Documentation

| Before | After |
| --- | --- |
| The trip readiness doc explained architecture and behavior, but it did not show the most important code paths. | `TRIP_READINESS.md` now includes code snippets for signal assembly, evidence gates, score conversion, weight redistribution, fatigue recovery, and manual-start fatigue warnings. |

Real-world example:

A reviewer wants to understand why a readiness number is hidden. Before, they had to jump from prose into source. Now the doc shows the exact gate: missing `timeOfDay` or `recentTrend`, or too many fallback signals, blocks the readiness score.

Key file:

- `docs/TRIP_READINESS.md`

## Voice Alerts Documentation

| Before | After |
| --- | --- |
| The voice alerts doc explained triggers and settings, but it did not include concrete implementation snippets. | `VOICE_ALERTS.md` now includes code snippets for shared speech routing, cooldowns, live-coach dispatch, alert priority, Android TTS bridge, and native background phone-use warnings. |

Real-world example:

A reviewer wants to know whether Road Sage sends voice text to a cloud service. The doc now shows the actual path: Android `TextToSpeech` first on native, browser Web Speech fallback, and no microphone or cloud TTS provider in the Road Sage path.

Key file:

- `docs/VOICE_ALERTS.md`

## Practical End-To-End Example

Scenario:

A driver starts at home, where they have a privacy zone. They begin a trip, receive a phone-use warning from Android Usage Access, later export a backup, and then switch apps while the live map is visible.

Before these changes:

- A weather request could still be sent if the selected weather point was outside the privacy zone.
- A task-switcher screenshot could capture the live map.
- Some legacy native plaintext preferences could still be opened for reconciliation.
- A backup/export flow could be less obvious about encryption and wrong-password states.
- Release APK internals were less explicitly protected by documented R8 keep and obfuscation rules.

After these changes:

- Weather is skipped because the origin is inside the expanded weather privacy guard.
- `FLAG_SECURE` blocks task-switcher screenshots and common screen capture.
- Native Android data uses encrypted storage, and legacy plaintext native files are cleanup-only.
- Voice alerts stay on device and respect `voice_alerts_enabled`.
- Backup export defaults toward password-protected `.rsbackup` with confirmation and strength feedback.
- Release builds run R8 minify, shrink, obfuscation, and log stripping while preserving required Capacitor bridge entry points.
