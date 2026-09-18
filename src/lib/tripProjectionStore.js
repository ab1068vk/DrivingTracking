import { decryptSensitiveValues, encryptSensitiveValues } from '@/lib/securePayloadCrypto';
import { assertDurablePublication } from '@/lib/browserKeyReferences';
import { isProjectionEnvelopeValid, projectionNeedsHydration } from '@/lib/tripProjection';
import { PROJECTION_STALE_VERSION, TRIP_PROJECTION_VERSION } from '@/lib/tripProjectionSchema';
import {
  buildProjectionKeyRange,
  buildProjectionRangeV2,
  decodeProjectionCursor,
  encodeProjectionCursor,
  projectionIndexFor,
} from '@/lib/tripProjectionQuery';

/**
 * Storage-side projection selection, decode and repair sequencing (P3).
 *
 * Ordering and identity are read from the **source** store, so a bounded page is
 * correct at zero migration progress and a missing or corrupt projection can
 * never remove a trip from a listing.
 */

/**
 * Projection payloads reuse the `trip-summary:` P0 prefix so
 * `payloadKindForContext` still reports `trip_summary`, while the distinct
 * `:projection:` segment keeps legacy-summary and projection ciphertext from
 * cross-authenticating under the same AAD.
 * @param {string | number} id
 */
export const projectionEncryptionContext = (id) => `trip-summary:projection:${String(id)}`;

