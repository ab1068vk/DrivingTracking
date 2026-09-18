# Road Sage — Product Overview

## What Road Sage is

Road Sage is a driving-tracker application for Android (built on a web application packaged with
Capacitor). It records trips, maps routes, identifies driving events, produces a driving score,
and keeps the resulting data on the device.

It is a **personal driving-record and review tool**. It is not a safety device, a legal evidence
system, an insurance product, or a driver-certification service.

## Intended use

Road Sage is intended to help a person:

- keep a record of trips they have driven,
- review a trip afterwards — route, events, speed and context,
- look at patterns in their own driving over time,
- keep that information under their own control on their own device.

It does not provide medical, legal, insurance, traffic-law or professional advice, and it does not
determine fault, liability or compliance with the law.

## Major capabilities

| Area | What it provides |
|---|---|
| Trip capture | Manual trips, foreground auto-detect, and Android native background auto tracking with activity recognition and a GPS fallback |
| Trip history and detail | Browsing recorded trips and examining an individual trip |
| Map and replay | Route display, playback, and 3D replay where route evidence is available |
| Events and evidence | Recorded driving events with an explicit evidence state per trip |
| Scoring | Component and overall scores with a confidence level and provenance |
| Insights | Trends and analytics derived from recorded trips |
| Coaching and progression | Structured coaching programs, milestones and achievements |
| Road-speed knowledge | Speed-limit resolution from map data, learned observation and user confirmation, each with a source and confidence |
| Speed-sign scanning | Android camera feature that reads posted speed-limit signs on demand |
| Vehicles | Vehicle profiles and trip attribution |
| Parking | Parked-location recording, optional photos with expiry, and a home-screen widget |
| Phone-usage evidence | Optional Android distraction evidence, requiring a special-access permission |
| Reports and exports | Report generation and data export |
| Privacy controls | Privacy zones, private-trip mode, retention settings and data-rights erasure |
| Backup and restore | Versioned, encrypted portable backups |
| Diagnostics | A bounded, privacy-preserving report describing what the app believes its own state to be |

## Platform

Road Sage is a React web application packaged into an Android application with Capacitor, backed
by Android native services written in Java.

Several capabilities are **Android-only** because they depend on native platform access:
background auto tracking, activity recognition, the quick-settings tile, speed-sign scanning, the
parking widget, phone-usage evidence and native durable storage. In a plain browser the
application runs, but those capabilities are not available.

## Where data lives

Trip records — including precise GPS traces — are stored on the device. The application does not
send trip records to a Road Sage server; there is no such server in this repository.

Some **optional** features contact third-party services for context: weather and OpenStreetMap
road data. These are network-dependent and consent-gated. See
[../legal/THIRD_PARTY_SERVICES.md](../legal/THIRD_PARTY_SERVICES.md) and
[../legal/DATA_HANDLING_NOTICE.md](../legal/DATA_HANDLING_NOTICE.md).

## Current maturity

| Track | Status |
|---|---|
| Implementation | Complete for the current branch |
| Software test coverage | Complete; JavaScript and Android suites pass |
| Independent software review | Completed for the most recent subsystem |
| **Physical-device qualification** | **Not started** |

Software qualification means the implementation behaves as specified under automated tests and
review. It does **not** establish real-world behaviour on physical hardware — background execution
under real operating-system pressure, GPS quality on real drives, camera behaviour in real
lighting, or performance on a real device with a large history.

No release or device qualification claim is made. See
[Limitations](LIMITATIONS.md) for what the product does not guarantee.

## Where to go next

| You are | Start here |
|---|---|
| Evaluating the product | [Capabilities and demo guide](CAPABILITIES_AND_DEMO.md) |
| Wondering how it works conceptually | [How Road Sage works](HOW_ROAD_SAGE_WORKS.md) |
| Looking for specific answers | [FAQ](FAQ.md) |
| Concerned about data | [../legal/DATA_HANDLING_NOTICE.md](../legal/DATA_HANDLING_NOTICE.md) |
| A developer | [../../README.md](../../README.md) |
