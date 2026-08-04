import { expect, test } from '@playwright/test';
import { LEGAL_NOTICE_ACK_VERSION } from '../src/lib/legalDisclaimers.js';

test.skip(({ isMobile }) => isMobile, 'Detailed settings control interactions are covered on desktop; mobile layout is covered separately.');

const onboardedSettings = {
  onboarding_completed: true,
  legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
  legal_notice_acknowledged_at: '2026-06-07T00:00:00.000Z',
  tracking_mode: 'manual',
  dark_mode: 'system',
  units: 'metric',
  notifications_enabled: true,
  speed_limit_lookup_enabled: false,
  speed_warning_enabled: true,
  phone_use_detection_enabled: true,
  phone_use_sensitivity: 'medium',
  heightened_privacy_mode: true,
  request_obfuscation_enabled: true,
  data_retention_days: 365,
};

const openSettingsArea = async (page, name) => {
  await page.getByRole('button', { name: new RegExp(name, 'i') }).first().click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
};

const readSetting = (page, key) => page.evaluate((settingKey) => (
  JSON.parse(localStorage.getItem('drivesense_settings') || '{}')[settingKey]
), key);

const expectSetting = async (page, key, value) => {
  await expect.poll(() => readSetting(page, key)).toEqual(value);
};

const setRangeValue = async (locator, value) => {
  await locator.evaluate((input, nextValue) => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('drivesense_settings', JSON.stringify(settings));
  }, onboardedSettings);
  page.on('dialog', (dialog) => dialog.accept());
});

test('settings controls persist real settings instead of only moving UI state', async ({ page }) => {
  await page.goto('/settings');

  await openSettingsArea(page, 'Appearance');
  await page.getByRole('button', { name: /^Light$/ }).click();
  await expectSetting(page, 'dark_mode', 'light');
  await page.getByRole('button', { name: /Imperial/ }).click();
  await expectSetting(page, 'units', 'imperial');

  await openSettingsArea(page, 'Economics');
  await page.locator('[data-setting-label="Currency symbol"] select').selectOption('kr');
  await expectSetting(page, 'currencySymbol', 'kr');
  await page.locator('[data-setting-label="Average vehicle CO2 baseline"] input').fill('14.5');
  await expectSetting(page, 'co2_baseline_kg_per_100km', 14.5);

  await openSettingsArea(page, 'Notifications');
  await page.locator('[data-setting-label="Enable all notifications"]').getByRole('switch').click();
  await expectSetting(page, 'notifications_enabled', false);

  await openSettingsArea(page, 'Driving Goals');
  // Target the slider by label. `.first()` silently drifted onto
  // "Minimum qualifying trips" as sliders were added above it.
  await setRangeValue(page.locator('[data-setting-label="Max harsh brakes"] input[type="range"]'), 10);
  await expectSetting(page, 'weekly_goal_harsh_brakes', 10);

  await openSettingsArea(page, 'Night Window');
  await page.getByRole('button', { name: /Custom/ }).click();
  await expectSetting(page, 'night_detection_mode', 'custom');
  await page.locator('label', { hasText: 'Start' }).locator('input[type="time"]').fill('20:30');
  await expectSetting(page, 'night_start_time', '20:30');

  await openSettingsArea(page, 'Phone Use Detection');
  await page.getByRole('button', { name: /^High/ }).click();
  await expectSetting(page, 'phone_use_sensitivity', 'high');

  await openSettingsArea(page, 'Speed & Road Data');
  await page.locator('[data-setting-label="Speed limits from OpenStreetMap"]').getByRole('switch').click();
  await expectSetting(page, 'speed_limit_lookup_enabled', true);
  await page.locator('[data-setting-label="Fallback estimate country"] select').selectOption('ca');
  await expectSetting(page, 'country_code', 'CA');
  await expect.poll(() => readSetting(page, 'configurable_country_defaults')).toMatch(/^CA-/);
  await page.locator('[data-setting-label="Live speed check"]').getByRole('switch').click();
  await expectSetting(page, 'speed_warning_enabled', false);

  await openSettingsArea(page, 'Privacy & Data');
  await page.locator('[data-setting-label="Heightened privacy mode"]').getByRole('switch').click();
  await expectSetting(page, 'heightened_privacy_mode', false);
  await page.locator('[data-setting-label="Data Retention"] select').selectOption('90');
  await page.getByRole('button', { name: 'Save retention' }).click();
  await expectSetting(page, 'data_retention_days', 90);
});
