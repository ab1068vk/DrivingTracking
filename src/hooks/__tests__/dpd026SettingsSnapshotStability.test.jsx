import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { projectAccessedSettings, sameAccessedProjection } from '@/hooks/useLocalSettings';

/**
 * DPD-026 — `useLocalSettings` handed out a new `settings` Proxy on every render
 * of Trip Detail, which recomputed `privacyZones` into a fresh array, re-ran the
 * effect that depends on it, wrote a new `Map` through `setRouteRiskIndex`, and
 * re-rendered — rebuilding the whole route layer several times a second while the
 * page sat idle.
 *
 * Measured on the A54 (master §40): the settings Proxy changed identity on
 * **20 of 20** samples on Trip Detail and on **0 of 20** on the `/reports`
 * control, which is what proved the hook — not the page — owned the instability.
 *
 * `useSyncExternalStore` requires `getSnapshot` to be a pure function of the
 * store. The projection below is that snapshot. These tests defend the contract
 * it has to satisfy; the hook itself is the `useRef` plumbing around it.
 */
describe('DPD-026 settings snapshot projection', () => {
  const settings = { units: 'metric', privacy_zones: [], theme: 'dark', premium_visual_experience: false };

  it('projects only the keys that were read, in a stable order', () => {
    const a = projectAccessedSettings(new Set(['theme', 'units']), settings);
    const b = projectAccessedSettings(new Set(['units', 'theme']), settings);

    // keys are sorted, so 'theme' precedes 'units'
    expect(a).toEqual(['dark', 'metric']);
    expect(sameAccessedProjection(a, b)).toBe(true);
  });

  it('treats an unchanged read-set over unchanged settings as the same snapshot', () => {
    const keys = new Set(['units', 'privacy_zones']);

    const first = projectAccessedSettings(keys, settings);
    const second = projectAccessedSettings(keys, settings);

    expect(first).not.toBe(second);
    expect(sameAccessedProjection(first, second)).toBe(true);
  });

  it('reports a change when a read value actually changes', () => {
    const keys = new Set(['units']);
    const before = projectAccessedSettings(keys, settings);
    const after = projectAccessedSettings(keys, { ...settings, units: 'imperial' });

    expect(sameAccessedProjection(before, after)).toBe(false);
  });

  it('reports a change when the read-set grows — which is why it must converge', () => {
    const before = projectAccessedSettings(new Set(['units']), settings);
    const after = projectAccessedSettings(new Set(['units', 'theme']), settings);

    expect(sameAccessedProjection(before, after)).toBe(false);
  });

  it('settles once the read-set stops growing', () => {
    // The loop existed because the read-set oscillated. With an accumulating set
    // it can only grow, so successive projections become equal and stay equal.
    const accumulated = new Set();
    const renders = [['units'], ['units', 'theme'], ['units', 'theme'], ['theme', 'units']];
    const projections = renders.map((read) => {
      read.forEach((k) => accumulated.add(k));
      return projectAccessedSettings(accumulated, settings);
    });

    expect(sameAccessedProjection(projections[0], projections[1])).toBe(false);
    expect(sameAccessedProjection(projections[1], projections[2])).toBe(true);
    expect(sameAccessedProjection(projections[2], projections[3])).toBe(true);
  });

  it('never settles if the read-set is allowed to shrink — the original defect', () => {
    // Reproduces the pre-fix behaviour: a set that resets can oscillate forever.
    const wide = projectAccessedSettings(new Set(['units', 'theme']), settings);
    const narrow = projectAccessedSettings(new Set(['units']), settings);

    expect(sameAccessedProjection(wide, narrow)).toBe(false);
    expect(sameAccessedProjection(narrow, wide)).toBe(false);
  });

  it('returns the snapshot itself when the component enumerated the object', () => {
    const projection = projectAccessedSettings(new Set(['*', 'units']), settings);

    expect(projection).toBe(settings);
  });

  it('a real privacy-zone change is still reported', () => {
    const keys = new Set(['privacy_zones']);
    const zones = [{ id: 'z1', lat: 43.6, lng: -79.4, radius_m: 200 }];

    const before = projectAccessedSettings(keys, settings);
    const after = projectAccessedSettings(keys, { ...settings, privacy_zones: zones });

    expect(sameAccessedProjection(before, after)).toBe(false);
  });
});

/**
 * The projection is only pure if the set feeding it never shrinks. Without this,
 * restoring the per-render reset would reinstate the loop with every unit test
 * still green.
 */
describe('DPD-026 the accessed-key set must not be cleared per render', () => {
  const source = readFileSync('src/hooks/useLocalSettings.jsx', 'utf8');

  it('does not reassign the accessed-key set during render', () => {
    expect(source).not.toMatch(/accessedKeysRef\.current\s*=\s*new Set\(\)/);
  });

  it('still seeds the set once, via useRef', () => {
    expect(source).toMatch(/useRef\(new Set\(\)\)/);
  });

  it('feeds the accumulated set to the projection', () => {
    expect(source).toMatch(/projectAccessedSettings\(accessedKeysRef\.current, settings\)/);
  });
});