/** 128-bit opaque transaction-coherence token. Not cryptographic source authenticity. */
export const mintSourceRevision = () => {
  const api = globalThis.crypto;
  if (api?.getRandomValues) {
    const bytes = new Uint8Array(16);
    api.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`.padEnd(32, '0');
};

/** Sentinel for a source row that has not been assigned a revision yet. */
export const ABSENT_REVISION = null;

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/**
 * Walk the source index and collect at most `limit` candidate keys.
 *
 * Cost is proportional to the page, never to the offset or to history: the
 * cursor is positioned by value through an exclusive key range rather than by
 * `advance(offset)`.
 *
 * @returns {Promise<{ rows: Array<{ id: string, start_time: string, status: string,
 *   source_revision: string | null }>, nextCursor: string | null, hasMore: boolean }>}
 */
export async function selectSourceWindow(db, {
  storeName, unfilteredIndex, filteredIndex, status = null, limit, direction, cursor, sort,
  position = undefined, fromKey = null, toKey = null,
}) {
  // A caller that already decoded its own keyset position (P7 cursor v2, which
  // preserves the exact IndexedDB key types) passes it directly. The v1 token
  // path is unchanged for every existing caller.
  const usesV2 = position !== undefined;
  const decoded = usesV2 ? position : decodeProjectionCursor(cursor, { sort, status });
  const effectiveStatus = status === 'any' ? null : status;
  const indexName = projectionIndexFor(effectiveStatus, unfilteredIndex, filteredIndex);
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index(indexName);
  const range = usesV2
    ? buildProjectionRangeV2(IDBKeyRange, {
      status: effectiveStatus, direction, position: decoded, fromKey, toKey,
    })
    : buildProjectionKeyRange(IDBKeyRange, { status: effectiveStatus, direction, cursor: decoded });

  const rows = [];
  let hasMore = false;
  await new Promise((resolve, reject) => {
    const request = range == null ? index.openCursor(null, direction) : index.openCursor(range, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const idbCursor = request.result;
      if (!idbCursor) return resolve(undefined);
      if (rows.length >= limit) {
        // One row past the page proves another page exists without reading it.
        hasMore = true;
        return resolve(undefined);
      }
      const record = idbCursor.value;
      rows.push({
        // Preserve the exact primary-key type. Mature databases contain numeric
        // legacy ids, and stringifying here would make every later point read,
        // projection record and pagination identity miss those rows.
        id: record.id,
        // The exact index key component, untouched. `start_time` below stays a
        // string because every existing consumer reads it as one; a P7 cursor v2
        // needs the original type so its `IDBKeyRange` matches a live cursor.
        sort_key: record.start_time,
        start_time: String(record.start_time ?? ''),
        status: String(record.status ?? ''),
        source_revision: record.source_revision ?? ABSENT_REVISION,
      });
      idbCursor.continue();
      return undefined;
    };
  });

  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    // The keyset position of the last row delivered, with its original key
    // types intact, so a P7 cursor v2 can be minted from it without the
    // stringification the v1 token performs.
    lastKey: last ? { sort: last.sort_key, id: last.id } : null,
    nextCursor: hasMore && last
      ? encodeProjectionCursor({ sort, status, startTime: last.start_time, id: last.id })
      : null,
  };
}

/**
 * Point-read the projection rows for a selected window.
 *
 * Arbitrary ids have no single contiguous key range, so this issues at most
 * `page` `get(id)` requests inside one readonly transaction and reassembles them
 * in the requested order.
 */
export async function readProjectionRecords(db, storeName, ids) {
  if (!ids.length) return new Map();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const records = await Promise.all(ids.map((id) => idbRequest(store.get(id))));
  const byId = new Map();
  records.forEach((record, index) => {
    if (record) byId.set(ids[index], record);
  });
  return byId;
}

/**
 * Classify each selected row against its projection record **before** any
 * decryption is attempted. A `projection_version === 0` marker is an intentional
 * obligation state, never generic corruption, and must be recognised without
 * touching its (possibly absent) ciphertext.
 */
export function classifyProjectionRows(sourceRows, projectionsById) {
  const usable = [];
  const needsBuild = [];
  const deterministicFailures = [];

  for (const row of sourceRows) {
    const record = projectionsById.get(row.id);
    if (!record) {
      needsBuild.push(row);
      continue;
    }
    if (record.projection_version === PROJECTION_STALE_VERSION) {
      // A deterministic build failure whose three fields still match current
      // state must not be rebuilt on every read; the row hydrates from detail.
      if (
        record.failure_class
        && String(record.failed_source_revision ?? '') === String(row.source_revision ?? '')
        && record.failed_target_projection_version === TRIP_PROJECTION_VERSION
      ) {
        deterministicFailures.push({ row, record });
      } else {
        needsBuild.push(row);
      }
      continue;
    }
    if (record.projection_version !== TRIP_PROJECTION_VERSION) {
      needsBuild.push(row);
      continue;
    }
    if (String(record.source_revision ?? '') !== String(row.source_revision ?? '')) {
      needsBuild.push(row);
      continue;
    }
    usable.push({ row, record });
  }

  return { usable, needsBuild, deterministicFailures };
}

const validatedEntry = (row, envelope) => {
  const valid = isProjectionEnvelopeValid(envelope, {
    id: row.id,
    start_time: row.start_time,
    status: row.status,
    source_revision: row.source_revision ?? '',
  });
  return { row, envelope: valid ? envelope : null };
};

/**
 * Decrypt a bounded set of projection payloads through P2's batch primitives and
 * validate each envelope against its authoritative plaintext columns.
 *
 * P2's batch contract is all-or-error, so a single corrupt or unauthenticated
 * member would take the whole page down with it — one bad row making a page of
 * fifty unreadable. When the batch fails, the members are isolated one at a
 * time: at most `entries.length` single-member decrypts, on this path only, so
 * the cost stays charged to the selected page and never to history. A member
 * that still fails comes back as `envelope: null`, which the caller already
 * serves from bounded detail.
 */
export async function decodeProjectionPayloads(entries, options = {}) {
  if (!entries.length) return [];
  try {
    const values = await decryptSensitiveValues(
      entries.map(({ record }) => ({
        payload: record.encrypted_payload,
        context: projectionEncryptionContext(record.id),
      })),
      options
    );
    return values.map((envelope, index) => validatedEntry(entries[index].row, envelope));
  } catch (error) {
    // An aborted read is the caller's decision, not a corrupt payload.
    if (error?.name === 'AbortError') throw error;
    const isolated = [];
    for (const entry of entries) {
      try {
        const [envelope] = await decryptSensitiveValues([{
          payload: entry.record.encrypted_payload,
          context: projectionEncryptionContext(entry.record.id),
        }], options);
        isolated.push(validatedEntry(entry.row, envelope));
      } catch (memberError) {
        if (memberError?.name === 'AbortError') throw memberError;
        isolated.push({ row: entry.row, envelope: null });
      }
    }
    return isolated;
  }
}

/** Encrypt a bounded set of projection envelopes through P2's batch primitives. */
export async function encodeProjectionPayloads(envelopes, publication, options = {}) {
  // AUD-007 REDESIGN. This function does NOT own admission — it returns root-key-bound
  // ciphertext to a caller that commits later, and a token held here would be released
  // the moment the bytes were handed back. What it DOES do is refuse to produce those
  // bytes at all unless the caller is inside a live publication and can prove it by
  // handing over the capability. The check runs before the empty-input shortcut, so a
  // caller cannot drift into the unadmitted shape on the days its page happens to be
  // empty and only fail in production.
  assertDurablePublication(publication, 'encodeProjectionPayloads');
  if (!envelopes.length) return [];
  return encryptSensitiveValues(
    envelopes.map((envelope) => ({
      value: envelope,
      context: projectionEncryptionContext(envelope.id),
    })),
    options,
  );
}

/**
 * Storage record shape written to `trip_projections`.
 *
 * The record key must be the **source** primary key, not `envelope.id`. Envelope
 * fields are string-normalized because consumers compare them with `String(...)`,
 * but IndexedDB keys are typed: a mature database whose trips were created with
 * numeric ids would store the source under `42` and the projection under `"42"`,
 * and the two-sided verifier would then read the row as simultaneously missing a
 * projection and owning an orphan — repairing and deleting it forever.
 */
export const projectionRecordFor = (envelope, encryptedPayload, sourceKey) => ({
  id: sourceKey === undefined ? envelope.id : sourceKey,
  start_time: envelope.start_time,
  status: envelope.status,
  projection_version: TRIP_PROJECTION_VERSION,
  source_revision: envelope.source_revision,
  encrypted_payload: encryptedPayload,
});

/**
 * Marker record for a deterministic build failure. Outer columns mirror the
 * **current** source row so an ordering or status change cannot leave the marker
 * indexed under stale values. It intentionally carries no ciphertext.
 */
export const projectionFailureMarkerFor = (row, failureClass) => ({
  id: row.id,
  start_time: row.start_time,
  status: row.status,
  projection_version: PROJECTION_STALE_VERSION,
  source_revision: row.source_revision ?? null,
  failure_class: failureClass,
  failed_source_revision: row.source_revision ?? null,
  failed_target_projection_version: TRIP_PROJECTION_VERSION,
});

export { projectionNeedsHydration };
