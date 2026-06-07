import { expect, test } from '@playwright/test';
import { LEGAL_NOTICE_ACK_VERSION } from '../src/lib/legalDisclaimers.js';

const onboardedSettings = {
  onboarding_completed: true,
  legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
  legal_notice_acknowledged_at: '2026-06-07T00:00:00.000Z',
  tracking_mode: 'manual',
  dark_mode: 'system',
  units: 'metric',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
  }, onboardedSettings);
});

test('navigates the core dashboard and settings flow', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/Tracking is ready|tracking setup/i)).toBeVisible();
  await expect(page.getByText('Why tracking did or did not start')).toBeVisible();

  await page.getByRole('link', { name: /Settings/ }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByPlaceholder(/Search settings/).fill('OSRM');
  await expect(page.getByRole('button', { name: /Advanced models.*Advanced/i })).toBeVisible();
});

test('opens empty trip history without leaving the app shell', async ({ page }) => {
  await page.goto('/trips');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: /Trip/i })).toBeVisible();
  await expect(page.getByText(/No trips|Start tracking|record/i).first()).toBeVisible();
});

test('opens reports export scope without mutating app data', async ({ page }) => {
  await page.goto('/reports');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.getByLabel('Report export package')).toContainText('Export package');
  await expect(page.getByText('Generated exports are presentation files only')).toBeVisible();
});

test('opens diagnostics recovery compatibility as read-only facts', async ({ page }) => {
  await page.goto('/diagnostics');

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('heading', { name: 'Tracking Diagnostics' })).toBeVisible();
  await expect(page.getByLabel('Recovery compatibility snapshot')).toContainText('Recovery Compatibility');
  await expect(page.getByLabel('Recovery compatibility snapshot')).toContainText('No writes');
});
