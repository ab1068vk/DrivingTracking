/**
 * P6 public-point block codec.
 *
 * The frozen §12.4 envelope `E(N,P,S) = 32 MiB + 24 KiB*N + 224 B*P + 512 B*S`
 * budgets 224 bytes per permitted public point for the point block, its spatial
 * posting, index overhead and encrypted framing together. A per-point object of
 * ten named fields spends more than that on property names alone before AES-GCM
 * and base64 expand it by a further third, so derived state is stored columnar:
 * one array per field, integer coordinates in 1e-7 degrees (about 1.1 cm, finer
 * than any GPS fix this app records), deltas for the monotonic columns, string
 * dictionaries, and all-null columns omitted entirely.
 *
 * The decoder restores the exact `compactPoint` object shape, so no reader,
 * adapter or native-parity surface observes the encoding. A legacy array of
 * point objects decodes unchanged, which keeps blocks published before this
 * codec readable without a content-version rebuild.
 */

const COORDINATE_SCALE = 1e7;
const NUMBER_COLUMNS = Object.freeze(['speedKmh', 'heading', 'accuracy', 'speedLimitKmh', 'utcOffsetMinutes']);
const STRING_COLUMNS = Object.freeze(['limitSource', 'timezoneId']);

export const P6_POINT_BLOCK_VERSION = 2;

const scaled = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * COORDINATE_SCALE) : null;
};

const deltaEncode = (values) => {
  const out = [];
  let previous = 0;
  for (const value of values) {
    if (value === null) { out.push(null); continue; }
    out.push(value - previous);
    previous = value;
  }
  return out;
};

const deltaDecode = (values) => {
  const out = [];
  let previous = 0;
  for (const value of values || []) {
    if (value === null || !Number.isFinite(Number(value))) { out.push(null); continue; }
    previous += Number(value);
    out.push(previous);
  }
  return out;
};

// `Number(null)` is 0, and P6 analytics, road learning and scoring all treat a
// missing value differently from a zero one, so absence is checked before any
// numeric coercion.
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const encodeP6PointBlock = (points = []) => {
  const rows = Array.isArray(points) ? points : [];
  const block = { v: P6_POINT_BLOCK_VERSION, n: rows.length };
  if (!rows.length) return block;
  block.lat = deltaEncode(rows.map((point) => scaled(point?.lat)));
  block.lng = deltaEncode(rows.map((point) => scaled(point?.lng)));
  const timestamps = rows.map((point) => point?.timestamp ?? null);
  if (timestamps.some((value) => value !== null)) {
    // A source point may carry a non-numeric recorded-at value. Delta coding is
    // only for the numeric case; anything else is carried through verbatim so
    // no reader loses a timestamp it would otherwise have seen.
    if (timestamps.every((value) => value === null || Number.isFinite(Number(value)))) {
      block.t = deltaEncode(timestamps.map((value) => numberOrNull(value)));
    } else {
      block.tRaw = timestamps;
    }
  }
  for (const column of NUMBER_COLUMNS) {
    const values = rows.map((point) => numberOrNull(point?.[column]));
    if (values.some((value) => value !== null)) block[column] = values;
  }
  for (const column of STRING_COLUMNS) {
    const values = rows.map((point) => String(point?.[column] ?? ''));
    if (!values.some((value) => value !== '')) continue;
    const dictionary = [...new Set(values)];
    block[column] = { d: dictionary, i: values.map((value) => dictionary.indexOf(value)) };
  }
  return block;
};

export const decodeP6PointBlock = (value) => {
  // Blocks published before this codec are a plain array of point objects.
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const count = Math.max(0, Number(value.n) || 0);
  if (!count) return [];
  const lat = deltaDecode(value.lat);
  const lng = deltaDecode(value.lng);
  const timestamps = value.tRaw ? value.tRaw : (value.t ? deltaDecode(value.t) : []);
  const strings = {};
  for (const column of STRING_COLUMNS) {
    const encoded = value[column];
    strings[column] = encoded
      ? (encoded.i || []).map((index) => String(encoded.d?.[index] ?? ''))
      : [];
  }
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const point = {
      lat: lat[index] === null || lat[index] === undefined ? null : lat[index] / COORDINATE_SCALE,
      lng: lng[index] === null || lng[index] === undefined ? null : lng[index] / COORDINATE_SCALE,
      timestamp: timestamps[index] ?? null,
    };
    for (const column of NUMBER_COLUMNS) {
      point[column] = value[column] ? numberOrNull(value[column][index]) : null;
    }
    for (const column of STRING_COLUMNS) point[column] = strings[column][index] ?? '';
    points.push(point);
  }
  return points;
};
