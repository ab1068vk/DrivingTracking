# Privacy Intelligence Implementation Reference

## Plain-English Verdict

Privacy Intelligence is a local privacy posture and activity dashboard. It is useful, concrete, and grounded in real app records, but it is not an external audit and it cannot establish that no sensitive data ever left the device.

What it does well:

- Shows the user one place for local privacy score, protection checks, outbound location-related transmission records, privacy-zone activity, and audit-chain health.
- Makes hidden GPS samples, hidden events, raw-coordinate sends, unverified protection claims, and failing/unknown controls visible.
- Uses real local self-tests for several controls instead of hardcoded success values.
- Stores transmission logs and privacy-zone stats through encrypted JSON storage.
- Uses privacy-zone redaction, OSRM endpoint blocking, audit-chain hashes, Android hardware-backed tip signing, and signature-aware audit checkpoint export/verify.
- Keeps unknowns distinct from verified protections.

What it cannot establish:

- It does not inspect packets on the wire.
- It does not cryptographically validate every outbound payload against the transmission metadata.
- It cannot protect against a compromised app bundle or malicious same-origin JavaScript.
- An unsigned local audit chain only protects against casual tampering because an attacker with local rewrite access could replace both the chain and anchor.
- A verified signed checkpoint protects against later history rewrites only if the user retains the exported checkpoint file.
- Native Android protections are stronger than the web runtime, but still depend on the app and platform behaving correctly.

Safe product wording:

```txt
Privacy Intelligence is a local dashboard that reports app-recorded privacy activity,
outbound location-sharing evidence, privacy-zone protection counts, local protection checks,
and audit-chain consistency.
```

Unsafe product wording examples to avoid:

```txt
Privacy Intelligence validates every sensitive-data path.
Privacy Intelligence promises that raw coordinates were never sent.
Privacy Intelligence prevents local history rewrites.
The privacy score is an independent security audit.
```

## Main Files

Route:

```txt
/privacy-intelligence
```

Primary files:

```txt
src/pages/PrivacyIntelligence.jsx
src/lib/privacyIntelligence.js
src/lib/deviceStatus.js
src/lib/controlSelfTests.js
src/lib/transmissionLog.js
src/lib/hashChainLog.js
src/lib/privacyZones.js
src/lib/privacyZoneSuggestions.js
src/lib/securePayloadCrypto.js
src/lib/keyRotationManager.js
src/lib/requestObfuscator.js
src/lib/privacyMode.js
src/lib/scoreInputPrivacy.js
src/lib/dataRights.js
src/lib/buildIntegrity.js
src/lib/mapMatching.js
src/lib/osrmPrivacy.js
src/App.jsx
```

Related privacy/security files:

```txt
src/lib/biometricGate.js
src/lib/crashSanitizer.js
src/lib/differentialPrivacy.js
src/lib/encryptedStore.js
src/lib/exportCommitment.js
src/lib/exportIntegrity.js
src/lib/privateTripMode.js
src/lib/rasp.js
src/lib/screenSecurity.js
src/lib/secureBridge.js
src/lib/SecureGpsBuffer.js
src/lib/pinnedFetch.js
src/lib/nativeRoadDataQueue.js
src/lib/nativePlatform.js
src/lib/mobileStorage.js
src/lib/localTripRepository.js
src/lib/trackingStore.js
```

Direct tests:

```txt
src/lib/__tests__/privacyIntelligence.test.js
src/lib/__tests__/transmissionLog.test.js
src/lib/__tests__/privacyZones.test.js
src/lib/__tests__/hashChainLog.test.js
src/lib/__tests__/securePayloadCrypto.test.js
src/lib/__tests__/securePayloadCryptoNative.test.js
src/lib/__tests__/differentialPrivacy.test.js
src/lib/__tests__/requestObfuscator.test.js
src/lib/__tests__/privacyMode.test.js
src/lib/__tests__/rasp.test.js
src/lib/__tests__/settingsImportSecurity.test.js
src/lib/__tests__/trackingStoreDefaults.test.js
src/lib/__tests__/openSourceContext.test.js
src/lib/__tests__/mapMatching.test.js
```

## System-Wide Behavioral Intelligence

Phase 9 adds qualitative intelligence that sits beside the score instead of changing the score formula:

- Timing-pattern exposure uses retained `transmissionLog` timestamps only. It looks for a same-service outbound request pattern across at least 10 distinct days in the last 30 days with local time-of-day standard deviation under 20 minutes. Blocked records are ignored because no network request was sent. Findings live on `protectionSummary.findings`.
- App-update posture regression stores one encrypted snapshot per app version under `drivesense_privacy_posture_snapshots_v1`. On the first `loadPrivacyIntelligence()` after a version change, controls that moved from `ok` or `configured` to `error` or `not_applicable` create a high-priority action-plan item.
- Compound risk flags two or more failing controls in the same layer. This appears as score-card context and does not change the numeric score.

## Heightened Privacy Mode

`heightened_privacy_mode` is a single Settings toggle for sensitive sessions. It changes runtime behavior without asking the user to remember a checklist:

- OSRM route snapping is skipped regardless of saved endpoint or consent.
- Open-Meteo weather and Overpass speed-limit lookups are skipped.
- Request timing obfuscation is treated as on for the session.
- Privacy zones are treated as high sensitivity for the session.

The network gateway also checks the persisted toggle before sending Open-Meteo, Overpass, or OSRM requests. This is a fail-safe for call paths that reach the gateway directly.

## Trip Score Side-Channel Protection

Phase 8 moves privacy-zone masking ahead of trip scoring for completed trips, stored-trip rescoring, native completed-trip import, and road-data score refreshes. The shared helper is `src/lib/scoreInputPrivacy.js`. These paths now run `maskRoutePointsForPrivacy()` and `maskEventsForPrivacy()` before `calculateTripStats()`, `detectDrivingEvents()`, phone-use route context, sensor-fusion route context, weather risk applied to the score, and `calculateTripScores()`.

Trips that touch a privacy zone are marked with `privacy_zone_touched` and `privacy_trend_excluded`. Cross-trip calculations that can leak a protected-day anomaly now exclude the whole trip day:

- Personal baseline, week-over-week deltas, percentile, and personal-best score summaries.
- Repeated-route and commute score trends.
- Monthly calendar score summaries, best/worst day, and drive streaks.
- Weekly coaching and weekly goal score comparisons.
- Habit-profile trend risk and phone-use cross-trip trends.

Audited but not changed: single-trip display fields, live safety alerts, daily fatigue state, and the latest-trip pre-trip-risk hint. Those features are either already tied to an individual trip/day the user is viewing or are active safety context rather than a cross-trip trend or streak.

## Data Rights And Build Identity

Phase 10 adds two user-owned data actions in Settings > Privacy & Data:

- Export Everything creates a versioned JSON portability bundle containing retained trip records, vehicles, current settings, hydrated privacy-zone configuration, and Privacy Intelligence score history. This is the user's own backup/portability file, not a shareable privacy posture summary.
- Erase All Local Data enumerates the app's known local storage keys from the key-rotation manifest and privacy/audit stores, overwrites/removes key-value stores, securely deletes trip records through the existing IndexedDB overwrite-then-delete path, exports a proof-of-erasure receipt, then reloads the app so stale in-memory state is not reused.

The erasure receipt is signed with the native AuditAnchor pattern when native signing is available. Web receipts are explicitly marked unsigned. This is app-level evidence of attempted local erasure; it cannot inspect flash wear-leveling, browser caches, OS backups, a rooted device under attacker control, or a compromised app bundle.

Diagnostics surfaces a build hash for production bundles. The hash is a SHA-256 over the normalized emitted JavaScript bundle, embedded into the built app and emitted as `build-integrity.json`. It helps compare the running artifact with a reviewed/published build, but it is not a complete supply-chain attestation and does not solve the compromised-bundle threat from inside the bundle itself.

## App Routing And Authentication

`src/App.jsx` lazy-loads the page:

```jsx
const PrivacyIntelligence = lazy(() => import('@/pages/PrivacyIntelligence'));

<Route path="/privacy-intelligence" element={(
  <AppRouteBoundary context="privacy_intelligence_page" title="Privacy intelligence unavailable">
    <PrivacyIntelligence />
  </AppRouteBoundary>
)} />
```

The page requires device authentication before loading data:

```jsx
const result = await authenticateDevice('Access Privacy Intelligence');
if (result.verified) {
  setAuthed(true);
  setError('');
  return true;
}
window.history.back();
```

It re-authenticates after the app returns from background if it was away for at least five minutes:

```jsx
CapacitorApp.addListener('appStateChange', ({ isActive }) => {
  if (!isActive) {
    backgroundedAt = Date.now();
    return;
  }
  if (backgroundedAt && Date.now() - backgroundedAt >= 5 * 60 * 1000) {
    setAuthed(false);
    void authenticate();
  }
  backgroundedAt = 0;
});
```

The broader app lock also exists in `src/App.jsx` with:

```txt
authenticateDevice('Verify to open your private driving data')
```

That app-level lock is separate from Privacy Intelligence's page-level authentication.

## Page Surface

The UI has five tabs:

| Tab | Purpose | Backing data |
| --- | --- | --- |
| Overview | Score, action plan, top risks, zone counts, outbound confidence, audit status, threat model dialog. | `loadPrivacyIntelligence()` |
| Transmissions | Search/filter retained outbound records and clear retained records. | `getTransmissionSummary()` and `clearTransmissionLog()` |
| Protections | Filter all controls by status or category. | `getProtectionStatus()` |
| Zones | Show configured zones, protected sample/event counts, raw points still inside zones, stale/untouched zones. | `getZoneStats()` and `buildDrivingPrivacyReadout()` |
| Audit Log | Verify hash-chain consistency, distinguish signed from unsigned checkpoints, show signature coverage, and export/verify retained checkpoints. | `loadPrivacyAuditChain()`, `verifyChain()`, `exportAuditCheckpoint()`, `verifyCheckpoint()` |

