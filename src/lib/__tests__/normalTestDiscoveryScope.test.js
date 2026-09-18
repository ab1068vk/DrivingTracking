import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('normal Vitest discovery scope', () => {
  it('excludes retained historical and temporary review probes without excluding src tests', () => {
    const config = readFileSync(new URL('../../../vite.config.js', import.meta.url), 'utf8');

    expect(config).toContain("'agent-post-p7-audit/probes/**'");
    expect(config).toContain("'tmp/**'");
    expect(config).not.toMatch(/['"]src\/(?:\*\*|lib|components|pages|api)/);
  });
});
