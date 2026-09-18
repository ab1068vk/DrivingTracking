# Privacy Policy — DRAFT

> **Status: DRAFT — NOT LEGAL ADVICE — REQUIRES JURISDICTION-SPECIFIC LEGAL REVIEW.**
> This draft describes the application's actual data behaviour as implemented. It is not a
> published policy, has not been reviewed by a qualified person, and must not be presented as
> final legal terms. Bracketed placeholders require decisions this repository cannot make.

## 1. Who this policy is from

`[LEGAL ENTITY / PUBLISHER NAME — DECISION REQUIRED]`
`[CONTACT ADDRESS — DECISION REQUIRED]`
`[DATA CONTROLLER IDENTITY — LEGAL REVIEW REQUIRED]`

> **Authoritative wording note.** The application's actual user-facing disclosure is
> `src/lib/legalDisclaimers.js`, presented at first launch and reviewable in Settings
> (currently acknowledgement version 9). This draft describes practice for review purposes and
> must not diverge from that source.

## 2. Scope

This policy covers the Road Sage application. Road Sage is a local-first driving tracker: the
application stores your driving data on your device and does not transmit trip records to a
service operated by the publisher.

## 3. Information processed on your device

| Category | Examples | Purpose |
|---|---|---|
| Location and route data | GPS coordinates, speed, heading, accuracy | Trip capture, mapping, replay, speed analysis |
| Trip records | Start/end time, distance, duration, capture source | The core product record |
| Driving events | Harsh braking, acceleration, cornering, speeding, distraction indicators | Scoring and review |
| Derived analysis | Scores, confidence, provenance, analytics, coaching and progression state | Review and trends |
| Road knowledge | Learned and confirmed speed limits with source and confidence | Speed-limit resolution |
| Vehicle information | Vehicle profiles, attribution, maintenance state | Segmenting your data |
| Parking data | Parked location, optional photos | Locating your vehicle |
| Phone-usage evidence | Usage windows during driving, where enabled | Distraction evidence |
| Settings and preferences | Configuration, privacy settings | Application behaviour |
| Camera sign crops | One tightly cropped sign image, encrypted in no-backup storage, deleted after the user's decision and unavailable after 24 hours | Parked confirmation of a scanned speed-limit sign |
| Survey labels | Post-trip calibration answers | Local calibration notes; they do not upload or automatically change scores |
| Diagnostic records | Application health events, build and session identifiers | Troubleshooting |

Trip payloads are encrypted at rest on the device.

## 4. Information transmitted off the device

Trip records are not transmitted to the publisher. The application has no publisher-operated
backend for trip data.

The following optional features transmit limited data to third parties when enabled:

| Feature | Recipient | Data | Default |
|---|---|---|---|
| Get Road Data | OpenStreetMap Overpass endpoints | Privacy-filtered public road boxes | Disabled by default |
| Get Road Data | An OSRM endpoint the user approves | Sampled public GPS route segments | Separate consent; can be invalidated |
| Get Weather | Open-Meteo | One rounded route point outside privacy-zone guards, plus the trip date | Disabled by default |

Get Road Data and Get Weather are distinct actions; Get Road Data never requests weather. No
camera image or recognised sign text is transmitted to any third party.

Third-party services operate under their own policies. See
[THIRD_PARTY_SERVICES.md](THIRD_PARTY_SERVICES.md).

## 5. Data you export

You may generate backups, reports, data exports and diagnostic reports. These are produced at your
request. Once shared, their contents are outside the application's control.

Diagnostic reports are constructed to exclude coordinates, route geometry, trip identifiers, trip
dates, notes, settings values, raw error text and stack traces, and contain no stable user or
device identifier.

## 5a. Use with other people

The application records the device it runs on and cannot identify who was driving. It must not be
used to track, score, evaluate, supervise, discipline, insure, employ, price or monitor another
person — including an employee, contractor, family member, minor, shared device or vehicle —
without every consent, disclosure, permission and legal basis required in the applicable
jurisdiction.

`[EMPLOYER / THIRD-PARTY MONITORING POSITION — LEGAL REVIEW REQUIRED]`

## 6. Identifiers

The application does not maintain a stable user account identifier or advertising identifier.
Diagnostics uses a per-launch session identifier and a per-process identifier, both regenerated on
each launch, and a build identifier that identifies the software build rather than the user or
device.

## 7. Permissions

Location and background location (trip capture), activity recognition (automatic detection),
notifications (capture notification and alerts), camera (speed-sign scanning, parking photos),
usage access (phone-usage evidence), Bluetooth (vehicle signals), biometric (optional app lock).

Declining or revoking a permission disables the dependent feature.

## 8. Retention

Route evidence expires according to your retention settings. Parking photos expire on a schedule.
Learned road-speed knowledge has a retention default. Records you delete are removed together with
their derived data.

`[STATUTORY RETENTION OBLIGATIONS — LEGAL REVIEW REQUIRED]`

## 9. Your choices and rights

You can configure privacy zones, record trips in private mode, adjust retention, export your data,
and erase your data. Erasure removes records and derived residue and is irreversible.

`[STATUTORY DATA-SUBJECT RIGHTS AND RESPONSE PROCEDURE — LEGAL REVIEW REQUIRED]`

## 10. Children

`[MINIMUM AGE AND CHILDREN'S DATA POSITION — DECISION REQUIRED]`

## 11. Security

The application implements encryption of trip payloads at rest, certificate pinning for pinned
external endpoints, an optional biometric app lock, screen-capture protection and application
integrity checks. No system is immune to compromise; these are controls, not guarantees.

## 12. Changes

`[POLICY CHANGE NOTIFICATION PROCEDURE — DECISION REQUIRED]`

## 13. Contact

`[PRIVACY CONTACT — DECISION REQUIRED]`

---

**Unresolved items are listed in [LEGAL_DECISIONS_REQUIRED.md](LEGAL_DECISIONS_REQUIRED.md).**
