/**
 * Explicit source for a completed route received from the native journal.
 * The points remain in the canonical encrypted trip document; this descriptor
 * is minted only at the journal import boundary after privacy masking.
 */
export const NATIVE_JOURNAL_INLINE_ROUTE_STORAGE = 'native_journal_inline_v1';
const NATIVE_ROUTE_SOURCE_OWNER = 'native_completed_journal';
const encoder = new TextEncoder();

const digestRoute = async (points) => {
  const bytes = encoder.encode(JSON.stringify(points));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return {
    jsonBytes: bytes.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
};

const eligibleShape = (trip) => (
  trip?.status === 'completed' &&
  typeof trip.id === 'string' && trip.id.startsWith('native_trip_') &&
  ['native_auto', 'native_manual'].includes(trip.start_source) &&
  trip.privacy_mode !== 'summary_only' && !trip.route_data_expired_at &&
  Array.isArray(trip.route_points) && trip.route_points.length > 0
);

/** Called only with a trip admitted from getNativeCompletedTripPage. */
export async function stampNativeJournalRouteSource(trip) {
  if (!eligibleShape(trip)) return {};
  const { jsonBytes, sha256 } = await digestRoute(trip.route_points);
  return {
    route_payload_storage: NATIVE_JOURNAL_INLINE_ROUTE_STORAGE,
    native_route_source: {
      version: 1,
      owner: NATIVE_ROUTE_SOURCE_OWNER,
      trip_id: trip.id,
      point_count: trip.route_points.length,
      json_bytes: jsonBytes,
      sha256,
    },
  };
}

/** A copied flag or a nonempty inline array alone never grants P6 admission. */
export async function verifiedNativeJournalRouteSource(trip, cursor = null) {
  const source = trip?.native_route_source;
  if (!eligibleShape(trip) ||
      trip.imported_from_native !== true ||
      trip.route_payload_storage !== NATIVE_JOURNAL_INLINE_ROUTE_STORAGE ||
      trip.rsas_session_id ||
      source?.version !== 1 || source.owner !== NATIVE_ROUTE_SOURCE_OWNER ||
      source.trip_id !== trip.id ||
      source.point_count !== trip.route_points.length ||
      !Number.isSafeInteger(source.json_bytes) || source.json_bytes <= 0 ||
      typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return false;
  if (cursor?.nativeSourceVerifiedDigest === source.sha256) return true;
  const digest = await digestRoute(trip.route_points);
  return digest.jsonBytes === source.json_bytes && digest.sha256 === source.sha256;
}

export function withoutClaimedRouteSource(trip) {
  const { route_payload_storage: _storage, rsas_session_id: _session,
    native_route_source: _source, ...rest } = trip || {};
  return rest;
}
