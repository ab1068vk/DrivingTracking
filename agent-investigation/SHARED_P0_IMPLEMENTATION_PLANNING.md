# P0 IMPLEMENTATION PLANNING

Authoritative implementation handoff for the jointly approved P0 Revision 3 in
`agent-investigation/SHARED_INVESTIGATION.md`. The investigation archive is historical/read-only. This
file contains only the final approved P0 contract; it does not reopen root-cause conclusions or reproduce
the earlier debate.

## 1. Purpose and scope

P0 adds trustworthy, low-perturbation causal instrumentation and runs the discriminator experiment. It
must determine:

- secure-bridge queue wait versus synchronous renderer work;
- transport and logical-payload JSON/base64 cost;
- WebCrypto invocation versus awaited latency;
- Capacitor invocation, native dispatch, native execution, and response-delivery latency;
- foreground work versus background/suspension time;
- synchronous diagnostics-persistence cost;
- exact overlap between app-authored synchronous phases and Long Tasks;
- whether P1 (diagnostics storage) or P2 (secure path) should be implemented first.

P0 does not optimize these paths. It must ship and be measured alone before P1/P2 work begins.

## 2. Governing constraints

- No caching, batching, projection, pagination, codec replacement, diagnostics-store rewrite, scheduling
  change, lifecycle deduplication, native-sync redesign, or job-coordinator work in P0.
- Do not change encryption, AAD, nonce/replay handling, session/key derivation, key rotation, call order,
  privacy masking, diagnostic redaction/retention, native recovery/acknowledgement, backups, or trip data.
- P0 trace data lives only in bounded in-memory circular buffers. It is never persisted on a timer and is
  serialized only by an explicit debug-gated raw export.
- Do not widen records in the existing performance/system/app-experience stores.
- The normal diagnostics export remains byte-identical unless the separate P0 raw export is explicitly
  requested.
- I-1 and I-2 are the only production-visible measurement corrections: reject zeroed triage context/set
  context only from resolved summaries, and refuse report build/export while the trip-profile query is
  pending. Do not alter retained-series aggregation for I-3 in P0.
- A run with dropped secure, persistence, lifecycle, or Long Task rows is invalid for causal percentages.
- No P0 implementation is complete until the required tests and device experiment pass.

## 3. Exact approved file inventory

### New JavaScript modules

- `src/lib/p0Probe.js` — trace state, fixed circular buffers, IDs, spans/phases, Long Task observer,
  scheduling-gap detector, lifecycle ledger, overhead counters, raw serializer.
- `src/lib/p0ProbeArms.js` — boot-immutable debug-gated arm selection, `arm_config_id`, job-entry and
  write-only suppression predicates.
- `src/lib/p0Schema.js` — schema version, phase/enumeration allowlists, payload-kind mapping,
  `run_marker` validation, and frozen `CLOCK_SUSPECT_THRESHOLD_MS`.

### New offline scripts

- `scripts/p0-analyze.mjs` — sorted interval sweep, inclusive/exclusive blocked-time attribution,
  bootstrap confidence intervals, byte buckets, Spearman correlation, and P1/P2 decision rules.
- `scripts/p0-trace.mjs` — mandatory CDP tracing and `RunTask` extraction, including Arm D.
- `scripts/p0-seed-dataset.mjs` — deterministic data/store fixtures and content hashes.

### Modified JavaScript files

- `src/lib/secureBridge.js`
- `src/lib/securePayloadCrypto.js`
- `src/lib/performanceTriage.js`
- `src/lib/systemLog.js`
- `src/lib/appExperienceDiagnostics.js`
- `src/lib/nativeAppExperienceWatchdog.js`
- `src/main.jsx`
- `src/App.jsx`
- `src/pages/Diagnostics.jsx`
- `src/components/AppExperienceDiagnosticsPanel.jsx`

### Java files

