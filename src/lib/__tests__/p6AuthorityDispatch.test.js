import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression cover for the 500-trip A54 blocker.
 *
 * P6 derived state must follow the **authority**, not the platform. Production
 * runs on Android with `VITE_P35_NATIVE_AUTHORITY` unset, so trips live in
 * IndexedDB — but every P6 dispatch site routed on `isAndroid()` alone and
 * therefore drove the *native archive* steppers against an archive holding no
 * trips. The observed consequence on device at 500 trips: 500 rows queued in
 * `p6_trip_work`, **0** in `p6_source_applied`, **0** analytics buckets, and
 * D1-D4 manifests stuck `DIRTY`/`complete: false`. Because the Q4 lifetime
 * aggregate is gated on D1 being `VERIFIED && complete`, Dashboard lifetime
 * totals could never arrive and the page stayed on its "still being prepared"
 * state permanently.
 *
 * These tests pin the routing predicate at the authority boundary. They assert
 * which implementation is reached, not that a constant has a value.
 */

const nativeCalls = vi.hoisted(() => ({
  stepP6TripDerived: vi.fn(async () => ({ state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false })),
  queryP6AchievementStats: vi.fn(async () => ({ available: true, state: 'VERIFIED', completedCount: 1 })),
  queryP6GeometryPreviewPage: vi.fn(async () => ({ items: [], nextCursor: null })),
  stepP6ComponentRepair: vi.fn(async () => ({ state: 'IDLE', itemsWorked: 0, bytesWorked: 0 })),
}));

vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: nativeCalls }));
vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => true,
  isNativePlatform: () => true,
  getNativePlatform: () => 'android',
}));

/** Android is constant across every case here; only the authority changes. */
const withAuthority = async (enabled) => {
  vi.resetModules();
  Object.values(nativeCalls).forEach((fn) => fn.mockClear());
  if (enabled) vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
  else vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', '');
  return import('@/lib/p6TripDerivedState');
};

describe('P6 derived state follows the authority, not the platform', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('does not reach the native archive for achievement stats under browser authority on Android', async () => {
    const mod = await withAuthority(false);
    await mod.readP6AchievementStats({ now: Date.now() }).catch(() => null);
    expect(nativeCalls.queryP6AchievementStats).not.toHaveBeenCalled();
  });

  it('does reach the native archive for achievement stats under native authority on Android', async () => {
    const mod = await withAuthority(true);
    await mod.readP6AchievementStats({ now: Date.now() }).catch(() => null);
    expect(nativeCalls.queryP6AchievementStats).toHaveBeenCalledTimes(1);
  });

  it('does not reach the native geometry preview under browser authority on Android', async () => {
    const mod = await withAuthority(false);
    await mod.queryP6GeometryPreviewPage({ cursor: '', maxTrips: 8 }).catch(() => null);
    expect(nativeCalls.queryP6GeometryPreviewPage).not.toHaveBeenCalled();
  });

  it('does reach the native geometry preview under native authority on Android', async () => {
    const mod = await withAuthority(true);
    await mod.queryP6GeometryPreviewPage({ cursor: '', maxTrips: 8 }).catch(() => null);
    expect(nativeCalls.queryP6GeometryPreviewPage).toHaveBeenCalledTimes(1);
  });
});

describe('P6 authority routing is stated once, not re-derived per call site', () => {
  it('leaves no bare isAndroid() authority dispatch in the P6 sources', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();
    const files = [
      'src/lib/p6TripDerivedState.js',
      'src/lib/p6RoadMemoryState.js',
      'src/lib/p6ExplicitOperations.js',
      'src/lib/appLifecycleWork.js',
    ];

    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8');
      const code = source
        // Comments legitimately mention the old predicate when explaining the bug.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      // Every surviving `isAndroid()` in these files must be part of the
      // authority predicate itself, never a standalone routing decision.
      const AUTHORITY_PREDICATE = /isAndroid\(\)\s*&&\s*(nativeAuthorityEnabled|import\.meta\.env\.VITE_P35_NATIVE_AUTHORITY)/;
      const standalone = [...code.matchAll(/isAndroid\(\)/g)].filter((match) => (
        !AUTHORITY_PREDICATE.test(code.slice(match.index, match.index + 80))
      ));

      expect(
        standalone.length,
        `${file} still routes on isAndroid() instead of the authority predicate`
      ).toBe(0);
    }
  });
});

describe('Diagnostics states the real backup format version', () => {
  it('derives the Recovery Compatibility label from BACKUP_VERSION rather than a literal', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();
    const page = readFileSync(path.join(root, 'src/pages/Diagnostics.jsx'), 'utf8');

    // The label drifted a version behind for three months because it was a
    // hardcoded string. It must read the constant, and no literal version may
    // be reintroduced alongside it.
    expect(page).toContain('Road Sage JSON v${BACKUP_VERSION}');
    expect(page).not.toMatch(/Road Sage JSON v\d/);
  });

  it('keeps one source of truth for the backup version', async () => {
    const constants = await import('@/lib/dataBackupConstants');
    const backup = await import('@/lib/dataBackup');
    expect(Number.isInteger(constants.BACKUP_VERSION)).toBe(true);
    expect(backup.BACKUP_VERSION).toBe(constants.BACKUP_VERSION);
  });
});
