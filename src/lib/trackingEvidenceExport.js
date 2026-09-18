/**
 * HPR-019 — the bounded evidence stream behind every Reports Lab artifact.
 *
 * THE DEFECT. The exports on that page enumerated the completed population with
 * Q1 and handed the resulting **projection rows** straight to evidence builders.
 * The projection carries aggregate counters, not payload: it has no
 * `route_points` and no `driving_events`. A builder that reads
 * `trip.route_points?.length` therefore recorded `0` retained samples, `0` gaps
 * and `0` events for trips whose canonical records hold all three — and printed
 * those zeros as measurements. Separately, the signed manifest and the PDF were
 * built from a literal `trips: []`, so the signature covered evidence for zero
 * trips while the surrounding card advertised the real lifetime count.
 *
 * THE RULE. An artifact describes the population it actually read. So evidence
 * comes from the canonical per-trip record, and the population claim is produced
 * by the same walk that produced the evidence — never from a second source that
 * can disagree with it.
 *
 * THE BOUND. Enumeration is one Q1 page at a time; hydration is one small chunk
 * of full records at a time, handed to the caller and then released. Nothing
 * here retains a trip after `onChunk` returns, and nothing accumulates the
 * population. Resident cost is one page of projection rows plus one chunk of
 * full records; what the caller keeps is the caller's business, and the summary
 * accumulator below keeps O(1) totals plus a bounded extract on purpose.
 *
 * WHAT FAILURE MEANS. A scan that did not reach the end of the population, a
 * page that could not be read, a trip whose detail could not be read, or a
 * source that moved underneath the walk all produce `complete: false` with a
 * typed failure. A caller may not present a partial read as a finished artifact.
 *
 * SOURCE COHERENCE (the Wave 6 correction). Comparing source identity between Q1
 * pages is not enough: a population that fits in one page has no second page
 * request, so a canonical mutation DURING that page's detail hydration was never
 * rejected, and the walk reported `complete: true` over evidence assembled from
 * two states. The identity is therefore re-checked after every hydration chunk,
 * BEFORE that chunk is handed to the caller, and once more before completion is
 * claimed. A chunk that fails the check never reaches the artifact at all.
 *
 * This works only because `readTrip` is an export read that does not write. The
 * ordinary detail read persists a rescore and so advances the query revision on
 * every call; a coherence check built on that read would refuse every export it
 * was meant to protect.
 */

/** The marker an evidence row carries when the record did not contain evidence. */
export const EVIDENCE_NOT_INCLUDED = 'evidence_not_included';

/** One Q1 page. Matches the limit the page has always requested. */
export const EVIDENCE_PAGE_LIMIT = 200;

/**
 * How many full records are resident at once.
 *
 * Small on purpose: a canonical record carries its whole route and event
 * payload, so this is the only number that bounds evidence residency. It is not
 * a cap on the population — every page is still walked.
 */
export const EVIDENCE_HYDRATION_CHUNK = 25;

/** The same turn ceiling the page has always applied to its own scan. */
export const EVIDENCE_MAX_TURNS = 5000;

export const EVIDENCE_FAILURE = Object.freeze({
  PAGE_UNAVAILABLE: 'PAGE_UNAVAILABLE',
  SOURCE_MOVED: 'SOURCE_MOVED',
  DETAIL_READ_FAILED: 'DETAIL_READ_FAILED',
  SCAN_LIMIT_REACHED: 'SCAN_LIMIT_REACHED',
});

const snapshotIdentity = (snapshot) => (snapshot
  ? `${snapshot.authority ?? ''}:${snapshot.generation ?? ''}:${snapshot.revision ?? ''}`
  : '');

const chunkOf = (rows, size) => {
  const out = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
};