The page quietly refreshes every 30 seconds while authenticated:

```jsx
loadData({ quiet: true });
const interval = setInterval(() => loadData({ quiet: true }), 30_000);
return () => clearInterval(interval);
```

## Data Orchestration

The dashboard is assembled by `loadPrivacyIntelligence()` in `src/lib/privacyIntelligence.js`.

```js
export async function loadPrivacyIntelligence() {
  const protections = await getProtectionStatus();
  const score = computePrivacyScoreFromControls(protections);
  const tripsPromise = tripService.listAll({ sort: '-start_time' }).catch(() => []);
  const [trips, transmissions, chain, chainResult] = await Promise.all([
    tripsPromise,
    getTransmissionSummary(),
    loadPrivacyAuditChain(),
    verifyChain(),
  ]);
  const zones = await getZoneStats(trips);
  const recommendations = protections
    .filter((item) => ['error', 'warn', 'unknown'].includes(item.status))
    .sort((a, b) => (
      (RECOMMENDATION_PRIORITY[a.status] ?? 9) - (RECOMMENDATION_PRIORITY[b.status] ?? 9) ||
      (b.weight || 0) - (a.weight || 0)
    ))
    .slice(0, 4);
  const zoneSummary = summarizeZones(zones);
  const drivingReadout = buildDrivingPrivacyReadout(trips, zones);
  const actionPlan = buildPrivacyActionPlan({
    score,
    protections,
    transmissions,
    chainResult,
    zoneSummary,
  });
  return {
    generatedAt: Date.now(),
    score,
    protections,
    protectionSummary: {
      active: protections.filter((item) => item.status === 'ok').length,
      configured: protections.filter((item) => item.status === 'configured').length,
      warnings: protections.filter((item) => item.status === 'warn').length,
      unknown: protections.filter((item) => item.status === 'unknown').length,
      errors: protections.filter((item) => item.status === 'error').length,
      notApplicable: protections.filter((item) => item.status === 'not_applicable').length,
    },
    recommendations,
    zones,
    zoneSummary,
    drivingReadout,
    transmissions,
    chain,
    chainResult,
    auditSummary: summarizeAudit(chain),
    actionPlan,
  };
}
```

Phase 0 note: `loadPrivacyIntelligence()` now passes the computed `drivingReadout` into `buildPrivacyActionPlan()`, so Overview can surface recent trip-zone mismatch, raw points inside zones, and untouched-zone findings already shown on the Zones tab.

## Privacy Score Model

Statuses and point values:

```js
export const STATUS_POINTS = Object.freeze({
  ok: 1,
  configured: 0.6,
  warn: 0.3,
  unknown: 0,
  error: 0,
  not_applicable: null,
});
```

Layer weights:

```js
const LAYERS = {
  device: { label: 'Device', color: '#10b981', weight: 0.3 },
  network: { label: 'Network', color: '#0ea5e9', weight: 0.25 },
  inference: { label: 'Inference', color: '#8b5cf6', weight: 0.25 },
  integrity: { label: 'Integrity', color: '#f59e0b', weight: 0.2 },
};
```

Layer formula:

```txt
layer_score = round(sum(control_weight * status_points) / sum(applicable_control_weight) * 100)
```

Overall formula:

```txt
overall = round(sum(layer_score * layer_weight) / sum(applicable_layer_weight))
```

`not_applicable` controls are excluded from the layer denominator. Layers with no applicable controls are excluded from the overall denominator.

On the web runtime, the computed score is clamped to 89 after the layer and overall formulas run. This preserves the scoring inputs while keeping browser-only evidence out of the `Strong` band. The score card states: "Capped because this is a web build; install the Android app for hardware-backed checks." Native builds are not clamped.

Score bands:

| Score | Label | UI tone | Meaning |
| ---: | --- | --- | --- |
| null | Unavailable | unknown | No applicable controls could be scored. |
| 90-100 | Strong | ok | Most applicable protections were verified. |
| 75-89 | Good | ok | Protection is solid with some checks to review. |
| 55-74 | Needs review | warn | Several protections are unverified or need attention. |
| 0-54 | At risk | error | Important protections are unavailable or failing. |

Score implementation:

```js
export function computePrivacyScoreFromControls(controls = []) {
  const layers = Object.entries(LAYERS).map(([id, layer]) => {
    const allControls = controls.filter((item) => item.category === id);
    const applicable = allControls.filter((item) => item.status !== 'not_applicable');
    const denominator = applicable.reduce((sum, item) => sum + item.weight, 0);
    const earned = applicable.reduce(
      (sum, item) => sum + item.weight * (STATUS_POINTS[item.status] ?? 0),
      0
    );
    return {
      id,
      label: layer.label,
      color: layer.color,
      score: denominator ? Math.round((earned / denominator) * 100) : null,
      applicableControls: applicable.length,
      totalControls: allControls.length,
    };
  });
  const applicableLayers = layers.filter((layer) => layer.score != null);
  const totalLayerWeight = applicableLayers.reduce((sum, layer) => sum + LAYERS[layer.id].weight, 0);
  const computedOverall = totalLayerWeight
    ? Math.round(applicableLayers.reduce(
      (sum, layer) => sum + layer.score * LAYERS[layer.id].weight,
      0
    ) / totalLayerWeight)
    : null;
  const webCapApplied = !isNativePlatform() && computedOverall != null && computedOverall > 89;
  const overall = webCapApplied ? 89 : computedOverall;
  const summary = Object.fromEntries(
    ['ok', 'configured', 'warn', 'unknown', 'error', 'not_applicable']
      .map((status) => [status, controls.filter((item) => item.status === status).length])
  );
  summary.total = controls.length;
  return {
    overall,
    computedOverall,
    webCapApplied,
    capReason: webCapApplied
      ? 'Capped because this is a web build; install the Android app for hardware-backed checks.'
      : null,
    ...scoreBand(overall),
    layers,
    summary,
  };
}
```

Recommendation status remains the primary sort key. Within the same status, recommendations are ordered by `control weight * category risk multiplier`: device `1.6`, integrity `1.5`, inference `1.2`, and network `1.0`. Device and integrity failures receive more weight because they are harder to notice through another dashboard surface.

The encrypted `drivesense_privacy_score_history_v1` store records the first score loaded on each local calendar day. Each entry contains `timestamp`, `overall`, and `layerScores`; retention is capped at 180 entries. `summarizeScoreTrend()` compares the latest entry with the most recent entry at least 7 and 30 days earlier. A weekly drop greater than 10 points adds a Protections action to the Overview plan.

## Protection Controls

Runtime-tested controls are defined in `CONTROL_REGISTRY`:

```js
const CONTROL_REGISTRY = [
  control('storage_encryption', 'device', 3, 'Storage encryption', checkStorageEncryption, 'Extracted trip data could be readable in plaintext.', 'Verify the secure payload encryption and key-provider paths.'),
  control('secure_deletion', 'device', 2, 'Secure deletion', checkSecureDeletion, 'Deleted application records may remain recoverable.', 'Verify secureDelete() overwrites before logical deletion.'),
  control('cert_pinning', 'network', 2, 'Certificate pinning', checkCertPinning, 'Location-bearing requests could be intercepted by a trusted malicious certificate.', 'Maintain pins for every native external endpoint.'),
  control('bridge_encryption', 'network', 1, 'Bridge encryption', checkBridgeEncryption, 'Sensitive native bridge payloads could be exposed.', 'Verify the encrypted bridge echo round-trip.'),
  control('request_obfuscation', 'network', 1, 'Request timing obfuscation', checkRequestObfuscation, 'Request timing may correlate with trip activity.', 'Verify that obfuscation batches execute successfully.'),
  control('memory_zeroing', 'inference', 1, 'Memory zeroing', checkMemoryZeroing, 'Raw coordinates could remain in process memory after masking.', 'Keep SecureGpsBuffer.zero() in finally blocks.'),
  control('timestamp_fuzzing', 'inference', 2, 'Boundary timestamp fuzzing', checkTimestampFuzzing, 'Boundary times may reveal private arrival or departure patterns.', 'Verify export boundary timestamps are fuzzed.'),
  control('kinematic_nulling', 'inference', 2, 'Kinematic data nulling', checkKinematicNulling, 'Boundary motion fields could help infer private route segments.', 'Keep all recorded kinematic fields in the sanitization list.'),
  control('differential_privacy', 'inference', 2, 'Differential privacy', checkDifferentialPrivacy, 'Repeated aggregate exports could reveal private activity.', 'Verify metric budgets and Laplace noise.'),
  control('commitment_scheme', 'inference', 2, 'Export commitments', checkCommitmentScheme, 'Repeated exports could expose privacy-zone centers.', 'Ensure commitments use fresh salts and exclude coordinates.'),
  control('export_signing', 'integrity', 2, 'Export HMAC signing', checkExportSigning, 'Modified backups could be accepted as authentic.', 'Verify signing keys and tamper rejection.'),
  control('crash_scrubbing', 'integrity', 2, 'Crash report scrubbing', checkCrashScrubbing, 'Crash payloads could disclose GPS coordinates.', 'Keep sensitive key and coordinate patterns current.'),
  control('audit_log', 'integrity', 1, 'Local audit chain', checkAuditLog, 'Privacy operations could be altered without detection.', 'Verify append and chain validation together.'),
  control('root_detection', 'device', 3, 'Root / jailbreak detection', checkDeviceIntegrity, 'A compromised device can weaken every local protection.', null),
  control('key_rotation', 'device', 2, 'Key rotation', getKeyRotationStatus, 'Older encryption keys may remain in use indefinitely.', 'Inspect stored payload key versions and rotation failures.'),
];
```

