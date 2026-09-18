# Key Lifecycle and Secure Bridge

Two security mechanisms documented together because they both define trust boundaries.

Canonical sources: `src/lib/securePayloadCrypto.js`, `src/lib/keyRotationManager.js`,
`src/lib/browserKeyReferences.js`, `src/lib/secureBridge.js`; on Android
`DriveSensePayloadCrypto`, `DriveSenseEnvelopeKeyRotation`, `SecureBridgePlugin`,
`SecureBatchContract`, `SecureBatchDispatcher`.

---

# Key lifecycle

## Model

Trip payloads are encrypted at rest. Payload keys are wrapped by a key-encryption key (KEK), so
rotating the wrapping key does not require rewriting every route payload.

| Concept | Meaning |
|---|---|
| Payload key | Encrypts an individual record's payload |
| Key-encryption key (KEK) | Wraps payload keys |
| Key reference | A durable pointer from a record to the key that protects it |
| Active key version | The version new writes use |
| Rotation log | Bounded record of rotation outcomes (capped at 20 entries) |

`browserKeyReferences.js` maintains the browser-side reference inventory. On Android,
`DriveSenseEnvelopeKeyRotation` performs envelope rewrap.

## Rotation

Rotation is a **bounded, resumable** operation with explicit state, not a single sweeping
transaction. It proceeds in turns admitted by the work coordinator.

Rotation rewraps envelopes; it does **not** rewrite route payloads. That is what keeps rotation
affordable on a large archive.

## Fail-closed retirement

The defining invariant: **an old key is not retired until all references to it are proven
resolved.** If reference accounting is dirty, unknown or incomplete, rotation refuses to retire
and reports the unresolved state.

This is deliberately conservative. Retiring a key whose references are unproven would render the
affected records permanently unreadable. Unknown is treated as unsafe, never as zero.

## Recovery and backup interaction

Rotation state is durable, so an interrupted rotation resumes rather than restarting. Backups are
bound to the key state that produced them; see
[../data/BACKUP_AND_RESTORE.md](../data/BACKUP_AND_RESTORE.md).

Erasure must remove key material together with the data it protects; leaving a usable key behind
would undermine the erasure guarantee.

## Diagnostics

Diagnostics reports key state observationally: active key version, native phase, pending count and
a recorded error count derived from the capped rotation log. It is read-only — it cannot retire a
key, prove references, or mutate rotation state.

## Testing

`keyRotationBoundedConvergence`, `keyRotationReferenceAccounting`, `keyAdmissionOwnership`,
`keyFinalizationAdmission`, `rootKeyProducerInventory`, `securePayloadCrypto*`, and the Android
rotation-fault suites.

---

# Secure bridge

## Purpose

The bridge between the web layer and native code is a **trust boundary**. `SecureBridgePlugin`
and `src/lib/secureBridge.js` define an envelope protocol for crossing it rather than passing
free-form objects.

## Envelope model

Calls are wrapped in envelopes that carry their own identity and integrity information. The native
side validates an envelope before acting on it, so a malformed or unexpected payload is rejected
at the boundary rather than deep inside a handler.

`SecureBatchContract` and `SecureBatchDispatcher` define batching: multiple operations may cross
in one batch under a declared contract, which bounds bridge chatter without weakening validation.

## Size limits

Both request and response sizes are bounded. The archive plugin enforces request ceilings
(distinguishing normal from large requests) and a maximum response size, and reports the actual
response byte count alongside the cap. An oversized request or response is refused rather than
truncated silently.

## Responsibilities

| Side | Responsibility |
|---|---|
| Web | Construct well-formed envelopes; handle typed refusals |
| Native | Validate before acting; enforce size ceilings; return typed outcomes |

## Failure semantics

A refusal is typed and distinguishable. In particular, "the plugin does not implement this" is
distinct from "the probe failed" — Diagnostics relies on that distinction to avoid reporting a
bridge failure as a normal unavailable state.

## Guarantees and limits

The bridge provides structural validation, bounded payloads and typed failures at the
web-to-native boundary. It is not a defence against a compromised device or a modified
application binary; app-integrity concerns are handled separately by the RASP and screen-security
controls described in
[PRIVACY_AND_DATA_HANDLING.md](PRIVACY_AND_DATA_HANDLING.md).

## Testing

`secureBridge`, `secureBridgePhases`, `SecureBatchContractTest`, `SecureBatchDispatcherTest`,
`DriveSenseArchivePluginArgumentContractTest`, and the SecureBridge envelope instrumentation
tests.
