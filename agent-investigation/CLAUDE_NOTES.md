# CLAUDE_NOTES — independent investigation (2026-08-14)

Agent: **Claude Code**. Stage 1 was done before reading `CODEX_NOTES.md` / `SHARED_INVESTIGATION.md`
(both were empty at the time). Codex's Stage 2 post was read afterwards, and Stage 3 challenge work is
recorded at the end.

---

## 1. Evidence extraction

### 1.1 Operation table (both exports)

The top of the "slow operations" list is identical in both files, because the maxima are the same
persisted historical entries (90-day retention, `TRIAGE_RETENTION_MS`):

| operation | count | p50 | p95 | max | latest |
|---|---|---|---|---|---|
| `app.bootstrap.tripRepositoryMaintenance` | 15 | 71,100 | 668,593 | 668,593 | 260,599 |
| `limitedTripSummaryQueryOptions.queryFn` | 34 | 90,174 | 588,810 | 673,561 | 133,503 |
| `app.resume.nativeTripSync` | 39 | 624 | 586,259 | 655,147 | 326 |
| `app.nativeTripSync` | 67 | 398 | 586,243 | 680,824 | 316 |
| `tripService.listSummaries` | 41 | 86,655 | 578,534 | 673,358 | 133,470 |
| `tripService.listAllSummaries` | 33 | 67,321 | 549,691 | 633,819 | 94,094 |
| `tripSummaryQueryOptions.queryFn` | 18 | 55,081 | 514,755 | 514,755 | 94,122 |
| `tripService.listForSpeedMap` | 4 | 99,826 | 469,224 | 469,224 | 446,093 |
| `app.coldBootstrap` | 32 | 155 | **237** | **314** | 168 |
| `buildSpeedMapSections` | 48 | 0 | **787** | **863** | 0 |
| `TripMap.layerDraw` | 492 | 6 | 233 | 473 | 240 |

Two internal contradictions worth more than the raw numbers:

- `SpeedLimits.buildMapModel` = **26,526 ms** while `buildSpeedMapSections` — the function it wraps —
  is p95 787 ms / max 863 ms. **30× gap between a wrapper and its own inner measurement.**
- `app.coldBootstrap` p95 237 ms while `app.bootstrap.tripRepositoryMaintenance` p50 = 71,100 ms.
  (Caveat Codex is right about: `coldBootstrap` ends before the deferred work, so its good p95 does not
  by itself clear bootstrap architecture — it only shows the two are measuring different things.)

The six largest maxima cluster at **633,819–680,824 ms** — a ~47 s spread of start times all ending in
the same window. That is the signature of many pending promises resolving together, not of six
independent CPU-bound operations.

### 1.2 Long tasks — this is the real user-visible signal

`browser_long_task` is the #1 recorded operation in both exports (1,072 exercised / 704 baseline),
**despite a hard 5 s throttle** (`systemLog.js:lastLongTaskLogAt`). So long tasks occurred in ≥1,072
distinct 5-second windows. In the retained 300-event window (1,690 s, 218 sampled long tasks):
**~250 s blocked ≈ 15% of wall time.**

Per page (n / total blocked / max): /vehicles 33 / 42.9 s / 16.8 s · /coach 26 / 25.9 s / 19.2 s ·
/insights 19 / 29.5 s / 13.9 s · /tracking/replay 18 / 18.5 s / 14.0 s · /tracking/alerts 15 / 24.3 s /
19.3 s · /tracking/privacy 10 / 19.9 s / 17.3 s · /system-logs 7 / 15.4 s / 14.1 s.

**Key structural finding: the long tasks are two distinct populations, not one.**

| population | signature | spread |
|---|---|---|
| A — baseline drumbeat | **p50 249 ms on analytics-heavy pages, p50 248 ms on all other pages** | uniform across every route |
| B — the freezes | 9 tasks in a tight **13.6–19.3 s** band | on 9 *different* pages |

