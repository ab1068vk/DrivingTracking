import { countJsonBytes } from '@/lib/jsonByteCounter';
import { ENVELOPE_MAX_BYTES } from '@/lib/tripProjectionSchema';

/**
 * Write admission for the P3 repository writers.
 *
 * Admission runs on the **source** object before any sanitized copy, legacy
 * summary, projection or ciphertext exists, so an open-shaped imported field
 * cannot be discovered only after the expensive copies have been made.
 */

/** Records per multi-record logical write. Rejected before any side effect. */
export const MAX_LOGICAL_WRITE_RECORDS = 32;

/**
 * Chunk budget for multi-record preparation, expressed in **logical serialized
 * bytes**. This is a conservative accounting model, not a JS heap guarantee: it
 * covers the caller object, the sanitized copy, the legacy-summary copy, the
 * projection, one serialized string per prepared record and base64-expanded
 * ciphertext per record.
 */
export const MAX_CHUNK_LOGICAL_CHARGE = 96 * 1024 * 1024;

/**
 * Observability threshold that forces isolated single-record preparation.
 * It is **not** a correctness ceiling and **not** a rejection threshold: a
 * legitimate completed drive is never refused or truncated because of it.
 */
export const MAX_SINGLE_RECORD_CHARGE = 128 * 1024 * 1024;

/** Conservative multi-record charge for one source of `bytes` serialized bytes. */
export const chunkCharge = (bytes) => (9 * bytes) + 82_000;

/**
 * Isolated single-record charge. The summary and projection are not
 * history-sized here and intermediates are released between stages, so the
 * multiplier is lower than the chunked model.
 */
export const singleCharge = (bytes) => (3.8 * bytes) + ENVELOPE_MAX_BYTES + 82_000;

/**
 * Measure a source trip with early abort.
 *
 * The ceiling passed here is an *admission* ceiling, not a rejection: exceeding
 * it only routes the record to isolated preparation. Aborting early means a
 * 200 MiB imported field costs the ceiling, not the field.
 *
 * @param {any} trip
 * @param {number} [ceiling]
 * @returns {{ bytes: number, aborted: boolean }}
 */
export const measureSourceTrip = (trip, ceiling = MAX_SINGLE_RECORD_CHARGE) => (
  countJsonBytes(trip, ceiling)
);

/**
 * Split a logical write into chunks bounded by **both** record count and
 * conservative logical charge, closing a chunk *before* preparing an item that
 * would exceed the budget rather than discovering the excess afterwards.
 *
 * A record whose own charge exceeds the chunk budget becomes an isolated
 * single-item chunk — the complete source is still written, never truncated and
 * never deferred.
 *
 * @param {any[]} trips
 * @returns {{ chunks: Array<{ items: any[], charge: number, isolated: boolean }>,
 *             measured: number[] }}
 */
/**
 * Choose the next admitted window **without** preparing anything.
 *
 * Callers must sanitize and encrypt only the returned window, then release it
 * before asking for the next one; preparing the whole input and slicing it
 * afterwards would make peak work depend on the entire logical batch.
 *
 * @param {any[]} trips
 * @param {number} start
 * @returns {{ count: number, charge: number, isolated: boolean }}
 */
export function nextWriteWindow(trips, start) {
  let charge = 0;
  let count = 0;
  for (let index = start; index < trips.length; index += 1) {
    const { bytes } = measureSourceTrip(trips[index]);
    const itemCharge = chunkCharge(bytes);
    if (itemCharge > MAX_CHUNK_LOGICAL_CHARGE) {
      if (count === 0) return { count: 1, charge: singleCharge(bytes), isolated: true };
      return { count, charge, isolated: false };
    }
    if (count > 0 && (charge + itemCharge > MAX_CHUNK_LOGICAL_CHARGE || count >= MAX_LOGICAL_WRITE_RECORDS)) {
      return { count, charge, isolated: false };
    }
    charge += itemCharge;
    count += 1;
    if (count >= MAX_LOGICAL_WRITE_RECORDS) return { count, charge, isolated: false };
  }
  return { count, charge, isolated: false };
}

export function planWriteChunks(trips = []) {
  const chunks = [];
  const measured = [];
  let current = { items: [], charge: 0, isolated: false };

  for (const trip of trips) {
    const { bytes } = measureSourceTrip(trip);
    measured.push(bytes);
    const charge = chunkCharge(bytes);

    if (charge > MAX_CHUNK_LOGICAL_CHARGE) {
      if (current.items.length) { chunks.push(current); current = { items: [], charge: 0, isolated: false }; }
      chunks.push({ items: [trip], charge: singleCharge(bytes), isolated: true });
      continue;
    }
    const wouldExceed = current.charge + charge > MAX_CHUNK_LOGICAL_CHARGE;
    const wouldOverflow = current.items.length >= MAX_LOGICAL_WRITE_RECORDS;
    if (current.items.length && (wouldExceed || wouldOverflow)) {
      chunks.push(current);
      current = { items: [], charge: 0, isolated: false };
    }
    current.items.push(trip);
    current.charge += charge;
  }
  if (current.items.length) chunks.push(current);
  return { chunks, measured };
}

/**
 * Typed complete-save failure.
 *
 * Raised for preparation, crypto, IndexedDB, quota and storage failures on the
 * complete-or-fail write path, so a caller can distinguish "this save did not
 * happen" from an unrelated error. There is deliberately no truncation, no
 * deferral and no hidden size rejection behind it.
 */
export class TripPersistenceFailedError extends Error {
  constructor(message, detail = {}, options = {}) {
    super(message, options);
    this.name = 'TripPersistenceFailedError';
    this.detail = detail;
  }
}

export class TripWriteAdmissionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TripWriteAdmissionError';
    this.detail = detail;
  }
}

/**
 * Public multi-record maximum. Rejected **before** locks, rescoring,
 * sanitization, copies, crypto or any downstream side effect, so a caller that
 * exceeds it cannot observe a partially applied write.
 * @param {any[]} trips
 */
export function assertLogicalWriteBatch(trips) {
  const list = Array.isArray(trips) ? trips : [];
  if (list.length > MAX_LOGICAL_WRITE_RECORDS) {
    throw new TripWriteAdmissionError(
      `A single upsert accepts at most ${MAX_LOGICAL_WRITE_RECORDS} trips.`,
      { received: list.length, maximum: MAX_LOGICAL_WRITE_RECORDS }
    );
  }
  return list;
}
