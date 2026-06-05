export function formatCoordinateLabel(lat, lng) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return '';

  const latHemisphere = parsedLat >= 0 ? 'N' : 'S';
  const lngHemisphere = parsedLng >= 0 ? 'E' : 'W';
  return `${Math.abs(parsedLat).toFixed(4)}\u00b0${latHemisphere} ${Math.abs(parsedLng).toFixed(4)}\u00b0${lngHemisphere}`;
}

export function zoneKey(zone, index) {
  return `${zone.name || 'zone'}-${zone.lat}-${zone.lng}-${index}`;
}