Setting-backed controls are added separately:

```js
{
  id: 'biometric_gate',
  category: 'device',
  weight: 2,
  status: !native ? 'not_applicable' : biometric ? 'configured' : 'error',
}
{
  id: 'screenshot_prevention',
  category: 'device',
  weight: 1,
  status: !native ? 'not_applicable' : screenSecure ? 'configured' : 'error',
}
{
  id: 'osrm_consent',
  category: 'network',
  weight: 2,
  status: !osrmEnabled ? 'not_applicable' : osrmOutdated ? 'warn' : osrmUnguarded ? 'error' : 'configured',
}
```

Current controls:

| ID | Layer | Weight | Source | Meaning |
| --- | --- | ---: | --- | --- |
| `storage_encryption` | device | 3 | `selfTestStorageEncryption()` | AES-256-GCM canary round trip through secure payload crypto. |
| `secure_deletion` | device | 2 | `selfTestSecureDeletion()` | IndexedDB canary is overwritten/removed via `secureDelete()`. |
| `cert_pinning` | network | 2 | `selfTestCertPinning()` | Native-only pinned host list is configured. |
| `bridge_encryption` | network | 1 | `selfTestBridgeEncryption()` | Native-only encrypted bridge echo test. |
| `request_obfuscation` | network | 1 | `selfTestRequestObfuscation()` | Queue enabled and a batch has completed this session. |
| `memory_zeroing` | inference | 1 | `selfTestMemoryZeroing()` | Route masking increments `SecureGpsBuffer.zero()` call count. |
| `timestamp_fuzzing` | inference | 2 | `selfTestTimestampFuzzing()` | Export boundary timestamp is fuzzed within expected range. |
| `kinematic_nulling` | inference | 2 | `selfTestKinematicNulling()` | Export placeholder removes speed, heading, bearing, accuracy, altitude. |
| `differential_privacy` | inference | 2 | `selfTestDifferentialPrivacy()` | Repeated noisy aggregate samples vary. |
| `commitment_scheme` | inference | 2 | `selfTestCommitmentScheme()` | Zone export commitment omits coordinates and changes across export salts. |
| `export_signing` | integrity | 2 | `selfTestExportSigning()` | Signed canary verifies and tampered payload fails. |
| `crash_scrubbing` | integrity | 2 | `selfTestCrashScrubbing()` | Crash sanitizer removes coordinate canaries. |
| `audit_log` | integrity | 1 | `selfTestAuditLog()` | Appends `SELF_TEST` and verifies the chain. |
| `root_detection` | device | 3 | `checkDeviceIntegrity()` | RASP/native integrity result. Web returns not applicable. |
| `key_rotation` | device | 2 | `getKeyRotationStatus()` | Inspects stored trip payload key versions and rotation log. |
| `biometric_gate` | device | 2 | settings | Native app lock enabled. |
| `screenshot_prevention` | device | 1 | settings | Native screen capture blocked unless user allows it. |
| `osrm_consent` | network | 2 | settings | OSRM is disabled or consent is current and zone guard is enforced. |

Self-test results are cached for 60 seconds in `src/lib/controlSelfTests.js`:

```js
const CACHE_TTL_MS = 60_000;
const cache = new Map();

async function withCache(key, check) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.lastCheckedAt < CACHE_TTL_MS) return cached;
  ...
  cache.set(key, completed);
  return completed;
}
```

## Control Self-Test Snippets

Storage encryption:

```js
export const selfTestStorageEncryption = () => withCache('storage_encryption', async () => {
  const canary = { selfTest: true, timestamp: Date.now(), nonce: Math.random() };
  const encrypted = await encryptSensitiveValue(canary, 'privacy-intelligence:self-test');
  if (!encrypted?.encrypted || encrypted.algorithm !== 'AES-256-GCM') {
    return error('Encrypted payload is missing AES-256-GCM metadata');
  }
  const decrypted = await decryptSensitiveValue(encrypted, 'privacy-intelligence:self-test');
  if (JSON.stringify(decrypted) !== JSON.stringify(canary)) {
    return error('AES-256-GCM canary round-trip did not reproduce the input');
  }
  return ok(`AES-256-GCM round-trip verified via ${encrypted.key_provider || 'unknown provider'}`);
});
```

Memory zeroing:

```js
export const selfTestMemoryZeroing = () => withCache('memory_zeroing', async () => {
  const before = getSecureGpsBufferZeroCallCount();
  maskRoutePointsForPrivacy([...], { privacy_zones: [...] });
  const after = getSecureGpsBufferZeroCallCount();
  return after > before
    ? ok(`SecureGpsBuffer.zero() call count increased from ${before} to ${after}`)
    : error('SecureGpsBuffer.zero() was not invoked by route masking');
});
```

Request obfuscation:

```js
export const selfTestRequestObfuscation = () => withCache('request_obfuscation', async () => {
  const status = getObfuscatorQueueStatus();
  if (!status.enabled) return notApplicable('Request timing obfuscation is disabled');
  if (!status.initialized) return unknown('No obfuscation batch has completed this session');
  return ok(`Last batch processed ${status.lastBatchSize} request(s)`);
});
```

Audit log:

```js
export const selfTestAuditLog = () => withCache('audit_log', async () => {
  const before = await loadPrivacyAuditChain();
  await appendPrivacyEvent({ op: 'SELF_TEST' });
  const after = await loadPrivacyAuditChain();
  if (after.length !== before.length + 1) return error('Audit append did not extend the chain');
  const verification = await verifyChain();
  return verification.valid
    ? ok(`Audit chain extended to ${after.length} entries and verified`)
    : error(`Audit chain failed verification: ${verification.reason}`);
});
```

Device integrity:

```js
export async function checkDeviceIntegrity() {
  try {
    const integrity = await checkIntegrity();
    if (integrity.secure) {
      return {
        status: integrity.native ? 'ok' : 'not_applicable',
        evidence: integrity.native
          ? 'Native integrity check passed with no threats detected'
          : 'Root and jailbreak checks do not apply to the web runtime',
        threats: [],
        source: 'device_integrity',
        lastCheckedAt: Date.now(),
      };
    }
    return {
      status: 'error',
      evidence: `Device integrity threats detected: ${integrity.threats.join(', ')}`,
      threats: integrity.threats,
      source: 'device_integrity',
      lastCheckedAt: Date.now(),
    };
  } catch (integrityError) {
    return {
      status: 'unknown',
      evidence: `Device integrity check unavailable: ${integrityError?.message || 'unknown error'}`,
      threats: [],
      source: 'device_integrity',
      lastCheckedAt: Date.now(),
    };
  }
}
```

## Action Plan

`buildPrivacyActionPlan()` turns score, protection, transmission, audit, zone, and driving evidence into the Overview "What to do next" card.

Priority order:

1. Raw coordinate sends without explicit consent metadata.
2. Invalid audit chain.
3. Failing protection checks.
4. Unverified transmission protection claims.
5. Raw sharing with consent metadata.
6. Warning controls.
7. Unknown controls.
8. No privacy zones.
9. Zones configured but not matching recent drives.
10. Raw saved route samples still inside zones.
11. Untouched zones.

Core snippet:

```js
if (rawWithoutConsent > 0) {
  issues.push({
    id: 'raw_without_consent',
    tone: 'error',
    targetTab: 'transmissions',
    title: 'Review raw-coordinate sends',
    detail: `${rawWithoutConsent} raw-coordinate request${rawWithoutConsent === 1 ? '' : 's'} had no explicit-consent evidence.`,
    action: 'Open transmissions',
  });
}
if (chainResult.valid === false) {
  issues.push({
    id: 'audit_invalid',
    tone: 'error',
    targetTab: 'audit',
    title: 'Audit history needs review',
    detail: chainResult.reason || 'The local audit chain did not verify.',
    action: 'Open audit log',
  });
}
```

Headline logic:

```js
const headline = hasErrors
  ? 'Needs action before privacy claims are trustworthy'
  : hasWarnings
    ? 'Useful, with items to review'
    : hasUnknowns
      ? 'Useful, but evidence is incomplete'
      : 'No urgent privacy issues recorded';
```

## Transmission Logging

Core file:

```txt
src/lib/transmissionLog.js
```

Storage:

```txt
drivesense_transmission_log_v1
```

Retention:

```txt
30 days
500 entries max
```

Allowed coordinate disclosure values:

```js
export const COORDINATE_DISCLOSURE_VALUES = Object.freeze([
  'none',
  'blocked',
  'raw',
  'rounded',
  'bounding_box',
  'masked',
  'committed',
]);
```

Record shape:

```js
const record = {
  id: generateId(),
  timestamp: now,
  service: safeText(entry.service, 'unknown'),
  type: safeText(entry.type, 'Outbound request'),
  coordinateDisclosure: entry.coordinateDisclosure,
  privacyTransformVerified,
  privacyTransformSource,
  privacyVerificationEvidence,
  sentCoords: entry.sentCoords == null ? null : safeText(entry.sentCoords),
  protections: safeArray(entry.protections),
  offsetMeters: entry.offsetMeters == null ? null : safeNumber(entry.offsetMeters, null),
  bytesOut: Math.max(0, Math.round(safeNumber(entry.bytesOut, 0))),
  bytesIn: Math.max(0, Math.round(safeNumber(entry.bytesIn, 0))),
  status: ['safe', 'blocked', 'warning'].includes(entry.status) ? entry.status : 'safe',
  tripId: entry.tripId == null ? null : safeText(entry.tripId),
  zonesSuppressed: safeArray(entry.zonesSuppressed),
  expiresAt: now + EXPIRY_MS,
  schemaVersion: 2,
};
```

