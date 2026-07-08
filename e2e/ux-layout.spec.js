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