- Modify `android/app/src/main/java/com/drivesense/app/SecureBridgePlugin.java`.
- Add `android/app/src/main/java/com/drivesense/app/P0CallTiming.java`.
- Do **not** modify `DriveSensePayloadCrypto.java`, Capacitor core, or the Capacitor handler thread.

### New tests

- `src/lib/__tests__/p0Probe.test.js`
- `src/lib/__tests__/p0ProbeArms.test.js`
- `src/lib/__tests__/p0ExportPrivacy.test.js`
- `src/lib/__tests__/secureBridgePhases.test.js`
- `src/lib/__tests__/secureBridgeQueueDepth.test.js`
- `src/lib/__tests__/securePayloadCryptoP0Phases.test.js`
- `src/lib/__tests__/p0Analyze.test.mjs`
- `android/app/src/test/java/com/drivesense/app/P0CallTimingTest.java`
- `android/app/src/androidTest/java/com/drivesense/app/SecureBridgeP0EnvelopeInstrumentedTest.java`

Existing affected tests may be extended as needed, but production files outside this inventory require a
fresh shared-plan review before modification.

## 4. IDs, trace model, and queue semantics

### Runtime metadata

Export `probe_session_id`, mandatory build hash, schema version, arm, `arm_config_id`, validated
`run_marker`, process-start wall/performance anchors, ring budgets, peaks, and dropped counts.

`run_marker` must match `^[a-z0-9_-]{1,64}$`; reject other values. Random session identifiers use a secure
random source where available and carry no user or trip identity.

### Correlation

- `call_id`: monotonic per-runtime join key for secure spans, phase rows, and native timing blocks.
- `parent_op_id`: used only when explicitly supplied. Never infer async parentage through a module-level
  stack held across `await`.
- Long Tasks have independent `lt_id` values and join to zero or more call/operation/phase IDs offline by
  interval overlap.

### Queue contract

`secureCall` maintains `pendingSecureCalls`:

1. Before chaining, record enqueue performance/wall time and snapshot
   `queue_depth_at_enqueue = pendingSecureCalls` (already pending/in-flight calls, excluding the new call).
2. Increment once, then chain onto the existing FIFO `bridgeCallQueue` without changing its behavior.
3. Record `performSecureCall` entry performance time; queue wait is entry minus enqueue.
4. Decrement exactly once in the call's own `finally`, including rejection and immediate settlement.

Queue wait is latency, never synchronous Long Task coverage.

## 5. Secure and logical-payload instrumentation

Split existing expressions without changing values or order.

### Synchronous intervals eligible for secure-path Long Task coverage

- `logical_stringify` — actual value serialization in `encryptSensitiveValue`.
- `req_json` — secure transport envelope `JSON.stringify`.
- `req_encode` — request `TextEncoder.encode`.
- `wc_encrypt_invoke` — synchronous call prefix before WebCrypto returns its Promise.
- `req_b64_iv`
- `req_b64_data`
- `native_invoke` — synchronous Capacitor call prefix before it returns its Promise.
- `res_b64_iv`
- `res_b64_data`
- `wc_decrypt_invoke`
- `res_decode`
- `res_json` — transport-envelope parse.
- `logical_parse` — actual decrypted logical value parse in `decryptSensitiveValue`.

### Latency intervals, never assigned CPU ownership

- `queue_wait`
- `session_wait`
- `wc_encrypt_await`
- `native_await`
- `wc_decrypt_await`

Invocation and await intervals must be separate. Only invocation intervals and the named synchronous
conversion intervals are eligible for synchronous blocked-time attribution.

### Byte/count fields

Reuse existing results only:

- `req_plaintext_bytes = encoded.byteLength`
- `req_ciphertext_bytes = encrypted.byteLength`
- request/response base64 character counts remain distinct
- `res_ciphertext_bytes = decodedResponseBytes.byteLength`
- `res_plaintext_bytes = plaintextBuffer.byteLength`
- at-rest ciphertext base64 character count
- at-rest plaintext/ciphertext byte sizes are `null` unless already available without an added encode or
  traversal

