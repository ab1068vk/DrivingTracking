/**
 * Browser cursor v2 (Annex A §A2), implemented.
 *
 * The v1 cursor (`tripProjectionQuery.js`) binds only sort/status and position,
 * **stringifies the id**, and carries no source revision, so it cannot deliver
 * the no-duplicate / no-skip law. v2 fixes all three:
 *
 *   - `key.t` records the exact IndexedDB key type and decoding restores it, so
 *     the `IDBKeyRange` is built from the original types and IndexedDB's own key
 *     ordering governs the range exactly as it does for a live cursor;
 *   - `bind` carries the normalized sort, status, range and filter identity;
 *   - `src` carries the authority, the canonical generation and the monotonic
 *     browser query revision.
 *
 * Cursors are **ephemeral**: there is no cursor data migration, a v1 token is
 * refused rather than upgraded, and every rejection happens before any row is
 * read.
 *
 * **What the integrity tag is and is not.** It is a keyed digest over the
 * canonical encoding, computed with a key minted once per module instance and
 * never persisted or transmitted. It detects truncation, corruption and a token
 * forged by other code in the page; it is not a defence against an attacker who
 * already executes in this origin, and it is not a confidentiality boundary —
 * a cursor carries only values that are already plaintext in the store and in
 * the index key, and it stays memory-only.
 */

import {
  P7_AUTHORITIES,
  P7_UNAVAILABLE_CODES,
  P7QueryContractError,
} from '@/lib/queryContracts/envelope';
import { P7_CURSOR_VERSION } from '@/lib/queryContracts/cursor';

const C = P7_UNAVAILABLE_CODES;
const encoder = new TextEncoder();

const refuse = (code, message, detail = {}) => {
  throw new P7QueryContractError(code, message, detail);
};

/** Deterministic key-ordered JSON, so two equivalent objects hash identically. */
export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Non-cryptographic fallback for environments without `crypto.subtle`. */
const fnv1a64 = (text) => {
  let high = 0xcbf2;
  let low = 0x9ce4;
  for (let index = 0; index < text.length; index += 1) {
    low ^= text.charCodeAt(index) & 0xffff;
    const nextLow = (low * 0x0193) & 0xffff;
    high = ((high * 0x0193) + ((low * 0x0193) >>> 16)) & 0xffff;
    low = nextLow;
  }
  return `${high.toString(16).padStart(4, '0')}${low.toString(16).padStart(4, '0')}`;
};

export async function digestHex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fnv1a64(text).padEnd(64, '0');
  const digest = await subtle.digest('SHA-256', encoder.encode(text));
  return hex(new Uint8Array(digest));
}

/** Module-lifetime tag key. Never persisted, never transmitted, never logged. */
const tagKey = (() => {
  const api = globalThis.crypto;
  if (api?.getRandomValues) {
    const bytes = new Uint8Array(32);
    api.getRandomValues(bytes);
    return hex(bytes);
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(64, '0');
})();

const base64urlEncode = (text) => {
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(text)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(text, 'utf8').toString('base64url');
};

const base64urlDecode = (token) => {
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(normalized)));
  return Buffer.from(normalized, 'base64').toString('utf8');
};

/**
 * The exact IndexedDB key type of a keyset component. Only these two types
 * appear in `(start_time, id)` keys; anything else is a malformed position.
 */
export const cursorKeyType = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string') return 'string';
  return null;
};

/**
 * Normalize the query identity a cursor binds to (§A2.3). Key order, defaults
 * and empty values are normalized away so two equivalent filters produce one
 * identity.
 *
 * @param {{sort?: string, status?: string|null, range?: {fromMs?: number|null, toMs?: number|null}, filter?: object}} query
 */
