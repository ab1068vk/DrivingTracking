/**
 * Bounded keyset selection for the P3 projection path.
 *
 * Ordering and identity come from the **source** store (`trips`), never from the
 * projection cache, so a bounded page is correct at zero migration progress and
 * a missing or corrupt projection can never hide a trip.
 *
 * An `IDBKeyRange` constrains only the index key, so the primary key is carried
 * inside the compound index (`['start_time','id']` /
 * `['status','start_time','id']`) rather than relied on as an implicit
 * tie-breaker. Reverse traversal therefore yields `(start_time DESC, id DESC)`,
 * a deliberate, documented change from the legacy stable-sort tie order.
 */

export const PROJECTION_CURSOR_VERSION = 1;

/** Supported orderings. Anything else is a typed error, never reinterpreted. */
export const SUPPORTED_SORTS = Object.freeze(['-start_time', 'start_time']);

export class ProjectionQueryError extends TypeError {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ProjectionQueryError';
    this.detail = detail;
  }
}

/**
 * One validator shared by the repository, the service layer and the query-option
 * helpers. Every layer throws the same typed error; no layer clamps, because a
 * clamp upstream would make the repository's guard unreachable.
 *
 * @param {{ sort?: any, limit?: any }} options
 * @param {{ maxLimit: number, defaultLimit: number }} bounds
 * @returns {{ sort: string, limit: number, direction: 'prev' | 'next' }}
 */
export function assertProjectionQuery(options = {}, bounds) {
  const { sort, limit } = options;
  const resolvedSort = sort === undefined ? '-start_time' : sort;
  if (typeof resolvedSort !== 'string' || !SUPPORTED_SORTS.includes(resolvedSort)) {
    throw new ProjectionQueryError('Unsupported sort for the bounded projection query.', { sort });
  }

  let resolvedLimit;
  if (limit === undefined) {
    resolvedLimit = bounds.defaultLimit;
  } else if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    // Rejects numeric strings, null, booleans, boxed Numbers, fractions, NaN
    // and both infinities in one test.
    throw new ProjectionQueryError('Projection query limit must be a primitive integer.', { limit });
  } else if (limit < 1 || limit > bounds.maxLimit) {
    throw new ProjectionQueryError('Projection query limit is out of range.', {
      limit, maximum: bounds.maxLimit,
    });
  } else {
    resolvedLimit = limit;
  }

  return {
    sort: resolvedSort,
    limit: resolvedLimit,
    direction: resolvedSort === '-start_time' ? 'prev' : 'next',
  };
}

/**
 * Stable signature of everything that affects ordering or filtering. A cursor
 * minted for one query must not be accepted by another.
 * @param {{ sort: string, status?: string | null }} query
 */
export const querySignature = (query) => `${query.sort}|${query.status ?? '*'}`;

/**
 * Cursor tokens carry only values that are already plaintext in the store and in
 * the index key, so they introduce no new exposure. They stay memory-only and
 * must never reach logs, diagnostics, P0 or browser history.
 * @param {{ sort: string, status?: string | null, startTime: string, id: string }} position
 */
export function encodeProjectionCursor(position) {
  const payload = {
    v: PROJECTION_CURSOR_VERSION,
    q: querySignature(position),
    t: String(position.startTime ?? ''),
    i: String(position.id ?? ''),
  };
  const json = JSON.stringify(payload);
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * @param {string | null | undefined} token
 * @param {{ sort: string, status?: string | null }} query
 * @returns {{ startTime: string, id: string } | null}
 */
export function decodeProjectionCursor(token, query) {
  if (token == null || token === '') return null;
  if (typeof token !== 'string') {
    throw new ProjectionQueryError('Projection cursor is not a token.', {});
  }
  let payload;
  try {
    const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function'
      ? decodeURIComponent(escape(atob(normalized)))
      : Buffer.from(normalized, 'base64').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    throw new ProjectionQueryError('Projection cursor is malformed.', {});
  }
  if (!payload || payload.v !== PROJECTION_CURSOR_VERSION) {
    throw new ProjectionQueryError('Projection cursor version is unsupported.', {});
  }
  if (payload.q !== querySignature(query)) {
    // Reusing an ascending token under descending semantics, or a token from a
    // differently filtered query, is rejected rather than silently restarted.
    throw new ProjectionQueryError('Projection cursor does not match this query.', {});
  }
  return { startTime: String(payload.t ?? ''), id: String(payload.i ?? '') };
}

/**
 * Build the exclusive `IDBKeyRange` for the next page.
 *
 * @param {object} idbKeyRange the `IDBKeyRange` constructor
 * @param {{ status?: string | null, direction: 'prev' | 'next',
 *          cursor: { startTime: string, id: string } | null }} query
 */
export function buildProjectionKeyRange(idbKeyRange, query) {
  const { status, direction, cursor } = query;
  const filtered = status != null && status !== '';

  if (!cursor) {
    if (!filtered) return null;
    // All keys sharing this status, whatever their time/id components.
    return idbKeyRange.bound([status], [status, [], []], false, false);
  }

  const bound = filtered
    ? [status, cursor.startTime, cursor.id]
    : [cursor.startTime, cursor.id];

  if (direction === 'prev') {
    return filtered
      ? idbKeyRange.bound([status], bound, false, true)
      : idbKeyRange.upperBound(bound, true);
  }
  return filtered
    ? idbKeyRange.bound(bound, [status, [], []], true, false)
    : idbKeyRange.lowerBound(bound, true);
}

/**
 * Build the `IDBKeyRange` for a P7 Q1 page (cursor v2).
 *
 * Unlike the v1 builder this accepts a **typed** keyset position and an
 * optional `start_time` range, both of which are served by the existing
 * `['start_time','id']` / `['status','start_time','id']` indexes — no new index
 * (OQ-2 is closed against one).
 *
 * Key ordering note: an array sorts after every string and number in IndexedDB,
 * so `[]` is the open upper sentinel for a trailing key component, exactly as
 * the v1 builder already uses it.
 *
 * @param {object} idbKeyRange the `IDBKeyRange` constructor
 * @param {{status?: string|null, direction: 'prev'|'next',
 *          position?: {startTime: any, id: any} | null,
 *          fromKey?: any, toKey?: any}} query
 */
export function buildProjectionRangeV2(idbKeyRange, query) {
  const { status, direction, position = null, fromKey = null, toKey = null } = query;
  const filtered = status != null && status !== '' && status !== 'any';
  const prefix = filtered ? [status] : [];

  // `[from, to)` — half-open on both authorities.
  let lower = fromKey != null ? [...prefix, fromKey] : (filtered ? [...prefix] : null);
  let lowerOpen = false;
  let upper = toKey != null ? [...prefix, toKey] : (filtered ? [...prefix, [], []] : null);
  let upperOpen = toKey != null;

  if (position) {
    const at = [...prefix, position.startTime, position.id];
    if (direction === 'prev') {
      upper = at;
      upperOpen = true;
    } else {
      lower = at;
      lowerOpen = true;
    }
  }

  if (lower == null && upper == null) return null;
  if (lower == null) return idbKeyRange.upperBound(upper, upperOpen);
  if (upper == null) return idbKeyRange.lowerBound(lower, lowerOpen);
  return idbKeyRange.bound(lower, upper, lowerOpen, upperOpen);
}

/** Index that serves a query, chosen by whether a fixed status is requested. */
export const projectionIndexFor = (status, unfiltered, filtered) => (
  status != null && status !== '' ? filtered : unfiltered
);
