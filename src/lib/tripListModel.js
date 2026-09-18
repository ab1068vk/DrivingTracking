import { PROJECTION_EXACT_FIELDS, PROJECTION_OVERFLOW_BITS } from '@/lib/tripProjectionSchema';

/**
 * Dual-shape adapter for bounded list consumers.
 *
 * The same components receive `TripProjection` v1 from a bounded query, a legacy
 * summary from `listAllSummaries`, and a full trip from `getById`. Every shared
 * consumer reads the adapter's output rather than a shape-specific field, so a
 * projection change cannot regress the legacy or full-trip path.
 *
 * The projection's `fields` keys are deliberately the trip field names, so a
 * flattened projection is shape-compatible with what those consumers already
 * read.
 */

/** True when the value is a decrypted projection envelope rather than a trip. */
export const isProjectionEnvelope = (value) => (
  value != null && typeof value === 'object' && value.record_type === 'trip_projection'
);

/**
 * Normalize any of the three shapes into one bounded list row.
 *
 * @param {any} input projection envelope, legacy summary, or full trip
 * @param {{ hydrated?: Record<string, any> | null }} [options] exact values
 *   recovered by bounded hydration for a row whose text was capped
 * @returns {Record<string, any>}
 */
export function asTripListModel(input, options = {}) {
  if (!isProjectionEnvelope(input)) {
    // Legacy summary or full trip: already the consumer shape.
    return input;
  }

  const row = {
    ...input.fields,
    id: input.id,
    start_time: input.start_time,
    status: input.status,
  };

  // A truncated exact value must never be observed. Hydration replaces it before
  // the row is returned, so grouping, matching and display all see the original.
  const hydrated = options.hydrated;
  if (hydrated) {
    for (const field of PROJECTION_EXACT_FIELDS) {
      if (hydrated[field] !== undefined) row[field] = hydrated[field];
    }
  }
  return row;
}

/** Overflow bits set on an envelope, empty when nothing was capped. */
export const overflowBitsOf = (envelope) => (
  PROJECTION_OVERFLOW_BITS.filter((bit) => envelope?.[bit] === true)
);
