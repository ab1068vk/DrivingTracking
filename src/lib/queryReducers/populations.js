/**
 * The six frozen Q10 populations (Annex C §C1a), as executable predicates.
 *
 * Every reducer names exactly one. The blanket `status === 'completed'` default
 * is not sufficient, because several current outputs filter further, and a
 * reducer that silently widened its population would change a number on screen.
 *
 * These evaluate a **bounded row** — the projection-backed model Q1 delivers —
 * so a reducer turn stays inside the history page's own budget
 * (`fullTripDecrypts = 0`). `driver_metric_eligible` is the one projection
 * addition P7 makes, precisely so `P-DRIVER` can be evaluated here without
 * hydrating a full record per row.
 */

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const isCompleted = (row) => String(row?.status ?? '') === 'completed';

/**
 * Driver eligibility, read from the derived projection boolean.
 *
 * A row whose projection predates the field is **not** assumed eligible: an
 * absent value is `unknown`, and treating it as `true` is exactly the silent
 * inclusion of passenger and excluded trips that Annex C forbids. The
 * page-bounded repair path rewrites such a row before it is classified, so this
 * is a transient state, not a steady one.
 */
const isDriverEligible = (row) => row?.driver_metric_eligible === true;

export const P7_POPULATION_PREDICATES = Object.freeze({
  'P-COMPLETED': (row) => isCompleted(row),
  'P-DRIVER': (row) => isCompleted(row) && isDriverEligible(row),
  'P-PROGRESSION': (row, settings = {}) => (
    isCompleted(row)
    && number(row?.distance_km) >= (Number(settings.progression_min_trip_km) || 2)
    && number(row?.duration_seconds) >= (Number(settings.progression_min_trip_seconds) || 180)
    && Number.isFinite(row?.score_overall)
  ),
  'P-SCORETIP': (row, settings = {}) => (
    isCompleted(row) && isDriverEligible(row)
    && number(row?.distance_km) >= (Number(settings.scoreTipMinTripKm) || 0)
    && number(row?.score_confidence) >= (Number(settings.scoreTipMinConfidence) || 0)
  ),
  'P-BASELINE': (row) => isCompleted(row) && Number.isFinite(row?.score_overall),
  'P-PEAKSTRESS': (row, settings = {}) => (
    isCompleted(row) && number(row?.distance_km) >= (Number(settings.peakStressMinTripKm) || 0)
  ),
});

/** Shared row arithmetic, kept in one place so two reducers cannot disagree. */
export const rowNumber = number;

/** The Report clean predicate: the four primary counters all zero. */
export const isReportCleanRow = (row) => (
  number(row?.harsh_brakes_count) === 0
  && number(row?.rapid_accel_count) === 0
  && number(row?.sharp_turns_count) === 0
  && number(row?.speeding_events_count) === 0
);

/** The D1/Achievements clean predicate: no risk event and no severe event. */
export const isLedgerCleanRow = (row) => (
  number(row?.harsh_brakes_count) + number(row?.rapid_accel_count)
  + number(row?.sharp_turns_count) + number(row?.speeding_events_count) === 0
  && number(row?.emergency_heavy_braking_count) + number(row?.phone_use_high_confidence_count) === 0
);

/**
 * The two clean predicates are **different** and are never interchanged
 * (Annex A §A3.1). This is the assertion that keeps them apart in review.
 */
export const P7_CLEAN_PREDICATES_ARE_DISTINCT = Object.freeze({
  report: 'harsh_brakes_count, rapid_accel_count, sharp_turns_count and speeding_events_count all zero',
  ledger: 'riskEventCount(trip) === 0 && severeEventCount(trip) === 0',
});

/** The local day a row belongs to, using the stored per-trip offset evidence. */
export const localDayKey = (row) => {
  const at = Date.parse(String(row?.start_time ?? ''));
  if (!Number.isFinite(at)) return null;
  const offsetMinutes = Number.isFinite(row?.trip_utc_offset_minutes)
    ? Number(row.trip_utc_offset_minutes)
    : -new Date(at).getTimezoneOffset();
  return new Date(at + offsetMinutes * 60000).toISOString().slice(0, 10);
};
