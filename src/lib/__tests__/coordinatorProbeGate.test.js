import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every production source file, tests and fixtures excluded. */
const productionSources = (directory = resolve(process.cwd(), 'src')) => (
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' || entry === '__fixtures__' ? [] : productionSources(path);
    }
    return /\.(js|jsx)$/.test(entry) ? [{ path }] : [];
  })
);

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

  it('installs every probe global inside the gate and nowhere else', () => {
    // The bundle proof for a qualification build is physical (grep the emitted
    // asset for these names); this is the source-level half of it, so a new
    // probe global cannot be added outside the gate without failing here.
    const gateAt = source.indexOf("if (import.meta.env.VITE_RS_COORDINATOR_PROBE === 'true')");
    expect(gateAt).toBeGreaterThan(-1);
    const globals = [...source.matchAll(/globalThis\.(__rsCoordinatorProbe[A-Za-z]*)\s*=/g)];
    expect(globals.length).toBeGreaterThan(0);
    for (const match of globals) {
      const name = match[1];
      // `__rsCoordinatorProbeLastError` is written by the read-only turn
      // wrapper, which is itself an identity function unless the flag is set.
      if (name === '__rsCoordinatorProbeLastError') {
        expect(source.indexOf('const probeCoordinatorTurn = COORDINATOR_PROBE_ENABLED'))
          .toBeGreaterThan(-1);
        expect(match.index, name).toBeGreaterThan(source.indexOf('COORDINATOR_PROBE_ENABLED'));
        continue;
      }
      expect(match.index, `${name} must be installed inside the flag gate`).toBeGreaterThan(gateAt);
    }
  });

  it('is referenced by no other production module', () => {
    const others = productionSources().filter(({ path }) => (
      !path.endsWith('appLifecycleWork.js') && /__rsCoordinatorProbe|COORDINATOR_PROBE_ENABLED/.test(
        readFileSync(path, 'utf8'),
      )
    ));
    expect(others.map(({ path }) => path)).toEqual([]);
  });

  it('exposes no trip payload, route or location field', () => {
    const start = source.indexOf("if (import.meta.env.VITE_RS_COORDINATOR_PROBE === 'true')");
    const block = source.slice(start);
    for (const leak of ['route_points', 'payload', 'lat', 'lng', 'ciphertext', 'trips']) {
      expect(block, `probe must not expose ${leak}`).not.toContain(leak);
    }
  });
});