/**
 * Walk the completed population, handing the caller bounded chunks.
 *
 * `onChunk({ summaries, trips })` receives the page's projection rows and the
 * canonical records for that chunk, in the same order. Both are handed over so a
 * caller can read a projection counter without having to guess which
 * representation it holds; the evidence itself always comes from `trips`.
 *
 * @param {{
 *   readPage: (request: object) => Promise<object>,
 *   readTrip?: (id: string) => Promise<object>,
 *   readSourceSnapshot?: (() => Promise<object>)|null,
 *   onChunk: (chunk: {summaries: object[], trips: object[]}) => unknown,
 *   pageLimit?: number,
 *   chunkSize?: number,
 *   maxTurns?: number,
 * }} options
 * @returns {Promise<{complete: boolean, tripCount: number, snapshot: object|null,
 *                    failure: {code: string, detail?: string}|null}>}
 */
export async function streamTripEvidence({
  readPage,
  readTrip,
  readSourceSnapshot,
  onChunk,
  pageLimit = EVIDENCE_PAGE_LIMIT,
  chunkSize = EVIDENCE_HYDRATION_CHUNK,
  maxTurns = EVIDENCE_MAX_TURNS,
} = {}) {
  if (typeof readPage !== 'function') throw new TypeError('streamTripEvidence requires readPage');
  if (typeof onChunk !== 'function') throw new TypeError('streamTripEvidence requires onChunk');
  if (typeof readTrip !== 'function') throw new TypeError('streamTripEvidence requires readTrip');
  // Without it the walk cannot prove the evidence still belongs to the snapshot
  // it will claim, and an artifact that cannot prove that must not be built.
  if (typeof readSourceSnapshot !== 'function') {
    throw new TypeError('streamTripEvidence requires readSourceSnapshot');
  }

  let cursor = null;
  let tripCount = 0;
  let snapshot = null;
  let identity = '';

  const failed = (code, detail) => ({ complete: false, tripCount, snapshot, failure: { code, detail } });

  /**
   * Has the canonical source moved since the page this walk is reading?
   *
   * Returns a typed failure, or `null` when the source still matches. It is a
   * single O(1) identity read; it never touches a trip, a route or a page.
   */
  const sourceDrift = async () => {
    if (!snapshot) return null;
    let current;
    try {
      current = await readSourceSnapshot();
    } catch {
      // Unable to prove coherence is not the same as proving it. Refuse.
      return failed(EVIDENCE_FAILURE.SOURCE_MOVED, 'source_identity_unreadable');
    }
    const now = snapshotIdentity(current);
    return now === identity ? null : failed(EVIDENCE_FAILURE.SOURCE_MOVED, now);
  };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const page = await readPage({
      sort: '-start_time', status: 'completed', limit: pageLimit, cursor,
    });
    if (page?.unavailable) {
      // The cursor is bound to the source generation/revision, so a canonical
      // change mid-walk lands here as a rejection rather than as page 2 of a
      // different population. Either way the artifact is not finished.
      return failed(EVIDENCE_FAILURE.PAGE_UNAVAILABLE, page.unavailable.code || 'page_unavailable');
    }

    if (!snapshot) {
      snapshot = page?.snapshot ?? null;
      identity = snapshotIdentity(snapshot);
    } else if (snapshotIdentity(page?.snapshot) !== identity) {
      // Belt as well as braces: if a continuation were ever accepted across a
      // source change, pages 1 and 2 would describe two different populations
      // and the artifact would sign their union as one coherent history.
      return failed(EVIDENCE_FAILURE.SOURCE_MOVED, snapshotIdentity(page?.snapshot));
    }

    const summaries = Array.isArray(page?.data) ? page.data : [];
    for (const group of chunkOf(summaries, Math.max(1, chunkSize))) {
      const trips = [];
      for (const summary of group) {
        const id = summary?.id;
        try {
          // Identity, not position: the canonical record for exactly this id.
          trips.push(await readTrip(id));
        } catch {
          // A trip that could not be read is not a trip with no evidence.
          return failed(EVIDENCE_FAILURE.DETAIL_READ_FAILED, String(id ?? 'unknown'));
        }
      }
      // The correction. The chunk is held back until the source it was read
      // under is proved unmoved; a chunk that fails here never becomes part of
      // any CSV line, summary total, PDF row or signed payload. Buffering is one
      // chunk, never the population.
      const drift = await sourceDrift();
      if (drift) return drift;

      await onChunk({ summaries: group, trips });
      tripCount += group.length;
    }

    // Q1's `completeness` describes the page, so the only terminal signal for a
    // whole-population walk is a null continuation.
    if (!page?.continuation) {
      // One last check before the walk calls itself complete: a mutation after
      // the final chunk was released is still a mutation this artifact would
      // otherwise have claimed to predate.
      const drift = await sourceDrift();
      if (drift) return drift;
      return { complete: true, tripCount, snapshot, failure: null };
    }
    cursor = page.continuation;
  }

  return failed(EVIDENCE_FAILURE.SCAN_LIMIT_REACHED, String(maxTurns));
}