Never add `TextEncoder`, `Blob`, `String.getBytes`, or another payload pass only to obtain a count.

### Logical payload classification

`securePayloadCrypto.js` allocates `parent_op_id`, times logical JSON, derives `payload_kind`, discards the
raw context, and passes only `{parent_op_id, payload_kind}` as an optional fourth `secureCall` argument.

Allowed payload kinds are fixed enums: `trip_summary`, `trip_detail`, `active_trip`, `speed_geometry`,
`speed_knowledge`, `privacy`, and `other`. Never store/export context strings, storage keys, or trip IDs.

## 6. Native timing contract

JS sends only the privacy-safe call ID and send wall time as outer diagnostic metadata. Native never trusts
these fields for crypto or control decisions.

`P0CallTiming` records:

- native-entry wall milliseconds and `SystemClock.elapsedRealtimeNanos()` at plugin-method entry;
- response-ready wall milliseconds and monotonic nanoseconds immediately before `call.resolve`;
- `native_total_internal = response_ready_nanos - native_entry_nanos`;
- named intervals for transport base64 decode, transport AES decrypt, envelope JSON parse, method work,
  response JSON, response UTF-8, response AES encrypt, and response base64 encode;
- named-phase residual versus the authoritative entry-to-ready total.

Attach `_p0` outside ciphertext and AAD on `resolveEncrypted` and every direct plaintext `call.resolve`
branch (`encryptSensitivePayload`, `setPreference`, `ensureSensitivePayloadKey`,
`deleteSensitivePayloadKey`, and `initSession`). JS strips `_p0` before any caller-visible non-encrypted
result is returned. Missing or hostile `_p0` data cannot throw, change returned values, or affect security.

JS reports total native invocation/await time, native entry-to-ready time, approximate pre-native dispatch,
approximate post-native delivery/rescheduling, and residual. Cross-clock estimates are invalid whenever
the containing span is clock-suspect.

## 7. Clocks, lifecycle, and suspension semantics

- Raw synchronous phase intervals use unrounded `performance.now()` values (compact integer-microsecond
  offsets from the span anchor are acceptable).
- Secure calls take four wall samples: span start, immediately before native, immediately after native,
  and span end. Do not call `Date.now()` around every synchronous subphase.
- `CLOCK_SUSPECT_THRESHOLD_MS` is frozen/exported and tested below, at, and above its boundary.
- When whole-span wall/performance divergence exceeds the threshold, mark every phase in that span
  `clock_suspect` and exclude it from correlation.
- Effective foreground state is document-visible **and** native-app-active.
- Export raw `visibilitychange` and `appStateChange` events separately; do not merge or deduplicate their
  evidence.
- Increment `foreground_epoch` only when effective state changes. Derive per span: start/end state and
  epoch, hidden/foreground milliseconds, and `spanned_background`.
- A 1-second heartbeat records only scheduling gaps over 250 ms. Never call visible timer lateness proof of
  renderer blocking; classification requires Long Task plus lifecycle/clock/native evidence.

## 8. Long Task collection and offline correlation

Use a separate unthrottled `PerformanceObserver('longtask')`. It writes directly to the P0 ring and must
not log through `systemLog` or `appExperienceDiagnostics`.

Export only `lt_id`, raw start, duration, fixed-enum name, fixed-enum container type, and attribution count.
Never export container name/src/id, URLs, DOM content, or arbitrary attribution values.

Do no live join or scan. `scripts/p0-analyze.mjs` performs a sorted interval sweep against synchronous
phase intervals and reports inclusive and exclusive overlap, with each blocked millisecond assigned at
most once. Classes include secure sync, logical JSON, diagnostics sync, mixed, and unattributed. Awaited
queue/WebCrypto/native time never counts as synchronous coverage.

## 9. Diagnostics instrumentation and experiment arms

### Hot-path measurements in Arm A/D

Record existing get, parse, transform, stringify, and set intervals in:

