/**
 * **Q10** — the named, versioned, deterministic reducer runner.
 *
 * Q10 accepts **no** arbitrary executable predicate or field list: a caller
 * names a registry identity and nothing else. An opaque continuation cannot
 * encode, validate or version a JavaScript callback, which is why the registry
 * exists.
 *
 * Each invocation performs **exactly one** declared bounded scan turn — at most
 * one Q1 page budget of source rows, under the same per-page bounds the history
 * contract imposes. It then returns `PARTIAL` plus a continuation, or `EXACT`
 * **only** at terminal EOF for the bound snapshot.
 *
 * Continuations are **ephemeral and page-owned**: nothing here persists,
 * schedules, or drains them. That is why P7 adds zero lifecycle jobs, zero
 * coordinator registrations and zero explicit operations.
 */

import {
  P7_COMPLETENESS,
  P7_UNAVAILABLE_CODES,
} from '@/lib/queryContracts/envelope';
import { P7_REDUCER_BY_IDENTITY } from '@/lib/queryContracts/reducers';
import { queryTripHistoryPage } from '@/lib/localTripRepository';
import { canonicalJson, digestHex } from '@/lib/tripQueryCursor';
import { P7_POPULATION_PREDICATES, localDayKey } from '@/lib/queryReducers/populations';
import { REPORT_REDUCERS } from '@/lib/queryReducers/reportReducers';
import { DOMAIN_REDUCERS } from '@/lib/queryReducers/domainReducers';

/** Every implemented reducer, keyed by its frozen registry identity. */
export const P7_REDUCER_IMPLEMENTATIONS = Object.freeze(Object.fromEntries(
  [...REPORT_REDUCERS, ...DOMAIN_REDUCERS].map((entry) => [entry.identity, entry])
));

const base64urlEncode = (text) => (typeof btoa === 'function'
  ? btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  : Buffer.from(text, 'utf8').toString('base64url'));

const base64urlDecode = (token) => {
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  return typeof atob === 'function'
    ? decodeURIComponent(escape(atob(normalized)))
    : Buffer.from(normalized, 'base64').toString('utf8');
};

/**
 * §A3.2 — the continuation binds reducer identity and version, the normalized
 * range and filter identity, the authority and source snapshot, the last key,
 * the fixed-size accumulator, and its own integrity metadata.
 */
const encodeContinuation = async (state) => base64urlEncode(canonicalJson({
  ...state,
  meta: { ...state.meta, mac: await digestHex(canonicalJson(state)) },
}));

const decodeContinuation = async (token) => {
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(token));
  } catch {
    return { error: P7_UNAVAILABLE_CODES.CURSOR_MALFORMED };
  }
  const { meta, ...rest } = payload ?? {};
  if (!meta || typeof meta.mac !== 'string') return { error: P7_UNAVAILABLE_CODES.CURSOR_MALFORMED };
  const { mac, ...metaRest } = meta;
  const expected = await digestHex(canonicalJson({ ...rest, meta: metaRest }));
  if (mac !== expected) return { error: P7_UNAVAILABLE_CODES.CURSOR_MALFORMED };
  return { state: { ...rest, meta: metaRest } };
};

/**
 * Run one bounded Q10 turn.
 *
 * @param {{reducer: string, version?: number, status?: string|null,
 *          range?: {fromMs?: number|null, toMs?: number|null},
 *          filter?: object|null, limit?: number, continuation?: string|null,
 *          context?: object, settings?: object}} request
 * @returns {Promise<object>} the generic P7 query envelope
 */
export async function queryTripReducer(request = {}) {
  return runReducerOverPages(request, queryTripHistoryPage);
}

/**
 * The reducer runner, with its **row source injected**.
 *
 * The registry, the populations, the folds and the continuation format are
 * authority-agnostic — only where a page of rows comes from differs. Running
 * the identical implementations over a native Q1 page is what makes V13
 * parity a real comparison rather than two implementations that happen to
 * agree today.
 *
 * @param {object} request the Q10 request
 * @param {(page: object) => Promise<object>} readPage the authority's Q1
 */
