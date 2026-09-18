import { getJson, setJson } from '@/lib/mobileStorage';

/**
 * AUD-007 — browser key-version reference accounting.
 *
 * Rotation used to delete a superseded key version after consulting a single consumer.
 * Every other persistent domain that still held ciphertext under that version — the
 * RSAS route spool's wrapped DEK, the P6 derived stores, speed knowledge, and several
 * encrypted-JSON documents — became permanently unreadable, and the destroyed version
 * was then silently re-minted as a *different* random key, so the failure surfaced as an
 * anonymous GCM authentication error far from its cause.
 *
 * This module owns the invariant that replaces that:
 *
 *   A browser key version may be deleted only after EVERY registered persistent domain
 *   has proven zero live references to it, and no writer that began before the fence can
 *   still publish one.
 *
 * Two properties matter more than convenience here:
 *
 * 1. **Unknown means RETAIN.** A domain that throws, is absent, or cannot answer is
 *    counted as "may still reference", never as "probably absent". A retained key costs
 *    storage; a deleted key costs the user's data.
 * 2. **Omission must be structurally hard.** Domains *self-register* at module load —
 *    the same idiom `registerP6BrowserDerivedReclaimer` already uses — so a new
 *    encrypted store is wired in where it is written, not in a hand-maintained list
 *    somewhere else that the next author will not find.
 *
 * This module must never import the crypto layer: the crypto layer imports it, and the
 * destroyed-version ledger has to be readable **without** a key.
 */

/** Plaintext on purpose: knowing a key is gone must not require that key. */
const DESTROYED_VERSIONS_KEY = 'drivesense_destroyed_key_versions_v1';

/** Plaintext index of encrypted documents that have actually been written. */
const ENCRYPTED_DOCUMENT_INDEX_KEY = 'drivesense_encrypted_document_index_v1';

/** @type {Map<string, {id: string, countReferences: Function, rewrapStep: Function|null}>} */
const domains = new Map();

/** In-flight writers that began before the current fence. */
let inFlightWrites = 0;

// ─── Finalization admission (round 4) ────────────────────────────────────────
//
// Round 3 counted writers and consulted that count INSIDE the proof. That cannot close
// the window the defect actually lives in, because the window opens when the proof
// RETURNS: proof says zero, a real writer then enters and captures the outgoing version,
// deletion happens, and the writer publishes durable ciphertext under a key that no
// longer exists. The next read fails with `KEY_VERSION_DESTROYED`, far from the cause.
//
// The invariant: once final proof begins for V, no NEW writer may acquire V until proof
// and deletion complete together, or abort and force re-proof.
//
// This is admission control, not a global application lock. Finalization is bounded (a
// bounded proof plus an O(1) delete), a writer waits only for that window, and a drain
// that does not complete ABORTS the deletion rather than waiting longer — retaining the
// key, which is the safe direction.

let finalizationInProgress = false;
/** @type {Array<() => void>} */
const admissionWaiters = [];
/** @type {Array<() => void>} */
const drainWaiters = [];

/** How long finalization will wait for already-admitted writers before giving up. */
const WRITER_DRAIN_TIMEOUT_MS = 250;

const reopenAdmission = () => {
  finalizationInProgress = false;
  admissionWaiters.splice(0).forEach((resolve) => resolve());
};

const noteWriterReleased = () => {
  if (inFlightWrites === 0) drainWaiters.splice(0).forEach((resolve) => resolve());
};

export function isBrowserKeyFinalizationInProgress() {
  return finalizationInProgress;
}

/**
 * Round 5. The epoch a multi-turn zero-reference PROOF is valid against.
 *
 * A proof watermark says "everything before this key is clean". That statement is only
 * true relative to the writers that existed when it was made: a writer admitted afterwards
 * can insert an old-version row BEHIND the watermark, and a later turn resuming from it
 * would walk straight past and conclude zero. Persistent progress must not outlive the
 * causal generation it proved.
 *
 * Only writers that can CREATE a reference advance it. A rewrap moves existing references
 * forward onto the incoming version and never publishes a new reference to the outgoing
 * one, so counting it here would restart every sweep forever and a large store could never
 * be proven clean.
 */
let referenceCreationEpoch = 1;