- `performanceTriage.persistEntry`
- `systemLog.flushPendingLogs`, both prune calls, `writeStoredLogs`, and `getSystemLogs`
- `readStoredExperienceEvents` and `flushHistoricalAppExperienceEvents`

Record array counts already in hand and `serialized_code_units = existingSerializedString.length`. Add no
extra payload traversal, comparator counter, or per-entry instrumentation.

### Arms

- **A:** collection on; all three recurring persistence jobs on; watchdog checkpoints on; probe on.
- **B:** collection on; all three recurring persistence jobs short-circuited at entry; watchdog
  checkpoints on; probe on.
- **C:** same as B, plus watchdog checkpoint bridge calls suppressed; probe on.
- **D:** production persistence/checkpoints on; probe off. CDP is the measurement source.

Arm is selected once at boot, immutable for the process, debug-gated, and exported with
`arm_config_id`. Normal release builds hard-return A and cannot suppress production behavior.

In B/C, branch before the first storage read/full-history work in `persistEntry`, `flushPendingLogs`, and
`flushHistoricalAppExperienceEvents`. Transfer only the already-collected pending batch to bounded volatile
buffers. Do not execute full-store `getItem`, parse, sanitize/prune/sort, stringify, set, or retry work.
Rewrite-on-read paths may perform explicitly requested display reads but cannot write. Pre-existing history
must remain byte-identical. Export volatile collection/drop counters; do not claim P0 retention equivalence.

Before every arm run, restore and content-hash the identical diagnostic-store fixture.

## 10. Raw export and probe-overhead controls

The separate debug raw export contains meta, spans, phases, Long Tasks, scheduling gaps, lifecycle events,
native blocks, overhead, budgets/peaks, and dropped counts. It includes raw rows, not aggregates.

- Use fixed circular buffers; never `Array.shift` or repeated whole-array spreading.
- Freeze the scenario trace before export serialization; report export serialization separately.
- Sample probe writer and observer-callback self-time 1-in-32.
- Run the synthetic ring microbenchmark only in a sacrificial realm and force-stop before measurements.
- Mandatory matched CDP A/D pairs measure downstream allocation/GC overhead the probe cannot self-charge.
- P0 measurements are invalid if added synchronous cost p95 is >=0.2 ms per instrumented call, probe
  blocking is >=1% of scenario wall time, or CDP Arm-A versus Arm-D TBT delta is >=5%.

## 11. Privacy and security rules

- `p0Schema.js` is the single allowlist for keys **and values**.
- No trip IDs, coordinates, trip timestamps, notes, settings values, storage keys, encryption contexts,
  DOM content, URLs, crypto material, nonce, secure-session ID, keys, AAD, or payload content in P0 data.
- `_p0` is explicitly unauthenticated and diagnostic-only. It never affects crypto/control decisions.
- Trace-on/off must preserve byte-identical encrypted request envelopes, AAD, nonce ordering, replay
  behavior, and caller-visible success/error results.
- P0 arms may suppress only diagnostic persistence/checkpoint work described above. They cannot suppress
  encryption, trip persistence, recovery, acknowledgement, privacy masking, key rotation, or features.
- Default app diagnostics behavior/history and all trip data remain preserved.

## 12. Required tests

Before device installation, tests must prove:

- transport byte equivalence across empty, small, 1 MB, nested, multibyte, emoji, and lone-surrogate data;
- byte fields distinguish UTF-8 byte length from JS/base64 character length;
- ordered, non-overlapping phase intervals and safe partial records on rejection;
- separate invoke/await intervals with only invoke marked synchronous;
- queue FIFO/depth/wait/finally behavior for delayed, rejected, and immediate predecessors;
- logical stringify/parse parenting and every payload-kind mapping with no raw context;
- hostile/missing `_p0` cannot affect behavior; `_p0` is stripped on plaintext results;
- release builds force Arm A; arm immutability and `arm_config_id` correctness;
- B/C job-entry short circuits invoke none of the full-store read/parse/transform/stringify/write/retry
  operations, while display reads remain readable and pre-existing history remains byte-identical;
