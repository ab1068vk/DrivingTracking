import { expect, test } from '@playwright/test';
import { LEGAL_NOTICE_ACK_VERSION } from '../src/lib/legalDisclaimers.js';

const tripAt = (id, daysAgo, score) => ({
  id,
  status: 'completed',
  start_time: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  distance_km: 12,
  duration_seconds: 1200,
  score_overall: score,
  score_safety: score,
  score_smoothness: score,
  score_eco: score,
  intersection_score: score,
  harsh_brakes_count: score < 80 ? 2 : 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  driving_events: [],
  route_key: 'insights-route',
  dominant_road_type: 'city',
});

test('organizes driving intelligence into summary, evidence, and history views', async ({ page }) => {
  const trips = [
    tripAt('current-1', 1, 78), tripAt('current-2', 2, 82),
    tripAt('prior-1', 35, 88), tripAt('prior-2', 36, 90),
  ];
  await page.addInitScript(({ tripRecords, noticeVersion }) => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    localStorage.setItem('drivesense_settings', JSON.stringify({
      onboarding_completed: true,
      legal_notice_ack_version: noticeVersion,
      legal_notice_acknowledged_at: new Date().toISOString(),
      tracking_mode: 'manual',
      units: 'metric',
    }));
    localStorage.setItem('drivesense_trips', JSON.stringify(tripRecords));
  }, { tripRecords: trips, noticeVersion: LEGAL_NOTICE_ACK_VERSION });

  await page.goto('/insights');
  await expect(page.getByRole('heading', { name: 'Driving Intelligence' })).toBeVisible();
  await expect(page.getByText('Priority insight')).toBeVisible();

  await page.getByRole('tab', { name: 'Explore evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Headline contribution ledger' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cited local answers' })).toBeVisible();

  await page.getByRole('tab', { name: 'History & tools' }).click();
  await expect(page.getByRole('heading', { name: 'Trip calendar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Phone use focus' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Weekly goals' })).toBeVisible();
});
