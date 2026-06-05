const finiteCoordinate = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function isValidLatLng(lat, lng) {
  const parsedLat = finiteCoordinate(lat);
  const parsedLng = finiteCoordinate(lng);
  return (
    parsedLat != null &&
    parsedLng != null &&
    parsedLat >= -90 &&
    parsedLat <= 90 &&
    parsedLng >= -180 &&
    parsedLng <= 180 &&
    !(parsedLat === 0 && parsedLng === 0)
  );
}

const asCenter = (lat, lng) => {
  if (!isValidLatLng(lat, lng)) return null;
  return [Number(lat), Number(lng)];
};

function routeMidpoint(routePoints = []) {
  const points = (Array.isArray(routePoints) ? routePoints : [])
    .map((point) => ({
      lat: Number(point?.lat),
      lng: Number(point?.lng),
    }))
    .filter((point) => isValidLatLng(point.lat, point.lng));

  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  return asCenter((first.lat + last.lat) / 2, (first.lng + last.lng) / 2);
}

export function getBestMapCenter({ trip, lastParked, lastKnownLocation } = {}) {
  const tripCenter = routeMidpoint(trip?.route_points);
  if (tripCenter) return tripCenter;

  const parkedCenter = asCenter(lastParked?.lat, lastParked?.lng);
  if (parkedCenter) return parkedCenter;

  const knownCenter = asCenter(lastKnownLocation?.lat, lastKnownLocation?.lng);
  if (knownCenter) return knownCenter;

  return null;
}