- redaction, retention, and zero-hour privacy behavior remain unchanged;
- schema privacy fuzzing validates both keys and enum/token values;
- offline inclusive/exclusive attribution, logical JSON class, unattributed class, bootstrap CIs,
  byte buckets, Spearman correlation, and decision boundaries;
- hidden/foreground intersections, effective epoch behavior, clock-suspect boundary/exclusion;
- ring budget/drop/peak behavior and raw timing fidelity;
- `serialized_code_units` uses the existing string with no diagnostic TextEncoder/Blob;
- Java timing allowlist, phase ordering, entry-to-ready total/residual, envelope placement, every direct
  resolve branch, encryption/AAD/replay equivalence.

Run all existing required gates: `npm test`, lint, typecheck, E2E, repository hygiene, recovery guard,
scoring version check, native constants check, JVM tests, and connected Android tests. P0 must not change
`SCORING_VERSION`.

## 13. Physical-device experiment

Back up and verify the real device first. Use a debug-routes-enabled release-configuration build with the
same application ID. Record build/app/WebView versions and thermal state.

Matrix:

- real 128-trip reproduction;
- deterministic 100, 500, 1,000, and 3,000-trip fixtures;
- P50, P95, and deliberately-large route shapes;
- empty and exactly 2,500/2,500/4,000 diagnostic stores.

Restore/hash each fixture before each arm. Measure cold boot, foreground history/detail/map/speed-map,
60-second resume, >5-minute resume, native sync, live capture, and export as separate scenarios. Use matched
ABBA persistence ordering with at least five measured repetitions per cell after warm-up, returning the
device to a comparable cool thermal state.

Mandatory artifacts per cell: raw P0 export (except Arm D), standard diagnostics export, CDP trace,
`adb am start -W`, build/app/WebView versions, thermal state, Android watchdog snapshot, and fixture hashes.

## 14. P1/P2 decision gates

Use exclusive blocked-time coverage with bootstrap confidence intervals:

- **P2 first** when secure synchronous intervals cover at least 40% of blocked milliseconds and
  `res_b64_data` duration correlates with `res_ciphertext_bytes` at Spearman rho >=0.7 across at least
  three populated size decades. Logical JSON counts only on the explicitly joined call chain.
- **P1 first** when matched A/B TBT reduction is at least 40% with a confidence interval excluding zero,
  or diagnostics synchronous intervals cover at least 40% of blocked milliseconds.
- If both pass, P1 is first because it is lower-risk and independently verifiable.
- If neither passes, or unattributed blocked time is at least 40%, stop and conduct P0.b; start neither.
- Never decide from unreplicated data.

For the 600-second gate, compare foreground-only time after intersecting lifecycle intervals. If the
maintenance/query p95 collapses to seconds after hidden time is removed, suspension accounting explains
the historical figure. If it remains hundreds of seconds while effectively foreground, that hypothesis is
falsified and must be investigated before P1/P2.

Always report double-prune cost, serialized code units per store flush, queue-depth distribution,
lifecycle-triggered span counts, native dispatch/internal/delivery split and residual, logical versus
transport JSON, and unattributed share.

## 15. Definition of done

P0 is complete only when:

- approved implementation and security/privacy reviews are recorded;
- all new and existing test gates pass;
- instrumentation overhead is inside budget;
- all required device cells/artifacts are captured without invalid drops;
- the hidden-time, secure-path, and diagnostics-persistence gates each have an evidence-backed answer,
  including an explicit inconclusive result if warranted;
- the P1/P2 decision rule runs with confidence intervals and the unattributed share is reported;
- no P1/P2 production optimization began before P0 evidence review.

P0 PLANNING STATUS: APPROVED

CODEX P0 PLAN: APPROVE

CLAUDE P0 PLAN: APPROVE
