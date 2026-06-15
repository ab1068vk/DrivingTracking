# Privacy Intelligence Documentation

## Plain-English Verdict

Privacy Intelligence is useful as an in-app privacy dashboard, but it is not yet strong enough to be treated as proof that the app is private or secure.

The feature does several genuinely valuable things:

- It gives the user one place to review privacy posture, outbound data records, privacy-zone activity, and audit-log integrity.
- It makes private GPS masking visible instead of hiding privacy behavior in background code.
- It has meaningful local protections around privacy zones, encrypted storage wrappers, native Android crypto hooks, audit-chain checks, and transmission logging.
- It is test-covered at the summary/classification layer.

The important limitation: the current "privacy score" is still local attestation, not an outside security audit. The app now runs runtime self-tests through `src/lib/controlSelfTests.js` instead of the old hardcoded `true` checks, but those tests still execute inside the same app runtime they are judging. The hash-chain audit log detects casual edits, but it is not tamper-proof because the chain and the anchor live on the same device. The transmission classifier is typed metadata provided by app call sites, not a packet capture or cryptographic proof of the payload. This feature is a strong UX and transparency layer, not a security guarantee.

If this is being positioned as a real privacy/security feature, it needs hardening before release claims are made.

## Purpose

Privacy Intelligence exists to answer four user questions:

1. What is my current privacy posture?
2. Which privacy protections are active, weak, unavailable, or misconfigured?
3. What location-related data left the device?
4. Can I trust the local privacy audit history?

It is implemented as a React page backed by local privacy/security modules.

Main route:

```txt
/privacy-intelligence
```

Main source files:

```txt
src/pages/PrivacyIntelligence.jsx
src/lib/privacyIntelligence.js
src/lib/deviceStatus.js
src/lib/controlSelfTests.js
src/lib/privacyZones.js
src/lib/transmissionLog.js
src/lib/hashChainLog.js
```

Related privacy/security modules:

```txt
src/lib/securePayloadCrypto.js
src/lib/differentialPrivacy.js
src/lib/requestObfuscator.js
src/lib/osrmPrivacy.js
src/lib/rasp.js
src/lib/biometricGate.js
src/lib/secureBridge.js
src/lib/screenSecurity.js
src/lib/crashSanitizer.js
src/lib/exportIntegrity.js
src/lib/exportCommitment.js
src/lib/privateTripMode.js
```

Tests:

```txt
src/lib/__tests__/privacyIntelligence.test.js
src/lib/__tests__/privacyZones.test.js
src/lib/__tests__/hashChainLog.test.js
src/lib/__tests__/transmissionLog.test.js
src/lib/__tests__/differentialPrivacy.test.js
src/lib/__tests__/securePayloadCrypto.test.js
src/lib/__tests__/rasp.test.js
src/lib/__tests__/requestObfuscator.test.js
```

## Feature Surface

The page has five tabs.

| Tab | Purpose | Main data source |
| --- | --- | --- |
| Overview | Shows score, layer scores, recommended review items, protected activity, and audit status. | `loadPrivacyIntelligence()` |
| Transmissions | Shows outbound request records, data shape, service, bytes, status, and privacy classification. | `loadTransmissionLog()` through `getTransmissionSummary()` |
| Protections | Shows individual privacy/security checks with status, detail, and action text. | `getProtectionStatus()` |
| Zones | Shows configured privacy zones and counts of hidden GPS samples/events. | `getZoneStatsSnapshot()` |
| Audit Log | Shows local hash-chain privacy audit entries and verification status. | `loadPrivacyAuditChain()` and `verifyChain()` |

The page requires device authentication before loading data:

```txt
src/pages/PrivacyIntelligence.jsx
authenticateDevice('Access Privacy Intelligence')
```

It also re-authenticates when the app returns from background after at least five minutes.

If Android app lock is enabled in Settings, the whole app is locked on launch and after returning from the background for five minutes. That app-wide lock is implemented in `src/App.jsx` with `authenticateDevice('Verify to open your private driving data')`; Privacy Intelligence still performs its own page-level authentication before showing the dashboard.

## Data Loading Flow

The main orchestration function is:

```js
loadPrivacyIntelligence()
```

