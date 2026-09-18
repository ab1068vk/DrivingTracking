# Road-Speed Knowledge

How Road Sage decides what the speed limit was on a stretch of road, and how it learns.

Canonical sources: `src/lib/localSpeedKnowledge.js`, `src/lib/speedKnowledgeRepository.js`,
`src/lib/speedLimitSource.js`, `src/lib/speedLimitMapSections.js`, `src/lib/localRoadMemory.js`,
`src/lib/mapMatching.js`, `src/lib/openSourceTripContext.js`. Native counterparts:
`DriveSenseSpeedArchiveRepository`, `DriveSenseSpeedEditorRepository`,
`DriveSenseSpeedMaintenanceJob`, `DriveSenseLegacySpeedMigration`.

## Why this exists

Speed-limit data is incomplete everywhere. A scoring system that assumes a limit it cannot
support produces false speeding events. This subsystem's job is to produce a limit **with a
confidence and a provenance**, or to report that it has none.

## Spatial model

Road knowledge is keyed by geohash cells. `CELL_PRECISION` is the working precision and
`FALLBACK_PRECISION` a coarser fallback; `geohashEncode`, `geohashBounds`, `geohashCenter` and
`geohashNeighboursInclude` implement lookup, and `correctionMatchesPoint` decides whether a stored
correction applies to an observed point.

Time-of-day variation is supported through time buckets (`timeToBucket`), so a cell can hold a
profile rather than a single value — used only where the evidence supports it.

## Source hierarchy

A resolved limit records where it came from. Source and refusal vocabulary lives in
`speedLimitSource.js`; representative values:

| Source | Meaning |
|---|---|
| `user_confirmed_posted_sign` | User confirmed against a posted sign — highest trust |
| `learned_local` | Learned from repeated local observation |
| `fetched` / `cache_hit` | Retrieved from map data (OpenStreetMap via Overpass), possibly cached |
| `inferred` | Inferred from road classification (`highway`, `expressway`) |
| `global` | Broad default |
| `trip_consensus` | Agreement across multiple trips |
| `none` | No usable limit |

Refusal reasons are first-class rather than silent: `disabled`, `disabled_heightened_privacy`,
`all_points_private`, `bbox_too_large`, `blocked`, `no_tagged_ways`, `empty_route`.
`disabled_heightened_privacy` and `all_points_private` mean the system declined to look up a limit
for privacy reasons — not that no limit exists.

Units are tracked (`mph` handling) so a value is never misinterpreted across unit systems.

## Confidence and conflict

Every cell carries a confidence. Two distinct values are maintained: a calibrated `confidence`
and an `evidenceConfidence` derived from observation agreement — they are deliberately separate,
and consumers should not substitute one for the other.

Conflicts are represented, not resolved by overwrite: a cell can be marked `conflict` when
observations disagree. A special case is tracked explicitly —
`learned_limit_above_map_default`, where learned evidence exceeds the map-derived default.

Score and alert eligibility is gated: a rule must clear confidence and validation state before it
may affect scoring or raise an alert (`canAffectScoreAndAlerts`, stage `operational`,
`intelligenceValidated`). `SPEED_ALERT_MIN_CONFIDENCE` prevents alerting on weak data.

## Learning

Repeated passes over the same cell accumulate evidence. Candidates progress through review states
before becoming operational; a single pass does not create a rule. Minimum-evidence constants
(`SPEEDING_STRETCH_MIN_PASSES`, `MIN_RATE`, `MIN_TRIPS`) prevent asserting a pattern from one
observation.

Users can review, confirm and correct learned rules in the Speed Limits surface. User
confirmation against a posted sign is the strongest evidence class.

## Map matching and enrichment

`mapMatching.js` associates route points with road segments. `openSourceTripContext.js` performs
OpenStreetMap/Overpass enrichment. Enrichment is **network-dependent and consent-gated**;
automatic road/weather context fetch is off by default, and route snapping additionally requires a
trusted user-configured OSRM endpoint — the public demo host is rejected.

When enrichment is unavailable, the system falls back to learned and inferred sources and records
the reason, rather than failing the trip.

## Persistence and maintenance

Browser storage lives under the speed-knowledge repository; the native side keeps a speed archive
with its own editor repository and a bounded maintenance job. Legacy records are migrated by
`DriveSenseLegacySpeedMigration`, and the JS mirror keeps saved rules readable by native auto
tracking after migration.

Retention is bounded by `SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT`. Maintenance runs as bounded
turns through the work coordinator — never a whole-corpus pass on a user-visible path.

## Consumers

- Scoring: speeding events and compliance scores.
- Live alerts: sustained-overspeed alerting, gated by confidence and hysteresis.
- Speed Limits page and the tracking speed workspace: review and correction.
- Hazard horizon and speeding-stretch analysis.

## Limitations

Coverage depends on available map data and on how often a road has been driven. Learned values are
statistical, not authoritative. Time-of-day and conditional limits are only represented where
evidence supports them. Signs that are temporary, variable or unposted may not be represented at
all.

## Testing

`speedKnowledgeRepository`, `localSpeedScoreRefresh`, `savedSpeedResolverParity`,
`nativeSpeedRegionParity`, speed geometry and map-section suites, plus the Android P3.5 speed
suites (editor, maintenance, scale, batch fault, legacy migration).
