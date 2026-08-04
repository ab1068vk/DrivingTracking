import { clamp } from '@/lib/mathUtils';
import {
  getEncryptedJson,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { withRetry } from '@/lib/retry';
import { weightedBlend } from '@/lib/tripEngine';
import { scoringValue } from '@/lib/scoringConstants';
import { getPrivacyZones, isPointInPrivacyZone } from '@/lib/privacyZones';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { privacyGatedFetch } from '@/lib/privacyGatedFetch';
import { enqueueLocationRequest } from '@/lib/requestObfuscator';
import { isHeightenedPrivacyMode } from '@/lib/privacyMode';

export const WEATHER_CACHE_KEY = 'drivesense_open_meteo_weather_cache_v1';
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ZONE_BUFFER_M = 100;
const WEATHER_NETWORK_TIMEOUT_MS = 10000;
export const WEATHER_SKIPPED_ALL_POINTS_PRIVATE = 'all_points_within_privacy_zones';
const FORECAST_HOURLY_FIELDS = [
  'temperature_2m',
  'precipitation',
  'precipitation_probability',
  'rain',
  'snowfall',
  'weather_code',
  'visibility',
  'wind_speed_10m',
  'wind_gusts_10m',
  'freezing_level_height',
];
const ARCHIVE_HOURLY_FIELDS = FORECAST_HOURLY_FIELDS.filter((field) => field !== 'precipitation_probability');
const USER_CONFIRMED_WEATHER = Object.freeze({
  clear: { riskScore: 0, riskMultiplier: 1 },
  rain: { riskScore: 35, riskMultiplier: 1.25 },
  snow: { riskScore: 55, riskMultiplier: 1.25 },
  fog: { riskScore: 45, riskMultiplier: 1.25 },
  freezing_precipitation: { riskScore: 80, riskMultiplier: 1.45 },
  storm: { riskScore: 75, riskMultiplier: 1.45 },
});
export const USER_CONFIRMED_WEATHER_OPTIONS = Object.freeze(Object.keys(USER_CONFIRMED_WEATHER));

const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round1 = (value) => Math.round(value * 10) / 10;
const throwIfWeatherRequestAborted = (signal) => {
  if (!signal?.aborted) return;
  const error = new Error('Weather lookup was cancelled.');
  error.name = 'AbortError';
  throw error;
};

export async function clearWeatherContextCache() {
  await removeEncryptedJson(WEATHER_CACHE_KEY);
}

function midpoint(points = []) {
  const valid = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!valid.length) return null;
  return {
    lat: avg(valid.map((point) => point.lat)),
    lng: avg(valid.map((point) => point.lng)),
  };
}