const numericOrNull = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * O(1) totals plus a bounded extract, for artifacts that describe a population
 * they cannot embed.
 *
 * The three evidence states are kept apart on purpose: a trip whose route was
 * measured and found empty, a trip whose route evidence this artifact did not
 * read, and a trip with no events are three different facts. Collapsing them
 * into one numeric zero is the untruth HPR-019 exists to remove.
 *
 * @param {{extractLimit?: number}} [options]
 */
export function createEvidenceSummaryAccumulator({ extractLimit = 250 } = {}) {
  const totals = {
    trip_count: 0,
    route_evidence_trip_count: 0,
    route_evidence_unavailable_trip_count: 0,
    retained_route_point_total: 0,
    route_gap_total: 0,
    privacy_masked_sample_total: 0,
    privacy_masked_trip_count: 0,
    speed_sample_total: 0,
    speed_limit_sample_total: 0,
    event_row_count: 0,
    event_evidence_unavailable_trip_count: 0,
    trips_with_events_count: 0,
  };
  const routeQualityExtract = [];
  const eventExtract = [];
  const limit = Math.max(0, Number(extractLimit) || 0);
  let routeQualityTruncated = false;
  let eventTruncated = false;

  const addTo = (key, value) => {
    const number = numericOrNull(value);
    if (number != null) totals[key] += number;
  };

  return {
    /**
     * @param {{routeQualityRows?: object[], eventRows?: object[]}} chunk
     */
    addChunk({ routeQualityRows = [], eventRows = [] } = {}) {
      const eventTripIds = new Set();
      routeQualityRows.forEach((row) => {
        totals.trip_count += 1;
        if (row.route_evidence === 'recorded') {
          totals.route_evidence_trip_count += 1;
          addTo('retained_route_point_total', row.retained_route_points);
          addTo('route_gap_total', row.route_gap_count);
          addTo('privacy_masked_sample_total', row.privacy_masked_samples);
          addTo('speed_sample_total', row.speed_samples);
          addTo('speed_limit_sample_total', row.speed_limit_samples);
          if (row.privacy_status === 'privacy masked') totals.privacy_masked_trip_count += 1;
        } else {
          totals.route_evidence_unavailable_trip_count += 1;
        }
        if (routeQualityExtract.length < limit) routeQualityExtract.push(row);
        else routeQualityTruncated = true;
      });
      eventRows.forEach((row) => {
        if (row.event_type === EVIDENCE_NOT_INCLUDED) {
          totals.event_evidence_unavailable_trip_count += 1;
        } else {
          totals.event_row_count += 1;
          if (row.trip_id) eventTripIds.add(row.trip_id);
        }
        if (eventExtract.length < limit) eventExtract.push(row);
        else eventTruncated = true;
      });
      totals.trips_with_events_count += eventTripIds.size;
    },
    totals: () => ({ ...totals }),
    extracts: () => ({
      route_quality_rows: [...routeQualityExtract],
      event_rows: [...eventExtract],
      extract_row_limit: limit,
      route_quality_extract_truncated: routeQualityTruncated,
      event_extract_truncated: eventTruncated,
    }),
  };
}

