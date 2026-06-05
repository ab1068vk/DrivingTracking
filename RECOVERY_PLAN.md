# Road Sage Safe Recovery Plan

Baseline: commit `75ddc9c` from May 30, 2026.

## Non-negotiable compatibility contract

- Android `applicationId`, namespace, and Java package remain `com.drivesense.app`.
- The visible product name may remain Road Sage.
- Web settings and the Android Quick Settings tile share `drivesense_settings`.
- Existing settings, trips, vehicles, permissions, and tile state must survive an APK upgrade.
- Backup format changes require explicit migrations and fixtures for every supported version.
- Storage, permissions, package identity, and backup format are never changed in the same feature commit.

Run `npm run recovery:guard` before builds, tests, commits, and Android installs.

## Safe to add first

These changes stay away from Android identity, permissions, and persisted-data schemas:

1. Legal and explanatory text.
2. Visual polish, loading states, accessibility labels, and navigation improvements.
3. Read-only diagnostics and score explanations.
4. CSV/PDF presentation fixes that do not change stored trip fields.
5. Voice message wording and queue behavior after focused tests are ported.
6. Additional unit, browser, and Android upgrade tests.
7. Removal of dependencies proven unused by the May 30 code.

Each feature should be a separate commit and must pass the recovery guard, build, focused tests, and an upgrade install over the previous APK.

## Requires a compatibility design first

Do not cherry-pick these areas directly from the abandoned June branch:

- Android package or Java package renames.
- Settings key renames or a new settings storage backend.
- Encrypted preferences or trip-field encryption.
- Backup encryption, integrity sealing, or backup version changes.
- Permission state-machine rewrites.
- Quick Settings tile or foreground-service rewrites.
- Parked-car widgets, boot receivers, or WorkManager jobs.
- Database/schema migrations and calibration pipeline migrations.
- Large Settings page rewrites.

These features need a small design, migration fixtures, rollback behavior, and device upgrade tests before implementation.

## Delivery stages

### Stage 0: Protect the baseline

- Add and run the recovery compatibility guard.
- Record a known-good APK and backup fixture.
- Verify settings survive app restart and APK upgrade.
- Verify the Quick Settings tile and backup import on a physical device.

### Stage 1: Low-risk improvements

- Add legal copy and read-only UI improvements.
- Port dependency cleanup one dependency at a time.
- Port voice/UI improvements in isolated commits with tests.

### Stage 2: Persistence hardening

- Define one settings owner while preserving `drivesense_settings`.
- Add settings restart and upgrade tests.
- Add backup v1-v6 fixtures and round-trip import tests.

### Stage 3: Android behavior

- Improve permission guidance without changing permission ownership.
- Improve the Quick Settings setup flow while retaining the package and settings key.
- Add widget or boot behavior only after upgrade and reboot tests pass.

### Release gate

Do not merge to `main` until all of these pass:

- Existing APK upgraded in place without uninstalling.
- Existing settings and trips remain visible.
- Settings persist after force-stop and restart.
- Backup export and import round-trip succeeds.
- Quick Settings tile reads the same state as Settings.
- Permission denial, grant, and return-from-settings flows work.
- `npm run recovery:guard`, production build, focused tests, and Android install pass.
