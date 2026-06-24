# Android Version Code 2 Verification

Status: passed physical-device verification on June 5, 2026.

Current status as of 2026-06-24: this remains the latest recorded physical-device version-code verification in the repo. The current Android Gradle config still declares `versionCode = 2`, `versionName = "1.0"`, and package identity `com.drivesense.app`.

This change only increments Android `versionCode` from 1 to 2. It does not change:

- package identity `com.drivesense.app`
- visible app name Road Sage
- version name `1.0`
- settings key `drivesense_settings`
- backup version
- database names
- permissions or runtime behavior

## Baseline

- Installed version code: 1
- First-install time: June 5, 2026 at 15:58:19
- Settings fingerprint: `17033da57518f84a166c1c44b48e10a1a20a9cc4dafa59e786f8b4d7fd6e72ba`
- IndexedDB footprint before install: 12,170 KB across 11 files
- Vehicles present: 1
- Privacy zones present: 1
- Onboarding complete: yes
- Tracking mode: `background_auto`
- Tracking paused: yes
- Fine location, background location, activity recognition, and notifications: granted

## Result

Gradle `installDebug` installed version code 2 over version code 1 without uninstalling or clearing data.

- Installed version code became 2.
- Version name remained `1.0`.
- First-install time remained unchanged.
- Last-update time changed, confirming an in-place Android update.
- Settings fingerprint remained byte-for-byte identical before installation, before first launch, and after launch.
- IndexedDB footprint was exactly preserved before first launch.
- Existing vehicle and privacy-zone counts remained unchanged.
- Existing permissions remained granted.
- Road Sage launched directly to Dashboard without onboarding.
- Dashboard rendered imported historical driving context.
- The Android Quick Settings tile remained installed.
- The tile displayed `Auto off`, matching the persisted paused tracking state.
- No tracking state was changed during verification.

Version code 2 is safe as the recovery branch's next Android upgrade baseline.
