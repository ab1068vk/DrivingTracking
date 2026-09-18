# Data Handling Notice

Plain-language description of what Road Sage stores, why, and what leaves the device. This is a
factual description of current behaviour, not a legal document. For the formal draft see
[PRIVACY_POLICY_DRAFT.md](PRIVACY_POLICY_DRAFT.md).

## The short version

Your driving data stays on your device. There is no Road Sage server that receives your trips.
A small number of optional features contact third-party services for context, and those are
described below.

## What is stored on the device

| Data | Why |
|---|---|
| Trips: times, distance, duration, how the trip started | The core record |
| Route points (precise GPS coordinates) | Map display, replay, speed and event analysis |
| Driving events | Scoring and review |
| Scores, confidence and provenance | Trip review and trends |
| Derived analytics, coaching and progression state | Insights, coaching, achievements |
| Road-speed knowledge | Speed-limit resolution and learning |
| Vehicle profiles and trip attribution | Segmenting your data by vehicle |
| Parking locations and optional photos | Finding your parked vehicle |
| Phone-usage windows (if enabled) | Distraction evidence |
| Settings and privacy preferences | Your configuration |
| System logs and diagnostics history | Troubleshooting |

Trip payloads are encrypted at rest on the device.

## What leaves the device

Nothing automatically, for trip data.

These **optional** features contact third parties when enabled and network is available:

Two distinct user actions send different data to different services. They are not the same
request, and one does not trigger the other:

| Action | Service contacted | What is sent |
|---|---|---|
| **Get Road Data** | OpenStreetMap Overpass (`overpass-api.de`, `overpass.kumi.systems`), and an OSRM endpoint you explicitly approve | Privacy-filtered public road boxes to Overpass; sampled public GPS segments to OSRM. **It never requests weather.** |
| **Get Weather** | Open-Meteo (`api.open-meteo.com`, `archive-api.open-meteo.com`) | One rounded route point taken outside privacy-zone guards, plus the trip date |

Both are **off by default**. `weather_context_enabled` and `external_context_auto_fetch_enabled`
each default to `false`, and enabling automatic fetching records a separate consent timestamp.
Once enabled, automatic external context can run the enabled speed and weather lookups
independently.

OSRM has its own consent state (`osrm_data_sharing_consented`) recorded with a timestamp, and that
consent can be **invalidated** — for example by switching to the maximum-privacy default or by a
privacy-zone change — with the reason recorded. The public demo endpoint is rejected outright.

Saved and reviewed road speeds reduce repeated Overpass lookups for roads you already maintain
locally, so confirming a limit reduces future external requests.

Requests are limited by the privacy-gated fetch layer and can be refused — for example when all
route points fall inside a privacy zone, or when the bounding box would be too large. The refusal
reason is recorded and the application continues without enrichment. `heightened_privacy_mode` and
request obfuscation are on by default.

Connections to the weather and Overpass endpoints use certificate pinning. Third-party services
have their own availability, logging, retention, security and policy practices.

## Camera and speed-sign scanning

Scanning is user-initiated and must be started while parked. Full camera frames are discarded and
recognised text is not retained.

One tightly cropped sign image may be kept temporarily so you can confirm the reading after
parking. It is encrypted, stored in Android no-backup storage, capped in size, deleted after you
confirm, adjust or reject the reading, and unavailable after 24 hours. It is **not** included in
exports or backups, and never reaches a third party. A camera prompt does not affect scoring or
voice alerts unless you personally confirm the posted sign.

## Using Road Sage with other people

Road Sage records the device it runs on and cannot identify who was driving.

Do not use Road Sage to track, score, evaluate, supervise, discipline, insure, employ, price or
monitor another person — including an employee, contractor, family member, minor, shared device or
vehicle — without every consent, disclosure, permission and legal basis required where you are.
Surveillance, recording, employment and privacy laws vary by place and change over time.

This is a statement of the product's intended use and the user's responsibility, not legal advice.

## What you export deliberately

You control these; nothing happens automatically:

- **Backups** — versioned and encrypted, optionally passphrase-protected. Private coordinates are
  never restored from a backup.
- **Reports and data exports** — generated on request.
- **Diagnostics reports** — deliberately exclude coordinates, route geometry, trip identifiers,
  trip dates, notes, settings values, raw error text and stack traces, and contain no stable user
  or device identifier.

Once you share an exported file, its contents are outside the application's control.

## Privacy controls

| Control | Effect |
|---|---|
| Privacy zones | Masks routes and events near places you designate |
| Private-trip mode | Records the trip as summary-only; route evidence is withheld |
| Retention settings | Expires route evidence after a period you choose |
| Data-rights erasure | Removes records **and** derived residue, not just the visible list |
| Optional app lock | Biometric gate on opening the app |

## Retention

Route evidence expires according to your retention settings; expired evidence is reported as
expired rather than as never having existed. Parking photos expire on a schedule. Learned
road-speed knowledge has its own retention default. Trips you delete are removed along with their
derived data.

## Identifiers

Road Sage does not maintain a stable user account or device identifier for analytics. Diagnostics
uses a per-launch session identifier and a per-process identifier that are regenerated each time,
plus a build identifier that identifies the *build* and is identical for everyone running it.

## Permissions and what they are for

| Permission | Used for |
|---|---|
| Location / background location | Trip capture |
| Activity recognition | Automatic trip detection |
| Notifications | Required capture notification; alerts |
| Camera | Speed-sign scanning; parking photos |
| Usage access | Phone-usage evidence (optional) |
| Bluetooth | Vehicle connection signals (optional) |
| Biometric | Optional app lock |

Declining a permission disables the dependent feature; it does not silently degrade into
guessing.

## Things this notice does not do

It does not constitute legal terms, and it does not describe the practices of the third-party
services listed above — those are governed by their own policies. See
[THIRD_PARTY_SERVICES.md](THIRD_PARTY_SERVICES.md).
