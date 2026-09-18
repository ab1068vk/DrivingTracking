# Vehicles, Parking and Android Device Integration

Three supporting product areas that are substantial in implementation and were previously
undocumented.

---

# Vehicles

Canonical sources: `src/lib/localVehicleRepository.js`, `src/lib/vehicleReferenceCatalog.js`,
`src/lib/vehicleSuggestions.js`, `src/lib/vehicleMaintenance.js`, `src/api/vehicles.js`,
`src/pages/Vehicles.jsx`, `src/hooks/useVehicleAnalytics.js`.

## Model

A vehicle profile carries identity, display name, reference attributes drawn from a bundled
reference catalogue, and maintenance state. Trips are attributed to a vehicle so that analytics
and reports can be segmented.

`vehicleReferenceCatalog.js` holds curated reference data with provenance (each entry records the
source it was reviewed against and when). It is bundled reference material, not a live lookup
service.

## Attribution and lifecycle

Trips reference a vehicle. The important invariant is that **deleting a profile must not leave
trips asserting a resolved vehicle that no longer exists**. Dangling references are surfaced for
repair rather than silently rendered as truthy attribution, and default promotion rules do not
invent an attribution that the user never made.

## Reads

Vehicle collections are read as bounded collections with truthful continuation, not as unbounded
arrays. Different consumers requesting different windows must not share a cache identity.

## Consumers

Vehicle analytics, reports and exports, trip detail attribution, and maintenance surfaces.

## Testing

`vehicleLifecycleWave4` covers lifecycle and dangling-reference behaviour; vehicle repository and
analytics suites cover reads and attribution.

---

# Parking

Canonical sources: `src/lib/parkingHistory.js`, `src/lib/parkingLearning.js`,
`src/lib/parkingDiagnostics.js`, `src/pages/Parking.jsx`, and on Android
`DriveSenseParkingResolver.java`, `ParkingPhotoExpiryScheduler.java`,
`WhereIParkedWidgetProvider.java`.

## What it does

Records where the vehicle was parked at the end of a trip so the user can find it again, with
optional photos and a home-screen widget.

| Capability | Owner |
|---|---|
| Resolving the parked location | `DriveSenseParkingResolver` |
| Parking history | `parkingHistory.js` |
| Learning frequent parking patterns | `parkingLearning.js` |
| Photo retention | `ParkingPhotoExpiryScheduler` |
| Home-screen widget | `WhereIParkedWidgetProvider` |
| Status reporting | `parkingDiagnostics.js` |

## Photo expiry

Parking photos are **not** retained indefinitely. `ParkingPhotoExpiryScheduler` is a scheduled
Android component that expires them. This is a privacy control, not a storage optimisation —
treat any change to its schedule as privacy-affecting.

## Widget

`WhereIParkedWidgetProvider` renders the parked location on the home screen. It is an Android app
widget: it displays already-derived state and is not an independent capture path.

## Privacy

A parked location is a precise, frequently home-or-work location — among the most sensitive data
the product holds. Privacy zones apply. Trips in private mode do not contribute parked-location
detail.

## Limitations

Resolution depends on the quality of the final location fix. Indoor and underground parking
frequently yields poor accuracy. The widget reflects the last resolved location, not a live
position.

---

# Android device integration

Supporting native integrations that make the product usable outside the app UI.

| Integration | Component | Notes |
|---|---|---|
| Quick-settings tile | `DriveSenseAutoTrackingTileService` | Arm/disarm native tracking from the system tile |
| Live capture notification | `DriveSenseAutoTrackingService` | Required foreground-service notification; also the user's stop control |
| Voice alerts | `DriveSenseSpeechController`, `src/lib/voiceAlerts.js` | Spoken alerts; `ACTION_STOP_SPEECH` stops output |
| Notifications | `src/lib/notificationService.js`, `milestoneNotificationCoordinator.js` | Trip, coaching and milestone notifications |
| Boot / update re-arm | `DriveSenseBootReceiver` | Re-arms only when the durable opt-in is set |
| Phone-usage evidence | `DriveSensePhoneUsageTracker`, `src/lib/phoneUsageAccess.js` | See below |
| Background road data | `RoadDataJobService` | Bounded background enrichment |
| App protection | biometric gate, screen security, RASP | See the security documentation |

## Phone-usage evidence

Uses Android's `PACKAGE_USAGE_STATS` access to determine whether the phone was being used during
driving, contributing distraction evidence to scoring.

This is a **special-access permission**: the user must grant it explicitly through system settings,
and it can be revoked at any time. When it is not granted the feature reports unavailable — it does
not infer usage from other signals. The product records usage *windows* as evidence, not the
content of what was used.

## Bluetooth

The manifest declares Bluetooth permissions used for vehicle-connection signals. Availability
depends on the vehicle and adapter; treat this as hardware-dependent and optional rather than a
guaranteed capability.

## Failure modes

| Condition | Behaviour |
|---|---|
| Notification permission denied | Foreground capture constrained by the platform |
| Usage-stats access not granted | Phone-use evidence reported unavailable |
| Battery optimisation active | Background capture reliability is device-dependent |
| Widget update suppressed | Widget shows last known state |

Real behaviour across manufacturers is a device-qualification obligation; see
[../operations/DEVICE_QUALIFICATION.md](../operations/DEVICE_QUALIFICATION.md).