/**
 * Round 6. A durable watermark cannot be qualified by a process-local counter.
 *
 * The epoch alone was unsafe across restarts: a watermark persisted at epoch 1, a writer
 * advanced the runtime epoch to 2 and inserted behind that watermark, the process
 * restarted, the counter began again at 1 — and the stale cursor aliased as valid. A
 * durable proof must be tied to an identity that cannot repeat.
 *
 * This identity is minted fresh per process and never reused, so a restart invalidates
 * every persisted proof cursor. That costs a bounded re-scan and buys correctness: proof
 * progress may only be trusted when it is provably causally continuous with the process
 * that produced it.
 */
const RUNTIME_PROOF_GENERATION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function getBrowserKeyReferenceEpoch() {
  return referenceCreationEpoch;
}

/**
 * The full identity a durable proof watermark must be stamped with.
 * @returns {{generation: string, epoch: number}}
 */
export function getBrowserKeyProofGeneration() {
  return { generation: RUNTIME_PROOF_GENERATION, epoch: referenceCreationEpoch };
}

/** Is a persisted watermark still causally valid? */
export function isBrowserKeyProofGenerationCurrent(stamp) {
  return stamp?.generation === RUNTIME_PROOF_GENERATION
    && Number(stamp?.epoch) === referenceCreationEpoch;
}

/**
 * Register a persistent domain that can hold ciphertext under a root key version.
 *
 * @param {{
 *   id: string,
 *   countReferences: (version: number) => Promise<number>,
 *   rewrapStep?: ((version: number, targetVersion: number, cursor: any) => Promise<{rewrapped: number, cursor: any, hasMore: boolean}>)|null,
 * }} domain
 */
export function registerBrowserKeyReferenceDomain(domain) {
  if (!domain?.id || typeof domain.countReferences !== 'function') {
    throw new TypeError('A browser key reference domain needs an id and countReferences()');
  }
  domains.set(domain.id, {
    id: domain.id,
    countReferences: domain.countReferences,
    rewrapStep: typeof domain.rewrapStep === 'function' ? domain.rewrapStep : null,
  });
}

/** Test seam only. Production code registers at module load and never unregisters. */
export function resetBrowserKeyReferenceDomainsForTests() {
  domains.clear();
  inFlightWrites = 0;
  referenceCreationEpoch += 1;
  reopenAdmission();
  drainWaiters.splice(0).forEach((resolve) => resolve());
}

export function listRegisteredKeyReferenceDomainIds() {
  return [...domains.keys()];
}

/**
 * Mark the start of a write that may publish a reference to the current key version.
 *
 * Final deletion cannot prove zero references while such a writer is outstanding: it may
 * have captured the old version before the rotation fence and not yet committed. This is
 * a *counter*, not a lock — it never blocks application work, it only withholds the
 * deletion proof, so bounded progress is preserved.
 *
 * @returns {() => void} release, safe to call once
 */
export function beginBrowserKeyWrite({ createsReferences = true } = {}) {
  if (createsReferences) referenceCreationEpoch += 1;
  inFlightWrites += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    noteWriterReleased();
  };
}

/**
 * Round 4. Await admission, then hold it for the whole capture-to-publication span.
 *
 * A writer that arrives while a version is being finalized WAITS here rather than
 * capturing a version that is about to be destroyed; when admission reopens it captures
 * the surviving version instead. This is the entry point every real producer uses —
 * protecting one helper and leaving another producer outside the protocol would leave the
 * defect exactly where it was.
 *
 * @returns {Promise<() => void>} release, safe to call once
 */
export async function admitBrowserKeyWrite(options = {}) {
  // Re-entrancy, and why the guard is `inFlightWrites === 0`.
  //
  // Moving admission out to the durable transaction boundary means one publication now
  // spans nested helpers that admit for themselves — a stage-bucket write inside an
  // explicit replacement, a projection encode inside a trip commit. If a nested acquire
  // blocked on a finalization that is waiting for the OUTER writer to drain, the two would
  // wait on each other forever, and "the app stopped saving" is a worse outcome than the
  // defect this whole invariant exists to prevent.
  //
  // Skipping the wait while another writer is in flight is safe, not a loophole:
  // finalization cannot complete its drain while `inFlightWrites > 0`, so it will refuse
  // the deletion regardless of who else is admitted meanwhile. Once the drain genuinely
  // succeeds there are no writers left, `inFlightWrites` is zero, and an arriving producer
  // waits properly and captures the surviving version.
  while (finalizationInProgress && inFlightWrites === 0) {
    await new Promise((resolve) => admissionWaiters.push(resolve));
  }
  return beginBrowserKeyWrite(options);
}

