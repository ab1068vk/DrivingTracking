# Android In-place Upgrade Verification

Date: June 5, 2026

Branch tested: `codex/recovery-safe-base`

Installed package: `com.drivesense.app`

Visible app name: Road Sage

## Test setup

- Physical Samsung Android device connected over ADB.
- May 30 baseline app already installed.
- Pre-password Road Sage backup already imported by the user.
- Recovery APK installed with Gradle `installDebug`.
- The app was not uninstalled and app data was not cleared.

## Baseline

- Version code: 1
- Version name: 1.0
- Settings key: `drivesense_settings`
- Settings fingerprint: `17033da57518f84a166c1c44b48e10a1a20a9cc4dafa59e786f8b4d7fd6e72ba`
- IndexedDB footprint: 9,658 KB across 10 files
- Vehicles present: 1
- Privacy zones present: 1
- Onboarding complete: yes
- Tracking mode: `background_auto`
- Tracking paused: yes
- Fine location: granted
- Background location: granted
- Activity recognition: granted
- Notifications: granted

## Result

The recovery build installed successfully over the existing app.

- Android first-install time remained unchanged.
- Android last-update time changed, confirming an in-place package update.
- Settings fingerprint remained byte-for-byte identical before and after installation and launch.
- IndexedDB footprint remained 9,658 KB across 10 files before first launch.
- Existing vehicle and privacy-zone counts remained unchanged.
- Existing permissions remained granted.
- The app opened directly to Dashboard without showing onboarding.
- Imported trips rendered in Trip History after the upgrade.
- The Android Quick Settings tile remained installed.
- The tile displayed `Auto off`, matching the persisted paused tracking state.
- No tracking state was changed during verification.

## Release limitation

This verified a same-version debug replacement using version code 1. A distributable upgrade must increment the version code while keeping:

- Android package identity `com.drivesense.app`
- Settings key `drivesense_settings`
- Existing database names and backup compatibility

The version-code increment must be tested with this same in-place procedure before merging to `main`.
