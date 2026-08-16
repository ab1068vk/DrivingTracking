# P1 — Diagnostics Storage: implementation record

Authoritative plan: `agent-investigation/SHARED_P1_IMPLEMENTATION_PLANNING.md`

Status: **active P1 implementation; Chunk 1 is in progress.**

Scope: diagnostics-history storage for `performanceTriage`, `systemLog`, and
`appExperienceDiagnostics` only. P0 remains available through P7; physical validation is deferred to the
single FINAL DEVICE VALIDATION campaign after P7.

Conventions:

- Re-read the planning and implementation files immediately before appending.
- Use `[CODEX]` and `[CLAUDE]` entries; never edit or impersonate the other reviewer.
- Do not copy P0 history or the old investigation debate here; reference authoritative phase files only.
- Add changed-file, test, migration, security/privacy, and review evidence only after both P1 planning
  approval lines are `APPROVE` and implementation is explicitly authorized.
- Do not record physical-device evidence here; P1 has no standalone device gate.

P1 implementation was authorized after both planning approvals became `APPROVE`. Production diagnostic
callers remain unchanged while the shared storage foundation is built and reviewed.

## [CODEX] Chunk 1 — diagnostics storage foundation

Status: **implementation complete; awaiting Claude adversarial review.**

Changed files:

- `src/lib/diagnosticsStorage.js` — new dependency-free IndexedDB foundation.
- `src/lib/__tests__/diagnosticsStorage.test.js` — 10 focused foundation contracts.
- `src/lib/__tests__/helpers/fakeIndexedDb.js` — injectable in-memory IndexedDB test adapter.
- this ledger only. No existing diagnostic recorder, getter, exporter, UI caller, P0 schema/analyzer, native,
  or P2+ source was changed in this chunk.

Implemented behavior:

- Freezes `roadsage_diagnostics` version 1, `events` (`eventUid` key) and `meta` (`key` key), all five
  Revision-2 compound indexes, `MAX_FLUSH_BATCH=64`, and `MAX_PRUNE_DELETES_PER_TX=128`.
- Provides injected IndexedDB, clock, and UID boundaries without importing `systemLog`, performance,
  app-experience, reporting, P0, or storage-domain modules. Unavailable/open-blocked/error states reject for
  later adapter-level degrade/fallback handling rather than recursively logging.
- Prepares live records and deterministic `migration:<kind>:<generation>:<ordinal>` records while preserving
  the supplied payload reference and approved internal fields. Persistent `ingestSeq` is absent from pending
  prepared records and allocated only inside the event+meta read-write transaction.
- Inserts no more than 64 prepared events per transaction. It point-reads only the batch UIDs plus one
  high-water meta row; it never invokes `getAll`, parses/sorts/stringifies retained history, or scans a store.
- Same-UID retries return the committed row and sequence without another write or sequence increment.
  A different logical row with the same UID aborts instead of overwriting history. Concurrent read-write
  transactions are serialized by IndexedDB across the shared `events`+`meta` stores.
- The generic transaction wrapper requires all request scheduling to be synchronous, attaches completion,
  error, and abort handlers before waiting, and rejects an async scheduler. It does not add any P0 phase;
  truthful phase placement remains Chunk 7 work.

Test-first and verification evidence:

- Initial focused run failed because `@/lib/diagnosticsStorage` did not exist, establishing the production
  boundary before implementation.
- Self-review found that an invalid injected UID (`undefined`) became a misleading string. A new contract
  test failed 1/10, then passed after the factory boundary was corrected to require a non-empty string.
- `npx vitest run src/lib/__tests__/diagnosticsStorage.test.js --pool=forks --maxWorkers=1 --reporter=verbose`
  — **10 passed**.
- `npx eslint src/lib/diagnosticsStorage.js src/lib/__tests__/diagnosticsStorage.test.js
  src/lib/__tests__/helpers/fakeIndexedDb.js --max-warnings 0` — **clean**.
- Raw integrity check — all four Chunk-1 files are LF-only, have final newlines, and contain no trailing
  whitespace. `git diff --check` exits 0 but is not treated as sole evidence because these files are untracked.

Self-review findings:

- Schema names/key paths/index order match Revision 2 exactly. Stable retry identity and monotonic sequence
  allocation are atomic in the same transaction; oversized/malformed batches fail before a transaction.
- The production module has zero imports and no production caller references it yet, so cold boot and all
  existing diagnostic behavior remain unchanged.
- No unresolved Chunk-1 defect or contract deviation remains. Open retry/backoff and bounded fallback belong
  to Chunk 6; migration/checksum/cutover/tombstones belong to Chunk 2; domain pending queues belong to Chunks
  3–5; and P0 phase instrumentation belongs to Chunk 7.

**CODEX P1 CHUNK 1 SELF-REVIEW: PASS**

**CLAUDE P1 CHUNK 1 REVIEW: PENDING**

Claude: please adversarially inspect the actual Chunk-1 source and tests and return `PASS` or `REVISE` with
concrete source-backed defects. Do not review or authorize later chunks; none has started.

## [CODEX] Repository-state transition

- Previous branch: `main`.
- New branch: `LOADTIME_UX_UI_FIXS`; newly created directly from the current `main` HEAD.
- The pre-switch and post-switch working trees match: 11 modified tracked files and 38 untracked files.
  The existing Chunk-1 foundation, focused test, fake adapter, and this ledger survived the switch unchanged;
  their pre/post SHA-256 hashes matched before this repository-state entry was appended.
- No merge, reset, rebase, stash, discard, cleanup, or commit was used. Nothing was merged into `main`.
- No Chunk-2 implementation or other P1 production change was started during the transition. Claude's
  Chunk-1 review remains pending and was not initiated as part of this repository-only task.
