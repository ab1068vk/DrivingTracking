# Constants and Policy Reference

Significant policy values, where they live, and which are sensitive. This is a curated reference,
not a dump of every literal — read the source files for exact current values.

## Where policy lives

| File | Scope |
|---|---|
| `src/lib/scoringConstants.js` | Scoring thresholds, blends, risk weights — each annotated with calibration status |
| `src/lib/scoringVersion.generated.js` | Generated content hash of the above; **never hand-edit** |
| `src/lib/appConstants.js` | Cross-cutting policy shared with Android native scoring |
| `src/lib/tripEngine.js` | Engine-level defaults: `DEFAULT_THRESHOLDS`, `EVENT_PENALTIES`, `SVI_DEFAULTS`, `CONFIDENCE_LEVELS` |
| `src/lib/dataBackupConstants.js` | Backup format versions and import limits |
| `android/app/build.gradle` | Version code/name, flavours, build identity |

## Scoring policy

| Constant | Meaning | Sensitivity |
|---|---|---|
| `SCORING_ALGORITHM_REVISION` | Algorithm revision marker | **High** — changes score comparability |
| `SCORING_CONSTANTS` | Aggregate scoring policy | **High** |
| `PENALTY_SCALE_FACTOR` | Scales event penalties into score impact | **High** |
| `LANE_CHANGING_SAFETY_WEIGHT` | Weight of lane-change safety | **High** |
| `DEFAULT_HOURLY_RISK_PROFILE` | Time-of-day risk weighting | Medium |
| `CALIBRATION_STATUSES` / `SCORE_OUTPUT_CALIBRATION_STATUSES` | Declares which outputs are calibrated vs provisional | **High** — governs how results may be presented |
| `EVENT_PENALTIES` | Per-event `score` and `weight` | **High** |
| `SVI_DEFAULTS` | Speed-variability parameters: 5 km/h moving floor, minimum moving/stratum samples, 80 km/h highway boundary | **High**, explicitly provisional in source |
| `CONFIDENCE_LEVELS` | `high` / `developing` / `low` / `unavailable` | **High** — presentation depends on it |

Changing any high-sensitivity value requires running `npm run scoring:version`, checking Android
parity, and considering whether stored scores need rescoring.

## Shared JS/Android policy

Defined in `appConstants.js` so both scorers agree:

| Constant | Meaning |
|---|---|
| `NIGHT_START_HOUR` / `NIGHT_END_HOUR` | Fixed 22:00–04:59 night window |
| `MORNING_RUSH_*` / `EVENING_RUSH_*` | Rush-hour boundaries |
| `PENALTY_SCALE_FACTOR` | Shared penalty scale |
| `FATIGUE_SAFETY_PENALTY_SCALE`, `FATIGUE_SAFETY_MAX_PENALTY` | Fatigue penalty scale and ceiling |

These are mirrored in native scoring. Parity is covered by golden/parity suites — change both
sides together.

## Alerts and hazard policy

| Constant | Meaning |
|---|---|
| `SPEED_ALERT_SUSTAINED_MS` | How long an overspeed must persist before alerting |
| `SPEED_ALERT_MIN_CONFIDENCE` | Minimum speed-limit confidence required to alert |
| `SPEED_ALERT_RELEASE_KMH` | Hysteresis for clearing an alert |
| `HAZARD_HORIZON_ALERT_SECONDS`, `HAZARD_HORIZON_MIN/MAX_SECONDS` | Look-ahead window for hazard alerts |
| `HAZARD_PROJECTION_SLACK`, `HAZARD_PROJECTION_MIN_M`, `HAZARD_PROJECTION_MAX_M` | Projection distance bounds |

`SPEED_ALERT_MIN_CONFIDENCE` is a user-safety-relevant gate: it prevents alerting on low-confidence
speed data. Do not lower it casually.

## Retention and display limits

| Constant | Meaning |
|---|---|
| `SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT` | Default retention for learned road speeds |
| `MAX_VISIBLE_DANGER_ZONES`, `MAX_ROUTE_RISK_SEGMENTS_SHOWN` | UI display ceilings |
| `DANGER_ZONE_CLUSTER_RADIUS_M`, `DANGER_ZONE_MIN_TRIPS` | Danger-zone clustering thresholds |
| `SPEEDING_STRETCH_MIN_PASSES/RATE/TRIPS` | Minimum evidence before a stretch is claimed |

The minimum-evidence constants exist so the product does not assert a pattern from a single
observation. Lowering them weakens a truthfulness guarantee, not just a display rule.

## Query and work bounds

Page limits, turn ceilings and response byte caps are declared next to their owners rather than
centrally: the archive plugin enforces request/response byte ceilings, lifecycle jobs declare
per-turn budgets (`P4_LIFECYCLE_TURN_BUDGET_CEILINGS`), and the rescoring queue declares its page
size and examined ceiling. Retained suites assert that a declared ceiling matches the constant its
domain derives.

## Android

| Value | Current | Notes |
|---|---|---|
| `versionCode` | `3` | Must increase monotonically; enforced by `recovery:guard` |
| `versionName` | `1.1.0` | Shipped Android identity |
| `applicationId` / `namespace` | `com.drivesense.app` | Guarded; changing breaks in-place upgrades |

## Rule of thumb

If a constant governs **what the product asserts to a user** — a confidence gate, a minimum
evidence count, a calibration status, a penalty scale — treat it as policy requiring review, not
as a tuning parameter.
