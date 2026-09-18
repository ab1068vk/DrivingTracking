/**
 * P7 Stage 1 — generic P7 query envelope (Annex A §A1), transcribed.
 *
 * Declaration only: nothing here executes a query, and importing it changes no
 * production behaviour. Stage 2+ implements against these constants; no later
 * stage may invent an envelope field, an outcome, or an unavailability code
 * that is not frozen below.
 *
 * The separation that A1.1 freezes:
 *   - the generic envelope belongs to P7 and appears on every Q1-Q10 result;
 *   - the P6 readiness object belongs to P6 D1-D4 and appears on Q4/Q5/Q8/Q9
 *     only, verbatim from `normalizeP6Readiness`, never flattened or synthesized;
 *   - React Query pending/fetching/error state is UI-layer only and is never an
 *     envelope field.
 */

/** The ten canonical query paths. There is no Q11. */
export const P7_QUERY_PATHS = Object.freeze({
  Q1: 'Q1', Q2: 'Q2', Q3: 'Q3', Q4: 'Q4', Q5: 'Q5',
  Q6: 'Q6', Q7: 'Q7', Q8: 'Q8', Q9: 'Q9', Q10: 'Q10',
});

/** The only completeness signal on a generic path (A1.2 rule 1). */
export const P7_COMPLETENESS = Object.freeze({ EXACT: 'EXACT', PARTIAL: 'PARTIAL' });

/** Envelope keys. `unavailable` and `p6Readiness` are conditional. */
export const P7_ENVELOPE_FIELDS = Object.freeze([
  'data', 'completeness', 'continuation', 'snapshot', 'unavailable', 'p6Readiness',
]);

/** Snapshot binding carried by every envelope (A1.2). */
export const P7_SNAPSHOT_FIELDS = Object.freeze([
  'authority', 'generation', 'revision', 'queryId', 'takenAt',
]);

export const P7_AUTHORITIES = Object.freeze({ BROWSER: 'browser', NATIVE: 'native' });

/** Enumerated unavailability codes (A1.3). This list is closed. */
export const P7_UNAVAILABLE_CODES = Object.freeze({
  CURSOR_RESTART_REQUIRED: 'CURSOR_RESTART_REQUIRED',
  CURSOR_MALFORMED: 'CURSOR_MALFORMED',
  CURSOR_VERSION_UNSUPPORTED: 'CURSOR_VERSION_UNSUPPORTED',
  CURSOR_AUTHORITY_MISMATCH: 'CURSOR_AUTHORITY_MISMATCH',
  CURSOR_QUERY_MISMATCH: 'CURSOR_QUERY_MISMATCH',
  DETAIL_NOT_FOUND: 'DETAIL_NOT_FOUND',
  DETAIL_REVISION_STALE: 'DETAIL_REVISION_STALE',
  FILTER_UNSUPPORTED: 'FILTER_UNSUPPORTED',
  REDUCER_UNKNOWN: 'REDUCER_UNKNOWN',
  REDUCER_VERSION_MISMATCH: 'REDUCER_VERSION_MISMATCH',
  ACCUMULATOR_SNAPSHOT_MISMATCH: 'ACCUMULATOR_SNAPSHOT_MISMATCH',
  OWNER_NOT_READY: 'OWNER_NOT_READY',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  AUTHORITY_UNAVAILABLE: 'AUTHORITY_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  LOW_SPACE_BLOCKED: 'LOW_SPACE_BLOCKED',
});

const C = P7_UNAVAILABLE_CODES;
const CURSOR_CODES = Object.freeze([
  C.CURSOR_RESTART_REQUIRED, C.CURSOR_MALFORMED, C.CURSOR_VERSION_UNSUPPORTED,
  C.CURSOR_AUTHORITY_MISMATCH, C.CURSOR_QUERY_MISMATCH,
]);
const TRANSPORT_CODES = Object.freeze([
  C.STORAGE_UNAVAILABLE, C.AUTHORITY_UNAVAILABLE, C.RECOVERY_REQUIRED, C.LOW_SPACE_BLOCKED,
]);

/**
 * The only paths that may carry a P6 readiness object (A1.1, A1.4).
 * A generic path carrying `p6Readiness` at all is a contract violation.
 */
export const P6_READINESS_QUERY_PATHS = Object.freeze(['Q4', 'Q5', 'Q8', 'Q9']);

/**
 * Valid outcomes per Q path (A1.4). `partialContinuation: null` means the path
 * is **never** generic PARTIAL — it may not manufacture one.
 */
