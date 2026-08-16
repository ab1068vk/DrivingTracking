# Codex independent investigation notes

Identity: **OpenAI Codex** (`[CODEX]`). Investigation only; no production source has been modified.

## Evidence reviewed

- Both JSON exports in `agent-investigation/evidence/` and all eight screenshots.
- Baseline export: generated `2026-08-14T17:04:07.014Z`, current dataset empty, 1,554 retained performance samples, 1,649 activity events, 704 retained `browser_long_task` events.
- Exercised export: generated `2026-08-14T19:39:41.650Z`, 128 completed trips, 59,520 retained route points, 5,546,978 bytes of serialized summaries, 1,914 retained performance samples, 2,244 activity events, 1,072 retained `browser_long_task` events.
- Exercised recent-event window contains 218 Long Task API reports between 19:11 and 19:39. Median retained duration is about 249 ms; 22 exceed 1 second; maximum is 19,253 ms. Reports are rate-limited to one per five seconds, so the count is a lower bound.
- Native evidence says zero Android UI stalls/ANRs. Runtime snapshot is not consistent with memory exhaustion: Web heap ~46.1 MB of 256 MB, ~2.19 GB available system memory, PSS ~457 MB. Thermal status was moderate, not sufficient by itself to explain the architecture-specific scaling.
- Historical controlled device results in `docs/PHASE_0_INCIDENT_TRIAGE_RESULTS.md`: with 53 trips / 13,903 points, all summaries took 5,222.9 ms and “limited 50” summaries took 4,901.2 ms (only 6.2% less); Speed Limits full query took 19,380 ms while map section build/draw/fit were only 16/24/9 ms and the query remained ~19.8 s with maps disabled.

## High-confidence root cause 1: summary reads are full-history, per-record native crypto pipelines

The “limited” API is not limited at the storage boundary.

Call chain:

`page useQuery`
→ `limitedTripSummaryQueryOptions.queryFn` (`src/api/trips.js:193`)
→ `tripService.listSummaries` (`src/api/trips.js:55`)
→ `localTripRepository.listSummaries` (`src/lib/localTripRepository.js:2092`)
→ `importNativeCompletedTrips`
→ `getCurrentTripSummaries` (`:1464`)
→ `getAllTripSummaries` (`:571`)
→ IndexedDB `trip_summaries.getAll()` (`:583`)
→ `decodeTripSummaryRecords` / `decodeRecordsInOrder` (`:337-354`)
→ one `decryptSensitiveValue` per record
→ one `secureCall('SecureBridge', 'decryptSensitivePayload')` per record (`src/lib/securePayloadCrypto.js`)
→ the single global `bridgeCallQueue` (`src/lib/secureBridge.js`)
→ JS bridge-envelope AES/JSON, Capacitor bridge, Android bridge-envelope AES/JSON, Keystore payload AES, response AES/JSON
→ decrypt every N records
→ JS copy/sort of all N
→ only then `.slice(0, limit)` (`localTripRepository.js:2094`).

On Capacitor Android, all plugin calls are also posted to one `CapacitorPlugins` `HandlerThread` (`node_modules/@capacitor/android/.../Bridge.java:816-854`). This work is off the Android UI Looper, but it serializes native bridge service and adds queue latency. The JS secure-call queue serializes secure operations again and can delay active-trip/encrypted-settings work behind a history read.

This explains why the historical 53-trip limited query was nearly as slow as the all-history query. It also explains why UI pagination/virtualization and React memoization did not fix storage time.

The summary snapshot is not genuinely lightweight. `buildTripSummary` (`src/lib/tripSummary.js:6-58`) shallow-copies every field except nine named arrays. Notably, it retains `driving_events` and any other large nested derived structures not explicitly excluded. Evidence measures summaries at 5,546,978 bytes / 128 = ~43.3 KB per trip. The service then calls `buildTripSummary` again on already-built summaries.

Confidence: **confirmed architecture and confirmed scaling defect**. The exact split between IndexedDB read, bridge queue wait, WebCrypto, native Keystore crypto, JSON/base64, and suspension is not measured and must be instrumented before choosing batching details.

