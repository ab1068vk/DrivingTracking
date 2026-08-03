import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RoadSpeedCommandCenter, { buildRoadSpeedCommandState } from '@/components/RoadSpeedCommandCenter';

describe('buildRoadSpeedCommandState', () => {
  it('prioritizes captured camera evidence over road conflicts', () => {
    expect(buildRoadSpeedCommandState({ cameraCount: 2, reviewCount: 8 })).toMatchObject({
      action: 'review',
      title: '2 captured signs waiting for you',
    });
  });

  it('gives a useful first action instead of an all-zero dashboard', () => {
    expect(buildRoadSpeedCommandState()).toMatchObject({
      action: 'map',
      title: 'Road Memory is ready to learn',
    });
  });

  it('shows automatic learning without asking the user to save every road', () => {
    expect(buildRoadSpeedCommandState({ learningCount: 9 })).toMatchObject({
      action: 'review',
      title: '9 road corridors being learned',
    });
  });
});

describe('RoadSpeedCommandCenter', () => {
  it('shows the complete confirm-and-apply workflow', () => {
    const html = renderToStaticMarkup(
      <RoadSpeedCommandCenter
        savedCount={12}
        postedCount={7}
        estimatedCount={5}
        learningCount={4}
        reviewCount={3}
        onAdd={vi.fn()}
        onOpenMap={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
    );

    expect(html).toContain('3 road sections need review');
    expect(html).toContain('Capture');
    expect(html).toContain('Verify');
    expect(html).toContain('Trusted rules update');
    expect(html).toContain('Learning roads');
    expect(html).toContain('Pending evidence changes nothing.');
  });
});
