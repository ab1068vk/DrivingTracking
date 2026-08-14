/**
 * Stable identity for a derived hazard record.
 *
 * Zones are rebuilt from trips, so nothing persists an id — but the alert gate
 * keys its one-shot on `zone:${id}`, and the map keeps selection by id. If the
 * id moved every rebuild the driver would be re-warned about the same corner on
 * every drive.
 *
 * Rounding the centre to four decimals (~11 m) absorbs the small drift in a
 * cluster mean as new events join, which is smaller than the cluster radius, so
 * the same physical place keeps the same id.
 */

const hash = (key) => {
  let value = 0;
  for (let i = 0; i < key.length; i++) {
    value = ((value << 5) - value + key.charCodeAt(i)) | 0;
  }
  return Math.abs(value).toString(36);
};

/**
 * @param {{lat: number, lng: number}} center
 * @param {string} prefix `dz` for point areas, `sz` for speeding stretches.
 */
export function zoneId(center, prefix = 'dz') {
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${prefix}_${hash(`${lat.toFixed(4)},${lng.toFixed(4)}`)}`;
}
