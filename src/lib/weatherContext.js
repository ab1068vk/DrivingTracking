import { getJson, setJson } from '@/lib/mobileStorage';

const WEATHER_CACHE_KEY = 'drivesense_open_meteo_weather_cache_v1';
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round1 = (value) => Math.round(value * 10) / 10;

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

async function fetchOpenMeteoWeather({ lat, lng, date }) {
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function samplesForTrip(data, startTime, endTime) {
  const hourly = data?.hourly || {};
  const times = hourly.time || [];
  const startMs = new Date(startTime || Date.now()).getTime();
  const endMs = new Date(endTime || startTime || Date.now()).getTime();
  const samples = times.map((time, index) => {
    const ms = new Date(time).getTime();
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
  let nearest = null;
  times.forEach((time, index) => {
    const ms = new Date(time).getTime();
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
    return { provider: 'open-meteo', status: 'disabled', riskLevel: 'low', riskScore: 0, riskMultiplier: 1 };
  }
  const center = midpoint(routePoints);
  if (!center) return { provider: 'open-meteo', status: 'empty_route', riskLevel: 'low', riskScore: 0, riskMultiplier: 1 };

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
    data = await fetchOpenMeteoWeather({ lat: center.lat, lng: center.lng, date: startTime });
    status = 'fetched';
    await setJson(WEATHER_CACHE_KEY, {
      ...cache,
      [key]: { savedAt: Date.now(), data },
    });
  }

  const samples = samplesForTrip(data, startTime, endTime);
  if (!samples.length) return { provider: 'open-meteo', status: 'no_hourly_match', riskLevel: 'low', riskScore: 0, riskMultiplier: 1 };
  return {
    ...classifyWeather(samples),
    status,
    sample_count: samples.length,
    lat: round1(center.lat),
    lng: round1(center.lng),
  };
}

export function applyWeatherRiskToScores(scores = {}, weatherContext = null) {
  if (!weatherContext || weatherContext.riskScore <= 0) return scores;
  const eventCount =
    (scores.harsh_brakes_count || 0) +
    (scores.sharp_turns_count || 0) +
    (scores.near_miss_count || 0) * 2 +
    (scores.speeding_events_count || 0);
  const weatherPenalty = Math.min(12, Math.round(eventCount * ((weatherContext.riskMultiplier || 1) - 1) * 6));
  if (weatherPenalty <= 0) {
    return {
      ...scores,
      weather_context: weatherContext,
      weather_risk_score: weatherContext.riskScore,
      weather_score_adjustment: 0,
    };
  }

  const scoreSafety = clamp((scores.score_safety ?? 100) - weatherPenalty, 0, 100);
  const scoreOverall = clamp(Math.round(
    scoreSafety * 0.35 +
    (scores.score_smoothness ?? 100) * 0.30 +
    (scores.score_eco ?? 100) * 0.20 +
    (scores.intersection_score ?? 100) * 0.15
  ), 0, 100);

  return {
    ...scores,
    score_safety: scoreSafety,
    score_overall: scoreOverall,
    weather_context: weatherContext,
    weather_risk_score: weatherContext.riskScore,
    weather_score_adjustment: -weatherPenalty,
  };
}
