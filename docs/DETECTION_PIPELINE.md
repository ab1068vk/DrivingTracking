# Detection Pipeline

How a driving event goes from GPS points to a scored, severity-classified record, which
parts of it a user can change from Settings, and how the JavaScript scorer and the Android
live detector stay in agreement.

Companion documents: [PRIVACY_INTELLIGENCE.md](PRIVACY_INTELLIGENCE.md) for what the motion
stream implies for personal data, [CAPTURE_FIDELITY.md](CAPTURE_FIDELITY.md) for how those
samples are captured and budgeted, and [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md) for
the generated function-level reference.

## 1. The path a point takes

```
GPS point
  → calculateSegmentMetrics()      noise floor, implied vs reported speed agreement
  → reliablePointSpeed()           spike rejection, per-point trusted speed
  → computeSmoothedAccelerations() centered difference over a 3-point window
  → detectDrivingEvents()          per-type triggers and severity
  → refineEventsWithMotion()       IMU confirms, refutes, or abstains
  → calculateTripScores()          counts, penalties, component scores
```

Every detector reads its trigger from a **resolved threshold object** built by
`buildDrivingThresholds(settings)`, which maps the lower_snake settings keys the UI writes
(`threshold_harsh_brake_ms2`) onto the UPPER_SNAKE names the detectors use
(`HARSH_BRAKE_MS2`), falling back to `DEFAULT_THRESHOLDS`, which come from
`scoringConstants.js`. That chain is the reason a value only has to be defined once.

### Acceleration is a centered difference

`computeSmoothedAccelerations` compares the reliable speed *before* `points[i]` with the one
*after*, over the time between them. Both ends must span the same interval as the
denominator. Pairing a single-step speed delta with a two-step time span reports exactly
half the true rate, which is what the code did before `SCORING_ALGORITHM_REVISION = 3`: a
sustained 5 m/s² stop measured as 2.5 m/s² and never reached the 3.5 m/s² trigger. Expect
higher harsh-brake and rapid-acceleration counts on trips re-scored across that revision.

Two different window bounds exist deliberately:

| Constant | Bounds | Why |
| --- | --- | --- |
| `ACCEL_SMOOTHING_MAX_WINDOW_SECONDS` (15 s) | the centered 3-point window, i.e. two sample gaps | keeps a long outage from being averaged into a plausible-looking rate |
| `ACCEL_RAW_MAX_GAP_SECONDS` (10 s) | the single segment used by the raw fallback | applies when the smoothed value is unavailable, e.g. a neighbouring speed spike |

## 2. Severity is relative to the configured threshold

Severity is classified against **multiples of the trigger that produced the event**, not
against absolute literals. `src/lib/scoring/eventSeverity.js` owns this; the multipliers
live in `EVENT_SEVERITY_BAND_MULTIPLIERS`.

| Event | medium | high | At the default trigger |
| --- | --- | --- | --- |
| `harsh_brake` | 1.40× | 1.75× | 3.5 → 4.90 / 6.13 m/s² |
| `rapid_acceleration` | 1.35× | 1.70× | 3.0 → 4.05 / 5.10 m/s² |
| `idle` | 2.00× | 3.30× | 90 → 180 / 297 s |
| `stop_start_pattern` | 1.20× | 1.60× | ratio-based, see below |
| `close_proximity` | 1.15× | 1.40× | ratio-based, see below |

Why this matters: the Settings UI allows harsh braking anywhere in 2–8 m/s², but severity
used to be fixed at `>6 high / >5 medium`. A user who set 7.0 got **every** surviving event
classified `high`, because the trigger itself sat above the high band; a user who set 2.0
could never produce anything above `low`. The multipliers were chosen so that at default
settings the boundaries land within a few percent of the old literals, keeping the forced
re-score near-neutral for anyone who never touched a slider.

Two-dimensional events (`stop_start_pattern`, `close_proximity`) classify on the **minimum**
of their two normalized ratios, so both dimensions have to escalate together. This
reproduces the old highway stop-start behaviour exactly while fixing urban stop-starts,
which under the previous absolute literals could essentially never exceed `low`.

Degenerate input is floored, not promoted: a threshold of zero or below returns `low`
rather than reporting everything as `high`.

`sharp_turn` is not in this table — it classifies against its own
`SHARP_TURN_G_LOW/MEDIUM/HIGH` settings and was the model the rest were generalized from.

Speeding uses `classifySpeedingSeverity`: absolute km/h margins above a known limit
(`SPEEDING_SEVERITY_MEDIUM_OVER_KMH` / `..._HIGH_OVER_KMH`), and multiples of the
configured fallback threshold when no limit is available.

## 3. What Settings actually controls

Slider bounds come from `settingRange(key)` in `trackingStore.js`, which reads the same
`SETTING_NUMBER_RANGES` table that `validateSettingsPatch` enforces and that backup import
clamps against. A control therefore cannot offer a value the app would then refuse to save.
`thresholdCalibration.js` intersects its own deliberately-conservative auto-calibration
bounds with the same table, so auto-calibration can nudge a threshold but never push it to
the edge of the saveable band.

Phone-use sensitivity presets **write** `phone_confidence_threshold` rather than overriding
it at read time, so the slider and the preset cannot disagree. Settings defaults version 24
migrates existing low/high users onto the explicit value so their detection sensitivity does
not change on upgrade.

Settings that affect detection but have no slider are not silently unreachable — the eco
constants, `threshold_long_drive_minutes`, `phone_micro_steer_window_s` and
`phone_proxy_max_accuracy_m` all have controls under Detection Features and Phone Use
Detection.

## 4. JavaScript and Android agree by construction

