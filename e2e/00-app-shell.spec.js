import { expect, test } from '@playwright/test';
import {
  clearAllStorage,
  gasVehicle,
  resetAndSeed,
  safeTrip,
} from './fixtures/seedRoadSage.js';
import { globalAssert, installGlobalAssert } from './helpers/globalAssert.js';

test.beforeEach(async ({ page }) => {
  installGlobalAssert(page);
  await clearAllStorage(page);
});

test.afterEach(async ({ page }) => {
  await globalAssert(page);
});

test('fresh launch shows onboarding when onboarding is incomplete', async ({ page }) => {
  await resetAndSeed(page, {
    settings: { onboarding_completed: false },
  });
  await page.evaluate(() => {
    localStorage.setItem('road_sage_first_launch_permission_prompted', JSON.stringify(true));
  });

  await page.goto('/?fresh-onboarding=1');

  await expect(page.getByRole('heading', { name: /Welcome to Road Sage|Road Sage/i })).toBeVisible();
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('post-onboarding launch renders the dashboard shell', async ({ page }) => {
  await resetAndSeed(page, {
    trips: [safeTrip],
    vehicles: [gasVehicle],
  });

  await page.goto('/');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/Ready to drive\?|Tracking is paused|setup item.*need attention|Recent Trips|Driving Score/i).first()).toBeVisible();
});

test('dashboard shows ready label only when readiness checks pass', async ({ page }) => {
  await page.context().grantPermissions(['geolocation'], {
    origin: 'http://127.0.0.1:4173',
  });
  await resetAndSeed(page, {
    settings: {
      tracking_mode: 'manual',
      tracking_paused: false,
      location_permission_granted: true,
    },
  });

  await page.goto('/');

  await expect(page.getByText('Ready to drive?', { exact: true })).toBeVisible();
  await expect(page.getByText(/setup item.*need attention/i)).not.toBeVisible();
});

test('dashboard shows paused label when tracking is paused', async ({ page }) => {
  await resetAndSeed(page, {
    settings: {
      tracking_mode: 'manual',
      tracking_paused: true,
      location_permission_granted: true,
    },
  });

  await page.goto('/');

  await expect(page.getByText('Tracking is paused', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready to drive?', { exact: true })).not.toBeVisible();
});

test('dashboard shows blocked label when location permission is denied', async ({ page }) => {
  await resetAndSeed(page, {
    settings: {
      tracking_mode: 'manual',
      tracking_paused: false,
      location_permission_granted: false,
    },
  });

  await page.goto('/');

  await expect(page.getByText('1 setup item needs attention', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready to drive?', { exact: true })).not.toBeVisible();
});

test('desktop navigation reaches every primary route', async ({ page }) => {
  await resetAndSeed(page, {
    trips: [safeTrip],
    vehicles: [gasVehicle],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const routes = [
    { label: 'Dashboard', url: /\/$/, heading: /Dashboard/i },
    { label: 'Trips', url: /\/trips$/, heading: /Trip History/i },
    { label: 'Map', url: /\/map$/, heading: /Map/i },
    { label: 'Coach', url: /\/coach$/, heading: /Coach/i },
    { label: 'Insights', url: /\/insights$/, heading: /Insights/i },
    { label: 'Reports', url: /\/reports$/, heading: /Reports/i },
    { label: 'Vehicles', url: /\/vehicles$/, heading: /Vehicles/i },
    { label: 'Settings', url: /\/settings$/, heading: /Settings/i },
  ];

  for (const route of routes) {
    await page.getByRole('link', { name: route.label, exact: true }).click();
    await expect(page).toHaveURL(route.url);
    await expect(page.getByRole('heading', { name: route.heading }).first()).toBeVisible();
  }
});

test('mobile navigation drawer exposes primary routes without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetAndSeed(page, {
    trips: [safeTrip],
    vehicles: [gasVehicle],
  });
  await page.goto('/');

  await page.getByLabel('Open navigation menu').evaluate((button) => button.click());
  for (const label of ['Dashboard', 'Trips', 'Map', 'Coach', 'Insights', 'Reports', 'Vehicles', 'Settings']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
});

test('unknown route shows a 404 with a home link', async ({ page }) => {
  await resetAndSeed(page);

  await page.goto('/does-not-exist');

  await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
  await page.getByRole('link', { name: /Back to Dashboard/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('browser back navigation returns through trip detail and history', async ({ page }) => {
  await resetAndSeed(page, {
    trips: [safeTrip],
    vehicles: [gasVehicle],
  });

  await page.goto('/');
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trip History' })).toBeVisible();

  await page.getByText(/Smooth morning commute|Toyota Camry|May/i).first().click();
  await expect(page).toHaveURL(/\/trips\/trip-safe-001$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/trips$/);
  await expect(page.getByRole('heading', { name: 'Trip History' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('rendered shell has no unsafe inline or external CDN scripts', async ({ page }) => {
  await resetAndSeed(page);

  await page.goto('/');

  const scripts = await page.locator('script').evaluateAll((nodes) => nodes.map((node) => ({
    src: node.getAttribute('src') || '',
    content: node.textContent || '',
  })));
  expect(scripts.some((script) => /unsafe-inline/i.test(script.content))).toBe(false);
  expect(scripts.some((script) => /^https:\/\/cdn\./i.test(script.src))).toBe(false);
});

test('biometric route guard does not block settings when disabled', async ({ page }) => {
  await resetAndSeed(page, {
    settings: { biometric_lock_enabled: false },
  });

  await page.goto('/settings');

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByPlaceholder(/Search settings/i)).toBeVisible();
});