/**
 * **The** canonical API for durable, root-key-bound publication.
 *
 * Round 6 collapses several lower-level calls into one primitive, because every round of
 * this defect has been the same shape: a producer nobody remembered to wrap. One clearly
 * named entry point means a new durable encrypted producer has one obvious thing to call,
 * and the structural guard can enforce that it did.
 *
 * The version is handed IN rather than looked up by the caller, so a caller cannot capture
 * a version before it owns admission — the ordering that made this defect recur.
 *
 * Contract:
 *  - admission is acquired first, and blocks while a finalization is open;
 *  - the active key version is resolved INSIDE admission and passed to the callback;
 *  - the token is held through the durable commit;
 *  - failure releases it, so a throwing producer cannot wedge rotation;
 *  - a delayed writer that waited resumes against the surviving version, never the
 *    doomed one it would have captured.
 *
 * @template T
 * @param {(context: {keyVersion: number}) => Promise<T>} publish
 * @param {{createsReferences?: boolean}} [options]
 * @returns {Promise<T>}
 */
const DURABLE_PUBLICATION = Symbol('durableKeyPublication');

/**
 * The capability a publication hands to the code that runs inside it.
 *
 * AUD-007 REDESIGN. Rounds 3-7 all failed the same way: the invariant lived in prose and
 * in a guard, so a new persistent write could be added to an already-correct module and
 * silently encrypt outside admission. CODEX found exactly that twice more, in
 * `runLegacyBrowserRawGpsRetention()` and `writeTripSummariesToDb()`.
 *
 * So the invariant now lives in the SIGNATURE. A persistent encoder demands one of these,
 * and only an open publication can produce one. Forgetting to admit is no longer a
 * reviewer-spotted omission — there is nothing to pass, and a handle that outlives its
 * publication throws instead of encrypting.
 */
class DurableKeyPublication {
  constructor(keyVersion) {
    this.keyVersion = keyVersion;
    this.open = true;
    this[DURABLE_PUBLICATION] = true;
  }

  close() {
    this.open = false;
  }
}

/**
 * Demand a live publication before producing durable root-key-bound ciphertext.
 *
 * Two distinct refusals, because they are two distinct mistakes: `REQUIRED` means a
 * persistent encoder was called with no publication at all (the CODEX bypass shape);
 * `CLOSED` means one leaked past the commit it belonged to and is being reused, which is
 * the `encrypt -> release -> commit later` shape wearing a handle.
 *
 * @param {unknown} publication
 * @param {string} operation name reported in the failure
 * @returns {DurableKeyPublication}
 */
export function assertDurablePublication(publication, operation) {
  if (!publication || !publication[DURABLE_PUBLICATION]) {
    throw Object.assign(
      new Error(`${operation} requires an open durable key publication`),
      { code: 'DURABLE_PUBLICATION_REQUIRED', operation },
    );
  }
  if (!publication.open) {
    throw Object.assign(
      new Error(`${operation} used a durable key publication that has already been released`),
      { code: 'DURABLE_PUBLICATION_CLOSED', operation },
    );
  }
  return /** @type {DurableKeyPublication} */ (publication);
}

/** True for a live publication handle; used by tests and by defensive branches. */
export function isDurablePublicationOpen(publication) {
  return Boolean(publication && publication[DURABLE_PUBLICATION] && publication.open);
}

export async function withDurableKeyPublication(publish, options = {}) {
  const release = await admitBrowserKeyWrite(options);
  let keyVersion = null;
  try {
    // Resolved under admission. The dynamic import keeps this module free of a static
    // dependency on the crypto layer, which imports this one.
    const { getActiveEncryptionKeyVersion } = await import('@/lib/securePayloadCrypto');
    keyVersion = await getActiveEncryptionKeyVersion();
  } catch {
    keyVersion = null;   // the producer falls back to the layer's own resolution
  }
  const publication = new DurableKeyPublication(keyVersion);
  try {
    return await publish(publication);
  } finally {
    // Closed BEFORE the token is released, so a handle captured by a continuation that
    // runs after the commit cannot encrypt even for the instant admission is still true.
    publication.close();
    release();
  }
}

