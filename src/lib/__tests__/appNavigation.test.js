import { describe, expect, it } from 'vitest';
import {
  createInitialAppUrlConsumer,
  pathForNotificationExtra,
  pathFromAppUrl,
} from '@/lib/appNavigation';

describe('app navigation handoffs', () => {
  it('routes native trip deep links to the completed trip', () => {
    expect(pathFromAppUrl('drivesense://trips/trip%20123')).toBe('/trips/trip%20123');
    expect(pathFromAppUrl('drivesense://settings')).toBe('/settings');
    expect(pathFromAppUrl('drivesense://parking/verify')).toBe('/parking?action=verify');
    expect(pathFromAppUrl('drivesense://parking/save')).toBe('/parking?action=save');
    expect(pathFromAppUrl('drivesense://parking/history')).toBe('/parking?action=history');
    expect(pathFromAppUrl('drivesense://parking/reminder')).toBe('/parking?action=reminder');
    expect(pathFromAppUrl('drivesense://parking/found')).toBe('/parking?action=found');
    expect(pathFromAppUrl('drivesense://parking')).toBe('/parking');
    expect(pathFromAppUrl('https://example.com/trips/1')).toBeNull();
  });

  it('routes notification types to their useful destination', () => {
    expect(pathForNotificationExtra({ tripId: 'abc/123', type: 'trip_completed_basic' }))
      .toBe('/trips/abc%2F123');
    expect(pathForNotificationExtra({ type: 'weekly_report' })).toBe('/reports');
    expect(pathForNotificationExtra({ type: 'weekly_pattern' })).toBe('/insights');
    expect(pathForNotificationExtra({ type: 'achievement_batch' })).toBe('/achievements');
    expect(pathForNotificationExtra({ type: 'maintenance' })).toBe('/vehicles');
    expect(pathForNotificationExtra({ type: 'parking_reminder' })).toBe('/parking');
    expect(pathForNotificationExtra({ type: 'parking_review' })).toBe('/parking');
  });

  it('consumes a cold-start widget URL once without locking later app navigation', () => {
    const consume = createInitialAppUrlConsumer();

    expect(consume('drivesense://parking/history')).toBe('/parking?action=history');
    expect(consume('drivesense://parking/history')).toBeNull();
    expect(consume('drivesense://parking/reminder')).toBe('/parking?action=reminder');
  });
});