## High-confidence root cause 2: diagnostics persistence is synchronous main-thread workload

Three retained diagnostic streams repeatedly parse, sanitize, sort/copy, stringify, and synchronously rewrite their entire retained histories in `localStorage`.

1. `src/lib/performanceTriage.js`
   - Since commit `ef4adc2b` (2026-08-03), every measurement completion calls `persistEntry`.
   - `persistEntry` reads/parses/maps/filters up to 2,500 records, appends one, stringifies the entire array, and calls synchronous `localStorage.setItem` (`:84-106`).
   - Nested measures amplify it: query wrapper → service wrapper → app wrapper. An outer timing includes inner diagnostic persistence.
2. `src/lib/systemLog.js`
   - Global capture listeners log click, input, focus in/out, change, submit, key actions, clipboard actions, lifecycle, failures, etc. (`:521-564`).
   - Every 750 ms batch flush reads all stored logs, recursively checks/prunes, sorts and slices; `writeStoredLogs` prunes/sorts the same collection again, then stringifies and synchronously writes up to 2,500 entries (`:259-270`, `:114-142`).
   - Initialization calls `getSystemLogs()` before React render (`src/main.jsx:11`), which reads/prunes/rewrites the full history.
3. `src/lib/appExperienceDiagnostics.js`
   - Every system log also queues a historical experience event.
   - Its one-second flush parses/sanitizes up to 4,000 retained events and stringifies/rewrites the whole collection (`:437-489`).

The `browser_long_task` source is a real `PerformanceObserver({entryTypes:['longtask']})` (`systemLog.js:429-452`), not a delayed-timer guess. Thus the reported renderer tasks are genuine wall-clock long tasks. The five-second cadence is the observer’s explicit log rate limit while systematic interaction produces continuous work; it is not proof that the expensive task itself is a five-second timer.

The exercised run added 595 historical events and 368 retained Long Task reports while systematically interacting. Global interaction logging means the act of exercising the UI repeatedly triggers both whole-history log stores. A Long Task report itself adds another log and another historical-event flush, creating an amplification path (though the five-second limiter prevents a direct unbounded immediate loop).

Confidence: **confirmed that instrumentation performs repeated synchronous O(history) main-thread work and distorts outer measurements; strongly supported as a major jank amplifier**. The export cannot attribute individual long tasks, so a controlled on-device A/B (same retained histories, diagnostics persistence on/off) is required to quantify its share of the 80 ms–19 s tasks. Do not claim every 19 s Long Task is diagnostics without that A/B.

## Timing semantics: giant operation durations are wall-clock symptoms, not CPU profiles

`beginMeasure` uses `performance.now()` at start and when the returned end callback eventually runs (`performanceTriage.js:131-173`). `measureAsync` ends only after its awaited promise resolves (`:268-277`). Therefore the recorded 94–680 second durations can include:

- IndexedDB and serialized native-bridge latency;
- time waiting behind the JS secure queue, Capacitor plugin handler, milestone queue, or in-flight dedup promises;
- callbacks delayed by renderer long tasks;
- WebView/process suspension while the app is backgrounded;
- downstream milestone reconciliation and nested diagnostic persistence;
- overlapping operations measuring the same shared wait.

Large retained maxima are strikingly similar across nested/cascading operations (maintenance, native sync, summary query), which is consistent with shared waits or a suspension interval. It is not evidence that each named function independently consumed 10+ minutes of CPU.

The current good `app.coldBootstrap` p95 (~237 ms) is misleadingly scoped: bootstrap ends after settings/privacy setup schedules, but native sync is launched without awaiting and maintenance is deferred until 12 seconds of quiet (`src/App.jsx:268-324`). The expensive work is outside the cold-bootstrap timing.

Instrumentation also drops decisive fields. `sanitizeEntry` retains only a small fixed context; worker duration, queue time, phase timings, source, and operation-specific counts are discarded. `safeEventDetail` drops Long Task `start_time_ms`, leaving no source correlation in the export.

