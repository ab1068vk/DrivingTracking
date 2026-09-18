import { p7QueryKeys } from '@/api/trips';
import { readSpeedMapGeometryPage } from '@/hooks/useSpeedMapGeometry';

/**
 * The Map screen's geometry composition (P7 Stage 7, ledger entry #6).
 *
 * What it replaces: a flat `limitedTripSummaryQueryOptions(200)` list plus an
 * eight-deep `useQueries` **Q2 detail** fan-out. The fan-out existed only to
 * draw the overview polylines, and to do that it decrypted eight complete trip
 * payloads — every route point, every driving event — for eight lines on a
 * map. Q8 answers the same question with one Q1 selection and one D2 by-id
 * batch, decimated to a preview cap.
 *
 * It reuses `readSpeedMapGeometryPage` rather than defining a second geometry
 * read: both surfaces ask the same bounded question of the same owner, and P7
 * permits exactly one geometry owner.
 */

/** The bounded page the map screen selects over. */
export const MAP_SCREEN_PAGE_TRIPS = 80;

/**
 * The query options for that page.
 *
 * The rows come back in the Q1 chronology with `route_points` lifted from the
 * batch, which is the shape the map's filters, replay checks and diagnostics
 * already read.
 */
export const mapScreenGeometryQuery = () => ({
  queryKey: p7QueryKeys.geometry('map-screen'),
  queryFn: async () => {
    const page = await readSpeedMapGeometryPage();
    return {
      trips: page.trips,
      exact: page.exact,
      nextCursor: page.nextCursor,
      unavailable: page.unavailable,
      readiness: page.readiness,
    };
  },
  staleTime: 60 * 1000,
});
