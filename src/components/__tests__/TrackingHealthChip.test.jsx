import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TrackingHealthChip } from '@/components/TrackingHealthChip';

const grantedPermissions = {
  backgroundLocation: 'granted',
  activityRecognition: 'granted',
  batteryOptimizationIgnored: true,
};

describe('TrackingHealthChip', () => {
  it('stays hidden outside background auto mode', () => {
    const html = renderToStaticMarkup(
      <TrackingHealthChip
        nativeStatus={{ enabled: false }}
        permissions={{}}
        trackingMode="manual"
      />
    );

    expect(html).toBe('');
  });

  it('stays hidden when background auto tracking is healthy', () => {
    const html = renderToStaticMarkup(
      <TrackingHealthChip
        nativeStatus={{ enabled: true }}
        permissions={grantedPermissions}
        trackingMode="background_auto"
      />
    );

    expect(html).toBe('');
  });

  it('shows the first degraded background auto problem', () => {
    const html = renderToStaticMarkup(
      <TrackingHealthChip
        nativeStatus={{ running: false }}
        permissions={grantedPermissions}
        trackingMode="background_auto"
      />
    );

    expect(html).toContain('Tracking degraded');
    expect(html).toContain('service not running');
  });

  it('reports permission degradation before battery degradation', () => {
    const html = renderToStaticMarkup(
      <TrackingHealthChip
        nativeStatus={{ running: true }}
        permissions={{
          backgroundLocation: 'granted',
          activityRecognition: 'denied',
          batteryOptimizationIgnored: false,
        }}
        trackingMode="background_auto"
      />
    );

    expect(html).toContain('activity permission missing');
    expect(html).not.toContain('battery restricted');
  });
});
