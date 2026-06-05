import { describe, expect, it, vi } from 'vitest';
import { buildPermissionMonitorIssues } from '../usePermissionMonitor';

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => true,
}));

describe('buildPermissionMonitorIssues', () => {
  it('stays quiet for manual tracking', () => {
    expect(buildPermissionMonitorIssues({
      trackingMode: 'manual',
      permissionStatus: {},
      batteryStatus: { batteryOptimizationIgnored: false },
    })).toEqual([]);
  });

  it('reports foreground auto tracking permission blockers', () => {
    const issues = buildPermissionMonitorIssues({
      trackingMode: 'auto_detect',
      permissionStatus: {
        foregroundLocation: 'denied',
        activityRecognition: 'not_requested',
      },
    });

    expect(issues.map((issue) => issue.id)).toEqual([
      'foregroundLocation',
      'activityRecognition',
    ]);
    expect(issues[0].fixHint).toContain('Location');
  });

  it('reports background-only requirements including battery optimization', () => {
    const issues = buildPermissionMonitorIssues({
      trackingMode: 'background_auto',
      permissionStatus: {
        foregroundLocation: 'granted',
        activityRecognition: 'granted',
        backgroundLocation: 'denied',
        notifications: 'denied',
      },
      batteryStatus: { batteryOptimizationIgnored: false },
    });

    expect(issues.map((issue) => issue.id)).toEqual([
      'backgroundLocation',
      'notifications',
      'batteryOptimization',
    ]);
  });
});
