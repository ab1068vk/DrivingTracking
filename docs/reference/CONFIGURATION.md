# Configuration and Environment

All web configuration is Vite build-time environment (`import.meta.env`). Values are baked into
the bundle at build time; there is no runtime configuration file.

## Application configuration

| Variable | Purpose | Values / default | Notes |
|---|---|---|---|
| `VITE_API_URL` | Base URL for the optional non-trip backend | unset by default | `src/api/client.js` **throws** when unset rather than defaulting to localhost. Trips never use it. |
| `VITE_APP_VERSION` | Displayed application version | falls back to `1.0.0` | On Android, Diagnostics prefers the native `versionName`. See [../operations/RELEASE_AND_VERSIONING.md](../operations/RELEASE_AND_VERSIONING.md). |
| `VITE_DB_NAME` | IndexedDB database name | product default | Changing it orphans existing local data. |
| `VITE_P35_NATIVE_AUTHORITY` | Selects the native archive as trip authority | `false` by default | The shipping configuration uses browser authority. |
| `VITE_COMPLETE_BUILD_SOURCE_ID` | Complete packaged-build identity | injected by the Android Gradle build | Not set for plain web builds; Diagnostics then reports `web_bundle_only`. |

## Map and routing

| Variable | Purpose | Notes |
|---|---|---|
| `VITE_DEFAULT_MAP_LAT` | Default map latitude | Initial view only |
| `VITE_DEFAULT_MAP_LNG` | Default map longitude | Initial view only |
| `VITE_DEFAULT_OSRM_URL` | OSRM route-snapping endpoint | Must be a trusted, user-configured endpoint. The public demo host `router.project-osrm.org` is **rejected** by `src/lib/osrmPrivacy.js`. Snapping also requires explicit consent. |
| `VITE_OSRM_TIMEOUT_MS` | OSRM request timeout | Bounds the request |

## Debug and triage controls — internal only

These exist for development and performance triage. They are **not** product features and should
not be enabled in a distributed build.

| Variable | Purpose |
|---|---|
| `VITE_SHOW_DEBUG_ROUTES` | Exposes the debug-only Android reference route |
| `VITE_PERF_TRIAGE_LOGS` | Emits performance-triage logging |
| `VITE_TRIAGE_DISABLE_MAPS` | Disables map components to isolate map cost |
| `VITE_TRIAGE_DASHBOARD_LIMITED_SUMMARIES` | Limits dashboard summary work |
| `VITE_TRIAGE_P0_ARM` | Arms the P0 probe instrumentation (`src/lib/p0Probe.js`) |

Triage flags change what the application does. Do not use them to produce product or performance
claims.

## Android / Gradle properties

| Property | Purpose |
|---|---|
| `physicalHVariants` | Opt-in flag enabling the Physical H qualification product flavours. Off by default; production and debug builds keep their normal task names and package identity. |
| `physicalHApprovedAndroidIds` | Restricts the qualification harness to an approved device identity. Validated as exactly one lowercase 16-hex value, or empty. |

`android/local.properties` is machine-generated and must remain untracked; `npm run
check:repo-hygiene` enforces this.

## Build identity inputs

The complete build identity hashes packaged inputs (`src`, `public`, project configuration,
`android/app/src`, the Gradle files) plus a variant family. Generated Android assets are excluded
so the identity does not fingerprint its own output. The Gradle build fails if the identity is
malformed.

## Guards that read configuration

| Command | Enforces |
|---|---|
| `npm run recovery:guard` | Package identity and version-code invariants |
| `npm run scoring:version:check` | Generated scoring version matches constants |
| `npm run check:repo-hygiene` | Machine-local Android files stay untracked |
| `npm run check:cert-pins` | TLS pin renewal window |
| `npm run legal:version:check` | Legal disclosure content matches its version metadata |

## Security relevance

`VITE_API_URL`, `VITE_DEFAULT_OSRM_URL` and the triage flags are the security-relevant entries.
The first two determine whether the application talks to an external service at all; the triage
flags can expose internal instrumentation. Treat all three as deployment decisions.
