import { jsonStringBytes, countJsonBytes } from '@/lib/jsonByteCounter';
import { isDriverMetricEligible } from '@/lib/phoneUseSummary';
import {
  ENVELOPE_MAX_BYTES,
  EVENT_TAXONOMY_VERSION,
  PROJECTION_FAILURE_CLASSES,
  PROJECTION_OVERFLOW_BITS,
  TRIP_PROJECTION_SCHEMA,
  TRIP_PROJECTION_VERSION,
} from '@/lib/tripProjectionSchema';

/**
 * Compact trip projection builder (P3).
 *
 * Copies **only** what `TRIP_PROJECTION_SCHEMA` lists, so a field cannot enter
 * by being added to a trip. Nested blocks are rebuilt member by member — never
 * spread — so a future nested property cannot ride along either.
 */

/** Deterministic, non-transient projection construction failure. */
export class ProjectionBuildError extends Error {
  /** @param {string} failureClass @param {Record<string, any>} [detail] */
  constructor(failureClass, detail = {}) {
    super('Trip projection could not be built within its contract.');
    this.name = 'ProjectionBuildError';
    this.failureClass = failureClass;
    this.detail = detail;
  }
}

/**
 * Cap a string by the bytes it will occupy **as serialized JSON**.
 *
 * The serialized length is the only measure that binds: a code-point cap leaves
 * a 2.3x spread across fills, and a raw UTF-8 cap is worse still because JSON
 * escapes one control character to six bytes. Iteration is by code point so a
 * surrogate pair is never split.
 *
 * @param {string} value
 * @param {number} budget serialized bytes including both quotes
 * @returns {{ value: string, truncated: boolean }}
 */
export const capSerialized = (value, budget) => {
  if (typeof value !== 'string' || !value) return { value: value === '' ? '' : '', truncated: false };
  if (jsonStringBytes(value) <= budget) return { value, truncated: false };
  let used = 2;
  let out = '';
  for (const codePoint of value) {
    const cost = jsonStringBytes(codePoint) - 2;
    if (used + cost > budget) return { value: out, truncated: true };
    out += codePoint;
    used += cost;
  }
  return { value: out, truncated: false };
};

const numValue = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const boolValue = (value) => value === true;

const nullableBoolValue = (value) => (value === undefined || value === null ? null : value === true);

const enumValue = (value, domain) => {
  const text = typeof value === 'string' ? value : '';
  return domain.includes(text) ? text : 'other';
};

/**
 * Text normalization. `String(value)` is used only where the consumer already
 * coerces — `getTripDisplayName` renders an imported numeric nickname as "123",
 * and identity fields are compared as `String(a) === String(b)`. Everywhere else
 * a non-string is `null` so a malformed import cannot become a legitimate value.
 */
const textValue = (value, cap, coerce) => {
  if (typeof value !== 'string') {
    if (!coerce || value == null || typeof value === 'object') return { value: null, truncated: false };
    return capSerialized(String(value), cap);
  }
  return capSerialized(value, cap);
};

const memberValue = (spec, value) => {
  if (spec === 'num') return numValue(value);
  if (spec === 'bool') return boolValue(value);
  if (typeof spec === 'number') return textValue(value, spec, false).value;
  return buildContainer(spec, value);
};

/**
 * @param {any} spec
 * @param {any} source
 * @returns {any}
 */
function buildContainer(spec, source) {
  if (!spec || typeof spec !== 'object') return null;

  if (spec.kind === 'list') {
    const list = Array.isArray(source) ? source : [];
    const out = [];
    let memberTruncated = false;
    for (let index = 0; index < list.length && out.length < spec.max; index += 1) {
      const member = spec.member;
      if (member.type === 'num') out.push(numValue(list[index]));
      else if (member.type === 'text') {
        // A member capped below its stored value is exactly as much of a parity
        // break as an overflowing count: exact search, filter and grouping would
        // observe a prefix. Report it so the caller can set the hydration bit.
        const capped = textValue(list[index], member.cap, false);
        if (capped.truncated) memberTruncated = true;
        out.push(capped.value);
      } else out.push(buildMembers(member.members, list[index]));
    }
    if (memberTruncated) Object.defineProperty(out, '__memberTruncated', { value: true });
    return out;
  }

  if (spec.kind === 'map') {
    const map = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const out = {};
    let count = 0;
    let overflowTotal = 0;
    let overflowed = false;
    for (const key of Object.keys(map)) {
      const safeKey = capSerialized(String(key), spec.keyCap).value;
      if (!safeKey) continue;
      const member = spec.member;
      const atCapacity = count >= spec.max - (spec.aggregateOverflow ? 1 : 0);
      // A future taxonomy entry beyond the bound must not silently vanish. For
      // count maps it is folded into an explicit `other` bucket so totals stay
      // semantically correct while the envelope stays bounded; a key collision
      // after capping is folded the same way rather than overwriting.
      if (spec.aggregateOverflow
        && (atCapacity || (Object.prototype.hasOwnProperty.call(out, safeKey) && safeKey !== 'other'))) {
        overflowTotal += Math.max(0, numValue(map[key]) ?? 0);
        overflowed = true;
        continue;
      }
      if (count >= spec.max) break;
      if (member.type === 'num') {
        out[safeKey] = (out[safeKey] ?? 0) + (numValue(map[key]) ?? 0);
      } else if (member.type === 'text') out[safeKey] = textValue(map[key], member.cap, false).value;
      else out[safeKey] = buildMembers(member.members, map[key]);
      count += 1;
    }
    if (spec.aggregateOverflow && overflowed) {
      out.other = (out.other ?? 0) + overflowTotal;
    }
    return out;
  }

  if (spec.kind === 'object') return buildMembers(spec.members, source);
  return null;
}