Dataset context is not reliable per sample. `setPerformanceTriageContext` is called only by the Diagnostics page (`src/pages/Diagnostics.jsx:316-326`), and its effect initially runs while the all-summary query still has the default empty array. That can persist `trip_count: 0` over a real populated dataset until the query resolves. In the exercised export, the 133.5-second limited query and 94.1-second all-summary query end with zero-trip/background-auto context even though the final profile contains 128 trips; earlier maintenance/listForSpeedMap samples contain 126-trip context. The p95 also combines up to 90 days of samples across sessions and code versions without retaining a build hash per entry. Consequently, neither latest context nor aggregate p95 can be used as a clean trip-count scaling curve.

## Confirmed duplicate/cascading work

### Native completed-trip polling on ordinary reads

Every `listSummaries`, `listAllSummaries`, `list`, `listForSpeedMap`, `listAllForExport`, `listAll`, and `getById` calls `importNativeCompletedTrips` first. It deduplicates only while one import is in flight; there is no freshness window or push signal.

Evidence: 268 `android_native_completed_trips_loaded` events versus 67 `native_completed_trips_synced` events. Roughly 201 native queue loads therefore came from repository reads or other non-explicit sync callers.

`DriveSenseActivityRecognitionPlugin.getNativeCompletedTrips` reads the journal once for trips and then calls status, which scans/decrypts it a second time (`DriveSenseActivityRecognitionPlugin.java:823-827`; `DriveSenseCompletedTripJournal.java:81`, `:254`, `:415-441`). The journal can hold 64 trips / 32 MB, with up to 8 MB per trip. This is currently cheap only when the recovery queue is empty.

`Layout` also polls `nativeAutoTrackingStatus` every five seconds whenever no JS active trip exists (`src/components/Layout.jsx:260-300`). That native method reads the full completed journal merely to obtain its count and calls journal status, scanning it again (`DriveSenseActivityRecognitionPlugin.java:660-681`). This is not proven to create JS Long Tasks because plugin work is off the Android UI/renderer thread, but it is a confirmed native queue/contention and battery scalability risk when completed trips are pending.

### Limited then all-history React Query duplication

Dashboard, Trips, Coach, Insights, Vehicles, and Achievements first request limited summaries and then enable the all-history query. Keys are distinct (`['trip-summaries','limited',limit]` versus `['trip-summaries']`), so this runs the same all-record storage/decrypt pipeline twice. At current repository semantics the “fast first result” query does not reduce I/O.

React Query’s shared all-summary cache and disabled focus refetch prevent some repetition, so page navigation alone is not a new database query every time. This is an important limit on the diagnosis: continuing Long Tasks on pages after the summary queries are cached must have another cause (diagnostic persistence, page derivation/rendering, garbage collection, or another recurring task).

### Boot/resume and milestone cascade

`syncNativeCompletedTripsAndMilestones({reconcileExisting:true})` is launched at boot and every Android `appStateChange` resume. Its global `milestoneSyncQueue` includes not just native import but `reconcileMilestoneNotifications`, which always calls `tripService.listAllSummaries` even when zero native trips were imported (`src/lib/milestoneNotificationCoordinator.js:20-137`). Thus `app.nativeTripSync` / `app.resume.nativeTripSync` largely measure downstream full-history milestone work and time queued behind earlier reconciliation; they do not isolate native-import latency.

Both Android `appStateChange` and document `visibilitychange` launch settings hydrate, privacy sweep, key rotation, road-context queue, and raw-GPS retention (`App.jsx:385-435`). Some functions self-deduplicate, but `scheduleIdleResumeTask` removes its pending name before the async task finishes (`:123-136`), allowing a second lifecycle signal during execution to overlap/queue another run.

### Trip completion can launch overlapping full-history speed rescoring

The post-save/import chain is broader than the measured summary query:

`tripService.create/upsertMany`
→ save encrypted full trip + summary
→ `synchronizeLocalRoadMemory(saved)` (`src/api/trips.js:135-163`)
→ if road-memory candidates changed, fire-and-forget `refreshTripsForLocalSpeedCorrections` (`src/lib/roadMemoryCoordinator.js:31-47`)
→ `tripService.listAll()` loads/decrypts every full trip (`src/lib/localSpeedScoreRefresh.js:172-180`)
→ scans route points against changed corrections
→ durable rescore queue
→ per affected trip: detail scoring plus `tripService.update`, which re-reads and re-encrypts the full record and summary.

Milestone notification reconciliation separately loads all summaries after the same save. Native imports start the same road-memory synchronization without awaiting it (`localTripRepository.js:1721-1731`). Therefore post-trip work can overlap foreground summary/detail queries while contending for the global secure bridge and Capacitor handler. Exercised activity evidence contains 11 `speed_knowledge_road_memory_learned` and 13 `speed_knowledge_trip_rescored` events. This does not prove those 13 jobs caused every long task, but it confirms the systematic exercise included background full-history/rescore activity rather than an isolated read benchmark.

The long-term fix should pass the newly changed candidate and use a spatial trip/geometry index to select affected trip IDs without loading every full trip. Rescore jobs need bounded batches, foreground-aware yielding, and one shared maintenance scheduler/priority policy so they cannot starve interactive detail reads or active-trip persistence.

## Maintenance and retained-point scaling

- `runTripRepositoryMaintenance` runs migration, native import, full-trip retention, raw-GPS retention, event migration, then summaries (`localTripRepository.js:2049-2063`).
- `migrateLegacyTripStorageToEncrypted` performs `TRIP_STORE.getAll()` on every maintenance run merely to find unencrypted records (`:607-654`). Even when every record is already encrypted, IndexedDB must materialize/structured-clone every full ciphertext envelope into JavaScript. This is O(total encrypted trip bytes) before retention begins and can create a large allocation/clone task without performing any useful migration.
- `enforceTripDataRetention` decrypts every full trip whenever `data_retention_days` is nonzero, even when nothing can have expired (`:1829-1859`). Default is 365 days. It has no next-expiration watermark and no index-only cutoff query.
- Raw-GPS/motion retention is guarded to approximately daily, but when due it loads/decrypts every full trip and scans/copies retained collections, so its cost is O(total trips + total points/samples).
- Summary refresh detects any stale summary, then loads/decrypts all full trips and rescoring is synchronous per route before batch writes (`getCurrentTripSummaries`, `rescoreTripsIfNeeded`).
- Key rotation is necessary but rotates all full records and all summary records one-by-one with decrypt + encrypt per record (`localTripRepository.js:657-721`). It can monopolize the global secure queue for a long time at thousands of trips. The manager does have durable `pendingVersion` state and re-entry skips already-rotated records, so crash-level resumability exists; the missing piece is a bounded per-run time/record budget that yields the queue back to foreground work instead of attempting every remaining record in one invocation.

The record envelopes already expose `start_time` and `status` and the stores already have indices for both (`localTripRepository.js:207-224`), but ordinary summary listing and retention do not use them. Future records should also expose non-sensitive schema/key-version metadata so migrations and rotation inspection can scan keys/metadata without cloning full ciphertext payloads.

These are separate background scaling problems even if they are not responsible for every current foreground long task.

## Speed/map findings

- Current Speed Limits architecture uses selected-trip paging, a compact geometry index, and a worker. Historical device evidence rules Leaflet rendering out as the dominant 19-second cost: the storage query stayed slow with maps disabled and section/draw/fit timings were small.
- `SpeedLimits.buildMapModel` brackets the entire worker request/response, so its 26.5-second retained value is an async wall-clock span, not worker CPU. The custom `workerDurationMs` detail is discarded by `sanitizeEntry`. Structured-cloning full selected trips into and sections out of the worker is not separately timed.
- `listForSpeedMap` still decrypts every summary on every page, then decrypts selected full trips by id (`localTripRepository.js:2111-2131`).
- `rebuildSpeedGeometryIndex` pages up to 5,000 trips in batches of 80, but each batch repeats the all-summary scan/decrypt. This makes the summary portion O(N * ceil(N/B)), effectively superlinear. It then stores up to 800,000 compact points as one encrypted JSON value, so read/write/JSON/bridge payloads become very large.
- Road-memory history backfill (up to 800 in batches of 80) repeats the same all-summary scan each batch before route processing.