function dayKey(dateValue) {
  const date = new Date(dateValue || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function weatherCodeLabel(code) {
  if ([45, 48].includes(code)) return 'fog';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([1, 2, 3].includes(code)) return 'cloudy';
  return 'clear';
}

function isRainCode(code) {
  return [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code);
}

function weatherCodeRisk(code) {
  if ([96, 99].includes(code)) return 90;
  if (code === 95) return 70;
  if ([66, 67].includes(code)) return 78;
  if ([75, 77, 85, 86].includes(code)) return 62;
  if ([71, 73].includes(code)) return 48;
  if ([45, 48].includes(code)) return 38;
  if ([65, 82].includes(code)) return 42;
  if ([61, 63, 80, 81].includes(code)) return 28;
  if ([51, 53, 55, 56, 57].includes(code)) return 18;
  return 0;
}

function sampleWeatherRisk(sample = {}) {
  const temperature = Number(sample.temperature_2m);
  const precipitation = Number(sample.precipitation);
  const rain = Number(sample.rain);
  const snowfall = Number(sample.snowfall);
  const visibility = Number(sample.visibility);
  const gust = Number(sample.wind_gusts_10m);
  const wind = Number(sample.wind_speed_10m);
  const code = Number(sample.weather_code);
  const wetAmount = Math.max(
    Number.isFinite(precipitation) ? precipitation : 0,
    Number.isFinite(rain) ? rain : 0
  );
  const reasons = [];
  let risk = weatherCodeRisk(code);
  if (risk > 0) reasons.push(weatherCodeLabel(code));

  const freezingPrecipitation = Number.isFinite(temperature) && temperature <= 1.5 && wetAmount > 0.1;
  if (freezingPrecipitation) {
    risk = Math.max(risk, 78);
    reasons.push('freezing precipitation');
  }
  if (Number.isFinite(snowfall) && snowfall > 0.1) {
    risk = Math.max(risk, snowfall >= 1 ? 62 : 45);
    reasons.push('snowfall');
  }
  if (Number.isFinite(visibility)) {
    if (visibility < 200) risk = Math.max(risk, 75);
    else if (visibility < 500) risk = Math.max(risk, 58);
    else if (visibility < 1000) risk = Math.max(risk, 42);
    else if (visibility < 3000) risk = Math.max(risk, 22);
    if (visibility < 3000) reasons.push('reduced visibility');
  }
  if (wetAmount >= 7.5) risk = Math.max(risk, 58);
  else if (wetAmount >= 2.5) risk = Math.max(risk, 42);
  else if (wetAmount > 0.1) risk = Math.max(risk, 24);
  if (wetAmount > 0.1) reasons.push('precipitation');

  const effectiveWind = Math.max(
    Number.isFinite(gust) ? gust : 0,
    Number.isFinite(wind) ? wind : 0
  );
  if (effectiveWind >= 90) risk = Math.max(risk, 65);
  else if (effectiveWind >= 70) risk = Math.max(risk, 45);
  else if (effectiveWind >= 50) risk = Math.max(risk, 25);
  if (effectiveWind >= 50) reasons.push('strong wind');

  if (Number.isFinite(temperature) && temperature <= -15) {
    risk = Math.max(risk, 32);
    reasons.push('extreme cold');
  } else if (Number.isFinite(temperature) && temperature <= -5) {
    risk = Math.max(risk, 18);
    reasons.push('cold');
  }

  return {
    risk: clamp(Math.round(risk), 0, 100),
    reasons: [...new Set(reasons)],
    freezingPrecipitation,
  };
}

export function classifyWeatherSamples(samples = []) {
  const temperatures = samples.map((sample) => sample.temperature_2m).filter(Number.isFinite);
  const precipitation = samples.map((sample) => sample.precipitation).filter(Number.isFinite);
  const precipitationProbability = samples.map((sample) => sample.precipitation_probability).filter(Number.isFinite);
  const rain = samples.map((sample) => sample.rain).filter(Number.isFinite);
  const snow = samples.map((sample) => sample.snowfall).filter(Number.isFinite);
  const visibility = samples.map((sample) => sample.visibility).filter(Number.isFinite);
  const wind = samples.map((sample) => sample.wind_speed_10m).filter(Number.isFinite);
  const gusts = samples.map((sample) => sample.wind_gusts_10m).filter(Number.isFinite);
  const freezingLevel = samples.map((sample) => sample.freezing_level_height).filter(Number.isFinite);
  const codes = samples.map((sample) => sample.weather_code).filter(Number.isFinite);

  const avgTempC = avg(temperatures);
  const totalPrecipMm = precipitation.reduce((sum, value) => sum + value, 0);
  const totalRainMm = rain.reduce((sum, value) => sum + value, 0);
  const totalSnowCm = snow.reduce((sum, value) => sum + value, 0);
  const minVisibilityM = visibility.length ? Math.min(...visibility) : null;
  const maxWindKmh = wind.length ? Math.max(...wind) : null;
  const maxWindGustKmh = gusts.length ? Math.max(...gusts) : null;
  const maxPrecipitationProbability = precipitationProbability.length ? Math.max(...precipitationProbability) : null;
  const minFreezingLevelM = freezingLevel.length ? Math.min(...freezingLevel) : null;
  const dominantCode = codes.sort((a, b) => (
    codes.filter((code) => code === b).length - codes.filter((code) => code === a).length
  ))[0] ?? null;
  const label = weatherCodeLabel(dominantCode);
  const sampleRisks = samples.map(sampleWeatherRisk);
  const freezingPrecip = sampleRisks.some((sample) => sample.freezingPrecipitation);
  const fog = label === 'fog' || (minVisibilityM != null && minVisibilityM < 1000);
  const snowing = label === 'snow' || totalSnowCm > 0.1;
  const rainCodeShare = codes.length ? codes.filter(isRainCode).length / codes.length : 0;
  const rainy = totalRainMm > 0.1 || totalPrecipMm > 0.2 || (rainCodeShare >= 0.75 && (totalRainMm > 0.02 || totalPrecipMm > 0.05));
  const storming = codes.some((code) => [95, 96, 99].includes(code));
  const condition = storming
    ? 'storm'
    : freezingPrecip
      ? 'freezing_precipitation'
      : snowing
        ? 'snow'
        : fog
          ? 'fog'
          : rainy
            ? 'rain'
            : label === 'rain'
              ? 'cloudy'
              : label;

  const riskScore = sampleRisks.length
    ? Math.max(...sampleRisks.map((sample) => sample.risk))
    : 0;
  const riskReasons = [...new Set(sampleRisks.flatMap((sample) => sample.reasons))];
  const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'moderate' : 'low';
  const riskMultiplier = riskScore >= 60 ? 1.45 : riskScore >= 30 ? 1.25 : riskScore >= 15 ? 1.15 : 1;

  return {
    provider: 'open-meteo',
    source: 'open_meteo',
    condition,
    confidence: 'modelled',
    riskLevel,
    riskScore,
    riskMultiplier,
    risk_reasons: riskReasons,
    avg_temp_c: avgTempC == null ? null : round1(avgTempC),
    precipitation_mm: round1(totalPrecipMm),
    precipitation_probability_pct: maxPrecipitationProbability == null ? null : Math.round(maxPrecipitationProbability),
    rain_mm: round1(totalRainMm),
    snow_cm: round1(totalSnowCm),
    min_visibility_m: minVisibilityM == null ? null : Math.round(minVisibilityM),
    max_wind_kmh: maxWindKmh == null ? null : round1(maxWindKmh),
    max_wind_gust_kmh: maxWindGustKmh == null ? null : round1(maxWindGustKmh),
    min_freezing_level_m: minFreezingLevelM == null ? null : Math.round(minFreezingLevelM),
    weather_code: dominantCode,
  };
}

const unavailableWeatherContext = (status, extra = {}) => ({
  provider: 'open-meteo',
  source: 'unavailable',
  status,
  riskLevel: null,
  riskScore: null,
  riskMultiplier: 1,
  ...extra,
});

const sourceForWeatherContext = (weatherContext = null) => {
  if (['open_meteo', 'user_confirmed', 'gps_inference', 'unavailable'].includes(weatherContext?.source)) {
    return weatherContext.source;
  }
  const unavailableStatuses = new Set([
    'disabled',
    'empty_route',
    'manual_required',
    'no_hourly_match',
    'skipped_privacy',
    'unavailable',
  ]);
  if (unavailableStatuses.has(weatherContext?.status)) {
    return 'unavailable';
  }
  const hasFiniteRiskScore = weatherContext?.riskScore != null &&
    weatherContext.riskScore !== '' &&
    Number.isFinite(Number(weatherContext.riskScore));
  if (weatherContext?.provider === 'open-meteo' || hasFiniteRiskScore) {
    return 'open_meteo';
  }
  return 'unavailable';
};

/**
 * True only when a lookup produced a real observation. Unavailable, skipped,
 * disabled, and no-match results are not observations and must never replace a
 * condition the driver confirmed by hand.
 * @param {Record<string, any> | null} weatherContext
 */
export function isUsableWeatherObservation(weatherContext = null) {
  if (!weatherContext) return false;
  if (sourceForWeatherContext(weatherContext) === 'unavailable') return false;
  return Number.isFinite(Number(weatherContext.riskScore));
}

/**
 * Decide which weather context survives a lookup. A failed, empty, or skipped
 * result carries no evidence, so it must not overwrite a condition the driver
 * confirmed by hand.
 * @param {Record<string, any> | null} existingContext
 * @param {Record<string, any> | null} fetchedContext
 * @returns {{ context: Record<string, any> | null, keptConfirmed: boolean }}
 */
export function resolveWeatherContextAfterLookup(existingContext = null, fetchedContext = null) {
  const keptConfirmed = existingContext?.source === 'user_confirmed' &&
    !isUsableWeatherObservation(fetchedContext);
  return {
    context: keptConfirmed ? existingContext : fetchedContext,
    keptConfirmed,
  };
}

export function buildUserConfirmedWeatherContext(condition, observedAt = new Date().toISOString()) {
  const normalized = String(condition || '').trim().toLowerCase();
  const preset = USER_CONFIRMED_WEATHER[normalized];
  if (!preset) throw new Error('Choose a supported weather condition.');
  return {
    provider: 'user',
    source: 'user_confirmed',
    status: 'user_confirmed',
    confidence: 'confirmed',
    condition: normalized,
    riskLevel: preset.riskScore >= 60 ? 'high' : preset.riskScore >= 30 ? 'moderate' : 'low',
    riskScore: preset.riskScore,
    riskMultiplier: preset.riskMultiplier,
    observed_at: observedAt,
    network_used: false,
  };
}

const gpsWeatherContextFromScores = (scores = {}) => {
  const proxy = scores.slippery_proxy;
  if (!proxy || proxy === 'insufficient_data') return unavailableWeatherContext('unavailable');
  return {
    provider: 'gps-stopping-distance',
    source: 'gps_inference',
    status: 'gps_inference',
    condition: proxy,
    confidence: 'low',
    interpretation: 'possible_low_grip_or_cautious_braking',
    riskLevel: null,
    riskScore: null,
    riskMultiplier: 1,
    wet_signal_count: scores.wet_signal_count ?? 0,
    wet_ratio: scores.wet_ratio ?? 0,
  };
};

function insidePrivacyWeatherBuffer(point, zones = []) {
  return Boolean(isPointInPrivacyZone(point, zones, ZONE_BUFFER_M));
}

function safeWeatherPoint(routePoints = [], privacyZones = []) {
  const valid = (routePoints || []).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
  if (!valid.length) return null;
  const safePoints = privacyZones.length
    ? valid.map((point) => ({
      lat: Number(Number(point.lat).toFixed(4)),
      lng: Number(Number(point.lng).toFixed(4)),
    })).filter((point) => !insidePrivacyWeatherBuffer(point, privacyZones))
    : valid;
  if (!safePoints.length) return null;
  return safePoints[Math.floor(safePoints.length / 2)];
}

function parseOpenMeteoHourlyTime(time, utcOffsetSeconds) {
  if (typeof time !== 'string') return NaN;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(time)) return new Date(time).getTime();

  const match = time.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || !Number.isFinite(utcOffsetSeconds)) return new Date(time).getTime();

  const [, year, month, day, hour, minute, second = '0'] = match;
  const localAsUtcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  return localAsUtcMs - utcOffsetSeconds * 1000;
}

