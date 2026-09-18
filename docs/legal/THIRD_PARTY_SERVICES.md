# Third-Party Services and Dependencies

Factual inventory of external services the current application can contact, and the state of
third-party software attribution.

> **Status: repository fact, not a legal conclusion.** Licensing and disclosure obligations
> require review by a qualified person. Items marked *legal review required* are not decided here.

## Services contacted at runtime

| Service | Host(s) | Purpose | Triggered by | Optional |
|---|---|---|---|---|
| OpenStreetMap Overpass | `overpass-api.de`, `overpass.kumi.systems` | Road data for speed limits and road context | **Get Road Data**, or automatic external context once consented | Yes — off by default |
| OSRM route matching | An endpoint the user explicitly approves | Matching sampled route segments to roads | **Get Road Data**, with its own separate consent | Yes — off by default |
| Open-Meteo | `api.open-meteo.com`, `archive-api.open-meteo.com` | Weather context for a trip | **Get Weather**, or automatic external context once consented | Yes — off by default |

Notes:

- **Get Road Data and Get Weather are distinct actions.** Get Road Data never requests weather.
- OSRM consent is tracked separately (`osrm_data_sharing_consented`, with a timestamp) and can be
  **invalidated** with a recorded reason — for example the maximum-privacy default or a
  privacy-zone change.
- The public OSRM demo host `router.project-osrm.org` is **explicitly rejected**; a user must
  supply an endpoint they approve.
- Weather and Overpass connections use certificate pinning. Pin renewal is an operational task;
  see [../security/CERTIFICATE_PIN_RENEWAL.md](../security/CERTIFICATE_PIN_RENEWAL.md).
- Requests pass through a privacy-gated fetch layer that can refuse a request and record the
  reason instead of sending it. `heightened_privacy_mode` and request obfuscation are on by
  default.
- Saved and reviewed road speeds reduce repeated Overpass lookups for roads already maintained
  locally.

## Data categories sent

| Service | Category sent |
|---|---|
| Overpass | Privacy-filtered public road boxes covering part of a route |
| OSRM | Sampled public GPS route segments |
| Open-Meteo | One rounded route point taken outside privacy-zone guards, plus the trip date |

No trip identifiers, user identifiers, account data, scores or notes are sent to these services.
No camera image or recognised sign text is ever sent to a third party; speed-sign scanning is
entirely on-device.

## Reference data bundled in the application

The vehicle reference catalogue cites public sources (for example national vehicle and transport
agency datasets and manufacturer specifications) with a recorded review date. These are
**citations for bundled reference data**, not runtime service calls — the application does not
contact those sites during use.

*Legal review required:* whether the bundled reference data requires attribution or carries usage
restrictions.

## Platform and library dependencies

The application uses React, Vite, Tailwind CSS, Capacitor, Leaflet-based mapping, Android
Jetpack/AndroidX libraries, Google Play services for location and activity recognition, ML Kit
text recognition, Robolectric and JUnit for testing, and a memory-hard key-derivation library for
portable backup encryption. The authoritative list is `package.json`, `package-lock.json`,
`android/app/build.gradle` and the Gradle version catalogue.

## Attribution status

| Item | Status |
|---|---|
| Repository LICENSE file | **Absent** — see [LEGAL_DECISIONS_REQUIRED.md](LEGAL_DECISIONS_REQUIRED.md) |
| Third-party licence notice file | **Absent** |
| OpenStreetMap attribution | *Legal review required* — ODbL attribution obligations typically apply to applications displaying or deriving from OSM data |
| Map tile attribution | *Legal review required* — depends on the tile provider actually configured at distribution |
| Bundled dependency notices | *Legal review required* — no aggregated notice file is generated today |

These are recorded as open items rather than resolved, because the correct answer depends on the
distribution model and jurisdiction, neither of which is established in this repository.

## What this document does not do

It does not reproduce or summarise third-party terms, does not grant rights, and does not conclude
that current usage is compliant. It records what the application does so a qualified reviewer can
make those determinations.
