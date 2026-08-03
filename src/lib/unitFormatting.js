export const KM_TO_MILES = 0.621371;
export const KM_PER_MILE = 1 / KM_TO_MILES;

export function normalizeUnits(units) {
  return units === 'imperial' ? 'imperial' : 'metric';
}

export function distanceUnitLabel(units) {
  return normalizeUnits(units) === 'imperial' ? 'mi' : 'km';
}

export function speedUnitLabel(units) {
  return normalizeUnits(units) === 'imperial' ? 'mph' : 'km/h';
}

export function convertDistanceKm(value, units = 'metric') {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return normalizeUnits(units) === 'imperial' ? number * KM_TO_MILES : number;
}

export function convertSpeedKmh(value, units = 'metric') {
  return convertDistanceKm(value, units);
}

export function convertDisplaySpeedToKmh(value, units = 'metric') {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return normalizeUnits(units) === 'imperial' ? number * KM_PER_MILE : number;
}

export function speedInputValueFromKmh(value, units = 'metric') {
  const converted = convertSpeedKmh(value, units);
  return converted == null ? '' : String(Math.round(converted));
}

export function formatSpeedKmh(value, units = 'metric', empty = 'Unknown') {
  const converted = convertSpeedKmh(value, units);
  return converted != null && converted > 0
    ? `${Math.round(converted)} ${speedUnitLabel(units)}`
    : empty;
}

export function convertPerDistanceRate(value, units = 'metric') {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return normalizeUnits(units) === 'imperial' ? number * KM_PER_MILE : number;
}

export function formatPerDistanceRate(
  value,
  units = 'metric',
  {
    baseDistance = 100,
    digits = 1,
    empty = 'Unavailable',
    suffix = '',
  } = {}
) {
  const converted = convertPerDistanceRate(value, units);
  if (converted == null) return empty;
  const suffixText = suffix ? ` ${suffix}` : '';
  return `${converted.toFixed(digits)}${suffixText} / ${baseDistance} ${distanceUnitLabel(units)}`;
}

export function formatDistanceScope(distanceKm, units = 'metric', digits = 1) {
  const converted = convertDistanceKm(distanceKm, units);
  if (converted == null) return 'Unavailable';
  return `${converted.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${distanceUnitLabel(units)}`;
}

export function formatDistanceMeters(value, units = 'metric', { empty = '0 m' } = {}) {
  if (value == null || value === '') return empty;
  const meters = Number(value);
  if (!Number.isFinite(meters)) return empty;
  if (normalizeUnits(units) === 'imperial') {
    const feet = meters * 3.28084;
    if (Math.abs(feet) < 1000) return `${Math.round(feet)} ft`;
    return `${(feet / 5280).toFixed(1)} mi`;
  }
  if (Math.abs(meters) < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(Math.abs(meters) >= 10000 ? 0 : 1)} km`;
}
