import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The section reads the encrypted knowledge store on mount. Effects do not run
// under renderToStaticMarkup, but the module graph is still imported, so the
// storage layer is stubbed rather than pulled in for a markup assertion.
vi.mock('@/lib/localSpeedKnowledge', () => ({
  LocalSpeedKnowledge: class {
    async exportData() { return { corrections: [], cells: {}, roadMemory: { candidates: [] } }; }
  },
  SPEED_KNOWLEDGE_CHANGED_EVENT: 'speed-knowledge-changed',
}));

vi.mock('@/lib/speedKnowledgeRepository', () => ({
  speedKnowledgeStore: {},
  getNativeSpeedKnowledgeMirrorStatus: () => ({ state: 'synced', syncedAt: 0, error: '' }),
  retryNativeSpeedKnowledgeMirror: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => false }));

import SavedRoadSpeedsSection from '@/components/settings/SavedRoadSpeedsSection';

const render = (cfg) => renderToStaticMarkup(
  <SavedRoadSpeedsSection cfg={cfg} updateCfg={vi.fn()} onManageSavedSpeeds={vi.fn()} />
);

describe('Saved road speeds settings section', () => {
  it('shows the metric ladder by default, never mph', () => {
    // The learner snapping onto the wrong ladder is what turned 35 mph roads
    // into 60 km/h, so which ladder is active has to be visible — and metric is
    // the default for a driver who has not chosen otherwise.
    const html = render({});

    expect(html).toContain('rungs: 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130 km/h');
    expect(html).not.toContain('rungs: 25, 30, 35');
  });

  it('shows whole mph rungs once units are imperial', () => {
    // The mph ladder exists because snapping 35 mph onto the metric rungs
    // learned it as 60 km/h. The rungs must read as whole mph, not converted
    // km/h values.
    const html = render({ units: 'imperial' });

    expect(html).toContain('rungs: 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75 mph');
    expect(html).not.toContain('rungs: 30, 40, 50');
  });

  it('falls back to the shared defaults when the alert settings are unset', () => {
    const html = render({});

    expect(html).toContain('0.55');
    expect(html).toContain('5s');
  });

  it('reflects the driver values rather than the defaults once set', () => {
    const html = render({
      speed_alert_min_confidence: 0.8,
      speed_alert_sustained_s: 12,
      speed_knowledge_retention_days: 365,
    });

    expect(html).toContain('0.80');
    expect(html).toContain('12s');
    expect(html).toContain('Currently 365 days');
  });

  it('says learning is paused rather than implying saved speeds stopped working', () => {
    const html = render({ road_memory_learning_enabled: false });

    expect(html).toContain('Paused');
    expect(html).toContain('still resolve, score and alert as normal');
  });

  it('does not claim an empty store before the first read completes', () => {
    // "0 rules" on a store that has simply not been read yet reads as data loss.
    const html = render({});

    expect(html).toContain('Reading…');
    expect(html).not.toContain('0 rules');
  });

  it('hides the Android background-copy row on other platforms', () => {
    expect(render({})).not.toContain('Background copy for closed-app trips');
  });
});
