# Privacy Intelligence Documentation

## Plain-English Verdict

Privacy Intelligence is useful as an in-app privacy dashboard, but it is not yet strong enough to be treated as proof that the app is private or secure.

The feature does several genuinely valuable things:

- It gives the user one place to review privacy posture, outbound data records, privacy-zone activity, and audit-log integrity.
- It makes private GPS masking visible instead of hiding privacy behavior in background code.
- It has meaningful local protections around privacy zones, encrypted storage wrappers, native Android crypto hooks, audit-chain checks, and transmission logging.
- It is test-covered at the summary/classification layer.

The harsh truth: the current "privacy score" is too optimistic. Several checks in `src/lib/deviceStatus.js` are hardcoded to return `true`, so the score can imply protections are active without proving that the underlying implementation is actually working. The hash-chain audit log detects casual edits, but it is not tamper-proof because the chain and the anchor live on the same device. The transmission classifier is metadata/string based, not a cryptographic or packet-level proof. This feature is a strong UX and transparency layer, not a security guarantee.

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

## Data Loading Flow

The main orchestration function is:

```js
loadPrivacyIntelligence()
```

It loads these in parallel:

```txt
computePrivacyScore()
getProtectionStatus()
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

The overall score is weighted from four layer scores:

| Layer | Weight | Function |
| --- | ---: | --- |
| Device | 30% | `scoreDevice()` |
| Network | 25% | `scoreNetwork()` |
| Inference | 25% | `scoreInference()` |
| Integrity | 20% | `scoreIntegrity()` |

Formula:

```txt
overall = round(
  device * 0.30 +
  network * 0.25 +
  inference * 0.25 +
  integrity * 0.20
)
```

Score bands:

| Score | Label | Meaning |
| ---: | --- | --- |
| 90-100 | Strong | Core protections appear active. |
| 75-89 | Good | Solid posture with a few review items. |
| 55-74 | Needs review | Some protections need attention. |
| 0-54 | At risk | Important protections are unavailable or failing. |

### Device Layer

Starts at 100 and subtracts:

| Condition | Penalty |
| --- | ---: |
| RASP/device integrity says insecure | -30 |
| Storage encryption inactive | -25 |
| Biometric gate inactive | -10 |
| Screenshot prevention inactive | -10 |
| Key rotation overdue | -15 |
| Key rotation due within seven days | -5 |

### Network Layer

Starts at 100 and subtracts:

| Condition | Penalty |
| --- | ---: |
| Certificate pinning inactive | -20 |
| Native bridge encryption inactive | -10 |
| Request obfuscation inactive | -10 |
| OSRM enabled while at least one privacy zone allows sharing | -15 |
| OSRM consent outdated after privacy-zone change | -10 |

### Inference Layer

Starts at 100 and subtracts:

| Condition | Penalty |
| --- | ---: |
| Timestamp fuzzing inactive | -25 |
| Kinematic nulling inactive | -25 |
| Differential privacy inactive | -20 |
| Commitment scheme inactive | -20 |

### Integrity Layer

Starts at 100 and subtracts:

| Condition | Penalty |
| --- | ---: |
| Audit chain verification fails | -40 |
| HMAC export signing inactive | -30 |
| Crash scrubbing inactive | -20 |
| Audit logging inactive | -10 |

### Honest Score Assessment

The score is only as real as the checks behind it. Right now, several checks are not true runtime validations.

Examples from `src/lib/deviceStatus.js`:

```js
export const isStorageEncrypted = () => true;
export const isMemoryZeroingEnabled = () => true;
export const isSecureDeletionEnabled = () => true;
export const isRequestObfuscationEnabled = () => true;
export const isTimestampFuzzingEnabled = () => true;
export const isKinematicNullingEnabled = () => true;
export const isDifferentialPrivacyEnabled = () => true;
export const isCommitmentSchemeEnabled = () => true;
export const isHmacExportEnabled = () => true;
export const isCrashScrubbingEnabled = () => true;
export const isAuditLogEnabled = () => true;
```

That means the score can look strong even if a future refactor breaks the actual behavior. These should become active health checks, not constants.

Also, `scoreDevice()` treats failed integrity checks as secure if `checkIntegrity()` throws:

```js
checkIntegrity().catch(() => ({ secure: true, threats: [] }))
```

That is too forgiving. A failed integrity check should be at least a warning and probably a score penalty.

## Protection Checks

`getProtectionStatus()` returns user-facing protection cards.

| ID | Category | What it reports | Current reliability |
| --- | --- | --- | --- |
| `storage` | Device | Storage encryption, key version, days since rotation. | Mixed. Encryption exists, but status is hardcoded true. |
| `key_rotation` | Device | Days until next 30-day rotation target. | Partial. Based on setting metadata, not proof of successful rotation. |
| `memory_zeroing` | Inference | Sensitive route buffers cleared after processing. | Partial. Some buffers use `SecureGpsBuffer.zero()`, but status is hardcoded true. |
| `secure_deletion` | Device | Private GPS purge uses secure deletion. | Weak. Status is hardcoded true; implementation needs verification. |
| `certificate_pinning` | Network | Native endpoint pinning active. | Reasonable on native only; web runtime fallback has no pinning. |
| `bridge_encryption` | Network | JS-to-Android sensitive payload bridge encryption. | Reasonable on Android; unavailable in web runtime. |
| `screenshots` | Device | Android sensitive screens use screenshot blocking. | Setting driven; depends on native plugin behavior. |
| `biometric_gate` | Device | App lock and Privacy Intelligence authentication. | Useful UX control, but not data-at-rest protection by itself. |
| `root_detection` | Integrity | RASP check result. | Useful, but mobile RASP is bypassable. Treat as signal, not certainty. |
| `request_obfuscation` | Network | Randomized outbound scheduling. | Implementation exists, but status is hardcoded true. |
| `crash_scrubbing` | Integrity | Crash report coordinate scrubbing. | Status hardcoded true; latest scrub count comes from settings. |
| `osrm_consent` | Network | OSRM data-sharing and privacy-zone guard status. | Useful and tied to actual settings. |
| `audit_chain` | Integrity | Local audit chain validity and tip hash. | Good for accidental/local edits, weak against full local compromise. |
| `export_signing` | Integrity | Backup export HMAC signing. | Status hardcoded true; should verify signing module readiness. |

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
- Shuffles real requests with decoys.
- Adds 1-3 decoy requests.
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

- The status check is hardcoded true.
- Decoys call `https://httpbin.org/get`, which leaks traffic to a third-party service. That may be unacceptable in a privacy feature.
- Obfuscation does not remove the need to minimize payloads.
- Network timing privacy is hard. This is a speed bump, not anonymity.

