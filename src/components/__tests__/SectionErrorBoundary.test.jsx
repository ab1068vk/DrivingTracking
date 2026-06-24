import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import MapErrorBoundary from '@/components/MapErrorBoundary';
import SectionErrorBoundary, { DefaultSectionErrorFallback } from '@/components/SectionErrorBoundary';
import { logError } from '@/lib/errorReporting';

vi.mock('@/lib/errorReporting', () => ({
  logError: vi.fn(),
}));

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.props?.children);
};

const findElement = (node, type) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  const children = node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, type);
      if (match) return match;
    }
  }
  return findElement(children, type);
};

const installSynchronousSetState = (component) => {
  component.setState = (update) => {
    const patch = typeof update === 'function'
      ? update(component.state, component.props)
      : update;
    component.state = { ...component.state, ...patch };
  };
};

describe('SectionErrorBoundary', () => {
  it('renders a friendly fallback with a reload action', () => {
    const onReload = vi.fn();
    const fallback = DefaultSectionErrorFallback({
      title: 'Something went wrong',
      message: 'Bad trip data prevented this section from rendering.',
      onReload,
    });

    expect(textOf(fallback)).toContain('Something went wrong');
    expect(textOf(fallback)).toContain('Bad trip data');

    const button = findElement(fallback, 'button');
    expect(button).toBeTruthy();
    expect(textOf(button)).toContain('Reload');
    button.props.onClick();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('logs caught render errors and swaps only the failed section to fallback UI', () => {
    const healthySection = <section>Recent trips still render</section>;
    const failedBoundary = new SectionErrorBoundary({
      children: <section>Explosive map</section>,
      context: 'trip_map',
      title: 'Map unavailable',
    });
    const healthyBoundary = new SectionErrorBoundary({ children: healthySection });
    const error = new Error('bad gps');

    failedBoundary.componentDidCatch(error, { componentStack: 'TripMapContent' });
    failedBoundary.state = SectionErrorBoundary.getDerivedStateFromError(error);

    const failedRender = failedBoundary.render();
    expect(failedRender.type).toBe(DefaultSectionErrorFallback);
    expect(failedRender.props.title).toBe('Map unavailable');
    expect(healthyBoundary.render()).toBe(healthySection);
    expect(logError).toHaveBeenCalledWith('trip_map', error, expect.objectContaining({
      component_stack: 'TripMapContent',
      section: 'trip_map',
    }));
  });

  it('keeps failed maps in fallback until an explicit retry', () => {
    const boundary = new MapErrorBoundary({
      children: <section>Map</section>,
      context: 'trip_map',
      resetKey: 'route-a',
    });
    installSynchronousSetState(boundary);

    const firstError = new Error('leaflet failed');
    boundary.state = { ...boundary.state, ...MapErrorBoundary.getDerivedStateFromError(firstError) };
    boundary.componentDidCatch(firstError, { componentStack: 'TripMapContent' });
    boundary.props = { ...boundary.props, resetKey: 'route-b' };

    expect(boundary.state.error).toBe(firstError);
    expect(boundary.state.retryNonce).toBe(0);
    expect(logError).toHaveBeenCalledWith('trip_map', firstError, expect.objectContaining({
      reset_key: 'route-a',
    }));

    boundary.retry();
    expect(boundary.state.error).toBeNull();
    expect(boundary.state.retryNonce).toBe(1);
  });
});
