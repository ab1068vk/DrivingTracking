import { expect, test } from '@playwright/test';
import { LEGAL_NOTICE_ACK_VERSION } from '../src/lib/legalDisclaimers.js';

const onboardedSettings = {
  onboarding_completed: true,
  legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
  legal_notice_acknowledged_at: '2026-06-07T00:00:00.000Z',
  experience_mode: 'coaching',
  tracking_mode: 'manual',
  dark_mode: 'system',
  units: 'metric',
};

const buildReplayTrip = (id, offset = 0, startOffsetMinutes = 0) => {
  const startMs = Date.now() - (60 + startOffsetMinutes) * 60_000;
  const routePoints = Array.from({ length: 10 }, (_, index) => ({
    lat: 43.6508 + offset + index * 0.00012,
    lng: -79.3832 + offset + index * 0.0001,
    timestamp: new Date(startMs + index * 45_000).toISOString(),
    speed_kmh: 32 + index * 3,
    speed_limit_kmh: index < 5 ? 40 : 50,
    speed_limit_source: index < 5 ? 'openstreetmap' : 'region_default_estimate',
    ...(index === 6 ? { route_gap: true } : {}),
  }));
  return {
    id,
    nickname: id === 'replay-a' ? 'Morning Route A' : 'Morning Route B',
    status: 'completed',
    privacy_mode: 'standard',
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(startMs + 9 * 45_000).toISOString(),
    duration_seconds: 9 * 45,
    distance_km: 3.4 + offset,
    avg_speed_kmh: 38 + offset * 100,
    route_replay_available: true,
    route_points_raw_count: routePoints.length,
    route_points_map_count: routePoints.length,
    route_points: routePoints,
    driving_events: [{
      type: id === 'replay-a' ? 'harsh_brake' : 'speeding',
      timestamp: routePoints[4].timestamp,
      lat: routePoints[4].lat,
      lng: routePoints[4].lng,
      speed_kmh: routePoints[4].speed_kmh,
      speed_limit_kmh: routePoints[4].speed_limit_kmh,
    }],
  };
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
  }, onboardedSettings);
});

const corePages = [
  { path: '/', heading: 'Dashboard' },
  { path: '/trips', heading: /Trip/i },
  { path: '/coach', heading: 'Driving Coach' },
  { path: '/settings', heading: 'Settings' },
  { path: '/reports', heading: 'Reports' },
];

for (const { path, heading } of corePages) {
  test(`keeps ${path} responsive without horizontal overflow`, async ({ page }) => {
    await page.goto(path);

    await expect(page.getByRole('banner')).toContainText('Road Sage');
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();

    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);

    if (metrics.innerWidth < 1280) {
      await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
    } else {
      await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    }
  });
}

test('renders Saved Road Speeds premium visuals as separate live controls without overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      dark_mode: 'light',
      premium_visual_experience: true,
    }));
  }, onboardedSettings);

  await page.goto('/speed-limits');

  await expect(page.getByRole('heading', { name: 'Saved road speeds' })).toBeVisible();
  const premiumPage = page.locator('.premium-saved-roads');
  await expect(premiumPage).toBeVisible();
  await expect(premiumPage.locator('.premium-speed-workspace')).toHaveCount(3);
  await expect(premiumPage.locator('.premium-speed-map-hero')).toBeVisible();
  await expect(premiumPage.getByRole('button', { name: /Add road speed/ })).toBeVisible();
  await expect(premiumPage.getByRole('searchbox', { name: 'Search map by road, source, or speed' })).toBeVisible();

  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.premium-speed-workspace')]
      .map((element) => element.getBoundingClientRect())
      .map(({ left, top, width, height }) => ({ left, top, width, height }));
    return {
      controls,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(layout.controls).toHaveLength(3);
  expect(layout.controls.every(({ width, height }) => width > 0 && height >= 44)).toBe(true);
  expect(new Set(layout.controls.map(({ left, top }) => `${left}:${top}`)).size).toBe(3);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
});

test('keeps the established Saved Road Speeds workspace when premium visuals are off', async ({ page }) => {
  await page.goto('/speed-limits');

  await expect(page.getByRole('heading', { name: 'Saved road speeds' })).toBeVisible();
  await expect(page.locator('.premium-saved-roads')).toHaveCount(0);
  const workspace = page.getByRole('navigation', { name: 'Saved road speed workspace' });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole('button')).toHaveCount(3);
});

test('surfaces hidden features through grouped nav and app search', async ({ page }) => {
  await page.goto('/');

  const metrics = await page.evaluate(() => ({ innerWidth: window.innerWidth }));
  if (metrics.innerWidth >= 1280) {
    const primaryNav = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(primaryNav).toContainText('Today');
    await expect(primaryNav).toContainText('Drive');
    await expect(primaryNav).toContainText('Review');
    await expect(primaryNav).toContainText('Settings');

    await page.getByRole('button', { name: 'Review navigation' }).click();
    await expect(page.getByRole('menuitem', { name: /Milestones/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /3D Replay/ })).toBeVisible();
    await page.keyboard.press('Escape');
  }

  await page.getByRole('button', { name: 'Search app' }).click();
  await page.getByPlaceholder('Search trips, reports, settings, vehicles, speed rules...').fill('speed rules');
  await page.getByRole('option', { name: /Speed rules/ }).click();
  await expect(page).toHaveURL(/\/speed-limits$/);
  await expect(page.getByRole('heading', { name: /Saved Road Speeds/i })).toBeVisible();
});

