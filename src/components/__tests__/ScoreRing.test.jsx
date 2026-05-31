import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ScoreRing from '@/components/ScoreRing';

vi.mock('framer-motion', () => ({
  motion: {
    circle: ({ children, ...props }) => <circle {...props}>{children}</circle>,
    span: ({ children, ...props }) => <span {...props}>{children}</span>,
  },
}));

describe('ScoreRing evidence styles', () => {
  it('renders unavailable evidence as a grey withheld ring', () => {
    const html = renderToStaticMarkup(<ScoreRing score={null} evidence="unavailable" animated={false} />);

    expect(html).toContain('data-evidence="unavailable"');
    expect(html).toContain('stroke-dasharray="2 5"');
    expect(html).toContain('text-muted-foreground');
    expect(html).toContain('>-</span>');
    expect(html).not.toContain('stroke-dasharray="5 4"');
  });

  it('renders low and limited evidence with dashed rings', () => {
    const low = renderToStaticMarkup(<ScoreRing score={74} evidence="low" animated={false} />);
    const developing = renderToStaticMarkup(<ScoreRing score={74} evidence="developing" animated={false} />);

    expect(low).toContain('stroke-dasharray="5 4"');
    expect(low).toContain('>~74</span>');
    expect(developing).toContain('stroke-dasharray="5 4"');
    expect(developing).toContain('limited evidence');
    expect(developing).not.toContain('developing evidence');
  });

  it('renders high-confidence scores as provisional estimates', () => {
    const html = renderToStaticMarkup(<ScoreRing score={74} evidence="high" animated={false} />);

    expect(html).toContain('data-evidence="high"');
    expect(html).toContain('stroke-dasharray="5 4"');
    expect(html).toContain('>~74</span>');
    expect(html).not.toContain('high evidence');
  });

  it('uses score provenance to remove provisional marking after calibration', () => {
    const html = renderToStaticMarkup(
      <ScoreRing score={74} evidence="high" animated={false} scoreProvenance={{ calibration_status: 'calibrated' }} />
    );

    expect(html).toContain('>74</span>');
    expect(html).not.toContain('>~74</span>');
  });
});
