# Phase 0 incident triage results

Measured June 22, 2026 on the connected Samsung SM-S931W Android target with 53 completed trips, 13,903 stored route points, and 35 saved road-speed corrections.

## Top blockers

1. `app.bootstrap.tripRepositoryMaintenance`: **19,763.3 ms** after cold launch.
2. Saved road speeds `tripService.list({ limit: 500 })`: **19,380.2 ms** baseline and **19,836.1 ms** with both tested map components disabled.

The Saved road speeds follow-on work was much smaller: `buildSpeedMapSections()` took 16.3 ms for 13,903 points, layer drawing took 23.9 ms for 286 sections, and `fitBounds` took 9.2 ms.

## Six-page baseline matrix

The slowest requested instrumented mark observed while following Dashboard → Trip History → Map → Saved road speeds → Settings → Trip Detail was:

| Page | Slowest mark | Time |
| --- | --- | ---: |
| Dashboard (cold) | `tripSummaryQueryOptions.queryFn` | 5,222.9 ms |
| Trip History | `RouteLogger.recordSystemEvent` (summary query was warm) | 0.1 ms |
| Map | `tripService.listSummaries(limit: 500)` | 730.1 ms |
| Saved road speeds | `tripService.list(limit: 500)` | 19,380.2 ms |
| Settings | `RouteLogger.recordSystemEvent` | 0.1 ms |
| Trip Detail | `TripMap.layerDraw` | 31.2 ms |

Android reported a **1,893 ms** cold activity launch. `app.coldBootstrap` itself took 16.0 ms; its deferred repository maintenance later took 19,763.3 ms.

## Controlled tests

### Maps disabled

The `VITE_TRIAGE_DISABLE_MAPS=true` build prevented `TripMap` on Map overview and `SpeedLimitEditorMap` on Saved road speeds from mounting. No map draw or fit marks occurred. The Saved road speeds full-trip query still took **19,836.1 ms**, followed by only 16.6 ms of section computation. This rules out map rendering as either of the top two blockers on this data set.

### Dashboard limited to 50 summaries

The `VITE_TRIAGE_DASHBOARD_LIMITED_SUMMARIES=true` build replaced Dashboard's all-summary query with `listSummaries({ limit: 50 })`.

- Baseline all summaries: **5,222.9 ms**
- Limited 50 summaries: **4,901.2 ms**
- Android cold activity launch: **1,893 ms** baseline versus **1,796 ms** limited

The 321.7 ms query reduction (6.2%) did not materially change cold responsiveness. This rules out result count alone; the summary repository path remains expensive even with a limit.

### Route logging deferred

`RouteLogger` now calls `recordSystemEvent()` through `requestIdleCallback` with a two-second timeout and a 250 ms timer fallback. The measured logging call took **0–1.8 ms**, so route logging is not a primary blocker on this device.

### Resume tasks

A hot foreground resume took 26 ms at the Android activity level. Individual in-app marks were:

| Resume task | Observed range |
| --- | ---: |
| Native completed-trip sync | 8.2 ms |
| Key rotation | 8.4–11.3 ms |
| Road context queue | 8.5–11.3 ms |
| Raw GPS retention | 8.3–10.3 ms |
| Privacy-zone sweep | 0.3–2.4 ms |

Both `visibilitychange` and Capacitor `appStateChange` initiate overlapping resume work, but their measured durations did not make resume a top-two blocker in this run.

## Phase 0 conclusion

Prioritize investigation of full-trip repository reads/maintenance. Do not prioritize Leaflet rendering, route logging, result limiting alone, or the measured resume tasks based on this run.