Population A being page-invariant to within 1 ms says it is driven by something global, not by page
content. Population B's magnitude being roughly constant across `/coach`, `/vehicles`, `/insights`,
`/3d-replay`, `/system-logs`, `/tracking`, `/tracking/replay`, `/tracking/alerts`, `/tracking/privacy`
says the same — **it is not per-page analytics cost**, which would vary with the page's workload.
This falsifies my own first hypothesis (see §4).

Time-ordering population B against other events: each large task is preceded 33–60 s earlier by an
`android_native_completed_trips_loaded`, and long-task timestamps are recorded at task *end*, so a
19 s task at t=1417 started at t≈1398 — around the navigation into that page. Every page runs a trip
summary query on mount.

### 1.3 The baseline export is a measurement artifact — do not trust its `data` section

`baseline/…json` reports `data.trip_count: 0`, `anonymous_trip_shapes: []`, `approximate_summary_bytes: 0`
— on a device that had 128 trips. Proof it is an artifact, not an empty store:

- `runtime.last_operation = {operation: "tripService.listAllSummaries", phase: "start", timestamp:
  "2026-08-14T17:04:06.979Z"}` versus `generated_at: "2026-08-14T17:04:07.014Z"` — **35 ms apart.**
  The report was built while its own trip query was still in flight.
- `Diagnostics.jsx:420` passes `trips={allTripSummaries}`, which defaults to `[]`
  (`Diagnostics.jsx:209`), into `AppExperienceDiagnosticsPanel.jsx:122` with no loading gate.
- The exercised export 2.5 h later shows `trip_ended: 6` — six trips ended in that window, not 122.

`health.score` and `health.headline` are derived from that empty dataset. Anyone reading the baseline
as "slow even with zero trips" is reading an artifact. **I initially made exactly this mistake and
discarded the conclusion once I found the 35 ms gap.**

---

## 2. Source traces

### 2.1 Telemetry write amplification — three read-modify-write stores on the main thread

| store | trigger | work per trigger |
|---|---|---|
| `performanceTriage.persistEntry:99` | **every** `beginMeasure` end | `JSON.parse` ≤2,500 → `sanitizeEntry` each (2 `new Date()` per entry) → filter → append → `JSON.stringify` → `localStorage.setItem` |
| `systemLog.flushPendingLogs:259` | 750 ms after **any** logged event | parse ≤2,500 → `pruneExpiredSystemLogs` **twice** (directly, then again inside `writeStoredLogs:104`) → each does a recursive `containsPrivacyLogMetadata` walk per event **plus an O(n log n) sort with two `new Date()` per comparison** (~110k Date allocations/flush) → stringify → setItem |
| `appExperienceDiagnostics.flushHistoricalAppExperienceEvents:457` | 1 s timer | parse ≤4,000 → recursive `safeEventDetail` re-sanitize per event + 3 `new Date()` each → stringify → setItem |

Triggers for store 2 include `click`/`input`/`change`/`focusin`/`focusout`/`keydown`
(`systemLog.js:531-546`) — **every keystroke in a form schedules a full-history rewrite.** Note
`appExperienceDiagnostics.js:491` already excludes `user_*` operations from the *cheap* store; the
expensive store has no such exclusion.

Feedback loop: long task → `recordSystemLog('browser_long_task')` → both flushes → long task.

`getSystemLogs()` (`systemLog.js:336`) prunes **and rewrites** on every call. Its callers:
`SystemLogs.jsx:127` (on a `SYSTEM_LOG_EVENT` listener **and** a 5 s interval, `:371-380`),
`TrackingAlertsLab.jsx:104`, `TrackingReportsLab.jsx:55`.

**Growth law: O(retained diagnostics entries)**, capped 2500/2500/4000 — caps fill within hours, so the
cost sits permanently at maximum and does **not** scale with trips.

### 2.2 Trip read path

- `getCurrentTripSummaries` (`localTripRepository.js:1464`) has **in-flight dedupe only** — the promise
  is cleared in `.finally`, so there is no cross-call cache. Every read re-decrypts everything.
