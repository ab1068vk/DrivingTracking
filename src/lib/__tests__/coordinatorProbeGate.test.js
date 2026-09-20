import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The DPD-015B coordinator probe is diagnostic-only and must never reach a
 * build that did not explicitly ask for it.
 *
 * `android:sync` runs `vite build`, so `import.meta.env.DEV` is false in the
 * debug APK as well as the release one. A DEV-gated probe would therefore be
 * useless on device, and a DEV-or-flag gate would be easy to trip by accident.
 * The gate is a single explicit build-time flag, and these tests pin that.
 */
const source = readFileSync(resolve(process.cwd(), 'src/lib/appLifecycleWork.js'), 'utf8');

describe('DPD-015B coordinator probe is strictly opt-in', () => {
  it('is gated on the explicit flag and nothing else', () => {
    expect(source).toContain("import.meta.env.VITE_RS_COORDINATOR_PROBE === 'true'");
    // No DEV fallback: that would silently arm it in any dev-mode surface.
    expect(source).not.toMatch(/VITE_RS_COORDINATOR_PROBE[^\n]*import\.meta\.env\.DEV/);
    expect(source).not.toMatch(/import\.meta\.env\.DEV[^\n]*VITE_RS_COORDINATOR_PROBE/);
  });

  it('installs exactly one global and only inside the gate', () => {
    const installs = source.match(/globalThis\.__rsCoordinatorProbe\s*=/g) || [];
    expect(installs).toHaveLength(1);
    const gateAt = source.indexOf("VITE_RS_COORDINATOR_PROBE === 'true'");
    expect(gateAt).toBeGreaterThan(-1);
    expect(source.indexOf('globalThis.__rsCoordinatorProbe =')).toBeGreaterThan(gateAt);
  });

  it('never mutates, admits, or pumps — read-only metadata only', () => {
    const start = source.indexOf("if (import.meta.env.VITE_RS_COORDINATOR_PROBE === 'true')");
    const block = source.slice(start);
    expect(block).toContain('getJobSnapshot');
    for (const forbidden of ['.admit(', '_requestPump', '_pump(', 'drain(', 'setLifecycleState']) {
      expect(block, `probe must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('exposes no trip payload, route or location field', () => {
    const start = source.indexOf("if (import.meta.env.VITE_RS_COORDINATOR_PROBE === 'true')");
    const block = source.slice(start);
    for (const leak of ['route_points', 'payload', 'lat', 'lng', 'ciphertext', 'trips']) {
      expect(block, `probe must not expose ${leak}`).not.toContain(leak);
    }
  });
});
