import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const checkedFiles = [
  'src/pages/PrivacyIntelligence.jsx',
  'src/lib/privacyIntelligence.js',
  'src/lib/privacyReport.js',
  'src/lib/dataBackup.js',
  'src/lib/exportCommitment.js',
  'src/lib/exportIntegrity.js',
  'src/lib/pdfExport.js',
  'src/lib/ubiReport.js',
  'src/pages/Settings.jsx',
  'docs/PROJECT_README.md',
  'docs/README.md',
  'docs/PRIVACY_INTELLIGENCE.md',
];

const bannedWording = [
  { label: 'proves/prove', pattern: /\bproves?\b/i },
  { label: 'guarantee', pattern: /\bguarantee(?:s|d)?\b/i },
  { label: 'certification/certified claim', pattern: /\bcertifi(?:es|ed|cation|cations|y)\b/i },
  { label: 'tamper-proof', pattern: /\btamper-proof\b/i },
  { label: 'no data left the device', pattern: /\bno data left the device\b/i },
  { label: 'private route snapping', pattern: /\bprivate route snapping\b/i },
  { label: 'proof-of-safety paraphrase', pattern: /\bproof (?:of safety|that no sensitive data|no private data)\b/i },
  { label: 'proof-of-erasure', pattern: /\bproof-of-erasure\b/i },
  { label: 'positive third-party proof claim', pattern: /\b(?:as|is|are|provides?|gives?|offers?) third-party proof\b/i },
  { label: 'third-party-verifiable', pattern: /\bthird-party-verifiable\b/i },
  { label: 'authentic export claim', pattern: /\baccepted as authentic\b/i },
  { label: 'audit checkpoint overclaim', pattern: /\bprotects against later history rewrites\b/i },
];

function readProjectFile(relativePath) {
  return readFileSync(join(rootDir, relativePath), 'utf8');
}

describe('safe Privacy Intelligence wording', () => {
  it('keeps UI, report, README, and Privacy Intelligence docs free of overclaim wording', () => {
    const failures = [];
    for (const relativePath of checkedFiles) {
      const source = readProjectFile(relativePath);
      for (const banned of bannedWording) {
        if (banned.pattern.test(source)) {
          failures.push(`${relativePath}: ${banned.label}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps unknown protections visually and verbally distinct from ok protections', () => {
    const source = readProjectFile('src/pages/PrivacyIntelligence.jsx');
    const statusClassBlock = source.match(/const statusClass = \{([\s\S]*?)\};/)?.[1] || '';
    const statusLabelBlock = source.match(/const STATUS_LABELS = \{([\s\S]*?)\};/)?.[1] || '';
    const okClass = statusClassBlock.match(/ok:\s*'([^']+)'/)?.[1];
    const unknownClass = statusClassBlock.match(/unknown:\s*'([^']+)'/)?.[1];
    const okLabel = statusLabelBlock.match(/ok:\s*'([^']+)'/)?.[1];
    const unknownLabel = statusLabelBlock.match(/unknown:\s*'([^']+)'/)?.[1];

    expect(unknownClass).toBeTruthy();
    expect(okClass).toBeTruthy();
    expect(unknownClass).not.toBe(okClass);
    expect(unknownClass).not.toMatch(/emerald/i);
    expect(unknownLabel).toBe('Unverified');
    expect(unknownLabel).not.toBe(okLabel);
    expect(source).toContain('label="Unverified"');
    expect(source).toContain('unverified');
  });
});