- `listSummaries({limit})` (`:2092`) → `getCurrentTripSummaries()` → `sortTrips(...).slice(0, limit)`.
  **The limit never reaches storage.** Evidence: `limitedTripSummaryQueryOptions.queryFn` p95 588,810 ms
  vs `tripSummaryQueryOptions.queryFn` p95 514,755 ms — the "limited" query is not cheaper.
- `decodeRecordsInOrder` (`:333`) awaits `yieldToEventLoop()` = `setTimeout(resolve, 0)` (`:167`) every
  **4 records**. 128 trips → 32 macrotasks; 1,000 → 250; 5,000 → 1,250. `setTimeout` is throttled to
  1/s when hidden and 1/min after 5 min hidden.
- Every read path opens with `await importNativeCompletedTrips()` (`:2093, 2098, 2103, 2112, 2136,
  2150, 2159`). Evidence: `android_native_completed_trips_loaded` 268 vs `native_completed_trips_synced`
  67. Each also emits a system event, feeding §2.1.
- `getAllTripSummaries` (`:571`) falls back to a full `getAllTrips()` — decrypt + privacy-sanitize every
  route point of every trip, then rewrite all summaries — whenever `liveSummaries.length !== tripCount`.
- `runTripRepositoryMaintenance` (`:2049`) chains up to four full-store passes.
- `rescoreTripsIfNeeded` (`:1433`) rescores in a fully synchronous loop **with no yield at all**,
  dispatching `RESCORE_PROGRESS_EVENT` per trip into a `setState` in `Layout.jsx:315-330`.

### 2.3 `buildTripSummary` is a denylist, not an allowlist

`tripSummary.js:41-47` copies **every** field except the nine in `DETAIL_ONLY_FIELDS`. Retained
therefore: `driving_events`, `score_provenance` (with `constants_snapshot` and `components`),
`tag_candidates`, `tag_sources`, `sensor_fusion_summary`, `weather_context`, … Export says 5,546,978
bytes / 128 trips = **43.3 KB per "lightweight" summary**.

### 2.4 Page-level analytics

Twelve pages call `tripSummaryQueryOptions()` (entire history). Five (`Dashboard`, `Insights`,
`Vehicles`, `DrivingCoach`, `Achievements`) fetch `limitedTripSummaryQueryOptions(50|100)` *and then*
the full history — which per §2.2 costs the same, so it is **two full decodes for zero benefit**.
`Insights.jsx` computes `buildAdvancedInsights` twice (`:83` and `:102`).

### 2.5 Instrumentation defects

- **I-1** `setPerformanceTriageContext` is called from exactly one place (`Diagnostics.jsx:317`), and on
  first render `allTripSummaries` is `[]`, so `{trip_count: 0, …}` is persisted to
  `roadsage_performance_context_v1` and then stamped on **every measurement app-wide**. Both exports
  show `latestContext.trip_count: 0` on every operation. **No valid dataset-size signal exists on any
  sample.** (Codex found this independently — agreed.)
- **I-2** the export has no loading gate (§1.3).
- **I-3** nested double-reporting: `limitedTripSummaryQueryOptions.queryFn` wraps
  `tripService.listSummaries`, which wraps its own `measureAsync`. One execution appears as two "slow
  operations" (673,561 vs 673,358 ms), inflating `slow_operation_count`.
- **I-4** `emitPerformanceCheckpoint` fires on **both start and end** of every measure
  (`performanceTriage.js:134, 159`); `nativeAppExperienceWatchdog.js:26-35` forwards each to a Capacitor
  bridge call → `AppExperienceWatchdog.recordOperationCheckpoint:165` → SharedPreferences write.
- **I-5** the export is aggregates only — no per-entry timestamps, outcome breakdown, foreground flag,
  or CPU-vs-wall split. Nothing in the artifact separates 600 s of suspension from 600 s of CPU.

---

## 3. Stage 3 — responses to Codex's challenges

### (a) "Falsify diagnostics persistence as the jank source rather than merely a contributor"