/**
 * (Superseded doc — see the definition above.)
 * The publication boundary is the DURABLE COMMIT, not the encryption.
 *
 * Round 6 wrapped the encoders, so the real lifetime was
 * `capture → encrypt → release → (later) durable commit`, and CODEX proved the gap: a
 * writer produced v1 wrappers, admission was already false, v1 was deleted, and the
 * writer then committed v1 ciphertext that nothing could read.
 *
 * `publish` must therefore not return until the authoritative commit boundary has been
 * reached — an IndexedDB transaction's completion event, a `Preferences.set` that has
 * resolved, a `setJson` that has resolved. A queued request is not a commit; an open
 * transaction is not a commit; returning bytes is certainly not a commit.
 *
 * This is the same primitive as `withDurableKeyPublication` — the separate name exists so
 * the structural guard can require that a producer's raw encryption and its durable commit
 * live inside ONE callback, which is the property that was missing.
 *
 * @template T
 * @param {(context: {keyVersion: number}) => Promise<T>} publish must include the commit
 * @param {{createsReferences?: boolean}} [options]
 */


/**
 * Close admission for `version`, drain admitted writers, prove, delete, reopen.
 *
 * Every exit path reopens admission. A drain that does not complete, or a proof that does
 * not come back zero, returns `{deleted: false}` with a reason and leaves the key alive:
 * refusing to delete is always recoverable, deleting a referenced key is not.
 *
 * @param {number} version
 * @param {(version: number) => Promise<void>} deleteVersion
 * @returns {Promise<{deleted: boolean, reason?: string, counts?: Record<string, number>}>}
 */
export async function finalizeBrowserKeyVersionDeletion(version, deleteVersion, options = {}) {
  const normalized = Math.max(0, Number(version) || 0);
  if (!normalized) return { deleted: false, reason: 'invalid_version' };
  if (finalizationInProgress) return { deleted: false, reason: 'finalization_in_progress' };

  const drainTimeoutMs = Math.max(0, Number(options.drainTimeoutMs ?? WRITER_DRAIN_TIMEOUT_MS));
  finalizationInProgress = true;
  try {
    if (inFlightWrites > 0) {
      // Bounded wait. The timeout is an ABORT, not a correctness guarantee: if it fires
      // the writers are still outstanding and the key is kept.
      await Promise.race([
        new Promise((resolve) => drainWaiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, drainTimeoutMs)),
      ]);
    }
    if (inFlightWrites > 0) return { deleted: false, reason: 'writers_did_not_drain' };

    const proof = await proveZeroBrowserKeyReferences(normalized);
    if (!proof.zero) {
      return { deleted: false, reason: proof.blockedBy || 'unproven_references', counts: proof.counts };
    }

    await deleteVersion(normalized);
    return { deleted: true, counts: proof.counts };
  } finally {
    reopenAdmission();
  }
}

export function hasInFlightBrowserKeyWrites() {
  return inFlightWrites > 0;
}

/**
 * Fail-safe zero-reference proof for `version`.
 *
 * @param {number} version
 * @returns {Promise<{zero: boolean, unknown: string[], counts: Record<string, number>, blockedBy: string|null}>}
 */
export async function proveZeroBrowserKeyReferences(version) {
  const normalized = Math.max(0, Number(version) || 0);
  const counts = {};
  const unknown = [];

  if (hasInFlightBrowserKeyWrites()) {
    // A pre-fence writer can still publish an old-version reference after a domain's
    // cursor has passed. Rescanning would not see it; refusing the proof does.
    return { zero: false, unknown, counts, blockedBy: 'in_flight_writer' };
  }

  for (const domain of domains.values()) {
    try {
      const count = Number(await domain.countReferences(normalized));
      if (!Number.isFinite(count) || count < 0) {
        unknown.push(domain.id);
        continue;
      }
      counts[domain.id] = count;
    } catch {
      // Unknown is not absence.
      unknown.push(domain.id);
    }
  }

  // Re-check the fence: a writer may have begun *during* the scan above.
  if (hasInFlightBrowserKeyWrites()) {
    return { zero: false, unknown, counts, blockedBy: 'in_flight_writer' };
  }

  const referencing = Object.entries(counts).filter(([, count]) => count > 0).map(([id]) => id);
  const blockedBy = unknown.length ? `unknown:${unknown.join(',')}`
    : referencing.length ? `references:${referencing.join(',')}`
      : null;

  return { zero: unknown.length === 0 && referencing.length === 0, unknown, counts, blockedBy };
}