Important validation behavior:

- Missing or invalid `coordinateDisclosure` throws.
- Protected disclosures are only verified if `privacyTransformVerified === true`, `privacyTransformSource` exists, and evidence exists for protected disclosures.
- Raw coordinates always create a warning.
- Raw coordinates without an `explicit consent` protection add another warning.
- Blocked records with `sentCoords` or bytes out create a warning.
- Protected disclosures without named evidence are downgraded to unverified/warning.

Warning logic:

```js
function verificationWarningsFor(record) {
  const warnings = [];
  if (record.coordinateDisclosure === 'raw') {
    warnings.push('Raw coordinates left the app; consent or guards do not make this a protected send.');
    if (!record.protections.some((item) => /explicit consent/i.test(item))) {
      warnings.push('Raw coordinate send has no explicit-consent metadata.');
    }
  }
  if (record.coordinateDisclosure === 'blocked' && (record.sentCoords || record.bytesOut > 0)) {
    warnings.push('Blocked transmission includes send metadata that should be empty.');
  }
  if (PROTECTED_DISCLOSURES.has(record.coordinateDisclosure)) {
    if (!record.privacyTransformVerified) {
      warnings.push('Protection is caller-reported but not verified by named pre-send evidence.');
    }
    if (record.privacyTransformVerified && !record.privacyVerificationEvidence.length) {
      warnings.push('Verified protection is missing evidence details.');
    }
  }
  return warnings;
}
```

Logging also appends a sanitized audit-chain event:

```js
await appendPrivacyEvent({
  op: 'TRANSMISSION',
  tripId: record.tripId,
  zoneLabel: record.zonesSuppressed.join(', ') || undefined,
  details: {
    service: record.service,
    status: record.status,
  },
});
```

Clearing retained records now appends an audit event:

```js
export async function clearTransmissionLog() {
  logWriteQueue = logWriteQueue
    .catch(() => {})
    .then(() => setEncryptedJson(TRANSMISSION_LOG_KEY, []));
  await logWriteQueue;
  await appendPrivacyEvent({ op: 'TRANSMISSION_LOG_CLEARED' });
}
```

Legacy v1 migration infers `coordinateDisclosure` from old metadata but marks the evidence unverified:

```js
return {
  ...entry,
  protections,
  coordinateDisclosure,
  privacyTransformVerified: false,
  privacyTransformSource: 'migrated_from_v1',
  privacyVerificationEvidence: [],
  privacyVerificationWarnings: ['Legacy transmission claim was migrated without pre-send verification evidence.'],
  schemaVersion: 2,
};
```

## Transmission Classification

Display privacy level:

```js
export function transmissionPrivacyLevel(entry = {}) {
  if (entry.coordinateDisclosure === 'blocked') return 'blocked';
  if (entry.coordinateDisclosure === 'none') return 'none';
  if (entry.coordinateDisclosure === 'raw') return 'raw';
  return entry.privacyTransformVerified && !(entry.privacyVerificationWarnings || []).length
    ? 'protected'
    : 'unverified';
}
```

Display label:

```js
export function classifyTransmissionForDisplay(entry = {}) {
  if (entry.coordinateDisclosure === 'blocked') return { label: 'Blocked', color: '#ef4444' };
  if (entry.coordinateDisclosure === 'none') return { label: 'No location data', color: '#10b981' };
  if (entry.coordinateDisclosure === 'raw') {
    return (entry.protections || []).includes('explicit consent')
      ? { label: 'Raw - consented', color: '#f59e0b' }
      : { label: 'Raw - REVIEW', color: '#ef4444' };
  }
  return entry.privacyTransformVerified && !(entry.privacyVerificationWarnings || []).length
    ? { label: 'Verified protection', color: '#10b981' }
    : { label: 'Unverified protection claim', color: '#f59e0b' };
}
```

Transmission summary returns:

```txt
entries
totalRawCoords
rawWithConsentCount
rawWithoutConsentCount
protectedTotal
claimedButUnverifiedCount
rawUnverifiedCount
needsReviewTotal
blockedTotal
warningTotal
safeTotal
totalBytesOut
byService
services
todayTotal
weekTotal
latestAt
outboundReadout
```

## Outbound Privacy Readout

Service profiles:

```js
const OUTBOUND_SERVICE_PROFILES = Object.freeze({
  'open-meteo': {
    label: 'Weather context',
    expectedDisclosure: 'rounded',
    enabled: (settings = {}) => settings.weather_context_enabled !== false,
    usefulFor: 'Weather risk for scored trips',
    safeShape: 'One public route point rounded to 4 decimals, after privacy-zone buffer checks.',
  },
  overpass: {
    label: 'OpenStreetMap speed limits',
    expectedDisclosure: 'bounding_box',
    enabled: (settings = {}) => settings.speed_limit_lookup_enabled !== false,
    usefulFor: 'Posted or inferred speed-limit context',
    safeShape: 'Privacy-filtered public road bounding boxes, not raw route traces.',
  },
  osrm: {
    label: 'OSRM route snapping',
    expectedDisclosure: 'raw',
    enabled: (settings = {}) => settings.map_matching_enabled !== false && Boolean(settings.osrm_map_matching_url),
    usefulFor: 'Optional route snapping to roads',
    safeShape: 'Sampled public GPS segments only after consent and privacy-zone endpoint guards.',
  },
  export: {
    label: 'Backup export',
    expectedDisclosure: 'committed',
    enabled: () => true,
    usefulFor: 'Manual backup files',
    safeShape: 'Coordinate-free zone commitments and signed backup metadata.',
  },
});
```

Confidence starts at `100` when retained records exist, otherwise `55`, then subtracts:

```txt
raw without consent: 35 each
raw with consent: 14 each
unverified protection claim: 18 each
warning entries beyond raw entries: 6 each
enabled outbound services without retained evidence: up to 20 total
```

Headline logic:

```js
const headline = rawWithoutConsent.length
  ? 'Do not rely on outbound privacy until raw sends are reviewed'
  : rawEntries.length
    ? 'Raw sharing is visible and needs trust in the endpoint'
    : unverified.length
      ? 'Mostly useful, but some protection claims are unverified'
      : retained.length
        ? 'Retained outbound records are usable'
        : 'No retained outbound evidence yet';
```

Outbound readout findings include:

- `no_retained_outbound_records`
- `raw_without_consent`
- `raw_with_consent`
- `unverified_protection`
- `no_evidence_open-meteo`
- `no_evidence_overpass`
- `no_evidence_osrm`

## Privacy Zones

Core file:

```txt
src/lib/privacyZones.js
```

Important constants:

```js
const EXPORT_NOISE_MIN_M = 10;
const EXPORT_NOISE_MAX_M = 35;
const TIMESTAMP_FUZZ_RANGE_MS = 3 * 60 * 1000;
const PRIVACY_CELL_SIZE_M = 50;
const PRIVACY_CELL_SCHEMA = 'global_grid_v1';
const EXPORT_PRIVACY_ZONE_ID = 'private_area';
const EXPORT_PRIVACY_ZONE_LABEL = 'Private area';
export const PRIVACY_RADIUS_MIN_M = 50;
export const PRIVACY_RADIUS_MAX_M = 1000;
export const PRIVACY_RADIUS_DEFAULT_M = 180;
export const PRIVACY_ZONE_TYPES = Object.freeze(['circle', 'corridor']);
export const PRIVACY_ZONE_SENSITIVITIES = Object.freeze(['standard', 'high']);
export const PRIVACY_CORRIDOR_MIN_WAYPOINTS = 2;
export const PRIVACY_CORRIDOR_MAX_WAYPOINTS = 20;
export const ZONE_STATS_KEY = 'drivesense_privacy_zone_stats_v1';
export const ZONE_EVENT_GUARD_M = 50;
export const PRIVACY_ZONES_SECURE_KEY = 'drivesense_privacy_zones_config_v1';
export const NATIVE_PRIVACY_ZONES_KEY = 'privacy_zones_v1';
export const NATIVE_PRIVACY_ZONES_CONTEXT = 'native:privacy_zones_v1';
```

Kinematic fields removed/nullified around private boundaries:

```js
export const KINEMATIC_FIELDS = Object.freeze([
  'speed',
  'speed_kmh',
  'speedKmh',
  'speed_mps',
  'speedMps',
  'speed_accuracy',
  'speedAccuracy',
  'obd_speed_kmh',
  'heading',
  'heading_accuracy',
  'headingAccuracy',
  'bearing',
  'bearing_accuracy',
  'bearingAccuracy',
  'course',
  'altitude',
  'altitude_m',
  'altitude_accuracy',
  'altitudeAccuracy',
  'vertical_speed',
  'verticalSpeed',
  'vertical_accuracy',
  'verticalAccuracy',
  'accuracy',
  'horizontal_accuracy',
  'horizontalAccuracy',
  'accel_ms2',
  'acceleration_ms2',
  'acceleration_x',
  'acceleration_y',
  'acceleration_z',
  'accelerationX',
  'accelerationY',
  'accelerationZ',
]);
```

Storage model:

- Exact/usable zone memory is held in `privacyZonesMemory`.
- Secure storage writes cell-only zones to `drivesense_privacy_zones_config_v1`.
- Circular zones store cells covering the circle footprint.
- Corridor zones store cells covering the full waypoint polyline plus its configured width; exact corridor waypoints are not written to the redacted Settings record.
- Settings store redacted privacy zones via `redactedPrivacyZones()`.
- Native sync receives cell-hash guards through secure preferences.

Persist and load flow:

```js
async function persistPrivacyZones(zones = []) {
  const normalized = normalizePrivacyZones(zones);
  privacyZonesMemory = normalized;
  await setEncryptedJson(PRIVACY_ZONES_SECURE_KEY, cellOnlyPrivacyZones(normalized));
  await syncZonesToNative(normalized);
  return normalized;
}

export async function savePrivacyZonesToStorage(zones = [], settings = localSettings.get()) {
  const normalized = await persistPrivacyZones(zones);
  localSettings.update({ privacy_zones: redactedPrivacyZones(normalized) });
  return {
    ...settings,
    ...localSettings.get(),
    privacy_zones: redactedPrivacyZones(normalized),
  };
}
```

Native sync fail-closed behavior:

```js
async function failClosedAfterNativePrivacySyncFailure(error, zoneCount) {
  const failedAt = new Date().toISOString();
  let nativeTrackingStopped = false;

  localSettings.update({
    privacy_zones_native_sync_status: NATIVE_PRIVACY_SYNC_STATUS_FAILED,
    privacy_zones_native_sync_failed_at: failedAt,
    privacy_zones_native_sync_zone_count: zoneCount,
    tracking_mode: 'manual',
    auto_tracking_enabled: false,
    background_tracking_enabled: false,
    tracking_paused: false,
  });

  try {
    const { stopNativeAutoTracking } = await import('@/lib/activityRecognition');
    nativeTrackingStopped = await stopNativeAutoTracking();
  } catch (stopError) {
    logSystemFailure('privacy_zones_native_sync_stop_tracking_failed', stopError, {
      zone_count: zoneCount,
    });
  }

  recordSystemEvent('privacy_zones_native_sync_fail_closed', {
    zone_count: zoneCount,
    native_tracking_stopped: nativeTrackingStopped === true,
  }, {
    category: 'privacy',
    severity: 'warn',
    title: 'Native privacy-zone sync failed closed',
    message: 'Background auto tracking was turned off until Android receives the privacy-zone guard.',
  });
}
```

Trip storage redaction:

```js
export function sanitizeTripForPrivacyStorage(trip = {}, settings = localSettings.get()) {
  if (!trip || typeof trip !== 'object') return trip;
  const zones = getPrivacyZones(settings);
  if (!zones.length) return trip;

  const routePoints = Array.isArray(trip.route_points)
    ? trip.route_points.map((point) => redactRoutePointForPrivacyStorage(point, zones))
    : trip.route_points;
  const drivingEvents = Array.isArray(trip.driving_events)
    ? trip.driving_events.map((event) => {
      const zone = isPointInPrivacyZone(event, zones, ZONE_EVENT_GUARD_M);
      return zone
        ? redactCoordinateFieldsForPrivacy(event, zone, { privacy_event_redacted: true })
        : event;
    })
    : trip.driving_events;

  return {
    ...trip,
    ...(Array.isArray(routePoints) ? {
      route_points: routePoints,
      route_points_raw_count: Number(trip.route_points_raw_count) || trip.route_points.length,
      route_points_map_count: routePoints.filter((point) => finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null).length,
    } : {}),
    ...(Array.isArray(drivingEvents) ? { driving_events: drivingEvents } : {}),
  };
}
```

Display masking uses `SecureGpsBuffer` and always zeroes it:

```js
export function maskRoutePointsForPrivacy(routePoints = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) {
    return (Array.isArray(routePoints) ? routePoints : [])
      .map((point) => point?.masked_for_privacy === true ? sanitizeKinematics(point) : point);
  }

  const masked = [];
  const points = Array.isArray(routePoints) ? routePoints : [];
  const coordinateBuffer = new SecureGpsBuffer(points);

  try {
    ...
    return masked;
  } finally {
    coordinateBuffer.zero();
  }
}
```

Export masking replaces boundaries with coordinate-free privacy gaps:

```js
export function replacePrivacyBoundariesWithExportGaps(routePoints = [], exportSalt = createPrivacyExportSalt()) {
  const output = [];
  (Array.isArray(routePoints) ? routePoints : []).forEach((point) => {
    if (!point?.privacy_boundary) {
      output.push(point?.masked_for_privacy === true || point?.privacy_gap === true
        ? sanitizePrivacyPointForExport(point)
        : point);
      return;
    }

    const previous = output.at(-1);
    const zoneId = point.privacy_zone_id || point.zone_id || 'privacy-zone';
    if (previous?.privacy_export_placeholder) return;

    output.push(sanitizePrivacyPointForExport({
      lat: null,
      lng: null,
      timestamp: fuzzBoundaryTimestamp(point.timestamp ?? point.time ?? null, zoneId, exportSalt),
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
    }));
  });
  return output;
}

export function maskRoutePointsForPrivacyExport(routePoints = [], settings = localSettings.get(), exportSalt = createPrivacyExportSalt()) {
  return replacePrivacyBoundariesWithExportGaps(maskRoutePointsForPrivacy(routePoints, settings), exportSalt);
}
```

Deleting a zone can purge raw GPS inside the zone:

```js
export async function purgeGpsWithinPrivacyZone(trips = [], zone, updateTrip) {
  let tripsAffected = 0;
  let pointsPurged = 0;
  let eventsPurged = 0;
  const tripIdsAffected = [];

  for (const trip of Array.isArray(trips) ? trips : []) {
    const result = purgeTripGpsWithinPrivacyZone(trip, zone);
    if (!result.changed) continue;
    ...
  }

  if (tripsAffected > 0) {
    appendPrivacyAuditEvent({
      op: 'PRIVATE_GPS_PURGED',
      zoneId: zone?.id,
      zoneLabel: zone?.label,
      hiddenCount: pointsPurged + eventsPurged,
      details: {
        affected_trip_count: tripsAffected,
        purged_point_count: pointsPurged,
        purged_event_count: eventsPurged,
      },
    });
  }

  return { tripsAffected, pointsPurged, eventsPurged, tripIdsAffected };
}
```

Changing a zone invalidates OSRM consent:

```js
const consentInvalidated = zoneChanged && settings.osrm_data_sharing_consented === true;
if (zoneChanged) void clearMapMatchingCache();
await persistPrivacyZones(next);
const updated = localSettings.update({
  privacy_zones: redactedPrivacyZones(next),
  ...(consentInvalidated ? {
    osrm_data_sharing_consented: false,
    osrm_data_sharing_consented_at: '',
    osrm_consent_invalidated_reason: 'privacy_zone_changed',
    osrm_consent_invalidated_at: new Date().toISOString(),
    osrm_consent_invalidated_zone_label: normalized.label,
  } : {}),
});
```

## Zone Statistics And Driving Readout

Zone stats are derived from saved trip records when trips are available:

```js
export async function getZoneStats(trips = null) {
  const settings = localSettings.get();
  const hydratedZones = await getHydratedPrivacyZones(settings).catch(() => []);
  const zoneSettings = hydratedZones.length ? { ...settings, privacy_zones: hydratedZones } : settings;
  const sourceTrips = Array.isArray(trips)
    ? trips
    : await tripService.listAll({ sort: '-start_time' }).catch(() => []);
  return getZoneStatsSnapshot(zoneSettings, sourceTrips);
}
```

`summarizeZones()` returns:

```txt
zoneCount
pointsToday
eventsToday
pointsWeek
eventsWeek
pointsAllTime
eventsAllTime
activeZoneCount
latestAt
```

`buildDrivingPrivacyReadout()` returns:

```txt
tripCount
recentTripCount
tripsWithProtectedActivity
recentProtectedTripCount
privateEndpointTripCount
protectedPointCount
protectedEventCount
rawPointInsideZoneCount
latestTripAt
recentProtectionRate
untouchedZoneCount
staleZoneCount
zoneSummaries
recommendedChecks
```

It marks these conditions:

- No privacy zones but trips exist.
- Zones exist but recent trips did not cross a zone.
- Zones configured but never protected a saved trip.
- Zones have no activity in the last 90 days.
- Saved local route samples still sit inside a configured privacy zone.

## Audit Chain

Core file:

```txt
src/lib/hashChainLog.js
```

Storage:

```txt
drivesense_privacy_audit_chain_v1
drivesense_privacy_audit_anchor_v1
```

Genesis hash:

```js
export const GENESIS_HASH = '0'.repeat(64);
```

Sensitive detail keys are blocked:

```js
const SENSITIVE_KEY = /(^|[_-])(lat|lng|longitude|latitude|coordinate|coordinates|radius|radius_m|route_points|driving_events|address|email|phone|token|password|secret)($|[_-])/i;
```

Allowed detail keys:

```js
const DETAIL_ALLOWLIST = new Set([
  'affected_trip_count',
  'event_count',
  'failure_count',
  'hidden_event_count',
  'hidden_point_count',
  'native_tracking_stopped',
  'point_count',
  'privacy_gap_count',
  'privacy_zone_count',
  'purge_raw_gps',
  'purged_event_count',
  'purged_point_count',
  'purged_trip_count',
  'reason',
  'segment_count',
  'service',
  'snapped_coverage',
  'status',
  'trip_count',
  'zone_count',
]);
```

Entry normalization:

```js
function normalizePrivacyEvent(event = {}, seq, prevHash) {
  const details = sanitizeDetails({ ...event.details, ...event });
  return removeUndefined({
    schema: AUDIT_SCHEMA,
    seq,
    timestamp: safeNumber(event.timestamp, Date.now()),
    op: safeString(event.op || event.operation || event.type, 'PRIVACY_EVENT'),
    zone_id: safeString(event.zoneId ?? event.zone_id, undefined),
    zone_label: safeString(event.zoneLabel ?? event.zone_label, undefined),
    hidden_count: safeNumber(event.hiddenCount ?? event.hidden_count, 0) || 0,
    trip_id: safeString(event.tripId ?? event.trip_id, undefined),
    details: Object.keys(details).length ? details : undefined,
    prevHash,
  });
}
```

