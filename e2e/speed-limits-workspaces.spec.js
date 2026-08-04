import { expect, test } from '@playwright/test';
import { LEGAL_NOTICE_ACK_VERSION } from '../src/lib/legalDisclaimers.js';

// Safety net for splitting SpeedLimits.jsx into per-workspace components.
//
// A unit render test cannot cover this page: `loading` starts true and only
// flips inside an effect, so renderToStaticMarkup always returns the loading
// skeleton and never reaches the workspace JSX. A real browser is the only
// place these three blocks render at all.
//
// Before this spec, only the default workspace had any coverage — the `map`
// and `review` blocks, which are the riskiest to extract, had none.

const onboardedSettings = {
  onboarding_completed: true,
  legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
  legal_notice_acknowledged_at: '2026-06-07T00:00:00.000Z',
  experience_mode: 'coaching',
  tracking_mode: 'manual',
  dark_mode: 'system',
  units: 'metric',
};

const seedSettings = async (page) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
  }, onboardedSettings);
};

const expectNoHorizontalOverflow = async (page) => {
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
};

const WORKSPACES = [
  { view: 'saved', tab: 'Saved roads' },
  { view: 'review', tab: 'Needs review' },
  { view: 'map', tab: 'Map' },
];

test.describe('SpeedLimits workspaces', () => {
  test.beforeEach(async ({ page }) => {
    await seedSettings(page);
  });

  for (const { view, tab } of WORKSPACES) {
    test(`deep-links to the ${view} workspace and renders it without overflow`, async ({ page }) => {
      await page.goto(`/speed-limits?view=${view}`);

      // Page shell resolved past the loading skeleton.
      await expect(page.getByRole('heading', { name: /Saved road speeds/i })).toBeVisible();

      const nav = page.getByRole('navigation', { name: 'Saved road speed workspace' });
      await expect(nav).toBeVisible();

      // The deep link selected the right tab, not just any tab.
      await expect(nav.getByRole('button', { name: new RegExp(tab, 'i') })).toHaveAttribute('aria-pressed', 'true');

      await expectNoHorizontalOverflow(page);
    });
  }

  test('switches workspaces by tab click and keeps each one mounted', async ({ page }) => {
    await page.goto('/speed-limits?view=saved');
    await expect(page.getByRole('heading', { name: /Saved road speeds/i })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Saved road speed workspace' });

    for (const { tab } of WORKSPACES) {
      const button = nav.getByRole('button', { name: new RegExp(tab, 'i') });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expectNoHorizontalOverflow(page);
    }
  });

  test('renders all three workspace tabs exactly once', async ({ page }) => {
    await page.goto('/speed-limits');

    const nav = page.getByRole('navigation', { name: 'Saved road speed workspace' });
    await expect(nav.getByRole('button')).toHaveCount(3);
  });
});