## Summary-shape and downstream UI risk

At 43.3 KB per summary, approximate aggregate summary payload is:

- 100 trips: ~4.3 MB
- 500 trips: ~21.7 MB
- 1,000 trips: ~43.3 MB
- 3,000 trips: ~130 MB

Those are rough linear projections from the evidence’s 128-trip shape, not measured storage ciphertext sizes. Repeatedly copying, decrypting, JSON-parsing, React-caching, filtering and sorting those objects is unsustainable. A true projection DTO should contain stable scalar/card/analytics fields and aggregate event counts; detail-only event arrays/evidence must be fetched by trip id. Consumers already accept `driving_events_count` / `event_count` fallbacks in several tracking/map components, showing an incremental migration path, but every summary consumer must be audited before removing arrays.

The consumer audit also shows that compacting summaries cannot be a blind field deletion. `DrivingCoach` and `mediumInsights` build danger zones from historical event coordinates (`src/pages/DrivingCoach.jsx:489-492`; `src/lib/dangerZoneEngine.js:105, 180`), `advancedInsightIntelligence` flattens historical events, and coaching/progression code falls back to inspecting event arrays (`src/lib/advancedInsightIntelligence.js:241`; `src/lib/coachPrograms.js:168-169, 745`; `src/lib/driverProgression.js:105-106`). Scalar totals are sufficient for most cards, but spatial/event analytics need a separate compact, indexed event projection or incremental aggregate; they must not force every ordinary trip summary to carry full event objects forever. Selected trip/map/replay views already have detail-query patterns and should continue fetching the full trip by id.

## Active-trip persistence scaling and queue contention

The live tracking path contains an independent retained-point scalability defect. For every accepted foreground GPS point, `Dashboard` constructs `routePointsWithLatest = [...existingPoints, newPoint]`, builds a new trip, and calls `activeTripStore.set` (`src/pages/Dashboard.jsx:1227-1247`). `activeTripStore.set` sanitizes the full trip snapshot and queues `setEncryptedJson` (`src/lib/trackingStore.js:1861-1875`). That path `JSON.stringify`s the entire growing trip, calls Android `SecureBridge.encryptSensitivePayload`, and writes the complete encrypted value (`src/lib/securePayloadCrypto.js:148-178, 232-236`). If privacy zones are configured, sanitization additionally maps every route point and checks/filter-counts the complete route on each checkpoint (`src/lib/privacyZones.js:1513-1591`).

Consequently, a P-point trip does O(1 + 2 + ... + P) route copying/serialization/encryption input, i.e. cumulative O(P^2) bytes/work, and enqueues a complete snapshot for every point even if earlier snapshots are already obsolete. The snapshot writes use the same global `secureCall` queue as historical summary/detail reads, so a long history job can delay crash-recovery checkpoints and a long trip can delay interactive secure operations. The code-level scaling defect and contention path are confirmed; the evidence export does not isolate its current wall-time contribution, so device tests must capture point cadence, snapshot bytes, coalesced/dropped stale writes, queue wait, encrypt time, and flush durability. The long-term design should use an append-only/chunked encrypted active-route journal plus compact current metadata, coalesce obsolete metadata snapshots, and compact/finalize once at trip completion without weakening crash recovery.

## Why prior attempts did not hold

- They improved rendering, map construction, UI virtualization, deferred work, and added “limited” queries.
- The storage implementation still performs `getAll` + N serialized bridge decryptions before applying the limit, so UI limits did not change the dominant I/O.
- Limited and all-history queries became two separate passes.
- New persistent performance history added another O(history) synchronous rewrite per measured operation.
- The system-log page was virtualized, but the underlying global logging/persistence still rewrites complete histories.
- Deferring maintenance makes cold-bootstrap metrics look good while the same work runs later and contends with interaction.
- Aggregate wall-clock timers were interpreted like function CPU profiles even though they include queues, downstream work, and possible suspension.