/**
 * Advance one bounded rewrap turn per domain that offers one.
 *
 * Each domain owns its own page/byte ceiling, so a larger archive produces more turns
 * rather than a larger turn. A domain without a `rewrapStep` simply keeps reporting its
 * references, which keeps the key retained — that is the safe direction.
 *
 * @param {number} version the version being retired
 * @param {number} targetVersion the version to rewrap onto
 * @returns {Promise<{rewrapped: number, hasMore: boolean, failed: string[]}>}
 */
export async function stepBrowserKeyRewrap(version, targetVersion, cursors = {}) {
  let rewrapped = 0;
  let examined = 0;
  let hasMore = false;
  const failed = [];
  const nextCursors = { ...cursors };

  const fromVersion = Math.max(0, Number(version) || 0);
  const toVersion = Math.max(1, Number(targetVersion) || 1);

  for (const domain of domains.values()) {
    if (!domain.rewrapStep) continue;
    try {
      // Round 4: the step is handed its own continuation and returns the next one.
      // Without this each turn restarted at the first key, so a turn's budget was spent
      // re-examining rows it had already migrated and the tail was never reached.
      // Round 5: a rewrap is itself a producer — it decrypts under the outgoing version
      // and publishes under the incoming one. Holding admission here covers every
      // domain's rewrap publication in one place rather than per domain.
      const outcome = await withDurableKeyPublication(() => domain.rewrapStep({
        fromVersion,
        toVersion,
        cursor: cursors[domain.id] ?? null,
        rowBudget: Number(cursors.rowBudget) || undefined,
      }), { createsReferences: false });
      rewrapped += Math.max(0, Number(outcome?.rewrapped) || 0);
      examined += Math.max(0, Number(outcome?.examined) || 0);
      if (outcome?.hasMore === true) hasMore = true;
      nextCursors[domain.id] = outcome?.cursor ?? null;
      if (outcome?.blocked) failed.push(domain.id);
    } catch {
      failed.push(domain.id);
      // Keep whatever continuation the domain had: a failed turn must not silently
      // rewind progress that is already durable.
      nextCursors[domain.id] = cursors[domain.id] ?? null;
    }
  }

  // Round 3: `hasMore` now DEFERS finalization, which makes it a livelock surface. A
  // domain that keeps reporting more work while moving nothing would stall rotation
  // forever, so the rule is enforced here rather than trusted to each domain: more work
  // is only claimed when this turn actually moved something. A stalled rewrap falls
  // through to the zero-reference proof, fails it, and retains the key — which is safe.
  return { rewrapped, examined, hasMore: hasMore && rewrapped > 0, failed, cursors: nextCursors };
}

// ─── Destroyed-version ledger ────────────────────────────────────────────────
//
// A destroyed version must never be silently re-minted under the same id. Without this,
// `loadOrCreateWebKey` generates a fresh random key for the missing version, old
// ciphertext fails to authenticate, and nothing distinguishes "this key was destroyed"
// from "this key never existed".

const readDestroyed = async () => {
  const stored = await getJson(DESTROYED_VERSIONS_KEY, null);
  if (stored === null) return [];
  if (!Array.isArray(stored)) throw new Error('DESTROYED_KEY_LEDGER_UNREADABLE');
  return stored.map((v) => Number(v) || 0).filter(Boolean);
};

/**
 * Round 2: this MUST throw on failure. A key deleted without a durable tombstone can be
 * re-minted later as a different random key under the same id, which is the displaced
 * failure AUD-007 is about. Deletion is gated on this succeeding.
 */
export async function markBrowserKeyVersionDestroyed(version) {
  const normalized = Math.max(0, Number(version) || 0);
  if (!normalized) return;
  const current = await readDestroyed();
  if (current.includes(normalized)) return;
  await setJson(DESTROYED_VERSIONS_KEY, [...current, normalized]);
}

