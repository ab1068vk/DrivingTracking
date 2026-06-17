import { clamp } from '@/lib/mathUtils';
import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { withRetry } from '@/lib/retry';
import { weightedBlend } from '@/lib/tripEngine';
import { scoringValue } from '@/lib/scoringConstants';
import { getPrivacyZones, isPointInPrivacyZone } from '@/lib/privacyZones';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { pinnedFetch } from '@/lib/pinnedFetch';
import { logTransmission } from '@/lib/transmissionLog';
import { enqueueLocationRequest } from '@/lib/requestObfuscator';

const WEATHER_CACHE_KEY = 'drivesense_open_meteo_weather_cache_v1';
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ZONE_BUFFER_M = 100;
export const WEATHER_SKIPPED_ALL_POINTS_PRIVATE = 'all_points_within_privacy_zones';

const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round1 = (value) => Math.round(value * 10) / 10;

export async function clearWeatherContextCache() {
  await removeJson(WEATHER_CACHE_KEY);
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

function classifyWeather(samples = []) {
  const temperatures = samples.map((sample) => sample.temperature_2m).filter(Number.isFinite);
  const precipitation = samples.map((sample) => sample.precipitation).filter(Number.isFinite);
  const rain = samples.map((sample) => sample.rain).filter(Number.isFinite);
  const snow = samples.map((sample) => sample.snowfall).filter(Number.isFinite);
  const visibility = samples.map((sample) => sample.visibility).filter(Number.isFinite);
  const codes = samples.map((sample) => sample.weather_code).filter(Number.isFinite);

  const avgTempC = avg(temperatures);
  const totalPrecipMm = precipitation.reduce((sum, value) => sum + value, 0);
  const totalRainMm = rain.reduce((sum, value) => sum + value, 0);
  const totalSnowCm = snow.reduce((sum, value) => sum + value, 0);
  const minVisibilityM = visibility.length ? Math.min(...visibility) : null;
  const dominantCode = codes.sort((a, b) => (
    codes.filter((code) => code === b).length - codes.filter((code) => code === a).length
  ))[0] ?? null;
  const label = weatherCodeLabel(dominantCode);
  const freezingPrecip = avgTempC != null && avgTempC <= 1.5 && (totalPrecipMm > 0.2 || totalRainMm > 0.2);
  const fog = label === 'fog' || (minVisibilityM != null && minVisibilityM < 1000);
  const snowing = label === 'snow' || totalSnowCm > 0.1;
  const rainCodeShare = codes.length ? codes.filter(isRainCode).length / codes.length : 0;
  const rainy = totalRainMm > 0.1 || totalPrecipMm > 0.2 || (rainCodeShare >= 0.75 && (totalRainMm > 0.02 || totalPrecipMm > 0.05));
  const condition = freezingPrecip
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

  let riskScore = 0;
  if (rainy) riskScore += 22;
  if (snowing) riskScore += 38;
  if (fog) riskScore += 28;
  if (freezingPrecip) riskScore += 45;
  if (avgTempC != null && avgTempC <= -5) riskScore += 12;
  riskScore = clamp(Math.round(riskScore), 0, 100);

  return {
    provider: 'open-meteo',
    source: 'open_meteo',
    condition,
    riskLevel: riskScore >= 60 ? 'high' : riskScore >= 30 ? 'moderate' : 'low',
    riskScore,
    riskMultiplier: riskScore >= 60 ? 1.45 : riskScore >= 30 ? 1.2 : 1,
    avg_temp_c: avgTempC == null ? null : round1(avgTempC),
    precipitation_mm: round1(totalPrecipMm),
    rain_mm: round1(totalRainMm),
    snow_cm: round1(totalSnowCm),
    min_visibility_m: minVisibilityM == null ? null : Math.round(minVisibilityM),
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
  if (['open_meteo', 'gps_inference', 'unavailable'].includes(weatherContext?.source)) {
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

const gpsWeatherContextFromScores = (scores = {}) => {
  const proxy = scores.slippery_proxy;
  if (!proxy || proxy === 'insufficient_data') return unavailableWeatherContext('unavailable');
  return {
    provider: 'gps-stopping-distance',
    source: 'gps_inference',
    status: 'gps_inference',
    condition: proxy,
    riskLevel: proxy === 'likely_wet' ? 'moderate' : proxy === 'possible_wet' ? 'low' : 'none',
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
    ? valid.filter((point) => !insidePrivacyWeatherBuffer(point, privacyZones))
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
  url.searchParams.set('hourly', 'temperature_2m,precipitation,rain,snowfall,weather_code,visibility');
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
  privacyTransformVerified = false,
  privacyVerificationEvidence = [],
}) {
  const startDate = dayKey(date);
  const url = openMeteoUrl({ lat, lng, date });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    await logTransmission({
      service: 'open-meteo',
      type: 'Weather lookup',
      coordinateDisclosure: 'rounded',
      privacyTransformVerified,
      privacyTransformSource: 'weatherContext.js:safeWeatherPoint',
      privacyVerificationEvidence,
      sentCoords: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      protections: ['privacy-zone buffer +100m', 'rounded to 4 decimals'],
      offsetMeters: null,
      bytesOut: url.toString().length,
      status: 'safe',
      tripId,
      zonesSuppressed,
    });
    const response = await withRetry('open-meteo-weather', () => pinnedFetch(url, { signal: controller.signal }));
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
      rain: Number(hourly.rain?.[index]),
      snowfall: Number(hourly.snowfall?.[index]),
      weather_code: Number(hourly.weather_code?.[index]),
      visibility: Number(hourly.visibility?.[index]),
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
    rain: Number(hourly.rain?.[nearest.index]),
    snowfall: Number(hourly.snowfall?.[nearest.index]),
    weather_code: Number(hourly.weather_code?.[nearest.index]),
    visibility: Number(hourly.visibility?.[nearest.index]),
  }];
}

export async function fetchWeatherContextForTrip(routePoints = [], startTime, endTime, settings = {}) {
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
      await logTransmission({
        service: 'open-meteo',
        type: 'Weather lookup',
        coordinateDisclosure: 'blocked',
        privacyTransformVerified: true,
        privacyTransformSource: 'weatherContext.js:safeWeatherPoint',
        privacyVerificationEvidence: ['all weather candidates were inside privacy-zone buffers'],
        sentCoords: null,
        protections: ['all route points inside privacy buffer - request blocked'],
        offsetMeters: null,
        bytesOut: 0,
        status: 'blocked',
        tripId: null,
        zonesSuppressed: privacyZones.map((zone) => zone.label),
      });
    }
    return unavailableWeatherContext(privacyZones.length && hasRoutePoints ? 'skipped_privacy' : 'empty_route', {
      ...(privacyZones.length && hasRoutePoints
        ? { weather_context: null, weather_skipped_reason: WEATHER_SKIPPED_ALL_POINTS_PRIVATE }
        : {}),
    });
  }

  const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)},${dayKey(startTime)}`;
  const cache = await getJson(WEATHER_CACHE_KEY, {});
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
      privacyTransformVerified: privacyZones.length === 0 ||
        !insidePrivacyWeatherBuffer(center, privacyZones),
      privacyVerificationEvidence: [
        privacyZones.length === 0
          ? 'no privacy zones were configured for this weather lookup'
          : 'selected point is outside privacy-zone weather buffer',
        'coordinate is rounded to 4 decimals',
      ],
    };
    data = await enqueueLocationRequest(
      'weather',
      () => fetchOpenMeteoWeather(weatherRequest),
      { url: openMeteoUrl(weatherRequest).toString(), method: 'GET' }
    );
    status = 'fetched';
    await setJson(WEATHER_CACHE_KEY, {
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
    ...classifyWeather(samples),
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
  const displayWeatherContext = sourcedWeatherContext?.source === 'open_meteo'
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
    { score: scores.score_eco, weight: overallBlend.eco },
    { score: scores.intersection_score, weight: overallBlend.intersection },
  ]) ?? Number(scores.score_overall) ?? 0, 0, 100);
  const componentScores = scores.component_scores
    ? {
      ...scores.component_scores,
      safety: {
        ...scores.component_scores.safety,
        value: scoreSafety,
        dataSource: [...new Set([...(scores.component_scores.safety?.dataSource || []), 'open_meteo_weather'])],
      },
      overall: {
        ...scores.component_scores.overall,
        value: scoreOverall,
        dataSource: [...new Set([...(scores.component_scores.overall?.dataSource || []), 'open_meteo_weather'])],
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
