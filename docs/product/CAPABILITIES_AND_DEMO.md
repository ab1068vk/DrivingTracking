# Capabilities and Demonstration Guide

A feature catalogue for evaluators, plus guidance for demonstrating the application accurately.

---

# Capability catalogue

Each entry states what it does, what it needs, and where it is limited. Platform column: **A** =
Android only, **W+A** = web and Android.

| Capability | Platform | Requires | Key limitation |
|---|---|---|---|
| Manual trip recording | W+A | Location permission | — |
| Foreground auto-detect | W+A | Location permission | Probabilistic start/stop |
| Native background tracking | A | Background location, activity recognition, notifications, battery exemption | OS and manufacturer background limits |
| Quick-settings tile | A | — | — |
| Trip history | W+A | — | Bounded pages; totals reported separately |
| Trip detail | W+A | — | — |
| Map view and playback | W+A | Route evidence | Unavailable for privacy-excluded or expired routes |
| 3D replay | W+A | Route evidence | Same as above |
| Driving events | W+A | Capture data | Derived from sensors; inherits sensor uncertainty |
| Evidence states | W+A | — | Explicitly distinguishes expired / privacy-excluded / unavailable / absent |
| Scoring | W+A | Sufficient evidence | Provisional thresholds; confidence-gated |
| Insights and analytics | W+A | Trip history | Sparse history yields developing/unavailable |
| Coaching programs | W+A | Trip history | Informational only |
| Achievements and progression | W+A | Trip history | — |
| Road-speed knowledge | W+A | Map data and/or observation | Coverage is incomplete by nature |
| Speed-sign scanning | A | Camera permission | Heuristic gate; optical conditions affect accuracy |
| Road/weather context enrichment | W+A | Network, consent | Off by default; third-party dependent |
| Vehicles and attribution | W+A | — | — |
| Parking + photos | A (widget A) | Location; camera for photos | Photos expire by design; indoor accuracy poor |
| Phone-usage evidence | A | Usage-access special permission | Cannot identify who used the phone |
| Bluetooth vehicle signals | A | Bluetooth, compatible hardware | Hardware-dependent |
| Voice alerts | A | Audio | — |
| Reports and exports | W+A | — | — |
| Privacy zones / private-trip mode | W+A | — | — |
| Retention and erasure | W+A | — | Erasure is irreversible |
| Backup and restore | W+A | Passphrase for protected backups | Lost passphrase is unrecoverable |
| App lock (biometric) | A | Biometric enrolment | — |
| Diagnostics | W+A | — | Software-observable state only |

Deeper detail lives in the engineering documentation: see
[../README.md](../README.md).

---

# Demonstration guide

## Prerequisites

- An Android debug build for anything native; a browser build cannot demonstrate background
  capture, scanning, the widget, phone-usage evidence or the tile.
- Representative data. A fresh install has no history, so scoring, insights, coaching and
  analytics will correctly show developing/unavailable states.
- Permissions granted in advance — requesting them live is slow and can fail.

## Suggested flow

1. **Overview** — Dashboard: what the app is and what it has recorded.
2. **History and detail** — open a trip; show route, events and score with its confidence.
3. **Evidence states** — show a trip where replay is available and, if possible, one where it is
   expired or privacy-excluded. This demonstrates the honesty model better than anything else.
4. **Speed knowledge** — the Speed Limits surface: sources, confidence and user correction.
5. **Insights / coaching / achievements** — derived analysis over history.
6. **Vehicles and parking** — attribution and parked-location features.
7. **Privacy** — privacy zones, private-trip mode, retention, erasure.
8. **Backup** — export, and mention that an untested backup is not a backup.
9. **Diagnostics** — what the app believes about itself, and what it deliberately excludes.

## What not to claim during a demonstration

- Do **not** claim the app has been validated on real hardware. It has not.
- Do **not** claim performance characteristics. No device measurements exist.
- Do **not** claim speed-limit accuracy, or that detection always works.
- Do **not** present the driving score as a safety rating or an assessment of the driver.
- Do **not** suggest the data is suitable as legal or insurance evidence.
- Do **not** describe the product as secure or private in absolute terms. Describe the specific
  controls instead.

## Features unsuitable for synthetic demonstration

Background auto-tracking, process-death recovery, speed-sign scanning and real GPS quality need
an actual drive. Simulated data can show the *surfaces* but not the behaviour. Say so rather than
implying the behaviour was demonstrated.

## Honest framing

A good framing is: *"The software is implemented and tested; its architecture is built around
reporting uncertainty honestly rather than guessing. Physical-device qualification is the next
phase and has not started."*
