# Routes, Pages and Data Sources

Application topology. Routes are declared in `src/App.jsx`; pages live in `src/pages/`; page data
is supplied by hooks in `src/hooks/`.

Road Sage presents two surfaces: the **main application** and the **advanced tracking
workspace** under `/tracking`. Both are user-reachable in the current build.

## Main application

| Route | Page | Purpose | Principal data source | Data shape |
|---|---|---|---|---|
| `/` | `Dashboard` | Overview, recent activity, readiness | `useDashboardData` | Bounded window + scalar totals |
| `/trips` | `TripHistory` | Trip list | `useTripHistoryPageData`, `useTripHistoryTotals` | Bounded page + population |
| `/trips/:id` | `TripDetail` | Single trip detail | Direct identity resolution | Detail record |
| `/trips/:id/speed` | `SpeedAnalysis` | Per-trip speed analysis | `useTripSpeedKnowledge`, `useSpeedingStretches` | Detail + derived |
| `/trips/:id/3d` | `TripDrive3DPage` | 3D replay for a trip | Route/evidence for that trip | Detail geometry |
| `/3d-replay` | `Trip3DReplay` | Replay entry surface | Trip selection | Bounded |
| `/map` | `MapScreen` | Map view | `useMapScreenGeometry` | Bounded geometry |
| `/parking` | `Parking` | Parked-location features | Parking modules | Current + history |
| `/coach` | `DrivingCoach` | Coaching programs and guidance | `useDrivingCoachData` | Derived |
| `/insights` | `Insights` | Analytics and trends | `useInsightsData` | Derived aggregates |
| `/achievements` | `Achievements` | Progression and milestones | `useAchievementsData` | Derived ledger |
| `/reports` | `Report` | Report generation and export | `useReportData` | Bounded + export |
| `/vehicles` | `Vehicles` | Vehicle profiles and attribution | `useVehicleAnalytics` | Bounded collection |
| `/speed-limits` | `SpeedLimits` | Road-speed knowledge and saved rules | `useSpeedMapGeometry` | Bounded + derived |
| `/privacy-intelligence` | `PrivacyIntelligence` | Privacy dashboard and protection checks | Privacy modules | Status |
| `/settings` | `Settings` | Application settings | `useLocalSettings` | Settings store |
| `/diagnostics` | `Diagnostics` | Observability report | `useDiagnosticsPageData` | Bounded snapshot |
| `/system-logs` | `SystemLogs` | Recorded system events | `systemLog` | Bounded log |
| `/android` | `AndroidReference` | **Debug-only** native reference | native bridges | Gated by `VITE_SHOW_DEBUG_ROUTES` or dev mode |

`Onboarding` is presented on first run rather than as a standalone navigation target.

## Advanced tracking workspace

A separate operator-oriented workspace for inspecting capture in depth. These screens are more
technical than the main application and are intended for advanced users and developers.

| Route | Page | Purpose |
|---|---|---|
| `/tracking` | `TrackingOverview` | Workspace entry and capture status |
| `/tracking/recorder` | `TrackingTripHistory` | Recorded-session browsing |
| `/tracking/map` | `TrackingMapWorkspace` | Map workspace over captured geometry |
| `/tracking/events` | `TrackingEvents` | Event inspection for a subject trip |
| `/tracking/alerts` | `TrackingAlertsLab` | Alert behaviour inspection |
| `/tracking/evidence` | `TrackingEvidenceConsole` | Evidence state inspection |
| `/tracking/speed` | `SpeedLimits` (speed workspace) | Speed knowledge workspace |
| `/tracking/privacy` | `TrackingPrivacyConsole` | Privacy state inspection |
| `/tracking/reports` | `TrackingReportsLab` | Report and export authority surface |
| `/tracking/replay` | `TrackingReplayPro` | Detailed replay |
| — | `TrackingTripDetail` | Subject trip detail within the workspace |

Workspace screens accept an explicit trip subject. Subject resolution is owned by
`src/lib/trackingTripSubject.js`: a screen asked for a specific trip resolves that trip directly
rather than substituting the first row of a loaded page. See
[../architecture/QUERY_AND_PROJECTIONS.md](../architecture/QUERY_AND_PROJECTIONS.md).

## Data-shape conventions

| Shape | Meaning |
|---|---|
| Bounded page | Fixed limit with continuation and completeness metadata |
| Population | Separate scalar count, only when an owner supplies it |
| Detail | Single record resolved by explicit identity |
| Derived | Precomputed domain state with readiness |

No page loads whole history. A surface that needs a total requests a scalar count rather than
counting loaded rows.

## Platform notes

The Android reference route is debug-gated. Native capture control, quick-settings tile, parking
widget and speed-sign scanning are Android-only; on the web those surfaces degrade to their
observational parts rather than pretending native capability exists.