export const P7_QUERY_OUTCOMES = Object.freeze({
  Q1: Object.freeze({
    exactWhen: 'page complete to hasMore:false, or a full page with a cursor v2 continuation',
    partialContinuation: 'cursor-v2',
    partialWhen: 'a filtered bounded scan exhausted its budget before k matches',
    p6Readiness: false,
    unavailable: Object.freeze([...CURSOR_CODES, C.FILTER_UNSUPPORTED, C.REQUEST_TOO_LARGE, ...TRANSPORT_CODES]),
  }),
  Q2: Object.freeze({
    exactWhen: 'record returned',
    partialContinuation: null,
    partialWhen: null,
    p6Readiness: false,
    unavailable: Object.freeze([C.DETAIL_NOT_FOUND, C.DETAIL_REVISION_STALE, ...TRANSPORT_CODES]),
  }),
  Q3: Object.freeze({
    // Q3's contract IS a stride-sampled, maxPoints-capped overview; the result is
    // complete for that contract. Callers needing full fidelity request Q2.
    exactWhen: 'a track is returned; data carries {sampled,maxPoints,strideApplied,sourcePointCount}',
    partialContinuation: null,
    partialWhen: null,
    p6Readiness: false,
    unavailable: Object.freeze([C.DETAIL_NOT_FOUND, ...TRANSPORT_CODES]),
  }),
  Q4: Object.freeze({
    // Q4 owns no continuation. An unsupported filter is FILTER_UNSUPPORTED with
    // no data; the page composition then selects the Q10 reducer its Annex C row
    // names, and Q10 owns the continuation.
    exactWhen: 'exact aggregate read from a total/bucket the owner keys',
    partialContinuation: null,
    partialWhen: null,
    p6Readiness: true,
    // OWNER_NOT_READY is included here by Annex C §C4, which states the law for
    // ANY P6 D1-D4 domain that is not `VERIFIED && complete`: the envelope
    // carries the verbatim p6Readiness plus that typed code, and may never
    // become a zero, an empty result or an exact total. Q4 reads D1 and carries
    // readiness, so the condition is reachable here; §A1.3's "raised by" column
    // names the two paths that motivated the code, not an exhaustive list of
    // D1 readers. No code, outcome class or continuation is added by this.
    unavailable: Object.freeze([C.FILTER_UNSUPPORTED, C.OWNER_NOT_READY, ...TRANSPORT_CODES]),
  }),
  Q5: Object.freeze({
    exactWhen: 'the requested bucket range is fully served',
    partialContinuation: 'next-bucket-range',
    partialWhen: 'the output limit truncated the requested bucket range',
    p6Readiness: true,
    // Same Annex C §C4 law as Q4: Q5 reads D1 and carries its readiness.
    unavailable: Object.freeze([
      C.FILTER_UNSUPPORTED, C.OWNER_NOT_READY, C.REQUEST_TOO_LARGE, ...TRANSPORT_CODES,
    ]),
  }),
  Q6: Object.freeze({
    exactWhen: '1 row, or a proven end of history',
    partialContinuation: null,
    partialWhen: null,
    p6Readiness: false,
    unavailable: Object.freeze([C.DETAIL_NOT_FOUND, ...TRANSPORT_CODES]),
  }),
  Q7: Object.freeze({
    exactWhen: 'maxRecent satisfied or history exhausted; data says {cappedAt:maxRecent}',
    partialContinuation: null,
    partialWhen: null,
    p6Readiness: false,
    unavailable: Object.freeze([...TRANSPORT_CODES]),
  }),
  Q8: Object.freeze({
    // A D2 refusal is NOT generic PARTIAL: the real readiness is surfaced with
    // no fabricated progress.
    exactWhen: 'the fixed Q1 page is fully hydrated and no further Q1 page exists',
    partialContinuation: 'cursor-v2',
    partialWhen: 'a further Q1 page exists',
    p6Readiness: true,
    unavailable: Object.freeze([...CURSOR_CODES, C.OWNER_NOT_READY, ...TRANSPORT_CODES]),
  }),
  Q9: Object.freeze({
    exactWhen: 'surfaces read from a VERIFIED && complete D1',
    partialContinuation: null,
    partialWhen: null,
    p6Readiness: true,
    unavailable: Object.freeze([C.OWNER_NOT_READY, ...TRANSPORT_CODES]),
  }),
  Q10: Object.freeze({
    exactWhen: 'terminal EOF reached for the bound snapshot',
    partialContinuation: 'q10-continuation',
    partialWhen: 'any state before terminal EOF',
    p6Readiness: false,
    unavailable: Object.freeze([
      C.REDUCER_UNKNOWN, C.REDUCER_VERSION_MISMATCH, C.ACCUMULATOR_SNAPSHOT_MISMATCH,
      ...CURSOR_CODES, ...TRANSPORT_CODES,
    ]),
  }),
});

/**
 * Frozen public page limit (OQ-5): an integer in [1, 200] inclusive on both
 * authorities. It is **validated, not silently clamped**.
 */
