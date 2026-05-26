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
    expect(html).toContain('hsl(var(--muted-foreground))');
    expect(html).toContain('>-</span>');
  });

  it('renders low and limited evidence with dashed rings', () => {
    const low = renderToStaticMarkup(<ScoreRing score={74} evidence="low" animated={false} />);
    const developing = renderToStaticMarkup(<ScoreRing score={74} evidence="developing" animated={false} />);

    expect(low).toContain('stroke-dasharray="5 4"');
    expect(developing).toContain('stroke-dasharray="5 4"');
    expect(developing).toContain('limited evidence');
    expect(developing).not.toContain('developing evidence');
  });

  it('renders high-confidence scores with a solid score ring', () => {
    const html = renderToStaticMarkup(<ScoreRing score={74} evidence="high" animated={false} />);

    expect(html).toContain('data-evidence="high"');
    expect(html).not.toContain('stroke-dasharray="5 4"');
    expect(html).not.toContain('high evidence');
  });
});
