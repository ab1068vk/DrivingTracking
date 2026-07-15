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

  const settingsLink = page.getByRole('link', { name: /Settings/ });
  if (await settingsLink.first().isVisible()) {
    await settingsLink.first().click();
  } else if (await page.getByRole('button', { name: 'Settings navigation' }).isVisible()) {
    await page.getByRole('button', { name: 'Settings navigation' }).click();
    await page.getByRole('menu')
      .getByRole('menuitem', { name: /^Settings$/ })
      .click();
  } else {
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('dialog', { name: 'Navigation menu' })
      .getByRole('link', { name: /Settings/ })
      .click();
  }
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByPlaceholder(/Search settings/).fill('OSRM');
  await expect(page.getByRole('button', { name: /OSRM timeout and endpoint.*Speed & Road Data/i })).toBeVisible();
});

test('keeps destructive settings dialogs responsive in cyber mode', async ({ page }) => {
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem('drivesense_settings') || '{}');
    localStorage.setItem('drivesense_settings', JSON.stringify({ ...settings, dark_mode: 'cyber' }));
  });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByPlaceholder(/Search settings/).fill('delete all trips');
  await page.getByRole('button', { name: /Delete All Trips.*Privacy & Data/i }).click();

  const deleteRow = page.getByRole('button', { name: /Delete All Trips.*Permanently removes all trip data/i });
  await deleteRow.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Delete all trips?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('position', 'fixed');
  const dialogBox = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 1);

  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Delete trips' });
  expect((await cancel.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect((await confirm.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await cancel.dblclick();
  await expect(dialog).toBeHidden();
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

test('keeps the app shell visible and reports progress during a delayed route change', async ({ page }) => {
  await page.route('**/assets/Settings-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const feedback = page.locator('.app-interaction-feedback');
  const settingsLinks = page.getByRole('link', { name: /Settings/ });
  if (await settingsLinks.first().isVisible()) {
    await settingsLinks.first().click();
  } else if (await page.getByRole('button', { name: 'Settings navigation' }).isVisible()) {
    await page.getByRole('button', { name: 'Settings navigation' }).click();
    await page.getByRole('menu')
      .getByRole('menuitem', { name: /^Settings$/ })
      .click();
  } else {
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('dialog', { name: 'Navigation menu' })
      .getByRole('link', { name: /Settings/ })
      .click();
  }

  await expect(page.getByRole('banner')).toContainText('Road Sage');
  await expect(page.getByRole('main')).toContainText('Loading settings');
  await expect(feedback).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(feedback).toHaveAttribute('data-active', 'false');
});

test('keeps mobile navigation responsive while a route is loading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/assets/Settings-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('dialog', { name: 'Navigation menu' })
    .getByRole('link', { name: /Settings/ })
    .click();

  const feedback = page.locator('.app-interaction-feedback');
  await expect(page.getByRole('main')).toContainText('Loading settings');
  await expect(feedback).toHaveAttribute('data-active', 'true');

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const dialog = page.getByRole('dialog', { name: 'Navigation menu' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-mobile-navigation-open', 'true');
  await expect(feedback.locator('.app-interaction-feedback__bar')).toHaveCSS('animation-play-state', 'paused');
  await dialog.getByRole('button', { name: 'Close navigation menu' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(feedback).toHaveAttribute('data-active', 'false');
});
