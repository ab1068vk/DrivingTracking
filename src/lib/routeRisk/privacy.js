import { haversineDistance } from '@/lib/gps/math';
import { ROUTE_RISK_PRIVACY_ZONE_GUARD_M } from '@/lib/routeRisk/constants';

export const finiteCoord = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const isPrivacyMaskedPoint = (point) => (
  point?.masked_for_privacy === true ||
  point?.privacy_masked === true ||
  point?.privacy_boundary === true ||
  point?.is_privacy_boundary === true ||
  point?.privacy_zone_id != null
);

export const isNearPrivacyZone = (
  lat,
  lng,
  privacyZones = [],
  guardM = ROUTE_RISK_PRIVACY_ZONE_GUARD_M
) => {
  const pointLat = finiteCoord(lat);
  const pointLng = finiteCoord(lng);
  if (pointLat == null || pointLng == null) return true;

  return (privacyZones || []).some((zone) => {
    const zoneLat = finiteCoord(zone?.lat);
    const zoneLng = finiteCoord(zone?.lng);
    const radiusM = Number(zone?.radius_m);
    if (zoneLat == null || zoneLng == null || !Number.isFinite(radiusM) || radiusM <= 0) return false;
    return haversineDistance(pointLat, pointLng, zoneLat, zoneLng) * 1000 <= radiusM + guardM;
  });
};