export async function runReducerOverPages(request = {}, readPage = queryTripHistoryPage) {
  const {
    reducer: identityInput, version = 1, status = 'completed', range = null,
    filter = null, limit = 100, continuation = null, context = {}, settings = {},
    narrowTo = null,
  } = request;

  const identity = String(identityInput ?? '').includes('@')
    ? String(identityInput)
    : `${identityInput}@${version}`;

  const declared = P7_REDUCER_BY_IDENTITY[identity];
  const implementation = P7_REDUCER_IMPLEMENTATIONS[identity];
  const fail = (code, reason) => ({
    data: null, completeness: null, continuation: null,
    snapshot: null, unavailable: { code, reason },
  });

  if (!declared || !implementation) {
    // A reducer absent from the frozen registry is refused, never improvised.
    const known = Object.keys(P7_REDUCER_BY_IDENTITY)
      .some((key) => key.split('@')[0] === String(identityInput).split('@')[0]);
    return fail(
      known ? P7_UNAVAILABLE_CODES.REDUCER_VERSION_MISMATCH : P7_UNAVAILABLE_CODES.REDUCER_UNKNOWN,
      identity,
    );
  }

  // A caller may narrow a reducer to one of the **six frozen populations**,
  // and only ever by intersection with the reducer's own declared population.
  //
  // O47 is why this exists. `buildScoreTips` needs a night-trip count and a
  // distance-weighted score over `P-SCORETIP`, and the two reducers that carry
  // those terms — `nightExposure@1` and `durationDistance@1` — declare
  // `P-DRIVER`. `P-SCORETIP` **is** `P-DRIVER` plus two row predicates, so the
  // narrowing is a restriction of the same population, not a different owner.
  //
  // It can only ever remove rows. It cannot widen a population, name a
  // population that is not frozen, add an owner, or change an accumulator's
  // size. The narrowing is bound into the continuation, so a turn cannot
  // resume under a different one.
  if (narrowTo !== null && !P7_POPULATION_PREDICATES[narrowTo]) {
    return fail(P7_UNAVAILABLE_CODES.REDUCER_UNKNOWN, `population:${narrowTo}`);
  }

  let carried = null;
  if (continuation) {
    const decoded = await decodeContinuation(continuation);
    if (decoded.error) return fail(decoded.error, 'continuation_rejected');
    carried = decoded.state;
    if (carried.reducer?.id !== declared.id || Number(carried.reducer?.version) !== Number(declared.version)) {
      return fail(P7_UNAVAILABLE_CODES.REDUCER_VERSION_MISMATCH, 'continuation_reducer_mismatch');
    }
  }

  // One declared bounded scan turn: exactly one Q1 page.
  const page = await readPage({
    sort: '-start_time',
    status,
    range,
    filter,
    limit,
    cursor: carried?.cursor ?? null,
  });
  if (page.unavailable) {
    // A snapshot that moved under an in-flight accumulation discards it rather
    // than merging contributions across two source snapshots.
    const cursorRejected = String(page.unavailable.code).startsWith('CURSOR_');
    return {
      ...page,
      unavailable: cursorRejected
        ? { code: P7_UNAVAILABLE_CODES.ACCUMULATOR_SNAPSHOT_MISMATCH, reason: page.unavailable.code }
        : page.unavailable,
    };
  }

  const bind = {
    range: {
      fromMs: Number.isFinite(range?.fromMs) ? Number(range.fromMs) : null,
      toMs: Number.isFinite(range?.toMs) ? Number(range.toMs) : null,
    },
    status: status ?? 'any',
    sort: '-start_time',
    filterId: page.snapshot.queryId,
    narrowTo: narrowTo ?? null,
  };
  if (carried && canonicalJson(carried.bind) !== canonicalJson(bind)) {
    return fail(P7_UNAVAILABLE_CODES.ACCUMULATOR_SNAPSHOT_MISMATCH, 'bind_changed');
  }
  const src = {
    authority: page.snapshot.authority,
    generation: page.snapshot.generation,
    revision: page.snapshot.revision,
  };
  if (carried && canonicalJson(carried.src) !== canonicalJson(src)) {
    return fail(P7_UNAVAILABLE_CODES.ACCUMULATOR_SNAPSHOT_MISMATCH, 'snapshot_changed');
  }

  const foldContext = { ...context, localDayKey };
  const accumulator = carried?.acc ?? implementation.init(context);
  const predicate = P7_POPULATION_PREDICATES[implementation.population];
  const narrowing = narrowTo ? P7_POPULATION_PREDICATES[narrowTo] : null;
  let folded = accumulator;
  let rowsVisited = 0;
  for (const row of page.data) {
    rowsVisited += 1;
    // Intersection, in this order: the reducer's own population always
    // applies, and the narrowing can only take rows away from it.
    if (!predicate(row, settings)) continue;
    if (narrowing && !narrowing(row, settings)) continue;
    folded = implementation.fold(folded, row, foldContext);
  }

  const terminal = page.continuation == null;
  if (terminal) {
    return {
      data: implementation.finish(folded),
      // EXACT only at terminal EOF for the bound snapshot.
      completeness: P7_COMPLETENESS.EXACT,
      continuation: null,
      snapshot: page.snapshot,
    };
  }

  const nextState = {
    v: 1,
    reducer: { id: declared.id, version: declared.version },
    bind,
    src,
    cursor: page.continuation,
    acc: folded,
    meta: {
      v: 1,
      turns: Number(carried?.meta?.turns ?? 0) + 1,
      rowsVisited: Number(carried?.meta?.rowsVisited ?? 0) + rowsVisited,
    },
  };

  return {
    // A PARTIAL accumulation is never labelled, exported or rendered as an
    // exact or lifetime total, so the running value is reported as `partial`.
    data: { partial: implementation.finish(folded) },
    completeness: P7_COMPLETENESS.PARTIAL,
    continuation: await encodeContinuation(nextState),
    snapshot: page.snapshot,
  };
}

/**
 * Drive a reducer to terminal EOF through successive bounded turns.
 *
 * This is the explicit, user-triggered "continue / finish analysis" path of
 * §A3.5: it is cancellable, holds one bounded page at a time, and creates no
 * durable operation. **No render, effect, focus handler, resume handler or
 * cache invalidation may call it.**
 *
 * @param {object} request the same shape `queryTripReducer` takes
 * @param {{maxTurns?: number, signal?: AbortSignal}} [options]
 */
export async function runTripReducerToExact(request, options = {}) {
  const maxTurns = Number(options.maxTurns) || 1000;
  let result = await queryTripReducer(request);
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.signal?.aborted) return { ...result, cancelled: true };
    if (result.unavailable || result.completeness === P7_COMPLETENESS.EXACT) return result;
    if (!result.continuation) return result;
    result = await queryTripReducer({ ...request, continuation: result.continuation });
  }
  return result;
}