Recommended improvement: remove public third-party decoys or make them opt-in/test-only, and log obfuscation health based on actual queue behavior.

## OSRM Privacy

OSRM route snapping is privacy-sensitive because it can send route coordinates to an external service.

Current safeguards:

- Public OSRM demo endpoint is detected by `isPublicOsrmDemoUrl()`.
- README says saved settings reject the public demo endpoint.
- OSRM requires a trusted custom endpoint.
- OSRM requires raw-coordinate sharing consent.
- Privacy-zone changes invalidate prior OSRM consent.
- Privacy zones can exclude protected interiors from route snapping.
- The Privacy Intelligence score penalizes outdated consent and zones that allow OSRM coordinate sharing.

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

- The page is polished enough to feel authoritative. That raises the bar for correctness. If the score is optimistic because checks are hardcoded, the UI can mislead users.

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
All listed protections are actively verified.
```

Those claims would be too strong for the current implementation.

## Priority Fix List

### P0: Stop Overstating Protection Status

Replace hardcoded `true` checks in `src/lib/deviceStatus.js` with real runtime checks or return `unknown`.

Needed status values:

```txt
ok
warn
error
unknown
not_applicable
```

Right now a missing proof often appears as success. That is the biggest credibility problem.

### P0: Treat Failed Integrity Checks As Risk

Change `scoreDevice()` so a thrown `checkIntegrity()` result does not silently become secure.

Better behavior:

```txt
check passed -> ok
check failed with threats -> error
check unavailable -> warn
```

### P0: Make Transmission Classification Typed

Replace string matching on `protections` with structured payload metadata:

```txt
coordinateDisclosure: none | blocked | raw | rounded | bounding_box | masked | committed
privacyTransformVerified: boolean
privacyTransformSource: module/function name
```

Require outbound call-site tests.

### P1: Add External Or Hardware-Backed Audit Anchoring

The local hash chain is not enough for strong tamper evidence.

Options:

- Hardware-backed signing key on Android.
- User-exported audit anchor.
- Optional server-side append-only anchor.
- QR/exported checkpoint the app cannot silently rewrite.

### P1: Fix Request Obfuscation Decoys

The current `httpbin.org` decoy is questionable for a privacy product. Remove it, make it test-only, or route decoys to a user-controlled endpoint.

### P1: Verify Key Rotation For Real

The dashboard should inspect encrypted payload metadata and report:

```txt
active key version
oldest payload key version
newest payload key version
last successful rotation time
payloads pending rotation
rotation errors
```

### P1: Add UI Language For Unknowns

The UI needs an "unknown" state. Unknown is not the same as OK.

### P2: Strengthen Documentation In-App

The page should include careful wording:

```txt
This dashboard reports app-recorded privacy activity and local protection checks. It is not an external security audit.
```

Do this without making the UI wordy.

## Suggested Better Score Model

The current score is easy to understand, but too forgiving.

Better model:

```txt
verified controls: can score high
configured controls: can score medium
claimed controls: no score boost without evidence
unknown controls: warning, not success
failed controls: penalty
not applicable controls: excluded from denominator
```

Example:

```txt
score = verified_points / applicable_points
```

Each control should have:

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

1. Should Privacy Intelligence show "unknown" explicitly instead of converting unverified protections into OK or warning?
2. Should clearing transmission records append an audit event?
3. Should the audit log be exportable with a signed checkpoint?
4. Should raw-coordinate OSRM sharing be blocked whenever any privacy zone exists near a route endpoint?
5. Should the score exist at all before checks become real evidence-based health checks?
6. Should web runtime receive a lower maximum possible score because browser storage cannot match Android hardware-backed protections?
7. Should request obfuscation decoys be removed to avoid sending privacy-feature traffic to `httpbin.org`?

## Bottom Line

Privacy Intelligence is not useless. The core idea is good, and the app already has meaningful privacy machinery around zones, masking, encrypted storage, audit records, and outbound request transparency.

But the current implementation is too optimistic and too self-attesting. It should be treated as a promising privacy dashboard, not a trustworthy privacy assurance system. The next serious work is not adding more UI. The next serious work is making every green check earn its color with real evidence.
