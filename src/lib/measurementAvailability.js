/**
 * Measurement availability (HPR-008).
 *
 * A trip measurement can be **known** — including a genuine zero — or
 * **unavailable**, which is what a degraded projection leaves behind when its
 * distance or duration could not be repaired. Coercing absence to `0` states
 * something untrue about the drive and quietly biases every total that sums it,
 * so the distinction is carried explicitly from the row to the renderer instead
 * of being re-derived from a falsy number.
 *
 * This is deliberately its own authority. Population completeness (HPR-001) and
 * score provenance (HPR-009) are different claims about different things; a
 * single shared "partial" flag would let one surface borrow another's
 * uncertainty and would make all three impossible to reason about separately.
 */

/** The one word the product uses for a measurement it does not have. */
export const MEASUREMENT_UNAVAILABLE_LABEL = 'Unavailable';

/**
 * @typedef {{known: boolean, value: number|null}} Measurement
 */

/**
 * Read one numeric measurement.
 *
 * Absent, null, empty and non-finite all mean **unknown**. `0` is a value the
 * source actually recorded and stays known.
 *
 * @param {unknown} value
 * @returns {Measurement}
 */
export function readMeasurement(value) {
  if (value == null) return { known: false, value: null };
  // A string that is empty once trimmed carries no measurement. `Number(' ')`
  // is `0`, which would have made blank text indistinguishable from a recorded
  // zero — the exact confusion this module exists to prevent.
  if (typeof value === 'string' && value.trim() === '') return { known: false, value: null };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { known: false, value: null };
  return { known: true, value: numeric };
}

/** @returns {Measurement} */
export const tripDistanceKm = (trip) => readMeasurement(trip?.distance_km);

/** @returns {Measurement} */
export const tripDurationSeconds = (trip) => readMeasurement(trip?.duration_seconds);

/**
 * Format a measurement, or say plainly that it is not available.
 *
 * @param {Measurement} measurement
 * @param {(value: number) => string} format
 * @param {{unavailable?: string}} [options]
 */
export function formatMeasurement(measurement, format, { unavailable = MEASUREMENT_UNAVAILABLE_LABEL } = {}) {
  return measurement?.known ? format(measurement.value) : unavailable;
}

/**
 * Sum one measurement across rows and report how much of the set it covered.
 *
 * The total is the sum of the **known** values only. Unknown rows are counted,
 * never added as zero, so a caller can disclose that its total is partial
 * instead of presenting an exact-looking figure it cannot support. O(L) over the
 * rows already held; it never reads more rows than it was given.
 *
 * @param {Array<any>} items
 * @param {(item: any) => Measurement} read
 */
export function summarizeMeasurementCoverage(items = [], read = readMeasurement) {
  const rows = Array.isArray(items) ? items : [];
  let total = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const item of rows) {
    const measurement = read(item);
    if (measurement?.known) {
      total += measurement.value;
      knownCount += 1;
    } else {
      unknownCount += 1;
    }
  }
  return {
    total,
    knownCount,
    unknownCount,
    representedCount: rows.length,
    complete: unknownCount === 0,
  };
}

/**
 * One sentence describing incomplete measurement coverage, or `null` when every
 * represented row carried the measurements.
 */
export function measurementCoverageNote(coverages = []) {
  const incomplete = coverages.filter((entry) => entry?.coverage && !entry.coverage.complete);
  if (!incomplete.length) return null;
  const parts = incomplete.map(({ label, coverage }) => (
    `${coverage.unknownCount} trip${coverage.unknownCount === 1 ? '' : 's'} with unavailable ${label}`
  ));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Totals exclude ${list}; those measurements could not be read and are not included as zero.`;
}
