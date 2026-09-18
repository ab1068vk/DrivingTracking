import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CALLER_CONTEXT,
  findSymbolCallEdges,
  isRoutineEdge,
} from './helpers/p7ReleaseAudit';

/**
 * P7-IMPL-F04 — hostile caller-context controls.
 *
 * The classifier's job is to answer one question: **can a routine path reach
 * this legacy call?** Codex found it answering "no" for a function that a
 * `useEffect` executes on mount, because the effect passed the function *by
 * reference* and the closure only recognized `name(`. The `onClick` on the
 * same function then became an explicit root and won.
 *
 * Two things were wrong and both are fail-open:
 *
 * 1. a reference is an edge — `useEffect(legacy, [])` runs `legacy` exactly as
 *    surely as `legacy()` does;
 * 2. routine must dominate — a user action cannot un-run something that
 *    already ran on mount.
 *
 * These fixtures are the adversarial shapes. They live outside `src/pages` so
 * the production sweeps never see them, and they are fed to the classifier
 * explicitly.
 */

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'p7CallerContext',
);

const fixtureFiles = () => readdirSync(FIXTURES).map((name) => path.join(FIXTURES, name));

const contextFor = (fixture, symbol) => {
  const edges = findSymbolCallEdges([symbol], { files: fixtureFiles() });
  const hit = edges.filter((edge) => edge.file.endsWith(fixture));
  expect(hit.length, `${fixture} must contain exactly one ${symbol} edge`).toBe(1);
  return hit[0].context;
};

describe('P7-IMPL-F04 — a routine callback reference is a routine edge', () => {
  it("Codex reproduction 1: useEffect(legacy) beside onClick={legacy} is ROUTINE", () => {
    expect(contextFor('mixedEffectAndClick.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('Codex reproduction 2: queryFn: legacy beside onClick={legacy} is ROUTINE', () => {
    expect(contextFor('mixedQueryFnAndClick.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('a focus/resume listener reference is ROUTINE even with a button on it', () => {
    expect(contextFor('routineListener.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('a cross-module reference is ROUTINE, not merely unclassified', () => {
    // The importer wires the exported helper to an effect; the legacy call is
    // one module away. Routine reachability still has to cross that boundary.
    expect(contextFor('crossModuleLegacy.js', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('Codex reproduction 3: JSX onFocus={legacy} is ROUTINE, not EXPLICIT', () => {
    // A focus prop is not a named user action: autofocus, a restored tab and a
    // remount all fire it. Classifying it EXPLICIT was the remaining fail-open.
    expect(contextFor('jsxFocusHandler.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('Codex reproduction 4: App.addListener("appStateChange", legacy) is ROUTINE', () => {
    // Resume. Fail-closed UNCLASSIFIED was safe but did not name the reason.
    expect(contextFor('capacitorLifecycleListener.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('an invalidation/refetch callback is ROUTINE', () => {
    expect(contextFor('invalidationCallback.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('useInfiniteQuery queryFn beside a load-more button is ROUTINE', () => {
    expect(contextFor('infiniteQueryLegacy.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('useLayoutEffect(legacy) is ROUTINE', () => {
    expect(contextFor('layoutEffectLegacy.jsx', 'tripService.list'))
      .toBe(CALLER_CONTEXT.ROUTINE);
  });

  it('still recognizes a genuinely explicit user action', () => {
    // The control that proves the rule did not simply become "everything is
    // routine": B7's export is reached only from its named action.
    expect(contextFor('explicitOnly.jsx', 'listAllForExport'))
      .toBe(CALLER_CONTEXT.EXPLICIT);
  });

  it('treats every routine shape as a gate failure', () => {
    const routineFixtures = [
      'mixedEffectAndClick.jsx',
      'mixedQueryFnAndClick.jsx',
      'routineListener.jsx',
      'crossModuleLegacy.js',
      'jsxFocusHandler.jsx',
      'capacitorLifecycleListener.jsx',
      'invalidationCallback.jsx',
      'infiniteQueryLegacy.jsx',
      'layoutEffectLegacy.jsx',
    ];
    const edges = findSymbolCallEdges(['tripService.list'], { files: fixtureFiles() });
    const failing = edges.filter(isRoutineEdge).map((edge) => path.basename(edge.file));
    expect(failing.sort()).toEqual(routineFixtures.sort());
  });
});

describe('P7-IMPL-F04 — routine dominance is a rule, not an ordering accident', () => {
  it('covers every frozen routine context as an executing construct', () => {
    // The contexts the plan freezes. Each must appear as an opener, because
    // each one executes a callback it was handed by reference.
    const source = readFileSync(
      path.join(FIXTURES, '..', '..', 'helpers', 'p7ReleaseAudit.js'), 'utf8'
    );
    for (const construct of [
      'useEffect', 'useLayoutEffect', 'useQuery', 'useQueries', 'useInfiniteQuery',
      'queryFn', 'refetch', 'onFocus', 'onResume', 'onAppStateChange',
      'invalidateQueries', 'addEventListener', 'addListener',
    ]) {
      expect(source, construct).toContain(construct);
    }
    // The JSX lifecycle handlers, which are routine roots rather than actions.
    for (const construct of ['ROUTINE_JSX_HANDLERS', 'onBlur', 'onVisibilityChange']) {
      expect(source, construct).toContain(construct);
    }
    // Routine wins over explicit, and the walk no longer stops at the first
    // explicit root it happens to meet.
    expect(source).toContain('if (routineRoots.has(name)) sawRoutine = true;');
    expect(source).toContain('if (sawRoutine) return CALLER_CONTEXT.ROUTINE;');
    // The suppression that hid a routine root behind a handler is gone.
    expect(source).not.toContain('&& !referencedByHandler');
  });
});