export const P7_PUBLIC_PAGE_LIMIT = Object.freeze({ min: 1, max: 200 });

export class P7QueryContractError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message || code);
    this.name = 'P7QueryContractError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Validate a public P7 page limit. Never clamps: an out-of-range or non-integer
 * request is `REQUEST_TOO_LARGE`, identically on both authorities.
 * @param {unknown} limit
 * @returns {number}
 */
export function assertP7PublicLimit(limit) {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new P7QueryContractError(C.REQUEST_TOO_LARGE, 'P7 page limit must be a primitive integer.', { limit });
  }
  if (limit < P7_PUBLIC_PAGE_LIMIT.min || limit > P7_PUBLIC_PAGE_LIMIT.max) {
    throw new P7QueryContractError(C.REQUEST_TOO_LARGE, 'P7 page limit is outside [1,200].', {
      limit, minimum: P7_PUBLIC_PAGE_LIMIT.min, maximum: P7_PUBLIC_PAGE_LIMIT.max,
    });
  }
  return limit;
}

/**
 * The three mechanical laws of A1.4, stated once so contract fixtures derive
 * from them rather than restating them:
 *   1. PARTIAL implies a real, non-null continuation;
 *   2. `unavailable` implies no data;
 *   3. `p6Readiness` appears on Q4/Q5/Q8/Q9 and nowhere else.
 * Returns the list of violated laws; empty means structurally valid.
 * @param {string} queryPath
 * @param {object} envelope
 * @returns {string[]}
 */
export function p7EnvelopeViolations(queryPath, envelope) {
  const outcome = P7_QUERY_OUTCOMES[queryPath];
  const problems = [];
  if (!outcome) return [`unknown query path: ${queryPath}`];
  if (!envelope || typeof envelope !== 'object') return ['envelope is not an object'];

  const hasUnavailable = envelope.unavailable != null;
  const hasData = envelope.data != null;

  if (hasUnavailable) {
    if (hasData) problems.push('unavailable result carries data');
    if (!outcome.unavailable.includes(envelope.unavailable.code)) {
      problems.push(`unavailable code ${envelope.unavailable.code} is not valid for ${queryPath}`);
    }
  } else {
    if (envelope.completeness !== P7_COMPLETENESS.EXACT
      && envelope.completeness !== P7_COMPLETENESS.PARTIAL) {
      problems.push('completeness must be EXACT or PARTIAL');
    }
    if (envelope.completeness === P7_COMPLETENESS.PARTIAL) {
      if (outcome.partialContinuation === null) {
        problems.push(`${queryPath} is never generic PARTIAL`);
      } else if (envelope.continuation == null) {
        problems.push('PARTIAL without a continuation');
      }
    }
  }

  const carries = envelope.p6Readiness != null;
  if (carries && !outcome.p6Readiness) problems.push(`${queryPath} must not carry p6Readiness`);
  if (envelope.unavailable?.code === C.OWNER_NOT_READY && !carries) {
    problems.push('OWNER_NOT_READY without the verbatim p6Readiness object');
  }
  return problems;
}

/** Throwing form of {@link p7EnvelopeViolations}. */
export function assertP7Envelope(queryPath, envelope) {
  const problems = p7EnvelopeViolations(queryPath, envelope);
  if (problems.length) {
    throw new P7QueryContractError('ENVELOPE_CONTRACT_VIOLATION', problems.join('; '), { queryPath, problems });
  }
  return envelope;
}

/**
 * Existing typed errors are reused, not replaced (A1.3). These map the two
 * current error families onto the enumerated codes.
 */
export function p7CodeForProjectionQueryError(error) {
  const message = String(error?.message || '');
  if (/version is unsupported/i.test(message)) return C.CURSOR_VERSION_UNSUPPORTED;
  if (/does not match this query/i.test(message)) return C.CURSOR_QUERY_MISMATCH;
  if (/malformed|not a token/i.test(message)) return C.CURSOR_MALFORMED;
  if (/out of range|must be a primitive integer/i.test(message)) return C.REQUEST_TOO_LARGE;
  return C.STORAGE_UNAVAILABLE;
}

export function p7CodeForCanonicalArchiveError(error) {
  switch (error?.code) {
    case 'RECOVERY_REQUIRED': return C.RECOVERY_REQUIRED;
    case 'LOW_SPACE_BLOCKED': return C.LOW_SPACE_BLOCKED;
    case 'REQUEST_TOO_LARGE': return C.REQUEST_TOO_LARGE;
    case 'CURSOR_QUERY_MISMATCH': return C.CURSOR_QUERY_MISMATCH;
    default: return C.AUTHORITY_UNAVAILABLE;
  }
}
