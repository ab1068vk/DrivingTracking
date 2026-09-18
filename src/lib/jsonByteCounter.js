/**
 * JSON-equivalent serialized byte counting with early abort.
 *
 * `TextEncoder(JSON.stringify(value)).byteLength` cannot be used to *discover*
 * that a value is oversized: it allocates the complete string and then the
 * encoded buffer before the size is known. For open-shaped or imported trip
 * objects that defeats the whole point of an admission bound.
 *
 * This walks the value and accumulates the byte count `JSON.stringify` would
 * produce, stopping the instant a caller-supplied limit is exceeded. Work is
 * O(source bytes visited until completion or early abort) — not O(1), and the
 * plan says so.
 *
 * Semantics are matched to `JSON.stringify` and pinned by parity tests:
 * string escaping, number formatting, `true`/`false`/`null`, object keys with
 * `undefined`/function/symbol values omitted, the same values rendered as
 * `null` inside arrays, and a `TypeError` for cyclic structures.
 */

/**
 * Serialized cost of one code point inside a JSON string, excluding quotes.
 * Uses charCode ranges rather than a per-code-point `JSON.stringify` call: the
 * reference implementation used while planning was ~400x slower and would have
 * made admission itself the bottleneck.
 * @param {number} code
 * @returns {number}
 */
const stringCharCost = (code) => {
  // `"` and `\` escape to two characters.
  if (code === 0x22 || code === 0x5c) return 2;
  // \b \t \n \f \r have two-character escapes; every other C0 control is \uXXXX.
  if (code < 0x20) {
    return (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) ? 2 : 6;
  }
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  // Lone surrogates are escaped as \uXXXX by JSON.stringify (well-formed
  // stringify, ES2019+). Paired surrogates are emitted as 4-byte UTF-8.
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return 3;
};

/**
 * Byte cost of a JS string as a JSON string literal, including both quotes.
 * @param {string} value
 * @returns {number}
 */
export function jsonStringBytes(value) {
  let total = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Valid surrogate pair -> one astral code point -> 4 UTF-8 bytes.
        total += 4;
        index += 1;
        continue;
      }
    }
    total += stringCharCost(code);
  }
  return total;
}

class CountAborted extends Error {}

/**
 * Count the bytes `JSON.stringify(value)` would produce, aborting early once
 * `limit` is exceeded.
 *
 * @param {any} value
 * @param {number} [limit] byte ceiling; the walk stops once it is passed.
 * @returns {{ bytes: number, aborted: boolean }} `bytes` is the count reached;
 *   when `aborted` is true it is a lower bound, not the true size.
 */
export function countJsonBytes(value, limit = Number.POSITIVE_INFINITY) {
  let total = 0;
  let aborted = false;
  const stack = new Set();

  const add = (amount) => {
    total += amount;
    if (total > limit) {
      aborted = true;
      throw new CountAborted();
    }
  };

  /**
   * Count a JSON string literal **incrementally**, so a single multi-megabyte
   * value aborts after visiting the budget rather than after scanning the whole
   * string. Charging `jsonStringBytes(value)` in one go would defeat the bound.
   */
  const addString = (value) => {
    add(2);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index += 1;
          continue;
        }
      }
      add(stringCharCost(code));
    }
  };

  /**
   * Resolve one value the way `SerializeJSONProperty` step 2 does: consult a
   * callable `toJSON` **before** anything decides the value is unserializable.
   *
   * Ordering is the whole point. `JSON.stringify` omits `{ a: { toJSON: () => undefined } }`
   * down to `{}` and renders the array form as `[null]`, and it *does* call
   * `toJSON` on a callable object — a function is an Object to the spec. Judging
   * the raw value first gets all three of those backwards, which is exactly the
   * open-shaped imported data this counter exists to measure.
   *
   * `key` mirrors what the serializer passes: `""` at the root, the property
   * name inside an object, the stringified index inside an array. Omitting it
   * changes the result for any `toJSON` that branches on the key.
   */
  const resolve = (node, key) => {
    const type = typeof node;
    if (node !== null && (type === 'object' || type === 'function' || type === 'bigint')) {
      const toJSON = node.toJSON;
      // Applied once, not repeatedly: the serializer does not re-consult
      // `toJSON` on the value a `toJSON` returned.
      if (typeof toJSON === 'function') return toJSON.call(node, key);
    }
    return node;
  };

  /** After resolution: the object omits this key, the array substitutes `null`. */
  const isUnserializable = (node) => {
    const type = typeof node;
    return node === undefined || type === 'function' || type === 'symbol';
  };

  /** Counts an **already resolved** value. Callers resolve before descending. */
  const walk = (node) => {
    if (node === null) return add(4);
    const type = typeof node;
    if (type === 'number') return add(Number.isFinite(node) ? String(node).length : 4);
    if (type === 'boolean') return add(node ? 4 : 5);
    if (type === 'string') return addString(node);
    if (type === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
    if (type === 'undefined' || type === 'function' || type === 'symbol') return add(0);

    if (stack.has(node)) throw new TypeError('Converting circular structure to JSON');
    stack.add(node);
    try {
      if (Array.isArray(node)) {
        add(2);
        for (let index = 0; index < node.length; index += 1) {
          if (index) add(1);
          // Holes resolve to `undefined` and render as `null`, same as a
          // `toJSON` that returns `undefined`.
          const item = resolve(node[index], String(index));
          if (isUnserializable(item)) add(4);
          else walk(item);
        }
        return undefined;
      }

      add(2);
      let first = true;
      const keys = Object.keys(node);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const child = resolve(node[key], key);
        if (isUnserializable(child)) continue;
        if (!first) add(1);
        first = false;
        addString(key);
        add(1);
        walk(child);
      }
      return undefined;
    } finally {
      stack.delete(node);
    }
  };

  try {
    walk(resolve(value, ''));
  } catch (error) {
    if (!(error instanceof CountAborted)) throw error;
  }
  return { bytes: total, aborted };
}
