# Derived State and Background Work

Two closely related subsystems: the derived-state model (what is precomputed and how it stays
valid) and the work coordinator (how background work is admitted and bounded).

Canonical sources: `src/lib/p6TripDerivedState.js`, `src/lib/p6RoadMemoryState.js`,
`src/lib/p6Contracts.js`, `src/lib/p6DerivedStorage.js`, `src/lib/appWorkCoordinator.js`,
`src/lib/appLifecycleWork.js`, `src/lib/rescoringQueue.js`, and on Android
`DriveSenseP6DerivedState.java` and `DriveSenseP6Jobs.java`.

## Derived state

Some values are too expensive to recompute on every render but are not raw recorded data. These
are persisted as derived state with explicit readiness, rather than cached implicitly.

Current derived domains are declared in `P6_DOMAIN_KEYS`:

| Domain | Subject |
|---|---|
| `D1_ANALYTICS` | Analytics aggregates |
| `D2_GEOMETRY` | Route geometry derivations |
| `D3_SPATIAL_SELECTION` | Spatial selection structures |
| `D4_ROAD_LEARNING_SPEED_LOOKUP` | Road-speed lookup structures |

Each domain has a control row recording `state`, `complete`, `required_version` and
`applied_version`. Readiness is therefore explicit and versioned: a consumer can tell whether a
domain is current, still converging, or unavailable.

**Absence is not readiness.** A missing control row reports `unavailable`, never "complete".

### Invalidation and recomputation

When source data changes, `required_version` advances. A domain whose `applied_version` lags is
stale and is recomputed by background jobs in bounded turns. Consumers that need exactness must
check readiness rather than assuming the derived value is fresh.

## Work coordinator

`appWorkCoordinator.js` is the admission point for recurring background work. It exists so that
maintenance, enrichment, rescoring, projection repair and retention cannot collectively stall the
UI or run unbounded.

Concepts:

| Concept | Meaning |
|---|---|
| Job registry | Declared jobs with identity and budget |
| Turn | One bounded unit of work for one job |
| Budget / ceiling | Declared maximum items a turn may examine |
| Backlog | Work known to remain |
| Lifecycle epoch | Generation marker; work from a prior epoch does not leak forward |
| Foreground state | Whether the app is user-visible |

`appLifecycleWork.js` registers the lifecycle jobs and their ceilings. A job declares what it will
examine before it runs, and the retained regression suites assert that the declared ceiling equals
the constant its domain derives — so a job cannot quietly grow its appetite.

### Fairness and boundedness

Each turn processes a page and reports whether more remains. A queue with 5,000 pending items does
not produce a 5,000-item turn; it produces many bounded turns. This is what keeps cost flat as
history grows.

`rescoringQueue.js` follows the same model: a bounded batch per turn, never the whole queue.

### Cancellation and epochs

Lifecycle transitions advance the epoch. Work admitted under an older epoch does not apply its
results to the new one, which prevents a long-running turn from writing stale output after a
teardown or authority change.

## Native counterpart

`DriveSenseP6Jobs.java` performs the equivalent derived work natively, and
`DriveSenseP6DerivedState.java` owns the `p6_control` rows. The archive plugin exposes a read-only
readiness accessor that performs four primary-key lookups — one per domain — so status can be
observed without triggering work.

## Diagnostics interaction

Diagnostics reports coordinator state (registered jobs, active and sleeping instances, backlog,
runnable backlog, lifecycle epoch, foreground, telemetry counts) and per-domain readiness. It
**observes** and never admits work. See [DIAGNOSTICS.md](DIAGNOSTICS.md).

## Failure semantics

| Failure | Behaviour |
|---|---|
| Job turn throws | Turn fails; backlog retained; no partial readiness claim |
| Derived domain unreadable | Reported `unavailable` |
| Version mismatch | Domain treated as stale and recomputed |
| Epoch advanced mid-turn | Results not applied |

## Testing

`p6FrozenContracts`, `p6DerivedStorageIntegration`, `p6CanonicalDebtFaults`, `p6KillMatrix`,
`p4ScaleMatrix` (bounded turn ceilings at multiple dataset sizes), `p4cAdapterAccounting`
(adapters account real domain work), `p5RegistrationContract`, and the Android P6 suites.
