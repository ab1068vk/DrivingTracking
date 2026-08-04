import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PremiumMapControls from '@/components/PremiumMapControls';

const actions = () => ({
  onShowMap: vi.fn(),
  onShowPlayback: vi.fn(),
  onToggleLayers: vi.fn(),
});

describe('PremiumMapControls', () => {
  it('renders every existing map control with its semantic artwork and state', () => {
    const html = renderToStaticMarkup(
      <PremiumMapControls playbackMode={false} showLayerPanel {...actions()} />,
    );

    expect(html).toContain('class="premium-map-controls"');
    expect(html).toContain('aria-label="Map view controls"');
    expect(html.match(/data-map-tab="mode"/g)).toHaveLength(2);
    expect(html.match(/data-map-tab="utility"/g)).toHaveLength(1);
    expect(html).toContain('data-control="map" data-tone="navigation" data-map-tab="mode" aria-pressed="true"');
    expect(html).toContain('data-control="playback" data-tone="playback" data-map-tab="mode" aria-pressed="false"');
    expect(html).toContain('data-control="layers" data-tone="layers" data-map-tab="utility" aria-pressed="true"');
    expect(html).toContain('premium-map-control-view.webp');
    expect(html).toContain('premium-map-control-playback.webp');
    expect(html).toContain('premium-map-control-layers.webp');
    expect(html).toContain('Explore the map');
    expect(html).toContain('Replay route history');
    expect(html).toContain('Manage map overlays');
  });

  it('moves the pressed mode state to playback without changing the layer toggle', () => {
    const html = renderToStaticMarkup(
      <PremiumMapControls playbackMode showLayerPanel={false} {...actions()} />,
    );

    expect(html).toContain('data-control="map" data-tone="navigation" data-map-tab="mode" aria-pressed="false"');
    expect(html).toContain('data-control="playback" data-tone="playback" data-map-tab="mode" aria-pressed="true"');
    expect(html).toContain('data-control="layers" data-tone="layers" data-map-tab="utility" aria-pressed="false"');
  });
});
