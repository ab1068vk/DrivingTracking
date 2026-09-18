# Data Models

Durable contracts for the main domain and state objects. This documents *meaningful contracts*,
not every JavaScript object. Field names below are the ones that carry semantics across layers.

## Trip

A trip is the central record. Its lifecycle is: candidate → active (capturing) → completed →
(optionally) rescored or enriched.

| Field group | Semantics |
|---|---|
| Identity | `id`, `status` (`completed` is the state list surfaces filter on) |
| Timing | `start_time`, `end_time`, `duration_seconds`, `trip_utc_offset_minutes` |
| Distance / motion | `distance_km`, `avg_speed_kmh`, `avg_running_speed_kmh` |
| Collection source | `start_source` — categorical capture origin; see below |
| Route | `route_key`, `route_points_map_count`, `route_replay_available`, `route_data_expired_at` |
| Privacy | `privacy_mode` (`summary_only` marks a privacy-excluded trip) |
| Scoring | `overall_compliance_score`, `score_confidence`, `score_version`, `driver_metric_eligible` |
| Events | harsh brake, rapid accel, sharp turn, speeding, distraction, phone-use and severe-event counts |
| Context | `road_type`, `night_driving`, weather/wet signals, tags and `tag_sources` |
| Attribution | vehicle association, `nickname`, `is_favorite` |

`start_source` is authoritative for how a trip was captured. Diagnostics maps it to a collection
mode; a generic value does not imply automatic capture. Recognised values include
`native_manual`, `native_auto`, `manual` and `auto`, with a legacy/unknown fallback.

## Active trip

In-progress capture state, held in a spool rather than as a finished trip:

- accumulating route points and event observations,
- capture tier / fidelity state,
- checkpoint markers used to resume after process replacement,
- ownership identity so a replacement process can tell live work from abandoned work.

Browser: `src/lib/browserActiveTripSpool.js`. Native: `DriveSenseActiveTripSpool`.

## Route point

The normalised unit produced by `normalizeLocationPoint`: coordinates, timestamp, speed, heading
and accuracy, subject to admission by `shouldAcceptLocationPoint`. Rejected points carry a
rejection reason rather than vanishing.

Route point collections are the privacy-sensitive part of a trip: masked by privacy zones,
reduced by `simplifyRoute`, excluded by private-trip mode, and subject to expiry.

## Evidence and replay state

Replay evidence resolves to exactly one categorical state, with deliberate precedence:

| State | Meaning |
|---|---|
| `privacy_excluded` | Trip is summary-only; evidence intentionally withheld |
| `expired` | Route evidence existed and has passed its retention/expiry |
| `unavailable` | Representation cannot currently be produced |
| `present` | Replay evidence is available |
| `absent` | No evidence was recorded |
| `legacy_unknown` | Older record without an attributable state |

Precedence matters: an unavailable projection must not be reported as `absent`, and a
privacy-excluded trip must not be reported as having no evidence.

## Vehicle

Profile identity, display name, reference-catalogue attributes, maintenance state and the
attribution relationship to trips. Deleting a profile must not leave trips claiming a resolved
vehicle that no longer exists; dangling references are surfaced rather than silently truthy.

## Score result

A score is not a bare number. It carries:

- the component domain values (`safety`, `smoothness`, `eco`, `intersection`) and the composed
  `overall`,
- a confidence level per component (`high` / `developing` / `low` / `unavailable`),
- provenance describing the constants snapshot and evidence tier,
- `score_version` (`SCORING_VERSION`) identifying the constants that produced it.

A stored score is only interpretable together with its version and provenance.

## Derived-state control

Per domain: `domain`, `state`, `complete`, `required_version`, `applied_version`. A missing row
means `unavailable`, never complete.

## Archive control (native)

`archive_meta` single row: `archive_generation`, `authority_state`, `recovery_state`,
`last_committed_seq`, `live_count`, `tip_chain_hash`, `pending_count`,
`projection_required_seq`, `updated_at_ms`.

`open_operations`: `operation_id`, `operation_type` (`LEGACY_IMPORT`, `DIRECT_COMMIT`,
`BACKUP_V2_RESTORE`, `TRIP_COMMIT`, …), `state` (`RECEIVING`, `ABANDONED_INGRESS`, …),
`owner_token`.

`migration_ingress`: `operation_id`, `trip_id`, `source_hash`, `expected_bytes`,
`received_bytes`, `next_chunk_index`, `temp_path`, `state`.

## Query page and population

Page: rows, requested limit, row count, continuation flag, completeness (exact/partial), and the
source snapshot (authority, generation, revision, query id).

Population: availability flag, total count when available, completed-count state, a reason when
unavailable, and its own source snapshot so a caller can tell whether page and population came
from the same state.

## Backup metadata

Portable backups are versioned and encrypted, record their format version and provenance, and are
treated as untrusted on import. Private coordinates are never restored. See
[../data/BACKUP_AND_RESTORE.md](../data/BACKUP_AND_RESTORE.md).

## Build and session identity (Diagnostics)

`artifactId = sourceId:buildType:flavor:vc<versionCode>`; a per-launch session id; a per-process
native session id. None is a stable user or device identifier.