function openMeteoUrl({ lat, lng, date }) {
  const startDate = dayKey(date);
  const tripDate = new Date(startDate);
  const today = new Date(dayKey(Date.now()));
  const useArchive = Number.isFinite(tripDate.getTime()) && tripDate < today;
  const url = new URL(useArchive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lng.toFixed(4));
  url.searchParams.set('hourly', (useArchive ? ARCHIVE_HOURLY_FIELDS : FORECAST_HOURLY_FIELDS).join(','));
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', startDate);
  url.searchParams.set('timezone', 'auto');
  return url;
}

async function fetchOpenMeteoWeather({
  lat,
  lng,
  date,
  tripId = null,
  zonesSuppressed = [],
  privacyVerificationEvidence = [],
  privacyZones = [],
  signal = null,
}) {
  const startDate = dayKey(date);
  const url = openMeteoUrl({ lat, lng, date });

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), WEATHER_NETWORK_TIMEOUT_MS);
  try {
    throwIfWeatherRequestAborted(controller.signal);
    const response = await withRetry('open-meteo-weather', () => privacyGatedFetch('open-meteo', {
      url: url.toString(),
      signal: controller.signal,
    }, {
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      privacyVerificationEvidence,
      sentCoords: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      protections: ['privacy-zone buffer +100m', 'rounded to 4 decimals'],
      status: 'safe',
      tripId,
      zonesSuppressed,
      guard: () => insidePrivacyWeatherBuffer({ lat, lng }, privacyZones)
        ? {
          reason: 'rounded_coordinate_within_privacy_guard',
          privacyVerificationEvidence: ['exact rounded weather coordinate failed the final privacy-zone guard'],
          protections: ['final pre-send privacy-zone buffer +100m guard'],
          zonesSuppressed,
        }
        : null,
    }));
    if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
    return response.json();
  } catch (error) {
    logSystemFailure('weather_open_meteo_fetch', error, {
      date: startDate,
      provider: 'open-meteo',
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function samplesForTrip(data, startTime, endTime) {
  const hourly = data?.hourly || {};
  const times = hourly.time || [];
  const utcOffsetSeconds = Number(data?.utc_offset_seconds);
  const startMs = new Date(startTime || Date.now()).getTime();
  const endMs = new Date(endTime || startTime || Date.now()).getTime();
  const samples = times.map((time, index) => {
    const ms = parseOpenMeteoHourlyTime(time, utcOffsetSeconds);
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) return null;
    return {
      sample_time: time,
      temperature_2m: Number(hourly.temperature_2m?.[index]),
      precipitation: Number(hourly.precipitation?.[index]),
      precipitation_probability: Number(hourly.precipitation_probability?.[index]),
      rain: Number(hourly.rain?.[index]),
      snowfall: Number(hourly.snowfall?.[index]),
      weather_code: Number(hourly.weather_code?.[index]),
      visibility: Number(hourly.visibility?.[index]),
      wind_speed_10m: Number(hourly.wind_speed_10m?.[index]),
      wind_gusts_10m: Number(hourly.wind_gusts_10m?.[index]),
      freezing_level_height: Number(hourly.freezing_level_height?.[index]),
    };
  }).filter(Boolean);
  if (samples.length) return samples;

  const midpointMs = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? startMs + (endMs - startMs) / 2
    : startMs;
  /** @type {{ time: string, index: number, delta: number } | null} */
  let nearest = null;
  times.forEach((time, index) => {
    const ms = parseOpenMeteoHourlyTime(time, utcOffsetSeconds);
    if (!Number.isFinite(ms)) return;
    const delta = Math.abs(ms - midpointMs);
    if (delta > 60 * 60 * 1000) return;
    if (!nearest || delta < nearest.delta) {
      nearest = { time, index, delta };
    }
  });
  if (!nearest) return [];
  return [{
    sample_time: nearest.time,
    temperature_2m: Number(hourly.temperature_2m?.[nearest.index]),
    precipitation: Number(hourly.precipitation?.[nearest.index]),
    precipitation_probability: Number(hourly.precipitation_probability?.[nearest.index]),
    rain: Number(hourly.rain?.[nearest.index]),
    snowfall: Number(hourly.snowfall?.[nearest.index]),
    weather_code: Number(hourly.weather_code?.[nearest.index]),
    visibility: Number(hourly.visibility?.[nearest.index]),
    wind_speed_10m: Number(hourly.wind_speed_10m?.[nearest.index]),
    wind_gusts_10m: Number(hourly.wind_gusts_10m?.[nearest.index]),
    freezing_level_height: Number(hourly.freezing_level_height?.[nearest.index]),
  }];
}

/**
 * Resolve weather already stored on this device without making a network request.
 * The same privacy-zone selection rules used by online weather are applied.
 */
export async function resolveCachedWeatherContextForTrip(routePoints = [], startTime, endTime, settings = {}) {
  if (isHeightenedPrivacyMode(settings)) return unavailableWeatherContext('disabled_heightened_privacy');
  if (settings.weather_context_enabled === false) return unavailableWeatherContext('disabled');

  const privacyZones = getPrivacyZones(settings);
  const center = privacyZones.length ? safeWeatherPoint(routePoints, privacyZones) : midpoint(routePoints);
  if (!center) {
    const hasRoutePoints = Array.isArray(routePoints) && routePoints.length > 0;
    return unavailableWeatherContext(privacyZones.length && hasRoutePoints ? 'skipped_privacy' : 'empty_route');
  }

  const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)},${dayKey(startTime)}`;
  const cache = await getEncryptedJson(WEATHER_CACHE_KEY, {});
  const cached = cache[key];
  const tripDate = new Date(dayKey(startTime));
  const today = new Date(dayKey(Date.now()));
  const historical = Number.isFinite(tripDate.getTime()) && tripDate < today;
  const maxAge = historical ? HISTORICAL_CACHE_MAX_AGE_MS : CACHE_MAX_AGE_MS;
  if (!cached?.data || !Number.isFinite(Number(cached.savedAt)) || Date.now() - Number(cached.savedAt) > maxAge) {
    return unavailableWeatherContext('cache_miss');
  }

  const samples = samplesForTrip(cached.data, startTime, endTime);
  if (!samples.length) return unavailableWeatherContext('no_hourly_match');
  return {
    ...classifyWeatherSamples(samples),
    status: 'cache_hit_local',
    sample_count: samples.length,
    network_used: false,
    cache_age_minutes: Math.max(0, Math.round((Date.now() - Number(cached.savedAt)) / 60000)),
    lat: round1(center.lat),
    lng: round1(center.lng),
  };
}

export async function fetchWeatherContextForTrip(routePoints = [], startTime, endTime, settings = {}, options = {}) {
  const signal = options?.signal;
  throwIfWeatherRequestAborted(signal);
  if (isHeightenedPrivacyMode(settings)) {
    recordSystemEvent('weather_context_skipped', { status: 'disabled_heightened_privacy' }, { category: 'weather' });
    return unavailableWeatherContext('disabled_heightened_privacy');
  }
  if (settings.weather_context_enabled === false) {
    recordSystemEvent('weather_context_skipped', { status: 'disabled' }, { category: 'weather' });
    return unavailableWeatherContext('disabled');
  }
  const privacyZones = getPrivacyZones(settings);
  const center = privacyZones.length ? safeWeatherPoint(routePoints, privacyZones) : midpoint(routePoints);
  if (!center) {
    const hasRoutePoints = Array.isArray(routePoints) && routePoints.length > 0;
    recordSystemEvent('weather_context_unavailable', {
      status: privacyZones.length && hasRoutePoints ? 'skipped_privacy' : 'empty_route',
      route_point_count: Array.isArray(routePoints) ? routePoints.length : 0,
      privacy_zone_count: privacyZones.length,
      reason: privacyZones.length && hasRoutePoints
        ? WEATHER_SKIPPED_ALL_POINTS_PRIVATE
        : 'No usable route points were available.',
    }, { category: 'weather', severity: 'warn', title: 'Operation failed: weather_context' });
    if (privacyZones.length && hasRoutePoints) {
      await privacyGatedFetch('open-meteo', { url: 'https://api.open-meteo.com/v1/forecast' }, {
        type: 'Weather lookup',
        coordinateDisclosure: 'blocked',
        block: {
          privacyVerificationEvidence: ['all weather candidates were inside privacy-zone buffers'],
          protections: ['all route points inside privacy buffer - request blocked'],
          zonesSuppressed: privacyZones.map((zone) => zone.label),
        },
      });
    }
    return unavailableWeatherContext(privacyZones.length && hasRoutePoints ? 'skipped_privacy' : 'empty_route', {
      ...(privacyZones.length && hasRoutePoints
        ? { weather_context: null, weather_skipped_reason: WEATHER_SKIPPED_ALL_POINTS_PRIVATE }
        : {}),
    });
  }

  const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)},${dayKey(startTime)}`;
  const cache = await getEncryptedJson(WEATHER_CACHE_KEY, {});
  throwIfWeatherRequestAborted(signal);
  const cached = cache[key];
  let data = cached?.data;
  let status = 'cache_hit';
  const tripDate = new Date(dayKey(startTime));
  const today = new Date(dayKey(Date.now()));
  const historical = Number.isFinite(tripDate.getTime()) && tripDate < today;
  const maxAge = historical ? HISTORICAL_CACHE_MAX_AGE_MS : CACHE_MAX_AGE_MS;
  if (!data || Date.now() - cached.savedAt > maxAge) {
    const weatherRequest = {
      lat: center.lat,
      lng: center.lng,
      date: startTime,
      zonesSuppressed: privacyZones.map((zone) => zone.label),
      privacyZones,
      signal,
      privacyVerificationEvidence: [
        privacyZones.length === 0
          ? 'no privacy zones were configured for this weather lookup'
          : 'selected point is outside privacy-zone weather buffer',
        'coordinate is rounded to 4 decimals',
      ],
    };
    // Pass the caller's settings so a manual foreground "Get Weather" tap can
    // skip the 3-9 minute obfuscation batch it would otherwise time out behind.
    data = await enqueueLocationRequest(
      'weather',
      () => fetchOpenMeteoWeather(weatherRequest),
      null,
      { settings }
    );
    throwIfWeatherRequestAborted(signal);
    status = 'fetched';
    await setEncryptedJson(WEATHER_CACHE_KEY, {
      ...cache,
      [key]: { savedAt: Date.now(), data },
    });
  }

  const samples = samplesForTrip(data, startTime, endTime);
  if (!samples.length) {
    recordSystemEvent('weather_context_unavailable', {
      status: 'no_hourly_match',
      sample_count: 0,
      reason: 'No Open-Meteo hourly sample matched the trip time window.',
    }, { category: 'weather', severity: 'warn', title: 'Operation failed: weather_context' });
    return unavailableWeatherContext('no_hourly_match');
  }
  recordSystemEvent('weather_context_loaded', {
    status,
    sample_count: samples.length,
    provider: 'open-meteo',
  }, { category: 'weather' });
  return {
    ...classifyWeatherSamples(samples),
    status,
    sample_count: samples.length,
    lat: round1(center.lat),
    lng: round1(center.lng),
  };
}