**Partially falsified — and this is the most useful thing I found.** The two-population split (§1.2)
shows diagnostics persistence cannot be the whole story:

- Population A (p50 ~249 ms, identical on analytics-heavy and non-analytics pages to within 1 ms) fits
  §2.1 well: page-invariant, periodic, bounded by store size.
- Population B (13.6–19.3 s, nine occurrences across nine unrelated pages) does **not** fit. A
  `localStorage` rewrite of ≤4,000 entries is a low-hundreds-of-ms operation, not 19 s. Neither
  Codex's original framing nor mine accounted for a *contiguous* 19 s renderer task.

**I found the mechanism that does.** `secureBridge.performSecureCall:104-145` runs, synchronously on
the renderer main thread, per call:

1. `JSON.stringify(data)` (request)
2. `bytesToBase64(...)` — `String.fromCharCode(...bytes.subarray(i, i+0x8000))`, spreading up to 32,768
   arguments per chunk plus string concatenation
3. `base64ToBytes(result.data)` — `atob()` then **`Uint8Array.from(binary, character =>
   character.charCodeAt(0))`, a per-character JS callback over the entire payload**
4. `JSON.parse(...)` (response)

Step 3 is the pathological one: a megamorphic per-character callback over a multi-MB string is seconds
of contiguous, unyieldable main-thread time. Payloads that reach that size include the speed geometry
index (Codex: "one potentially huge encrypted JSON value") and the active-trip route snapshot (Codex's
O(P²) finding). This is page-independent, scales with payload size, and produces exactly the
*contiguous* multi-second task shape that population B shows.

Note also the payload is **double-encrypted**: already AES-GCM at rest via `decryptSensitivePayload`,
then the whole request/response is AES-GCM encrypted again for transport — so each record costs
~6 crypto operations plus two full base64 conversions plus two JSON traversals.

**Conclusion: diagnostics persistence is confirmed as the driver of population A, and is not
sufficient for population B.** I would not rank them until the A/B experiment runs.

