import { describe, expect, it } from 'vitest';

const runLive = process.env.LIVE_EXTERNAL_CONTRACTS === 'true';
const liveDescribe = runLive ? describe : describe.skip;

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RoadSageContractTest/1.0 (https://github.com/ab1068vk/DrivingTracking)',
        ...options.headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 120)}`);
    }
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

liveDescribe('live external service contracts', () => {
  it('checks the Open-Meteo forecast JSON contract', async () => {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', '43.6500');
    url.searchParams.set('longitude', '-79.3800');
    url.searchParams.set('hourly', 'temperature_2m,precipitation,weather_code,visibility');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'UTC');

    const { response, data } = await fetchJson(url);

    expect(response.ok).toBe(true);
    expect(Array.isArray(data.hourly?.time)).toBe(true);
    expect(Array.isArray(data.hourly?.temperature_2m)).toBe(true);
    expect(data.hourly.time.length).toBeGreaterThan(0);
  }, 25_000);

  it('checks the Overpass interpreter JSON contract', async () => {
    const body = new URLSearchParams({
      data: `
        [out:json][timeout:15];
        way["highway"](43.6500,-79.3810,43.6510,-79.3790);
        out tags 1;
      `,
    });

    const { response, data } = await fetchJson('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });

    expect(response.ok).toBe(true);
    expect(Array.isArray(data.elements)).toBe(true);
  }, 25_000);

  it('checks the public OSRM match JSON contract', async () => {
    const url = new URL('https://router.project-osrm.org/match/v1/driving/13.388860,52.517037;13.397634,52.529407;13.428555,52.523219');
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('steps', 'false');
    url.searchParams.set('radiuses', '15;15;15');

    const { response, data } = await fetchJson(url);

    expect(response.ok).toBe(true);
    expect(data.code).toBe('Ok');
    expect(Array.isArray(data.matchings)).toBe(true);
  }, 25_000);
});
