import { describe, expect, it, vi } from 'vitest';
import { Children } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumReadyToDriveCard, { buildTripLaunchStatus } from '@/components/PremiumReadyToDriveCard';

const actions = {
  onEnableBackgroundTracking: vi.fn(),
  onRefreshTrackingStatus: vi.fn(),
  onStartPrivateTrip: vi.fn(),
  onStartTrip: vi.fn(),
  onStartTripWithCamera: vi.fn(),
};

function findByClassName(node, className) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.className === className) return node;

  for (const child of Children.toArray(node.props?.children)) {
    const match = findByClassName(child, className);
    if (match) return match;
  }

  return null;
}

describe('buildTripLaunchStatus', () => {
  it('summarizes the live manual tracking checks', () => {
    const result = buildTripLaunchStatus({
      foregroundLocationReady: true,
      backgroundLocationReady: false,
      notificationsReady: true,
    });

    expect(result.readyCount).toBe(2);
    expect(result.totalCount).toBe(3);
    expect(result.isReady).toBe(false);
    expect(result.systems.map(({ id, ready }) => ({ id, ready }))).toEqual([
      { id: 'location', ready: true },
      { id: 'background', ready: false },
      { id: 'notifications', ready: true },
    ]);
  });

  it('reports ready only when every manual tracking check passes', () => {
    expect(buildTripLaunchStatus({
      foregroundLocationReady: true,
      backgroundLocationReady: true,
      notificationsReady: true,
    })).toMatchObject({ isReady: true, readyCount: 3, totalCount: 3 });
  });
});

describe('PremiumReadyToDriveCard', () => {
  it('renders the ready state with the original trip actions and labels', () => {
    const html = renderToStaticMarkup(
      <PremiumReadyToDriveCard {...actions} />,
    );

    expect(html).toContain('class="premium-ready-card"');
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('Ready to drive?');
    expect(html).toContain('Start a new trip');
    expect(html).toContain('Tap to begin tracking your route');
    expect(html).toContain('aria-label="Start trip"');
    expect(html).toContain('premium-ready-city-hero-v6.png');
    expect(html).toContain('premium-ready-start-generated-v1.png');
    expect(html).toContain('Start Private Trip');
    expect(html).not.toContain('Privacy mode');
    expect(html).toContain('premium-ready-private-v6.png');
    expect(html).toContain('premium-ready-private-shield-generated-v1.png');
    expect(html).toContain('premium-ready-private-control-generated-v1.png');
    expect(html).toContain('Save distance and duration only.');
    expect(html).toContain('No route, addresses, events, or score.');
    expect(html).not.toContain('Manual background setup needed');
  });

  it('keeps both visible launcher buttons wired to their real trip actions', () => {
    const onStartTrip = vi.fn();
    const onStartPrivateTrip = vi.fn();
    const tree = PremiumReadyToDriveCard({
      ...actions,
      onStartTrip,
      onStartPrivateTrip,
    });
    const startButton = findByClassName(tree, 'premium-ready-start');
    const privateButton = findByClassName(tree, 'premium-ready-private');

    expect(startButton?.type).toBe('button');
    expect(privateButton?.type).toBe('button');
    expect(startButton?.props.disabled).toBe(false);
    expect(privateButton?.props.disabled).toBe(false);

    startButton.props.onClick();
    privateButton.props.onClick();

    expect(onStartTrip).toHaveBeenCalledOnce();
    expect(onStartPrivateTrip).toHaveBeenCalledOnce();
  });

  it('renders real Android permission states and preserves setup controls', () => {
    const html = renderToStaticMarkup(
      <PremiumReadyToDriveCard
        {...actions}
        isAndroidManualMode
        foregroundLocationReady
        notificationsReady
      />,
    );

    expect(html).toContain('data-status="attention"');
    expect(html).toContain('2 of 3 checks ready');
    expect(html).toContain('Manual background setup needed');
    expect(html).toContain('Action required');
    expect(html).toContain('premium-ready-systems-v6.png');
    expect(html).toContain('Location</span><small>Ready');
    expect(html).toContain('Background</span><small>Needed');
    expect(html).toContain('Notifications</span><small>Ready');
    expect(html).toContain('Enable Background Tracking');
    expect(html).toContain('Refresh');
  });

  it('renders the protected manual state only when every live check is ready', () => {
    const html = renderToStaticMarkup(
      <PremiumReadyToDriveCard
        {...actions}
        isAndroidManualMode
        androidManualBackgroundReady
        foregroundLocationReady
        backgroundLocationReady
        notificationsReady
        speedSignScannerEnabled
      />,
    );

    expect(html).toContain('data-status="ready"');
    expect(html).toContain('3 of 3 checks ready');
    expect(html).toContain('Protected recording');
    expect(html).toContain('Manual trips will use Background GPS');
    expect(html).toContain('Start Trip + Camera');
    expect(html).not.toContain('Enable Background Tracking');
  });

  it('keeps the parked manual camera launcher available for setup and start', () => {
    const onStartTripWithCamera = vi.fn();
    const disabledTree = PremiumReadyToDriveCard({
      ...actions,
      isAndroidManualMode: true,
      onStartTripWithCamera,
    });
    const disabledButton = findByClassName(disabledTree, 'premium-ready-camera-start');

    expect(disabledButton.props.disabled).toBe(false);
    expect(disabledButton.props.children).toContain('Enable Sign Scan in Settings');
    disabledButton.props.onClick();

    const enabledTree = PremiumReadyToDriveCard({
      ...actions,
      isAndroidManualMode: true,
      onStartTripWithCamera,
      speedSignScannerEnabled: true,
    });
    const enabledButton = findByClassName(enabledTree, 'premium-ready-camera-start');

    expect(enabledButton.props.disabled).toBe(false);
    enabledButton.props.onClick();
    expect(onStartTripWithCamera).toHaveBeenCalledTimes(2);
  });

  it('keeps the start control accessible during its loading state', () => {
    const html = renderToStaticMarkup(
      <PremiumReadyToDriveCard {...actions} startingTrip />,
    );

    expect(html).toContain('aria-label="Starting trip"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Starting trip...');
    expect(html).toContain('disabled=""');
  });
});
