import {
  ODOMETER_SYNC_MAX_EXTRA_PAGES,
  planOdometerSync,
  rowsCoverSyncPoints,
} from '@/lib/vehicleOdometer';

let inFlight = null;

/**
 * DPD-035 — one odometer sync over the fleet.
 *
 * Starts from the Vehicles page's first Q1 page and reads further pages only
 * while some vehicle's sync point is older than every row held, so the rows read
 * are bounded by the trips that arrived since the last sync, never by history.
 * The extra pages are capped; if the cap stops the walk, what was read is still
 * credited and the (rare) gap is logged as a floor rather than guessed.
 *
 * Runs are serialised: a second call while one is in flight waits for it and
 * returns its result instead of planning from the same stale snapshot again.
 *
 * @param {{
 *   vehicles: Array<object>,
 *   windowRows: Array<object>,
 *   continuation?: string|null,
 *   fetchPage: (cursor: string) => Promise<{rows: Array<object>, continuation: string|null}>,
 *   writeVehicle: (id: string, patch: object) => Promise<unknown>,
 *   now?: Date,
 * }} input
 * @returns {Promise<{written: number, pagesRead: number, capped: boolean}>}
 */
export function syncVehicleOdometers(input) {
  if (inFlight) return inFlight;
  inFlight = runSync(input).finally(() => { inFlight = null; });
  return inFlight;
}

async function runSync({ vehicles = [], windowRows = [], continuation = null, fetchPage, writeVehicle, now = new Date() }) {
  let rows = [...windowRows];
  let cursor = continuation;
  let pagesRead = 0;
  while (cursor && !rowsCoverSyncPoints(vehicles, rows) && pagesRead < ODOMETER_SYNC_MAX_EXTRA_PAGES) {
    const page = await fetchPage(cursor);
    pagesRead += 1;
    rows = rows.concat(page?.rows || []);
    cursor = page?.continuation || null;
  }
  const capped = Boolean(cursor) && !rowsCoverSyncPoints(vehicles, rows);
  const plan = planOdometerSync(vehicles, { windowRows, rows, now });
  for (const { id, patch } of plan) {
    await writeVehicle(id, patch);
  }
  return { written: plan.length, pagesRead, capped };
}