export async function normalizeCursorBind(query = {}) {
  const sort = query.sort === 'start_time' ? 'start_time' : '-start_time';
  const status = query.status == null || query.status === '' ? 'any' : String(query.status);
  const fromMs = Number.isFinite(query.range?.fromMs) ? Number(query.range.fromMs) : null;
  const toMs = Number.isFinite(query.range?.toMs) ? Number(query.range.toMs) : null;

  const filter = query.filter && typeof query.filter === 'object' ? query.filter : {};
  const normalizedFilter = {};
  for (const key of Object.keys(filter).sort()) {
    const value = filter[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    normalizedFilter[key] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  const filterId = await digestHex(canonicalJson(normalizedFilter));
  return { sort, status, range: { fromMs, toMs }, filterId };
}

const tagFor = (body) => digestHex(`${tagKey}|${canonicalJson(body)}`);

/**
 * Encode a cursor v2 token.
 *
 * `opaque` carries an authority-private position the caller cannot interpret —
 * the native archive's own cursor token, which SQLite mints and validates. It
 * rides inside the bound, integrity-tagged envelope so the *binding* rules
 * (query identity, generation, revision) apply to it identically, rather than
 * the native token travelling unbound beside them.
 *
 * @param {{key: {sort: any, id: any}, bind: object, src: {generation: any, rev: number},
 *          scan?: {budgetSpent?: number, matched?: number}, opaque?: string|null}} position
 * @param {string} [authority] the minting authority, defaulting to the browser
 */
export async function encodeTripCursorV2(position, authority = P7_AUTHORITIES.BROWSER) {
  const sortType = cursorKeyType(position?.key?.sort);
  const idType = cursorKeyType(position?.key?.id);
  if (!sortType || !idType) {
    refuse(C.CURSOR_MALFORMED, 'Cursor position carries a non-key value.', {
      sort: sortType, id: idType,
    });
  }
  const body = {
    v: P7_CURSOR_VERSION,
    auth: authority,
    ...(position?.opaque == null ? {} : { opaque: String(position.opaque) }),
    // One `t` for the pair: both components come from the same compound index
    // key, and a mixed pair is not a position this store can produce.
    key: { t: idType, sort: position.key.sort, id: position.key.id, st: sortType },
    bind: position.bind,
    src: { generation: String(position.src?.generation ?? ''), rev: Number(position.src?.rev ?? 0) },
    scan: {
      budgetSpent: Number(position.scan?.budgetSpent ?? 0),
      matched: Number(position.scan?.matched ?? 0),
    },
  };
  return base64urlEncode(canonicalJson({ ...body, mac: await tagFor(body) }));
}

/**
 * Decode and validate a cursor v2 token **before any row is read** (§A2.5).
 *
 * Rejections are returned as typed throws in the frozen matrix order, so a
 * caller can map each one straight onto an `unavailable` envelope with zero
 * rows.
 *
 * @param {string|null|undefined} token
 * @param {{authority?: string, bind: object, src: {generation: any, rev: number}}} expected
 * @returns {Promise<{key: {sort: any, id: any}, scan: {budgetSpent: number, matched: number}} | null>}
 */
export async function decodeTripCursorV2(token, expected) {
  if (token == null || token === '') return null;
  if (typeof token !== 'string') refuse(C.CURSOR_MALFORMED, 'Cursor is not a token.');

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(token));
  } catch {
    refuse(C.CURSOR_MALFORMED, 'Cursor is undecodable.');
  }
  if (!payload || typeof payload !== 'object') refuse(C.CURSOR_MALFORMED, 'Cursor is not an object.');

  // 1. Legacy version, refused rather than upgraded.
  if (payload.v !== P7_CURSOR_VERSION) {
    refuse(C.CURSOR_VERSION_UNSUPPORTED, 'Cursor version is unsupported.', { v: payload.v });
  }

  // 2. Integrity and key type.
  const { mac, ...body } = payload;
  if (typeof mac !== 'string' || mac !== await tagFor(body)) {
    refuse(C.CURSOR_MALFORMED, 'Cursor integrity tag does not match.');
  }
  if (cursorKeyType(body.key?.id) !== body.key?.t || cursorKeyType(body.key?.sort) !== body.key?.st) {
    refuse(C.CURSOR_MALFORMED, 'Cursor key type does not match its declared type.');
  }

  // 3. Authority.
  const authority = expected?.authority ?? P7_AUTHORITIES.BROWSER;
  if (body.auth !== authority) {
    refuse(C.CURSOR_AUTHORITY_MISMATCH, 'Cursor was minted by the other authority.', { auth: body.auth });
  }

  // 4. Query binding.
  if (canonicalJson(body.bind) !== canonicalJson(expected?.bind ?? {})) {
    refuse(C.CURSOR_QUERY_MISMATCH, 'Cursor does not match this query.');
  }

  // 5-6. Source identity, then the monotonic browser query revision.
  if (String(body.src?.generation ?? '') !== String(expected?.src?.generation ?? '')) {
    refuse(C.CURSOR_RESTART_REQUIRED, 'Cursor belongs to a superseded generation.');
  }
  if (Number(body.src?.rev ?? -1) !== Number(expected?.src?.rev ?? -2)) {
    refuse(C.CURSOR_RESTART_REQUIRED, 'Cursor is stale: the row set changed.');
  }

  return {
    key: { sort: body.key.sort, id: body.key.id },
    opaque: body.opaque == null ? null : String(body.opaque),
    scan: {
      budgetSpent: Number(body.scan?.budgetSpent ?? 0),
      matched: Number(body.scan?.matched ?? 0),
    },
  };
}

/** True when `token` is a v1 projection cursor rather than a v2 token. */
export async function isLegacyCursor(token) {
  if (typeof token !== 'string' || token === '') return false;
  try {
    const payload = JSON.parse(base64urlDecode(token));
    return payload?.v !== P7_CURSOR_VERSION;
  } catch {
    return false;
  }
}
