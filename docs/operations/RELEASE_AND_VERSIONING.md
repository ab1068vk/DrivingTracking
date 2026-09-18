# Release and Versioning

This is the maintained release procedure. One-time historical verification records are kept
separately under [../historical/](../historical/) and are not release documentation.

## Identity that must not change

| Item | Value |
|---|---|
| Android `applicationId` / `namespace` / Java package | `com.drivesense.app` |
| Capacitor `appId` | `com.drivesense.app` |
| Visible app name | Road Sage |
| Shared settings key | `drivesense_settings` |

`npm run recovery:guard` enforces the package identity and version-code invariants and runs as
part of `prebuild` and `pretest`. A change here breaks in-place upgrades for installed users.

## Current version

| Field | Value | Source |
|---|---|---|
| Android `versionCode` | `3` | `android/app/build.gradle` |
| Android `versionName` | `1.1.0` | `android/app/build.gradle` |
| npm `version` | `1.0.0` | `package.json` |

`versionCode` must increase monotonically. Do not bump a version as part of unrelated work.

### Which version is the product version

`android/app/build.gradle` is the **only** source of the Road Sage application version. The
`version` field in `package.json` is npm package metadata: nothing in `src/`, the Vite build or
the Gradle build reads it, and it is deliberately not kept in step with the Android version.

The two numbers differing is therefore not a mismatch to reconcile. What matters is that no
product surface presents package or fallback metadata as the installed application version —
Settings and Diagnostics both derive their version from the native build, and
`src/lib/__tests__/appVersionIdentity.test.js` pins that.

### Identifying an installed build

| Purpose | Value | Where |
|---|---|---|
| Human-readable installed identity | `Version 1.1.0 (3)` | Settings → About; Android app info |
| Immutable packaged-build identity | `sha256-packaged-inputs-v1:<64 hex>` | Diagnostics `artifact_id` |
| Web bundle identity | separate bundle hash | Diagnostics `web_bundle_hash` |

These are distinct identities and are never collapsed into one value.

## Build identity

Each packaged build derives a deterministic complete build identity from its packaged inputs,
combined with build type, flavour and version code. The build fails if the identity cannot be
generated in the expected form. This identity is what Diagnostics reports; see
[../architecture/DIAGNOSTICS.md](../architecture/DIAGNOSTICS.md).

## Release build

```bash
npm run build          # prebuild runs recovery:guard and regenerates the scoring version
npm run android:sync   # build, sync Capacitor, reapply the Gradle patch
```

Then build the release artifact from `android/` with Gradle.

`android/local.properties` is machine-generated and must stay untracked;
`npm run check:repo-hygiene` and CI enforce this.

## Optional Physical H variants

Device-qualification harness variants are opt-in and inert by default. They are enabled only
with `-PphysicalHVariants=true`, which adds the `physicalH` and `physicalHLegacy` product
flavours under a separate application id suffix. Production and debug builds keep their normal
task names and package identity. A retained JVM test asserts the production build exposes no
Physical H build configuration fields.

## In-place upgrade verification

Before shipping a build that changes storage, settings, backup format or package metadata,
verify an in-place upgrade on a physical device:

1. Install the previous released build and create representative data: trips, vehicles, saved
   road speeds, settings and permission grants.
2. Install the new build over it without uninstalling.
3. Confirm settings, trips, vehicles, permissions and quick-settings tile state survive.
4. Confirm the app launches to a usable state and the archive reports a healthy recovery state.
5. Record the result, including device model, both version codes and the data set used.

This procedure is required because upgrade behaviour cannot be proven by the JVM and JavaScript
suites alone.

## Certificate pins

TLS certificate pin renewal is a recurring operational task with its own cadence and window
check; see [../security/CERTIFICATE_PIN_RENEWAL.md](../security/CERTIFICATE_PIN_RENEWAL.md).