export function applyWeatherRiskToScores(scores = {}, weatherContext = null) {
  const sourcedWeatherContext = weatherContext
    ? { ...weatherContext, source: sourceForWeatherContext(weatherContext) }
    : null;
  const displayWeatherContext = ['open_meteo', 'user_confirmed'].includes(sourcedWeatherContext?.source)
    ? sourcedWeatherContext
    : (
      scores.slippery_proxy && scores.slippery_proxy !== 'insufficient_data'
        ? gpsWeatherContextFromScores(scores)
        : sourcedWeatherContext || unavailableWeatherContext('unavailable')
    );
  const hasWeatherRiskScore = weatherContext?.riskScore != null &&
    weatherContext.riskScore !== '' &&
    Number.isFinite(Number(weatherContext.riskScore));
  if (!weatherContext || !hasWeatherRiskScore || Number(weatherContext.riskScore) <= 0) {
    return {
      ...scores,
      weather_context: displayWeatherContext,
      weather_risk_score: hasWeatherRiskScore ? Number(weatherContext.riskScore) : null,
      weather_score_adjustment: 0,
    };
  }
  // Brake-turn alerts are GPS-only advisories, not scored Safety evidence.
  const eventCount =
    (scores.harsh_brakes_count || 0) +
    (scores.sharp_turns_count || 0) +
    (scores.speeding_events_count || 0);
  const weatherPenalty = Math.min(
    scoringValue('WEATHER_SCORE_PENALTY_CAP'),
    Math.round(eventCount * ((weatherContext.riskMultiplier || 1) - 1) * scoringValue('WEATHER_EVENT_PENALTY_SCALE'))
  );
  if (weatherPenalty <= 0) {
    return {
      ...scores,
      weather_context: sourcedWeatherContext,
      weather_risk_score: weatherContext.riskScore,
      weather_score_adjustment: 0,
    };
  }

  const scoreSafety = Number.isFinite(Number(scores.score_safety))
    ? clamp(Number(scores.score_safety) - weatherPenalty, 0, 100)
    : null;
  const overallBlend = scoringValue('OVERALL_SCORE_BLEND_WEIGHTS');
  const scoreOverall = clamp(weightedBlend([
    { score: scoreSafety, weight: overallBlend.safety },
    { score: scores.score_smoothness, weight: overallBlend.smoothness },
    { score: scores.intersection_score, weight: overallBlend.intersection },
  ]) ?? Number(scores.score_overall) ?? 0, 0, 100);
  const componentScores = scores.component_scores
    ? {
      ...scores.component_scores,
      safety: {
        ...scores.component_scores.safety,
        value: scoreSafety,
        dataSource: [...new Set([
          ...(scores.component_scores.safety?.dataSource || []),
          sourcedWeatherContext?.source === 'user_confirmed' ? 'user_confirmed_weather' : 'open_meteo_weather',
        ])],
      },
      overall: {
        ...scores.component_scores.overall,
        value: scoreOverall,
        dataSource: [...new Set([
          ...(scores.component_scores.overall?.dataSource || []),
          sourcedWeatherContext?.source === 'user_confirmed' ? 'user_confirmed_weather' : 'open_meteo_weather',
        ])],
      },
    }
    : undefined;

  return {
    ...scores,
    score_safety: scoreSafety,
    score_overall: scoreOverall,
    ...(componentScores ? { component_scores: componentScores } : {}),
    weather_context: sourcedWeatherContext,
    weather_risk_score: weatherContext.riskScore,
    weather_score_adjustment: -weatherPenalty,
  };
}