/**
 * @param {Record<string, any>} members
 * @param {any} source
 * @returns {Record<string, any> | null}
 */
function buildMembers(members, source) {
  if (source == null || typeof source !== 'object') return null;
  const out = {};
  for (const [name, spec] of Object.entries(members)) {
    out[name] = memberValue(spec, source[name]);
  }
  return out;
}

/**
 * Build the compact projection envelope for a trip.
 *
 * The caller supplies the privacy-sanitized storage trip, so the projection can
 * never contain data the sanitizer removed.
 *
 * @param {Record<string, any>} trip sanitized storage trip
 * @param {{ sourceRevision: string }} context
 * @returns {Record<string, any>} authenticated envelope, ready for encryption
 * @throws {ProjectionBuildError} deterministic, non-transient contract failure
 */
export function buildTripProjection(trip = {}, context = { sourceRevision: '' }) {
  const schema = TRIP_PROJECTION_SCHEMA;
  const fields = /** @type {Record<string, any>} */ ({});
  const overflow = PROJECTION_OVERFLOW_BITS.reduce((acc, bit) => { acc[bit] = false; return acc; }, {});

  for (const name of schema.num) fields[name] = numValue(trip[name]);
  for (const name of schema.bool) fields[name] = boolValue(trip[name]);
  // Derived, not copied: `driver_metric_eligible` has no canonical field of its
  // own. It is exactly `isDriverMetricEligible(trip)` evaluated against the
  // canonical record at build time (P7 Annex C C1a.1), which is why it is
  // written after the copy loop rather than inside it.
  fields.driver_metric_eligible = isDriverMetricEligible(trip);
  for (const name of schema.nullableBool) fields[name] = nullableBoolValue(trip[name]);
  for (const [name, domain] of Object.entries(schema.enum)) fields[name] = enumValue(trip[name], domain);

  for (const [name, cap] of Object.entries(schema.text)) {
    const coerce = schema.textCoerced.includes(name);
    const capped = textValue(trip[name], cap, coerce);
    fields[name] = capped.value;
    if (capped.truncated) {
      if (name === 'nickname') overflow.nickname_truncated = true;
      else if (name === 'start_address' || name === 'end_address') overflow.address_truncated = true;
      else if (name === 'notes') overflow.notes_truncated = true;
      else if (name === 'route_key') overflow.route_key_truncated = true;
      else if (name === 'vehicle_id') overflow.vehicle_id_truncated = true;
    }
  }

  // `has_notes` is exact presence and never degrades, even when the text does.
  fields.has_notes = typeof trip.notes === 'string' ? trip.notes.trim().length > 0 : Boolean(trip.notes);

  for (const [name, spec] of Object.entries(schema.collection)) {
    fields[name] = buildContainer(spec, trip[name]);
  }
  const rawTags = Array.isArray(trip.tags) ? trip.tags : [];
  // Either overflowing the count OR capping any individual tag changes the exact
  // value a consumer would compare against, so both set the hydration bit.
  if (rawTags.length > schema.collection.tags.max) overflow.tags_truncated = true;
  if (fields.tags?.__memberTruncated) overflow.tags_truncated = true;
  // Truncation can also collide two distinct tags into one prefix, which would
  // silently change set membership.
  if (Array.isArray(fields.tags) && new Set(fields.tags).size !== fields.tags.length) {
    overflow.tags_truncated = true;
    fields.tags = Array.from(new Set(fields.tags));
  }

  const envelope = {
    record_type: 'trip_projection',
    projection_version: TRIP_PROJECTION_VERSION,
    event_taxonomy_version: EVENT_TAXONOMY_VERSION,
    id: String(trip.id ?? ''),
    start_time: typeof trip.start_time === 'string' ? trip.start_time : '',
    status: fields.status,
    source_revision: String(context.sourceRevision ?? ''),
    projection_status: 'ok',
    ...overflow,
    fields,
  };

  // Terminal guard. Measured before any crypto call, so an oversized envelope
  // can never reach `encryptSensitiveValues`.
  const { bytes } = countJsonBytes(envelope);
  if (bytes > ENVELOPE_MAX_BYTES) {
    throw new ProjectionBuildError(PROJECTION_FAILURE_CLASSES.ENVELOPE_OVERSIZE, {
      bytes,
      limit: ENVELOPE_MAX_BYTES,
    });
  }
  return envelope;
}

/**
 * Validate a decrypted envelope against the authoritative plaintext columns.
 * Every check runs before any field is read by a caller.
 *
 * @param {any} envelope
 * @param {{ id: string, start_time: string, status: string, source_revision: string }} columns
 * @returns {boolean}
 */
export function isProjectionEnvelopeValid(envelope, columns) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.record_type !== 'trip_projection') return false;
  if (envelope.projection_version !== TRIP_PROJECTION_VERSION) return false;
  if (envelope.event_taxonomy_version !== EVENT_TAXONOMY_VERSION) return false;
  if (String(envelope.id) !== String(columns.id)) return false;
  if (String(envelope.start_time) !== String(columns.start_time ?? '')) return false;
  if (String(envelope.status) !== String(columns.status ?? '')) return false;
  if (String(envelope.source_revision) !== String(columns.source_revision ?? '')) return false;
  return envelope.fields != null && typeof envelope.fields === 'object';
}

/** True when any overflow bit is set and the row needs exact-ID hydration. */
export const projectionNeedsHydration = (envelope) => (
  PROJECTION_OVERFLOW_BITS.some((bit) => envelope?.[bit] === true)
);
