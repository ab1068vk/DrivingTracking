# Error and Failure Model

Architectural failure semantics. This is not a catalogue of every exception; it is the set of
rules that decide how Road Sage behaves when something goes wrong.

## Core principles

1. **Fail closed on authority.** When the system cannot prove a fact, it reports that it cannot,
   rather than assuming the convenient answer.
2. **Absence is not success.** A missing status row, an unreachable owner or a rejected call is
   reported as `unavailable` — never as `idle`, `complete` or zero.
3. **Durability before acknowledgement.** Bytes are persisted and verified before the producer is
   told the work is done.
4. **Retryable by default.** Interrupted durable work retains its obligation instead of being
   discarded.
5. **Critical paths log rather than swallow.** Post-trip and persistence failures route through
   `logError` / `src/lib/systemLog.js`.

## Failure domains

| Domain | Typical failures | Behaviour |
|---|---|---|
| Location capture | Sample rejected, permission lost, GPS unavailable | Point rejection reason recorded; capture arms or stops explicitly; no fabricated movement |
| Active capture | Process replaced mid-trip | Checkpoint reconciled on next start; session resumes |
| Trip admission | Interrupted commit, unacknowledged journal entry | Entry retried; acknowledgement only after verified persistence |
| Migration ingress | Interrupted chunk, duplicate chunk, reset attempt | Durable index monotonic; duplicates and resets refused |
| Archive recovery | Failed bootstrap | Retryable within the incarnation; completion flag set only after success |
| Deletion / unlink | Failed file unlink | Debt retained and retried; fenced by live operations |
| Query | Store unavailable, snapshot moved mid-count | Population reported unavailable with a reason; torn totals refused |
| Derived state | Job turn throws, version mismatch | Backlog retained; domain reported stale or unavailable, never falsely complete |
| Key lifecycle | References cannot be proven resolved | Rotation fails closed; a key is not retired on unproven evidence |
| Backup import | Truncated, unknown or untrusted payload | Treated as untrusted; note-truncating imports require explicit confirmation |
| Native bridge | Plugin unavailable, probe failure | Distinguished: unimplemented is `false`, probe failure is unknown/`null` |
| Permissions | Denied or revoked | Feature reports unavailable rather than degrading silently |
| Network enrichment | Provider unreachable, pin mismatch | Optional enrichment is skipped; core capture is unaffected |

## Retryable versus terminal

**Retryable:** interrupted ingress, unacknowledged journal entries, failed unlinks, failed
derived-state turns, failed bootstrap, transient enrichment failures.

**Terminal (refused, not retried):** duplicate or out-of-sequence chunks, reset-to-zero attempts,
stale activity intents after a deliberate stop, imports failing integrity validation, rotation
where reference resolution cannot be proven.

The distinction matters: retrying a terminal refusal would defeat the invariant that produced it.

## Fail-open versus fail-closed

| Concern | Posture |
|---|---|
| User data durability | Fail closed |
| Authority and identity | Fail closed |
| Key retirement | Fail closed |
| Erasure completeness | Fail closed |
| Optional context enrichment | Fail open — skip and continue |
| Presentation of low-confidence values | Fail closed — report unavailable rather than guess |

## Diagnostics representation

Diagnostics exposes failure state without exposing failure *content*: categories, counts and
explicit `unavailable` states, but no raw error text or stack traces. Health counting is driven by
severity and authoritative category — an informational event named "error" or "freeze" does not
count as a failure, and Android process exits are classified by the operating system's exit
reason.

## Troubleshooting paths

| Symptom | Where to look |
|---|---|
| Trips not appearing | Journal/admission state; archive recovery state in Diagnostics |
| Capture not starting | Durable enabled flag, permissions, activity/location evidence |
| Score missing or approximate | Confidence level and provenance on the score |
| Totals missing | Population availability and reason |
| Replay unavailable | Replay evidence state: expired vs privacy-excluded vs unavailable |
| Derived values stale | Domain readiness: `required_version` vs `applied_version` |

See [../development/DEBUGGING.md](../development/DEBUGGING.md) and
[../architecture/DIAGNOSTICS.md](../architecture/DIAGNOSTICS.md).
