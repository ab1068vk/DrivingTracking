import { p7TripQueries } from '@/api/trips';

/**
 * The Speed Limits map's geometry composition (P7 Stage 7, ledger entry #11,
 * Annex C rows **O35** and **O36**).
 *
 * What it replaces: `tripService.listForSpeedMap({ sort, offset, limit })`
 * merged with `readSpeedGeometryIndex()`. Two problems came with that pair.
 *
 * 1. **Offset paging.** `listForSpeedMap` sorted the entire eligible history to
 *    reach `offset`, so page 20 cost twenty times page 1 — the growth law
 *    inverted. Q8 selects through the Q1 cursor, so every page costs the same.
 * 2. **A synthesized total.** The merge presented
 *    `max(indexed, index.totalAvailable)` as "available routes", and the index
 *    computed that as `items.length + (nextCursor ? 1 : 0)` — a bounded read of
 *    80 reported "81 available" no matter how much history existed. O36
 *    replaces it with **"at least N, more available"**, which is what a bounded
 *    scan can honestly say.
 *
 * Geometry comes from the **one** D2 by-id batch Q8 already owns: a fixed Q1
 * page, then a single batch for exactly those ids. There is no second geometry
 * owner and no N x Q2.
 */

/** The page the map renders, and the batch the D2 read is given. */
export const SPEED_MAP_PAGE_TRIPS = 80;

/** The preview cap D2 decimates each route to for a map overview. */
export const SPEED_MAP_MAX_POINTS = 160;

/**
 * One bounded Q8 page.
 *
 * @param {{cursor?: string|null}} [options]
 * @returns {Promise<{trips: Array, nextCursor: string|null, exact: boolean,
 *                    unavailable: object|null, readiness: object|null}>}
 */
export async function readSpeedMapGeometryPage({ cursor = null } = {}) {
  const page = await p7TripQueries.geometryPage({
    sort: '-start_time',
    status: 'completed',
    limit: SPEED_MAP_PAGE_TRIPS,
    maxPoints: SPEED_MAP_MAX_POINTS,
    cursor,
  });

  if (page.unavailable) {
    return {
      trips: [],
      nextCursor: null,
      exact: false,
      unavailable: page.unavailable,
      readiness: page.p6Readiness ?? null,
    };
  }

  // The map consumers read `route_points` off the trip, so the batch's geometry
  // is lifted onto the row. A row the D2 owner could not cover keeps a null
  // route rather than an empty one: "unknown", never "no route".
  const trips = (page.data ?? []).map((row) => ({
    ...row,
    route_points: row.geometry?.route_points ?? null,
    geometry_indexed: row.geometry?.geometry_indexed === true,
    geometry_coverage: row.geometry?.coverage ?? 'unknown',
  }));

  return {
    trips,
    nextCursor: page.continuation ?? null,
    exact: page.completeness === 'EXACT',
    unavailable: null,
    readiness: page.p6Readiness ?? null,
  };
}

/**
 * **O36** — what the count line may claim.
 *
 * Until the scan reaches its end the only truthful statement is a floor. This
 * returns the pieces the surface renders, never a total it cannot support.
 */
export const speedMapCoverageLabel = ({ loaded, exact }) => (
  exact
    ? `${loaded} trip route${loaded === 1 ? '' : 's'} indexed`
    : `at least ${loaded} trip route${loaded === 1 ? '' : 's'} indexed, more available`
);