export async function isBrowserKeyVersionDestroyed(version) {
  const normalized = Math.max(0, Number(version) || 0);
  if (!normalized) return false;
  return (await readDestroyed()).includes(normalized);
}

// ─── Encrypted-document index ────────────────────────────────────────────────
//
// `ROTATING_ENCRYPTED_JSON_KEYS` is hand-maintained, and CODEX independently found four
// live documents missing from it. A hand-written list cannot be made reliable by adding
// four more names to it. Recording every key at the point it is *written* makes the
// sweep complete by construction for any document that exists.

let documentIndexCache = null;

/**
 * Round 2: an index write failure must NOT be swallowed. It no longer creates an
 * undiscoverable document (storage enumeration covers that), but suppressing the error
 * would hide a degraded discoverability record, and the caller decides what to do.
 */
export async function noteEncryptedDocumentKey(key) {
  const name = String(key || '').trim();
  if (!name) return;
  if (documentIndexCache === null) {
    const stored = await getJson(ENCRYPTED_DOCUMENT_INDEX_KEY, null).catch(() => null);
    documentIndexCache = new Set(Array.isArray(stored) ? stored.map(String) : []);
  }
  if (documentIndexCache.has(name)) return;
  documentIndexCache.add(name);
  await setJson(ENCRYPTED_DOCUMENT_INDEX_KEY, [...documentIndexCache]);
}

/**
 * Round 2. A forward-only index is not discovery.
 *
 * Two ways it fails, both proven by CODEX:
 *   1. documents written BEFORE the index existed are invisible to it;
 *   2. a durable index write can fail while the ciphertext still publishes, so a
 *      restart loses the only record that the document exists.
 *
 * The durable store itself is the one source that cannot be out of date. Enumerate it,
 * and treat the index and the static list as *additions*, never as the boundary.
 *
 * `unknown: true` means enumeration could not be completed. The caller must then retain
 * the key: "we could not look" is not "there is nothing there".
 */
const APP_STORAGE_PREFIXES = ['drivesense_', 'road_sage_', 'roadsage_', 'trip_speed_summary_'];
const APP_STORAGE_EXACT_KEYS = new Set(['privacy_zones_v1', 'speed_knowledge_v1']);

const isAppStorageKey = (key) => {
  const name = String(key || '');
  return APP_STORAGE_EXACT_KEYS.has(name)
    || APP_STORAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
};

/** These are bookkeeping, not encrypted documents; rotating them would be circular. */
const NON_DOCUMENT_KEYS = new Set([DESTROYED_VERSIONS_KEY, ENCRYPTED_DOCUMENT_INDEX_KEY]);

/**
 * Round 3. Enumeration finds CANDIDATES; it does not find encrypted documents.
 *
 * Round 2 returned every app-prefixed key, and rotation then handed each one to
 * `rotateEncryptedJsonKey`, whose legacy-upgrade branch encrypts a plaintext value. The
 * result was a production failure in its own right: `drivesense_settings` — a plaintext
 * document with plaintext readers — was rewritten as ciphertext because its key happens
 * to share a prefix with encrypted ones. Sharing a prefix is not membership in this key
 * domain.
 *
 * Only a record that is recognisably one of THIS layer's encrypted envelopes may enter
 * the sweep. The static `ROTATING_ENCRYPTED_JSON_KEYS` list keeps its own legacy-upgrade
 * semantics — those names were declared encrypted deliberately — but discovery may not
 * promote a document into that set by guessing.
 */
const isEncryptedDocumentRecord = (value) => (
  !!value
  && typeof value === 'object'
  && !Array.isArray(value)
  && value.encrypted === true
  && typeof value.ciphertext === 'string'
  && Number.isFinite(Number(value.key_version))
);

/** Bounded classification budget: exhaustion is UNKNOWN, which retains the key. */
const ENCRYPTED_DOCUMENT_CLASSIFY_LIMIT = 512;