test('uses a driver-focused tracking shell without overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/');

  await expect(page).toHaveURL(/\/tracking$/);

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: 'Track your next drive', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start tracking', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tracking shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What your recent tracking data can tell you', exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const main = document.querySelector('#main-content');
    const mainRect = main?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mainWidth: mainRect?.width || 0,
      mainMaxWidth: main ? window.getComputedStyle(main).maxWidth : '',
    };
  });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
  expect(metrics.mainWidth).toBeGreaterThan(metrics.innerWidth * 0.72);

  if (metrics.innerWidth >= 768) {
    const nav = page.getByRole('navigation', { name: 'Trip tracking navigation' });
    await expect(nav).toBeVisible();
    for (const section of ['Track now', 'Trips & routes', 'Driving details', 'Manage']) {
      await expect(nav.getByText(section, { exact: true })).toBeVisible();
    }
    for (const label of ['Live tracking', 'Record a drive', 'My trips', 'Route map', 'Compare drives', 'Drive events', 'Driving alerts', 'Data quality', 'Road speeds', 'Trip privacy', 'Share & export', 'Tracking settings']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
  } else {
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tracking navigation menu' });
    await expect(dialog).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(nav).toBeVisible();
    await expect(nav).not.toHaveCSS('position', 'fixed');
    for (const section of ['Track now', 'Trips & routes', 'Driving details', 'Manage']) {
      await expect(nav.getByText(section, { exact: true })).toBeVisible();
    }
    for (const label of ['Live tracking', 'Record a drive', 'My trips', 'Route map', 'Compare drives', 'Drive events', 'Driving alerts', 'Data quality', 'Road speeds', 'Trip privacy', 'Share & export', 'Tracking settings']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await dialog.getByRole('button', { name: 'Close navigation menu' }).click();
  }

  await page.goto('/trips');
  await expect(page.getByRole('heading', { name: /Trip telemetry|My Tracked Trips/, exact: true })).toBeVisible();
  await expect(page.getByText(/No driver grades or rankings are shown here/i)).toBeVisible();
  await expect(page.getByText('Best Score', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Search app' }).click();
  await page.getByPlaceholder('Search tracking, trips, map, events, speed, privacy...').fill('privacy');
  await page.getByRole('option', { name: /Trip privacy/ }).click();
  await expect(page).toHaveURL(/\/tracking\/privacy$/);
});

test('renders tracking map workspace without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/map');

  await expect(page.getByRole('heading', { name: 'Route Map', exact: true })).toBeVisible();
  await expect(page.getByText('Choose a trip', { exact: true })).toBeVisible();
  await expect(page.getByText('Route details', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map workspace timeline' })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders tracking replay pro compare workflow without horizontal overflow', async ({ page }) => {
  const trips = [
    buildReplayTrip('replay-a', 0, 0),
    buildReplayTrip('replay-b', 0.00003, 30),
  ];
  await page.addInitScript(({ settings, tripRecords }) => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: undefined,
    });
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
    localStorage.setItem('drivesense_trips', JSON.stringify(tripRecords));
  }, { settings: onboardedSettings, tripRecords: trips });

  await page.goto('/tracking/replay');

  await expect(page.getByRole('heading', { name: 'Compare Drive Replays', exact: true })).toBeVisible();
  await expect(page.getByText('Morning Route A')).toBeVisible();
  await expect(page.getByText('Morning Route B')).toBeVisible();
  await expect(page.getByText('Speed timeline overlay', { exact: true })).toBeVisible();
  await expect(page.getByText('3D Replay Event Chapters', { exact: true })).toBeVisible();
  await expect(page.getByText(/Same or similar route|Route geometry differs/)).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders tracking events workspace without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/events');

  await expect(page.getByRole('heading', { name: 'Drive Event Timeline', exact: true })).toBeVisible();
  await expect(page.getByText('Recorded events', { exact: true })).toBeVisible();
  await expect(page.getByText('Event details', { exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders tracking speed console without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/speed');

  await expect(page.getByRole('heading', { name: 'Speed Intelligence', exact: true })).toBeVisible();
  await expect(page.getByText('Source Confidence', { exact: true })).toBeVisible();
  await expect(page.getByText('Trip Coverage', { exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders driving alerts without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/alerts');

  await expect(page.getByRole('heading', { name: 'Driving Alerts', exact: true })).toBeVisible();
  await expect(page.getByText('Speed Tier Cooldowns', { exact: true })).toBeVisible();
  await expect(page.getByText('Ownership Rules', { exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders tracking evidence console without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/evidence');

  await expect(page.getByRole('heading', { name: 'Data Quality', exact: true })).toBeVisible();
  await expect(page.getByText('Evidence Rows', { exact: true })).toBeVisible();
  await expect(page.getByText('Measurement details', { exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders trip sharing and exports without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/reports');

  await expect(page.getByRole('heading', { name: 'Share and Export Trips', exact: true })).toBeVisible();
  await expect(page.getByText('Export options', { exact: true })).toBeVisible();
  await expect(page.getByText('Export details', { exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});

test('renders tracking privacy console without horizontal overflow', async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify({
      ...settings,
      experience_mode: 'tracking',
    }));
  }, onboardedSettings);

  await page.goto('/tracking/privacy');

  await expect(page.getByRole('heading', { name: 'Trip Privacy', exact: true })).toBeVisible();
  await expect(page.getByText('Privacy Zones', { exact: true })).toBeVisible();
  await expect(page.getByText('Outbound Road Data', { exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainMaxWidth: window.getComputedStyle(document.querySelector('#main-content')).maxWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.mainMaxWidth).toBe('none');
});
