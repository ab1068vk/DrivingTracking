# Motion Capture Fidelity and the Low-Power Guard

How much motion (IMU) data Road Sage keeps per trip, why it is its own setting, and
what the in-trip governor is allowed to do.

## Why `capture_fidelity` is not part of `experience_mode`

`experience_mode` is a **presentation** contract (`docs/ADVANCED_TRACKING_MODE_QA.md`).
If a cosmetic toggle also changed what landed on disk:

- trips recorded in Coaching Mode and Advanced Tracking Mode would stop being
  comparable, so score trends, trend series, and compare/replay would quietly go
  apples-to-oranges with no cause the user could see;
- extra storage would be consumed without a consent moment;
- a coaching user who wants better crash and lane-change evidence would be locked
  out of a safety feature by an aesthetic preference.

There is also no implementation saving from merging them: the Android service reads
`CapacitorStorage` / `drivesense_settings` directly, so any new key is readable from
Java with zero bridge work.

## The profiles

| Profile | Sample budget | Sampling interval | Event windows |
|---|---|---|---|
| `standard` (default) | 5000 | 100 ms | off |
| `high` | 15000 | 100 ms | on |

Mirrored in `src/lib/captureFidelity.js` (JS), `src/lib/appConstants.js` (shared
constants), and `android/app/src/main/java/com/drivesense/app/CaptureFidelityProfile.java`.

**GPS cadence is identical under every fidelity** (2000 ms / 1000 ms / 5 m). GPS
dominates battery, 1 Hz buys almost nothing over 0.5 Hz at the consumer-GPS noise
floor, and changing it is exactly what would break cross-setting comparability.

**The cost is storage, not battery.** The IMU is already registered at
`SENSOR_DELAY_GAME` (~50 Hz) for every trip in both modes and most of it is discarded
before storage. High fidelity mostly stops throwing data away.

Storage is bounded twice:

- by **sample count** (the budget above), and
- by **bytes** (`MAX_MOTION_BYTES_PER_TRIP`), computed from the size of a real
  serialized sample rather than from the same estimate that sized the count budget —
  a byte cap derived from that estimate could never bind and would be decorative.
  A count-only cap is how a device with little free space ends up with a 40 MB trip.

When `AppExperienceWatchdog`'s low-storage threshold is crossed, high fidelity drops
to the standard budget for the trip while keeping the user's chosen `fidelity` value,
so the downgrade is reportable rather than looking like the setting reverted.

## Retention

`motion_sample_retention_days` defaults to **14**, shorter than
`raw_gps_retention_days` (30), so the largest data ages out first. It rides the
existing sweep in `localTripRepository.enforceRawGpsRetention`, which now applies two
cutoffs in one pass. Expiring motion samples keeps every derived summary
(`sensor_fusion_summary`), so scores and forensics are unaffected.

## Buffer retention is decimation, not FIFO

`MotionSampleRetention.enforceBudget` thins the **oldest half** by dropping every
second sample when the budget is exceeded. The previous FIFO policy evicted the
oldest sample per append, so a 30-minute drive silently kept only its last ~8
minutes while everything downstream still read the buffer as "the trip's motion
data". Coverage now spans the whole drive; only the resolution of older stretches
degrades, in halvings.

`native_motion_samples_dropped` and `motion_capture_profile` are written to the trip
so forensics can state the trade rather than implying full-rate coverage.

## The low-power capture guard (`adaptive_capture_mode`)

A **protective governor, not an optimizer**. It only acts in states where the
realistic alternative is a dead phone or a thermally throttled service and a lost
trip — reduced fidelity beats no trip.

> **Invariant: NORMAL is the ceiling.** No tier may return an interval shorter than
> NORMAL's, and NORMAL's values are exactly today's values. The default path is
> therefore bit-identical to current behaviour.

| Tier | Trigger | GPS | IMU |
|---|---|---|---|
| `normal` | everything else | 2000/1000 ms (unchanged) | 100 ms (unchanged) |
| `thermal_guard` | thermal >= MODERATE | **unchanged** | 200 ms |
| `battery_guard` | <= 15%, not charging | 4000/2000 ms | 250 ms |
| `critical` | <= 5% not charging, or thermal >= SEVERE | 8000/4000 ms | suspended |

`thermal_guard` deliberately leaves GPS alone: device heat is dominated by CPU and
radio work, and dropping GPS is what actually breaks the product.

An unknown battery level (`-1`) means "unavailable", not "flat", and never triggers a
guard.

**Observability is not optional.** Every tier transition writes a `capture_tier_*`
entry to both the trip timeline and diagnostics, time-in-tier is accumulated into
`capture_tier_seconds` on the trip, and any non-normal time adds `capture_throttled`
to `data_quality_flags`. A throttle is reduced resolution, not missing data, so it
does **not** set `score_confidence_flag` — only a real permission gap does.
`buildSessionForensics` renders all of this as a plain-language row.

`adaptive_capture_mode: 'off'` is a full runtime kill switch reachable from Settings
with no app update.

## Tests

- `android/app/src/test/java/com/drivesense/app/CaptureFidelityProfileTest.java`
- `android/app/src/test/java/com/drivesense/app/CaptureTierPolicyTest.java` — includes
  the exhaustive monotonicity sweep that enforces the NORMAL-is-the-ceiling invariant
- `android/app/src/test/java/com/drivesense/app/MotionSampleRetentionTest.java` —
  whole-trip coverage after 3x budget overflow
- `src/lib/__tests__/captureFidelity.test.js`
- `src/lib/__tests__/trackingStoreDefaults.test.js` — defaults, enum sanitization,
  import ranges, and the v23 migration
- `src/lib/__tests__/trackingSessionForensics.test.js` — the user-facing rows

## Manual verification on device

1. Record a **>30 minute** drive. Forensics must report motion coverage across the
   whole trip, not just the tail.
2. Switch `capture_fidelity` to high, record, and confirm the retained sample count
   rises while GPS point spacing is unchanged.
3. Drop below 15% battery mid-drive. Confirm a `capture_tier_battery_guard` timeline
   entry, a `capture_throttled` data-quality flag, and that the trip still saves.
   Then set `adaptive_capture_mode: 'off'` and confirm intervals stay at NORMAL.
4. Install the new APK **over** the previous one. Old trips must open and show
   "source unavailable" for the new rows rather than crashing.
