import { expect, test } from '@playwright/test';
import { clearAllStorage, resetAndSeed } from './fixtures/seedRoadSage.js';
import { globalAssert, installGlobalAssert } from './helpers/globalAssert.js';

const onboardedSettings = {
  onboarding_completed: true,
  tracking_mode: 'manual',
  dark_mode: 'system',
  units: 'metric',
};

test.beforeEach(async ({ page }) => {
  installGlobalAssert(page);
  await clearAllStorage(page);
  await resetAndSeed(page, { settings: onboardedSettings });
});

test.afterEach(async ({ page }) => {
  await globalAssert(page);
});

test('navigates the core dashboard and settings flow', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/^(Tracking is ready|Check tracking setup)$/i)).toBeVisible();

  await page.getByRole('link', { name: /Settings/ }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByPlaceholder(/Search settings/).fill('OSRM');
  await expect(page.getByRole('button', { name: /Advanced models.*OSRM/i })).toBeVisible();
});

test('opens empty trip history without leaving the app shell', async ({ page }) => {
  await page.goto('/trips');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: /Trip/i })).toBeVisible();
  await expect(page.getByText(/No trips|Start tracking|record/i).first()).toBeVisible();
});