It first gathers protection statuses, then computes the score from those controls and loads activity summaries:

```txt
getProtectionStatus()
computePrivacyScoreFromControls()
getZoneStats()
getTransmissionSummary()
loadPrivacyAuditChain()
verifyChain()
```

Returned shape:

```txt
generatedAt
score
protections
protectionSummary
recommendations
zones
zoneSummary
transmissions
chain
chainResult
auditSummary
```

The page refreshes quietly every 30 seconds while authenticated.

## Privacy Score Model

The overall score is weighted from four layer scores. Each layer is calculated from applicable controls in `CONTROL_REGISTRY` plus setting-backed controls.

| Layer | Weight | Source |
| --- | ---: | --- |
| Device | 30% | Storage encryption, secure deletion, root/jailbreak check, key rotation, app lock, screenshot prevention |
| Network | 25% | Certificate pinning, bridge encryption, request obfuscation, OSRM consent |
| Inference | 25% | Memory zeroing, timestamp fuzzing, kinematic nulling, differential privacy, export commitments |
| Integrity | 20% | Export signing, crash scrubbing, local audit chain |

Each control returns one of these statuses:

| Status | Points | Meaning |
| --- | ---: | --- |
| `ok` | 1.0 | Runtime self-test passed. |
| `configured` | 0.6 | Setting-backed protection is enabled, but not fully self-tested. |
| `warn` | 0.3 | Protection exists but needs review. |
| `unknown` | 0.0 | The app could not prove the state. |
| `error` | 0.0 | The check failed or the protection is off. |
| `not_applicable` | excluded | Control does not apply to this runtime, such as native-only pinning on web. |

Layer formula:

```txt
layer = round(earned_control_points / applicable_control_points * 100)
```

Overall formula:

```txt
overall = round(weighted_applicable_layer_scores / applicable_layer_weight)
```

Score bands:

| Score | Label | Meaning |
| ---: | --- | --- |
| 90-100 | Strong | Core protections appear active. |
| 75-89 | Good | Solid posture with a few review items. |
| 55-74 | Needs review | Some protections need attention. |
| 0-54 | At risk | Important protections are unavailable or failing. |

### Honest Score Assessment

The score is only as real as the checks behind it. The current implementation is much better than the previous hardcoded status model: `src/lib/deviceStatus.js` delegates to `src/lib/controlSelfTests.js`, and the self-tests exercise real code paths such as AES-GCM round trips, `SecureGpsBuffer.zero()`, privacy export masking, export HMAC signing, crash scrubbing, and audit-chain append/verify.

Remaining limitations:

- Self-tests run inside the same JavaScript/native app runtime and can be fooled by a compromised app bundle.
- Some controls are still setting-backed (`configured`) rather than fully proven (`ok`).
- Request obfuscation can be `unknown` until a batch runs in the current session.
- `checkDeviceIntegrity()` now returns `unknown` when integrity checking is unavailable, but unknown still needs careful UI language so users do not read it as proof of safety.
- `getKeyRotationStatus()` is based on key metadata and rotation timing; a stronger version would inspect stored payload key versions and report pending rotations.

## Protection Checks

`getProtectionStatus()` returns user-facing protection cards.