The native service runs its **own** live detector for voice coaching. It never produces a
score: completed native trips are stored with null scores, `needs_rescore: true` and
`score_status: "pending_javascript_scoring"`, and the JavaScript pipeline scores them.

Its constants used to be hand-copied and had drifted — minimum speed 15 km/h against the
scorer's 25/5/25, sharp-turn heading gate 12° against 30°, urban split 55 against 50,
accuracy gate 25 m against 50 m. Users heard alerts for events that never appeared in the
scored trip.

They are now generated:

```bash
npm run native:constants         # regenerate DetectionConstants.java
npm run native:constants:check   # fails if stale (runs as part of pretest)
```

`scripts/generate-native-detection-constants.mjs` emits
`android/app/src/main/java/com/drivesense/app/DetectionConstants.java` from
`scoringConstants.js`. Each field names the JS constant it mirrors, and
`androidTripStatsParity.test.js` walks the generated file and asserts every value still
equals its source. Do not edit the Java file by hand.

One shared `LIVE_EVENT_MIN_SPEED_KMH` was split into the three gates the scorer actually
uses: `MIN_SPEED_HARSH_BRAKE_KMH`, `MIN_SPEED_RAPID_ACCEL_KMH`, `CORNERING_MIN_SPEED_KMH`.

Deliberate differences stay in the service next to a comment explaining them: alert
cooldowns, and the tighter accuracy gate for spoken alerts. Stop-start threshold selection
is an approximation on the native side — the scorer picks urban vs highway from the trip
median moving speed, which live coaching does not have until the trip ends, so it uses the
current speed against the same shared split point.

Phone-proxy tuning is read from settings per sample rather than frozen into `static final`
fields, so the sensitivity controls are not a no-op natively.

## 5. IMU refinement

`src/lib/scoring/motionEventRefinement.js` compares each `harsh_brake`,
`rapid_acceleration` and `sharp_turn` against a ±`IMU_REFINEMENT_WINDOW_SECONDS` window of
motion samples, using the axis identified by `calibratePhoneOrientation`.

| Outcome | Condition | Effect |
| --- | --- | --- |
| `confirmed` | IMU peak ≥ `IMU_CONFIRM_RATIO` of the GPS magnitude | recorded, severity unchanged |
| `contradicted` | IMU peak ≤ `IMU_REFUTE_RATIO` **and** orientation confidence is `high` | severity downgraded one band |
| `inconclusive` | between the two, or a low-confidence calibration | unchanged |
| `unavailable` | no samples, or orientation never calibrated | unchanged |

Two rules constrain this hard:

1. **The IMU never creates an event.** `calibratePhoneOrientation` recovers which device
   axis is longitudinal but neither its sign nor a full rotation matrix, and a phone being
   picked up produces accelerations indistinguishable from braking. GPS triggers; the IMU
   only agrees, disagrees, or abstains. A refutation lowers severity rather than deleting
   the event — the GPS evidence still exists, it is just no longer corroborated.
2. **The outcome is persisted on the event.** Motion samples are purged after
   `MOTION_SAMPLE_RETENTION_DAYS_DEFAULT` (14 days). An event that already carries
   `imu_evidence` is left untouched on re-score, so a score cannot silently move back when
   the samples that justified it expire.

This is the direct fix for urban-canyon and tunnel-exit false positives, where GPS reports a
speed cliff the vehicle never experienced.

### IMU jerk

`src/lib/scoring/motionJerk.js` derives jerk from the ~50 Hz longitudinal axis. The raw
signal measures suspension travel, road texture and phone rattle, so it is low-pass filtered
(`IMU_JERK_SMOOTHING_WINDOW_MS`) and differentiated over a step long enough to be a vehicle
motion rather than a chassis response (`IMU_JERK_STEP_MS`), with the derivative broken
across any gap over `IMU_JERK_MAX_GAP_MS`.

The **reported** `avg_jerk_ms3` switches to the IMU value when available, and
`jerk_data_source` becomes `['gps', 'imu']`. The **scored** `jerk_score` deliberately stays
on the GPS path: its penalty ladder was fitted against GPS-derived jerk, and rescaling it
for a differently-conditioned signal without labelled data would move every smoothness score
for reasons unrelated to driving. `gps_avg_jerk_ms3` is retained alongside for comparison.

## 6. Changing a constant

1. Edit `src/lib/scoringConstants.js`. Every entry carries a label, domain, calibration
   note, and the metrics it affects.
2. If the change alters how a score is *computed* rather than only what a threshold is,
   increment `SCORING_ALGORITHM_REVISION` and add a revision-history entry.
3. `npm run scoring:version` — never hand-edit `scoringVersion.generated.js`.
4. `npm run native:constants` if the constant is mirrored natively.
5. `npm test`. The golden fixtures pin canonical scores; a deliberate change means
   regenerating them and confirming every diff is explained.
6. Only user-settable constants belong in `PROVENANCE_THRESHOLD_KEYS` — detector-internal
   shape constants would bloat every per-trip provenance snapshot.

Existing trips whose `score_version` no longer matches are flagged for re-score, and
`localTripRepository` auto-rescores when more than 20% of the last 28 days mismatch.

## 7. Known limits

- Detection is GPS-first. The IMU refines but does not detect, for the reasons in §5.
- `close_proximity` and the phone-use GPS proxy are diagnostic signals derived from
  steering and speed patterns. Neither observes another vehicle or the phone screen, and
  the phone proxy never contributes to a score — confirmed phone use requires Usage Access.
- Most thresholds are marked `provisional` in the constants registry. They are
  telematics-conventional values, not outcome-calibrated ones, which is why score outputs
  are presented as approximate.
- The golden fixtures cover speeding and a smooth urban route; they contain no harsh
  braking or rapid acceleration, so the acceleration path is covered by
  `detectionThresholdCoupling.test.js` instead.