/**
 * Read one candidate, distinguishing "absent" from "could not be read".
 *
 * `getJson` cannot be used for this: it swallows a substrate failure and a parse failure
 * alike and returns the fallback, so an unreadable document would classify as "not an
 * encrypted record" — which is exactly the "we could not look ⇒ there is nothing there"
 * reading this module exists to forbid. A substrate failure throws here; an absent value
 * reports `found: false`; a value that is not valid JSON is a deterministic answer, not
 * an unknown one, and cannot be one of our envelopes.
 *
 * @returns {Promise<{found: boolean, value: any}>}
 */
const readCandidateRecord = async (name) => {
  const parse = (raw) => {
    try { return JSON.parse(raw); } catch { return null; }
  };
  const { isNativePlatform } = await import('@/lib/nativePlatform');
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: name });
    return value == null ? { found: false, value: null } : { found: true, value: parse(value) };
  }
  const web = globalThis.localStorage;
  if (web && typeof web.getItem === 'function') {
    const raw = web.getItem(name);
    return raw == null ? { found: false, value: null } : { found: true, value: parse(raw) };
  }
  return { found: false, value: null };
};

const enumerateDurableStorageKeys = async () => {
  const found = new Set();
  let complete = true;

  // An ABSENT substrate is provably empty, not unknown: with no durable web store and
  // no native preference store there is nowhere for an encrypted document to persist.
  // `complete = false` is reserved for enumeration that actually FAILED — that is the
  // case where "we could not look" must not be read as "there is nothing there".
  const web = globalThis.localStorage;
  if (web && typeof web.key === 'function') {
    try {
      const size = Number(web.length) || 0;
      for (let index = 0; index < size; index += 1) {
        const name = web.key(index);
        if (name) found.add(String(name));
      }
    } catch { complete = false; }
  } else if (web) {
    // Present but not enumerable — we genuinely cannot look.
    complete = false;
  }

  try {
    const { isNativePlatform } = await import('@/lib/nativePlatform');
    if (isNativePlatform()) {
      const { Preferences } = await import('@capacitor/preferences');
      const native = await Preferences.keys();
      (native?.keys || []).forEach((name) => found.add(String(name)));
    }
  } catch { complete = false; }

  return { keys: [...found], complete };
};

/**
 * Every durable encrypted document this installation actually holds.
 * @returns {Promise<{keys: string[], unknown: boolean}>}
 */
export async function discoverEncryptedDocumentKeys() {
  const enumerated = await enumerateDurableStorageKeys();
  const candidates = new Set(enumerated.keys.filter(isAppStorageKey));

  // The forward index and the static registry can only ADD to what enumeration found.
  let indexUnknown = false;
  try {
    const stored = await getJson(ENCRYPTED_DOCUMENT_INDEX_KEY, null);
    if (stored === null) {
      // Absent is legitimate (nothing indexed yet). Corrupt is not.
    } else if (Array.isArray(stored)) {
      stored.forEach((name) => candidates.add(String(name)));
    } else {
      indexUnknown = true;   // unreadable/corrupt index is UNKNOWN, never []
    }
  } catch {
    indexUnknown = true;
  }
  if (documentIndexCache) documentIndexCache.forEach((name) => candidates.add(name));

  NON_DOCUMENT_KEYS.forEach((name) => candidates.delete(name));

  // Classify. A candidate we cannot read is UNKNOWN — it may be an encrypted document we
  // failed to inspect — but a candidate we CAN read and that is not an encrypted record
  // is simply not ours, and must never be rewritten.
  const keys = [];
  let classifyUnknown = false;
  let examined = 0;
  for (const name of candidates) {
    if (examined >= ENCRYPTED_DOCUMENT_CLASSIFY_LIMIT) { classifyUnknown = true; break; }
    examined += 1;
    let record;
    try {
      record = await readCandidateRecord(name);
    } catch {
      classifyUnknown = true;
      continue;
    }
    // No durable substrate holds it, but the in-memory store this process uses when
    // there is no localStorage still might — the forward index can name such a document.
    const stored = record.found ? record.value : await getJson(name, null);
    if (isEncryptedDocumentRecord(stored)) keys.push(name);
  }

  return { keys, unknown: !enumerated.complete || indexUnknown || classifyUnknown };
}

export async function listKnownEncryptedDocumentKeys() {
  return (await discoverEncryptedDocumentKeys()).keys;
}

export function resetEncryptedDocumentIndexCacheForTests() {
  documentIndexCache = null;
}