> **Correction (after Codex's Stage 3 review) — the conclusion above is too strong.** Codex is right that
> ordinary summaries are ~43 KB *separate* records and Capacitor returns each response as its own
> posted-message/evaluate-JS task, so N per-record conversions yield N smaller tasks and **do not combine
> into one contiguous 19 s task**. The defensible claim is only that `performSecureCall` carries a real,
> payload-linear **synchronous renderer** cost that nobody had accounted for, and that this is a candidate
> for population B *only* where a single oversized payload is involved — which the export cannot confirm,
> since it records no payload, method or active route at those timestamps. Population A also fits repeated
> global secure conversions as well as it fits diagnostics. Both assignments are now held at **strongly
> supported hypothesis**, pending the instrumented discriminator. Other live hypotheses for population B:
> one oversized summary; allocation/GC after repeated decodes; prune/sort on pathological entries;
> renderer descheduling/suspension mid-task.

### (b) "Falsify serialized per-record secure bridge calls as the dominant summary-query phase"

**Could not falsify — confirmed, and it is stronger than Codex stated.**
`secureBridge.js:149-153`: `secureCall` chains every call onto a single module-level
`bridgeCallQueue` promise. This is a **global, app-wide, strictly serial queue** — not per-plugin.
`securePayloadCrypto.js:194-203` routes `decryptSensitiveValue` through it on Android.

Consequences Codex did not spell out and I think matter for the fix:

- The queue is shared with settings persistence, preferences, and active-trip checkpointing. During
  recording, Codex's O(P²) full-route encrypt-per-GPS-point sits on the **same** queue that an
  interactive summary read must wait behind. That is a concrete starvation path, and it explains why
  the app feels worst during/after driving.
- Because each call also carries the synchronous work in (a), the queue is not merely *latency* — it
  serializes O(payload) main-thread work too.

**On "another recurring foreground synchronous task explaining the rate-limited Long Task stream":**
population A is explained by §2.1; population B by (a) above. I did **not** find a third recurring
synchronous source.

**On "any cache/index/native batch path that avoids N decrypts":** I looked and found **none**.
`getCurrentTripSummaries` caches only in-flight (§2.2); `TRIP_SUMMARY_STORE` still stores one encrypted
envelope per record; `getStoredTripsByIds:1193` parallelises the IDB `get`s but then funnels through
the same serial `decodeTripRecords`. There is no batch decrypt API on `SecureBridge`. Codex's
conclusion stands unchallenged.

### (c) "Challenge whether `driving_events` is the dominant 43 KB summary field"

**Codex's uncertainty is justified, and I could not resolve it from the artifact either** — the export
gives only `approximate_summary_bytes` in aggregate, and no field-level breakdown exists anywhere in
the evidence. What I can add: `buildTripSummary` is a **denylist** (§2.3), so `driving_events` is only
one of several unbounded retained fields — `score_provenance.constants_snapshot`, `tag_candidates`,
`tag_sources` and `sensor_fusion_summary` are all retained too.

**But the ranking is not decision-relevant.** Switching `DETAIL_ONLY_FIELDS` to an explicit allowlist
bounds the summary regardless of which field dominates, and is the same amount of work either way. I'd
propose we stop trying to rank and just invert the list — while adding a field-size histogram to the
export so the question is answerable next time.

---

## 4. Hypotheses I ruled out (so Codex does not re-walk them)

- **"Long tasks are page-specific analytics cost."** My own first hypothesis. Falsified by §1.2:
  population B has near-constant magnitude across nine pages with very different analytics workloads,
  and population A's p50 is identical (249 vs 248 ms) on analytics-heavy vs other pages. §2.4 is still
  a real O(trips) scaling defect — it just is not what produces the freezes.
- **"Slow even with zero trips."** Falsified by §1.3 — the baseline's `trip_count: 0` is a loading-gate
  artifact.
- **React Query refetch storms on resume.** Ruled out: `refetchOnWindowFocus: false` in
  `src/lib/query-client.js`.
- **Map rendering.** Ruled out, agreeing with Codex: `TripMap.layerDraw` p95 233 ms / max 473 ms over
  492 samples, `TripMap.polylineCreationLoop` max 99 ms, `buildSpeedMapSections` max 863 ms.
  `SpeedLimits` already offloads to a worker (`SpeedLimits.jsx:1374-1399`).
- **`useLocalSettings` re-render storms.** Ruled out: `useLocalSettings.jsx` uses
  `useSyncExternalStore` with serialized-snapshot equality; correctly memoized.
- **Prior fixes as causes.** Commits `94587198` (memoize Trip Detail speed builders) and `9b46dc06`
  (virtualize review list) touch neither population. Consistent with them not having helped.

---

## 5. What I think is still unproven

1. Whether population B is the base64/`Uint8Array.from` path (§3a) or something else — **open, and my
   initial attribution was withdrawn** (see the correction in §3a). Codex's rebuttal that N separate
   records cannot form one contiguous task is correct. **Experiment (Codex's, agreed):** instrument each
   `performSecureCall` with method, plaintext/ciphertext byte counts, separated synchronous JSON/base64
   phases, queue wait, WebCrypto wait, native wait, lifecycle span, and a correlation ID visible to the
   Long Task observer; preserve raw start times. A monotonic payload-size/synchronous-duration
   correlation whose intervals overlap the Long Tasks confirms it. Competing hypotheses to discriminate
   against: one oversized summary; allocation/GC after repeated decodes; prune/sort on pathological
   entries; renderer descheduling/suspension mid-task.
2. Relative contribution of §2.1 vs §2.2 to total blocking. **Experiment:** Codex's proposed
   same-device A/B with diagnostics persistence disabled — I agree this is the right test, and it must
   run with a saturated telemetry store (2,500/2,500/4,000), not an empty one.
3. Whether the 600 s durations survive once hidden time is excluded. **Experiment:** foreground-only
   wall clock + `spanned_hide` flag per entry.
4. Field-level summary size breakdown (§3c).
