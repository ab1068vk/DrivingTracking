/**
 * DPD-037. What the Map overview may claim about its trips.
 *
 * The overview reads the D2 geometry owner (Q8). A history restored from a backup
 * carries legacy inline routes that D2 only reads in an explicit pass (DPD-020
 * parking), so until that pass runs Q8 refuses with a typed `OWNER_NOT_READY`.
 * The Map rendered that refusal as "Showing 0 filtered trips" and "No trips with
 * playable route GPS" over 3,000 routed trips on the A54. A refusal means the
 * previews are not built, never that there are no trips.
 *
 * @param {{loading?: boolean, unavailable?: {code?: string}|null, count?: number}} input
 */
export function mapOverviewStatus({ loading = false, unavailable = null, count = 0 } = {}) {
  const notBuilt = unavailable?.code === 'OWNER_NOT_READY';
  let header;
  if (loading) header = 'Loading trips...';
  else if (notBuilt) header = 'Route overviews are not built yet';
  else if (unavailable) header = 'Route overviews could not be read';
  else header = `Showing ${count} filtered trip${count === 1 ? '' : 's'}`;
  return { header, notBuilt, readFailed: Boolean(unavailable) && !notBuilt };
}

export const MAP_OVERVIEW_NOT_BUILT_TITLE = 'Route overviews are not built yet';
export const MAP_OVERVIEW_NOT_BUILT_DETAIL = 'Your trips are saved, but the map-ready route previews for this history have not been built. '
  + 'In Settings, "Repair trip analytics and route previews" builds them from your retained trips. '
  + 'Any trip\'s full route still opens from Trip History.';