## Proposed architectural direction (not implementation yet)

1. First add causal phase instrumentation with negligible overhead: monotonic active-session ID, lifecycle suspend/resume markers, queue wait versus native call versus decrypt/parse versus IDB versus render/worker phases, Long Task attribution, and asynchronous/chunked diagnostic persistence. Preserve raw phase data in exports.
2. Make summary query boundaries real. Use an IndexedDB schema that stores queryable/sortable projection fields and a compact encrypted projection payload; query the `start_time` index with cursor direction/limit/offset or keyset pagination. Do not `getAll`, decrypt all, sort all, then slice.
3. Add Android batch decrypt/encrypt (or another safe amortized native crypto design) so one query does not require N JavaScript↔native round trips. Keep at-rest encryption and data integrity. Instrument before deciding batch size and memory bounds.
4. Separate native recovery ingestion from reads. Sync on boot/resume/native completion signal with a freshness/generation token; ordinary repository reads must not poll the native journal. Make native status return manifest metadata/count without decrypting full trip bodies; avoid double scans.
5. Use one canonical summary cache/query supporting limited windows and incrementally loaded history, rather than separate limited/all pipelines. Preserve explicit full-history analytics as background/incremental aggregation or an intentional user action.
6. Replace diagnostic localStorage whole-history rewrites with bounded append/chunk stores (IndexedDB or segmented ring buffers), buffered writes outside user interaction, no global logging of every focus/input action, and a recursion guard so diagnostic work cannot generate more diagnostic persistence. Diagnostics remain enabled and truthful.
7. Give maintenance a persisted schedule/watermark and index-driven scope. Run retention only when the earliest eligible expiry can exist; chunk/resume full-record migrations, raw-point retention, key rotation, and rescoring with cancellation/foreground yielding.
8. Fix speed-geometry and road-memory pagination so summary selection is done once and batches fetch only detail IDs; store geometry in bounded chunks rather than one giant encrypted blob.
9. Change milestone reconciliation to incremental state updated on the newly completed trip; reserve full rebuild for migration/repair, not every boot/resume.

## Required proof before production rollout

- Controlled physical-Android A/B using identical data and retained diagnostic histories:
  - diagnostics persistence on/off (collection can remain on) to quantify jank contribution;
  - Layout five-second native status polling isolated/on/off, especially with a large pending native journal;
  - foreground-only versus background/resume during a measured query to validate suspension inflation.
- Phase timings and call counts for 0/100/500/1,000/3,000 trips; route shapes at small, p50, p95 (~3,659 points), and large retained routes.
- Assert limited-50 storage work is bounded by ~50 projection decrypts/records and is independent of total N; assert no native completed-journal call occurs from a normal cached repository read.
- Assert speed-geometry backfill decrypts summaries once (or uses index-only records) and full trip details exactly once each, not once per batch plus repeated all-history scans.
- Long-task acceptance on representative device: no app-authored task >200 ms during ordinary navigation; p95 app-authored task <50 ms; zero >1 s tasks. Separate browser/GC unknowns from attributed app work.
- Bootstrap/resume acceptance must distinguish UI-ready latency from background completion and verify no duplicate jobs or active-trip write starvation.
- Active tracking at p95/large route shape must persist O(1) new checkpoint bytes per point (not a full prefix), keep secure-queue backlog bounded, recover every acknowledged checkpoint after process kill, and show no growth in per-point checkpoint latency as the route grows.
- Diagnostics-on versus collection-with-persistence-disabled must keep ordinary-navigation Long Task count/duration within 10%; diagnostic record/flush slices should remain below 10 ms p95 and must not create recursive diagnostic records.
- On a representative mid-tier Android target, limited-50 cold query p95 should be <=750 ms and p99 <=1.5 s at 3,000 trips; its record/byte/decrypt/bridge-call counts must be invariant (within a small fixed metadata constant) from 100 to 3,000 trips. Treat these as proposed release gates to calibrate against the first low-overhead phase benchmark, not as claims about current hardware.
- Native status should read bounded manifest metadata and complete p95 <=50 ms with the journal at its 64-trip cap; ordinary summary/detail reads must issue zero native recovery-journal calls.
- Data integrity tests for interrupted migration, key rotation, native import/ack, concurrent edit/rescore, privacy redaction, deletion, backup/export, and rollback/upgrade.

