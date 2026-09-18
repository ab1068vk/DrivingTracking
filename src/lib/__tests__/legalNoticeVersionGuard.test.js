import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Proves the legal-version guard actually discriminates, rather than asserting a constant
 * equals itself. Each case mutates real source, runs the real script, and restores the bytes.
 */
const repoRoot = process.cwd();
const disclosurePath = path.join(repoRoot, 'src', 'lib', 'legalDisclaimers.js');
const generatedPath = path.join(repoRoot, 'src', 'lib', 'legalNoticeVersion.generated.js');
const scriptPath = path.join(repoRoot, 'scripts', 'generate-legal-version.mjs');

const original = {
  disclosure: readFileSync(disclosurePath, 'utf8'),
  generated: readFileSync(generatedPath, 'utf8'),
};

const restore = () => {
  writeFileSync(disclosurePath, original.disclosure);
  writeFileSync(generatedPath, original.generated);
};

const runScript = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
};

const runCheck = () => runScript(['--check']);
const runGenerate = () => runScript([]);

afterEach(restore);

describe('legal notice version guard', () => {
  it('passes against unmodified source', () => {
    expect(runCheck().ok).toBe(true);
  });

  it('fails when a data-practice sharing statement changes', () => {
    // Sharing is the highest-consequence disclosure: it says what leaves the device.
    const mutated = original.disclosure.replace(
      'Stored locally by default.',
      'Uploaded to our servers by default.',
    );
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);

    const result = runCheck();
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Raise LEGAL_NOTICE_ACK_VERSION');
  });

  it('fails when a key point is removed', () => {
    const mutated = original.disclosure.replace(
      /\s*'Do not use the app while driving\.',\r?\n/,
      '\n',
    );
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);
    expect(runCheck().ok).toBe(false);
  });

  it('fails when a disclaimer body is reworded', () => {
    const mutated = original.disclosure.replace(
      'Road Sage is for personal trip logging and self-coaching.',
      'Road Sage is a certified safety system.',
    );
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);
    expect(runCheck().ok).toBe(false);
  });

  it('fails when the acknowledgement version changes without regenerating', () => {
    const mutated = original.disclosure.replace(
      'export const LEGAL_NOTICE_ACK_VERSION = 9;',
      'export const LEGAL_NOTICE_ACK_VERSION = 10;',
    );
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);
    expect(runCheck().ok).toBe(false);
  });

  it('tolerates line-ending differences, which are representation and not meaning', () => {
    // Windows checkouts rewrite line endings; that must not demand re-acknowledgement.
    const mutated = original.disclosure.replace(/\n/g, '\r\n');
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);
    expect(runCheck().ok).toBe(true);
  });

  it('regenerates a new hash after a reconciled version bump', () => {
    const mutated = original.disclosure.replace(
      'export const LEGAL_NOTICE_ACK_VERSION = 9;',
      'export const LEGAL_NOTICE_ACK_VERSION = 10;',
    );
    writeFileSync(disclosurePath, mutated);
    expect(runGenerate().ok).toBe(true);

    const regenerated = readFileSync(generatedPath, 'utf8');
    expect(regenerated).toContain('LEGAL_NOTICE_HASHED_VERSION = 10');
    expect(regenerated).not.toBe(original.generated);
    expect(runCheck().ok).toBe(true);
  });

  it('REFUSES to rebind the same version to different content', () => {
    // The decisive case. Regenerating here would silently turn every content-bound
    // acknowledgement into content_mismatch, with no changelog explaining why.
    const mutated = original.disclosure.replace(
      'Do not use the app while driving.',
      'Do not use the app whilst driving.',
    );
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);

    const generated = runGenerate();
    expect(generated.ok).toBe(false);
    expect(generated.output).toContain('Refusing to rebind acknowledgement version 9');
    // The recorded hash must be untouched, so existing acknowledgements stay bound.
    expect(readFileSync(generatedPath, 'utf8')).toBe(original.generated);
  });

  it('treats a spelling correction as a canonical content change, not a free edit', () => {
    const mutated = original.disclosure.replace(
      'Do not use the app while driving.',
      'Do not use the app while drivng.',
    );
    expect(mutated).not.toBe(original.disclosure);
    writeFileSync(disclosurePath, mutated);
    expect(runCheck().ok).toBe(false);
    expect(runGenerate().ok).toBe(false);
  });

  it('ignores a representation-only change to the rendering layer', () => {
    // Styling lives outside the canonical content, so the dialog can be restyled freely.
    const dialogPath = path.join(repoRoot, 'src', 'components', 'LegalNoticeDialog.jsx');
    const dialogOriginal = readFileSync(dialogPath, 'utf8');
    try {
      writeFileSync(dialogPath, dialogOriginal.replace('rounded-2xl', 'rounded-3xl'));
      expect(runCheck().ok).toBe(true);
    } finally {
      writeFileSync(dialogPath, dialogOriginal);
    }
  });
});
