/**
 * HPR-017 — the trip-subject identity authority for the advanced tracking
 * destinations (Map Workspace, Event Timeline, Data Quality).
 *
 * THE DEFECT. Those screens are reached with an explicit `?trip=<id>` emitted by
 * Tracking Trip Detail and Tracking Overview, but each one started its selection
 * state empty and rendered whichever row its bounded window happened to put
 * first. A user inspecting trip A therefore landed on trip B, and once A fell
 * outside the destination's window (50 summaries for Events/Evidence, one Q8
 * geometry page for Map) it could not be reached there at all.
 *
 * THE RULE. Collection position is not identity. When navigation names trip X,
 * the destination resolves X — through the id-addressed canonical detail query it
 * already owns — or says truthfully that X is unavailable. It never substitutes
 * the newest trip, the first loaded trip, or any other row.
 *
 * WHAT THIS IS NOT. It is not a search. Nothing here walks pages looking for X,
 * raises a cap, or hydrates a history: resolution costs exactly one by-id detail
 * read whether the store holds ten trips or ten million. The bounded window
 * remains only the picker's option list.
 */

export const TRACKING_TRIP_PARAM = 'trip';

/**
 * A trip id longer than this is not a trip id. It is refused as an explicit
 * request rather than dropped, because dropping it would fall back to the newest
 * trip — the wrong-subject substitution this module exists to forbid.
 */
export const MAX_REQUESTED_TRIP_ID_LENGTH = 200;

const EMPTY_REQUEST = Object.freeze({ present: false, id: '', malformed: false });

const NOT_A_TRIP_LINK = 'That link does not name a trip this device can open. Nothing else has been substituted.';

/**
 * Read the explicitly requested trip identity from a location search.
 *
 * @param {URLSearchParams|string|null|undefined} source
 * @returns {{present: boolean, id: string, malformed: boolean}}
 */
export function readRequestedTripId(source) {
  if (!source) return EMPTY_REQUEST;
  let params = source;
  if (typeof source === 'string') {
    params = new URLSearchParams(source.startsWith('?') ? source.slice(1) : source);
  }
  if (typeof params?.get !== 'function') return EMPTY_REQUEST;
  const raw = params.get(TRACKING_TRIP_PARAM);
  if (raw == null) return EMPTY_REQUEST;
  const id = String(raw).trim();
  if (!id) return EMPTY_REQUEST;
  if (id.length > MAX_REQUESTED_TRIP_ID_LENGTH) return { present: true, id: '', malformed: true };
  return { present: true, id, malformed: false };
}

const firstSummaryId = (summaries) => {
  const first = Array.isArray(summaries) ? summaries[0] : null;
  return first?.id == null ? '' : String(first.id);
};

/**
 * Decide which trip the destination is about.
 *
 * Precedence, and the reason for it: a trip the user picked from the
 * destination's own control is the most recent statement of intent, so it
 * outranks the link that opened the screen; an explicit link outranks the
 * window's first row; the first row is the legitimate default only when nothing
 * was asked for.
 *
 * @param {{requested?: {present: boolean, id: string, malformed: boolean},
 *          selectedTripId?: string, summaries?: Array<{id?: unknown}>}} [input]
 * @returns {{tripId: string, mode: 'selected'|'explicit'|'default'|'none',
 *            requestedTripId: string, rejected: boolean}}
 */
export function resolveTrackingTripSubject({ requested = EMPTY_REQUEST, selectedTripId = '', summaries = [] } = {}) {
  const request = requested || EMPTY_REQUEST;
  const picked = selectedTripId == null ? '' : String(selectedTripId).trim();
  if (picked) {
    return { tripId: picked, mode: 'selected', requestedTripId: request.id, rejected: false };
  }
  if (request.present) {
    // A malformed explicit id stays explicit. It resolves to nothing and is
    // reported as nothing; it never degrades into "show the newest trip".
    return {
      tripId: request.malformed ? '' : request.id,
      mode: 'explicit',
      requestedTripId: request.id,
      rejected: request.malformed === true,
    };
  }
  const fallback = firstSummaryId(summaries);
  return {
    tripId: fallback,
    mode: fallback ? 'default' : 'none',
    requestedTripId: '',
    rejected: false,
  };
}

const summaryForId = (summaries, tripId) => {
  if (!tripId || !Array.isArray(summaries)) return null;
  return summaries.find((trip) => String(trip?.id) === String(tripId)) || null;
};

/**
 * Turn the resolved identity plus the id-addressed detail read into the state the
 * destination renders.
 *
 * `summary` is only ever the bounded row **for the same id**. It is a cheaper
 * rendering of the subject while its detail resolves, never a different trip.
 *
 * @param {{subject?: ReturnType<typeof resolveTrackingTripSubject>,
 *          summaries?: Array<{id?: unknown}>,
 *          detail?: {data?: unknown, isPending?: boolean, isError?: boolean}}} [input]
 * @returns {{status: 'ready'|'loading'|'unavailable'|'empty', trip: unknown,
 *            summary: unknown, notice: string|null}}
 */
export function trackingTripSubjectState({ subject, summaries = [], detail = {} } = {}) {
  const resolved = subject || resolveTrackingTripSubject();
  if (resolved.rejected) {
    return { status: 'unavailable', trip: null, summary: null, notice: NOT_A_TRIP_LINK };
  }
  if (!resolved.tripId) {
    return {
      status: 'empty',
      trip: null,
      summary: null,
      notice: resolved.mode === 'explicit' ? NOT_A_TRIP_LINK : 'No completed trip selected.',
    };
  }
  if (detail.isError) {
    return {
      status: 'unavailable',
      trip: null,
      summary: null,
      notice: resolved.mode === 'explicit'
        ? `Trip ${resolved.tripId} is not available on this device. No other trip has been shown in its place.`
        : 'That trip is not available on this device.',
    };
  }
  const summary = summaryForId(summaries, resolved.tripId);
  if (detail.data) return { status: 'ready', trip: detail.data, summary, notice: null };
  return { status: 'loading', trip: null, summary, notice: null };
}

/**
 * The picker's option list.
 *
 * The bounded window is the list of trips a user can browse to. When the subject
 * was named explicitly and lies outside that window, it is added as its own
 * option so the control shows the trip actually on screen — the alternative is a
 * select whose value matches nothing, which the browser renders as some other
 * trip's label.
 *
 * Each option carries the row it came from, so a caller that renders fields
 * rather than one string does not have to re-derive the list and re-introduce the
 * omission this function exists to close.
 *
 * @param {{summaries?: Array<{id?: unknown}>, tripId?: string, subjectTrip?: unknown,
 *          formatLabel?: (trip: unknown) => string}} [input]
 * @returns {Array<{value: string, label: string, outsideWindow: boolean, trip: unknown}>}
 */
export function trackingTripPickerOptions({ summaries = [], tripId = '', subjectTrip = null, formatLabel } = {}) {
  const label = typeof formatLabel === 'function' ? formatLabel : () => 'Trip';
  const rows = (Array.isArray(summaries) ? summaries : []).map((trip) => ({
    value: String(trip?.id ?? ''),
    label: label(trip),
    outsideWindow: false,
    trip,
  }));
  const id = tripId ? String(tripId) : '';
  if (!id || rows.some((row) => row.value === id)) return rows;
  const known = subjectTrip && String(subjectTrip.id ?? '') === id ? subjectTrip : null;
  return [
    {
      value: id,
      label: known ? `${label(known)} (linked)` : 'Linked trip',
      outsideWindow: true,
      trip: known || { id },
    },
    ...rows,
  ];
}
