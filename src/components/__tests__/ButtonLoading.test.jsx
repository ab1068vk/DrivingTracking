import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';

describe('Button loading contract', () => {
  it('disables repeat activation and announces busy state', () => {
    const html = renderToStaticMarkup(
      <Button loading loadingText="Saving trip...">Save trip</Button>
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-loading="true"');
    expect(html).toContain('Saving trip...');
    expect(html).not.toContain('>Save trip<');
  });

  it('keeps a linked button to one child and blocks activation while loading', () => {
    const html = renderToStaticMarkup(
      <Button asChild loading loadingText="Loading trip...">
        <a href="/trips/one">Open trip</a>
      </Button>
    );

    expect(html).toContain('href="/trips/one"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading trip...');
    expect(html).not.toContain('>Open trip<');
  });
});