Append flow:

```js
export async function appendPrivacyEvent(event = {}) {
  const state = await readAuditState();
  const current = await verifyAuditState(state);
  if (!current.valid) {
    throw new Error(`Audit log verification failed before append: ${current.reason}`);
  }

  const prevHash = state.chain.length > 0 ? state.chain[state.chain.length - 1].hash : GENESIS_HASH;
  const body = normalizePrivacyEvent(event, state.chain.length + 1, prevHash);
  const entry = {
    ...body,
    hash: await sha256hex(canonicalStringify(body)),
  };
  if (isNativePlatform()) {
    try {
      const signed = await AuditAnchor.signTipHash({ tipHash: entry.hash });
      entry.tipSignature = signed.signature || null;
      entry.signingPublicKey = signed.publicKey || null;
    } catch {
      entry.tipSignature = null;
      entry.signingPublicKey = null;
    }
  }
  const chain = [...state.chain, entry];
  await writeRaw(PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(chain));
  await writeRaw(PRIVACY_AUDIT_ANCHOR_KEY, JSON.stringify({
    schema: AUDIT_SCHEMA,
    length: chain.length,
    tip: entry.hash,
    updated_at: Date.now(),
  }));
  return entry;
}
```

Verification checks:

- Audit log JSON parses.
- Audit log is an array.
- Anchor JSON parses.
- Non-empty chain has an anchor.
- Sequence numbers are continuous.
- Each `prevHash` points to the previous entry hash.
- Each `hash` is present and 64 lowercase hex characters.
- Recomputed SHA-256 hash matches stored hash.
- Anchor length matches chain length.
- Anchor tip matches the final hash.

Checkpoint export:

```js
export async function exportAuditCheckpoint() {
  const chain = await loadPrivacyAuditChain();
  if (!chain.length) throw new Error('Audit chain is empty');
  const tip = chain.at(-1);
  const exportedAt = Date.now();
  const checkpoint = {
    schema: 'ds_audit_checkpoint_v1',
    seq: tip.seq,
    tip_hash: tip.hash,
    signature: tip.tipSignature || null,
    signing_pubkey: tip.signingPublicKey || null,
    chain_length: chain.length,
    exported_at: exportedAt,
  };
  await writeRaw('drivesense_last_checkpoint_export_at', String(exportedAt));
  return checkpoint;
}
```

Checkpoint verification:

```js
export async function verifyCheckpoint(checkpoint = {}) {
  // Signature metadata is checked first. Android uses AuditAnchor.verifyTipHash;
  // web verification imports signing_pubkey and verifies ECDSA P-256 with WebCrypto.
  const signatureStatus = checkpoint.signature && checkpoint.signing_pubkey
    ? await verifyCheckpointSignature(...) ? 'verified' : 'invalid'
    : 'unsigned';
  // The retained tip hash is then compared with the currently verified chain.
  return { valid: true, signatureStatus, verifiedAt: Date.now() };
}
```

Honest limitation: a verified signed checkpoint protects against later history rewrites if the user retains the exported file. An unsigned chain only protects against casual tampering because the chain and local anchor can be rewritten together. Neither mode is equivalent to a server-side append-only log.

## Storage Encryption

Core file:

```txt
src/lib/securePayloadCrypto.js
```

Encrypted payload metadata:

```txt
encrypted: true
version: 1
key_version
algorithm: AES-256-GCM
key_provider
ciphertext
iv, for web payloads
```

Android path:

```js
if (isAndroid()) {
  const result = await secureCall('SecureBridge', 'encryptSensitivePayload', {
    plaintext,
    context,
    keyVersion,
  });
  return {
    encrypted: true,
    version: ENCRYPTION_VERSION,
    key_version: keyVersion,
    algorithm: 'AES-256-GCM',
    key_provider: 'android-keystore',
    ciphertext: result.ciphertext,
  };
}
```

Web path:

```js
const key = await getWebKey(keyVersion);
const iv = api.getRandomValues(new Uint8Array(12));
const additionalData = new TextEncoder().encode(context);
const ciphertext = await api.subtle.encrypt(
  { name: 'AES-GCM', iv, additionalData },
  key,
  new TextEncoder().encode(plaintext)
);
return {
  encrypted: true,
  version: ENCRYPTION_VERSION,
  key_version: keyVersion,
  algorithm: 'AES-256-GCM',
  key_provider: 'webcrypto-nonextractable',
  iv: bytesToBase64(iv),
  ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
};
```

Unsupported native platforms throw instead of silently storing sensitive data with unsupported crypto:

```js
const assertSupportedNativeCrypto = () => {
  if (!isNativePlatform() || isAndroid()) return;
  throw new Error(
    `Native secure payload encryption is not implemented for ${getNativePlatform()}. ` +
    'Add a platform-backed secure crypto plugin before storing sensitive GPS data.'
  );
};
```

Encrypted JSON helpers:

```js
export async function getEncryptedJson(key, fallback) {
  const stored = await getJson(key, null);
  if (stored == null) return fallback;
  if (isEncryptedPayload(stored)) {
    return decryptSensitiveValue(stored, `storage:${key}`);
  }

  await setEncryptedJson(key, stored);
  return stored;
}

export async function setEncryptedJson(key, value, options = {}) {
  const encrypted = await encryptSensitiveValue(value, `storage:${key}`, options);
  await setJson(key, encrypted);
}
```

Web limitation: non-extractable WebCrypto keys prevent direct key export but do not stop compromised same-origin JavaScript from calling the decrypt function.

## Key Rotation

Core file:

```txt
src/lib/keyRotationManager.js
```

Policy:

```js
export const KEY_ROTATION_DAYS = 30;
export const KEY_ROTATION_MS = KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
```

Encrypted JSON keys rotated:

```js
const ROTATING_ENCRYPTED_JSON_KEYS = [
  'drivesense_active_trip',
  'drivesense_last_parked',
  'drivesense_privacy_zone_stats_v1',
  'drivesense_privacy_zones_config_v1',
  'drivesense_transmission_log_v1',
];
```

Rotation also imports and calls `rotateTripEncryptionKey(nextVersion)` from `src/lib/localTripRepository.js`.

Rotation status now inspects stored trip payload key versions:

```js
export async function getKeyRotationStatus() {
  const [versions, rotationLog, activeKeyVersion] = await Promise.all([
    inspectStoredTripKeyVersions(),
    loadRotationLog(),
    getActiveEncryptionKeyVersion(),
  ]);
  const lastRotation = rotationLog.at(-1) || null;
  const rotationErrors = rotationLog.filter((entry) => entry.status === 'error');

  if (!versions.length) {
    return {
      status: lastRotation?.status === 'error' ? 'error' : 'unknown',
      evidence: lastRotation?.status === 'error'
        ? `Latest key rotation failed: ${lastRotation.error || 'unknown error'}`
        : 'No encrypted trip records were available to inspect',
      activeKeyVersion,
      oldestPayloadKeyVersion: null,
      newestPayloadKeyVersion: null,
      payloadsPendingRotation: 0,
      lastRotationAt: lastRotation?.completedAt || null,
      rotationErrors: rotationErrors.length,
    };
  }
  ...
}
```

This is stronger than a pure setting check, but still depends on complete visibility into stored encrypted records.

## Request Obfuscation

Core file:

```txt
src/lib/requestObfuscator.js
```

Timing:

```js
const BATCH_MIN_MS = 3 * 60 * 1000;
const BATCH_MAX_MS = 9 * 60 * 1000;
const INTER_REQUEST_MIN_MS = 800;
const INTER_REQUEST_MAX_MS = 3500;
const DECOY_MIN_COUNT = 1;
const DECOY_MAX_COUNT = 3;
```

Behavior:

- If `request_obfuscation_enabled === false`, requests run immediately.
- Otherwise requests are queued for a random 3-9 minute delay.
- Native road-data requests can be delegated to `runNativeRoadDataRequest()`.
- First-party decoys only run when `decoy_traffic_mode === 'first_party'`.
- Decoys use Open-Meteo neutral coordinates.
- Decoys are best-effort and cannot change real request outcomes.

Key snippet:

```js
export function enqueueLocationRequest(tag, fn, nativeRequest = null) {
  if (typeof fn !== 'function') {
    return Promise.reject(new TypeError('Location request must be a function.'));
  }
  if (localSettings.get()?.request_obfuscation_enabled === false) return fn();

  if (nativeRequest?.url) {
    const delay = randomInt(BATCH_MIN_MS, BATCH_MAX_MS);
    return runNativeRoadDataRequest(tag, nativeRequest, delay)
      .then((result) => result ?? enqueueLocationRequest(tag, fn))
      .catch(() => fn());
  }

  const result = new Promise((resolve, reject) => {
    queue.push({
      tag: String(tag || 'location'),
      fn,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    });
  });
  if (!timer) scheduleBatch();
  return result;
}
```

Honest limitation: timing obfuscation is a speed bump, not anonymity.

## OSRM Privacy

Core files:

```txt
src/lib/mapMatching.js
src/lib/osrmPrivacy.js
src/pages/Settings.jsx
```

Public demo endpoint:

```js
export const PUBLIC_OSRM_DEMO_URL = 'https://router.project-osrm.org';

export function isPublicOsrmDemoUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    return url.hostname.toLowerCase() === 'router.project-osrm.org';
  } catch {
    return false;
  }
}
```

Route snapping guard order:

1. Disabled setting returns `disabled`.
2. Missing endpoint returns `needs_endpoint`.
3. Public demo endpoint returns `public_demo_blocked`.
4. Missing consent returns `needs_consent`.
5. Privacy filtering removes private points.
6. Private route endpoint near a privacy zone blocks the OSRM request and logs a blocked transmission.
7. Not enough public points blocks the request and logs a blocked transmission.
8. Valid public segments are sent to the configured endpoint.

Blocked private endpoint logging:

```js
if (nearPrivateEndpoint) {
  await logTransmission({
    service: 'osrm',
    type: 'Route matching',
    coordinateDisclosure: 'blocked',
    privacyTransformVerified: true,
    privacyTransformSource: 'mapMatching.js:always_on_privacy_zone_guard',
    privacyVerificationEvidence: ['route endpoint was inside the privacy-zone guard buffer'],
    sentCoords: null,
    protections: ['route endpoint near privacy zone - request blocked'],
    bytesOut: 0,
    status: 'blocked',
    zonesSuppressed: zones.map((zone) => zone.label),
  });
  appendOsrmAuditEvent({
    op: 'OSRM_SKIPPED_PRIVACY_ENDPOINT',
    details: {
      status: 'blocked_private_endpoint',
      privacy_zone_count: zones.length,
    },
  });
  return {
    routePoints: osrmRoutePoints,
    status: 'blocked_private_endpoint',
    provider: 'osrm',
    isOsrmDemoUrl,
  };
}
```

Blocked due to privacy gaps or too few public points:

```js
await logTransmission({
  service: 'osrm',
  type: 'Route matching',
  coordinateDisclosure: 'blocked',
  privacyTransformVerified: true,
  privacyTransformSource: 'mapMatching.js:splitAtNullPoints',
  privacyVerificationEvidence: ['privacy filtering left no matchable public route segment'],
  sentCoords: null,
  protections: [gapCount ? 'privacy gaps left no route segment to send' : 'not enough public points - request blocked'],
  offsetMeters: null,
  bytesOut: 0,
  status: 'blocked',
  tripId: null,
  zonesSuppressed: osrmRoutePoints
    .map((point) => point?.privacy_zone_label)
    .filter(Boolean),
});
```

Honest limitation: consented OSRM sends can still reveal sampled public route segments to the configured endpoint. This should be described as "controlled raw sharing after consent", not as a private OSRM workflow.

## Audit Operations Shown In UI

`src/pages/PrivacyIntelligence.jsx` maps audit operations to user-facing labels:

```js
const auditLabels = {
  TRANSMISSION: ['External request recorded', 'An outbound request was added to the privacy history.'],
  PRIVATE_GPS_PURGED: ['Private GPS purged', 'Saved GPS samples inside a privacy zone were removed.'],
  POINTS_SUPPRESSED: ['GPS samples suppressed', 'Private route samples were excluded from a public view or export.'],
  EVENTS_SUPPRESSED: ['Driving events suppressed', 'Driving events inside a privacy zone were excluded.'],
  ZONE_SAVED: ['Privacy zone saved', 'A privacy-zone configuration was created or updated.'],
  ZONE_DELETED: ['Privacy zone deleted', 'A privacy-zone configuration was removed.'],
  OSRM_SKIPPED: ['Route matching skipped', 'OSRM route matching did not send coordinates.'],
  OSRM_MATCHED: ['Route matching completed', 'Public route segments were sent to the configured OSRM service.'],
};
```

Other operations can still appear as title-cased fallback labels.

## UI Details

Important UI copy and behavior:

- Header: "Review local privacy activity, protection checks, and recorded outbound data. This shows what the app recorded leaving the device."
- V2 banner: "Privacy Intelligence now checks protection status from local evidence."
- Score card label: "Local evidence posture."
- Score disclaimer: "Local evidence only. Unknown checks are not evidence of safety."
- Overview can export a signed Privacy Report JSON containing the current score, summaries, five user-facing recommendations, audit status, and an embedded checkpoint.
- Action plan claim can explicitly say "Treat this as local transparency, not a security assurance."
- Audit tab says local verification can reveal local history changes, but it cannot stop local rewrites.
- Zones tab explains that counts come from redacted records saved with each trip and refreshing the page does not increment them.

Transmissions tab features:

- Clear retained records.
- Search by service, type, sent-coordinate shape, protection text, and verification source.
- Filter by privacy level.
- Filter by service.
- Show service-level outbound readout and findings.
- Show per-entry warnings and evidence.

Protections tab features:

- Filter by status or category.
- Show verified, unverified, warnings, failing summary cards.
- Error, warning, and unknown controls expose a one-tap "What should I do?" panel with `riskIfMissing` and `userAction`.
- `developerAction` appears only in development mode or when `VITE_SHOW_DEBUG_ROUTES=true`.
- Request Timing Obfuscation has an info tooltip explaining that first-party decoy mode creates additional real Open-Meteo requests.
- OSRM consent evidence distinguishes disabled route matching from current consent with active privacy-zone exclusion.
- Show key rotation details when available:

```txt
Active v{activeKeyVersion}
Oldest v{oldestPayloadKeyVersion}
Pending {payloadsPendingRotation}
```

Zones tab features:

- Suggest frequent trip start/end clusters only after at least five distinct occurrence days.
- Return and display only aggregate center, radius, occurrence count, and first/last seen times, never the underlying endpoint list.
- Allow suggestions to be dismissed for 90 days using encrypted local suppression storage.
- Show raw near-miss counts just outside each zone and the smallest capped radius that would include them.
- Accept opens the existing Settings zone form with the suggested aggregate center and radius prefilled; the user must still save it.

Audit tab features:

- Chain consistency banner.
- Export checkpoint.
- Verify checkpoint from `.json`.
- Search entries.
- Filter by operation.

## Privacy Intelligence Data Contracts

Top-level `loadPrivacyIntelligence()` result:

```txt
generatedAt: number
score: PrivacyScore
scoreHistory: PrivacyScoreHistoryEntry[]
scoreTrend: PrivacyScoreTrend
protections: ProtectionControl[]
protectionSummary: ProtectionSummary
recommendations: ProtectionControl[]
zones: PrivacyZoneStats[]
zoneSummary: ZoneSummary
drivingReadout: DrivingPrivacyReadout
zoneSuggestions: PrivacyZoneSuggestion[]
transmissions: TransmissionSummary
chain: AuditEntry[]
chainResult: ChainVerification
auditSummary: AuditSummary
actionPlan: PrivacyActionPlan
```

`AuditSummary` includes:

```txt
todayTotal
weekTotal
latestAt
lastCheckpointExportedAt
signatureCoverage
operations
```

`ProtectionControl` important fields:

```txt
id
category
weight
label
status
evidence
value
detail
action
lastCheckedAt
source
riskIfMissing
userAction
developerAction
rotation, for key_rotation
```

`PrivacyActionPlan`:

```txt
headline
tone
scoreLabel
claim
primaryAction
issues[]
```

## Smart Zone Suggestions And Effectiveness

`getPrivacyZoneSuggestions()` uses only locally stored trip route endpoints and performs no network requests.

A stop cluster becomes eligible only when:

```txt
distinct occurrence days >= 5
endpoint distance within the default privacy radius
no existing privacy zone center within PRIVACY_RADIUS_MAX_M
no active 90-day dismissal fingerprint for the aggregate center
```

The returned object intentionally excludes clustered points:

```txt
suggestedCenter
suggestedRadiusM
occurrenceDays
firstSeenAt
lastSeenAt
```

The suggested radius is the smallest radius covering 90% of clustered endpoints, clamped to `PRIVACY_RADIUS_MIN_M` and `PRIVACY_RADIUS_MAX_M`. Dismiss stores only an encrypted opaque fingerprint and expiry in `drivesense_privacy_zone_suggestion_dismissals_v1`.

`getZoneEffectiveness(zone, trips)` checks raw route points and events between the saved radius and `radius + ZONE_EVENT_GUARD_M * 2`. It returns only:

```txt
nearMissCount
suggestedRadiusM
```

No cluster point list or near-miss coordinate is rendered in Privacy Intelligence.

## Advanced Zone Types And Leak-Free Creation

Existing zones normalize to `type: 'circle'` and `sensitivity: 'standard'`, so previously saved circles keep their existing behavior.

Corridor zones contain:

```txt
type: corridor
waypoints: 2-20 ordered local points
width_m: 50-1000
```

`isPointInPrivacyZone()` computes point-to-polyline distance for exact corridor geometry. Masking, storage redaction, purge, kinematic nulling, weather/Overpass guards, and OSRM filtering continue to call the same zone predicate. Cell-only storage covers the corridor footprint so those call sites do not need corridor-specific branches.

Any zone may include `expiresAt`. Expired zones are swept at app startup and each foreground transition. The sweep purges saved raw GPS and events through `purgeGpsWithinPrivacyZone()`, writes the existing `PRIVATE_GPS_PURGED` audit event when records are affected, marks affected trips for rescoring, and then removes the zone.

Sensitivity behavior:

- `standard`: existing masking and OSRM exclusion behavior.
- `high`: purges matching saved raw GPS when saved and blocks the entire OSRM request when any route segment touches the zone, regardless of general OSRM consent.

The editor intentionally has no address-search or remote-geocoder path. It accepts current location, parked location, local frequent-stop suggestions, or locally stored trip geometry. The zone editor also has no map-tile preview, so creating a zone does not silently reveal the viewed private region to a tile provider. Other app maps that use OpenStreetMap tiles retain their existing provider disclosure.

## Privacy Report Export

`src/lib/privacyReport.js` builds the shareable report payload and wraps it with the existing `signExport()` integrity envelope. It does not introduce another signing format.

The payload contains:

```txt
format
version
header
generatedAt
score, including capNote when the web ceiling applies
protectionSummary
recommendations[0..4], including riskIfMissing and userAction
zoneSummary
drivingReadout highlights
audit.chainResult
audit.signatureStatus
auditCheckpoint
```

