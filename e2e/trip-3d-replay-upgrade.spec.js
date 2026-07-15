import { expect, test } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { LEGAL_NOTICE_ACK_VERSION } from '../src/lib/legalDisclaimers.js';

const onboardedSettings = {
  onboarding_completed: true,
  legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
  legal_notice_acknowledged_at: '2026-06-07T00:00:00.000Z',
  tracking_mode: 'manual',
  dark_mode: 'system',
  units: 'metric',
  raw_gps_retention_days: 365,
};

const buildSyntheticTrip = () => {
  const startMs = Date.now() - 20 * 60_000;
  const routePoints = Array.from({ length: 48 }, (_, index) => {
    const timestamp = new Date(startMs + index * 15_000).toISOString();
    return {
      lat: 43.6508 + index * 0.00016,
      lng: -79.3832 + Math.sin(index / 5) * 0.001,
      timestamp,
      speed_kmh: Math.max(0, 28 + Math.sin(index / 4) * 18 + (index > 24 ? 16 : 0)),
      speed_limit_kmh: index > 24 ? 50 : 40,
      accuracy: 8,
      altitude: 84 + Math.sin(index / 6) * 8 + index * 0.15,
      altitude_accuracy: 6,
    };
  });

  return {
    id: 'visual-3d-upgrade',
    nickname: 'Visual 3D Upgrade',
    status: 'completed',
    privacy_mode: 'standard',
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(startMs + (routePoints.length - 1) * 15_000).toISOString(),
    duration_seconds: (routePoints.length - 1) * 15,
    distance_km: 3.1,
    avg_speed_kmh: 39,
    max_speed_kmh: 67,
    route_replay_available: true,
    route_points_raw_count: routePoints.length,
    route_points_map_count: routePoints.length,
    route_points: routePoints,
    driving_events: [
      {
        type: 'harsh_brake',
        severity: 'high',
        lat: routePoints[14].lat,
        lng: routePoints[14].lng,
        timestamp: routePoints[14].timestamp,
      },
      {
        type: 'speeding',
        severity: 'medium',
        lat: routePoints[31].lat,
        lng: routePoints[31].lng,
        timestamp: routePoints[31].timestamp,
      },
    ],
  };
};

const parsePngPixels = (buffer) => {
  const signatureLength = 8;
  let offset = signatureLength;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      colorType = buffer[dataStart + 9];
    }
    if (type === 'IDAT') idatChunks.push(buffer.subarray(dataStart, dataEnd));
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] || 0 : 0;
      const predictor = (() => {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        if (pa <= pb && pa <= pc) return left;
        return pb <= pc ? up : upLeft;
      })();
      if (filter === 1) row[x] = (row[x] + left) & 255;
      if (filter === 2) row[x] = (row[x] + up) & 255;
      if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      if (filter === 4) row[x] = (row[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * 4;
      pixels[target] = row[source];
      pixels[target + 1] = row[source + 1];
      pixels[target + 2] = row[source + 2];
      pixels[target + 3] = colorType === 6 ? row[source + 3] : 255;
    }
    previous = row;
  }

  return { width, height, pixels };
};

const summarizeCanvasPng = (buffer) => {
  const { width, height, pixels } = parsePngPixels(buffer);
  let sampled = 0;
  let colored = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 24));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const a = pixels[index + 3];
      sampled += 1;
      if (a > 0 && (r > 55 || g > 70 || b > 95)) colored += 1;
    }
  }
  return { sampled, colored };
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
  }, onboardedSettings);
});

test('renders upgraded 3D replay with chapters and nonblank WebGL canvas', async ({ page }, testInfo) => {
  const trip = buildSyntheticTrip();

  await page.addInitScript((tripRecord) => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: undefined,
    });
    localStorage.setItem('drivesense_trips', JSON.stringify([tripRecord]));
  }, trip);

  await page.goto(`/trips/${trip.id}/3d`);
  await expect(page.getByRole('heading', { name: trip.nickname })).toBeVisible();
  await expect(page.getByText('Drive chapters')).toBeVisible();
  await expect(page.getByRole('button', { name: /Cinema/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hood' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter 3D fullscreen' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Auto/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Director' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable local drive sound' })).toBeVisible();
  await expect(page.getByRole('button', { name: /1x replay/ })).toBeVisible();
  await expect(page.getByLabel('3D telemetry')).toContainText('Accel steady');
  await expect(page.getByLabel('3D telemetry')).toContainText('Cornering straight');
  await expect(page.getByLabel('3D telemetry')).toContainText('Altitude');
  await expect(page.getByLabel('3D telemetry')).toContainText('Scene optimized');
  await expect(page.getByRole('img', { name: 'Trip elevation profile' })).toBeVisible();
  if (testInfo.project.name === 'chromium') {
    await expect(page.getByTestId('trip-3d-minimap')).toBeVisible();
  }

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/trip-3d-replay-upgrade.png', fullPage: true });

  const pixelSummary = summarizeCanvasPng(await canvas.screenshot());
  expect(pixelSummary.sampled).toBeGreaterThan(100);
  expect(pixelSummary.colored).toBeGreaterThan(25);

  const playbackPosition = page.getByRole('slider', { name: '3D drive playback position' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(1100);
  expect(Number(await playbackPosition.inputValue())).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'Pause' }).click();

  await page.getByRole('button', { name: 'Enable local drive sound' }).click();
  await expect(page.getByRole('button', { name: 'Disable local drive sound' })).toBeVisible();
  await page.getByRole('button', { name: 'Disable local drive sound' }).click();
});