## Unknowns / hypotheses that must not be promoted to fact

- Exact share of current renderer Long Tasks caused by diagnostic persistence versus page computations/GC.
- Exact phase responsible for current 94–133 second summary queries (bridge queue, crypto, payload JSON, native handler contention, suspension, or a mix).
- Whether any of the 14–19 second Long Task entries include renderer/process suspension; Long Task API durations are genuine wall-clock task durations but do not provide source attribution in this export.
- Whether the five-second native status poll materially affects the current empty recovery queue. Its scalability defect with a populated journal is confirmed; its current contribution is not.
- Field-level breakdown of the 5.55 MB summary aggregate. `driving_events` retention is confirmed in code, but the export does not include private field sizes. Add local privacy-safe per-field byte counters.

## Stage 3 review of Claude's independent findings

Claude independently confirmed the unbounded summary/decryption path, lack of a persistent repository cache or native batch decrypt, denylist summary shape, native-read coupling, diagnostic write amplification, invalid performance context, and baseline export loading-gate artifact. Claude added an important renderer phase: `secureBridge.performSecureCall` performs request/response JSON, nested base64, and `Uint8Array.from(binary, callback)` on the WebView main thread. A local desktop V8 sanity check (not device evidence) showed this conversion grows linearly—about 9 ms at 44 KiB, 69 ms at 1 MiB, 300 ms at 5 MiB and 1.28 s at 20 MiB—so on Android it can plainly create Long Tasks and must be replaced/bounded and measured.

I do not accept as confirmed Claude's attribution of all nine 13.6–19.3 second tasks to that conversion. Summaries are individual ~43 KiB-average records, Capacitor posts each native response back to the WebView, and each next call crosses asynchronous crypto/native boundaries. A single huge speed/route/index payload, an outlier summary, or allocation/GC could explain a long contiguous task, but the export contains no method or payload bytes. Native-load events are variably 13–82 seconds before inferred task starts and are not causal attribution. The uniform ~249 ms population also fits both diagnostic whole-history work and global per-record bridge conversions. Both population assignments remain strongly supported hypotheses until correlated phase/payload tracing and a saturated diagnostic persistence A/B run.

The final architecture must therefore solve both confirmed sources without relying on the disputed attribution: compact/bounded projection payloads and bridge batches eliminate the known sync conversion risk, while append/chunk diagnostic persistence eliminates the known telemetry rewrite/feedback risk. This disagreement affects only confidence wording and the order of proof, not whether either defect should be fixed.

## Initial Codex conclusion

There are at least two independent primary problems: (1) unbounded full-history reads implemented as N serialized cross-bridge crypto calls and oversized projections, producing severe async/query latency that grows with history; and (2) diagnostics implemented as synchronous repeated whole-history localStorage work, producing or amplifying genuine renderer jank and contaminating outer timings. Native polling, duplicated limited/all queries, full-history milestone reconciliation, unconditional retention scans, lifecycle overlap, and superlinear speed/backfill paging compound the problem. Maps themselves are not the primary root cause supported by current evidence.
# P0 challenge review (2026-08-14)

Claude's initial `# P0 EXECUTION PLAN` is a strong structure, but Codex cannot approve it yet. Required
corrections are recorded in `SHARED_INVESTIGATION.md`; the decisive issues are byte-count correctness,
raw per-phase intervals, native-vs-bridge partitioning, lifecycle/dual-clock semantics, a clean persistence
A/B, externally measured probe-off overhead, and the agreed multi-size saturated/empty device matrix.