The header reuses the safe product wording from this document. The embedded `auditCheckpoint` can be passed to `verifyCheckpoint()` later while the signed export envelope can be checked with `verifyExport()`.

`OutboundPrivacyReadout`:

```txt
confidence
tone
headline
retainedCount
latestAt
protectedCount
blockedCount
rawCount
rawWithConsent
rawWithoutConsentCount
unverifiedCount
warningCount
enabledWithoutEvidenceCount
serviceSummaries[]
findings[]
generatedAt
```

## Test Coverage

Direct Privacy Intelligence tests currently cover:

- Transmission privacy classification: blocked, none, protected, unverified, raw.
- Score computation that excludes `not_applicable` controls and renormalizes layers.
- Zone summary aggregation.
- Trip-derived privacy readout and raw point detection inside zones.
- Audit activity summary.
- Transmission summary for raw, consented raw, and unverified records.
- Outbound confidence and service-level readout.
- Enabled outbound services with no retained evidence.
- Privacy action-plan priority ordering.

`src/lib/__tests__/transmissionLog.test.js` covers:

- Typed v2 records.
- Audit append without coordinate leakage.
- Committed export records.
- Raw warnings.
- Write queue and clear event.
- Invalid `coordinateDisclosure` rejection.
- Verified-protection downgrade when evidence/source is missing.
- Legacy migration behavior.

`src/lib/__tests__/privacyZones.test.js` covers:

- Display masking.
- Export masking.
- Boundary placeholders and timestamp fuzzing.
- Purging raw GPS inside deleted zones.
- Cell-only zone behavior.
- OSRM exclusion defaults.
- OSRM consent invalidation.
- Native sync-related behavior.

Related tests cover hash-chain integrity, crypto, differential privacy, request obfuscation, OSRM/public endpoint behavior, settings import sanitization, and tracking-store defaults.

Recommended commands:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

For a narrower check:

```bash
npm run test -- src/lib/__tests__/privacyIntelligence.test.js src/lib/__tests__/transmissionLog.test.js src/lib/__tests__/privacyZones.test.js src/lib/__tests__/hashChainLog.test.js
```

## Known Gaps And Risks

High-priority gaps:

- `loadPrivacyIntelligence()` passes `drivingReadout` into `buildPrivacyActionPlan()`, and regression tests cover the Overview zone/trip action-plan findings.
- Transmission logging is caller-reported metadata. More call-site tests should compare actual payload shape with logged `coordinateDisclosure`, `privacyTransformVerified`, and evidence.
- The dashboard does not inspect network packets.
- Audit checkpoints are still user-retained and local-only. Losing the exported file removes the independent reference needed to detect a coordinated local chain-and-anchor rewrite.
- Request obfuscation reports `unknown` until a batch completes in the current session.
- Unknown controls must remain visually and verbally distinct from OK.
- Web runtime storage is materially weaker than Android Keystore-backed storage.
- Key rotation now inspects trip payload versions, but coverage depends on repository inspection completeness.
- The UI is polished enough to feel authoritative, so copy must keep saying local evidence rather than proof.

Threats Privacy Intelligence can help with:

- Accidental privacy regressions.
- Unnoticed raw-coordinate sharing.
- Missing app lock or screenshot prevention.
- Stale OSRM consent after privacy-zone changes.
- Simple local audit-log corruption.
- Saved raw route samples that still fall inside privacy zones.
- Lack of retained evidence for enabled outbound services.

Threats it does not fully solve:

- Compromised app bundle.
- XSS or malicious same-origin JavaScript.
- Rooted device controlled by an attacker.
- Attacker who can rewrite the local chain and anchor when no retained signed checkpoint is available.
- Malicious OSRM/weather/road-data endpoint.
- Network observer outside app control.
- Incorrect call-site metadata that marks unsafe payloads as protected.
- Legal or regulatory compliance by itself.

## Manual Verification Checklist

Use this checklist before making privacy/security claims:

```txt
[ ] Open Privacy Intelligence and confirm device authentication is required. (automated: see src/pages/__tests__/PrivacyIntelligence.test.jsx; manual: real native biometric prompt)
[ ] Background the app for at least five minutes and confirm re-authentication. (automated: see src/pages/__tests__/PrivacyIntelligence.test.jsx; manual: physical backgrounding)
[ ] Toggle app lock and screen-capture settings and confirm protections update. (automated defaults/import guard: see src/lib/__tests__/trackingStoreDefaults.test.js; manual: native setting toggles)
[x] Add a privacy zone and confirm it appears on Zones. (automated: see src/lib/__tests__/privacyZones.test.js and src/pages/__tests__/PrivacyIntelligence.test.jsx)
[x] Save or seed a trip crossing the zone and confirm protected GPS/event counts. (automated: see src/lib/__tests__/privacyZones.test.js)
[x] Confirm raw saved samples inside zones are flagged. (automated: see src/lib/__tests__/privacyIntelligence.test.js)
[x] Delete a zone with purge enabled and confirm audit event plus trip rescore marker. (automated: see src/lib/__tests__/privacyZones.test.js)
[x] Trigger Open-Meteo and Overpass lookups and confirm retained records are protected or unverified accurately. (automated: see src/lib/__tests__/externalContracts.test.js)
[x] Configure OSRM endpoint and consent, then confirm raw sharing is labeled raw with consent. (automated: see src/lib/__tests__/externalContracts.test.js)
[x] Try a route endpoint inside a zone and confirm OSRM is blocked and logged as blocked. (automated: see src/lib/__tests__/mapMatching.test.js and src/lib/__tests__/externalContracts.test.js)
[x] Clear transmission records and confirm TRANSMISSION_LOG_CLEARED appears in audit log. (automated: see src/lib/__tests__/transmissionLog.test.js)
[x] Export an audit checkpoint, change nothing, verify it successfully. (automated: see src/lib/__tests__/hashChainLog.test.js)
[x] Confirm a signed Android checkpoint reports a verified signature and an unsigned web checkpoint is labeled unsigned rather than invalid. (automated: see src/lib/__tests__/hashChainLog.test.js)
[ ] Tamper with audit storage in devtools and confirm chain verification fails. (automated mutation coverage: see src/lib/__tests__/hashChainLog.test.js; manual: devtools interaction)
[x] Confirm Settings rejects or blocks public OSRM demo use for saved settings. (automated: see src/lib/__tests__/mapMatching.test.js and src/lib/__tests__/trackingStoreDefaults.test.js)
[x] Confirm imported settings cannot restore untrusted OSRM endpoint/consent. (automated: see src/lib/__tests__/settingsImportSecurity.test.js)
```

## Release-Ready Claims

Reasonable:

```txt
Privacy Intelligence shows local protection checks, privacy-zone activity,
outbound location-sharing records, and local audit-chain consistency.
```

Reasonable:

```txt
The dashboard flags raw coordinate sends, unverified protection claims,
unknown controls, failed controls, and stale OSRM consent.
```

Reasonable:

```txt
Privacy-zone changes invalidate OSRM raw-coordinate consent and clear map-matching cache.
```

Not reasonable:

```txt
The app validates that no private data ever left the device.
```

Not reasonable:

```txt
The privacy score is a security assurance, independent audit, or external validation result.
```

Not reasonable:

```txt
Audit logs prevent local history rewrites.
```

## Priority Fix List

Done in Phase 0: Pass `drivingReadout` into `buildPrivacyActionPlan()` inside `loadPrivacyIntelligence()` so Overview includes zone/trip findings already computed for the Zones tab.

P0: Add call-site tests for every `logTransmission()` call. Each test should assert actual payload shape and logged fields agree.

P0: Keep unknown as unknown in every UI, report, PDF, and README claim.

Done in Phase 2: Verify Android hardware-backed checkpoint signatures, surface signed/unsigned/invalid status, track signature coverage, and remind users to retain checkpoints.

P1: Make all outbound service records typed at source with:

```txt
coordinateDisclosure
privacyTransformVerified
privacyTransformSource
privacyVerificationEvidence
privacyVerificationWarnings
```

Done in Phase 3: Cap the web runtime score at 89 after normal computation, risk-weight same-status recommendations, and retain one encrypted score snapshot per local day for trend reporting.

Done in Phase 4: Add user guidance for every review-status control, a signed Privacy Report with an embedded checkpoint, the request-obfuscation decoy tooltip, and distinct OSRM disabled/current-consent evidence.

Done in Phase 5: Add mixed-status component coverage for all five tabs plus authentication rejection, success, and background timeout behavior.

Done in Phase 5: Link the manual checklist to automated zone, purge, outbound-service, OSRM guard, transmission-clear, checkpoint, and settings-import regression tests while retaining explicit human checks for native prompts, physical backgrounding, and devtools tampering.

Done in Phase 6: Add local-only frequent-stop zone suggestions, encrypted 90-day dismissals, Settings prefill, and per-zone near-boundary radius tuning without displaying underlying cluster or near-miss coordinates.

Done in Phase 7: Add cell-hashed route corridors, foreground-swept temporary zones, high-sensitivity purge/OSRM overrides, and a zone editor with no remote address geocoding or private-region tile preview.

P2: Add documentation/tooltips explaining that request obfuscation decoys can create extra Open-Meteo traffic when enabled.

## Bottom Line

Privacy Intelligence is a strong transparency layer for this app. It has real implementation behind it: gateway-verified transmission records, local protection checks, privacy-zone masking and purging, encrypted local storage, key rotation evidence, OSRM guards, and signature-aware hash-chain checkpoint verification.

It should still be described as local evidence and user transparency, not as proof-grade privacy assurance. The next serious improvement is broader automated UI and integration coverage.