| ID | Category | What it reports | Current reliability |
| --- | --- | --- | --- |
| `storage_encryption` | Device | AES-256-GCM sensitive-payload encryption round trip. | Runtime self-test; strong local signal. |
| `key_rotation` | Device | Days until next 30-day rotation target. | Partial. Based on setting metadata and key status, not a full payload inventory. |
| `memory_zeroing` | Inference | Route masking invokes `SecureGpsBuffer.zero()`. | Runtime self-test; proves the masking path calls zeroing. |
| `secure_deletion` | Device | IndexedDB canary is overwritten and removed with `secureDelete()`. | Runtime self-test where IndexedDB is available; otherwise unknown. |
| `cert_pinning` | Network | Native endpoint pinning is configured. | Native-only; web runtime is not applicable. |
| `bridge_encryption` | Network | JS-to-Android sensitive payload bridge encryption. | Native-only encrypted bridge echo test. |
| `screenshot_prevention` | Device | Android screen capture is blocked unless the user allows it. | Setting driven; depends on native plugin behavior. |
| `biometric_gate` | Device | App lock and Privacy Intelligence authentication. | Useful UX control, but not data-at-rest protection by itself. |
| `root_detection` | Device | RASP check result. | Useful, but mobile RASP is bypassable. Treat as signal, not certainty. |
| `request_obfuscation` | Network | Randomized outbound scheduling queue health. | Runtime queue status; can be unknown until a batch has run. |
| `timestamp_fuzzing` | Inference | Privacy export boundary timestamps are fuzzed. | Runtime self-test with a synthetic private boundary. |
| `kinematic_nulling` | Inference | Privacy export placeholders omit motion fields. | Runtime self-test with a synthetic private boundary. |
| `differential_privacy` | Inference | Aggregate noise varies across samples. | Runtime canary; validates behavior, not statistical privacy policy. |
| `commitment_scheme` | Inference | Zone export commitments omit coordinates and vary by export. | Runtime self-test. |
| `crash_scrubbing` | Integrity | Crash report coordinate scrubbing. | Runtime self-test with coordinate canaries. |
| `osrm_consent` | Network | OSRM data-sharing and privacy-zone guard status. | Useful and tied to actual settings. |
| `audit_chain` | Integrity | Local audit chain validity and tip hash. | Good for accidental/local edits, weak against full local compromise. |
| `export_signing` | Integrity | Backup export HMAC signing and tamper rejection. | Runtime self-test. |

## Privacy Zones

Privacy zones hide or remove sensitive location data around private places.

Core file:

```txt
src/lib/privacyZones.js
```

Important behaviors:

- Zone radius is clamped between 50 m and 1000 m.
- Zone geometry is normalized.
- Exact coordinates are stored in encrypted storage when available.
- Settings store redacted/cell-only versions where possible.
- Native Android receives privacy-zone cell guards through secure preference sync.
- If native sync fails, the app fails closed by disabling background/auto tracking.
- Saving or changing a zone invalidates OSRM raw-coordinate consent.
- Privacy-zone changes clear map-matching cache.
- Route points inside zones are masked for display.
- Driving events inside zones are filtered or redacted.
- Export paths replace boundaries with privacy gaps and can apply timestamp fuzzing and aggregate noise.
- Purging private GPS removes points/events from stored trips and marks affected trips for rescoring.

Key storage:

```txt
drivesense_privacy_zones_config_v1
privacy_zones_v1
drivesense_privacy_zone_stats_v1
```

Zone statistics count:

- GPS samples hidden today, this week, and all time.
- Driving events hidden today, this week, and all time.
- Latest protected activity time.
- Number of configured zones.
- Number of zones with protected activity.

### Honest Zone Assessment

This is one of the strongest parts of the system. It has real implementation depth and clear user value.

Weak spots:

- Counts are derived from saved/redacted trip records, so they are only as complete as trip persistence.
- The dashboard proves that records were marked/masked, not that no private coordinate ever existed temporarily in memory.
- Web runtime protections are weaker than Android native protections.
- If malicious code runs in the same app origin, it can likely read decrypted values through app APIs.

## Transmission Logging

Transmission logging records outbound location-related requests.

Core file:

```txt
src/lib/transmissionLog.js
```

Storage key:

```txt
drivesense_transmission_log_v1
```

Retention:

```txt
30 days
500 entries max
```

Each record stores:

```txt
id
timestamp
service
type
sentCoords
protections
offsetMeters
bytesOut
bytesIn
status
tripId
zonesSuppressed
expiresAt
```

The log is stored through:

```js
setEncryptedJson()
getEncryptedJson()
```

Each logged transmission also appends an audit-chain event:

```txt
op: TRANSMISSION
```

Privacy classification:

| Result | Logic |
| --- | --- |
| `blocked` | `entry.status === 'blocked'` |
| `none` | No `sentCoords` |
| `protected` | `protections` contains words such as zone, round, bbox, scrub, commitment, mask, privacy |
| `raw` | Coordinates were sent and no recognized protection marker exists |

### Honest Transmission Assessment

This is helpful transparency, but it is not proof-grade.

Limitations:

- Classification is based on app-provided metadata, not observed network packets.
- A request can be mislabeled if the calling code supplies incorrect `protections`.
- "Protected" means the metadata says protection happened; it does not cryptographically prove the payload was safe.
- Bytes are counted from caller-provided values, not a network stack measurement.
- Clearing retained records removes the user's local visibility.

Recommended improvement: define typed transmission records at every outbound call site and require tests that verify actual payload shape before logging a request as protected.

## Audit Log

Privacy audit logging is implemented in:

```txt
src/lib/hashChainLog.js
```

Storage keys:

```txt
drivesense_privacy_audit_chain_v1
drivesense_privacy_audit_anchor_v1
```

Each entry includes:

```txt
schema
seq
timestamp
op
zone_id
zone_label
hidden_count
trip_id
details
prevHash
hash
```

Sensitive keys are rejected from details. The sanitizer blocks keys containing:

```txt
lat
lng
longitude
latitude
coordinate
coordinates
radius
radius_m
route_points
driving_events
address
email
phone
token
password
secret
```

Allowed details include controlled metadata such as:

```txt
affected_trip_count
event_count
failure_count
hidden_event_count
hidden_point_count
native_tracking_stopped
point_count
privacy_gap_count
privacy_zone_count
purge_raw_gps
purged_event_count
purged_point_count
purged_trip_count
reason
segment_count
service
snapped_coverage
status
trip_count
zone_count
```

Verification checks:

- Chain JSON parses.
- Chain is an array.
- Anchor JSON parses.
- Non-empty chain has an anchor.
- Sequence numbers are continuous.
- `prevHash` links to the previous entry hash.
- Entry hash is present and 64 hex characters.
- Recomputed SHA-256 hash matches.
- Anchor length matches chain length.
- Anchor tip matches final hash.

### Honest Audit Assessment

The audit log is good for detecting accidental corruption or unsophisticated local editing.

It is not tamper-proof. A local attacker, compromised app runtime, or malicious backup/import path that can rewrite both the chain and anchor can create a new valid chain. For real tamper evidence, the app needs an external anchor, a server-side append-only log, hardware-backed signing, or periodic export to a place the app cannot rewrite.

## Storage And Encryption

Sensitive JSON storage uses:

```txt
src/lib/securePayloadCrypto.js
```

Encryption behavior:

| Runtime | Behavior |
| --- | --- |
| Android native | Uses `SecureBridge` and Android Keystore-backed AES-256-GCM. |
| Web | Uses WebCrypto AES-GCM with non-extractable keys stored in IndexedDB. |
| Unsupported native platforms | Throws until platform-backed crypto exists. |

Encrypted payload metadata:

```txt
encrypted: true
version: 1
key_version
algorithm: AES-256-GCM
key_provider
ciphertext
iv, for web
```

### Honest Storage Assessment

Android Keystore-backed encryption is a meaningful protection.

WebCrypto non-extractable keys are better than plaintext, but they are not a magic shield. If the same origin JavaScript is compromised, the attacker can call the decrypt path even if the raw key is non-extractable. This is still worthwhile, but do not oversell it as equivalent to hardware-backed mobile storage.

Key rotation is not fully proven by the Privacy Intelligence status. `getKeyVersion()` returns `1`, and key age is based on settings metadata. The dashboard should verify stored payload key versions and successful re-encryption before claiming key rotation health.

## Request Obfuscation

Request obfuscation is implemented in:

```txt
src/lib/requestObfuscator.js
```

Behavior:

- Batches location requests after a random 3-9 minute delay.
- Shuffles real requests with decoys only when `decoy_traffic_mode` is `first_party`.
- Adds 1-3 first-party Open-Meteo decoy requests only in that opt-in mode.
- Adds 800-3500 ms between requests in a batch.
- Uses native road-data queue when a native request is available.

Timing constants:

```txt
batchMinMs: 180000
batchMaxMs: 540000
interRequestMinMs: 800
interRequestMaxMs: 3500
decoyMinCount: 1
decoyMaxCount: 3
```

### Honest Obfuscation Assessment

The idea is useful, but the implementation needs scrutiny:

- Privacy Intelligence only reports `ok` after the obfuscator queue has initialized and processed a batch; otherwise it can report `not_applicable` or `unknown`.
- Decoys are off by default. When enabled, they use a first-party-style Open-Meteo weather request at neutral coordinates, which is better than the old generic public decoy but still creates extra external traffic.
- Obfuscation does not remove the need to minimize payloads.
- Network timing privacy is hard. This is a speed bump, not anonymity.

Recommended improvement: keep decoys opt-in, make the UI clear about the extra external request, and consider a user-controlled endpoint for deployments that need stricter privacy.

## OSRM Privacy

OSRM route snapping is privacy-sensitive because it can send route coordinates to an external service.

Current safeguards:

- Public OSRM demo endpoint is detected by `isPublicOsrmDemoUrl()`.
- README says saved settings reject the public demo endpoint.
- OSRM requires a trusted custom endpoint.
- OSRM requires raw-coordinate sharing consent.
- Privacy-zone changes invalidate prior OSRM consent.
- Privacy-zone interiors and boundary points are always excluded from route snapping.
- Settings blocks the public demo endpoint for saved OSRM configuration.
- The Privacy Intelligence score penalizes outdated consent and treats the OSRM privacy-zone guard as always on.

### Honest OSRM Assessment

This is a good direction. The strongest rule is consent invalidation when zones change.

Risk remains whenever raw sampled coordinates are sent to a third-party endpoint. Even a trusted endpoint can infer sensitive places if the route starts or ends near them. The safest product language is "controlled sharing with consent", not "private route snapping".

## UI Behavior

Main component:

```txt
src/pages/PrivacyIntelligence.jsx
```

Important UI details:

- Requires device authentication before loading dashboard data.
- Shows loading state while locked/loading.
- Shows retry state if privacy data fails to load.
- Re-authenticates after five minutes in background.
- Refreshes every 30 seconds.
- Provides a manual Refresh button.
- Links review actions to Settings.
- Allows clearing retained transmission records.
- Filters transmissions by query, service, and privacy level.
- Filters protections by status or category.
- Filters audit log by query and operation.

UI risk:

- The page is polished enough to feel authoritative. That raises the bar for correctness. If users read local self-tests as an external security audit, the UI can mislead them even when the checks are technically passing.

## Test Coverage

Direct Privacy Intelligence tests currently cover:

- Transmission classification for blocked, none, protected, and raw cases.
- Zone summary aggregation.
- Audit summary aggregation.

Related tests cover privacy zones, hash chains, crypto, differential privacy, request obfuscation, and other security pieces.

### Test Gaps

High-priority missing tests:

- `computePrivacyScore()` with mocked failing checks.
- `getProtectionStatus()` for every status branch.
- Score behavior when `checkIntegrity()` throws.
- Score behavior when `verifyChain()` throws.
- OSRM consent edge cases.
- Transmission logging from actual outbound service call sites.
- Whether "protected" transmissions really have reduced/masked/boxed payloads.
- UI render tests for all five tabs with representative data.
- Authentication failure and background re-authentication behavior.
- Audit-chain tamper scenarios where chain and anchor are both rewritten, to document current limits.

## Threat Model

Privacy Intelligence can help with:

- Accidental privacy regressions.
- User awareness of external requests.
- Visibility into privacy-zone suppression.
- Detecting simple audit-log corruption.
- Identifying missing user-side protections such as biometric gate or screenshot prevention.
- Local-first privacy transparency.

Privacy Intelligence does not fully protect against:

- A compromised app bundle.
- XSS or malicious same-origin JavaScript.
- A rooted device controlled by an attacker.
- An attacker who can rewrite both local audit chain and anchor.
- Network-layer observation by a powerful adversary.
- A malicious or compromised OSRM/weather/road-data provider.
- Incorrect app code that logs raw payloads as protected.
- Legal/compliance requirements by itself.

## Release Readiness

### Useful Today

The feature is useful as a developer and user transparency dashboard.

It can honestly be described as:

```txt
A local privacy posture and activity dashboard that shows privacy-zone masking, outbound location request records, local audit-chain health, and configurable protection status.
```

### Not Safe To Claim Yet

Do not claim:

```txt
Privacy Intelligence proves all sensitive data is protected.
Privacy Intelligence is tamper-proof.
Privacy Intelligence guarantees no raw coordinates left the device.
The privacy score is a security certification.
Every listed protection is independently verified outside the app runtime.
```

Those claims would be too strong for the current implementation.

## Priority Fix List

### P0: Verify Transmission Metadata At Call Sites

Transmission records now use typed fields, but each outbound call site still needs tests that compare the actual payload shape against the logged metadata:

```txt
coordinateDisclosure: none | blocked | raw | rounded | bounding_box | masked | committed
privacyTransformVerified: boolean
privacyTransformSource: module/function name
```

The most important cases are OSM speed-limit lookups, Open-Meteo weather lookups, OSRM route snapping, and export-related flows.

### P0: Preserve Unknown As Unknown

The scoring model supports `unknown` and `not_applicable`. Keep UI copy, report copy, and release language from converting unknown local evidence into proof of safety.

### P1: Add External Or Hardware-Backed Audit Anchoring

The local hash chain is not enough for strong tamper evidence.

Options:

- Hardware-backed signing key on Android.
- User-exported audit anchor.
- Optional server-side append-only anchor.
- QR/exported checkpoint the app cannot silently rewrite.

### P1: Review Request Obfuscation Decoys

First-party Open-Meteo decoys are safer than generic public decoys, but they still create extra network traffic. Keep them opt-in and consider a user-controlled endpoint for stricter deployments.

### P1: Verify Key Rotation For Real

The dashboard should inspect encrypted payload metadata across stored sensitive records and report:

```txt
active key version
oldest payload key version
newest payload key version
last successful rotation time
payloads pending rotation
rotation errors
```

### P1: Add UI Language For Unknowns

The UI has status filtering, but unknown states need to remain visually and verbally distinct from both success and failure. Unknown is not the same as OK.

### P2: Strengthen Documentation In-App

The page should include careful wording:

```txt
This dashboard reports app-recorded privacy activity and local protection checks. It is not an external security audit.
```

Do this without making the UI wordy.

## Current Score Model Direction

The current score model follows the right direction:

```txt
verified controls: can score high
configured controls: can score medium
unknown controls: warning, not success
failed controls: penalty
not applicable controls: excluded from denominator
```

Current implementation:

```txt
score = weighted_control_points / applicable_control_points
```

Each control has or should preserve:

```txt
id
label
category
status
evidence
lastCheckedAt
source
riskIfMissing
userAction
developerAction
```

## Developer Verification Checklist

Run deterministic tests:

```bash
npm run test
```

Run lint:

```bash
npm run lint
```

Run type checking:

```bash
npm run typecheck
```

Run build:

```bash
npm run build
```

Manual checks:

- Open Settings and enable/disable app lock.
- Open Privacy Intelligence and confirm authentication is required.
- Add a privacy zone and confirm it appears in Zones.
- Record or seed a trip crossing the zone and confirm protected counts.
- Trigger an outbound road/weather/OSRM request and confirm transmission logging.
- Confirm raw-coordinate sends are not mislabeled as protected.
- Edit audit storage manually in devtools and confirm verification fails.
- Clear transmission records and confirm the tab updates.
- Put app in background for more than five minutes and confirm re-authentication.

## Open Design Questions

1. Should Privacy Intelligence make "unknown" more visually prominent even though the status exists today?
2. Should clearing transmission records append an audit event?
3. Should the audit log be exportable with a signed checkpoint?
4. Should raw-coordinate OSRM sharing be blocked whenever any privacy zone exists near a route endpoint?
5. Should the score exist at all before checks become real evidence-based health checks?
6. Should web runtime receive a lower maximum possible score because browser storage cannot match Android hardware-backed protections?
7. Should request obfuscation decoys remain Open-Meteo based, move to a user-controlled endpoint, or stay disabled for most users?

## Bottom Line

Privacy Intelligence is not useless. The core idea is good, and the app already has meaningful privacy machinery around zones, masking, encrypted storage, audit records, and outbound request transparency.

But the current implementation is still self-attesting. It should be treated as a useful privacy dashboard, not a trustworthy privacy assurance system. The next serious work is tightening call-site payload tests, key-rotation evidence, and any external or hardware-backed audit anchoring.
